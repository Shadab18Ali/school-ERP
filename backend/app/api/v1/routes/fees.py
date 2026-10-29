"""Fee heads and fee structures for the active school.

Every total, yearly amount and month-by-month schedule returned here is computed
by SQL functions (private.fee_structure_totals / fee_item_breakdown /
fee_structure_schedule) from the session's real dates. Python never sums money.
"""

import uuid
from collections import OrderedDict
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy import bindparam, func, select, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.models.academic import AcademicSession, SchoolClass
from app.models.fees import FeeHead, FeeStructure, FeeStructureItem
from app.schemas.fees import (
    CopyResult,
    FeeHeadBulk,
    FeeHeadCreate,
    FeeHeadOut,
    FeeHeadUpdate,
    FeeItemCreate,
    FeeItemOut,
    FeeItemUpdate,
    FeeStructureCopy,
    FeeStructureCreate,
    FeeStructureDetail,
    FeeStructureSummary,
    FeeStructureUpdate,
    ScheduleLine,
    ScheduleMonth,
    Totals,
)
from app.schemas.session import CurrentSessionOut
from app.services.academics import resolve_session
from app.services.audit import write_audit

VIEW = Depends(require_permission(Permission.FEE_STRUCTURES_VIEW))
MANAGE = Depends(require_permission(Permission.FEE_STRUCTURES_MANAGE))

heads_router = APIRouter(prefix="/fee-heads", tags=["fees"])
router = APIRouter(prefix="/fee-structures", tags=["fees"])

HEAD_UNIQUE = {"fee_heads_school_name_key": "A fee head with this name already exists."}
ITEM_UNIQUE = {"fee_items_one_per_head": "This fee head is already in the structure. Edit that line instead."}
STRUCTURE_UNIQUE = {"fee_structures_one_per_class": "This class already has a fee structure for that session."}

_TOTALS = text(
    "select fee_structure_id, item_count, annual_compulsory, annual_optional, monthly_compulsory, one_time_compulsory "
    "from private.fee_structure_totals(:ids)"
).bindparams(bindparam("ids", type_=ARRAY(UUID(as_uuid=True))))


# ======================================================================= heads
@heads_router.get("", response_model=list[FeeHeadOut])
async def list_heads(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> list[FeeHeadOut]:
    used = (
        select(func.count(func.distinct(FeeStructureItem.fee_structure_id)))
        .where(FeeStructureItem.fee_head_id == FeeHead.id)
        .correlate(FeeHead)
        .scalar_subquery()
    )
    # transport fare zones' heads are charged through Transport, not class fee structures
    zone_heads = text("id not in (select fee_head_id from public.transport_fare_zones)")
    rows = await db.execute(
        select(FeeHead, used).where(FeeHead.school_id == ctx.school_id, zone_heads).order_by(func.lower(FeeHead.name))
    )
    return [
        FeeHeadOut(id=h.id, name=h.name, description=h.description, is_active=h.is_active, used_in=n or 0)
        for h, n in rows.all()
    ]


@heads_router.post("", response_model=FeeHeadOut, status_code=status.HTTP_201_CREATED)
async def create_head(
    payload: FeeHeadCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FeeHeadOut:
    h = FeeHead(school_id=ctx.school_id, created_by=user.id, **payload.model_dump())
    db.add(h)
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="fee_head.created",
            entity_type="fee_head",
            entity_id=str(h.id),
            school_id=ctx.school_id,
            metadata={"name": h.name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, HEAD_UNIQUE) from None
    return FeeHeadOut(id=h.id, name=h.name, description=h.description, is_active=True, used_in=0)


@heads_router.post("/bulk", status_code=status.HTTP_201_CREATED)
async def bulk_heads(
    payload: FeeHeadBulk,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, object]:
    """Adds common fee heads; names that already exist are skipped."""
    existing = {
        n.casefold() for n in (await db.scalars(select(FeeHead.name).where(FeeHead.school_id == ctx.school_id))).all()
    }
    created = [n for n in payload.names if n.casefold() not in existing]
    for n in created:
        db.add(FeeHead(school_id=ctx.school_id, name=n, created_by=user.id))
    try:
        await db.flush()
        if created:
            await write_audit(
                db,
                request,
                action="fee_head.bulk_created",
                entity_type="fee_head",
                school_id=ctx.school_id,
                metadata={"names": created},
            )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, HEAD_UNIQUE) from None
    return {"created": len(created), "skipped": [n for n in payload.names if n not in created]}


@heads_router.patch("/{head_id}", response_model=FeeHeadOut)
async def update_head(
    head_id: uuid.UUID,
    payload: FeeHeadUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> FeeHeadOut:
    h = await db.scalar(select(FeeHead).where(FeeHead.id == head_id, FeeHead.school_id == ctx.school_id))
    if h is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fee head not found.")
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if getattr(h, k) != v}
    if changes:
        for k, v in changes.items():
            setattr(h, k, v)
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="fee_head.updated",
                entity_type="fee_head",
                entity_id=str(h.id),
                school_id=ctx.school_id,
                metadata={"changes": changes},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, HEAD_UNIQUE) from None
    used = await db.scalar(
        select(func.count(func.distinct(FeeStructureItem.fee_structure_id))).where(FeeStructureItem.fee_head_id == h.id)
    )
    return FeeHeadOut(id=h.id, name=h.name, description=h.description, is_active=h.is_active, used_in=used or 0)


# ================================================================= structures
class FeeStructureList(BaseModel):
    session: CurrentSessionOut | None
    session_archived: bool
    items: list[FeeStructureSummary]
    classes_without_structure: list[CurrentSessionOut]  # {id, name} of active classes not yet covered


async def _totals(db: AsyncSession, ids: list[uuid.UUID]) -> dict[uuid.UUID, Totals]:
    if not ids:
        return {}
    rows = (await db.execute(_TOTALS, {"ids": ids})).all()
    return {
        r[0]: Totals(
            item_count=r[1],
            annual_compulsory=r[2],
            annual_optional=r[3],
            monthly_compulsory=r[4],
            one_time_compulsory=r[5],
        )
        for r in rows
    }


def _summary_query(ctx: SchoolContext):
    return (
        select(FeeStructure, AcademicSession.name, AcademicSession.archived_at, SchoolClass.name)
        .join(AcademicSession, AcademicSession.id == FeeStructure.academic_session_id)
        .join(SchoolClass, SchoolClass.id == FeeStructure.class_id)
        .where(FeeStructure.school_id == ctx.school_id)
    )


def _summary(fs: FeeStructure, sname: str, sarch, cname: str, totals: Totals) -> FeeStructureSummary:
    return FeeStructureSummary(
        id=fs.id,
        academic_session_id=fs.academic_session_id,
        session_name=sname,
        session_is_archived=sarch is not None,
        class_id=fs.class_id,
        class_name=cname,
        name=fs.name,
        is_active=fs.is_active,
        copied_from_id=fs.copied_from_id,
        totals=totals,
    )


async def _get_structure(db: AsyncSession, ctx: SchoolContext, structure_id: uuid.UUID) -> FeeStructure:
    fs = await db.scalar(
        select(FeeStructure).where(FeeStructure.id == structure_id, FeeStructure.school_id == ctx.school_id)
    )
    if fs is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fee structure not found.")
    return fs


async def _detail(db: AsyncSession, ctx: SchoolContext, structure_id: uuid.UUID) -> FeeStructureDetail:
    row = (await db.execute(_summary_query(ctx).where(FeeStructure.id == structure_id))).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fee structure not found.")
    fs, sname, sarch, cname = row
    totals = (await _totals(db, [fs.id]))[fs.id]

    breakdown = {
        r[0]: r[1:]
        for r in (
            await db.execute(
                text("select fee_item_id, occurrences, annual_amount, due_months from private.fee_item_breakdown(:id)"),
                {"id": fs.id},
            )
        ).all()
    }
    item_rows = (
        await db.execute(
            select(FeeStructureItem, FeeHead.name)
            .join(FeeHead, FeeHead.id == FeeStructureItem.fee_head_id)
            .where(FeeStructureItem.fee_structure_id == fs.id)
            .order_by(FeeStructureItem.sort_order, FeeStructureItem.is_optional, func.lower(FeeHead.name))
        )
    ).all()
    items = [
        FeeItemOut(
            id=i.id,
            fee_head_id=i.fee_head_id,
            fee_head_name=hname,
            amount=i.amount,
            frequency=i.frequency,
            is_optional=i.is_optional,
            billing_months=i.billing_months,
            due_month=i.due_month,
            sort_order=i.sort_order,
            occurrences=breakdown.get(i.id, (0, Decimal("0"), []))[0],
            annual_amount=breakdown.get(i.id, (0, Decimal("0"), []))[1],
            due_months=list(breakdown.get(i.id, (0, Decimal("0"), []))[2] or []),
        )
        for i, hname in item_rows
    ]

    # Month-by-month view: lines from the schedule function, month sums from SQL too.
    sched = (
        await db.execute(
            text(
                "select due_month, fee_item_id, fee_head_name, amount, is_optional, "
                "sum(amount) filter (where not is_optional) over (partition by due_month), "
                "sum(amount) filter (where is_optional) over (partition by due_month) "
                "from private.fee_structure_schedule(:id) order by due_month, is_optional, fee_head_name"
            ),
            {"id": fs.id},
        )
    ).all()
    months: OrderedDict = OrderedDict()
    for month, item_id, hname, amount, optional, comp_sum, opt_sum in sched:
        m = months.setdefault(
            month,
            ScheduleMonth(month=month, compulsory=comp_sum or Decimal("0"), optional=opt_sum or Decimal("0"), lines=[]),
        )
        m.lines.append(ScheduleLine(fee_item_id=item_id, fee_head_name=hname, amount=amount, is_optional=optional))

    base = _summary(fs, sname, sarch, cname, totals)
    return FeeStructureDetail(**base.model_dump(), notes=fs.notes, items=items, schedule=list(months.values()))


@router.get("", response_model=FeeStructureList)
async def list_structures(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = Query(default=None, description="Defaults to the current session"),
) -> FeeStructureList:
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return FeeStructureList(session=None, session_archived=False, items=[], classes_without_structure=[])
    rows = (
        await db.execute(
            _summary_query(ctx)
            .where(FeeStructure.academic_session_id == session.id)
            .order_by(SchoolClass.display_order, func.lower(SchoolClass.name))
        )
    ).all()
    totals = await _totals(db, [r[0].id for r in rows])
    covered = {r[0].class_id for r in rows}
    missing = (
        await db.execute(
            select(SchoolClass.id, SchoolClass.name)
            .where(
                SchoolClass.school_id == ctx.school_id,
                SchoolClass.deleted_at.is_(None),
                SchoolClass.is_active.is_(True),
            )
            .order_by(SchoolClass.display_order, func.lower(SchoolClass.name))
        )
    ).all()
    return FeeStructureList(
        session=CurrentSessionOut(id=session.id, name=session.name),
        session_archived=session.archived_at is not None,
        items=[_summary(*r, totals[r[0].id]) for r in rows],
        classes_without_structure=[CurrentSessionOut(id=i, name=n) for i, n in missing if i not in covered],
    )


@router.get("/{structure_id}", response_model=FeeStructureDetail)
async def get_structure(
    structure_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> FeeStructureDetail:
    return await _detail(db, ctx, structure_id)


async def _check_target(db: AsyncSession, ctx: SchoolContext, session_id: uuid.UUID, class_id: uuid.UUID):
    session = await db.scalar(
        select(AcademicSession).where(AcademicSession.id == session_id, AcademicSession.school_id == ctx.school_id)
    )
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Academic session not found.")
    cls = await db.scalar(select(SchoolClass).where(SchoolClass.id == class_id, SchoolClass.school_id == ctx.school_id))
    if cls is None or cls.deleted_at is not None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Class not found.")
    return session, cls


@router.post("", response_model=FeeStructureDetail, status_code=status.HTTP_201_CREATED)
async def create_structure(
    payload: FeeStructureCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FeeStructureDetail:
    session, cls = await _check_target(db, ctx, payload.academic_session_id, payload.class_id)
    fs = FeeStructure(school_id=ctx.school_id, created_by=user.id, **payload.model_dump())
    db.add(fs)
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="fee_structure.created",
            entity_type="fee_structure",
            entity_id=str(fs.id),
            school_id=ctx.school_id,
            metadata={"session": session.name, "class": cls.name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, STRUCTURE_UNIQUE) from None
    return await _detail(db, ctx, fs.id)


@router.patch("/{structure_id}", response_model=FeeStructureDetail)
async def update_structure(
    structure_id: uuid.UUID,
    payload: FeeStructureUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> FeeStructureDetail:
    fs = await _get_structure(db, ctx, structure_id)
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if getattr(fs, k) != v}
    if changes:
        for k, v in changes.items():
            setattr(fs, k, v)
        action = "fee_structure.updated"
        if set(changes) == {"is_active"}:
            action = "fee_structure.activated" if changes["is_active"] else "fee_structure.deactivated"
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action=action,
                entity_type="fee_structure",
                entity_id=str(fs.id),
                school_id=ctx.school_id,
                metadata={"changes": changes},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, STRUCTURE_UNIQUE) from None
    return await _detail(db, ctx, fs.id)


@router.delete("/{structure_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_structure(
    structure_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> None:
    """Only an empty structure (created by mistake) can be deleted; otherwise deactivate it."""
    fs = await _get_structure(db, ctx, structure_id)
    n = await db.scalar(
        select(func.count()).select_from(FeeStructureItem).where(FeeStructureItem.fee_structure_id == fs.id)
    )
    if n:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This structure has fee items. Deactivate it instead of deleting."
        )
    try:
        await db.delete(fs)
        await db.flush()
        await write_audit(
            db,
            request,
            action="fee_structure.deleted",
            entity_type="fee_structure",
            entity_id=str(structure_id),
            school_id=ctx.school_id,
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None


# ---------------------------------------------------------------- items
async def _check_item(
    db: AsyncSession, ctx: SchoolContext, fs: FeeStructure, head_id: uuid.UUID | None, due_month: int | None
) -> None:
    if head_id is not None:
        head = await db.scalar(select(FeeHead).where(FeeHead.id == head_id, FeeHead.school_id == ctx.school_id))
        if head is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Fee head not found.")
        if not head.is_active:
            raise HTTPException(status.HTTP_409_CONFLICT, f"{head.name} is inactive. Activate it first.")
    if due_month is not None:
        in_session = await db.scalar(
            text(
                "select exists (select 1 from public.academic_sessions s, "
                "generate_series(date_trunc('month', s.start_date), date_trunc('month', s.end_date), "
                "interval '1 month') m "
                "where s.id = :sid and extract(month from m) = :mn)"
            ),
            {"sid": fs.academic_session_id, "mn": due_month},
        )
        if not in_session:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That due month isn't part of this session.")


@router.post("/{structure_id}/items", response_model=FeeStructureDetail, status_code=status.HTTP_201_CREATED)
async def add_item(
    structure_id: uuid.UUID,
    payload: FeeItemCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> FeeStructureDetail:
    fs = await _get_structure(db, ctx, structure_id)
    await _check_item(db, ctx, fs, payload.fee_head_id, payload.due_month)
    next_order = await db.scalar(
        select(func.coalesce(func.max(FeeStructureItem.sort_order), -1) + 1).where(
            FeeStructureItem.fee_structure_id == fs.id
        )
    )
    item = FeeStructureItem(
        school_id=ctx.school_id, fee_structure_id=fs.id, sort_order=min(next_order or 0, 999), **payload.model_dump()
    )
    db.add(item)
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="fee_item.added",
            entity_type="fee_structure",
            entity_id=str(fs.id),
            school_id=ctx.school_id,
            metadata={"fee_head_id": str(item.fee_head_id), "amount": str(item.amount), "frequency": item.frequency},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, ITEM_UNIQUE) from None
    return await _detail(db, ctx, fs.id)


@router.patch("/{structure_id}/items/{item_id}", response_model=FeeStructureDetail)
async def update_item(
    structure_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: FeeItemUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> FeeStructureDetail:
    fs = await _get_structure(db, ctx, structure_id)
    item = await db.scalar(
        select(FeeStructureItem).where(FeeStructureItem.id == item_id, FeeStructureItem.fee_structure_id == fs.id)
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fee item not found.")
    data = payload.model_dump(exclude_unset=True)
    # switching frequency clears settings that no longer apply
    if "frequency" in data:
        if data["frequency"] != "monthly":
            data.setdefault("billing_months", None)
            if data.get("billing_months"):
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, "Months can only be chosen for monthly fees."
                )
        else:
            data.setdefault("due_month", None)
    freq = data.get("frequency", item.frequency)
    if freq != "monthly" and data.get("billing_months"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Months can only be chosen for monthly fees.")
    if freq == "monthly" and data.get("due_month"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Monthly fees don't have a due month.")
    changes = {k: v for k, v in data.items() if getattr(item, k) != v}
    if "fee_head_id" in changes or "due_month" in changes:
        await _check_item(db, ctx, fs, changes.get("fee_head_id"), changes.get("due_month"))
    if changes:
        before = {k: str(getattr(item, k)) for k in changes}
        for k, v in changes.items():
            setattr(item, k, v)
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="fee_item.updated",
                entity_type="fee_structure",
                entity_id=str(fs.id),
                school_id=ctx.school_id,
                metadata={"item_id": str(item.id), "before": before, "after": {k: str(v) for k, v in changes.items()}},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, ITEM_UNIQUE) from None
    return await _detail(db, ctx, fs.id)


@router.delete("/{structure_id}/items/{item_id}", response_model=FeeStructureDetail)
async def remove_item(
    structure_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> FeeStructureDetail:
    fs = await _get_structure(db, ctx, structure_id)
    item = await db.scalar(
        select(FeeStructureItem).where(FeeStructureItem.id == item_id, FeeStructureItem.fee_structure_id == fs.id)
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fee item not found.")
    meta = {"item_id": str(item.id), "fee_head_id": str(item.fee_head_id), "amount": str(item.amount)}
    try:
        await db.delete(item)
        await db.flush()
        await write_audit(
            db,
            request,
            action="fee_item.removed",
            entity_type="fee_structure",
            entity_id=str(fs.id),
            school_id=ctx.school_id,
            metadata=meta,
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _detail(db, ctx, fs.id)


# ---------------------------------------------------------------- copy
@router.post("/{structure_id}/copy", response_model=CopyResult, status_code=status.HTTP_201_CREATED)
async def copy_structure(
    structure_id: uuid.UUID,
    payload: FeeStructureCopy,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> CopyResult:
    """Copy to other classes and/or sessions, optionally changing amounts by a %.
    The arithmetic (percentage + rounding) happens in private.copy_fee_structure."""
    src = await _get_structure(db, ctx, structure_id)
    created: list[uuid.UUID] = []
    skipped: list[str] = []
    seen: set[tuple[uuid.UUID, uuid.UUID]] = set()
    try:
        for t in payload.targets:
            key = (t.academic_session_id, t.class_id)
            if key in seen:
                continue
            seen.add(key)
            session, cls = await _check_target(db, ctx, t.academic_session_id, t.class_id)
            exists = await db.scalar(
                select(FeeStructure.id).where(
                    FeeStructure.academic_session_id == session.id, FeeStructure.class_id == cls.id
                )
            )
            if exists:
                skipped.append(f"{cls.name} · {session.name}")
                continue
            new_id = await db.scalar(
                text("select private.copy_fee_structure(:src, :sid, :cid, :pct, :rnd)"),
                {
                    "src": src.id,
                    "sid": session.id,
                    "cid": cls.id,
                    "pct": payload.increase_percent,
                    "rnd": payload.round_to,
                },
            )
            created.append(new_id)
        if created:
            await write_audit(
                db,
                request,
                action="fee_structure.copied",
                entity_type="fee_structure",
                entity_id=str(src.id),
                school_id=ctx.school_id,
                metadata={
                    "created": [str(c) for c in created],
                    "increase_percent": str(payload.increase_percent),
                    "round_to": str(payload.round_to),
                },
            )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, STRUCTURE_UNIQUE) from None
    return CopyResult(created=created, skipped=skipped)
