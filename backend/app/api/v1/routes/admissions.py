"""Online admission: the school's side.

Admins set which classes are open (seats, admission fee, last date), review
applications, verify, approve or reject, and create the student. Accountants
see applications and record the admission fee. Every workflow rule is enforced
by the database (migration 0017); the checks here give clearer messages first.
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.schemas.students import normalize_phone
from app.services import storage
from app.services.audit import write_audit
from app.services.documents import content_disposition
from app.services.receipts import ReceiptData, ReceiptLine, build_receipt_pdf

router = APIRouter(prefix="/admissions", tags=["admissions"])
VIEW = Depends(require_permission(Permission.ADMISSIONS_VIEW))
MANAGE = Depends(require_permission(Permission.ADMISSIONS_MANAGE))
FEE = Depends(require_permission(Permission.ADMISSIONS_FEE))
BUCKET = "admission-files"
NOT_FOUND = HTTPException(status.HTTP_404_NOT_FOUND, "Application not found.")
STATUSES = ("submitted", "under_review", "verified", "approved", "rejected", "fee_paid", "enrolled")
# admission document type -> student document type (Phase 6)
DOC_MAP = {
    "birth_certificate": "birth_certificate",
    "transfer_certificate": "transfer_certificate",
    "previous_report_card": "previous_marksheet",
    "address_proof": "address_proof",
    "parent_id_proof": "other",
    "other": "other",
}
DOC_LABEL = {
    "birth_certificate": "Birth certificate",
    "transfer_certificate": "Transfer certificate",
    "previous_report_card": "Previous report card",
    "address_proof": "Address proof",
    "parent_id_proof": "Parent's ID proof",
    "other": "Other document",
}


class _Strict(BaseModel):
    model_config = {"extra": "forbid"}


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


class WindowIn(_Strict):
    academic_session_id: uuid.UUID
    class_id: uuid.UUID
    is_open: bool
    seats: int | None = Field(default=None, ge=1, le=5000)
    admission_fee: Decimal = Field(ge=0, le=10000000, decimal_places=2)
    last_date: date | None = None
    instructions: str | None = Field(default=None, max_length=1000)
    _c = field_validator("instructions", mode="before")(classmethod(lambda cls, v: _clean(v)))


class StatusIn(_Strict):
    status: Literal["under_review", "verified", "approved", "rejected"]
    note: str | None = Field(default=None, max_length=500)
    rejection_reason: str | None = Field(default=None, max_length=500)
    _c = field_validator("note", "rejection_reason", mode="before")(classmethod(lambda cls, v: _clean(v)))


class FeeIn(_Strict):
    amount: Decimal = Field(ge=0, decimal_places=2)
    payment_mode: Literal["cash", "upi", "bank_transfer", "cheque", "other"] | None = None
    reference: str | None = Field(default=None, max_length=60)
    paid_on: date
    _c = field_validator("reference", mode="before")(classmethod(lambda cls, v: _clean(v)))


class DetailsIn(_Strict):
    """Corrections by the school before the application is completed."""

    student_name: str | None = Field(default=None, min_length=2, max_length=150)
    date_of_birth: date | None = None
    gender: Literal["male", "female", "other"] | None = None
    father_name: str | None = Field(default=None, max_length=150)
    mother_name: str | None = Field(default=None, max_length=150)
    contact_phone: str | None = None
    contact_email: EmailStr | None = None
    address_line: str | None = Field(default=None, min_length=5, max_length=300)
    city: str | None = Field(default=None, min_length=2, max_length=80)
    state: str | None = Field(default=None, min_length=2, max_length=80)
    postal_code: str | None = Field(default=None, pattern=r"^[0-9]{6}$")
    class_id: uuid.UUID | None = None
    review_note: str | None = Field(default=None, max_length=1000)

    _c = field_validator(
        "student_name", "father_name", "mother_name", "address_line", "city", "state", "review_note", mode="before"
    )(classmethod(lambda cls, v: _clean(v)))

    @field_validator("contact_phone", mode="before")
    @classmethod
    def _phone(cls, v: object) -> object:
        return normalize_phone(v) if isinstance(v, str) else v


class EnrollIn(_Strict):
    section_id: uuid.UUID
    admission_number: str | None = Field(default=None, max_length=30)
    admission_date: date | None = None
    invite_parent: bool = False
    _c = field_validator("admission_number", mode="before")(classmethod(lambda cls, v: _clean(v)))


def _money(v: Decimal | None) -> str | None:
    return None if v is None else f"{v:.2f}"


def _is_admin(ctx: SchoolContext) -> bool:
    return ctx.is_super_admin or "school_admin" in ctx.roles


# ------------------------------------------------------------------ windows (what is open)
@router.get("/windows")
async def list_windows(
    session_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    """Every active class of the session with its admission settings and counts."""
    rows = (
        await db.execute(
            text(
                "select c.id, c.name, w.id, coalesce(w.is_open, false), w.seats, w.admission_fee, "
                "w.last_date, w.instructions, "
                "(select count(*) from public.admission_applications x where x.academic_session_id = "
                ":sess and x.class_id = c.id), "
                "(select count(*) from public.admission_applications x where x.academic_session_id = "
                ":sess and x.class_id = c.id "
                " and x.status in ('approved', 'fee_paid', 'enrolled')) "
                "from public.classes c left join public.admission_windows w on w.class_id = c.id and "
                "w.academic_session_id = :sess "
                "where c.school_id = :s and c.is_active and c.deleted_at is null order by "
                "c.display_order, lower(c.name)"
            ),
            {"s": ctx.school_id, "sess": session_id},
        )
    ).all()
    return [
        {
            "class_id": str(r[0]),
            "class_name": r[1],
            "window_id": str(r[2]) if r[2] else None,
            "is_open": r[3],
            "seats": r[4],
            "admission_fee": _money(r[5]) if r[5] is not None else None,
            "last_date": r[6].isoformat() if r[6] else None,
            "instructions": r[7],
            "applications": r[8],
            "admitted": r[9],
        }
        for r in rows
    ]


@router.put("/windows")
async def save_window(
    payload: WindowIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    try:
        await db.execute(
            text(
                "insert into public.admission_windows (school_id, academic_session_id, class_id, "
                "is_open, seats, admission_fee, "
                "last_date, instructions) values (:s, :sess, :c, :o, :seats, :fee, :ld, :ins) "
                "on conflict (academic_session_id, class_id) do update set is_open = "
                "excluded.is_open, seats = excluded.seats, "
                "admission_fee = excluded.admission_fee, last_date = excluded.last_date, "
                "instructions = excluded.instructions"
            ),
            {
                "s": ctx.school_id,
                "sess": payload.academic_session_id,
                "c": payload.class_id,
                "o": payload.is_open,
                "seats": payload.seats,
                "fee": payload.admission_fee,
                "ld": payload.last_date,
                "ins": payload.instructions,
            },
        )
        await write_audit(
            db,
            request,
            action="admission_window.saved",
            entity_type="admission",
            school_id=ctx.school_id,
            metadata={"class_id": str(payload.class_id), "open": payload.is_open, "fee": str(payload.admission_fee)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await list_windows(payload.academic_session_id, ctx=ctx, db=db)


# ------------------------------------------------------------------ applications
_LIST = (
    "select x.id, x.application_number, x.status::text, x.student_name, x.date_of_birth, "
    "x.gender::text, x.contact_phone, "
    "x.father_name, x.mother_name, c.name as class_name, a.name as session_name, x.submitted_at, x.updated_at, "
    "(select count(*) from public.admission_documents d where d.application_id = x.id) as documents "
    "from public.admission_applications x join public.classes c on c.id = x.class_id "
    "join public.academic_sessions a on a.id = x.academic_session_id "
)


def _row(r) -> dict:
    return {
        "id": str(r.id),
        "application_number": r.application_number,
        "status": r.status,
        "student_name": r.student_name,
        "date_of_birth": r.date_of_birth.isoformat(),
        "gender": r.gender,
        "contact_phone": r.contact_phone,
        "parent_name": r.father_name or r.mother_name,
        "class_name": r.class_name,
        "session_name": r.session_name,
        "submitted_at": r.submitted_at.isoformat(),
        "updated_at": r.updated_at.isoformat(),
        "documents": r.documents,
    }


@router.get("")
async def list_applications(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = None,
    status_filter: Literal[STATUSES] | None = Query(default=None, alias="status"),  # type: ignore[valid-type]
    class_id: uuid.UUID | None = None,
    search: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    where, p = ["x.school_id = :s"], {"s": ctx.school_id}
    if session_id:
        where.append("x.academic_session_id = :sess")
        p["sess"] = session_id
    if class_id:
        where.append("x.class_id = :cls")
        p["cls"] = class_id
    if search and search.strip():
        digits = "".join(ch for ch in search if ch.isdigit())
        cond = (
            "(x.student_name ilike :q or x.application_number ilike :q or x.father_name ilike :q "
            "or x.mother_name ilike :q"
        )
        if len(digits) >= 4:
            cond += " or x.contact_phone like :d"
            p["d"] = f"%{digits}%"
        where.append(cond + ")")
        p["q"] = f"%{search.strip()}%"
    base = " where " + " and ".join(where)
    counts = {
        r[0]: r[1]
        for r in (
            await db.execute(
                text(f"select x.status::text, count(*) from public.admission_applications x {base} group by 1"), p
            )
        ).all()
    }
    if status_filter:
        base += " and x.status = cast(:st as public.admission_status)"
        p["st"] = status_filter
    total = (await db.execute(text(f"select count(*) from public.admission_applications x {base}"), p)).scalar_one()
    rows = (
        await db.execute(
            text(_LIST + base + " order by x.submitted_at desc limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).all()
    return {
        "items": [_row(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "counts": {s: counts.get(s, 0) for s in STATUSES},
    }


async def _application(db: AsyncSession, ctx: SchoolContext, app_id: uuid.UUID):
    r = (
        (
            await db.execute(
                text(
                    "select x.*, x.status::text as status_text, c.name as class_name, a.name as session_name, "
                    "a.archived_at is not null as session_archived, w.admission_fee as window_fee, w.seats, "
                    "(select count(*) from public.admission_applications y where "
                    "y.academic_session_id = x.academic_session_id "
                    " and y.class_id = x.class_id and y.status in ('approved', 'fee_paid', "
                    "'enrolled')) as seats_taken, "
                    "st.student_code "
                    "from public.admission_applications x join public.classes c on c.id = x.class_id "
                    "join public.academic_sessions a on a.id = x.academic_session_id "
                    "left join public.admission_windows w on w.academic_session_id = "
                    "x.academic_session_id and w.class_id = x.class_id "
                    "left join public.students st on st.id = x.student_id "
                    "where x.id = :id and x.school_id = :s"
                ),
                {"id": app_id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise NOT_FOUND
    return r


async def _detail(db: AsyncSession, ctx: SchoolContext, app_id: uuid.UUID) -> dict:
    r = await _application(db, ctx, app_id)
    docs = (
        await db.execute(
            text(
                "select id, document_type::text, file_name, mime_type, size_bytes from public.admission_documents "
                "where application_id = :a order by created_at"
            ),
            {"a": app_id},
        )
    ).all()
    events = (
        await db.execute(
            text(
                "select e.from_status::text, e.to_status::text, e.note, e.created_at, p.full_name "
                "from public.admission_events e left join public.profiles p on p.id = e.actor "
                "where e.application_id = :a order by e.id"
            ),
            {"a": app_id},
        )
    ).all()
    fields = (
        "student_name blood_group father_name father_phone father_occupation mother_name "
        "mother_phone mother_occupation "
        "contact_phone contact_email address_line city state postal_code previous_school previous_class previous_board "
        "review_note rejection_reason fee_reference fee_receipt_number"
    ).split()
    return {
        "id": str(r["id"]),
        "application_number": r["application_number"],
        "status": r["status_text"],
        **{k: r[k] for k in fields},
        "date_of_birth": r["date_of_birth"].isoformat(),
        "gender": str(r["gender"]),
        "academic_session_id": str(r["academic_session_id"]),
        "session_name": r["session_name"],
        "session_is_archived": r["session_archived"],
        "class_id": str(r["class_id"]),
        "class_name": r["class_name"],
        "has_photo": bool(r["photo_path"]),
        "submitted_at": r["submitted_at"].isoformat(),
        "fee_due": _money(r["fee_amount"] if r["fee_amount"] is not None else r["window_fee"]),
        "fee_amount": _money(r["fee_amount"]),
        "fee_paid_amount": _money(r["fee_paid_amount"]),
        "fee_payment_mode": str(r["fee_payment_mode"]) if r["fee_payment_mode"] else None,
        "fee_paid_on": r["fee_paid_on"].isoformat() if r["fee_paid_on"] else None,
        "seats": r["seats"],
        "seats_taken": r["seats_taken"],
        "student_id": str(r["student_id"]) if r["student_id"] else None,
        "student_code": r["student_code"],
        "documents": [
            {
                "id": str(d[0]),
                "document_type": d[1],
                "label": DOC_LABEL.get(d[1], d[1]),
                "file_name": d[2],
                "mime_type": d[3],
                "size_bytes": d[4],
            }
            for d in docs
        ],
        "timeline": [
            {
                "from": e[0],
                "to": e[1],
                "note": e[2],
                "at": e[3].isoformat(),
                "by": e[4] or ("Applicant" if e[0] is None else None),
            }
            for e in events
        ],
    }


@router.get("/{app_id}")
async def get_application(app_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    return await _detail(db, ctx, app_id)


def _stream_headers(name: str, mime: str, size: int | None, download: bool) -> dict:
    h = {
        "Content-Disposition": content_disposition("attachment" if download else "inline", name),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    }
    if size:
        h["Content-Length"] = str(size)
    return h


@router.get("/{app_id}/photo")
async def get_photo(app_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)):
    r = await _application(db, ctx, app_id)
    data = await storage.download(BUCKET, r["photo_path"])
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No photo.")
    return Response(data, media_type="image/jpeg", headers=_stream_headers("photo.jpg", "image/jpeg", None, False))


@router.get("/{app_id}/documents/{doc_id}")
async def get_document(
    app_id: uuid.UUID,
    doc_id: uuid.UUID,
    download: bool = False,
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
):
    await _application(db, ctx, app_id)
    d = (
        await db.execute(
            text(
                "select file_path, file_name, mime_type, size_bytes from public.admission_documents "
                "where id = :d and application_id = :a"
            ),
            {"d": doc_id, "a": app_id},
        )
    ).first()
    if d is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    try:
        body = await storage.open_stream(BUCKET, d[0])
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    return StreamingResponse(body, media_type=d[2], headers=_stream_headers(d[1], d[2], d[3], download))


async def _commit(
    db: AsyncSession, request: Request, ctx: SchoolContext, action: str, app_id: uuid.UUID, meta: dict
) -> None:
    await write_audit(
        db,
        request,
        action=action,
        entity_type="admission",
        entity_id=str(app_id),
        school_id=ctx.school_id,
        metadata=meta,
    )
    await db.commit()


@router.patch("/{app_id}")
async def update_details(
    app_id: uuid.UUID,
    payload: DetailsIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _application(db, ctx, app_id)
    fields = payload.model_dump(exclude_unset=True)
    for k in (
        "student_name",
        "date_of_birth",
        "gender",
        "contact_phone",
        "address_line",
        "city",
        "state",
        "postal_code",
        "class_id",
    ):
        if k in fields and fields[k] is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"{k.replace('_', ' ').capitalize()} can't be empty."
            )
    if fields:
        sets = ", ".join(f"{k} = cast(:{k} as public.gender)" if k == "gender" else f"{k} = :{k}" for k in fields)
        try:
            await db.execute(
                text(f"update public.admission_applications set {sets} where id = :id"), {**fields, "id": app_id}
            )
            await _commit(db, request, ctx, "admission.details_updated", app_id, {"fields": sorted(fields)})
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc) from None
    return await _detail(db, ctx, app_id)


@router.post("/{app_id}/status")
async def change_status(
    app_id: uuid.UUID,
    payload: StatusIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Review → verify → approve, or reject (with a reason the applicant will see)."""
    r = await _application(db, ctx, app_id)
    if payload.status == "rejected" and not payload.rejection_reason:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Give the reason for rejecting (the applicant will see it)."
        )
    try:
        await db.execute(
            text(
                "update public.admission_applications set status = cast(:st as "
                "public.admission_status), status_note = :n, "
                "rejection_reason = coalesce(:rr, rejection_reason) where id = :id"
            ),
            {"st": payload.status, "n": payload.note, "rr": payload.rejection_reason, "id": app_id},
        )
        await _commit(
            db, request, ctx, f"admission.{payload.status}", app_id, {"from": r["status_text"], "note": payload.note}
        )
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _detail(db, ctx, app_id)


@router.post("/{app_id}/fee")
async def record_fee(
    app_id: uuid.UUID, payload: FeeIn, request: Request, ctx: SchoolContext = FEE, db: AsyncSession = Depends(get_db)
) -> dict:
    r = await _application(db, ctx, app_id)
    if r["status_text"] != "approved":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "The admission fee is recorded after the application is approved."
        )
    if payload.amount != r["fee_amount"]:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"The admission fee is ₹{r['fee_amount']}; record exactly that amount.",
        )
    if payload.amount > 0 and not payload.payment_mode:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose how the fee was paid.")
    if payload.paid_on > date.today():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The payment date can't be in the future.")
    try:
        await db.execute(
            text(
                "update public.admission_applications set status = 'fee_paid', fee_paid_amount = :a, "
                "fee_payment_mode = cast(:m as public.payment_mode), fee_reference = :ref, fee_paid_on = :d, "
                "status_note = :note where id = :id"
            ),
            {
                "a": payload.amount,
                "m": payload.payment_mode,
                "ref": payload.reference,
                "d": payload.paid_on,
                "note": "No admission fee" if payload.amount == 0 else None,
                "id": app_id,
            },
        )
        await _commit(
            db,
            request,
            ctx,
            "admission.fee_recorded",
            app_id,
            {"amount": str(payload.amount), "mode": payload.payment_mode},
        )
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _detail(db, ctx, app_id)


@router.get("/{app_id}/fee-receipt.pdf")
async def fee_receipt(app_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> Response:
    from app.api.v1.routes.report_cards import school_info

    r = await _application(db, ctx, app_id)
    if not r["fee_receipt_number"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No admission fee has been recorded yet.")
    info = await school_info(db, ctx)
    who = (
        await db.execute(text("select full_name from public.profiles where id = :u"), {"u": r["fee_recorded_by"]})
    ).scalar()
    pdf = build_receipt_pdf(
        ReceiptData(
            school_name=info.name,
            school_address=info.address or "",
            school_contact=info.contact or "",
            school_affiliation=info.affiliation,
            logo_png=info.logo_png,
            receipt_number=r["fee_receipt_number"],
            payment_date=r["fee_paid_on"],
            session_name=r["session_name"],
            student_name=r["student_name"],
            student_code=r["application_number"],
            class_section=r["class_name"],
            admission_number=r["application_number"],
            parent_name=r["father_name"] or r["mother_name"],
            lines=[ReceiptLine("Admission fee", r["session_name"], r["fee_paid_amount"])],
            total=r["fee_paid_amount"],
            payment_mode=str(r["fee_payment_mode"] or "—"),
            reference_number=r["fee_reference"],
            remarks=f"Application {r['application_number']}",
            balance_after=Decimal(0),
            received_by=who,
            generated_at=datetime.now(UTC),
        )
    )
    return Response(
        pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="admission-receipt-{r["fee_receipt_number"]}.pdf"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/{app_id}/enroll")
async def enroll(
    app_id: uuid.UUID,
    payload: EnrollIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Creates the student (with enrollment, photo and documents) and completes the application."""
    r = await _application(db, ctx, app_id)
    if r["status_text"] != "fee_paid":
        raise HTTPException(status.HTTP_409_CONFLICT, "The student is created after the admission fee is recorded.")
    sec = (
        await db.execute(
            text(
                "select id from public.sections where id = :id and school_id = :s and class_id = :c "
                "and academic_session_id = :sess "
                "and is_active and deleted_at is null"
            ),
            {"id": payload.section_id, "s": ctx.school_id, "c": r["class_id"], "sess": r["academic_session_id"]},
        )
    ).scalar()
    if sec is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Choose an active section of {r['class_name']}.")
    admission_number = payload.admission_number or r["application_number"]
    admission_date = payload.admission_date or date.today()
    address = ", ".join(x for x in (r["address_line"], r["city"], r["state"], r["postal_code"]) if x)

    student_id = uuid.uuid4()
    copied: list[tuple[str, str]] = []  # (bucket, path) to clean up on failure
    photo_path = None
    try:
        photo = await storage.download(BUCKET, r["photo_path"])
        if photo:
            photo_path = f"{ctx.school_id}/{student_id}/{uuid.uuid4().hex}.jpg"
            await storage.upload(storage.PHOTO_BUCKET, photo_path, photo, "image/jpeg")
            copied.append((storage.PHOTO_BUCKET, photo_path))
        docs = (
            await db.execute(
                text(
                    "select document_type::text, file_name, mime_type, size_bytes, file_path from "
                    "public.admission_documents where application_id = :a"
                ),
                {"a": app_id},
            )
        ).all()
        doc_rows = []
        for d in docs:
            data = await storage.download(BUCKET, d[4], max_bytes=11 * 1024 * 1024)
            if data is None:
                continue
            ext = d[1].rsplit(".", 1)[-1] if "." in d[1] else "pdf"
            doc_id = uuid.uuid4()
            path = f"{ctx.school_id}/{student_id}/{doc_id.hex}.{ext}"
            await storage.upload(storage.DOCUMENT_BUCKET, path, data, d[2])
            copied.append((storage.DOCUMENT_BUCKET, path))
            doc_rows.append(
                (
                    doc_id,
                    DOC_MAP.get(d[0], "other"),
                    DOC_LABEL.get(d[0]) if DOC_MAP.get(d[0]) == "other" else None,
                    path,
                    d[1],
                    d[2],
                    len(data),
                )
            )
    except storage.StorageError as exc:
        for b, p in copied:
            await storage.delete(b, p)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None

    try:
        await db.execute(
            text(
                "insert into public.students (id, school_id, full_name, father_name, mother_name, "
                "date_of_birth, gender, mobile, "
                "address, photo_path, created_by) values (:id, :s, :n, :f, :m, :dob, cast(:g as "
                "public.gender), :mob, :addr, :photo, :by)"
            ),
            {
                "id": student_id,
                "s": ctx.school_id,
                "n": r["student_name"],
                "f": r["father_name"],
                "m": r["mother_name"],
                "dob": r["date_of_birth"],
                "g": str(r["gender"]),
                "mob": r["contact_phone"],
                "addr": address[:500],
                "photo": photo_path,
                "by": user.id,
            },
        )
        await db.execute(
            text(
                "insert into public.student_enrollments (school_id, student_id, academic_session_id, "
                "class_id, section_id, "
                "admission_number, admission_date, created_by) values (:s, :st, :sess, :c, :sec, :an, :ad, :by)"
            ),
            {
                "s": ctx.school_id,
                "st": student_id,
                "sess": r["academic_session_id"],
                "c": r["class_id"],
                "sec": payload.section_id,
                "an": admission_number,
                "ad": admission_date,
                "by": user.id,
            },
        )
        for doc_id, dtype, title, path, name, mime, size in doc_rows:
            await db.execute(
                text(
                    "insert into public.student_documents (id, school_id, student_id, document_type, "
                    "title, file_path, file_name, "
                    "mime_type, size_bytes, uploaded_by) values (:id, :s, :st, cast(:t as "
                    "public.student_document_type), :title, :p, :n, :m, :b, :by)"
                ),
                {
                    "id": doc_id,
                    "s": ctx.school_id,
                    "st": student_id,
                    "t": dtype,
                    "title": title,
                    "p": path,
                    "n": name,
                    "m": mime,
                    "b": size,
                    "by": user.id,
                },
            )
        await db.execute(
            text(
                "update public.admission_applications set status = 'enrolled', student_id = :st, "
                "status_note = :note where id = :id"
            ),
            {"st": student_id, "note": f"Admission no. {admission_number}", "id": app_id},
        )
        await _commit(
            db,
            request,
            ctx,
            "admission.enrolled",
            app_id,
            {"student_id": str(student_id), "admission_number": admission_number, "documents": len(doc_rows)},
        )
    except DBAPIError as exc:
        for b, p in copied:
            await storage.delete(b, p)
        raise await http_error_from_db(
            db,
            exc,
            {"student_enrollments_admission_number_key": "This admission number is already used in this session."},
        ) from None

    invite_error = None
    if payload.invite_parent and r["contact_email"]:
        from app.api.v1.routes.guardians import GuardianIn, link_guardian

        try:
            await link_guardian(
                student_id,
                GuardianIn(
                    email=r["contact_email"],
                    full_name=r["father_name"] or r["mother_name"] or "Parent",
                    relationship="father" if r["father_name"] else "mother",
                ),
                request,
                ctx=ctx,
                user=user,
                db=db,
            )
        except HTTPException as exc:  # the student exists either way; report the invitation problem
            invite_error = str(exc.detail)
    out = await _detail(db, ctx, app_id)
    out["parent_invite_error"] = invite_error
    return out
