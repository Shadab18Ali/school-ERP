"""Report card templates (school admins) and the data that goes onto a report card.

`build_cards` gathers everything for one section's report cards with the caller's
identity, so RLS decides what each person may print: staff any student of a
section they can see, parents/students only their own once results are published.
"""

import uuid
from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services import storage
from app.services.audit import write_audit
from app.services.images import LogoError, process_signature
from app.services.report_card_pdf import (
    Attendance,
    Card,
    CardSet,
    CardStudent,
    SchoolInfo,
    TemplateSettings,
    build_report_card_pdf,
    sample_cards,
)

router = APIRouter(prefix="/report-cards", tags=["report-cards"])
MANAGE = Depends(require_permission(Permission.REPORT_CARDS_MANAGE))
UNIQUE = {
    "report_card_templates_name_key": "A template with this name already exists.",
    "report_card_templates_one_default": "Only one template can be the default.",
}
FLAGS = (
    "show_logo",
    "show_photo",
    "show_rank",
    "show_attendance",
    "show_subject_grades",
    "show_pass_marks",
    "show_grade_scale",
    "show_teacher_remarks",
    "show_principal_remarks",
)
TEXTS = ("signature_1", "signature_2", "signature_3", "principal_name", "footer_note")
COLUMNS = ("name", "layout", "accent_color", "title", *FLAGS, *TEXTS)


class _Strict(BaseModel):
    model_config = {"extra": "forbid"}


def _tidy(v: object) -> object:
    return " ".join(v.split()) if isinstance(v, str) else v


class TemplateUpdate(_Strict):
    name: str | None = Field(default=None, min_length=2, max_length=60)
    layout: Literal["classic", "modern"] | None = None
    accent_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    title: str | None = Field(default=None, min_length=2, max_length=60)
    show_logo: bool | None = None
    show_photo: bool | None = None
    show_rank: bool | None = None
    show_attendance: bool | None = None
    show_subject_grades: bool | None = None
    show_pass_marks: bool | None = None
    show_grade_scale: bool | None = None
    show_teacher_remarks: bool | None = None
    show_principal_remarks: bool | None = None
    signature_1: str | None = Field(default=None, max_length=40)
    signature_2: str | None = Field(default=None, max_length=40)
    signature_3: str | None = Field(default=None, max_length=40)
    principal_name: str | None = Field(default=None, max_length=100)
    footer_note: str | None = Field(default=None, max_length=300)

    _c = field_validator("name", "title", *TEXTS, mode="before")(classmethod(lambda cls, v: _tidy(v)))


class TemplateCreate(_Strict):
    name: str = Field(min_length=2, max_length=60)
    copy_from: uuid.UUID | None = None
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _tidy(v)))


_SELECT = (
    "select t.*, (select count(*) from public.exams x where x.report_card_template_id = t.id) as exams_using "
    "from public.report_card_templates t "
)


def _out(r) -> dict:
    d = {k: r[k] for k in COLUMNS}
    d["layout"] = str(r["layout"])
    return {
        "id": str(r["id"]),
        "is_default": r["is_default"],
        "has_signature": bool(r["principal_signature_path"]),
        "exams_using": r["exams_using"],
        **d,
    }


async def _ensure_default(db: AsyncSession, ctx: SchoolContext) -> None:
    """Admins get a "Standard" template the first time they open report cards."""
    exists = (
        await db.execute(
            text("select 1 from public.report_card_templates where school_id = :s limit 1"), {"s": ctx.school_id}
        )
    ).first()
    if exists is None:
        await db.execute(
            text(
                "insert into public.report_card_templates (school_id, name, is_default) values (:s, 'Standard', true)"
            ),
            {"s": ctx.school_id},
        )
        await db.commit()


async def _template(db: AsyncSession, ctx: SchoolContext, template_id: uuid.UUID):
    r = (
        (
            await db.execute(
                text(_SELECT + "where t.id = :id and t.school_id = :s"), {"id": template_id, "s": ctx.school_id}
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Template not found.")
    return r


@router.get("/templates")
async def list_templates(ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> list[dict]:
    await _ensure_default(db, ctx)
    rows = (
        (
            await db.execute(
                text(_SELECT + "where t.school_id = :s order by t.is_default desc, lower(t.name)"), {"s": ctx.school_id}
            )
        )
        .mappings()
        .all()
    )
    return [_out(r) for r in rows]


@router.post("/templates", status_code=status.HTTP_201_CREATED)
async def create_template(
    payload: TemplateCreate, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    cols = [c for c in COLUMNS if c != "name"]
    try:
        if payload.copy_from:
            src = await _template(db, ctx, payload.copy_from)
            tid = (
                await db.execute(
                    text(
                        f"insert into public.report_card_templates (school_id, name, {', '.join(cols)}) "
                        f"select :s, :n, {', '.join(cols)} from public.report_card_templates where id "
                        f"= :src returning id"
                    ),
                    {"s": ctx.school_id, "n": payload.name, "src": src["id"]},
                )
            ).scalar_one()
        else:
            tid = (
                await db.execute(
                    text("insert into public.report_card_templates (school_id, name) values (:s, :n) returning id"),
                    {"s": ctx.school_id, "n": payload.name},
                )
            ).scalar_one()
        await write_audit(
            db,
            request,
            action="report_card_template.created",
            entity_type="report_card_template",
            entity_id=str(tid),
            school_id=ctx.school_id,
            metadata={"name": payload.name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return _out(await _template(db, ctx, tid))


@router.get("/templates/{template_id}")
async def get_template(template_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    return _out(await _template(db, ctx, template_id))


@router.patch("/templates/{template_id}")
async def update_template(
    template_id: uuid.UUID,
    payload: TemplateUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _template(db, ctx, template_id)
    fields = payload.model_dump(exclude_unset=True)
    for k in ("name", "layout", "accent_color", "title", *FLAGS):
        if k in fields and fields[k] is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"{k.replace('_', ' ').capitalize()} can't be empty."
            )
    for k in TEXTS:  # empty text = hidden (signature) or none
        if k in fields and not fields[k]:
            fields[k] = None
    if fields:
        sets = ", ".join(
            f"{k} = cast(:{k} as public.report_card_layout)" if k == "layout" else f"{k} = :{k}" for k in fields
        )
        try:
            await db.execute(
                text(f"update public.report_card_templates set {sets} where id = :id and school_id = :s"),
                {**fields, "id": template_id, "s": ctx.school_id},
            )
            await write_audit(
                db,
                request,
                action="report_card_template.updated",
                entity_type="report_card_template",
                entity_id=str(template_id),
                school_id=ctx.school_id,
                metadata={"fields": sorted(fields)},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return _out(await _template(db, ctx, template_id))


@router.post("/templates/{template_id}/default")
async def make_default(
    template_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    await _template(db, ctx, template_id)
    try:
        await db.execute(
            text(
                "update public.report_card_templates set is_default = false where school_id = :s and "
                "is_default and id <> :id"
            ),
            {"s": ctx.school_id, "id": template_id},
        )
        await db.execute(
            text("update public.report_card_templates set is_default = true where id = :id"), {"id": template_id}
        )
        await write_audit(
            db,
            request,
            action="report_card_template.default",
            entity_type="report_card_template",
            entity_id=str(template_id),
            school_id=ctx.school_id,
            metadata={},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await list_templates(ctx=ctx, db=db)


@router.delete("/templates/{template_id}")
async def delete_template(
    template_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    t = await _template(db, ctx, template_id)
    try:
        await db.execute(text("delete from public.report_card_templates where id = :id"), {"id": template_id})
        await write_audit(
            db,
            request,
            action="report_card_template.deleted",
            entity_type="report_card_template",
            entity_id=str(template_id),
            school_id=ctx.school_id,
            metadata={"name": t["name"]},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    if t["principal_signature_path"]:
        await storage.delete(storage.REPORT_CARD_BUCKET, t["principal_signature_path"])
    return await list_templates(ctx=ctx, db=db)


@router.put("/templates/{template_id}/signature")
async def upload_signature(
    template_id: uuid.UUID,
    request: Request,
    file: UploadFile = File(...),
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    t = await _template(db, ctx, template_id)
    data = await file.read(2 * 1024 * 1024 + 1)
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The signature image must be 2 MB or smaller.")
    try:
        png = await run_in_threadpool(process_signature, data)
    except LogoError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    path = f"{ctx.school_id}/signatures/{template_id}-{uuid.uuid4().hex[:8]}.png"
    try:
        await storage.upload(storage.REPORT_CARD_BUCKET, path, png, "image/png")
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    await db.execute(
        text("update public.report_card_templates set principal_signature_path = :p where id = :id"),
        {"p": path, "id": template_id},
    )
    await write_audit(
        db,
        request,
        action="report_card_template.signature_uploaded",
        entity_type="report_card_template",
        entity_id=str(template_id),
        school_id=ctx.school_id,
        metadata={},
    )
    await db.commit()
    if t["principal_signature_path"]:
        await storage.delete(storage.REPORT_CARD_BUCKET, t["principal_signature_path"])
    return _out(await _template(db, ctx, template_id))


@router.delete("/templates/{template_id}/signature")
async def remove_signature(
    template_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    t = await _template(db, ctx, template_id)
    await db.execute(
        text("update public.report_card_templates set principal_signature_path = null where id = :id"),
        {"id": template_id},
    )
    await write_audit(
        db,
        request,
        action="report_card_template.signature_removed",
        entity_type="report_card_template",
        entity_id=str(template_id),
        school_id=ctx.school_id,
        metadata={},
    )
    await db.commit()
    if t["principal_signature_path"]:
        await storage.delete(storage.REPORT_CARD_BUCKET, t["principal_signature_path"])
    return _out(await _template(db, ctx, template_id))


@router.get("/templates/{template_id}/signature.png")
async def get_signature(
    template_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> Response:
    t = await _template(db, ctx, template_id)
    data = await storage.download(storage.REPORT_CARD_BUCKET, t["principal_signature_path"])
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No signature uploaded.")
    return Response(data, media_type="image/png", headers={"Cache-Control": "private, no-store"})


@router.get("/templates/{template_id}/preview.pdf")
async def preview(template_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> Response:
    """The template with clearly fictional sample data, watermarked SAMPLE."""
    t = await _template(db, ctx, template_id)
    settings = await _settings(t)
    cs, cards = sample_cards(settings, await school_info(db, ctx), await grade_scale(db, ctx))
    pdf = build_report_card_pdf(cs, cards, sample=True)
    return Response(
        pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": 'inline; filename="preview.pdf"', "Cache-Control": "no-store"},
    )


# ------------------------------------------------------------------ report card data
async def _settings(r) -> TemplateSettings:
    return TemplateSettings(
        layout=str(r["layout"]),
        accent_color=r["accent_color"],
        title=r["title"],
        **{k: r[k] for k in FLAGS},
        **{k: r[k] for k in ("signature_1", "signature_2", "signature_3", "principal_name", "footer_note")},
        principal_signature_png=await storage.download(storage.REPORT_CARD_BUCKET, r["principal_signature_path"]),
    )


async def template_for_exam(db: AsyncSession, ctx: SchoolContext, template_id: uuid.UUID | None) -> TemplateSettings:
    """The exam's template, else the school's default, else the built-in standard design."""
    r = None
    if template_id is not None:
        r = (
            (
                await db.execute(
                    text("select * from public.report_card_templates where id = :id and school_id = :s"),
                    {"id": template_id, "s": ctx.school_id},
                )
            )
            .mappings()
            .first()
        )
    if r is None:
        r = (
            (
                await db.execute(
                    text("select * from public.report_card_templates where school_id = :s and is_default"),
                    {"s": ctx.school_id},
                )
            )
            .mappings()
            .first()
        )
    return await _settings(r) if r else TemplateSettings()


async def school_info(db: AsyncSession, ctx: SchoolContext) -> SchoolInfo:
    from app.api.v1.routes.collection import _logo

    s = (
        await db.execute(
            text(
                "select name, address, city, state, postal_code, phone, email, affiliation_board, "
                "affiliation_number, logo_url "
                "from public.schools where id = :s"
            ),
            {"s": ctx.school_id},
        )
    ).first()
    address = ", ".join(x for x in (s[1], s[2], s[3], s[4]) if x) or None
    contact = " · ".join(x for x in (f"Phone {s[5]}" if s[5] else None, s[6]) if x) or None
    affiliation = f"{s[7]} affiliation no. {s[8]}" if s[7] and s[8] else (s[7] or None)
    return SchoolInfo(name=s[0], address=address, contact=contact, affiliation=affiliation, logo_png=await _logo(s[9]))


async def grade_scale(db: AsyncSession, ctx: SchoolContext) -> list:
    rows = (
        await db.execute(
            text(
                "select grade, min_percentage, remark from public.grade_bands where school_id = :s "
                "order by min_percentage desc"
            ),
            {"s": ctx.school_id},
        )
    ).all()
    return [(r[0], r[1], r[2]) for r in rows]


async def build_cards(
    db: AsyncSession, ctx: SchoolContext, exam, section_id: uuid.UUID, only: set[str] | None = None
) -> bytes | None:
    """Report cards for a section (or some of its students). None when there is nothing to print."""
    from app.api.v1.routes.exams import section_results

    results, ids, size = await section_results(db, exam.id, section_id)
    pairs = [(r, i["student_id"]) for r, i in zip(results, ids, strict=True) if only is None or i["student_id"] in only]
    if not pairs:
        return None
    template = await template_for_exam(db, ctx, exam.report_card_template_id)
    student_ids = [uuid.UUID(sid) for _, sid in pairs]
    uuid_list = bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
    rows = (
        (
            await db.execute(
                text(
                    "select s.id, s.full_name, s.student_code, s.date_of_birth, s.father_name, "
                    "s.mother_name, s.photo_path, "
                    "e.id as enrollment_id, e.admission_number, c.name || ' – ' || sec.name as class_section "
                    "from public.students s join public.student_enrollments e on e.student_id = s.id "
                    "and e.section_id = :sec "
                    "join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id "
                    "where s.id = any(:ids)"
                ).bindparams(uuid_list),
                {"sec": section_id, "ids": student_ids},
            )
        )
        .mappings()
        .all()
    )
    info = {str(r["id"]): r for r in rows}

    # attendance from the start of the session up to the last paper (or today, if earlier)
    tz = (
        await db.execute(text("select timezone from public.schools where id = :s"), {"s": ctx.school_id})
    ).scalar() or "Asia/Kolkata"
    today = datetime.now(ZoneInfo(tz)).date()
    last_paper = (
        await db.execute(text("select max(exam_date) from public.exam_papers where exam_id = :x"), {"x": exam.id})
    ).scalar()
    period_to = min(d for d in (last_paper, today, exam.end_date) if d is not None)
    period_from: date = exam.start_date
    attendance: dict[str, Attendance] = {}
    if template.show_attendance:
        enr = [r["enrollment_id"] for r in rows]
        for a in (
            await db.execute(
                text(
                    "select enrollment_id, count(*) filter (where status = 'present'), count(*) from "
                    "public.attendance_records "
                    "where enrollment_id = any(:ids) and attendance_date between :f and :t group by enrollment_id"
                ).bindparams(uuid_list),
                {"ids": enr, "f": period_from, "t": period_to},
            )
        ).all():
            attendance[str(a[0])] = Attendance(a[1], a[2], period_from, period_to)
    remarks = {
        str(r[0]): (r[1], r[2])
        for r in (
            await db.execute(
                text(
                    "select student_id, teacher_remarks, principal_remarks from public.report_card_remarks "
                    "where exam_id = :x and student_id = any(:ids)"
                ).bindparams(uuid_list),
                {"x": exam.id, "ids": student_ids},
            )
        ).all()
    }
    class_teacher = (await db.execute(text("select private.class_teacher_name(:s)"), {"s": section_id})).scalar()

    cards = []
    for result, sid in pairs:
        r = info.get(sid)
        if r is None:
            continue
        photo = await storage.download(storage.PHOTO_BUCKET, r["photo_path"]) if template.show_photo else None
        t_rem, p_rem = remarks.get(sid, (None, None))
        cards.append(
            Card(
                student=CardStudent(
                    full_name=r["full_name"],
                    admission_number=r["admission_number"],
                    student_code=r["student_code"],
                    class_section=r["class_section"],
                    date_of_birth=r["date_of_birth"],
                    father_name=r["father_name"],
                    mother_name=r["mother_name"],
                    photo=photo,
                ),
                result=result,
                out_of=size,
                attendance=attendance.get(str(r["enrollment_id"]), Attendance(0, 0, period_from, period_to)),
                teacher_remarks=t_rem,
                principal_remarks=p_rem,
                class_teacher=class_teacher,
            )
        )
    if not cards:
        return None
    card_set = CardSet(
        school=await school_info(db, ctx),
        template=template,
        exam_name=exam.name,
        session_name=exam.session_name,
        grades=await grade_scale(db, ctx),
        issued_on=today,
    )
    return await run_in_threadpool(build_report_card_pdf, card_set, cards)
