"""Sections of the active school, always within one academic session."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.models.academic import AcademicSession, SchoolClass, Section
from app.schemas.classes import (
    BulkResult,
    RecordStatus,
    SectionBulkCreate,
    SectionCopy,
    SectionCreate,
    SectionList,
    SectionOut,
    SectionUpdate,
)
from app.services.academics import get_class, resolve_session, student_counts, writable_session
from app.services.audit import write_audit

router = APIRouter(prefix="/sections", tags=["sections"])
VIEW = Depends(require_permission(Permission.CLASSES_VIEW))
MANAGE = Depends(require_permission(Permission.CLASSES_MANAGE))
UNIQUE = {"sections_session_class_name_key": "This class already has a section with that name in this session."}


def _like(term: str) -> str:
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _base(ctx: SchoolContext):
    return (
        select(Section, SchoolClass.name, SchoolClass.is_active, AcademicSession.name)
        .join(SchoolClass, SchoolClass.id == Section.class_id)
        .join(AcademicSession, AcademicSession.id == Section.academic_session_id)
        .where(Section.school_id == ctx.school_id)
    )


async def _outs(db: AsyncSession, rows) -> list[SectionOut]:
    counts = await student_counts(db, [r[0].id for r in rows])
    return [
        SectionOut(
            id=s.id,
            class_id=s.class_id,
            class_name=cname,
            class_is_active=cactive,
            academic_session_id=s.academic_session_id,
            session_name=sname,
            name=s.name,
            capacity=s.capacity,
            room=s.room,
            is_active=s.is_active,
            is_deleted=s.deleted_at is not None,
            student_count=counts.get(s.id, 0),
            created_at=s.created_at,
        )
        for s, cname, cactive, sname in rows
    ]


async def _one(db: AsyncSession, ctx: SchoolContext, section_id: uuid.UUID) -> SectionOut:
    row = (await db.execute(_base(ctx).where(Section.id == section_id))).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Section not found.")
    return (await _outs(db, [row]))[0]


async def _get(db: AsyncSession, ctx: SchoolContext, section_id: uuid.UUID) -> Section:
    s = await db.scalar(select(Section).where(Section.id == section_id, Section.school_id == ctx.school_id))
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Section not found.")
    return s


async def _live_classes(db: AsyncSession, ctx: SchoolContext, ids: list[uuid.UUID]) -> list[SchoolClass]:
    classes = list(
        (
            await db.scalars(select(SchoolClass).where(SchoolClass.school_id == ctx.school_id, SchoolClass.id.in_(ids)))
        ).all()
    )
    if len(classes) != len(set(ids)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "One or more classes weren't found in this school.")
    unusable = [c.name for c in classes if c.deleted_at is not None or not c.is_active]
    if unusable:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"These classes are inactive or deleted: {', '.join(sorted(unusable))}."
        )
    return classes


@router.get("", response_model=SectionList)
async def list_sections(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = Query(default=None, description="Defaults to the current session"),
    class_id: uuid.UUID | None = None,
    search: str | None = Query(default=None, max_length=50),
    status_filter: RecordStatus | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> SectionList:
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return SectionList(items=[], total=0, page=page, page_size=page_size)
    q = _base(ctx).where(Section.academic_session_id == session.id)
    if class_id:
        q = q.where(Section.class_id == class_id)
    if status_filter == "deleted":
        q = q.where(Section.deleted_at.is_not(None))
    else:
        q = q.where(Section.deleted_at.is_(None))
        if status_filter == "active":
            q = q.where(Section.is_active.is_(True))
        elif status_filter == "inactive":
            q = q.where(Section.is_active.is_(False))
    if search and search.strip():
        p = _like(search.strip())
        q = q.where(
            or_(
                Section.name.ilike(p, escape="\\"),
                Section.room.ilike(p, escape="\\"),
                SchoolClass.name.ilike(p, escape="\\"),
            )
        )
    total = await db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = (
        await db.execute(
            q.order_by(SchoolClass.display_order, func.lower(SchoolClass.name), func.lower(Section.name))
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return SectionList(items=await _outs(db, rows), total=total, page=page, page_size=page_size)


@router.post("", response_model=SectionOut, status_code=status.HTTP_201_CREATED)
async def create_section(
    payload: SectionCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SectionOut:
    await writable_session(db, ctx, payload.academic_session_id)
    await _live_classes(db, ctx, [payload.class_id])
    s = Section(school_id=ctx.school_id, created_by=user.id, **payload.model_dump())
    db.add(s)
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="section.created",
            entity_type="section",
            entity_id=str(s.id),
            school_id=ctx.school_id,
            metadata={"name": s.name, "class_id": str(s.class_id)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _one(db, ctx, s.id)


@router.post("/bulk", response_model=BulkResult, status_code=status.HTTP_201_CREATED)
async def assign_sections(
    payload: SectionBulkCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BulkResult:
    """Assign the same sections (e.g. A, B, C) to several classes. Existing ones are skipped."""
    session = await writable_session(db, ctx, payload.academic_session_id)
    classes = await _live_classes(db, ctx, payload.class_ids)
    existing = {
        (cid, name.casefold())
        for cid, name in (
            await db.execute(
                select(Section.class_id, Section.name).where(
                    Section.academic_session_id == session.id,
                    Section.class_id.in_(payload.class_ids),
                    Section.deleted_at.is_(None),
                )
            )
        ).all()
    }
    created, skipped = 0, []
    for c in sorted(classes, key=lambda c: (c.display_order, c.name.lower())):
        for name in payload.names:
            if (c.id, name.casefold()) in existing:
                skipped.append(f"{c.name} {name}")
                continue
            db.add(
                Section(
                    school_id=ctx.school_id,
                    class_id=c.id,
                    academic_session_id=session.id,
                    name=name,
                    capacity=payload.capacity,
                    created_by=user.id,
                )
            )
            created += 1
    try:
        await db.flush()
        if created:
            await write_audit(
                db,
                request,
                action="section.bulk_created",
                entity_type="section",
                school_id=ctx.school_id,
                metadata={
                    "session": session.name,
                    "classes": [c.name for c in classes],
                    "names": payload.names,
                    "created": created,
                },
            )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return BulkResult(created=created, skipped=skipped)


@router.post("/copy", response_model=BulkResult, status_code=status.HTTP_201_CREATED)
async def copy_sections(
    payload: SectionCopy,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BulkResult:
    """Copy last year's section structure (names, capacity, rooms) into a new session."""
    source = await resolve_session(db, ctx, payload.from_session_id)
    target = await writable_session(db, ctx, payload.to_session_id)
    assert source is not None
    rows = (
        await db.execute(
            select(Section, SchoolClass.name)
            .join(SchoolClass, SchoolClass.id == Section.class_id)
            .where(
                Section.school_id == ctx.school_id,
                Section.academic_session_id == source.id,
                Section.deleted_at.is_(None),
                SchoolClass.deleted_at.is_(None),
                SchoolClass.is_active.is_(True),
            )
        )
    ).all()
    existing = {
        (cid, n.casefold())
        for cid, n in (
            await db.execute(
                select(Section.class_id, Section.name).where(
                    Section.academic_session_id == target.id, Section.deleted_at.is_(None)
                )
            )
        ).all()
    }
    created, skipped = 0, []
    for s, cname in rows:
        if (s.class_id, s.name.casefold()) in existing:
            skipped.append(f"{cname} {s.name}")
            continue
        db.add(
            Section(
                school_id=ctx.school_id,
                class_id=s.class_id,
                academic_session_id=target.id,
                name=s.name,
                capacity=s.capacity,
                room=s.room,
                created_by=user.id,
            )
        )
        created += 1
    try:
        await db.flush()
        if created:
            await write_audit(
                db,
                request,
                action="section.copied",
                entity_type="section",
                school_id=ctx.school_id,
                metadata={"from": source.name, "to": target.name, "created": created},
            )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return BulkResult(created=created, skipped=skipped)


@router.patch("/{section_id}", response_model=SectionOut)
async def update_section(
    section_id: uuid.UUID,
    payload: SectionUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> SectionOut:
    s = await _get(db, ctx, section_id)
    if s.deleted_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This section has been deleted. Restore it first.")
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if getattr(s, k) != v}
    if "class_id" in changes:
        await get_class(db, ctx, changes["class_id"])  # must belong to this school
    if changes:
        before = {k: str(getattr(s, k)) for k in changes}
        for k, v in changes.items():
            setattr(s, k, v)
        action = "section.updated"
        if set(changes) == {"is_active"}:
            action = "section.activated" if changes["is_active"] else "section.deactivated"
        elif "class_id" in changes:
            action = "section.moved"
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action=action,
                entity_type="section",
                entity_id=str(s.id),
                school_id=ctx.school_id,
                metadata={"before": before, "after": {k: str(v) for k, v in changes.items()}},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _one(db, ctx, s.id)


@router.delete("/{section_id}", response_model=SectionOut)
async def delete_section(
    section_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SectionOut:
    """Soft delete. Refused (by the database too) while the section has students."""
    s = await _get(db, ctx, section_id)
    if s.deleted_at is None:
        s.deleted_at, s.deleted_by = datetime.now(UTC), user.id
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="section.deleted",
                entity_type="section",
                entity_id=str(s.id),
                school_id=ctx.school_id,
                metadata={"name": s.name},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _one(db, ctx, s.id)


@router.post("/{section_id}/restore", response_model=SectionOut)
async def restore_section(
    section_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> SectionOut:
    s = await _get(db, ctx, section_id)
    if s.deleted_at is not None:
        s.deleted_at, s.deleted_by, s.is_active = None, None, True
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="section.restored",
                entity_type="section",
                entity_id=str(s.id),
                school_id=ctx.school_id,
                metadata={"name": s.name},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(
                db,
                exc,
                {"sections_session_class_name_key": f"Another section {s.name} now exists here. Rename one first."},
            ) from None
    return await _one(db, ctx, s.id)
