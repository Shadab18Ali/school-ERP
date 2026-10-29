"""Attendance: one request loads a section's roster, one request saves all of it
(private.save_section_attendance does it in a single SQL statement), and every
report is computed by SQL functions. Pinned to the active school throughout."""

import calendar
import json
import uuid
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.schemas.attendance import (
    ClassReport,
    Counts,
    Daily,
    DailyRow,
    DayTotals,
    Monthly,
    MonthlyStudent,
    MonthTotals,
    Roster,
    RosterSave,
    RosterStudent,
    SaveResult,
    StudentAttendance,
    StudentRecord,
    StudentTotals,
)
from app.services.academics import resolve_session
from app.services.audit import write_audit

router = APIRouter(prefix="/attendance", tags=["attendance"])
# Marking and the staff reports: teachers and school admins.
STAFF = Depends(require_permission(Permission.ATTENDANCE_MARK))


def _pct(present: int, marked: int) -> Decimal | None:
    return None if marked == 0 else (Decimal(100 * present) / Decimal(marked)).quantize(Decimal("0.1"))


async def _section(db: AsyncSession, ctx: SchoolContext, section_id: uuid.UUID):
    row = (
        await db.execute(
            text(
                "select sec.id, sec.name, c.name, a.id, a.name, a.start_date, a.end_date, a.archived_at "
                "from public.sections sec join public.classes c on c.id = sec.class_id "
                "join public.academic_sessions a on a.id = sec.academic_session_id "
                "where sec.id = :id and sec.school_id = :s and sec.deleted_at is null"
            ),
            {"id": section_id, "s": ctx.school_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Section not found.")
    return row


async def _roster(db: AsyncSession, ctx: SchoolContext, section_id: uuid.UUID, day: date) -> Roster:
    sec = await _section(db, ctx, section_id)
    reason = None
    if sec[7] is not None:
        reason = f"Session {sec[4]} is archived, so its attendance is read-only."
    elif day > date.today():
        reason = "Attendance can't be marked for a future date."
    elif not sec[5] <= day <= sec[6]:
        reason = f"That date is outside session {sec[4]}."
    # One query: active students of the section plus any saved mark for the day.
    rows = (
        await db.execute(
            text(
                "select e.id, st.id, st.full_name, st.student_code, e.admission_number, "
                "a.status, a.remarks, a.updated_at "
                "from public.student_enrollments e join public.students st on st.id = e.student_id "
                "left join public.attendance_records a on a.student_id = st.id and a.attendance_date = :d "
                "where e.section_id = :sec and e.school_id = :s and (st.status = 'active' or a.id is not null) "
                "order by lower(st.full_name)"
            ),
            {"d": day, "sec": section_id, "s": ctx.school_id},
        )
    ).all()
    students = [
        RosterStudent(
            enrollment_id=r[0],
            student_id=r[1],
            full_name=r[2],
            student_code=r[3],
            admission_number=r[4],
            status=r[5],
            remarks=r[6],
            updated_at=r[7],
        )
        for r in rows
    ]
    n = {s: sum(1 for x in students if x.status == s) for s in ("present", "absent", "leave")}
    marked = n["present"] + n["absent"] + n["leave"]
    return Roster(
        section_id=sec[0],
        section_name=sec[1],
        class_name=sec[2],
        session_id=sec[3],
        session_name=sec[4],
        date=day,
        editable=reason is None,
        reason=reason,
        students=students,
        counts=Counts(**n, unmarked=len(students) - marked, percentage=_pct(n["present"], marked)),
    )


@router.get("/roster", response_model=Roster)
async def get_roster(
    section_id: uuid.UUID,
    day: date = Query(alias="date"),
    ctx: SchoolContext = STAFF,
    db: AsyncSession = Depends(get_db),
) -> Roster:
    return await _roster(db, ctx, section_id, day)


@router.put("/roster", response_model=SaveResult)
async def save_roster(
    payload: RosterSave, request: Request, ctx: SchoolContext = STAFF, db: AsyncSession = Depends(get_db)
) -> SaveResult:
    await _section(db, ctx, payload.section_id)
    entries = json.dumps(
        [{"enrollment_id": str(e.enrollment_id), "status": e.status, "remarks": e.remarks} for e in payload.entries]
    )
    try:
        inserted, updated, unchanged, changes = (
            await db.execute(
                text(
                    "select inserted, updated, unchanged, changes from "
                    "private.save_section_attendance(:sec, :d, cast(:entries as jsonb))"
                ),
                {"sec": payload.section_id, "d": payload.date, "entries": entries},
            )
        ).one()
        if inserted or updated:
            await write_audit(
                db,
                request,
                action="attendance.saved",
                entity_type="section",
                entity_id=str(payload.section_id),
                school_id=ctx.school_id,
                metadata={
                    "date": payload.date.isoformat(),
                    "inserted": inserted,
                    "updated": updated,
                    "changes": changes,
                },
            )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return SaveResult(
        inserted=inserted,
        updated=updated,
        unchanged=unchanged,
        roster=await _roster(db, ctx, payload.section_id, payload.date),
    )


@router.get("/daily", response_model=Daily)
async def daily(
    day: date = Query(alias="date"), ctx: SchoolContext = STAFF, db: AsyncSession = Depends(get_db)
) -> Daily:
    rows = (
        await db.execute(
            text(
                "select section_id, class_name, section_name, enrolled, present, absent, leave, unmarked, percentage "
                "from private.attendance_daily(:s, :d) order by class_order, lower(class_name), lower(section_name)"
            ),
            {"s": ctx.school_id, "d": day},
        )
    ).all()
    sections = [
        DailyRow(
            section_id=r[0],
            class_name=r[1],
            section_name=r[2],
            enrolled=r[3],
            present=r[4],
            absent=r[5],
            leave=r[6],
            unmarked=r[7],
            percentage=r[8],
        )
        for r in rows
    ]
    p, a, lv, u = (sum(getattr(s, k) for s in sections) for k in ("present", "absent", "leave", "unmarked"))
    return Daily(
        date=day,
        sections=sections,
        totals=Counts(present=p, absent=a, leave=lv, unmarked=u, percentage=_pct(p, p + a + lv)),
    )


async def _student_totals(db: AsyncSession, ctx: SchoolContext, section_id: uuid.UUID, d1: date, d2: date):
    return (
        await db.execute(
            text(
                "select t.enrollment_id, t.student_id, st.full_name, st.student_code, e.admission_number, "
                "t.present, t.absent, t.leave, t.marked, t.percentage "
                "from private.attendance_student_totals(:sec, :d1, :d2) t "
                "join public.students st on st.id = t.student_id "
                "join public.student_enrollments e on e.id = t.enrollment_id "
                "where e.school_id = :s order by lower(st.full_name)"
            ),
            {"sec": section_id, "d1": d1, "d2": d2, "s": ctx.school_id},
        )
    ).all()


async def _days(db: AsyncSession, section_id: uuid.UUID, d1: date, d2: date) -> list[DayTotals]:
    rows = (
        await db.execute(
            text(
                "select attendance_date, present, absent, leave, marked, percentage "
                "from private.attendance_section_days(:sec, :d1, :d2)"
            ),
            {"sec": section_id, "d1": d1, "d2": d2},
        )
    ).all()
    return [DayTotals(date=r[0], present=r[1], absent=r[2], leave=r[3], marked=r[4], percentage=r[5]) for r in rows]


@router.get("/monthly", response_model=Monthly)
async def monthly(
    section_id: uuid.UUID,
    month: str = Query(pattern=r"^\d{4}-(0[1-9]|1[0-2])$"),
    ctx: SchoolContext = STAFF,
    db: AsyncSession = Depends(get_db),
) -> Monthly:
    sec = await _section(db, ctx, section_id)
    y, m = int(month[:4]), int(month[5:])
    d1, d2 = date(y, m, 1), date(y, m, calendar.monthrange(y, m)[1])
    totals = await _student_totals(db, ctx, section_id, d1, d2)
    marks = (
        await db.execute(
            text(
                "select enrollment_id, attendance_date, status from public.attendance_records "
                "where section_id = :sec and school_id = :s and attendance_date between :d1 and :d2"
            ),
            {"sec": section_id, "s": ctx.school_id, "d1": d1, "d2": d2},
        )
    ).all()
    grid: dict[uuid.UUID, dict[str, str]] = {}
    for enr, d, st in marks:
        grid.setdefault(enr, {})[d.isoformat()] = st
    students = [
        MonthlyStudent(
            enrollment_id=r[0],
            student_id=r[1],
            full_name=r[2],
            student_code=r[3],
            admission_number=r[4],
            present=r[5],
            absent=r[6],
            leave=r[7],
            marked=r[8],
            percentage=r[9],
            days=grid.get(r[0], {}),
        )
        for r in totals
    ]
    return Monthly(
        section_id=sec[0],
        class_name=sec[2],
        section_name=sec[1],
        month=d1,
        days=await _days(db, section_id, d1, d2),
        students=students,
    )


@router.get("/class", response_model=ClassReport)
async def class_report(
    section_id: uuid.UUID,
    date_from: date,
    date_to: date,
    ctx: SchoolContext = STAFF,
    db: AsyncSession = Depends(get_db),
) -> ClassReport:
    if date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The end date must be on or after the start date.")
    if (date_to - date_from).days > 400:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a range of at most about a year.")
    sec = await _section(db, ctx, section_id)
    rows = await _student_totals(db, ctx, section_id, date_from, date_to)
    students = [
        StudentTotals(
            enrollment_id=r[0],
            student_id=r[1],
            full_name=r[2],
            student_code=r[3],
            admission_number=r[4],
            present=r[5],
            absent=r[6],
            leave=r[7],
            marked=r[8],
            percentage=r[9],
        )
        for r in rows
    ]
    present, marked = sum(s.present for s in students), sum(s.marked for s in students)
    return ClassReport(
        section_id=sec[0],
        class_name=sec[2],
        section_name=sec[1],
        date_from=date_from,
        date_to=date_to,
        days=await _days(db, section_id, date_from, date_to),
        students=students,
        overall=_pct(present, marked),
    )


@router.get("/students/{student_id}", response_model=StudentAttendance)
async def student_attendance(
    student_id: uuid.UUID,
    session_id: uuid.UUID | None = None,
    ctx: SchoolContext = STAFF,
    db: AsyncSession = Depends(get_db),
) -> StudentAttendance:
    st = (
        await db.execute(
            text("select id, full_name from public.students where id = :id and school_id = :s"),
            {"id": student_id, "s": ctx.school_id},
        )
    ).first()
    if st is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found.")
    session = await resolve_session(db, ctx, session_id)
    empty = Counts(present=0, absent=0, leave=0, unmarked=0, percentage=None)
    if session is None:
        return StudentAttendance(
            student_id=st[0],
            full_name=st[1],
            session_id=None,
            session_name=None,
            class_section=None,
            months=[],
            overall=empty,
            records=[],
        )
    enr = (
        await db.execute(
            text(
                "select e.id, c.name || ' – ' || sec.name from public.student_enrollments e "
                "join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id "
                "where e.student_id = :st and e.academic_session_id = :sid and e.school_id = :s"
            ),
            {"st": student_id, "sid": session.id, "s": ctx.school_id},
        )
    ).first()
    if enr is None:
        return StudentAttendance(
            student_id=st[0],
            full_name=st[1],
            session_id=session.id,
            session_name=session.name,
            class_section=None,
            months=[],
            overall=empty,
            records=[],
        )
    months = [
        MonthTotals(month=r[0], present=r[1], absent=r[2], leave=r[3], marked=r[4], percentage=r[5])
        for r in (
            await db.execute(
                text(
                    "select month, present, absent, leave, marked, percentage "
                    "from private.attendance_student_months(:e)"
                ),
                {"e": enr[0]},
            )
        ).all()
    ]
    records = [
        StudentRecord(date=r[0], status=r[1], remarks=r[2], class_section=r[3])
        for r in (
            await db.execute(
                text(
                    "select a.attendance_date, a.status, a.remarks, c.name || ' – ' || sec.name "
                    "from public.attendance_records a join public.classes c on c.id = a.class_id "
                    "join public.sections sec on sec.id = a.section_id "
                    "where a.enrollment_id = :e and a.school_id = :s order by a.attendance_date desc"
                ),
                {"e": enr[0], "s": ctx.school_id},
            )
        ).all()
    ]
    p, a, lv = (sum(getattr(m, k) for m in months) for k in ("present", "absent", "leave"))
    return StudentAttendance(
        student_id=st[0],
        full_name=st[1],
        session_id=session.id,
        session_name=session.name,
        class_section=enr[1],
        months=months,
        overall=Counts(present=p, absent=a, leave=lv, unmarked=0, percentage=_pct(p, p + a + lv)),
        records=records,
    )
