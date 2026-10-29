"""Parent portal. Every endpoint first proves the signed-in user is a linked
guardian of the requested student in this school (else 404, revealing nothing),
and RLS independently limits parents to their own children's rows."""

import uuid
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.collection import receipt_response
from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.schemas.collection import DueOut, FeeTotalsOut, PaymentSummary
from app.services import storage

router = APIRouter(prefix="/portal", tags=["parent-portal"])
# Handlers below are shared with the student portal (/my), which resolves the
# student from the signed-in account and calls them with the same checks.
PARENT = Depends(require_permission(Permission.PORTAL_VIEW))
NOT_FOUND = HTTPException(status.HTTP_404_NOT_FOUND, "Student not found.")


class Child(BaseModel):
    student_id: uuid.UUID
    full_name: str
    student_code: str
    relationship: str
    photo_url: str | None
    class_section: str | None
    session_name: str | None
    attendance_percentage: Decimal | None
    outstanding: str | None


class ChildProfile(Child):
    date_of_birth: date
    gender: str
    father_name: str | None
    mother_name: str | None
    mobile: str
    address: str | None
    admission_number: str | None
    admission_date: date | None
    status: str


async def _link(db: AsyncSession, ctx: SchoolContext, user: CurrentUser, student_id: uuid.UUID) -> str:
    """First line of defence (RLS is the second): the signed-in user must be a linked
    parent of this student ("father", "mother", ...) or the student themself ("self")."""
    rel = (
        await db.execute(
            text(
                "select relationship::text from public.student_guardians "
                "where student_id = :st and user_id = :u and school_id = :s "
                "union all select 'self' from public.students where id = :st and account_id = :u and school_id = :s "
                "limit 1"
            ),
            {"st": student_id, "u": user.id, "s": ctx.school_id},
        )
    ).scalar()
    if rel is None:
        raise NOT_FOUND
    return rel


async def _current_enrollment(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID):
    return (
        await db.execute(
            text(
                "select e.id, c.name || ' – ' || sec.name, a.name, e.admission_number, e.admission_date "
                "from public.student_enrollments e join public.academic_sessions a on a.id = e.academic_session_id "
                "join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id "
                "where e.student_id = :st and e.school_id = :s order by a.is_current desc, a.start_date desc limit 1"
            ),
            {"st": student_id, "s": ctx.school_id},
        )
    ).first()


async def _summary(db: AsyncSession, enrollment_id: uuid.UUID | None) -> tuple[Decimal | None, str | None]:
    if enrollment_id is None:
        return None, None
    present, marked = (
        await db.execute(
            text(
                "select count(*) filter (where status = 'present'), count(*) from public.attendance_records "
                "where enrollment_id = :e"
            ),
            {"e": enrollment_id},
        )
    ).one()
    pct = None if not marked else (Decimal(100 * present) / Decimal(marked)).quantize(Decimal("0.1"))
    out = (
        await db.execute(
            text("select outstanding from private.enrollment_fee_totals(:ids)").bindparams(
                bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
            ),
            {"ids": [enrollment_id]},
        )
    ).scalar()
    return pct, f"{out:.2f}" if out is not None else None


@router.get("/children", response_model=list[Child])
async def my_children(
    ctx: SchoolContext = PARENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[Child]:
    rows = (
        await db.execute(
            text(
                "select st.id, st.full_name, st.student_code, g.relationship, st.photo_path "
                "from public.student_guardians g join public.students st on st.id = g.student_id "
                "where g.user_id = :u and g.school_id = :s order by st.full_name"
            ),
            {"u": user.id, "s": ctx.school_id},
        )
    ).all()
    photos = await storage.signed_urls(storage.PHOTO_BUCKET, [r[4] for r in rows if r[4]])
    out = []
    for sid, name, code, rel, photo in rows:
        await db.execute(text("select private.sync_dues_for_portal(:st)"), {"st": sid})
        enr = await _current_enrollment(db, ctx, sid)
        pct, outstanding = await _summary(db, enr[0] if enr else None)
        out.append(
            Child(
                student_id=sid,
                full_name=name,
                student_code=code,
                relationship=rel,
                photo_url=photos.get(photo or ""),
                class_section=enr[1] if enr else None,
                session_name=enr[2] if enr else None,
                attendance_percentage=pct,
                outstanding=outstanding,
            )
        )
    await db.commit()
    return out


@router.get("/children/{student_id}", response_model=ChildProfile)
async def child_profile(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChildProfile:
    rel = await _link(db, ctx, user, student_id)
    st = (
        await db.execute(
            text(
                "select full_name, student_code, photo_path, date_of_birth, gender, father_name, mother_name, mobile, "
                "address, status from public.students where id = :st and school_id = :s"
            ),
            {"st": student_id, "s": ctx.school_id},
        )
    ).first()
    if st is None:  # RLS hid it: treat exactly like "not linked"
        raise NOT_FOUND
    await db.execute(text("select private.sync_dues_for_portal(:st)"), {"st": student_id})
    await db.commit()
    enr = await _current_enrollment(db, ctx, student_id)
    pct, outstanding = await _summary(db, enr[0] if enr else None)
    photo = (await storage.signed_urls(storage.PHOTO_BUCKET, [st[2]])).get(st[2] or "") if st[2] else None
    return ChildProfile(
        student_id=student_id,
        full_name=st[0],
        student_code=st[1],
        relationship=rel,
        photo_url=photo,
        class_section=enr[1] if enr else None,
        session_name=enr[2] if enr else None,
        attendance_percentage=pct,
        outstanding=outstanding,
        date_of_birth=st[3],
        gender=st[4],
        father_name=st[5],
        mother_name=st[6],
        mobile=st[7],
        address=st[8],
        status=st[9],
        admission_number=enr[3] if enr else None,
        admission_date=enr[4] if enr else None,
    )


@router.get("/children/{student_id}/attendance")
async def child_attendance(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _link(db, ctx, user, student_id)
    enr = await _current_enrollment(db, ctx, student_id)
    if enr is None:
        return {"session_name": None, "class_section": None, "months": [], "overall": None, "records": []}
    months = [
        {
            "month": r[0].isoformat(),
            "present": r[1],
            "absent": r[2],
            "leave": r[3],
            "marked": r[4],
            "percentage": str(r[5]),
        }
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
        {"date": r[0].isoformat(), "status": r[1], "remarks": r[2]}
        for r in (
            await db.execute(
                text(
                    "select attendance_date, status, remarks from public.attendance_records "
                    "where enrollment_id = :e order by attendance_date desc"
                ),
                {"e": enr[0]},
            )
        ).all()
    ]
    p = sum(m["present"] for m in months)
    a = sum(m["absent"] for m in months)
    lv = sum(m["leave"] for m in months)
    pct = None if not (p + a + lv) else str((Decimal(100 * p) / Decimal(p + a + lv)).quantize(Decimal("0.1")))
    return {
        "session_name": enr[2],
        "class_section": enr[1],
        "months": months,
        "overall": {"present": p, "absent": a, "leave": lv, "percentage": pct},
        "records": records,
    }


class ChildFees(BaseModel):
    session_name: str | None
    class_section: str | None
    totals: FeeTotalsOut | None
    dues: list[DueOut]
    payments: list[PaymentSummary]


@router.get("/children/{student_id}/fees", response_model=ChildFees)
async def child_fees(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ChildFees:
    await _link(db, ctx, user, student_id)
    await db.execute(text("select private.sync_dues_for_portal(:st)"), {"st": student_id})
    await db.commit()
    enr = await _current_enrollment(db, ctx, student_id)
    if enr is None:
        return ChildFees(session_name=None, class_section=None, totals=None, dues=[], payments=[])
    t = (
        await db.execute(
            text("select total, paid, outstanding, overdue from private.enrollment_fee_totals(:ids)").bindparams(
                bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
            ),
            {"ids": [enr[0]]},
        )
    ).one()
    dues = [
        DueOut(
            due_id=r[0],
            fee_item_id=r[1],
            fee_head_name=r[2],
            frequency=r[3],
            is_optional=r[4],
            due_month=r[5],
            amount=r[6],
            paid=r[7],
            balance=r[8],
        )
        for r in (
            await db.execute(
                text(
                    "select due_id, fee_item_id, fee_head_name, frequency, is_optional, due_month, "
                    "amount, paid, balance from private.student_fee_status(:e)"
                ),
                {"e": enr[0]},
            )
        ).all()
    ]
    payments = [
        PaymentSummary(
            id=r[0],
            receipt_number=r[1],
            payment_date=r[2],
            amount=r[3],
            payment_mode=r[4],
            reference_number=r[5],
            balance_after=r[6],
            received_by_name=None,
            created_at=r[7],
            cancelled_at=r[8],
            cancel_reason=r[9],
        )
        for r in (
            await db.execute(
                text(
                    "select id, receipt_number, payment_date, amount, payment_mode, reference_number, balance_after, "
                    "created_at, cancelled_at, cancel_reason "
                    "from public.fee_payments where student_id = :st and school_id = :s order by created_at desc"
                ),
                {"st": student_id, "s": ctx.school_id},
            )
        ).all()
    ]
    return ChildFees(
        session_name=enr[2],
        class_section=enr[1],
        totals=FeeTotalsOut(total=t[0], paid=t[1], outstanding=t[2], overdue=t[3]),
        dues=dues,
        payments=payments,
    )


@router.get("/children/{student_id}/payments/{payment_id}/receipt.pdf")
async def child_receipt(
    student_id: uuid.UUID,
    payment_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    await _link(db, ctx, user, student_id)
    owner = (
        await db.execute(
            text("select student_id from public.fee_payments where id = :p and school_id = :s"),
            {"p": payment_id, "s": ctx.school_id},
        )
    ).scalar()
    if owner != student_id:  # the receipt must belong to THIS child
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Receipt not found.")
    return await receipt_response(db, ctx, payment_id)


async def _child_section(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID) -> uuid.UUID:
    sec = (
        await db.execute(
            text(
                "select e.section_id from public.student_enrollments e "
                "join public.academic_sessions a on a.id = e.academic_session_id "
                "where e.student_id = :st and e.school_id = :s order by a.is_current desc, a.start_date desc limit 1"
            ),
            {"st": student_id, "s": ctx.school_id},
        )
    ).scalar()
    if sec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not enrolled in a class yet.")
    return sec


@router.get("/children/{student_id}/timetable")
async def child_timetable(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes.timetable import class_grid

    await _link(db, ctx, user, student_id)
    return await class_grid(db, ctx, await _child_section(db, ctx, student_id))


@router.get("/children/{student_id}/timetable/pdf")
async def child_timetable_pdf(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes.timetable import class_grid, grid_pdf

    await _link(db, ctx, user, student_id)
    g = await class_grid(db, ctx, await _child_section(db, ctx, student_id))
    return await grid_pdf(db, ctx, g, g.title)


# ---------------------------------------------------------------- homework (read only for parents)
@router.get("/children/{student_id}/homework")
async def child_homework(
    student_id: uuid.UUID,
    kind: str | None = None,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.api.v1.routes import homework as hw

    await _link(db, ctx, user, student_id)
    if kind not in (None, "homework", "assignment"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown kind.")
    return await hw.student_homework_list(db, ctx, student_id, kind)  # type: ignore[arg-type]


@router.get("/children/{student_id}/homework/{homework_id}")
async def child_homework_detail(
    student_id: uuid.UUID,
    homework_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes import homework as hw

    rel = await _link(db, ctx, user, student_id)
    return await hw.student_homework_detail(db, ctx, student_id, homework_id, is_self=rel == "self")


@router.get("/children/{student_id}/homework/{homework_id}/attachments/{file_id}")
async def child_homework_attachment(
    student_id: uuid.UUID,
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
    download: bool = False,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes import homework as hw

    await _link(db, ctx, user, student_id)
    await hw.student_homework_detail(db, ctx, student_id, homework_id, is_self=False)
    return await hw.attachment_response(db, homework_id, file_id, download)


@router.get("/children/{student_id}/homework/{homework_id}/files/{file_id}")
async def child_submission_file(
    student_id: uuid.UUID,
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
    download: bool = False,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes import homework as hw

    await _link(db, ctx, user, student_id)
    return await hw.student_submission_file(db, ctx, student_id, homework_id, file_id, download)


# ---------------------------------------------------------------- exams (date sheets; results once published)
@router.get("/children/{student_id}/exams")
async def child_exams(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    from app.api.v1.routes import exams

    await _link(db, ctx, user, student_id)
    return await exams.student_exams(db, ctx, student_id)


@router.get("/children/{student_id}/exams/{exam_id}/report-card.pdf")
async def child_report_card(
    student_id: uuid.UUID,
    exam_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes import exams

    await _link(db, ctx, user, student_id)
    return await exams.student_report_card(db, ctx, student_id, exam_id)


@router.get("/children/{student_id}/library")
async def child_library(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.api.v1.routes import library

    await _link(db, ctx, user, student_id)
    return await library.student_library(db, ctx, student_id)


@router.get("/children/{student_id}/transport")
async def child_transport(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    from app.api.v1.routes import transport

    await _link(db, ctx, user, student_id)
    return await transport.family_transport(db, student_id)
