"""Platform (super admin): subscription plans and what they include, each school's usage, the
school administrators, and system analytics. (Subscriptions, invoices and payments: billing.py.)

Figures come from SQL functions (migrations 0029-0030) that check the caller themselves; plans
are protected by row-level security as well (only the super admin writes them). No price,
limit or period is built in: every plan is entered by the super admin."""

import calendar
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, get_db, require_super_admin
from app.db.errors import http_error_from_db
from app.services.audit import write_audit

router = APIRouter(prefix="/admin", tags=["super-admin"])

Cycle = Literal["monthly", "yearly"]
Money = Decimal

PLAN_CONFLICTS = {
    "subscription_plans_code_key": "Another plan already uses this code.",
    "subscription_plans_name_key": "Another plan already has this name.",
}


def ist_today() -> date:
    return (datetime.now(UTC) + timedelta(hours=5, minutes=30)).date()


def add_cycle(start: date, cycle: Cycle) -> date:
    """The last day of one billing cycle that starts on `start` (as private.add_cycle)."""
    if cycle == "yearly":
        try:
            nxt = start.replace(year=start.year + 1)
        except ValueError:  # 29 February
            nxt = start.replace(year=start.year + 1, day=28)
    else:
        y, m = (start.year + 1, 1) if start.month == 12 else (start.year, start.month + 1)
        nxt = date(y, m, min(start.day, calendar.monthrange(y, m)[1]))
    return nxt - timedelta(days=1)


def exact(d: dict) -> dict:
    """Amounts as exact decimal strings in JSON (as everywhere in the API); the browser only formats them."""
    return {k: (f"{v:.2f}" if isinstance(v, Decimal) else v) for k, v in d.items()}


# ---------------------------------------------------------------- plans and their entitlements
class Entitlement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    included: bool
    limit: int | None = Field(default=None, ge=0, le=10_000_000, description="Limits only; empty = no limit")


class PlanFields(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str | None = Field(default=None, min_length=2, max_length=60)
    description: str | None = Field(default=None, max_length=500)
    price_monthly: Money | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    price_yearly: Money | None = Field(default=None, ge=0, max_digits=12, decimal_places=2)
    trial_days: int | None = Field(default=None, ge=0, le=365)
    grace_period_days: int | None = Field(default=None, ge=0, le=90)
    features: list[str] | None = Field(default=None, max_length=20, description="Highlights shown to schools")
    entitlements: dict[str, Entitlement] | None = None
    is_active: bool | None = None
    display_order: int | None = Field(default=None, ge=0, le=1000)

    @field_validator("features")
    @classmethod
    def _features(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        out = [f.strip() for f in v if f and f.strip()]
        if any(len(f) > 100 for f in out):
            raise ValueError("Each highlight can be up to 100 characters.")
        return out

    @field_validator("description", mode="before")
    @classmethod
    def _empty(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v


class PlanCreate(PlanFields):
    code: str = Field(pattern=r"^[A-Za-z0-9-]{2,30}$")
    name: str = Field(min_length=2, max_length=60)
    price_monthly: Money = Field(ge=0, max_digits=12, decimal_places=2)
    price_yearly: Money = Field(ge=0, max_digits=12, decimal_places=2)
    trial_days: int = Field(ge=0, le=365)
    grace_period_days: int = Field(ge=0, le=90)
    entitlements: dict[str, Entitlement]

    @field_validator("code")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()


class PlanUpdate(PlanFields):
    @model_validator(mode="after")
    def _required(self) -> "PlanUpdate":
        for f in (
            "name",
            "price_monthly",
            "price_yearly",
            "is_active",
            "display_order",
            "features",
            "trial_days",
            "grace_period_days",
            "entitlements",
        ):
            if f in self.model_fields_set and getattr(self, f) is None:
                raise ValueError(f"{f} cannot be empty")
        return self


PLAN_COLS = (
    "p.id, p.code, p.name, p.description, p.price_monthly, p.price_yearly, p.trial_days, p.grace_period_days, "
    "p.features, p.is_active, p.display_order, p.created_at, p.updated_at, "
    "(select count(*) from public.school_subscriptions s where s.plan_id = p.id) as schools, "
    "coalesce((select jsonb_object_agg(e.feature_key, jsonb_build_object('included', e.included, 'limit', "
    "e.limit_value)) "
    "  from public.plan_entitlements e where e.plan_id = p.id), '{}') as entitlements"
)


async def feature_catalog(db: AsyncSession) -> list[dict]:
    rows = await db.execute(
        text(
            "select key, label, kind, unit, description, enforced_by, available from public.plan_features order by "
            "display_order"
        )
    )
    return [dict(r._mapping) for r in rows.all()]


async def _save_entitlements(db: AsyncSession, plan_id: uuid.UUID, ents: dict[str, Entitlement]) -> None:
    catalog = {f["key"]: f for f in await feature_catalog(db)}
    unknown = set(ents) - set(catalog)
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown feature: {', '.join(sorted(unknown))}.")
    missing = set(catalog) - set(ents)
    if missing:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Say whether the plan includes: {', '.join(catalog[k]['label'] for k in sorted(missing))}.",
        )
    for key, e in ents.items():
        if catalog[key]["kind"] == "feature" and e.limit is not None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"{catalog[key]['label']} is on or off; it takes no number."
            )
        if catalog[key]["kind"] == "limit" and not e.included:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"{catalog[key]['label']}: set a number, or no limit."
            )
        await db.execute(
            text(
                "insert into public.plan_entitlements (plan_id, feature_key, included, limit_value) values (:p, :k, "
                ":i, :l) "
                "on conflict (plan_id, feature_key) do update set included = excluded.included, limit_value = "
                "excluded.limit_value"
            ),
            {"p": plan_id, "k": key, "i": e.included, "l": e.limit},
        )


async def _plan_out(db: AsyncSession, plan_id: uuid.UUID) -> dict:
    row = (
        await db.execute(text(f"select {PLAN_COLS} from public.subscription_plans p where p.id = :id"), {"id": plan_id})
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found.")
    return exact(dict(row._mapping))


@router.get("/features")
async def list_features(
    _: CurrentUser = Depends(require_super_admin), db: AsyncSession = Depends(get_db)
) -> list[dict]:
    """What a plan can include or limit (the features this system knows how to enforce)."""
    return await feature_catalog(db)


@router.get("/plans")
async def list_plans(_: CurrentUser = Depends(require_super_admin), db: AsyncSession = Depends(get_db)) -> list[dict]:
    rows = await db.execute(
        text(f"select {PLAN_COLS} from public.subscription_plans p order by p.display_order, lower(p.name)")
    )
    return [exact(dict(r._mapping)) for r in rows.all()]


@router.post("/plans", status_code=status.HTTP_201_CREATED)
async def create_plan(
    payload: PlanCreate,
    request: Request,
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    data = payload.model_dump(exclude={"entitlements"})
    data["features"] = data["features"] or []
    data["is_active"] = True if data["is_active"] is None else data["is_active"]
    data["display_order"] = data["display_order"] or 0
    try:
        pid = await db.scalar(
            text(
                "insert into public.subscription_plans (code, name, description, price_monthly, price_yearly, "
                "trial_days, "
                "grace_period_days, features, is_active, display_order) values (:code, :name, :description, "
                ":price_monthly, "
                ":price_yearly, :trial_days, :grace_period_days, :features, :is_active, :display_order) returning id"
            ),
            data,
        )
        await _save_entitlements(db, pid, payload.entitlements)
        await write_audit(
            db,
            request,
            action="plan.created",
            entity_type="subscription_plan",
            entity_id=str(pid),
            metadata={
                "code": data["code"],
                "name": data["name"],
                "price_monthly": str(data["price_monthly"]),
                "price_yearly": str(data["price_yearly"]),
                "entitlements": {k: v.model_dump() for k, v in payload.entitlements.items()},
            },
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, PLAN_CONFLICTS) from None
    except HTTPException:
        await db.rollback()
        raise
    return await _plan_out(db, pid)


@router.patch("/plans/{plan_id}")
async def update_plan(
    plan_id: uuid.UUID,
    payload: PlanUpdate,
    request: Request,
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    changes = payload.model_dump(exclude_unset=True, exclude={"entitlements"})
    try:
        if changes:
            sets = ", ".join(f"{k} = :{k}" for k in changes)
            res = await db.execute(
                text(f"update public.subscription_plans set {sets} where id = :id"), {**changes, "id": plan_id}
            )
            if res.rowcount == 0:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found.")
        elif not await db.scalar(
            text("select exists (select 1 from public.subscription_plans where id = :id)"), {"id": plan_id}
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found.")
        if payload.entitlements is not None:
            await _save_entitlements(db, plan_id, payload.entitlements)
        if changes or payload.entitlements is not None:
            meta = {k: str(v) for k, v in changes.items()}
            if payload.entitlements is not None:
                meta["entitlements"] = {k: v.model_dump() for k, v in payload.entitlements.items()}
            await write_audit(
                db,
                request,
                action="plan.updated",
                entity_type="subscription_plan",
                entity_id=str(plan_id),
                metadata=meta,
            )
            await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, PLAN_CONFLICTS) from None
    except HTTPException:
        await db.rollback()
        raise
    return await _plan_out(db, plan_id)


@router.delete("/plans/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plan(
    plan_id: uuid.UUID,
    request: Request,
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> Response:
    used = await db.scalar(
        text("select count(*) from public.school_subscriptions where plan_id = :id"), {"id": plan_id}
    )
    invoiced = await db.scalar(
        text("select count(*) from public.subscription_invoices where plan_id = :id"), {"id": plan_id}
    )
    if used or invoiced:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Schools are on this plan, or were billed for it. Retire it instead (it stays with them, and no new "
            "school can get it).",
        )
    res = await db.execute(text("delete from public.subscription_plans where id = :id"), {"id": plan_id})
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found.")
    await write_audit(db, request, action="plan.deleted", entity_type="subscription_plan", entity_id=str(plan_id))
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------- usage and analytics
async def json_response(db: AsyncSession, sql: str, params: dict) -> Response:
    try:
        data = await db.scalar(text(sql), params)
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")
    return Response(content=data, media_type="application/json")


@router.get("/schools/{school_id}/usage")
async def school_usage(
    school_id: uuid.UUID, _: CurrentUser = Depends(require_super_admin), db: AsyncSession = Depends(get_db)
) -> Response:
    return await json_response(db, "select private.school_usage(:id)::text", {"id": school_id})


@router.get("/analytics")
async def platform_analytics(
    _: CurrentUser = Depends(require_super_admin), db: AsyncSession = Depends(get_db)
) -> Response:
    return await json_response(db, "select private.platform_analytics()::text", {})


# ---------------------------------------------------------------- administrators
class AdminStatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["active", "disabled"]


@router.patch("/schools/{school_id}/admins/{user_id}")
async def set_admin_status(
    school_id: uuid.UUID,
    user_id: uuid.UUID,
    payload: AdminStatusIn,
    request: Request,
    _: CurrentUser = Depends(require_super_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    res = await db.execute(
        text(
            "update public.school_memberships set status = cast(:st as public.membership_status) "
            "where school_id = :s and user_id = :u and role = 'school_admin' returning user_id"
        ),
        {"st": payload.status, "s": school_id, "u": user_id},
    )
    if res.first() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This person isn't an administrator of this school.")
    remaining = await db.scalar(
        text(
            "select count(*) from public.school_memberships where school_id = :s and role = 'school_admin' and status "
            "= 'active'"
        ),
        {"s": school_id},
    )
    await write_audit(
        db,
        request,
        action="school.admin_enabled" if payload.status == "active" else "school.admin_disabled",
        entity_type="school_membership",
        entity_id=str(user_id),
        school_id=school_id,
        metadata={"active_admins_left": remaining},
    )
    await db.commit()
    return {"user_id": str(user_id), "status": payload.status, "active_admins": remaining}
