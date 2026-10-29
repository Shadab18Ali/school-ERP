"""Teacher management (school admins). Staff records, photo, login link and class
assignments. Which students a teacher can then reach is decided by RLS from the
assignments made here (private.teacher_assigned_section / teacher_sees_student)."""

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.schemas.teachers import (
    AssignmentIn,
    AssignmentOut,
    AssignmentUpdate,
    LoginInfo,
    StatusChange,
    TeacherCreate,
    TeacherDetail,
    TeacherList,
    TeacherSummary,
    TeacherUpdate,
)
from app.services import storage
from app.services.audit import write_audit
from app.services.images import MAX_UPLOAD_BYTES, PhotoError, process_photo
from app.services.supabase_admin import SupabaseAdminError, invite_user

router = APIRouter(prefix="/teachers", tags=["teachers"])
VIEW = Depends(require_permission(Permission.TEACHERS_VIEW))
MANAGE = Depends(require_permission(Permission.TEACHERS_MANAGE))

UNIQUE = {
    "teachers_school_employee_key": "That Employee ID is already used by another teacher.",
    "teachers_school_email_key": "A teacher with this email already exists.",
    "teachers_account_unique": "That login is already linked to another teacher.",
    "assignments_unique": "This teacher already has that subject in that section.",
    "assignments_one_class_teacher": "That section already has a class teacher. Remove them as class teacher first.",
}
FIELDS = (
    "employee_id",
    "full_name",
    "phone",
    "email",
    "qualification",
    "subject",
    "joining_date",
    "address",
    "staff_type",
    "designation",
)
_ASSIGNED_NOW = (
    "(select count(distinct a.section_id) from public.teacher_assignments a "
    "join public.academic_sessions s on s.id = a.academic_session_id and s.is_current "
    "where a.teacher_id = t.id)"
)


def _like(term: str) -> str:
    return "%" + " ".join(term.split()).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


async def _row(db: AsyncSession, ctx: SchoolContext, teacher_id: uuid.UUID):
    row = (
        (
            await db.execute(
                text(
                    f"select t.*, {_ASSIGNED_NOW} as assigned_now from public.teachers t where t.id = :id and "
                    f"t.school_id = :s"
                ),
                {"id": teacher_id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Teacher not found.")
    return row


def _summary(r, photo_url: str | None) -> dict:
    return dict(
        id=r["id"],
        employee_id=r["employee_id"],
        full_name=r["full_name"],
        phone=r["phone"],
        email=r["email"],
        qualification=r["qualification"],
        subject=r["subject"],
        joining_date=r["joining_date"],
        staff_type=r["staff_type"],
        designation=r["designation"],
        status=r["status"],
        photo_url=photo_url,
        has_login=r["account_id"] is not None,
        assigned_sections=r["assigned_now"] or 0,
    )


async def _assignments(db: AsyncSession, teacher_id: uuid.UUID) -> list[AssignmentOut]:
    rows = (
        await db.execute(
            text(
                "select a.id, a.section_id, a.class_id, c.name, sec.name, a.academic_session_id, s.name, s.is_current, "
                "s.archived_at is not null, a.subject, a.is_class_teacher "
                "from public.teacher_assignments a join public.classes c on c.id = a.class_id "
                "join public.sections sec on sec.id = a.section_id "
                "join public.academic_sessions s on s.id = a.academic_session_id "
                "where a.teacher_id = :t order by s.start_date desc, c.display_order, lower(c.name), lower(sec.name), "
                "a.is_class_teacher desc, lower(coalesce(a.subject, ''))"
            ),
            {"t": teacher_id},
        )
    ).all()
    return [
        AssignmentOut(
            id=r[0],
            section_id=r[1],
            class_id=r[2],
            class_name=r[3],
            section_name=r[4],
            academic_session_id=r[5],
            session_name=r[6],
            session_is_current=r[7],
            session_is_archived=r[8],
            subject=r[9],
            is_class_teacher=r[10],
        )
        for r in rows
    ]


async def _detail(db: AsyncSession, ctx: SchoolContext, teacher_id: uuid.UUID) -> TeacherDetail:
    r = await _row(db, ctx, teacher_id)
    photo = None
    if r["photo_path"]:
        photo = (await storage.signed_urls(storage.STAFF_PHOTO_BUCKET, [r["photo_path"]])).get(r["photo_path"])
    login_email = None
    library_duty = False
    if r["account_id"]:
        login_email = (
            await db.execute(text("select email from public.profiles where id = :u"), {"u": r["account_id"]})
        ).scalar()
        library_duty = bool(
            (
                await db.execute(
                    text(
                        "select exists (select 1 from public.school_memberships where user_id = :u and school_id = :s "
                        "and role = 'librarian' and status = 'active')"
                    ),
                    {"u": r["account_id"], "s": ctx.school_id},
                )
            ).scalar()
        )
    return TeacherDetail(
        **_summary(r, photo),
        address=r["address"],
        status_reason=r["status_reason"],
        login=LoginInfo(linked=r["account_id"] is not None, email=login_email, library_duty=library_duty),
        assignments=await _assignments(db, r["id"]),
        created_at=r["created_at"],
    )


# ------------------------------------------------------------------ list / read
@router.get("", response_model=TeacherList)
async def list_teachers(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    search: str | None = Query(default=None, max_length=100),
    status_filter: str | None = Query(default=None, alias="status", pattern="^(active|inactive)$"),
    subject: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> TeacherList:
    where, p = ["t.school_id = :s"], {"s": ctx.school_id}
    if status_filter:
        where.append("t.status = cast(:st as public.teacher_status)")
        p["st"] = status_filter
    if subject and subject.strip():
        where.append("t.subject ilike :subj escape '\\'")
        p["subj"] = _like(subject)
    if search and search.strip():
        conds = [
            "t.full_name ilike :q escape '\\'",
            "t.employee_id ilike :q escape '\\'",
            "t.email ilike :q escape '\\'",
            "t.subject ilike :q escape '\\'",
            "t.qualification ilike :q escape '\\'",
        ]
        p["q"] = _like(search)
        digits = "".join(ch for ch in search if ch.isdigit())
        if len(digits) >= 4 and all(ch.isdigit() or ch in " +-()" for ch in search.strip()):
            conds.append("t.phone like :qd")
            p["qd"] = f"%{digits}%"
        where.append("(" + " or ".join(conds) + ")")
    base = f"from public.teachers t where {' and '.join(where)}"
    total = (await db.execute(text(f"select count(*) {base}"), p)).scalar_one()
    rows = (
        (
            await db.execute(
                text(
                    f"select t.*, {_ASSIGNED_NOW} as assigned_now {base} "
                    "order by t.status, lower(t.full_name) limit :lim offset :off"
                ),
                {**p, "lim": page_size, "off": (page - 1) * page_size},
            )
        )
        .mappings()
        .all()
    )
    photos = await storage.signed_urls(storage.STAFF_PHOTO_BUCKET, [r["photo_path"] for r in rows if r["photo_path"]])
    return TeacherList(
        items=[TeacherSummary(**_summary(r, photos.get(r["photo_path"] or ""))) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{teacher_id}", response_model=TeacherDetail)
async def get_teacher(
    teacher_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> TeacherDetail:
    return await _detail(db, ctx, teacher_id)


# ------------------------------------------------------------------ write
@router.post("", response_model=TeacherDetail, status_code=status.HTTP_201_CREATED)
async def create_teacher(
    payload: TeacherCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    data = payload.model_dump()
    try:
        tid = (
            await db.execute(
                text(
                    "insert into public.teachers (school_id, created_by, employee_id, full_name, phone, email, "
                    "qualification, subject, joining_date, address, staff_type, designation) "
                    "values (:s, :by, :employee_id, :full_name, "
                    ":phone, :email, :qualification, :subject, :joining_date, :address, :staff_type, :designation) "
                    "returning id"
                ),
                {"s": ctx.school_id, "by": user.id, **data},
            )
        ).scalar_one()
        await write_audit(
            db,
            request,
            action="teacher.created",
            entity_type="teacher",
            entity_id=str(tid),
            school_id=ctx.school_id,
            metadata={"name": payload.full_name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, tid)


@router.patch("/{teacher_id}", response_model=TeacherDetail)
async def update_teacher(
    teacher_id: uuid.UUID,
    payload: TeacherUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    r = await _row(db, ctx, teacher_id)
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if k in FIELDS and r[k] != v}
    if changes:
        sets = ", ".join(f"{k} = :{k}" for k in changes)
        try:
            await db.execute(
                text(f"update public.teachers set {sets} where id = :id and school_id = :s"),
                {"id": teacher_id, "s": ctx.school_id, **changes},
            )
            await write_audit(
                db,
                request,
                action="teacher.updated",
                entity_type="teacher",
                entity_id=str(teacher_id),
                school_id=ctx.school_id,
                metadata={"before": {k: str(r[k]) for k in changes}, "after": {k: str(v) for k, v in changes.items()}},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, teacher_id)


async def _set_teacher_role(db: AsyncSession, ctx: SchoolContext, account_id: uuid.UUID, active: bool) -> None:
    """The login's staff roles follow the teacher record: an inactive or unlinked
    teacher keeps no teacher (or library) access to the school. Library duty that was
    given comes back when the teacher is activated again (turning the duty off removes it)."""
    await db.execute(
        text(
            "update public.school_memberships set status = cast(:st as public.membership_status) "
            "where user_id = :u and school_id = :s and role in ('teacher', 'librarian')"
        ),
        {"st": "active" if active else "disabled", "u": account_id, "s": ctx.school_id},
    )


@router.post("/{teacher_id}/status", response_model=TeacherDetail)
async def set_status(
    teacher_id: uuid.UUID,
    payload: StatusChange,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    r = await _row(db, ctx, teacher_id)
    if payload.status == "inactive" and not payload.reason:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Give a reason for deactivating the teacher.")
    if r["status"] != payload.status:
        try:
            await db.execute(
                text(
                    "update public.teachers set status = cast(:st as public.teacher_status), status_reason = :rs "
                    "where id = :id and school_id = :s"
                ),
                {
                    "st": payload.status,
                    "rs": payload.reason if payload.status == "inactive" else None,
                    "id": teacher_id,
                    "s": ctx.school_id,
                },
            )
            if r["account_id"]:
                await _set_teacher_role(db, ctx, r["account_id"], payload.status == "active")
            await write_audit(
                db,
                request,
                action=f"teacher.{'activated' if payload.status == 'active' else 'deactivated'}",
                entity_type="teacher",
                entity_id=str(teacher_id),
                school_id=ctx.school_id,
                metadata={"reason": payload.reason},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, teacher_id)


# ------------------------------------------------------------------ photo
@router.post("/{teacher_id}/photo", response_model=TeacherDetail)
async def upload_photo(
    teacher_id: uuid.UUID,
    request: Request,
    file: UploadFile = File(...),
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    r = await _row(db, ctx, teacher_id)
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    try:
        jpeg = await run_in_threadpool(process_photo, data)  # re-encoded JPEG, EXIF stripped, resized
    except PhotoError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    path = f"{ctx.school_id}/teachers/{teacher_id}/{uuid.uuid4().hex}.jpg"
    try:
        await storage.upload(storage.STAFF_PHOTO_BUCKET, path, jpeg, "image/jpeg")
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    try:
        await db.execute(
            text("update public.teachers set photo_path = :p where id = :id and school_id = :s"),
            {"p": path, "id": teacher_id, "s": ctx.school_id},
        )
        await write_audit(
            db,
            request,
            action="teacher.photo_updated",
            entity_type="teacher",
            entity_id=str(teacher_id),
            school_id=ctx.school_id,
        )
        await db.commit()
    except DBAPIError:
        await db.rollback()
        await storage.delete(storage.STAFF_PHOTO_BUCKET, path)
        raise
    if r["photo_path"]:
        await storage.delete(storage.STAFF_PHOTO_BUCKET, r["photo_path"])
    return await _detail(db, ctx, teacher_id)


@router.delete("/{teacher_id}/photo", response_model=TeacherDetail)
async def remove_photo(
    teacher_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> TeacherDetail:
    r = await _row(db, ctx, teacher_id)
    if r["photo_path"]:
        await db.execute(
            text("update public.teachers set photo_path = null where id = :id and school_id = :s"),
            {"id": teacher_id, "s": ctx.school_id},
        )
        await write_audit(
            db,
            request,
            action="teacher.photo_removed",
            entity_type="teacher",
            entity_id=str(teacher_id),
            school_id=ctx.school_id,
        )
        await db.commit()
        await storage.delete(storage.STAFF_PHOTO_BUCKET, r["photo_path"])
    return await _detail(db, ctx, teacher_id)


# ------------------------------------------------------------------ login
@router.put("/{teacher_id}/login", response_model=TeacherDetail)
async def create_login(
    teacher_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    """Gives the teacher a sign-in using the email on their record (new emails get an invitation)."""
    r = await _row(db, ctx, teacher_id)
    if r["account_id"] is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This teacher already has a login.")
    if r["status"] != "active":
        raise HTTPException(status.HTTP_409_CONFLICT, "Activate the teacher before giving them a login.")
    try:
        account = await invite_user(r["email"], r["full_name"])
    except SupabaseAdminError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    invited = account is not None
    if account is None:
        account = (
            await db.execute(
                text("select private.find_account_by_email(:s, :e)"), {"s": ctx.school_id, "e": r["email"]}
            )
        ).scalar()
        if account is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "That email has a sign-in but no profile; ask support to check it."
            )
    is_student = (
        await db.execute(
            text(
                "select exists (select 1 from public.school_memberships where user_id = :u and school_id = :s "
                "and role = 'student' and status = 'active')"
            ),
            {"u": account, "s": ctx.school_id},
        )
    ).scalar()
    if is_student:
        raise HTTPException(status.HTTP_409_CONFLICT, "That email belongs to a student account in this school.")
    try:
        await db.execute(
            text(
                "insert into public.school_memberships (school_id, user_id, role, created_by) "
                "values (:s, :u, 'teacher', :by) on conflict (school_id, user_id, role) do update set status = 'active'"
            ),
            {"s": ctx.school_id, "u": account, "by": user.id},
        )
        await db.execute(
            text("update public.teachers set account_id = :u where id = :id and school_id = :s"),
            {"u": account, "id": teacher_id, "s": ctx.school_id},
        )
        await write_audit(
            db,
            request,
            action="teacher.login_linked",
            entity_type="teacher",
            entity_id=str(teacher_id),
            school_id=ctx.school_id,
            metadata={"email": r["email"], "invited": invited},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, teacher_id)


@router.delete("/{teacher_id}/login", response_model=TeacherDetail)
async def remove_login(
    teacher_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> TeacherDetail:
    r = await _row(db, ctx, teacher_id)
    if r["account_id"] is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This teacher has no login.")
    await db.execute(
        text("update public.teachers set account_id = null where id = :id and school_id = :s"),
        {"id": teacher_id, "s": ctx.school_id},
    )
    await _set_teacher_role(db, ctx, r["account_id"], False)
    await write_audit(
        db,
        request,
        action="teacher.login_removed",
        entity_type="teacher",
        entity_id=str(teacher_id),
        school_id=ctx.school_id,
        metadata={"user_id": str(r["account_id"])},
    )
    await db.commit()
    return await _detail(db, ctx, teacher_id)


class LibraryDuty(BaseModel):
    model_config = {"extra": "forbid"}
    enabled: bool


@router.put("/{teacher_id}/library-duty", response_model=TeacherDetail)
async def set_library_duty(
    teacher_id: uuid.UUID,
    payload: LibraryDuty,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    """Library duty = the librarian role for this staff member's login (catalogue, issue/return, fines)."""
    r = await _row(db, ctx, teacher_id)
    if r["account_id"] is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Give this staff member a login first.")
    if payload.enabled and r["status"] != "active":
        raise HTTPException(status.HTTP_409_CONFLICT, "Activate the staff member first.")
    try:
        if payload.enabled:
            await db.execute(
                text(
                    "insert into public.school_memberships (school_id, user_id, role, created_by) "
                    "values (:s, :u, 'librarian', :by) on conflict (school_id, user_id, role) do update set "
                    "status = 'active'"
                ),
                {"s": ctx.school_id, "u": r["account_id"], "by": user.id},
            )
        else:
            await db.execute(
                text(
                    "delete from public.school_memberships where school_id = :s and user_id = :u and role = 'librarian'"
                ),
                {"s": ctx.school_id, "u": r["account_id"]},
            )
        await write_audit(
            db,
            request,
            action="teacher.library_duty",
            entity_type="teacher",
            entity_id=str(teacher_id),
            school_id=ctx.school_id,
            metadata={"enabled": payload.enabled},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, teacher_id)


# ------------------------------------------------------------------ assignments
@router.post("/{teacher_id}/assignments", response_model=TeacherDetail, status_code=status.HTTP_201_CREATED)
async def add_assignment(
    teacher_id: uuid.UUID,
    payload: AssignmentIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    await _row(db, ctx, teacher_id)
    sec = (
        await db.execute(
            text(
                "select sec.class_id, sec.academic_session_id, c.name || ' – ' || sec.name from public.sections sec "
                "join public.classes c on c.id = sec.class_id where sec.id = :id and sec.school_id = :s and "
                "sec.deleted_at is null"
            ),
            {"id": payload.section_id, "s": ctx.school_id},
        )
    ).first()
    if sec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Section not found.")
    try:
        await db.execute(
            text(
                "insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, "
                "section_id, "
                "subject, is_class_teacher, created_by) values (:s, :t, :sid, :cid, :sec, :subj, :ct, :by)"
            ),
            {
                "s": ctx.school_id,
                "t": teacher_id,
                "sid": sec[1],
                "cid": sec[0],
                "sec": payload.section_id,
                "subj": payload.subject,
                "ct": payload.is_class_teacher,
                "by": user.id,
            },
        )
        await write_audit(
            db,
            request,
            action="teacher.assigned",
            entity_type="teacher",
            entity_id=str(teacher_id),
            school_id=ctx.school_id,
            metadata={"section": sec[2], "subject": payload.subject, "class_teacher": payload.is_class_teacher},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, teacher_id)


@router.patch("/{teacher_id}/assignments/{assignment_id}", response_model=TeacherDetail)
async def update_assignment(
    teacher_id: uuid.UUID,
    assignment_id: uuid.UUID,
    payload: AssignmentUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    data = payload.model_dump(exclude_unset=True)
    if "is_class_teacher" in data and data["is_class_teacher"] is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose whether they are the class teacher.")
    if data:
        sets = ", ".join(f"{k} = :{k}" for k in data)
        try:
            res = await db.execute(
                text(
                    f"update public.teacher_assignments set {sets} where id = :a and teacher_id = :t and school_id = :s"
                ),
                {"a": assignment_id, "t": teacher_id, "s": ctx.school_id, **data},
            )
            if res.rowcount != 1:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Assignment not found.")
            await write_audit(
                db,
                request,
                action="teacher.assignment_updated",
                entity_type="teacher",
                entity_id=str(teacher_id),
                school_id=ctx.school_id,
                metadata={"assignment_id": str(assignment_id), **{k: str(v) for k, v in data.items()}},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, teacher_id)


@router.delete("/{teacher_id}/assignments/{assignment_id}", response_model=TeacherDetail)
async def remove_assignment(
    teacher_id: uuid.UUID,
    assignment_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> TeacherDetail:
    try:
        res = await db.execute(
            text(
                "delete from public.teacher_assignments where id = :a and teacher_id = :t and school_id = :s "
                "returning section_id"
            ),
            {"a": assignment_id, "t": teacher_id, "s": ctx.school_id},
        )
        if res.scalar() is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Assignment not found.")
        await write_audit(
            db,
            request,
            action="teacher.unassigned",
            entity_type="teacher",
            entity_id=str(teacher_id),
            school_id=ctx.school_id,
            metadata={"assignment_id": str(assignment_id)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, teacher_id)
