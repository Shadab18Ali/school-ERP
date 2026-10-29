"""Homework & assignments.

Staff (/homework): school admins see and manage all homework; teachers see the
homework of sections assigned to them and can change and review only homework
they set. Students (/my/homework) and parents (/portal/children/{id}/homework)
use the shared handlers at the bottom of this module.

Every query runs with the caller's identity, so RLS (migration 0014) applies on
top of the checks here: deadlines, who may submit, who may mark, and what each
person can see are enforced by the database as well.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services import storage
from app.services.audit import write_audit
from app.services.documents import (
    MAX_DOCUMENT_BYTES,
    DocumentError,
    clean_homework_file,
    content_disposition,
    safe_filename,
)

router = APIRouter(prefix="/homework", tags=["homework"])
VIEW = Depends(require_permission(Permission.HOMEWORK_VIEW))
MANAGE = Depends(require_permission(Permission.HOMEWORK_MANAGE))
NOT_FOUND = HTTPException(status.HTTP_404_NOT_FOUND, "Homework not found.")
MAX_FILES_PER_UPLOAD = 5
Kind = Literal["homework", "assignment"]


# ------------------------------------------------------------------ schemas
class _Strict(BaseModel):
    model_config = {"extra": "forbid"}


def _clean_text(v: object) -> object:
    return v.strip() if isinstance(v, str) else v


class HomeworkIn(_Strict):
    section_id: uuid.UUID
    kind: Kind = "homework"
    subject_id: uuid.UUID | None = None
    title: str = Field(min_length=2, max_length=150)
    description: str = Field(default="", max_length=5000)
    due_at: datetime
    max_marks: Decimal | None = Field(default=None, gt=0, le=1000, decimal_places=2)
    allow_late: bool = False

    _c = field_validator("title", "description", mode="before")(classmethod(lambda cls, v: _clean_text(v)))

    @field_validator("due_at")
    @classmethod
    def _aware(cls, v: datetime) -> datetime:
        if v.tzinfo is None:
            raise ValueError("Give the deadline with a time zone.")
        return v


class HomeworkUpdate(_Strict):
    kind: Kind | None = None
    subject_id: uuid.UUID | None = None
    title: str | None = Field(default=None, min_length=2, max_length=150)
    description: str | None = Field(default=None, max_length=5000)
    due_at: datetime | None = None
    max_marks: Decimal | None = Field(default=None, gt=0, le=1000, decimal_places=2)
    allow_late: bool | None = None

    _c = field_validator("title", "description", mode="before")(classmethod(lambda cls, v: _clean_text(v)))

    @field_validator("due_at")
    @classmethod
    def _aware(cls, v: datetime | None) -> datetime | None:
        if v is not None and v.tzinfo is None:
            raise ValueError("Give the deadline with a time zone.")
        return v


class ReviewIn(_Strict):
    marks: Decimal | None = Field(default=None, ge=0, le=1000, decimal_places=2)
    feedback: str | None = Field(default=None, max_length=2000)

    _c = field_validator("feedback", mode="before")(classmethod(lambda cls, v: _clean_text(v)))


class FileOut(BaseModel):
    id: uuid.UUID
    file_name: str
    mime_type: str
    size_bytes: int


class HomeworkSummary(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    subject_id: uuid.UUID | None
    subject_name: str | None
    section_id: uuid.UUID
    class_name: str
    section_name: str
    due_at: datetime
    max_marks: str | None
    allow_late: bool
    teacher_name: str | None
    created_at: datetime
    attachment_count: int
    is_closed: bool  # past the deadline and late work not allowed


class StaffSummary(HomeworkSummary):
    students: int
    submitted: int
    reviewed: int
    can_manage: bool


class HomeworkList(BaseModel):
    items: list[StaffSummary]
    total: int
    page: int
    page_size: int


class HomeworkDetail(StaffSummary):
    description: str
    session_name: str
    session_is_archived: bool
    attachments: list[FileOut]


class SubmissionOut(BaseModel):
    id: uuid.UUID
    answer: str
    submitted_at: datetime
    is_late: bool
    marks: str | None
    feedback: str | None
    reviewed_at: datetime | None
    files: list[FileOut]


class RosterRow(BaseModel):
    student_id: uuid.UUID
    full_name: str
    admission_number: str
    submission_id: uuid.UUID | None
    submitted_at: datetime | None
    is_late: bool
    marks: str | None
    reviewed: bool
    file_count: int


class StudentHomework(HomeworkSummary):
    status: str  # pending | submitted | late | reviewed | missing
    marks: str | None
    submitted_at: datetime | None


class StudentHomeworkDetail(StudentHomework):
    description: str
    attachments: list[FileOut]
    submission: SubmissionOut | None
    can_submit: bool
    session_is_archived: bool


# ------------------------------------------------------------------ helpers
def _money(v: Decimal | None) -> str | None:
    return None if v is None else f"{v:.2f}".rstrip("0").rstrip(".")


_BASE = (
    "select h.id, h.kind::text, h.title, h.subject_id, sub.name as subject_name, h.section_id, c.name as class_name, "
    "sec.name as section_name, h.due_at, h.max_marks, h.allow_late, "
    "private.teacher_display_name(h.teacher_id) as teacher_name, "
    "h.created_at, (select count(*) from public.homework_attachments x where x.homework_id = h.id) "
    "as attachment_count, "
    "(now() > h.due_at and not h.allow_late) as is_closed "
    "from public.homework h join public.classes c on c.id = h.class_id join public.sections sec on "
    "sec.id = h.section_id "
    "left join public.subjects sub on sub.id = h.subject_id "
)
_STAFF_EXTRA = (
    ", (select count(*) from public.student_enrollments e where e.section_id = h.section_id) as students, "
    "(select count(*) from public.homework_submissions s where s.homework_id = h.id) as submitted, "
    "(select count(*) from public.homework_submissions s where s.homework_id = h.id and "
    "s.reviewed_at is not null) as reviewed, "
    "private.can_manage_homework(h.id) as can_manage "
)


def _summary_fields(r) -> dict:
    return {
        "id": r.id,
        "kind": r.kind,
        "title": r.title,
        "subject_id": r.subject_id,
        "subject_name": r.subject_name,
        "section_id": r.section_id,
        "class_name": r.class_name,
        "section_name": r.section_name,
        "due_at": r.due_at,
        "max_marks": _money(r.max_marks),
        "allow_late": r.allow_late,
        "teacher_name": r.teacher_name,
        "created_at": r.created_at,
        "attachment_count": r.attachment_count,
        "is_closed": r.is_closed,
    }


def _staff_sql(where: str) -> str:
    return _BASE.replace(" from public.homework h", _STAFF_EXTRA + " from public.homework h", 1) + where


async def _attachments(db: AsyncSession, homework_id: uuid.UUID) -> list[FileOut]:
    rows = (
        await db.execute(
            text(
                "select id, file_name, mime_type, size_bytes from public.homework_attachments "
                "where homework_id = :h order by created_at, file_name"
            ),
            {"h": homework_id},
        )
    ).all()
    return [FileOut(id=r[0], file_name=r[1], mime_type=r[2], size_bytes=r[3]) for r in rows]


async def _submission_files(db: AsyncSession, submission_id: uuid.UUID) -> list[FileOut]:
    rows = (
        await db.execute(
            text(
                "select id, file_name, mime_type, size_bytes from public.homework_submission_files "
                "where submission_id = :s order by created_at, file_name"
            ),
            {"s": submission_id},
        )
    ).all()
    return [FileOut(id=r[0], file_name=r[1], mime_type=r[2], size_bytes=r[3]) for r in rows]


async def _staff_detail(db: AsyncSession, ctx: SchoolContext, homework_id: uuid.UUID) -> HomeworkDetail:
    r = (
        await db.execute(
            text(
                _staff_sql("where h.id = :id and h.school_id = :s")
                .replace(
                    " from public.homework h",
                    ", h.description, a.name as session_name, a.archived_at is not null as archived "
                    "from public.homework h",
                    1,
                )
                .replace(
                    "left join public.subjects sub",
                    "join public.academic_sessions a on a.id = h.academic_session_id left join public.subjects sub",
                    1,
                )
            ),
            {"id": homework_id, "s": ctx.school_id},
        )
    ).first()
    if r is None:
        raise NOT_FOUND
    return HomeworkDetail(
        **_summary_fields(r),
        students=r.students,
        submitted=r.submitted,
        reviewed=r.reviewed,
        can_manage=r.can_manage,
        description=r.description,
        session_name=r.session_name,
        session_is_archived=r.archived,
        attachments=await _attachments(db, homework_id),
    )


async def _require_manage(db: AsyncSession, ctx: SchoolContext, homework_id: uuid.UUID) -> HomeworkDetail:
    d = await _staff_detail(db, ctx, homework_id)
    if not d.can_manage:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the teacher who set this (or a school admin) can do that.")
    return d


def _file_response(body, f_name: str, mime: str, size: int, download: bool) -> StreamingResponse:
    inline_ok = mime in ("application/pdf", "image/jpeg", "image/png") and not download
    media = "text/plain; charset=utf-8" if mime == "text/plain" else mime
    return StreamingResponse(
        body,
        media_type=media,
        headers={
            "Content-Length": str(size),
            "Content-Disposition": content_disposition("inline" if inline_ok else "attachment", f_name),
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            "Cross-Origin-Resource-Policy": "same-site",
        },
    )


async def _stream(path: str):
    try:
        return await storage.open_stream(storage.HOMEWORK_BUCKET, path)
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None


async def _read_uploads(files: list[UploadFile]):
    """Validate every file before storing any of them."""
    if len(files) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Upload at most {MAX_FILES_PER_UPLOAD} files at a time."
        )
    out = []
    for f in files:
        data = await f.read(MAX_DOCUMENT_BYTES + 1)
        try:
            clean = await run_in_threadpool(clean_homework_file, data, f.filename)
        except DocumentError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{f.filename or 'File'}: {exc}") from None
        out.append((clean, safe_filename(f.filename, clean.extension)))
    return out


async def _store(prefix: str, cleaned) -> list[tuple[uuid.UUID, str, str, object]]:
    stored = []
    try:
        for clean, name in cleaned:
            fid = uuid.uuid4()
            path = f"{prefix}/{fid.hex}.{clean.extension}"
            await storage.upload(storage.HOMEWORK_BUCKET, path, clean.data, clean.mime_type)
            stored.append((fid, path, name, clean))
    except storage.StorageError as exc:
        for _, path, _, _ in stored:
            await storage.delete(storage.HOMEWORK_BUCKET, path)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    return stored


async def _discard(paths: list[str]) -> None:
    for p in paths:
        await storage.delete(storage.HOMEWORK_BUCKET, p)


# ------------------------------------------------------------------ staff: homework
@router.get("/sections")
async def settable_sections(ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Sections of the current session the caller may set homework for (teachers: assigned ones)."""
    is_admin = ctx.is_super_admin or "school_admin" in ctx.roles
    rows = (
        await db.execute(
            text(
                "select sec.id, c.name, sec.name, "
                "coalesce((select array_agg(distinct a.subject order by a.subject) from public.teacher_assignments a "
                "  where a.section_id = sec.id and a.subject is not null "
                "  and a.teacher_id = private.current_teacher_id(sec.school_id)), '{}') "
                "from public.sections sec join public.classes c on c.id = sec.class_id "
                "join public.academic_sessions a on a.id = sec.academic_session_id and a.is_current "
                "where sec.school_id = :s and sec.is_active and sec.deleted_at is null "
                + ("" if is_admin else "and private.teacher_assigned_section(sec.id) ")
                + "order by c.display_order, lower(c.name), lower(sec.name)"
            ),
            {"s": ctx.school_id},
        )
    ).all()
    return [{"section_id": str(r[0]), "class_name": r[1], "section_name": r[2], "subjects": list(r[3])} for r in rows]


@router.get("", response_model=HomeworkList)
async def list_homework(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    section_id: uuid.UUID | None = None,
    kind: Kind | None = None,
    state: Literal["open", "closed", "all"] = "all",
    mine: bool = False,
    search: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=20, ge=1, le=100),
) -> HomeworkList:
    where, p = ["h.school_id = :s"], {"s": ctx.school_id}
    if section_id:
        where.append("h.section_id = :sec")
        p["sec"] = section_id
    if kind:
        where.append("h.kind = cast(:k as public.homework_kind)")
        p["k"] = kind
    if state == "open":
        where.append("(now() <= h.due_at or h.allow_late)")
    elif state == "closed":
        where.append("(now() > h.due_at and not h.allow_late)")
    if mine:
        where.append("h.teacher_id = private.current_teacher_id(h.school_id)")
    if search and search.strip():
        where.append("(h.title ilike :q or sub.name ilike :q)")
        p["q"] = f"%{search.strip()}%"
    cond = " where " + " and ".join(where)
    total = (
        await db.execute(
            text(
                "select count(*) from public.homework h left join public.subjects sub on sub.id = h.subject_id" + cond
            ),
            p,
        )
    ).scalar_one()
    # open work first (nearest deadline first), then closed work (most recent first)
    order = (
        " order by (now() > h.due_at and not h.allow_late), "
        "case when now() <= h.due_at or h.allow_late then h.due_at end, h.due_at desc"
    )
    rows = (
        await db.execute(
            text(_staff_sql(cond + order + " limit :lim offset :off")),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).all()
    items = [
        StaffSummary(
            **_summary_fields(r),
            students=r.students,
            submitted=r.submitted,
            reviewed=r.reviewed,
            can_manage=r.can_manage,
        )
        for r in rows
    ]
    return HomeworkList(items=items, total=total, page=page, page_size=page_size)


@router.post("", response_model=HomeworkDetail, status_code=status.HTTP_201_CREATED)
async def create_homework(
    payload: HomeworkIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> HomeworkDetail:
    sec = (
        await db.execute(
            text(
                "select sec.class_id, sec.academic_session_id, private.teacher_assigned_section(sec.id), "
                "private.current_teacher_id(sec.school_id) from public.sections sec "
                "where sec.id = :id and sec.school_id = :s and sec.deleted_at is null"
            ),
            {"id": payload.section_id, "s": ctx.school_id},
        )
    ).first()
    if sec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Class not found.")
    is_admin = ctx.is_super_admin or "school_admin" in ctx.roles
    if not is_admin and not (sec[2] and sec[3]):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only set homework for classes assigned to you.")
    if payload.due_at <= datetime.now(UTC):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The deadline must be in the future.")
    try:
        hid = (
            await db.execute(
                text(
                    "insert into public.homework (school_id, academic_session_id, class_id, "
                    "section_id, kind, subject_id, "
                    "title, description, due_at, max_marks, allow_late) values (:s, :sess, :cls, :sec, "
                    "cast(:kind as public.homework_kind), :sub, :t, :d, :due, :max, :late) returning id"
                ),
                {
                    "s": ctx.school_id,
                    "sess": sec[1],
                    "cls": sec[0],
                    "sec": payload.section_id,
                    "kind": payload.kind,
                    "sub": payload.subject_id,
                    "t": payload.title,
                    "d": payload.description,
                    "due": payload.due_at,
                    "max": payload.max_marks,
                    "late": payload.allow_late,
                },
            )
        ).scalar_one()
        await write_audit(
            db,
            request,
            action="homework.created",
            entity_type="homework",
            entity_id=str(hid),
            school_id=ctx.school_id,
            metadata={"title": payload.title, "kind": payload.kind, "section_id": str(payload.section_id)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _staff_detail(db, ctx, hid)


@router.get("/{homework_id}", response_model=HomeworkDetail)
async def get_homework(
    homework_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> HomeworkDetail:
    return await _staff_detail(db, ctx, homework_id)


@router.patch("/{homework_id}", response_model=HomeworkDetail)
async def update_homework(
    homework_id: uuid.UUID,
    payload: HomeworkUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> HomeworkDetail:
    await _require_manage(db, ctx, homework_id)
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        return await _staff_detail(db, ctx, homework_id)
    if "title" in fields and not fields["title"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter a title.")
    sets, p = [], {"id": homework_id, "s": ctx.school_id}
    for k, v in fields.items():
        sets.append(f"{k} = cast(:{k} as public.homework_kind)" if k == "kind" else f"{k} = :{k}")
        p[k] = "" if (k == "description" and v is None) else v
    try:
        await db.execute(text(f"update public.homework set {', '.join(sets)} where id = :id and school_id = :s"), p)
        await write_audit(
            db,
            request,
            action="homework.updated",
            entity_type="homework",
            entity_id=str(homework_id),
            school_id=ctx.school_id,
            metadata={"fields": sorted(fields)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _staff_detail(db, ctx, homework_id)


@router.delete("/{homework_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_homework(
    homework_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> None:
    d = await _require_manage(db, ctx, homework_id)
    paths = [
        r[0]
        for r in (
            await db.execute(
                text("select file_path from public.homework_attachments where homework_id = :h"), {"h": homework_id}
            )
        ).all()
    ]
    try:
        await db.execute(
            text("delete from public.homework where id = :id and school_id = :s"),
            {"id": homework_id, "s": ctx.school_id},
        )
        await write_audit(
            db,
            request,
            action="homework.deleted",
            entity_type="homework",
            entity_id=str(homework_id),
            school_id=ctx.school_id,
            metadata={"title": d.title},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    await _discard(paths)


# ------------------------------------------------------------------ staff: files
@router.post("/{homework_id}/attachments", response_model=HomeworkDetail, status_code=status.HTTP_201_CREATED)
async def add_attachments(
    homework_id: uuid.UUID,
    request: Request,
    files: list[UploadFile] = File(...),
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> HomeworkDetail:
    await _require_manage(db, ctx, homework_id)
    cleaned = await _read_uploads(files)
    stored = await _store(f"{ctx.school_id}/{homework_id}", cleaned)
    try:
        for fid, path, name, clean in stored:
            await db.execute(
                text(
                    "insert into public.homework_attachments (id, school_id, homework_id, file_name, "
                    "mime_type, size_bytes, "
                    "file_path) values (:id, :s, :h, :n, :m, :b, :p)"
                ),
                {
                    "id": fid,
                    "s": ctx.school_id,
                    "h": homework_id,
                    "n": name,
                    "m": clean.mime_type,
                    "b": len(clean.data),
                    "p": path,
                },
            )
        await write_audit(
            db,
            request,
            action="homework.files_added",
            entity_type="homework",
            entity_id=str(homework_id),
            school_id=ctx.school_id,
            metadata={"files": [s[2] for s in stored]},
        )
        await db.commit()
    except DBAPIError as exc:
        await _discard([s[1] for s in stored])
        raise await http_error_from_db(db, exc) from None
    return await _staff_detail(db, ctx, homework_id)


@router.delete("/{homework_id}/attachments/{file_id}", response_model=HomeworkDetail)
async def remove_attachment(
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> HomeworkDetail:
    await _require_manage(db, ctx, homework_id)
    try:
        path = (
            await db.execute(
                text("delete from public.homework_attachments where id = :f and homework_id = :h returning file_path"),
                {"f": file_id, "h": homework_id},
            )
        ).scalar()
        if path is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
        await write_audit(
            db,
            request,
            action="homework.file_removed",
            entity_type="homework",
            entity_id=str(homework_id),
            school_id=ctx.school_id,
            metadata={"file_id": str(file_id)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    await _discard([path])
    return await _staff_detail(db, ctx, homework_id)


async def attachment_response(db: AsyncSession, homework_id: uuid.UUID, file_id: uuid.UUID, download: bool):
    """RLS decides: the file is found only if its homework is visible to the caller."""
    r = (
        await db.execute(
            text(
                "select file_path, file_name, mime_type, size_bytes from public.homework_attachments "
                "where id = :f and homework_id = :h"
            ),
            {"f": file_id, "h": homework_id},
        )
    ).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    return _file_response(await _stream(r[0]), r[1], r[2], r[3], download)


@router.get("/{homework_id}/attachments/{file_id}")
async def get_attachment(
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
    download: bool = False,
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
):
    await _staff_detail(db, ctx, homework_id)
    return await attachment_response(db, homework_id, file_id, download)


# ------------------------------------------------------------------ staff: submissions & review
@router.get("/{homework_id}/submissions", response_model=list[RosterRow])
async def roster(
    homework_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> list[RosterRow]:
    """Every student of the class with their submission (if any). Only for those who may review."""
    await _require_manage(db, ctx, homework_id)
    rows = (
        await db.execute(
            text(
                "select st.id, st.full_name, e.admission_number, s.id, s.submitted_at, "
                "coalesce(s.is_late, false), s.marks, "
                "s.reviewed_at is not null, (select count(*) from public.homework_submission_files f "
                "where f.submission_id = s.id) "
                "from public.homework h join public.student_enrollments e on e.section_id = h.section_id "
                "join public.students st on st.id = e.student_id "
                "left join public.homework_submissions s on s.homework_id = h.id and s.student_id = st.id "
                "where h.id = :h order by lower(st.full_name), e.admission_number"
            ),
            {"h": homework_id},
        )
    ).all()
    return [
        RosterRow(
            student_id=r[0],
            full_name=r[1],
            admission_number=r[2],
            submission_id=r[3],
            submitted_at=r[4],
            is_late=r[5],
            marks=_money(r[6]),
            reviewed=r[7],
            file_count=r[8] or 0,
        )
        for r in rows
    ]


async def _submission(db: AsyncSession, homework_id: uuid.UUID, submission_id: uuid.UUID) -> SubmissionOut:
    r = (
        await db.execute(
            text(
                "select id, answer, submitted_at, is_late, marks, feedback, reviewed_at from "
                "public.homework_submissions "
                "where id = :id and homework_id = :h"
            ),
            {"id": submission_id, "h": homework_id},
        )
    ).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found.")
    return SubmissionOut(
        id=r[0],
        answer=r[1],
        submitted_at=r[2],
        is_late=r[3],
        marks=_money(r[4]),
        feedback=r[5],
        reviewed_at=r[6],
        files=await _submission_files(db, r[0]),
    )


@router.get("/{homework_id}/submissions/{submission_id}", response_model=SubmissionOut)
async def get_submission(
    homework_id: uuid.UUID, submission_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> SubmissionOut:
    await _require_manage(db, ctx, homework_id)
    return await _submission(db, homework_id, submission_id)


@router.put("/{homework_id}/submissions/{submission_id}/review", response_model=SubmissionOut)
async def review_submission(
    homework_id: uuid.UUID,
    submission_id: uuid.UUID,
    payload: ReviewIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> SubmissionOut:
    d = await _require_manage(db, ctx, homework_id)
    if payload.marks is not None and d.max_marks is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "This homework isn't marked. Set maximum marks on it first."
        )
    if payload.marks is not None and d.max_marks is not None and payload.marks > Decimal(d.max_marks):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Marks can't be more than the maximum ({d.max_marks})."
        )
    try:
        found = (
            await db.execute(
                text(
                    "update public.homework_submissions set marks = :m, feedback = :f "
                    "where id = :id and homework_id = :h returning student_id"
                ),
                {"m": payload.marks, "f": payload.feedback or None, "id": submission_id, "h": homework_id},
            )
        ).scalar()
        if found is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found.")
        await write_audit(
            db,
            request,
            action="homework.reviewed",
            entity_type="homework_submission",
            entity_id=str(submission_id),
            school_id=ctx.school_id,
            metadata={
                "homework_id": str(homework_id),
                "marks": str(payload.marks) if payload.marks is not None else None,
            },
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _submission(db, homework_id, submission_id)


async def submission_file_response(db: AsyncSession, submission_id: uuid.UUID, file_id: uuid.UUID, download: bool):
    r = (
        await db.execute(
            text(
                "select file_path, file_name, mime_type, size_bytes from public.homework_submission_files "
                "where id = :f and submission_id = :s"
            ),
            {"f": file_id, "s": submission_id},
        )
    ).first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    return _file_response(await _stream(r[0]), r[1], r[2], r[3], download)


@router.get("/{homework_id}/submissions/{submission_id}/files/{file_id}")
async def get_submission_file(
    homework_id: uuid.UUID,
    submission_id: uuid.UUID,
    file_id: uuid.UUID,
    download: bool = False,
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
):
    await _require_manage(db, ctx, homework_id)
    await _submission(db, homework_id, submission_id)
    return await submission_file_response(db, submission_id, file_id, download)


# ------------------------------------------------------------------ student / parent (shared)
def _status(r) -> str:
    if r.sub_id is not None:
        if r.reviewed_at is not None:
            return "reviewed"
        return "late" if r.sub_late else "submitted"
    return "missing" if r.is_closed else "pending"


_STUDENT_EXTRA = ", s.id as sub_id, s.submitted_at, s.is_late as sub_late, s.marks as sub_marks, s.reviewed_at "


def _student_sql(where: str) -> str:
    sql = _BASE.replace(" from public.homework h", _STUDENT_EXTRA + " from public.homework h", 1)
    return sql + "left join public.homework_submissions s on s.homework_id = h.id and s.student_id = :st " + where


def _student_row(r) -> dict:
    return {
        **_summary_fields(r),
        "status": _status(r),
        "marks": _money(r.sub_marks),
        "submitted_at": r.submitted_at,
    }


async def student_homework_list(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID, kind: Kind | None) -> dict:
    """Homework of the student's current class, newest deadline first."""
    from app.api.v1.routes.portal import _child_section

    sec = await _child_section(db, ctx, student_id)
    p = {"st": student_id, "sec": sec, "s": ctx.school_id}
    where = "where h.section_id = :sec and h.school_id = :s "
    if kind:
        where += "and h.kind = cast(:k as public.homework_kind) "
        p["k"] = kind
    rows = (
        await db.execute(
            text(
                _student_sql(
                    where + "order by (s.id is not null or (now() > h.due_at and not h.allow_late)), "
                    "case when s.id is null and (now() <= h.due_at or h.allow_late) then h.due_at end, h.due_at desc"
                )
            ),
            p,
        )
    ).all()
    items = [StudentHomework(**_student_row(r)) for r in rows]
    counts: dict[str, int] = {}
    for i in items:
        counts[i.status] = counts.get(i.status, 0) + 1
    return {"items": [i.model_dump(mode="json") for i in items], "counts": counts}


async def student_homework_detail(
    db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID, homework_id: uuid.UUID, *, is_self: bool
) -> StudentHomeworkDetail:
    r = (
        await db.execute(
            text(
                _student_sql(
                    "where h.id = :h and h.school_id = :s and exists (select 1 from public.student_enrollments e "
                    "where e.student_id = :st and e.section_id = h.section_id)"
                )
                .replace(
                    " from public.homework h",
                    ", h.description, a.archived_at is not null as archived from public.homework h",
                    1,
                )
                .replace(
                    "left join public.subjects sub",
                    "join public.academic_sessions a on a.id = h.academic_session_id left join public.subjects sub",
                    1,
                )
            ),
            {"h": homework_id, "s": ctx.school_id, "st": student_id},
        )
    ).first()
    if r is None:
        raise NOT_FOUND
    submission = await _submission(db, homework_id, r.sub_id) if r.sub_id else None
    can_submit = (
        is_self and not r.archived and not r.is_closed and (submission is None or submission.reviewed_at is None)
    )
    return StudentHomeworkDetail(
        **_student_row(r),
        description=r.description,
        attachments=await _attachments(db, homework_id),
        submission=submission,
        can_submit=can_submit,
        session_is_archived=r.archived,
    )


async def student_submission_file(
    db: AsyncSession,
    ctx: SchoolContext,
    student_id: uuid.UUID,
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
    download: bool,
):
    d = await student_homework_detail(db, ctx, student_id, homework_id, is_self=False)
    if d.submission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    return await submission_file_response(db, d.submission.id, file_id, download)


async def submit_work(
    db: AsyncSession,
    ctx: SchoolContext,
    request: Request,
    student_id: uuid.UUID,
    homework_id: uuid.UUID,
    answer: str,
    files: list[UploadFile],
) -> StudentHomeworkDetail:
    d = await student_homework_detail(db, ctx, student_id, homework_id, is_self=True)
    if d.session_is_archived:
        raise HTTPException(status.HTTP_409_CONFLICT, "This session is archived, so its homework is read-only.")
    if d.submission and d.submission.reviewed_at:
        raise HTTPException(status.HTTP_409_CONFLICT, "Your teacher has already reviewed this, so it can't be changed.")
    if d.is_closed:
        raise HTTPException(status.HTTP_409_CONFLICT, "The deadline has passed, so this can't be submitted any more.")
    answer = answer.strip()
    have = len(d.submission.files) if d.submission else 0
    if not answer and not files and have == 0:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Write an answer or attach at least one file.")
    if have + len(files) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"You can attach at most {MAX_FILES_PER_UPLOAD} files."
        )
    cleaned = await _read_uploads(files)
    stored: list = []
    try:
        if d.submission is None:
            sid = (
                await db.execute(
                    text(
                        "insert into public.homework_submissions (school_id, homework_id, "
                        "student_id, enrollment_id, answer) "
                        "select e.school_id, :h, e.student_id, e.id, :a from public.student_enrollments e "
                        "join public.homework h on h.section_id = e.section_id and h.id = :h "
                        "where e.student_id = :st returning id"
                    ),
                    {"h": homework_id, "st": student_id, "a": answer},
                )
            ).scalar_one()
        else:
            sid = d.submission.id
            await db.execute(
                text("update public.homework_submissions set answer = :a where id = :id"), {"a": answer, "id": sid}
            )
        stored = await _store(f"{ctx.school_id}/{homework_id}/sub/{sid}", cleaned)
        for fid, path, name, clean in stored:
            await db.execute(
                text(
                    "insert into public.homework_submission_files (id, school_id, submission_id, file_name, mime_type, "
                    "size_bytes, file_path) values (:id, :s, :sub, :n, :m, :b, :p)"
                ),
                {
                    "id": fid,
                    "s": ctx.school_id,
                    "sub": sid,
                    "n": name,
                    "m": clean.mime_type,
                    "b": len(clean.data),
                    "p": path,
                },
            )
        await write_audit(
            db,
            request,
            action="homework.submitted" if d.submission is None else "homework.resubmitted",
            entity_type="homework_submission",
            entity_id=str(sid),
            school_id=ctx.school_id,
            metadata={"homework_id": str(homework_id), "files": len(stored)},
        )
        await db.commit()
    except DBAPIError as exc:
        await _discard([s[1] for s in stored])
        raise await http_error_from_db(db, exc) from None
    except HTTPException:
        await db.rollback()
        await _discard([s[1] for s in stored])
        raise
    return await student_homework_detail(db, ctx, student_id, homework_id, is_self=True)


async def remove_submission_file(
    db: AsyncSession,
    ctx: SchoolContext,
    request: Request,
    student_id: uuid.UUID,
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
) -> StudentHomeworkDetail:
    d = await student_homework_detail(db, ctx, student_id, homework_id, is_self=True)
    if d.submission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
    try:
        path = (
            await db.execute(
                text(
                    "delete from public.homework_submission_files where id = :f and submission_id = "
                    ":s returning file_path"
                ),
                {"f": file_id, "s": d.submission.id},
            )
        ).scalar()
        if path is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found.")
        await write_audit(
            db,
            request,
            action="homework.submission_file_removed",
            entity_type="homework_submission",
            entity_id=str(d.submission.id),
            school_id=ctx.school_id,
            metadata={"file_id": str(file_id)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    await _discard([path])
    return await student_homework_detail(db, ctx, student_id, homework_id, is_self=True)


# Form/File re-exported for the student router (keeps imports in one place)
SubmitAnswer = Form(default="", max_length=5000)
SubmitFiles = File(default=[])
