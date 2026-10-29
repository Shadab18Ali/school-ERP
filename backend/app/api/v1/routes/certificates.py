"""Certificates: bonafide, character, transfer, study and the school's own custom ones.

The database does the work (migration 0026): a certificate is filled in from the
student's record, enrollment and the school's details by private.certificate_render,
numbered per prefix and year (BC-2026-0001), and then fixed for good — it can only
be revoked, with a reason. A student holds at most one valid transfer certificate.
Only school admins (and the platform's super admin) can see or issue any of this.

The browser sends only *which* template, student and session, the date, the purpose
and any extra fields the template asks for (e.g. the date of leaving on a TC); it
never supplies the student's details.
"""

import json
import uuid
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import SchoolContext, get_db, get_school_context, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db, pg_error
from app.services import storage
from app.services.audit import write_audit
from app.services.certificate_pdf import CertificateDoc, build_certificate_pdf
from app.services.exports import to_csv
from app.services.images import LogoError, process_signature

router = APIRouter(prefix="/certificates", tags=["certificates"])
settings_router = APIRouter(prefix="/document-settings", tags=["certificates"])
MANAGE = Depends(require_permission(Permission.CERTIFICATES_MANAGE))
IST = ZoneInfo("Asia/Kolkata")

Kind = Literal["bonafide", "character", "transfer", "study", "custom"]
KIND_LABEL = {
    "bonafide": "Bonafide",
    "character": "Character",
    "transfer": "Transfer (TC)",
    "study": "Study",
    "custom": "Custom",
}
UNIQUE = {"certificate_templates_name_key": "A certificate template with this name already exists."}

# Must match private.certificate_placeholders() (a unit test checks this against the migration).
PLACEHOLDERS: list[tuple[str, str]] = [
    ("student_name", "Student's name"),
    ("father_name", "Father's name"),
    ("mother_name", "Mother's name"),
    ("parent_name", "Father's name, or the mother's if none"),
    ("gender", "Gender (Male / Female / Other)"),
    ("son_daughter", "son / daughter"),
    ("he_she", "he / she"),
    ("he_she_cap", "He / She"),
    ("his_her", "his / her"),
    ("his_her_cap", "His / Her"),
    ("him_her", "him / her"),
    ("date_of_birth", "Date of birth (5 May 2015)"),
    ("date_of_birth_words", "Date of birth in words"),
    ("student_code", "Student ID"),
    ("admission_number", "Admission number (that session)"),
    ("admission_date", "Admission date (that session)"),
    ("first_admission_date", "Date of first admission"),
    ("first_class", "Class at first admission"),
    ("class_name", "Class"),
    ("section_name", "Section"),
    ("class_section", "Class – section"),
    ("session_name", "Academic session"),
    ("session_start", "Session start date"),
    ("session_end", "Session end date"),
    ("address", "Student's address"),
    ("school_name", "School name"),
    ("school_address", "School address"),
    ("place", "Place"),
    ("affiliation", "Board affiliation"),
    ("issue_date", "Date of issue"),
    ("certificate_number", "Certificate number"),
    ("purpose", "Purpose (asked when issuing)"),
    ("principal_name", "Principal's name"),
    ("signatory_title", "Signatory's title"),
]

# Starting templates for a school, written once (the school edits them freely afterwards).
DEFAULT_TEMPLATES: list[dict[str, Any]] = [
    {
        "kind": "bonafide",
        "name": "Bonafide certificate",
        "title": "Bonafide Certificate",
        "prefix": "BC",
        "body": (
            "This is to certify that {{student_name}}, {{son_daughter}} of {{parent_name}}, is a bonafide student of "
            "{{school_name}}, studying in {{class_section}} during the academic session {{session_name}}. "
            "{{his_her_cap}} admission number is {{admission_number}} and {{his_her}} date of birth as per the school "
            "records is {{date_of_birth}} ({{date_of_birth_words}}).\n\n"
            "This certificate is issued on request for {{purpose}}."
        ),
        "fields": [],
        "show_photo": False,
    },
    {
        "kind": "character",
        "name": "Character certificate",
        "title": "Character Certificate",
        "prefix": "CC",
        "body": (
            "This is to certify that {{student_name}}, {{son_daughter}} of {{parent_name}}, was a student of "
            "{{school_name}} and studied in {{class_section}} during the academic session {{session_name}}.\n\n"
            "To the best of our knowledge, {{student_name}} bears a good moral character. {{his_her_cap}} conduct "
            "during {{his_her}} time at the school was {{conduct}}.\n\n"
            "We wish {{him_her}} every success in life."
        ),
        "fields": [{"key": "conduct", "label": "Conduct", "type": "text", "required": True}],
        "show_photo": False,
    },
    {
        "kind": "transfer",
        "name": "Transfer certificate",
        "title": "Transfer Certificate",
        "prefix": "TC",
        "body": (
            "Admission number: {{admission_number}}\n"
            "Name of the student: {{student_name}}\n"
            "Father's / guardian's name: {{parent_name}}\n"
            "Date of birth: {{date_of_birth}} ({{date_of_birth_words}})\n"
            "Date of first admission: {{first_admission_date}}, in {{first_class}}\n"
            "Class last studied: {{class_section}} (session {{session_name}})\n"
            "Whether qualified for promotion: {{promotion}}\n"
            "Fees paid up to: {{fees_paid_up_to}}\n"
            "Date of leaving: {{leaving_date}}\n"
            "Reason for leaving: {{reason}}\n"
            "General conduct: {{conduct}}\n"
            "Remarks: {{remarks}}\n\n"
            "Certified that the above particulars are as per the school records."
        ),
        "fields": [
            {"key": "leaving_date", "label": "Date of leaving", "type": "date", "required": True},
            {"key": "reason", "label": "Reason for leaving", "type": "text", "required": True},
            {"key": "promotion", "label": "Qualified for promotion", "type": "text", "required": False},
            {"key": "fees_paid_up_to", "label": "Fees paid up to", "type": "text", "required": False},
            {"key": "conduct", "label": "General conduct", "type": "text", "required": True},
            {"key": "remarks", "label": "Remarks", "type": "text", "required": False},
        ],
        "show_photo": False,
    },
    {
        "kind": "study",
        "name": "Study certificate",
        "title": "Study Certificate",
        "prefix": "SC",
        "body": (
            "This is to certify that {{student_name}}, {{son_daughter}} of {{parent_name}}, studied in "
            "{{school_name}} from {{first_admission_date}} (admitted to {{first_class}}), and was in "
            "{{class_section}} during the academic session {{session_name}}.\n\n"
            "{{his_her_cap}} date of birth as recorded in the school register is {{date_of_birth}}.\n\n"
            "This certificate is issued for {{purpose}}."
        ),
        "fields": [],
        "show_photo": True,
    },
]


def frontend_verify_url(token: str) -> str:
    return f"{get_settings().frontend_url.rstrip('/')}/verify/{token}"


def today_ist() -> date:
    return datetime.now(IST).date()


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


async def documents_context(ctx: SchoolContext = Depends(get_school_context)) -> SchoolContext:
    """Settings serve both certificates and ID cards."""
    if not (ctx.can(Permission.CERTIFICATES_MANAGE) or ctx.can(Permission.ID_CARDS_MANAGE)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow this action.")
    return ctx


DOCS = Depends(documents_context)


# ================================================================== settings
class SettingsIn(BaseModel):
    model_config = {"extra": "forbid"}

    principal_name: str | None = Field(default=None, min_length=2, max_length=100)
    signatory_title: str = Field(default="Principal", min_length=2, max_length=40)
    place: str | None = Field(default=None, min_length=2, max_length=60)
    accent_color: str = Field(default="#2f6b57", pattern=r"^#[0-9a-fA-F]{6}$")
    card_valid_until: date | None = None
    card_back_note: str | None = Field(default=None, max_length=200)

    _c = field_validator("principal_name", "signatory_title", "place", "card_back_note", mode="before")(
        classmethod(lambda cls, v: _clean(v))
    )

    @field_validator("accent_color")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.lower()


async def ensure_settings(db: AsyncSession, ctx: SchoolContext) -> None:
    """The first visit creates the school's settings row and its starting templates (once)."""
    created = (
        await db.execute(
            text(
                "insert into public.document_settings (school_id) values (:s) "
                "on conflict do nothing returning school_id"
            ),
            {"s": ctx.school_id},
        )
    ).first()
    if created:
        for t in DEFAULT_TEMPLATES:
            await db.execute(
                text(
                    "insert into public.certificate_templates (school_id, kind, name, title, prefix, body, fields, "
                    "show_photo) values (:s, :kind, :name, :title, :prefix, :body, cast(:fields as jsonb), "
                    ":show_photo) "
                    "on conflict do nothing"
                ),
                {"s": ctx.school_id, **t, "fields": json.dumps(t["fields"])},
            )
    await db.commit()


async def settings_row(db: AsyncSession, ctx: SchoolContext):
    await ensure_settings(db, ctx)
    return (
        (
            await db.execute(
                text(
                    "select ds.*, s.name as school_name, (s.logo_url is not null) as has_logo, "
                    "(select end_date from public.academic_sessions a "
                    "where a.school_id = ds.school_id and a.is_current) "
                    "as session_end from public.document_settings ds join public.schools s on s.id = ds.school_id "
                    "where ds.school_id = :s"
                ),
                {"s": ctx.school_id},
            )
        )
        .mappings()
        .one()
    )


def _settings_out(r) -> dict:
    return {
        "principal_name": r["principal_name"],
        "signatory_title": r["signatory_title"],
        "place": r["place"],
        "accent_color": r["accent_color"],
        "card_valid_until": r["card_valid_until"],
        "card_back_note": r["card_back_note"],
        "has_signature": bool(r["signature_path"]),
        "school_name": r["school_name"],
        "has_logo": r["has_logo"],
        # what new ID cards default to: the setting, else the end of the current session
        "default_card_valid_until": r["card_valid_until"] or r["session_end"],
    }


@settings_router.get("")
async def get_document_settings(ctx: SchoolContext = DOCS, db: AsyncSession = Depends(get_db)) -> dict:
    return _settings_out(await settings_row(db, ctx))


@settings_router.put("")
async def put_document_settings(
    payload: SettingsIn, request: Request, ctx: SchoolContext = DOCS, db: AsyncSession = Depends(get_db)
) -> dict:
    await ensure_settings(db, ctx)
    if payload.card_valid_until and payload.card_valid_until < today_ist():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The ID card validity date has already passed.")
    data = payload.model_dump()
    try:
        await db.execute(
            text(
                "update public.document_settings set principal_name = :principal_name, "
                "signatory_title = :signatory_title, "
                "place = :place, accent_color = :accent_color, card_valid_until = :card_valid_until, "
                "card_back_note = :card_back_note where school_id = :s"
            ),
            {"s": ctx.school_id, **data},
        )
        await write_audit(
            db,
            request,
            action="document_settings.updated",
            entity_type="document_settings",
            entity_id=str(ctx.school_id),
            school_id=ctx.school_id,
            metadata={k: str(v) if v is not None else None for k, v in data.items()},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return _settings_out(await settings_row(db, ctx))


@settings_router.put("/signature")
async def upload_signature(
    request: Request, file: UploadFile = File(...), ctx: SchoolContext = DOCS, db: AsyncSession = Depends(get_db)
) -> dict:
    await ensure_settings(db, ctx)
    data = await file.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The signature image must be 2 MB or smaller.")
    try:
        png = await run_in_threadpool(process_signature, data)
    except LogoError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    path = f"{ctx.school_id}/signatures/{uuid.uuid4().hex}.png"
    try:
        await storage.upload(storage.DOCUMENT_ASSET_BUCKET, path, png, "image/png")
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    # the previous image is kept: certificates already issued still print with the signature they were issued with
    await db.execute(
        text("update public.document_settings set signature_path = :p where school_id = :s"),
        {"p": path, "s": ctx.school_id},
    )
    await write_audit(
        db,
        request,
        action="document_settings.signature_uploaded",
        entity_type="document_settings",
        entity_id=str(ctx.school_id),
        school_id=ctx.school_id,
        metadata={},
    )
    await db.commit()
    return _settings_out(await settings_row(db, ctx))


@settings_router.delete("/signature")
async def remove_signature(request: Request, ctx: SchoolContext = DOCS, db: AsyncSession = Depends(get_db)) -> dict:
    await ensure_settings(db, ctx)
    await db.execute(
        text("update public.document_settings set signature_path = null where school_id = :s"), {"s": ctx.school_id}
    )
    await write_audit(
        db,
        request,
        action="document_settings.signature_removed",
        entity_type="document_settings",
        entity_id=str(ctx.school_id),
        school_id=ctx.school_id,
        metadata={},
    )
    await db.commit()
    return _settings_out(await settings_row(db, ctx))


@settings_router.get("/signature.png")
async def get_signature(ctx: SchoolContext = DOCS, db: AsyncSession = Depends(get_db)) -> Response:
    r = await settings_row(db, ctx)
    data = await storage.download(storage.DOCUMENT_ASSET_BUCKET, r["signature_path"])
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No signature uploaded.")
    return Response(data, media_type="image/png", headers={"Cache-Control": "private, no-store"})


# ================================================================== templates
class FieldIn(BaseModel):
    model_config = {"extra": "forbid"}

    key: str = Field(pattern=r"^[a-z][a-z0-9_]{1,29}$")
    label: str = Field(min_length=2, max_length=60)
    type: Literal["text", "date"] = "text"
    required: bool = False

    _c = field_validator("label", mode="before")(classmethod(lambda cls, v: _clean(v)))


class TemplateIn(BaseModel):
    model_config = {"extra": "forbid"}

    kind: Kind = "custom"
    name: str = Field(min_length=2, max_length=60)
    title: str = Field(min_length=2, max_length=80)
    prefix: str = Field(min_length=1, max_length=6)
    body: str = Field(min_length=10, max_length=5000)
    fields: list[FieldIn] = Field(default_factory=list, max_length=12)
    show_logo: bool = True
    show_photo: bool = False
    show_qr: bool = True
    is_active: bool = True

    _c = field_validator("name", "title", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @field_validator("prefix", mode="before")
    @classmethod
    def _prefix(cls, v: object) -> object:
        if isinstance(v, str):
            v = v.strip().upper()
            if not v.isascii() or not v.isalpha():
                raise ValueError("The number prefix is 1 to 6 letters (e.g. BC, TC).")
        return v

    @field_validator("body", mode="before")
    @classmethod
    def _body(cls, v: object) -> object:
        return v.replace("\r\n", "\n").strip() if isinstance(v, str) else v

    @field_validator("fields")
    @classmethod
    def _unique_keys(cls, v: list[FieldIn]) -> list[FieldIn]:
        keys = [f.key for f in v]
        if len(keys) != len(set(keys)):
            raise ValueError("Two extra fields have the same key.")
        return v


class TemplateUpdate(TemplateIn):
    kind: None = None  # a template's kind is fixed once created


def _template_out(r) -> dict:
    return {
        "id": r["id"],
        "kind": r["kind"],
        "kind_label": KIND_LABEL[r["kind"]],
        "name": r["name"],
        "title": r["title"],
        "prefix": r["prefix"],
        "body": r["body"],
        "fields": r["fields"],
        "show_logo": r["show_logo"],
        "show_photo": r["show_photo"],
        "show_qr": r["show_qr"],
        "is_active": r["is_active"],
        "issued_count": r["issued_count"],
    }


TEMPLATE_SELECT = (
    "select t.*, (select count(*) from public.certificates c where c.template_id = t.id) as issued_count "
    "from public.certificate_templates t"
)


async def _template(db: AsyncSession, ctx: SchoolContext, template_id: uuid.UUID):
    r = (
        (
            await db.execute(
                text(f"{TEMPLATE_SELECT} where t.id = :id and t.school_id = :s"),
                {"id": template_id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Certificate template not found.")
    return r


@router.get("/placeholders")
async def placeholders(ctx: SchoolContext = MANAGE) -> list[dict]:
    return [{"key": k, "label": label} for k, label in PLACEHOLDERS]


@router.get("/templates")
async def list_templates(ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> list[dict]:
    await ensure_settings(db, ctx)
    rows = (
        (
            await db.execute(
                text(
                    f"{TEMPLATE_SELECT} where t.school_id = :s order by not t.is_active, "
                    "array_position(array['bonafide','character','transfer','study','custom'], t.kind), lower(t.name)"
                ),
                {"s": ctx.school_id},
            )
        )
        .mappings()
        .all()
    )
    return [_template_out(r) for r in rows]


@router.post("/templates", status_code=status.HTTP_201_CREATED)
async def create_template(
    payload: TemplateIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    await ensure_settings(db, ctx)
    data = payload.model_dump()
    data["fields"] = json.dumps(data["fields"])
    try:
        tid = (
            await db.execute(
                text(
                    "insert into public.certificate_templates (school_id, kind, name, title, prefix, body, fields, "
                    "show_logo, show_photo, show_qr, is_active) values (:s, :kind, :name, :title, :prefix, :body, "
                    "cast(:fields as jsonb), :show_logo, :show_photo, :show_qr, :is_active) returning id"
                ),
                {"s": ctx.school_id, **data},
            )
        ).scalar_one()
        await write_audit(
            db,
            request,
            action="certificate_template.created",
            entity_type="certificate_template",
            entity_id=str(tid),
            school_id=ctx.school_id,
            metadata={"name": payload.name, "kind": payload.kind},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return _template_out(await _template(db, ctx, tid))


@router.put("/templates/{template_id}")
async def update_template(
    template_id: uuid.UUID,
    payload: TemplateUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _template(db, ctx, template_id)
    data = payload.model_dump(exclude={"kind"})
    data["fields"] = json.dumps(data["fields"])
    try:
        await db.execute(
            text(
                "update public.certificate_templates set name = :name, title = :title, prefix = :prefix, body = :body, "
                "fields = cast(:fields as jsonb), show_logo = :show_logo, show_photo = :show_photo, "
                "show_qr = :show_qr, "
                "is_active = :is_active where id = :id and school_id = :s"
            ),
            {"id": template_id, "s": ctx.school_id, **data},
        )
        await write_audit(
            db,
            request,
            action="certificate_template.updated",
            entity_type="certificate_template",
            entity_id=str(template_id),
            school_id=ctx.school_id,
            metadata={"name": payload.name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return _template_out(await _template(db, ctx, template_id))


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> Response:
    t = await _template(db, ctx, template_id)
    try:
        await db.execute(text("delete from public.certificate_templates where id = :id"), {"id": template_id})
        await write_audit(
            db,
            request,
            action="certificate_template.deleted",
            entity_type="certificate_template",
            entity_id=str(template_id),
            school_id=ctx.school_id,
            metadata={"name": t["name"]},
        )
        await db.commit()
    except DBAPIError as exc:
        err = pg_error(exc)
        if err.sqlstate == "23503" and err.constraint is None:  # our guard: certificates were issued from it
            await db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, err.message) from None
        raise await http_error_from_db(db, exc) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ================================================================== issue
class IssueIn(BaseModel):
    model_config = {"extra": "forbid"}

    template_id: uuid.UUID
    student_id: uuid.UUID
    session_id: uuid.UUID | None = None  # default: the current session
    issued_on: date | None = None  # default: today
    purpose: str | None = Field(default=None, max_length=200)
    fields: dict[str, str | None] = Field(default_factory=dict)
    mark_left: bool = False  # transfer certificates: mark the student as having left

    _c = field_validator("purpose", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @field_validator("purpose")
    @classmethod
    def _purpose(cls, v: str | None) -> str | None:
        if v is not None and len(v) < 2:
            raise ValueError("Write the purpose in a few words.")
        return v

    @field_validator("fields")
    @classmethod
    def _fields(cls, v: dict[str, str | None]) -> dict[str, str | None]:
        if len(v) > 12:
            raise ValueError("Too many extra fields.")
        out = {}
        for k, val in v.items():
            if len(k) > 30:
                raise ValueError("Unknown extra field.")
            val = " ".join(val.split()) if isinstance(val, str) else None
            if val and len(val) > 300:
                raise ValueError("An extra field is at most 300 characters.")
            out[k] = val or None
        return out


def _issue_params(ctx: SchoolContext, p: IssueIn) -> dict:
    return {
        "t": p.template_id,
        "st": p.student_id,
        "sess": p.session_id,
        "on": p.issued_on or today_ist(),
        "purpose": p.purpose,
        "extra": json.dumps({k: v for k, v in p.fields.items() if v is not None}),
    }


@router.post("/preview")
async def preview(payload: IssueIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    """The wording exactly as it will be issued (with a placeholder number)."""
    try:
        r = (
            await db.execute(
                text(
                    "select private.certificate_preview(:t, :st, cast(:sess as uuid), :on, :purpose, "
                    "cast(:extra as jsonb))"
                ),
                _issue_params(ctx, payload),
            )
        ).scalar_one()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    await db.rollback()
    return {"title": r["title"], "body": r["body"], "student_status": r["student_status"]}


class CertificateOut(BaseModel):
    id: uuid.UUID
    certificate_number: str
    kind: str
    kind_label: str
    title: str
    body: str
    template_name: str
    student_id: uuid.UUID
    student_name: str
    student_code: str
    class_section: str | None
    session_name: str | None
    purpose: str | None
    issued_on: date
    signatory_name: str | None
    signatory_title: str
    status: str
    revoked_at: datetime | None
    revoke_reason: str | None
    issued_by_name: str | None
    created_at: datetime
    verify_url: str


CERT_SELECT = (
    "select c.*, t.name as template_name, s.full_name as student_name, s.student_code, "
    "c.field_values ->> 'class_section' as class_section, a.name as session_name, "
    "(select p.full_name from public.profiles p where p.id = c.issued_by) as issued_by_name "
    "from public.certificates c join public.certificate_templates t on t.id = c.template_id "
    "join public.students s on s.id = c.student_id left join public.academic_sessions a on a.id = c.academic_session_id"
)


def _cert_out(r) -> CertificateOut:
    return CertificateOut(
        **{k: r[k] for k in CertificateOut.model_fields if k in r.keys() and k not in ("verify_url", "kind_label")},
        kind_label=KIND_LABEL[r["kind"]],
        verify_url=frontend_verify_url(r["verify_token"]),
    )


async def _cert(db: AsyncSession, ctx: SchoolContext, cert_id: uuid.UUID):
    r = (
        (
            await db.execute(
                text(f"{CERT_SELECT} where c.id = :id and c.school_id = :s"), {"id": cert_id, "s": ctx.school_id}
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Certificate not found.")
    return r


@router.post("", response_model=CertificateOut, status_code=status.HTTP_201_CREATED)
async def issue(
    payload: IssueIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> CertificateOut:
    await ensure_settings(db, ctx)
    try:
        cid = (
            await db.execute(
                text(
                    "select private.certificate_issue(:t, :st, cast(:sess as uuid), :on, :purpose, "
                    "cast(:extra as jsonb), :left)"
                ),
                {**_issue_params(ctx, payload), "left": payload.mark_left},
            )
        ).scalar_one()
        r = await _cert(db, ctx, cid)
        await write_audit(
            db,
            request,
            action="certificate.issued",
            entity_type="certificate",
            entity_id=str(cid),
            school_id=ctx.school_id,
            metadata={
                "number": r["certificate_number"],
                "kind": r["kind"],
                "student": r["student_name"],
                "marked_left": bool(payload.mark_left and r["kind"] == "transfer"),
            },
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return _cert_out(r)


CERT_CSV = [
    ("certificate_number", "Number", "text"),
    ("kind_label", "Type", "text"),
    ("title", "Title", "text"),
    ("student_name", "Student", "text"),
    ("student_code", "Student ID", "text"),
    ("class_section", "Class", "text"),
    ("session_name", "Session", "text"),
    ("purpose", "Purpose", "text"),
    ("issued_on", "Issued on", "date"),
    ("status", "Status", "text"),
    ("revoke_reason", "Revoked because", "text"),
    ("issued_by_name", "Issued by", "text"),
]


@router.get("")
async def list_certificates(
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
    kind: Kind | None = None,
    status_filter: Literal["issued", "revoked"] | None = Query(default=None, alias="status"),
    student_id: uuid.UUID | None = None,
    q: str | None = Query(default=None, max_length=100),
    date_from: date | None = Query(default=None, alias="from"),
    date_to: date | None = Query(default=None, alias="to"),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
    format: Literal["json", "csv"] = "json",
) -> Any:
    where, p = ["c.school_id = :s"], {"s": ctx.school_id}
    if kind:
        where.append("c.kind = :kind")
        p["kind"] = kind
    if status_filter:
        where.append("c.status = :st")
        p["st"] = status_filter
    if student_id:
        where.append("c.student_id = :sid")
        p["sid"] = student_id
    if date_from:
        where.append("c.issued_on >= :df")
        p["df"] = date_from
    if date_to:
        where.append("c.issued_on <= :dt")
        p["dt"] = date_to
    if q and q.strip():
        term = "%" + " ".join(q.split()).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append(
            "(s.full_name ilike :q escape '\\' or c.certificate_number ilike :q escape '\\' "
            "or s.student_code ilike :q escape '\\')"
        )
        p["q"] = term
    w = " and ".join(where)
    order = "c.issued_on desc, c.created_at desc"
    if format == "csv":
        rows = [dict(r) for r in (await db.execute(text(f"{CERT_SELECT} where {w} order by {order}"), p)).mappings()]
        for r in rows:
            r["kind_label"] = KIND_LABEL[r["kind"]]
            r["status"] = "Valid" if r["status"] == "issued" else "Revoked"
        return Response(
            to_csv(CERT_CSV, rows),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="certificates.csv"'},
        )
    total = (
        await db.execute(
            text(f"select count(*) from public.certificates c join public.students s on s.id = c.student_id where {w}"),
            p,
        )
    ).scalar_one()
    rows = (
        (
            await db.execute(
                text(f"{CERT_SELECT} where {w} order by {order} limit :lim offset :off"),
                {**p, "lim": page_size, "off": (page - 1) * page_size},
            )
        )
        .mappings()
        .all()
    )
    return {"items": [_cert_out(r) for r in rows], "total": total, "page": page, "page_size": page_size}


@router.get("/{cert_id}", response_model=CertificateOut)
async def get_certificate(
    cert_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> CertificateOut:
    return _cert_out(await _cert(db, ctx, cert_id))


class RevokeIn(BaseModel):
    model_config = {"extra": "forbid"}

    reason: str = Field(min_length=3, max_length=300)

    _c = field_validator("reason", mode="before")(classmethod(lambda cls, v: _clean(v) or ""))


@router.post("/{cert_id}/revoke", response_model=CertificateOut)
async def revoke(
    cert_id: uuid.UUID,
    payload: RevokeIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> CertificateOut:
    r = await _cert(db, ctx, cert_id)
    try:
        await db.execute(
            text("select private.certificate_revoke(:id, :reason)"), {"id": cert_id, "reason": payload.reason}
        )
        await write_audit(
            db,
            request,
            action="certificate.revoked",
            entity_type="certificate",
            entity_id=str(cert_id),
            school_id=ctx.school_id,
            metadata={"number": r["certificate_number"], "reason": payload.reason},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return _cert_out(await _cert(db, ctx, cert_id))


async def school_for_documents(db: AsyncSession, ctx: SchoolContext):
    from app.api.v1.routes.report_cards import school_info

    return await school_info(db, ctx)


@router.get("/{cert_id}/certificate.pdf")
async def certificate_pdf(
    cert_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> Response:
    r = await _cert(db, ctx, cert_id)
    ds = await settings_row(db, ctx)
    photo = None
    if r["show_photo"]:
        path = (
            await db.execute(text("select photo_path from public.students where id = :id"), {"id": r["student_id"]})
        ).scalar_one_or_none()
        photo = await storage.download(storage.PHOTO_BUCKET, path)
    doc = CertificateDoc(
        school=await school_for_documents(db, ctx),
        number=r["certificate_number"],
        title=r["title"],
        body=r["body"],
        issued_on=r["issued_on"],
        place=r["place"],
        signatory_name=r["signatory_name"],
        signatory_title=r["signatory_title"],
        verify_url=frontend_verify_url(r["verify_token"]),
        accent=ds["accent_color"],
        signature_png=await storage.download(storage.DOCUMENT_ASSET_BUCKET, r["signature_path"]),
        photo=photo,
        show_logo=r["show_logo"],
        show_photo=r["show_photo"],
        show_qr=r["show_qr"],
        revoked=r["status"] == "revoked",
    )
    pdf = await run_in_threadpool(build_certificate_pdf, doc)
    name = r["certificate_number"].replace("/", "-")
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{name}.pdf"', "Cache-Control": "private, no-store"},
    )
