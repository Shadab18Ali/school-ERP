"""Classes of the active school. Soft deletion only; sections are per session."""

import uuid
from collections import defaultdict
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.models.academic import SchoolClass, Section
from app.schemas.classes import (
    BulkResult,
    ClassBulkCreate,
    ClassCreate,
    ClassList,
    ClassOut,
    ClassUpdate,
    RecordStatus,
    SectionBrief,
)
from app.schemas.session import CurrentSessionOut
from app.services.academics import get_class, resolve_session, student_counts
from app.services.audit import write_audit

router = APIRouter(prefix="/classes", tags=["classes"])
VIEW = Depends(require_permission(Permission.CLASSES_VIEW))
MANAGE = Depends(require_permission(Permission.CLASSES_MANAGE))
UNIQUE = {"classes_school_name_key": "A class with this name already exists."}


def _like(term: str) -> str:
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _status_filter(q, st: RecordStatus | None):
    if st == "deleted":
        return q.where(SchoolClass.deleted_at.is_not(None))
    q = q.where(SchoolClass.deleted_at.is_(None))
    if st == "active":
        q = q.where(SchoolClass.is_active.is_(True))
    elif st == "inactive":
        q = q.where(SchoolClass.is_active.is_(False))
    return q


async def _build(db: AsyncSession, ctx: SchoolContext, classes: list[SchoolClass], session_id) -> list[ClassOut]:
    by_class: dict[uuid.UUID, list[Section]] = defaultdict(list)
    if session_id and classes:
        rows = await db.scalars(
            select(Section)
            .where(
                Section.school_id == ctx.school_id,
                Section.academic_session_id == session_id,
                Section.class_id.in_([c.id for c in classes]),
                Section.deleted_at.is_(None),
            )
            .order_by(func.lower(Section.name))
        )
        for s in rows.all():
            by_class[s.class_id].append(s)
    counts = await student_counts(db, [s.id for secs in by_class.values() for s in secs])

    out: list[ClassOut] = []
    for c in classes:
        secs = by_class.get(c.id, [])
        caps = [s.capacity for s in secs]
        out.append(
            ClassOut(
                id=c.id,
                name=c.name,
                display_order=c.display_order,
                is_active=c.is_active,
                is_deleted=c.deleted_at is not None,
                deleted_at=c.deleted_at,
                created_at=c.created_at,
                sections=[
                    SectionBrief(
                        id=s.id,
                        name=s.name,
                        is_active=s.is_active,
                        capacity=s.capacity,
                        student_count=counts.get(s.id, 0),
                    )
                    for s in secs
                ],
                student_count=sum(counts.get(s.id, 0) for s in secs),
                capacity_total=sum(caps) if caps and all(x is not None for x in caps) else None,  # type: ignore[arg-type]
            )
        )
    return out


async def _one(db: AsyncSession, ctx: SchoolContext, c: SchoolClass) -> ClassOut:
    session = await resolve_session(db, ctx, None)
    return (await _build(db, ctx, [c], session.id if session else None))[0]


@router.get("", response_model=ClassList)
async def list_classes(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = Query(default=None, description="Defaults to the current session"),
    search: str | None = Query(default=None, max_length=50),
    status_filter: RecordStatus | None = Query(default=None, alias="status"),
) -> ClassList:
    session = await resolve_session(db, ctx, session_id)
    q = _status_filter(select(SchoolClass).where(SchoolClass.school_id == ctx.school_id), status_filter)
    if search and search.strip():
        q = q.where(SchoolClass.name.ilike(_like(search.strip()), escape="\\"))
    classes = list((await db.scalars(q.order_by(SchoolClass.display_order, func.lower(SchoolClass.name)))).all())
    items = await _build(db, ctx, classes, session.id if session else None)
    return ClassList(
        session=CurrentSessionOut(id=session.id, name=session.name) if session else None,
        session_archived=bool(session and session.archived_at),
        items=items,
        total_students=sum(i.student_count for i in items),
    )


@router.post("", response_model=ClassOut, status_code=status.HTTP_201_CREATED)
async def create_class(
    payload: ClassCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ClassOut:
    order = payload.display_order
    if order is None:
        current_max = await db.scalar(
            select(func.max(SchoolClass.display_order)).where(
                SchoolClass.school_id == ctx.school_id, SchoolClass.deleted_at.is_(None)
            )
        )
        order = min((current_max or 0) + 1, 999)
    c = SchoolClass(school_id=ctx.school_id, name=payload.name, display_order=order, created_by=user.id)
    db.add(c)
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="class.created",
            entity_type="class",
            entity_id=str(c.id),
            school_id=ctx.school_id,
            metadata={"name": c.name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    await db.refresh(c)
    return await _one(db, ctx, c)


@router.post("/bulk", response_model=BulkResult, status_code=status.HTTP_201_CREATED)
async def bulk_create_classes(
    payload: ClassBulkCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BulkResult:
    """Adds standard classes (e.g. Nursery to Class 12). Existing names are skipped."""
    existing = {
        n.casefold()
        for n in (
            await db.scalars(
                select(SchoolClass.name).where(SchoolClass.school_id == ctx.school_id, SchoolClass.deleted_at.is_(None))
            )
        ).all()
    }
    created, skipped = [], []
    for item in payload.classes:
        if item.name.casefold() in existing:
            skipped.append(item.name)
            continue
        existing.add(item.name.casefold())
        db.add(
            SchoolClass(school_id=ctx.school_id, name=item.name, display_order=item.display_order, created_by=user.id)
        )
        created.append(item.name)
    try:
        await db.flush()
        if created:
            await write_audit(
                db,
                request,
                action="class.bulk_created",
                entity_type="class",
                school_id=ctx.school_id,
                metadata={"names": created},
            )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return BulkResult(created=len(created), skipped=skipped)


@router.patch("/{class_id}", response_model=ClassOut)
async def update_class(
    class_id: uuid.UUID,
    payload: ClassUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> ClassOut:
    c = await get_class(db, ctx, class_id)
    if c.deleted_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This class has been deleted. Restore it first.")
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if getattr(c, k) != v}
    if changes:
        before = {k: getattr(c, k) for k in changes}
        for k, v in changes.items():
            setattr(c, k, v)
        action = "class.updated"
        if set(changes) == {"is_active"}:
            action = "class.activated" if changes["is_active"] else "class.deactivated"
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action=action,
                entity_type="class",
                entity_id=str(c.id),
                school_id=ctx.school_id,
                metadata={"before": before, "after": changes},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
        await db.refresh(c)
    return await _one(db, ctx, c)


@router.delete("/{class_id}", response_model=ClassOut)
async def delete_class(
    class_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ClassOut:
    """Soft delete: hidden from lists, kept for history, restorable."""
    c = await get_class(db, ctx, class_id)
    if c.deleted_at is None:
        c.deleted_at, c.deleted_by = datetime.now(UTC), user.id
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="class.deleted",
                entity_type="class",
                entity_id=str(c.id),
                school_id=ctx.school_id,
                metadata={"name": c.name},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
        await db.refresh(c)
    return await _one(db, ctx, c)


@router.post("/{class_id}/restore", response_model=ClassOut)
async def restore_class(
    class_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> ClassOut:
    c = await get_class(db, ctx, class_id)
    if c.deleted_at is not None:
        c.deleted_at, c.deleted_by, c.is_active = None, None, True
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="class.restored",
                entity_type="class",
                entity_id=str(c.id),
                school_id=ctx.school_id,
                metadata={"name": c.name},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(
                db, exc, {"classes_school_name_key": f"Another class is already called {c.name}. Rename it first."}
            ) from None
        await db.refresh(c)
    return await _one(db, ctx, c)
