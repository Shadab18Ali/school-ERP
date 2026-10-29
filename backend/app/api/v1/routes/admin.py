"""Platform (super admin) endpoints: tenant lifecycle."""

import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import bindparam, func, or_, select, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, get_db, require_super_admin
from app.db.errors import pg_error
from app.models.core import Profile, School, SchoolMembership
from app.schemas.school import (
    InviteAdminIn,
    InviteAdminOut,
    PlatformStats,
    SchoolAdminOut,
    SchoolCreate,
    SchoolList,
    SchoolOut,
    SchoolStatus,
    SchoolUpdate,
)
from app.services import storage
from app.services.audit import write_audit
from app.services.images import MAX_UPLOAD_BYTES, LogoError, process_logo
from app.services.schools import admin_count_subquery, school_out
from app.services.supabase_admin import SupabaseAdminError, invite_user

router = APIRouter(prefix="/admin", tags=["super-admin"])

CONFLICTS = {
    "schools_code_key": "Another school already uses this code.",
    "schools_affiliation_key": "Another school already has this affiliation number for the same board.",
    "schools_udise_key": "Another school already has this UDISE code.",
}


def _school_conflict(exc: IntegrityError) -> HTTPException:
    err = pg_error(exc)
    if err.constraint in CONFLICTS:
        return HTTPException(status.HTTP_409_CONFLICT, CONFLICTS[err.constraint])
    if err.sqlstate == "23514":
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "One of the values isn't in a valid format.")
    return HTTPException(status.HTTP_409_CONFLICT, "This change conflicts with another school's details.")


def _like(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


@router.get("/stats", response_model=PlatformStats)
async def platform_stats(
    _: CurrentUser = Depends(require_super_admin), db: AsyncSession = Depends(get_db)
) -> PlatformStats:
    total = await db.scalar(select(func.count()).select_from(School)) or 0
    active = await db.scalar(select(func.count()).select_from(School).where(School.status == "active")) or 0
    users = await db.scalar(select(func.count()).select_from(Profile)) or 0
    return PlatformStats(
        total_schools=total, active_schools=active, suspended_schools=total - active, total_users=users
    )


@router.get("/schools", response_model=SchoolList)
async def list_schools(
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
    search: str | None = Query(default=None, max_length=100),
    status_filter: SchoolStatus | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=20, ge=1, le=100),
) -> SchoolList:
    query = select(School)
    if search and search.strip():
        pattern = _like(search.strip())
        query = query.where(
            or_(
                School.name.ilike(pattern, escape="\\"),
                School.code.ilike(pattern, escape="\\"),
                School.city.ilike(pattern, escape="\\"),
            )
        )
    if status_filter:
        query = query.where(School.status == status_filter)

    total = await db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = (
        await db.execute(
            query.add_columns(admin_count_subquery())
            .order_by(School.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    items = [SchoolOut.model_validate(s).model_copy(update={"admin_count": c or 0}) for s, c in rows]
    if items:
        # plan, size and last activity, from private.platform_schools (migration 0029)
        overview = {
            r.school_id: r
            for r in (
                await db.execute(
                    text("select * from private.platform_schools(:ids)").bindparams(
                        bindparam("ids", type_=ARRAY(PG_UUID(as_uuid=True)))
                    ),
                    {"ids": [i.id for i in items]},
                )
            ).all()
        }
        items = [
            i.model_copy(
                update={
                    "plan_name": o.plan_name,
                    "subscription_state": o.subscription_state,
                    "current_period_end": o.current_period_end,
                    "trial_ends_at": o.trial_ends_at,
                    "students_active": o.students_active,
                    "staff": o.staff,
                    "max_students": o.max_students,
                    "last_activity_at": o.last_activity_at,
                }
            )
            if (o := overview.get(i.id))
            else i
            for i in items
        ]
    return SchoolList(items=items, total=total, page=page, page_size=page_size)


@router.post("/schools", response_model=SchoolOut, status_code=status.HTTP_201_CREATED)
async def create_school(
    payload: SchoolCreate,
    request: Request,
    user: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> SchoolOut:
    school = School(**payload.model_dump(), created_by=user.id)
    db.add(school)
    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _school_conflict(exc) from None
    # recorded in the audit log by the database (school.created, migration 0032)
    await db.commit()
    out = await school_out(db, school.id)
    assert out is not None
    return out


@router.get("/schools/{school_id}", response_model=SchoolOut)
async def get_school(
    school_id: uuid.UUID,
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> SchoolOut:
    out = await school_out(db, school_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")
    return out


@router.patch("/schools/{school_id}", response_model=SchoolOut)
async def update_school(
    school_id: uuid.UUID,
    payload: SchoolUpdate,
    request: Request,
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> SchoolOut:
    school = await db.get(School, school_id)
    if school is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")

    changes: dict[str, dict[str, object]] = {}
    for field, new in payload.model_dump(exclude_unset=True).items():
        old = getattr(school, field)
        if old != new:
            changes[field] = {"from": old, "to": new}
            setattr(school, field, new)

    if not changes:
        out = await school_out(db, school_id)
        assert out is not None
        return out

    try:
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise _school_conflict(exc) from None

    # recorded by the database: school.updated (each changed field) or school.activated / deactivated (0032)
    await db.commit()
    out = await school_out(db, school_id)
    assert out is not None
    return out


@router.post("/schools/{school_id}/admins", response_model=InviteAdminOut, status_code=status.HTTP_201_CREATED)
async def invite_school_admin(
    school_id: uuid.UUID,
    payload: InviteAdminIn,
    request: Request,
    user: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> InviteAdminOut:
    school = await db.get(School, school_id)
    if school is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")

    email = payload.email.lower()
    try:
        new_user_id = await invite_user(email, payload.full_name)
    except SupabaseAdminError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc

    invited = new_user_id is not None
    if new_user_id is None:
        existing = await db.scalar(select(Profile).where(func.lower(Profile.email) == email))
        if existing is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "This email exists in Auth but has no profile.")
        new_user_id = existing.id

    membership = await db.scalar(
        select(SchoolMembership).where(
            SchoolMembership.school_id == school_id,
            SchoolMembership.user_id == new_user_id,
            SchoolMembership.role == "school_admin",
        )
    )
    if membership and membership.status == "active":
        raise HTTPException(status.HTTP_409_CONFLICT, "This person is already an admin of this school.")
    if membership:
        membership.status = "active"
    else:
        db.add(SchoolMembership(school_id=school_id, user_id=new_user_id, role="school_admin", created_by=user.id))
    await db.flush()

    await write_audit(
        db,
        request,
        action="school.admin_added",
        entity_type="school_membership",
        entity_id=str(new_user_id),
        school_id=school_id,
        metadata={"email": email, "invited": invited},
    )
    await db.commit()
    return InviteAdminOut(user_id=new_user_id, email=email, invited=invited)


@router.get("/schools/{school_id}/admins", response_model=list[SchoolAdminOut])
async def list_school_admins(
    school_id: uuid.UUID,
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> list[SchoolAdminOut]:
    rows = await db.execute(
        select(Profile.id, Profile.full_name, Profile.email, SchoolMembership.status, SchoolMembership.created_at)
        .join(SchoolMembership, SchoolMembership.user_id == Profile.id)
        .where(SchoolMembership.school_id == school_id, SchoolMembership.role == "school_admin")
        .order_by(Profile.full_name)
    )
    return [
        SchoolAdminOut(user_id=uid, full_name=name, email=email, status=st, added_at=at)
        for uid, name, email, st, at in rows.all()
    ]


@router.post("/schools/{school_id}/logo", response_model=SchoolOut)
async def upload_school_logo(
    school_id: uuid.UUID,
    request: Request,
    file: UploadFile = File(...),
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> SchoolOut:
    school = await db.get(School, school_id)
    if school is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")

    data = await file.read(MAX_UPLOAD_BYTES + 1)
    try:
        png = await run_in_threadpool(process_logo, data)
    except LogoError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None

    path = f"{school_id}/logo-{uuid.uuid4().hex}.png"  # new name each time: no stale caches
    try:
        url = await storage.upload(storage.LOGO_BUCKET, path, png, "image/png")
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None

    old_path = school.logo_path
    school.logo_path, school.logo_url = path, url
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="school.logo_updated",
            entity_type="school",
            entity_id=str(school_id),
            school_id=school_id,
            metadata={"bytes": len(png)},
        )
        await db.commit()
    except DBAPIError:
        await db.rollback()
        await storage.delete(storage.LOGO_BUCKET, path)
        raise
    if old_path:
        await storage.delete(storage.LOGO_BUCKET, old_path)
    out = await school_out(db, school_id)
    assert out is not None
    return out


@router.delete("/schools/{school_id}/logo", response_model=SchoolOut)
async def remove_school_logo(
    school_id: uuid.UUID,
    request: Request,
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> SchoolOut:
    school = await db.get(School, school_id)
    if school is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")
    old_path = school.logo_path
    if old_path:
        school.logo_path = school.logo_url = None
        await db.flush()
        await write_audit(
            db,
            request,
            action="school.logo_removed",
            entity_type="school",
            entity_id=str(school_id),
            school_id=school_id,
        )
        await db.commit()
        await storage.delete(storage.LOGO_BUCKET, old_path)
    out = await school_out(db, school_id)
    assert out is not None
    return out
