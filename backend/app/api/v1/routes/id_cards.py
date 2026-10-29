"""ID cards for students, teachers and non-teaching staff (including drivers and attendants).

Cards are issued in the database (private.id_card_issue, migration 0026): one valid
card per person. Printing again reuses the valid card (same QR code); "issue new
cards" replaces it, and the old card then shows as replaced when scanned. Student
cards carry the student ID, staff cards the employee ID (drivers and attendants get a
T-0001 number on their first card). Teacher cards are for teaching staff and staff
cards for non-teaching staff, as set on the staff record. School admins only.
"""

import asyncio
import uuid
from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.certificates import (
    frontend_verify_url,
    school_for_documents,
    settings_row,
    today_ist,
)
from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services import storage
from app.services.audit import write_audit
from app.services.id_card_pdf import CardFace, CardSheet, build_id_cards_pdf

router = APIRouter(prefix="/id-cards", tags=["id-cards"])
MANAGE = Depends(require_permission(Permission.ID_CARDS_MANAGE))
HolderKind = Literal["student", "teacher", "staff"]
KIND_LABEL = {"student": "Student", "teacher": "Teacher", "staff": "Staff"}


def _like(term: str) -> str:
    return "%" + " ".join(term.split()).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ------------------------------------------------------------------ people
_CURRENT_CLASS = (
    "(select c2.name || ' – ' || sec.name from public.student_enrollments en "
    "join public.classes c2 on c2.id = en.class_id join public.sections sec on sec.id = en.section_id "
    "join public.academic_sessions a on a.id = en.academic_session_id "
    "where en.student_id = {sid} and a.is_current limit 1)"
)
_CARD = (
    "(select jsonb_build_object('id', k.id, 'card_number', k.card_number, 'valid_until', k.valid_until, "
    "'issued_on', k.issued_on) from public.id_cards k where k.{col} = {pid} and k.status = 'active')"
)


@router.get("/people")
async def people(
    kind: HolderKind,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
    class_id: uuid.UUID | None = None,
    section_id: uuid.UUID | None = None,
    q: str | None = Query(default=None, max_length=100),
    without_card: bool = False,
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=50, ge=1, le=500),
) -> dict:
    """Who can get a card of this kind: active students (current session), active teaching staff, or active
    non-teaching staff plus drivers and attendants — each with their valid card, if any."""
    p: dict[str, Any] = {"s": ctx.school_id}
    if kind == "student":
        where = ["st.school_id = :s", "st.status = 'active'"]
        if class_id or section_id:
            where.append(
                "exists (select 1 from public.student_enrollments en join public.academic_sessions a "
                "on a.id = en.academic_session_id and a.is_current where en.student_id = st.id "
                + ("and en.class_id = :cid " if class_id else "")
                + ("and en.section_id = :sec" if section_id else "")
                + ")"
            )
            if class_id:
                p["cid"] = class_id
            if section_id:
                p["sec"] = section_id
        if q and q.strip():
            where.append("(st.full_name ilike :q escape '\\' or st.student_code ilike :q escape '\\')")
            p["q"] = _like(q)
        base = (
            f"select st.id, st.full_name as name, st.student_code as number, {_CURRENT_CLASS.format(sid='st.id')} "
            f"as detail, st.photo_path is not null as has_photo, {_CARD.format(col='student_id', pid='st.id')} as card "
            f"from public.students st where {' and '.join(where)}"
        )
        order = "detail nulls last, lower(name)"
    else:
        tw = ["t.school_id = :s", "t.status = 'active'", "t.staff_type = :stype"]
        p["stype"] = "teaching" if kind == "teacher" else "non_teaching"
        if q and q.strip():
            tw.append("(t.full_name ilike :q escape '\\' or t.employee_id ilike :q escape '\\')")
            p["q"] = _like(q)
        base = (
            "select t.id, t.full_name as name, t.employee_id as number, "
            "coalesce(t.designation, case t.staff_type when 'teaching' then 'Teacher' else 'Staff' end) as detail, "
            f"t.photo_path is not null as has_photo, {_CARD.format(col='teacher_id', pid='t.id')} as card "
            f"from public.teachers t where {' and '.join(tw)}"
        )
        if kind == "staff":
            xw = ["x.school_id = :s", "x.status = 'active'"]
            if q and q.strip():
                xw.append("x.full_name ilike :q escape '\\'")
            base += (
                " union all select x.id, x.full_name, "
                "(select k.card_number from public.id_cards k where k.transport_staff_id = x.id order by k.created_at "
                "limit 1), initcap(x.role), false, "
                f"{_CARD.format(col='transport_staff_id', pid='x.id')} from public.transport_staff x "
                f"where {' and '.join(xw)}"
            )
        order = "lower(name)"
    outer = "select * from (" + base + ") z" + (" where z.card is null" if without_card else "")
    total = (await db.execute(text(f"select count(*) from ({outer}) y"), p)).scalar_one()
    rows = (
        (
            await db.execute(
                text(f"{outer} order by {order} limit :lim offset :off"),
                {**p, "lim": page_size, "off": (page - 1) * page_size},
            )
        )
        .mappings()
        .all()
    )
    return {"items": [dict(r) for r in rows], "total": total, "page": page, "page_size": page_size}


# ------------------------------------------------------------------ printing
async def _faces(db: AsyncSession, ctx: SchoolContext, card_ids: list[uuid.UUID]) -> list[CardFace]:
    """Everything printed on the cards, read from the school's records, in the order given."""
    if not card_ids:
        return []
    rows = (
        (
            await db.execute(
                text(
                    "select k.*, s.full_name as s_name, s.father_name, s.mother_name, s.date_of_birth, s.mobile, "
                    "s.photo_path as s_photo, " + _CURRENT_CLASS.format(sid="k.student_id") + " as s_class, "
                    "t.full_name as t_name, t.phone as t_phone, t.photo_path as t_photo, "
                    "coalesce(t.designation, case t.staff_type when 'teaching' then 'Teacher' else 'Staff' end) "
                    "as t_post, "
                    "x.full_name as x_name, x.phone as x_phone, x.role as x_role, x.license_number "
                    "from public.id_cards k left join public.students s on s.id = k.student_id "
                    "left join public.teachers t on t.id = k.teacher_id "
                    "left join public.transport_staff x on x.id = k.transport_staff_id "
                    "where k.school_id = :s and k.id = any(:ids)"
                ).bindparams(bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))),
                {"s": ctx.school_id, "ids": card_ids},
            )
        )
        .mappings()
        .all()
    )
    by_id = {r["id"]: r for r in rows}
    sem = asyncio.Semaphore(8)

    async def photo(bucket: str, path: str | None) -> bytes | None:
        if not path:
            return None
        async with sem:
            return await storage.download(bucket, path)

    ordered = [by_id[i] for i in card_ids if i in by_id]
    photos = await asyncio.gather(
        *(
            photo(storage.PHOTO_BUCKET, r["s_photo"])
            if r["student_id"]
            else photo(storage.STAFF_PHOTO_BUCKET, r["t_photo"])
            if r["teacher_id"]
            else photo("", None)
            for r in ordered
        )
    )
    faces = []
    for r, ph in zip(ordered, photos, strict=True):
        common = {
            "kind": r["holder_kind"],
            "number": r["card_number"],
            "verify_url": frontend_verify_url(r["verify_token"]),
            "valid_until": r["valid_until"],
            "status": r["status"],
            "photo": ph,
        }
        if r["student_id"]:
            rows_ = []
            if r["father_name"]:
                rows_.append(("Father", r["father_name"]))
            elif r["mother_name"]:
                rows_.append(("Mother", r["mother_name"]))
            rows_.append(("DOB", f"{r['date_of_birth'].day} {r['date_of_birth']:%b %Y}"))
            rows_.append(("Phone", r["mobile"]))
            faces.append(CardFace(name=r["s_name"], line=r["s_class"], rows=rows_, emergency=r["mobile"], **common))
        elif r["teacher_id"]:
            faces.append(CardFace(name=r["t_name"], line=r["t_post"], rows=[("Phone", r["t_phone"])], **common))
        else:
            rows_ = [("Phone", r["x_phone"])]
            if r["license_number"]:
                rows_.append(("Licence", r["license_number"]))
            faces.append(CardFace(name=r["x_name"], line=r["x_role"].capitalize(), rows=rows_, **common))
    return faces


async def _pdf(db: AsyncSession, ctx: SchoolContext, card_ids: list[uuid.UUID], back: bool) -> bytes:
    ds = await settings_row(db, ctx)
    sheet = CardSheet(
        school=await school_for_documents(db, ctx),
        accent=ds["accent_color"],
        signatory_title=ds["signatory_title"],
        signature_png=await storage.download(storage.DOCUMENT_ASSET_BUCKET, ds["signature_path"]),
        back_note=ds["card_back_note"],
        cards=await _faces(db, ctx, card_ids),
    )
    return await run_in_threadpool(build_id_cards_pdf, sheet, back)


def _pdf_response(pdf: bytes, name: str) -> Response:
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{name}.pdf"', "Cache-Control": "private, no-store"},
    )


class PrintIn(BaseModel):
    model_config = {"extra": "forbid"}

    kind: HolderKind
    ids: list[uuid.UUID] = Field(min_length=1, max_length=500)
    valid_until: date | None = None  # default: the school's card validity, else the end of the current session
    replace: bool = False  # issue new cards (the old ones stop being valid) instead of reprinting the valid ones
    back: bool = False  # add the back side, mirrored for double-sided printing

    @field_validator("ids")
    @classmethod
    def _unique(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        return list(dict.fromkeys(v))


@router.post("/print")
async def print_cards(
    payload: PrintIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> Response:
    ds = await settings_row(db, ctx)
    valid_until = payload.valid_until or ds["card_valid_until"] or ds["session_end"]
    if valid_until is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose how long the cards are valid (there is no current session)."
        )
    if valid_until < today_ist():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"The cards would already have expired ({valid_until:%d %b %Y}). Choose a later 'valid until' date.",
        )
    try:
        before = set(
            (
                await db.execute(
                    text("select id from public.id_cards where school_id = :s and status = 'active'"),
                    {"s": ctx.school_id},
                )
            ).scalars()
        )
        card_ids = list(
            (
                await db.execute(
                    text("select * from private.id_card_issue(:s, :kind, :ids, :vu, :rep)").bindparams(
                        bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
                    ),
                    {"s": ctx.school_id, "kind": payload.kind, "ids": payload.ids, "vu": valid_until,
                     "rep": payload.replace},
                )
            ).scalars()
        )  # fmt: skip
        new = [c for c in card_ids if c not in before]
        await write_audit(
            db,
            request,
            action="id_cards.printed",
            entity_type="id_card",
            entity_id=None,
            school_id=ctx.school_id,
            metadata={"kind": payload.kind, "cards": len(card_ids), "new": len(new), "replace": payload.replace},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    pdf = await _pdf(db, ctx, card_ids, payload.back)
    return _pdf_response(pdf, f"id-cards-{payload.kind}-{today_ist():%Y%m%d}")


# ------------------------------------------------------------------ issued cards
class CardOut(BaseModel):
    id: uuid.UUID
    holder_kind: str
    kind_label: str
    holder_id: uuid.UUID
    holder_name: str
    detail: str | None
    card_number: str
    valid_until: date
    issued_on: date
    status: str  # active | replaced | revoked | expired (active but past its date)
    revoke_reason: str | None
    revoked_at: datetime | None
    issued_by_name: str | None


CARD_SELECT = (
    "select k.*, coalesce(k.student_id, k.teacher_id, k.transport_staff_id) as holder_id, "
    "coalesce(s.full_name, t.full_name, x.full_name) as holder_name, "
    "case when k.student_id is not null then " + _CURRENT_CLASS.format(sid="k.student_id") + " "
    "when k.teacher_id is not null then coalesce(t.designation, case t.staff_type when 'teaching' then 'Teacher' "
    "else 'Staff' end) else initcap(x.role) end as detail, "
    "(select p.full_name from public.profiles p where p.id = k.issued_by) as issued_by_name "
    "from public.id_cards k left join public.students s on s.id = k.student_id "
    "left join public.teachers t on t.id = k.teacher_id "
    "left join public.transport_staff x on x.id = k.transport_staff_id"
)


def _card_out(r) -> CardOut:
    st = r["status"]
    if st == "active" and r["valid_until"] < today_ist():
        st = "expired"
    return CardOut(
        **{k: r[k] for k in CardOut.model_fields if k not in ("kind_label", "status")},
        kind_label=KIND_LABEL[r["holder_kind"]],
        status=st,
    )


@router.get("")
async def list_cards(
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
    kind: HolderKind | None = None,
    status_filter: Literal["active", "replaced", "revoked", "expired"] | None = Query(default=None, alias="status"),
    q: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    where, p = ["k.school_id = :s"], {"s": ctx.school_id, "today": today_ist()}
    if kind:
        where.append("k.holder_kind = :kind")
        p["kind"] = kind
    if status_filter == "expired":
        where.append("k.status = 'active' and k.valid_until < :today")
    elif status_filter == "active":
        where.append("k.status = 'active' and k.valid_until >= :today")
    elif status_filter:
        where.append("k.status = :st")
        p["st"] = status_filter
    if q and q.strip():
        where.append(
            "(coalesce(s.full_name, t.full_name, x.full_name) ilike :q escape '\\' "
            "or k.card_number ilike :q escape '\\')"
        )
        p["q"] = _like(q)
    w = " and ".join(where)
    joins = (
        "from public.id_cards k left join public.students s on s.id = k.student_id "
        "left join public.teachers t on t.id = k.teacher_id "
        "left join public.transport_staff x on x.id = k.transport_staff_id"
    )
    total = (await db.execute(text(f"select count(*) {joins} where {w}"), p)).scalar_one()
    rows = (
        (
            await db.execute(
                text(f"{CARD_SELECT} where {w} order by k.created_at desc limit :lim offset :off"),
                {**p, "lim": page_size, "off": (page - 1) * page_size},
            )
        )
        .mappings()
        .all()
    )
    return {"items": [_card_out(r) for r in rows], "total": total, "page": page, "page_size": page_size}


async def _card(db: AsyncSession, ctx: SchoolContext, card_id: uuid.UUID):
    r = (
        (
            await db.execute(
                text(f"{CARD_SELECT} where k.id = :id and k.school_id = :s"), {"id": card_id, "s": ctx.school_id}
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ID card not found.")
    return r


class RevokeIn(BaseModel):
    model_config = {"extra": "forbid"}

    reason: str = Field(min_length=3, max_length=300)

    @field_validator("reason", mode="before")
    @classmethod
    def _clean(cls, v: object) -> object:
        return " ".join(v.split()) if isinstance(v, str) else v


@router.post("/{card_id}/revoke", response_model=CardOut)
async def revoke(
    card_id: uuid.UUID,
    payload: RevokeIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> CardOut:
    r = await _card(db, ctx, card_id)
    try:
        await db.execute(text("select private.id_card_revoke(:id, :reason)"), {"id": card_id, "reason": payload.reason})
        await write_audit(
            db,
            request,
            action="id_card.revoked",
            entity_type="id_card",
            entity_id=str(card_id),
            school_id=ctx.school_id,
            metadata={"number": r["card_number"], "holder": r["holder_name"], "reason": payload.reason},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return _card_out(await _card(db, ctx, card_id))


@router.get("/{card_id}/card.pdf")
async def card_pdf(
    card_id: uuid.UUID, back: bool = False, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> Response:
    r = await _card(db, ctx, card_id)
    return _pdf_response(await _pdf(db, ctx, [card_id], back), f"id-card-{r['card_number']}")
