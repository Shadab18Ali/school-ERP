"""School dashboard: every figure is a SQL aggregate over real records for the
selected (default: current) session. Blocks are included only for roles that may
see them: fees for fee collectors, attendance for teachers/admins."""

import uuid
from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.schemas.fees import Money
from app.services.academics import resolve_session

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


class StudentBlock(BaseModel):
    total_students: int
    total_classes: int
    total_sections: int
    by_class: list[dict]  # {class_name, students, boys, girls}


class AttendanceBlock(BaseModel):
    date: date
    present: int
    absent: int
    leave: int
    unmarked: int
    percentage: Decimal | None
    trend: list[dict]  # {date, percentage, marked}


class MonthPoint(BaseModel):
    month: date
    amount: Money


class FeeBlock(BaseModel):
    collected: Money
    pending: Money
    overdue: Money
    today: Money
    today_receipts: int
    monthly: list[MonthPoint]


class Dashboard(BaseModel):
    session_id: uuid.UUID | None
    session_name: str | None
    today: date
    students: StudentBlock | None
    attendance: AttendanceBlock | None
    fees: FeeBlock | None


async def session_enrollments(db: AsyncSession, ctx: SchoolContext, session_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        (
            await db.scalars(
                text("select id from public.student_enrollments where school_id = :s and academic_session_id = :sid"),
                {"s": ctx.school_id, "sid": session_id},
            )
        ).all()
    )


async def sync_dues(db: AsyncSession, school_id: uuid.UUID, ids: list[uuid.UUID]) -> None:
    """Bring unpaid dues in line with the fee structures before summing them.

    private.sync_school_dues does this for the school's fee office only (and does nothing for
    other roles, who can't change dues); it runs as the owner, so a whole school takes about a
    second instead of minutes of per-row security checks (migration 0028)."""
    if ids:
        await db.execute(
            text("select private.sync_school_dues(:s, :ids)").bindparams(
                bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
            ),
            {"s": school_id, "ids": ids},
        )
        await db.commit()


@router.get("", response_model=Dashboard)
async def dashboard(
    session_id: uuid.UUID | None = None,
    ctx: SchoolContext = Depends(require_permission(Permission.DASHBOARD_VIEW)),
    db: AsyncSession = Depends(get_db),
) -> Dashboard:
    today = date.today()
    session = await resolve_session(db, ctx, session_id)
    out = Dashboard(
        session_id=session.id if session else None,
        session_name=session.name if session else None,
        today=today,
        students=None,
        attendance=None,
        fees=None,
    )
    if session is None:
        return out
    p = {"s": ctx.school_id, "sid": session.id, "t": today}

    if ctx.can(Permission.STUDENTS_VIEW):
        students = (
            await db.execute(
                text(
                    "select count(*) from public.student_enrollments e join public.students st on st.id = e.student_id "
                    "where e.school_id = :s and e.academic_session_id = :sid and st.status = 'active'"
                ),
                p,
            )
        ).scalar_one()
        classes, sections = (
            await db.execute(
                text(
                    "select count(distinct c.id), count(sec.id) from public.classes c "
                    "left join public.sections sec on sec.class_id = c.id and sec.academic_session_id = :sid "
                    "and sec.deleted_at is null and sec.is_active "
                    "where c.school_id = :s and c.deleted_at is null and c.is_active"
                ),
                p,
            )
        ).one()
        by_class = [
            {"class_name": r[0], "students": r[1], "boys": r[2], "girls": r[3]}
            for r in (
                await db.execute(
                    text(
                        "select c.name, count(*), count(*) filter (where st.gender = 'male'), "
                        "count(*) filter (where st.gender = 'female') "
                        "from public.student_enrollments e join public.students st on st.id = e.student_id "
                        "join public.classes c on c.id = e.class_id "
                        "where e.school_id = :s and e.academic_session_id = :sid and st.status = 'active' "
                        "group by c.id, c.name, c.display_order order by c.display_order, lower(c.name)"
                    ),
                    p,
                )
            ).all()
        ]
        out.students = StudentBlock(
            total_students=students, total_classes=classes, total_sections=sections, by_class=by_class
        )

    if ctx.can(Permission.ATTENDANCE_MARK):
        present, absent, leave, unmarked = (
            await db.execute(
                text(
                    "select coalesce(sum(present), 0), coalesce(sum(absent), 0), coalesce(sum(leave), 0), "
                    "coalesce(sum(unmarked), 0) from private.attendance_daily(:s, :t)"
                ),
                p,
            )
        ).one()
        marked = present + absent + leave
        trend = [
            {"date": r[0].isoformat(), "percentage": str(r[1]), "marked": r[2]}
            for r in (
                await db.execute(
                    text(
                        "select attendance_date, round(100.0 * count(*) filter (where status = 'present') / "
                        "count(*), 1), "
                        "count(*) from public.attendance_records where school_id = :s "
                        "and attendance_date between :from and :t group by 1 order by 1"
                    ),
                    {**p, "from": today - timedelta(days=29)},
                )
            ).all()
        ]
        out.attendance = AttendanceBlock(
            date=today,
            present=present,
            absent=absent,
            leave=leave,
            unmarked=unmarked,
            percentage=None if marked == 0 else (Decimal(100 * present) / Decimal(marked)).quantize(Decimal("0.1")),
            trend=trend,
        )

    if ctx.can(Permission.FEES_COLLECT):
        ids = await session_enrollments(db, ctx, session.id)
        await sync_dues(db, ctx.school_id, ids)
        pending, overdue = (
            (
                await db.execute(
                    text(
                        "select coalesce(sum(outstanding), 0), coalesce(sum(overdue), 0) "
                        "from private.enrollment_fee_totals(:ids)"
                    ).bindparams(bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))),
                    {"ids": ids},
                )
            ).one()
            if ids
            else (Decimal(0), Decimal(0))
        )
        collected = (
            await db.execute(
                text(
                    "select coalesce(sum(amount), 0) from public.fee_payments where school_id = :s "
                    "and academic_session_id = :sid and cancelled_at is null"
                ),
                p,
            )
        ).scalar_one()
        today_amount, today_count = (
            await db.execute(
                text(
                    "select coalesce(sum(amount), 0), count(*) from public.fee_payments "
                    "where school_id = :s and payment_date = :t and cancelled_at is null"
                ),
                p,
            )
        ).one()
        monthly = [
            MonthPoint(month=r[0], amount=r[1])
            for r in (
                await db.execute(
                    text(
                        "select m::date, coalesce(sum(fp.amount), 0) from public.academic_sessions a "
                        "cross join generate_series(date_trunc('month', a.start_date), date_trunc('month', "
                        "a.end_date), "
                        "interval '1 month') m "
                        "left join public.fee_payments fp on fp.school_id = :s and fp.academic_session_id = a.id "
                        "and date_trunc('month', fp.payment_date) = m and fp.cancelled_at is null "
                        "where a.id = :sid group by m order by m"
                    ),
                    p,
                )
            ).all()
        ]
        out.fees = FeeBlock(
            collected=collected,
            pending=pending,
            overdue=overdue,
            today=today_amount,
            today_receipts=today_count,
            monthly=monthly,
        )
    return out
