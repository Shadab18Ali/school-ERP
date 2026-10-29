"""School inventory: items by category (computer, furniture, laboratory, sports, stationery,
electronics, other) with quantity, purchase date and cost, location, condition and the staff
member responsible, plus each item's stock in / out history.

Rules live in the database (migration 0024): quantity changes only through
private.inventory_move (no taking out more than is in stock, no future dates, whole numbers
for counted units, archived items frozen), item codes are assigned there, changes of
location / condition / assignee are logged by a trigger, and the history is append-only.
"""

import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, get_school_context, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db, pg_error
from app.services.audit import write_audit
from app.services.exports import to_csv

router = APIRouter(prefix="/inventory", tags=["inventory"])
VIEW = Depends(require_permission(Permission.INVENTORY_VIEW))
MANAGE = Depends(require_permission(Permission.INVENTORY_MANAGE))

Category = Literal["computer", "furniture", "laboratory", "sports", "stationery", "electronics", "other"]
CATEGORIES: tuple[str, ...] = Category.__args__  # type: ignore[attr-defined]
Unit = Literal["piece", "set", "pair", "box", "pack", "ream", "dozen", "kg", "litre", "metre", "roll", "bottle"]
Condition = Literal["new", "good", "fair", "needs_repair", "damaged", "unusable"]
IN_REASONS = ("opening", "purchase", "donation", "returned", "found", "adjustment")
OUT_REASONS = ("issued", "consumed", "damaged", "lost", "disposed", "returned_to_vendor", "adjustment")
MEASURED = ("kg", "litre", "metre")  # units that may be fractions; the rest are counted
PLURAL = {"box": "boxes", "dozen": "dozen", "kg": "kg"}


def plural(unit: str) -> str:
    return PLURAL.get(unit, unit + "s")


CATEGORY_LABEL = {
    "computer": "Computer",
    "furniture": "Furniture",
    "laboratory": "Laboratory",
    "sports": "Sports",
    "stationery": "Stationery",
    "electronics": "Electronics",
    "other": "Other",
}
REASON_LABEL = {
    "opening": "Opening stock",
    "purchase": "Purchase",
    "donation": "Donation",
    "returned": "Returned",
    "found": "Found",
    "adjustment": "Adjustment",
    "issued": "Issued",
    "consumed": "Used up",
    "damaged": "Damaged",
    "lost": "Lost",
    "disposed": "Disposed of",
    "returned_to_vendor": "Returned to vendor",
    "details": "Details changed",
}
MAX_QTY = Decimal("1000000000")
IST = ZoneInfo("Asia/Kolkata")


def today() -> date:
    """The school's today (India), as the database counts it."""
    return datetime.now(IST).date()


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = re.sub(r"\s+", " ", v).strip()
        return v or None
    return v


def _qty(v: Decimal | None, unit: str | None = None, *, label: str = "quantity") -> Decimal | None:
    if v is None:
        return None
    if v.as_tuple().exponent < -2:  # type: ignore[operator]
        raise ValueError(f"Enter the {label} with at most 2 decimal places.")
    if unit and unit not in MEASURED and v != v.to_integral_value():
        raise ValueError(f"Enter a whole number for the {label} (counted in {plural(unit)}).")
    return v


async def _call(db: AsyncSession, sql: str, params: dict[str, Any]) -> Any:
    try:
        return await db.execute(text(sql), params)
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None


def _json(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, uuid.UUID):
            v = str(v)
        elif isinstance(v, datetime | date):
            v = v.isoformat()
        elif isinstance(v, Decimal):
            v = f"{v:.2f}"
        out[k] = v
    return out


def _rows(result: Any) -> list[dict]:
    return [_json(dict(r)) for r in result.mappings()]


# ------------------------------------------------------------------ inputs
class OpeningIn(BaseModel):
    """Stock the item arrives with (optional)."""

    model_config = {"extra": "forbid"}
    quantity: Decimal = Field(gt=0, le=MAX_QTY)
    reason: Literal["opening", "purchase", "donation"] = "opening"
    moved_on: date
    unit_cost: Decimal | None = Field(default=None, ge=0, le=Decimal("100000000"), decimal_places=2)
    vendor: str | None = Field(default=None, max_length=120)
    reference: str | None = Field(default=None, max_length=60)
    _c = field_validator("vendor", "reference", mode="before")(classmethod(lambda cls, v: _clean(v)))


class ItemIn(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=2, max_length=150)
    category: Category
    unit: Unit = "piece"
    brand_model: str | None = Field(default=None, max_length=120)
    serial_number: str | None = Field(default=None, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    min_quantity: Decimal | None = Field(default=None, ge=0, le=MAX_QTY)
    unit_cost: Decimal | None = Field(default=None, ge=0, le=Decimal("100000000"), decimal_places=2)
    purchase_date: date | None = None
    vendor: str | None = Field(default=None, max_length=120)
    location: str = Field(min_length=1, max_length=100)
    condition: Condition = "good"
    assigned_teacher_id: uuid.UUID | None = None
    notes: str | None = Field(default=None, max_length=500)
    is_active: bool = True
    opening: OpeningIn | None = None  # new items only

    _c = field_validator(
        "name", "brand_model", "serial_number", "description", "vendor", "location", "notes", mode="before"
    )(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _check(self) -> "ItemIn":
        self.min_quantity = _qty(self.min_quantity, self.unit, label="reorder level")
        if self.opening:
            self.opening.quantity = _qty(self.opening.quantity, self.unit)  # type: ignore[assignment]
            if self.opening.moved_on > today():
                raise ValueError("The stock date can't be in the future.")
        if self.purchase_date and self.purchase_date > today():
            raise ValueError("The purchase date can't be in the future.")
        return self

    def fields(self) -> dict[str, Any]:
        return self.model_dump(exclude={"opening", "is_active"})


class StockIn(BaseModel):
    model_config = {"extra": "forbid"}
    kind: Literal["in", "out"]
    reason: str
    quantity: Decimal = Field(gt=0, le=MAX_QTY)
    moved_on: date
    unit_cost: Decimal | None = Field(default=None, ge=0, le=Decimal("100000000"), decimal_places=2)
    vendor: str | None = Field(default=None, max_length=120)
    reference: str | None = Field(default=None, max_length=60)
    teacher_id: uuid.UUID | None = None
    recipient: str | None = Field(default=None, max_length=120)
    note: str | None = Field(default=None, max_length=300)
    _c = field_validator("vendor", "reference", "recipient", "note", mode="before")(
        classmethod(lambda cls, v: _clean(v))
    )

    @model_validator(mode="after")
    def _check(self) -> "StockIn":
        if self.reason not in (IN_REASONS if self.kind == "in" else OUT_REASONS):
            raise ValueError("Choose a reason for the stock " + ("coming in." if self.kind == "in" else "going out."))
        _qty(self.quantity)
        if self.kind == "out":
            self.unit_cost = None
            self.vendor = None
        if self.kind == "out" and self.reason == "issued" and not (self.teacher_id or self.recipient):
            raise ValueError("Say who the items were issued to: a staff member, or a class, room or event.")
        return self


# ------------------------------------------------------------------ dashboard
@router.get("/dashboard")
async def dashboard(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    d = (await _call(db, "select private.inventory_dashboard(:s)", {"s": ctx.school_id})).scalar()
    for k in ("value", "month_spent", "year_spent"):
        d[k] = f"{Decimal(str(d[k])):.2f}"
    for c in d["by_category"]:
        c["value"] = f"{Decimal(str(c['value'])):.2f}"
        c["quantity"] = f"{Decimal(str(c['quantity'])):.2f}"
    for x in (*d["low_stock_items"], *d["attention_items"]):
        for k in ("quantity", "min_quantity"):
            if x.get(k) is not None:
                x[k] = f"{Decimal(str(x[k])):.2f}"
    d["recent"] = (await _movements(db, ctx, page_size=8))["items"]
    return d


# ------------------------------------------------------------------ items
ITEM_SELECT = """
select i.id, i.item_code, i.name, i.category, i.unit, i.brand_model, i.serial_number, i.description, i.quantity,
       i.min_quantity, i.unit_cost, i.purchase_date, i.vendor, i.location, i.condition, i.assigned_teacher_id,
       t.full_name as assigned_to, t.employee_id as assigned_employee_id, i.is_active, i.notes, i.created_at,
       i.updated_at,
       case when i.unit_cost is null then null else round(i.quantity * i.unit_cost, 2) end as value,
       (i.min_quantity is not null and i.quantity <= i.min_quantity) as is_low
from public.inventory_items i
left join public.teachers t on t.id = i.assigned_teacher_id
"""
ItemState = Literal["active", "archived", "low", "attention", "assigned", "all"]
ITEM_CSV = [
    ("item_code", "Code", "text"),
    ("name", "Item", "text"),
    ("category_label", "Category", "text"),
    ("brand_model", "Brand / model", "text"),
    ("serial_number", "Serial no.", "text"),
    ("quantity", "Quantity", "text"),
    ("unit", "Unit", "text"),
    ("min_quantity", "Reorder level", "text"),
    ("unit_cost", "Unit cost", "money"),
    ("value", "Value", "money"),
    ("purchase_date", "Purchase date", "text"),
    ("vendor", "Vendor", "text"),
    ("location", "Location", "text"),
    ("condition", "Condition", "text"),
    ("assigned_to", "Assigned to", "text"),
    ("status", "Status", "text"),
]


def _item_filters(
    ctx: SchoolContext,
    state: str,
    category: str | None,
    condition: str | None,
    location: str | None,
    teacher_id: uuid.UUID | None,
    q: str | None,
) -> tuple[str, dict[str, Any]]:
    where = ["i.school_id = :s"]
    p: dict[str, Any] = {"s": ctx.school_id}
    where.append(
        {
            "active": "i.is_active",
            "archived": "not i.is_active",
            "low": "i.is_active and i.min_quantity is not null and i.quantity <= i.min_quantity",
            "attention": "i.is_active and i.condition in ('needs_repair', 'damaged', 'unusable') and i.quantity > 0",
            "assigned": "i.is_active and i.assigned_teacher_id is not null",
            "all": "true",
        }[state]
    )
    if category:
        where.append("i.category = :cat")
        p["cat"] = category
    if condition:
        where.append("i.condition = :cond")
        p["cond"] = condition
    if location:
        where.append("lower(i.location) = lower(:loc)")
        p["loc"] = location
    if teacher_id:
        where.append("i.assigned_teacher_id = :t")
        p["t"] = teacher_id
    if q and q.strip():
        p["q"] = q.strip().lower()
        where.append(
            "(lower(i.name) like '%' || :q || '%' or lower(i.item_code) = :q "
            "or lower(coalesce(i.serial_number, '')) = :q or lower(coalesce(i.brand_model, '')) like '%' || :q || '%')"
        )
    return " and ".join(where), p


@router.get("/items")
async def items(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    state: ItemState = "active",
    category: Category | None = None,
    condition: Condition | None = None,
    location: str | None = Query(default=None, max_length=100),
    teacher_id: uuid.UUID | None = None,
    q: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=50, ge=1, le=200),
    format: Literal["json", "csv"] = "json",
) -> Any:
    w, p = _item_filters(ctx, state, category, condition, location, teacher_id, q)
    order = "i.category, lower(i.name), i.item_code"
    if format == "csv":
        rows = [dict(r) for r in (await db.execute(text(f"{ITEM_SELECT} where {w} order by {order}"), p)).mappings()]
        for r in rows:
            r["category_label"] = CATEGORY_LABEL[r["category"]]
            r["condition"] = r["condition"].replace("_", " ")
            r["status"] = "In use" if r["is_active"] else "Archived"
            for k in ("quantity", "min_quantity"):
                if r[k] is not None:
                    r[k] = f"{r[k].normalize():f}"
        return Response(
            to_csv(ITEM_CSV, rows),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="inventory-{state}.csv"'},
        )
    total = (await db.execute(text(f"select count(*) from public.inventory_items i where {w}"), p)).scalar_one()
    rows = _rows(
        await db.execute(
            text(f"{ITEM_SELECT} where {w} order by {order} limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    )
    return {"items": rows, "total": total, "page": page, "page_size": page_size}


async def _item(db: AsyncSession, ctx: SchoolContext, item_id: uuid.UUID) -> dict:
    r = (
        (
            await db.execute(
                text(f"{ITEM_SELECT} where i.id = :id and i.school_id = :s"), {"id": item_id, "s": ctx.school_id}
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    return _json(dict(r))


@router.get("/items/{item_id}")
async def item(item_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    return await _item(db, ctx, item_id)


async def _move(db: AsyncSession, item_id: uuid.UUID, m: StockIn | OpeningIn, kind: str) -> uuid.UUID:
    return (
        await _call(
            db,
            "select private.inventory_move(:i, :k, :r, :q, :d, :c, :v, :ref, :t, :rec, :n)",
            {
                "i": item_id,
                "k": kind,
                "r": m.reason,
                "q": m.quantity,
                "d": m.moved_on,
                "c": m.unit_cost,
                "v": m.vendor,
                "ref": m.reference,
                "t": getattr(m, "teacher_id", None),
                "rec": getattr(m, "recipient", None),
                "n": getattr(m, "note", None),
            },
        )
    ).scalar_one()


@router.post("/items", status_code=status.HTTP_201_CREATED)
async def add_item(
    payload: ItemIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    v = payload.fields()
    iid = (
        await _call(
            db,
            f"insert into public.inventory_items (school_id, {', '.join(v)}, created_by) "
            f"values (:school_id, {', '.join(':' + k for k in v)}, :by) returning id",
            {**v, "school_id": ctx.school_id, "by": user.id},
        )
    ).scalar_one()
    if payload.opening:
        await _move(db, iid, payload.opening, "in")
    out = await _item(db, ctx, iid)
    await write_audit(
        db,
        request,
        action="inventory.item_added",
        entity_type="inventory_item",
        entity_id=str(iid),
        school_id=ctx.school_id,
        metadata={"code": out["item_code"], "name": out["name"], "quantity": out["quantity"]},
    )
    await db.commit()
    return out


@router.put("/items/{item_id}")
async def update_item(
    item_id: uuid.UUID,
    payload: ItemIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    if payload.opening:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Record stock with Stock in, not by editing the item."
        )
    v = {**payload.fields(), "is_active": payload.is_active}
    r = await _call(
        db,
        "update public.inventory_items set "
        + ", ".join(f"{k} = :{k}" for k in v)
        + " where id = :id and school_id = :s",
        {**v, "id": item_id, "s": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    await write_audit(
        db,
        request,
        action="inventory.item_changed",
        entity_type="inventory_item",
        entity_id=str(item_id),
        school_id=ctx.school_id,
        metadata={"name": payload.name, "location": payload.location, "condition": payload.condition},
    )
    await db.commit()
    return await _item(db, ctx, item_id)


@router.delete("/items/{item_id}")
async def delete_item(
    item_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    it = await _item(db, ctx, item_id)
    try:
        r = await db.execute(
            text("delete from public.inventory_items where id = :id and school_id = :s"),
            {"id": item_id, "s": ctx.school_id},
        )
    except DBAPIError as exc:
        err = pg_error(exc)
        if err.sqlstate == "23503":
            await db.rollback()
            msg = err.message if err.constraint is None else "This item is still referenced, so it is kept."
            raise HTTPException(status.HTTP_409_CONFLICT, msg) from None
        raise await http_error_from_db(db, exc) from None
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Item not found.")
    await write_audit(
        db,
        request,
        action="inventory.item_deleted",
        entity_type="inventory_item",
        entity_id=str(item_id),
        school_id=ctx.school_id,
        metadata={"code": it["item_code"], "name": it["name"]},
    )
    await db.commit()
    return {"ok": True}


@router.post("/items/{item_id}/stock", status_code=status.HTTP_201_CREATED)
async def stock(
    item_id: uuid.UUID,
    payload: StockIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    it = await _item(db, ctx, item_id)
    try:
        _qty(payload.quantity, it["unit"])  # also checked in the database; this gives the nicer message first
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    mid = await _move(db, item_id, payload, payload.kind)
    await write_audit(
        db,
        request,
        action=f"inventory.stock_{payload.kind}",
        entity_type="inventory_item",
        entity_id=str(item_id),
        school_id=ctx.school_id,
        metadata={"movement_id": str(mid), "reason": payload.reason, "quantity": str(payload.quantity)},
    )
    await db.commit()
    return await _item(db, ctx, item_id)


# ------------------------------------------------------------------ history
MOVE_SELECT = """
select m.id, m.item_id, i.item_code, i.name as item_name, i.category, i.unit, m.kind, m.reason, m.quantity,
       m.balance_after, m.moved_on, m.unit_cost, m.total_cost, m.vendor, m.reference, m.teacher_id,
       t.full_name as teacher_name,
       m.recipient, m.note, m.changes, m.created_at, nullif(p.full_name, '') as recorded_by
from public.inventory_movements m
join public.inventory_items i on i.id = m.item_id
left join public.teachers t on t.id = m.teacher_id
left join public.profiles p on p.id = m.created_by
"""
MOVE_CSV = [
    ("moved_on", "Date", "text"),
    ("item_code", "Code", "text"),
    ("item_name", "Item", "text"),
    ("direction", "In / out", "text"),
    ("reason_label", "Reason", "text"),
    ("quantity", "Quantity", "text"),
    ("unit", "Unit", "text"),
    ("balance_after", "Balance after", "text"),
    ("unit_cost", "Unit cost", "money"),
    ("total_cost", "Total cost", "money"),
    ("vendor", "Vendor", "text"),
    ("reference", "Reference", "text"),
    ("to_from", "To / from", "text"),
    ("note", "Note", "text"),
    ("recorded_by", "Recorded by", "text"),
]


async def _movements(
    db: AsyncSession,
    ctx: SchoolContext,
    *,
    item_id: uuid.UUID | None = None,
    kind: str | None = None,
    reason: str | None = None,
    category: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    q: str | None = None,
    page: int = 1,
    page_size: int = 50,
    include_changes: bool = False,
    csv: bool = False,
) -> Any:
    where = ["m.school_id = :s"]
    p: dict[str, Any] = {"s": ctx.school_id}
    if item_id:
        where.append("m.item_id = :item")
        p["item"] = item_id
    if kind:
        where.append("m.kind = :kind")
        p["kind"] = kind
    elif not include_changes:
        where.append("m.kind <> 'change'")
    if reason:
        where.append("m.reason = :reason")
        p["reason"] = reason
    if category:
        where.append("i.category = :cat")
        p["cat"] = category
    if date_from:
        where.append("m.moved_on >= :df")
        p["df"] = date_from
    if date_to:
        where.append("m.moved_on <= :dt")
        p["dt"] = date_to
    if q and q.strip():
        p["q"] = q.strip().lower()
        where.append(
            "(lower(i.name) like '%' || :q || '%' or lower(i.item_code) = :q or lower(coalesce(m.reference, '')) = :q "
            "or lower(coalesce(m.vendor, '')) like '%' || :q || '%' "
            "or lower(coalesce(m.recipient, '')) like '%' || :q || '%' "
            "or lower(coalesce(t.full_name, '')) like '%' || :q || '%')"
        )
    w = " and ".join(where)
    order = "m.moved_on desc, m.created_at desc"
    if csv:
        rows = [dict(r) for r in (await db.execute(text(f"{MOVE_SELECT} where {w} order by {order}"), p)).mappings()]
        for r in rows:
            r["direction"] = {"in": "In", "out": "Out", "change": "Change"}[r["kind"]]
            r["reason_label"] = REASON_LABEL.get(r["reason"], r["reason"])
            r["to_from"] = r["teacher_name"] or r["recipient"]
            for k in ("quantity", "balance_after"):
                r[k] = f"{r[k].normalize():f}"
        return rows
    total = (
        await db.execute(
            text(
                "select count(*) from public.inventory_movements m join public.inventory_items i on i.id = m.item_id "
                f"left join public.teachers t on t.id = m.teacher_id where {w}"
            ),
            p,
        )
    ).scalar_one()
    rows = _rows(
        await db.execute(
            text(f"{MOVE_SELECT} where {w} order by {order} limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    )
    return {"items": rows, "total": total, "page": page, "page_size": page_size}


@router.get("/items/{item_id}/history")
async def item_history(
    item_id: uuid.UUID,
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=50, ge=1, le=200),
) -> dict:
    await _item(db, ctx, item_id)
    return await _movements(db, ctx, item_id=item_id, include_changes=True, page=page, page_size=page_size)


@router.get("/movements")
async def movements(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    kind: Literal["in", "out"] | None = None,
    reason: str | None = Query(default=None, max_length=30),
    category: Category | None = None,
    date_from: date | None = Query(default=None, alias="from"),
    date_to: date | None = Query(default=None, alias="to"),
    q: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=50, ge=1, le=200),
    format: Literal["json", "csv"] = "json",
) -> Any:
    if date_from and date_to and date_to < date_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The end date is before the start date.")
    args = {
        "kind": kind,
        "reason": reason,
        "category": category,
        "date_from": date_from,
        "date_to": date_to,
        "q": q,
    }
    if format == "csv":
        rows = await _movements(db, ctx, **args, csv=True)
        return Response(
            to_csv(MOVE_CSV, rows),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="inventory-stock-history.csv"'},
        )
    return await _movements(db, ctx, **args, page=page, page_size=page_size)


# ------------------------------------------------------------------ helpers for the forms
@router.get("/locations")
async def locations(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> list[str]:
    rows = await db.execute(
        text(
            "select min(location) from public.inventory_items where school_id = :s "
            "group by lower(location) order by lower(min(location))"
        ),
        {"s": ctx.school_id},
    )
    return [r[0] for r in rows]


@router.get("/staff")
async def staff(ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Active staff an item can be assigned or issued to."""
    return _rows(
        await db.execute(
            text(
                "select id, full_name, employee_id from public.teachers where school_id = :s and status = 'active' "
                "order by lower(full_name)"
            ),
            {"s": ctx.school_id},
        )
    )


@router.get("/mine")
async def mine(ctx: SchoolContext = Depends(get_school_context), db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Items assigned to the signed-in staff member (RLS: a staff member sees only these)."""
    teacher = (await db.execute(text("select private.current_teacher_id(:s)"), {"s": ctx.school_id})).scalar()
    if teacher is None:
        return []
    return _rows(
        await db.execute(
            text(
                "select id, item_code, name, category, unit, quantity, brand_model, serial_number, location, condition "
                "from public.inventory_items where school_id = :s and assigned_teacher_id = :t and is_active "
                "order by category, lower(name)"
            ),
            {"s": ctx.school_id, "t": teacher},
        )
    )
