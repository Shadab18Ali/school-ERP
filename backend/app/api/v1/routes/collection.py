"""Fee collection: student balances, dues, payments and receipts.

Money rules (no overpayment, receipt numbers, duplicate submissions, frozen paid
dues) are enforced inside the database functions this module calls:
private.sync_student_dues, private.record_fee_payment, private.student_fee_status
and private.enrollment_fee_totals. Every query is pinned to the active school.
"""

import json
import re
import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.schemas.collection import (
    MODE_LABELS,
    DueOut,
    FeeTotalsOut,
    OptinsUpdate,
    OptionalFeeOut,
    PaymentCreate,
    PaymentDetail,
    PaymentLine,
    PaymentResult,
    PaymentSummary,
    StudentBalanceList,
    StudentBalanceRow,
    StudentFeeAccount,
)
from app.services import storage
from app.services.academics import resolve_session
from app.services.audit import write_audit
from app.services.receipts import ReceiptData, ReceiptLine, build_receipt_pdf

router = APIRouter(tags=["fee-collection"])
COLLECT = Depends(require_permission(Permission.FEES_COLLECT))

_IDS = bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
_SYNC = text("select private.sync_student_dues(:ids)").bindparams(_IDS)
# whole school at once: as the owner, for the fee office only (migration 0028)
_SYNC_SCHOOL = text("select private.sync_school_dues(:s, :ids)").bindparams(_IDS)
_TOTALS = text(
    "select enrollment_id, total, paid, outstanding, overdue from private.enrollment_fee_totals(:ids)"
).bindparams(_IDS)
ZERO = FeeTotalsOut(total=Decimal(0), paid=Decimal(0), outstanding=Decimal(0), overdue=Decimal(0))


def _like(term: str) -> str:
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def _totals(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, FeeTotalsOut]:
    if not ids:
        return {}
    rows = (await db.execute(_TOTALS, {"ids": ids})).all()
    return {r[0]: FeeTotalsOut(total=r[1], paid=r[2], outstanding=r[3], overdue=r[4]) for r in rows}


# ------------------------------------------------------------------ balances
@router.get("/fee-collection/students", response_model=StudentBalanceList)
async def list_balances(
    ctx: SchoolContext = COLLECT,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = None,
    class_id: uuid.UUID | None = None,
    section_id: uuid.UUID | None = None,
    search: str | None = Query(default=None, max_length=100),
    balance: Literal["outstanding", "overdue", "cleared"] | None = None,
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> StudentBalanceList:
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return StudentBalanceList(items=[], total=0, page=page, page_size=page_size, session_id=None, session_name=None)

    ids = list(
        (
            await db.scalars(
                text("select id from public.student_enrollments where school_id = :s and academic_session_id = :sid"),
                {"s": ctx.school_id, "sid": session.id},
            )
        ).all()
    )
    if ids:
        await db.execute(_SYNC_SCHOOL, {"s": ctx.school_id, "ids": ids})  # keep dues in step with the fee structures
        await db.commit()

    where = ["e.school_id = :s", "e.academic_session_id = :sid"]
    params: dict = {"s": ctx.school_id, "sid": session.id}
    if class_id:
        where.append("e.class_id = :cid")
        params["cid"] = class_id
    if section_id:
        where.append("e.section_id = :secid")
        params["secid"] = section_id
    if search and search.strip():
        where.append(
            "(st.full_name ilike :q escape '\\' or st.student_code ilike :q escape '\\' "
            "or e.admission_number ilike :q escape '\\' or st.father_name ilike :q escape '\\')"
        )
        params["q"] = _like(" ".join(search.split()))
    if balance == "outstanding":
        where.append("t.outstanding > 0")
    elif balance == "overdue":
        where.append("t.overdue > 0")
    elif balance == "cleared":
        where.append("t.total > 0 and t.outstanding = 0")
    base = f"""
        from public.student_enrollments e
        join public.students st on st.id = e.student_id
        join public.classes c on c.id = e.class_id
        join public.sections sec on sec.id = e.section_id
        cross join lateral private.enrollment_fee_totals(array[e.id]) t
        where {" and ".join(where)}
    """
    total = (await db.execute(text(f"select count(*) {base}"), params)).scalar_one()
    rows = (
        await db.execute(
            text(
                f"select st.id, e.id, st.full_name, st.student_code, c.name || ' – ' || sec.name, e.admission_number, "
                f"st.status, t.total, t.paid, t.outstanding, t.overdue {base} "
                "order by c.display_order, lower(c.name), lower(sec.name), lower(st.full_name) limit :lim offset :off"
            ),
            {**params, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).all()
    items = [
        StudentBalanceRow(
            student_id=r[0],
            enrollment_id=r[1],
            student_name=r[2],
            student_code=r[3],
            class_section=r[4],
            admission_number=r[5],
            status=r[6],
            totals=FeeTotalsOut(total=r[7], paid=r[8], outstanding=r[9], overdue=r[10]),
        )
        for r in rows
    ]
    return StudentBalanceList(
        items=items, total=total, page=page, page_size=page_size, session_id=session.id, session_name=session.name
    )


# ------------------------------------------------------------------ one student
async def _payments(db: AsyncSession, ctx: SchoolContext, enrollment_id: uuid.UUID) -> list[PaymentSummary]:
    rows = (
        await db.execute(
            text(
                "select id, receipt_number, payment_date, amount, payment_mode, reference_number, balance_after, "
                "received_by_name, created_at, cancelled_at, cancel_reason from public.fee_payments "
                "where school_id = :s and enrollment_id = :e order by created_at desc"
            ),
            {"s": ctx.school_id, "e": enrollment_id},
        )
    ).all()
    return [
        PaymentSummary(
            id=r[0],
            receipt_number=r[1],
            payment_date=r[2],
            amount=r[3],
            payment_mode=r[4],
            reference_number=r[5],
            balance_after=r[6],
            received_by_name=r[7],
            created_at=r[8],
            cancelled_at=r[9],
            cancel_reason=r[10],
        )
        for r in rows
    ]


async def _account(
    db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID, session_id: uuid.UUID | None
) -> StudentFeeAccount:
    student = (
        await db.execute(
            text("select id, full_name, student_code, status from public.students where id = :id and school_id = :s"),
            {"id": student_id, "s": ctx.school_id},
        )
    ).first()
    if student is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found.")
    session = await resolve_session(db, ctx, session_id)
    enr = None
    if session is not None:
        enr = (
            await db.execute(
                text(
                    "select e.id, c.name || ' – ' || sec.name, e.admission_number, e.class_id from "
                    "public.student_enrollments e "
                    "join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id "
                    "where e.student_id = :st and e.academic_session_id = :sid and e.school_id = :s"
                ),
                {"st": student_id, "sid": session.id, "s": ctx.school_id},
            )
        ).first()
    common = dict(
        student_id=student[0],
        student_name=student[1],
        student_code=student[2],
        status=student[3],
        session_id=session.id if session else None,
        session_name=session.name if session else None,
        session_is_archived=bool(session and session.archived_at),
    )
    if enr is None:
        return StudentFeeAccount(
            **common,
            enrollment_id=None,
            class_section=None,
            admission_number=None,
            has_structure=False,
            structure_active=False,
            totals=ZERO,
            dues=[],
            optional_fees=[],
            payments=[],
        )

    await db.execute(_SYNC, {"ids": [enr[0]]})
    await db.commit()
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
                    "select due_id, fee_item_id, fee_head_name, frequency, is_optional, due_month, amount, "
                    "paid, balance "
                    "from private.student_fee_status(:e)"
                ),
                {"e": enr[0]},
            )
        ).all()
    ]
    structure = (
        await db.execute(
            text(
                "select id, is_active from public.fee_structures where school_id = :s and academic_session_id = :sid "
                "and class_id = :cid"
            ),
            {"s": ctx.school_id, "sid": session.id, "cid": enr[3]},
        )
    ).first()
    optional: list[OptionalFeeOut] = []
    if structure:
        optional = [
            OptionalFeeOut(fee_item_id=r[0], fee_head_name=r[1], amount=r[2], frequency=r[3], opted_in=r[4])
            for r in (
                await db.execute(
                    text(
                        "select i.id, h.name, i.amount, i.frequency, exists (select 1 from public.student_fee_optins o "
                        "where o.enrollment_id = :e and o.fee_item_id = i.id) "
                        "from public.fee_structure_items i join public.fee_heads h on h.id = i.fee_head_id "
                        "where i.fee_structure_id = :fs and i.is_optional order by i.sort_order, h.name"
                    ),
                    {"e": enr[0], "fs": structure[0]},
                )
            ).all()
        ]
    return StudentFeeAccount(
        **common,
        enrollment_id=enr[0],
        class_section=enr[1],
        admission_number=enr[2],
        has_structure=structure is not None,
        structure_active=bool(structure and structure[1]),
        totals=(await _totals(db, [enr[0]]))[enr[0]],
        dues=dues,
        optional_fees=optional,
        payments=await _payments(db, ctx, enr[0]),
    )


@router.get("/fee-collection/students/{student_id}", response_model=StudentFeeAccount)
async def get_account(
    student_id: uuid.UUID,
    session_id: uuid.UUID | None = None,
    ctx: SchoolContext = COLLECT,
    db: AsyncSession = Depends(get_db),
) -> StudentFeeAccount:
    return await _account(db, ctx, student_id, session_id)


async def _enrollment(db: AsyncSession, ctx: SchoolContext, enrollment_id: uuid.UUID):
    row = (
        await db.execute(
            text(
                "select e.id, e.student_id, e.academic_session_id, e.class_id from public.student_enrollments e "
                "where e.id = :e and e.school_id = :s"
            ),
            {"e": enrollment_id, "s": ctx.school_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Enrollment not found.")
    return row


@router.put("/fee-collection/enrollments/{enrollment_id}/optins", response_model=StudentFeeAccount)
async def set_optins(
    enrollment_id: uuid.UUID,
    payload: OptinsUpdate,
    request: Request,
    ctx: SchoolContext = COLLECT,
    db: AsyncSession = Depends(get_db),
) -> StudentFeeAccount:
    enr = await _enrollment(db, ctx, enrollment_id)
    allowed = set(
        (
            await db.scalars(
                text(
                    "select i.id from public.fee_structure_items i join public.fee_structures fs on fs.id = "
                    "i.fee_structure_id "
                    "where fs.school_id = :s and fs.academic_session_id = :sid and fs.class_id = :cid and i.is_optional"
                ),
                {"s": ctx.school_id, "sid": enr[2], "cid": enr[3]},
            )
        ).all()
    )
    wanted = set(payload.fee_item_ids)
    if wanted - allowed:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Only optional fees of this student's class can be chosen."
        )
    try:
        await db.execute(
            text(
                "delete from public.student_fee_optins where enrollment_id = :e and school_id = :s "
                "and not (fee_item_id = any(:keep))"
            ).bindparams(bindparam("keep", type_=ARRAY(UUID(as_uuid=True)))),
            {"e": enrollment_id, "s": ctx.school_id, "keep": list(wanted)},
        )
        for item in wanted:
            await db.execute(
                text(
                    "insert into public.student_fee_optins (school_id, enrollment_id, fee_item_id) values (:s, :e, :i) "
                    "on conflict do nothing"
                ),
                {"s": ctx.school_id, "e": enrollment_id, "i": item},
            )
        await db.execute(_SYNC, {"ids": [enrollment_id]})
        await write_audit(
            db,
            request,
            action="fees.optins_updated",
            entity_type="student",
            entity_id=str(enr[1]),
            school_id=ctx.school_id,
            metadata={"fee_item_ids": sorted(str(i) for i in wanted)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _account(db, ctx, enr[1], enr[2])


# ------------------------------------------------------------------ payments
async def _payment_detail(db: AsyncSession, ctx: SchoolContext, payment_id: uuid.UUID) -> PaymentDetail:
    p = (
        await db.execute(
            text(
                "select p.id, p.receipt_number, p.payment_date, p.amount, p.payment_mode, p.reference_number, "
                "p.balance_after, "
                "p.received_by_name, p.created_at, p.remarks, st.id, st.full_name, st.student_code, "
                "c.name || ' – ' || sec.name, e.admission_number, a.name, p.cancelled_at, p.cancel_reason "
                "from public.fee_payments p join public.students st on st.id = p.student_id "
                "join public.student_enrollments e on e.id = p.enrollment_id join public.classes c on c.id = "
                "e.class_id "
                "join public.sections sec on sec.id = e.section_id join public.academic_sessions a on a.id = "
                "p.academic_session_id "
                "where p.id = :id and p.school_id = :s"
            ),
            {"id": payment_id, "s": ctx.school_id},
        )
    ).first()
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payment not found.")
    lines = [
        PaymentLine(fee_head_name=r[0], due_month=r[1], frequency=r[2], amount=r[3])
        for r in (
            await db.execute(
                text(
                    # a cancelled (refunded) receipt keeps what it had paid in cancelled_allocations
                    "with al as (select due_id, amount from public.fee_payment_allocations where payment_id = :id "
                    "union all select (x->>'due_id')::uuid, (x->>'amount')::numeric from public.fee_payments fp, "
                    "jsonb_array_elements(coalesce(fp.cancelled_allocations, '[]')) x where fp.id = :id) "
                    "select h.name, d.due_month, i.frequency, al.amount from al "
                    "join public.student_fee_dues d on d.id = al.due_id join public.fee_heads h on h.id = "
                    "d.fee_head_id "
                    "join public.fee_structure_items i on i.id = d.fee_item_id "
                    "order by d.due_month, h.name"
                ),
                {"id": payment_id},
            )
        ).all()
    ]
    return PaymentDetail(
        id=p[0],
        receipt_number=p[1],
        payment_date=p[2],
        amount=p[3],
        payment_mode=p[4],
        reference_number=p[5],
        balance_after=p[6],
        received_by_name=p[7],
        created_at=p[8],
        remarks=p[9],
        student_id=p[10],
        student_name=p[11],
        student_code=p[12],
        class_section=p[13],
        admission_number=p[14],
        session_name=p[15],
        lines=lines,
        cancelled_at=p[16],
        cancel_reason=p[17],
    )


@router.post(
    "/fee-collection/enrollments/{enrollment_id}/payments",
    response_model=PaymentResult,
    status_code=status.HTTP_201_CREATED,
)
async def record_payment(
    enrollment_id: uuid.UUID,
    payload: PaymentCreate,
    request: Request,
    response: Response,
    ctx: SchoolContext = COLLECT,
    db: AsyncSession = Depends(get_db),
) -> PaymentResult:
    await _enrollment(db, ctx, enrollment_id)  # 404 unless the enrollment is in this school
    allocations = json.dumps([{"due_id": str(a.due_id), "amount": f"{a.amount:.2f}"} for a in payload.allocations])
    try:
        row = (
            await db.execute(
                text(
                    "select payment_id, receipt_number, duplicate from private.record_fee_payment("
                    ":e, :d, cast(:m as public.payment_mode), :ref, :rem, :key, cast(:al as jsonb))"
                ),
                {
                    "e": enrollment_id,
                    "d": payload.payment_date,
                    "m": payload.payment_mode,
                    "ref": payload.reference_number,
                    "rem": payload.remarks,
                    "key": payload.idempotency_key,
                    "al": allocations,
                },
            )
        ).first()
        payment_id, receipt, duplicate = row
        # the receipt is recorded in the audit log by the database (fee_payment.recorded, migration 0032)
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    if duplicate:
        response.status_code = status.HTTP_200_OK
    return PaymentResult(payment=await _payment_detail(db, ctx, payment_id), duplicate=duplicate)


class CancelIn(BaseModel):
    model_config = {"extra": "forbid"}
    reason: str = Field(min_length=5, max_length=300)


@router.post("/fee-payments/{payment_id}/cancel", response_model=PaymentDetail)
async def cancel_payment(
    payment_id: uuid.UUID,
    payload: CancelIn,
    ctx: SchoolContext = Depends(require_permission(Permission.FEES_CANCEL)),
    db: AsyncSession = Depends(get_db),
) -> PaymentDetail:
    """Reverses a receipt recorded at the desk: it stays on record, marked cancelled with the reason and what
    it had paid, and those dues become payable again. School admins only; receipts paid online are reversed
    by refunding them. Recorded in the audit log by the database (fee_payment.cancelled)."""
    if not await db.scalar(
        text("select exists (select 1 from public.fee_payments where id = :id and school_id = :s)"),
        {"id": payment_id, "s": ctx.school_id},
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Receipt not found.")
    try:
        await db.execute(text("select private.fee_payment_cancel(:id, :r)"), {"id": payment_id, "r": payload.reason})
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _payment_detail(db, ctx, payment_id)


@router.get("/fee-payments/{payment_id}", response_model=PaymentDetail)
async def get_payment(
    payment_id: uuid.UUID, ctx: SchoolContext = COLLECT, db: AsyncSession = Depends(get_db)
) -> PaymentDetail:
    return await _payment_detail(db, ctx, payment_id)


def _period(due_month: date, frequency: str, session_name: str) -> str:
    if frequency in ("yearly", "one_time"):
        return session_name
    return due_month.strftime("%b %Y")


LOGO_URL = re.compile(r"^[0-9a-f-]{36}/logo-[0-9a-f]{32}\.png$")


async def _logo(url: str | None) -> bytes | None:
    """The school's logo for a PDF. Only ever fetched from the platform's own logo storage: the URL is a
    stored value, and the server must not be made to request any other address (SSRF)."""
    prefix = storage.public_url(storage.LOGO_BUCKET, "")
    if not url or not url.startswith(prefix) or not LOGO_URL.match(url[len(prefix) :]):
        return None
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            res = await client.get(url)
        return res.content if res.status_code == 200 and res.content[:8] == b"\x89PNG\r\n\x1a\n" else None
    except httpx.HTTPError:
        return None


@router.get("/fee-payments/{payment_id}/receipt.pdf")
async def receipt_pdf(
    payment_id: uuid.UUID, ctx: SchoolContext = COLLECT, db: AsyncSession = Depends(get_db)
) -> Response:
    return await receipt_response(db, ctx, payment_id)


async def receipt_response(db: AsyncSession, ctx: SchoolContext, payment_id: uuid.UUID) -> Response:
    """Builds the receipt PDF. Callers must have checked access; RLS applies to every query."""
    d = await _payment_detail(db, ctx, payment_id)
    school = (
        await db.execute(
            text(
                "select name, address, city, state, postal_code, phone, email, affiliation_board, "
                "affiliation_number, logo_url "
                "from public.schools where id = :s"
            ),
            {"s": ctx.school_id},
        )
    ).first()
    extra = (
        await db.execute(
            text("select coalesce(nullif(father_name, ''), mother_name) from public.students where id = :id"),
            {"id": d.student_id},
        )
    ).scalar()
    address = ", ".join(x for x in (school[1], school[2], school[3], school[4]) if x)
    contact = " · ".join(x for x in (f"Phone {school[5]}" if school[5] else None, school[6]) if x)
    affiliation = f"{school[7]} affiliation no. {school[8]}" if school[7] and school[8] else (school[7] or None)
    pdf = build_receipt_pdf(
        ReceiptData(
            school_name=school[0],
            school_address=address,
            school_contact=contact,
            school_affiliation=affiliation,
            logo_png=await _logo(school[9]),
            receipt_number=d.receipt_number,
            payment_date=d.payment_date,
            session_name=d.session_name,
            student_name=d.student_name,
            student_code=d.student_code,
            class_section=d.class_section,
            admission_number=d.admission_number,
            parent_name=extra,
            lines=[
                ReceiptLine(line.fee_head_name, _period(line.due_month, line.frequency, d.session_name), line.amount)
                for line in d.lines
            ],
            total=d.amount,
            payment_mode=MODE_LABELS[d.payment_mode],
            reference_number=d.reference_number,
            remarks=d.remarks,
            balance_after=d.balance_after,
            received_by=d.received_by_name,
            generated_at=datetime.now(UTC),
            cancelled=(
                f"Cancelled on {d.cancelled_at.strftime('%d %b %Y')}. {d.cancel_reason or ''}".strip()
                if d.cancelled_at
                else None
            ),
        )
    )
    safe = d.receipt_number.replace("/", "-")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="receipt-{safe}.pdf"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/fee-payments")
async def list_payments(
    ctx: SchoolContext = COLLECT,
    db: AsyncSession = Depends(get_db),
    date_from: date | None = None,
    date_to: date | None = None,
    mode: Literal["cash", "upi", "bank_transfer", "cheque", "other", "online"] | None = None,
    search: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    """Payments register (day book). The total is summed in SQL; cancelled (refunded) receipts are
    listed but not counted."""
    where, params = ["p.school_id = :s"], {"s": ctx.school_id}
    if date_from:
        where.append("p.payment_date >= :df")
        params["df"] = date_from
    if date_to:
        where.append("p.payment_date <= :dt")
        params["dt"] = date_to
    if mode:
        where.append("p.payment_mode = cast(:m as public.payment_mode)")
        params["m"] = mode
    if search and search.strip():
        where.append(
            "(p.receipt_number ilike :q escape '\\' or st.full_name ilike :q escape '\\' "
            "or st.student_code ilike :q escape '\\' or p.reference_number ilike :q escape '\\')"
        )
        params["q"] = _like(" ".join(search.split()))
    base = f"from public.fee_payments p join public.students st on st.id = p.student_id where {' and '.join(where)}"
    count, total = (
        await db.execute(
            text(f"select count(*), coalesce(sum(p.amount) filter (where p.cancelled_at is null), 0) {base}"), params
        )
    ).one()
    rows = (
        await db.execute(
            text(
                f"select p.id, p.receipt_number, p.payment_date, p.amount, p.payment_mode, p.reference_number, "
                f"st.id, st.full_name, st.student_code, p.received_by_name, p.cancelled_at {base} "
                "order by p.payment_date desc, p.created_at desc limit :lim offset :off"
            ),
            {**params, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).all()
    return {
        "items": [
            {
                "id": str(r[0]),
                "receipt_number": r[1],
                "payment_date": r[2].isoformat(),
                "amount": f"{r[3]:.2f}",
                "payment_mode": r[4],
                "reference_number": r[5],
                "student_id": str(r[6]),
                "student_name": r[7],
                "student_code": r[8],
                "received_by_name": r[9],
                "cancelled": r[10] is not None,
            }
            for r in rows
        ],
        "total": count,
        "amount_total": f"{total:.2f}",
        "page": page,
        "page_size": page_size,
    }
