"""Subscription billing: subscriptions, invoices, payments, renewal, cancellation, and the platform's
Razorpay checkout and webhook.

Everything about money happens in the database (migration 0030): invoices are issued, numbered
and taxed by private.billing_issue_invoice; payments and refunds are recorded by
private.billing_record_payment / _refund; a subscription's status is worked out from those records
by private.subscription_status and is never stored. This module checks who may ask, talks to
Razorpay with the platform's own keys (which never leave the API), and lays out invoices as PDF.

A gateway payment counts only after the API verified it: the checkout signature, then the payment
fetched from Razorpay (order, amount, currency, status); or a webhook signed with the platform's
webhook secret. Webhook events are stored once (by Razorpay's event id), so a repeat is ignored."""

import hashlib
import json
import logging
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.platform import exact, ist_today
from app.core.config import get_settings
from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission, require_super_admin
from app.core.permissions import Permission
from app.db.errors import http_error_from_db, pg_error
from app.db.session import billing_session
from app.services.audit import write_audit
from app.services.invoice_pdf import build_invoice_pdf
from app.services.razorpay import (
    GatewayError,
    RazorpayClient,
    describe_method,
    from_paise,
    payment_signature_ok,
    to_paise,
    webhook_signature_ok,
)

log = logging.getLogger("billing")
router = APIRouter(tags=["billing"])
SCHOOL_ADMIN = Depends(require_permission(Permission.SETTINGS_MANAGE))
SUPER = Depends(require_super_admin)
Cycle = Literal["monthly", "yearly"]
GSTIN = r"^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$"


def platform_client() -> RazorpayClient:
    s = get_settings()
    if not s.platform_payments_enabled:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Online payment isn't set up. Pay by bank transfer and the platform will record it.",
        )
    return RazorpayClient(s.platform_razorpay_key_id, s.platform_razorpay_key_secret)


def _gateway_error(exc: GatewayError) -> HTTPException:
    return HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc))


# ================================================================== views
async def subscription_view(db: AsyncSession, school_id: uuid.UUID, *, for_school: bool = False) -> dict:
    """The subscription as the caller may see it (the super admin, or the school's own admins)."""
    try:
        st = await db.scalar(text("select private.subscription_overview(:s)"), {"s": school_id})
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    facts = (
        await db.execute(
            text(
                "select s.plan_id, p.name as plan_name, p.code as plan_code, p.is_active as plan_is_active, "
                "p.features as highlights, "
                "p.trial_days, p.grace_period_days, s.billing_cycle, s.price as agreed_price, "
                "case when s.billing_cycle = 'yearly' then p.price_yearly else p.price_monthly end as plan_price, "
                "s.started_on, s.trial_ends_at, s.cancel_at_period_end, s.cancelled_at, s.cancel_reason, "
                "s.billing_gstin, "
                + ("" if for_school else "s.notes, ")
                + "s.updated_at from public.school_subscriptions s join public.subscription_plans p on p.id = "
                "s.plan_id where s.school_id = :s"
            ),
            {"s": school_id},
        )
    ).first()
    out: dict = {"status": st, "subscription": exact(dict(facts._mapping)) if facts else None}
    invoices = await db.execute(
        text(
            "select i.id, i.invoice_number, i.kind, i.plan_name, i.billing_cycle, i.period_start, i.period_end, "
            "i.subtotal, i.tax_amount, "
            "i.total, i.issued_on, i.due_on, i.voided_at, i.void_reason, private.invoice_state(i.id) as state, "
            "private.invoice_paid_amount(i.id) as paid from public.subscription_invoices i where i.school_id = :s "
            "order by i.period_start desc, i.issued_on desc"
        ),
        {"s": school_id},
    )
    out["invoices"] = [exact(dict(r._mapping)) for r in invoices.all()]
    payments = await db.execute(
        text(
            "select p.id, p.invoice_id, i.invoice_number, p.amount, p.refunded_amount, p.method, p.method_detail, "
            "p.reference, "
            "p.gateway_payment_id, p.source, p.paid_on, p.refunded_at from public.subscription_payments p "
            "join public.subscription_invoices i on i.id = p.invoice_id where p.school_id = :s order by p.paid_on "
            "desc, p.created_at desc"
        ),
        {"s": school_id},
    )
    out["payments"] = [exact(dict(r._mapping)) for r in payments.all()]
    if facts:
        ents = await db.execute(
            text(
                "select f.key, f.label, f.kind, f.unit, f.available, coalesce(e.included, f.kind = 'limit') as "
                "included, e.limit_value as limit "
                "from public.plan_features f left join public.plan_entitlements e on e.feature_key = f.key and "
                "e.plan_id = :p "
                "order by f.display_order"
            ),
            {"p": facts.plan_id},
        )
        out["entitlements"] = [dict(r._mapping) for r in ents.all()]
    else:
        out["entitlements"] = []
    if not for_school:
        hist = await db.execute(
            text(
                "select e.id, e.action, e.plan_name, e.billing_cycle, e.price, e.trial_ends_at, e.details, "
                "e.changed_at, "
                "(select coalesce(nullif(pr.full_name, ''), pr.email) from public.profiles pr where pr.id = "
                "e.changed_by) as changed_by "
                "from public.school_subscription_events e where e.school_id = :s order by e.changed_at desc, e.id "
                "desc limit 50"
            ),
            {"s": school_id},
        )
        out["history"] = [exact(dict(r._mapping)) for r in hist.all()]
    return out


async def _invoice_for_pdf(db: AsyncSession, invoice_id: uuid.UUID, school_id: uuid.UUID | None) -> Response:
    row = (
        await db.execute(
            text(
                "select i.*, private.invoice_state(i.id) as state from public.subscription_invoices i where i.id = :id"
                + (" and i.school_id = :s" if school_id else "")
            ),
            {"id": invoice_id, "s": school_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found.")
    inv = dict(row._mapping)
    pays = [
        dict(r._mapping)
        for r in (
            await db.execute(
                text(
                    "select amount, refunded_amount, method, reference, gateway_payment_id, paid_on from "
                    "public.subscription_payments "
                    "where invoice_id = :id order by paid_on, created_at"
                ),
                {"id": invoice_id},
            )
        ).all()
    ]
    pdf = build_invoice_pdf(inv, pays, inv["state"])
    name = inv["invoice_number"].replace("/", "-")
    return Response(
        pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}.pdf"'}
    )


# ================================================================== super admin: settings, run, events
class BillingSettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    legal_name: str = Field(min_length=2, max_length=200)
    gstin: str | None = Field(default=None, pattern=GSTIN)
    address: str = Field(min_length=3, max_length=500)
    state: str = Field(min_length=2, max_length=100)
    email: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=20)
    invoice_prefix: str = Field(pattern=r"^[A-Z0-9-]{1,10}$")
    tax_label: str = Field(min_length=2, max_length=20)
    tax_rate: Decimal = Field(ge=0, le=100, max_digits=5, decimal_places=2)
    renewal_lead_days: int = Field(ge=0, le=60)
    payment_due_days: int = Field(ge=0, le=90)

    @field_validator("gstin", "email", "phone", mode="before")
    @classmethod
    def _blank(cls, v: object) -> object:
        return (v.strip().upper() if isinstance(v, str) and v.strip() else None) if isinstance(v, str) else v

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str | None) -> str | None:
        return v.lower() if v else v


@router.get("/admin/billing/settings")
async def get_billing_settings(_: CurrentUser = SUPER, db: AsyncSession = Depends(get_db)) -> dict:
    row = (await db.execute(text("select * from public.billing_settings"))).first()
    s = get_settings()
    return {
        "settings": exact(dict(row._mapping)) if row else None,
        "online_payments": {
            "enabled": s.platform_payments_enabled,
            "webhook_secret_set": bool(s.platform_razorpay_webhook_secret),
            "key_id": s.platform_razorpay_key_id or None,
            "webhook_path": "/api/v1/billing/webhooks/razorpay",
        },
    }


@router.put("/admin/billing/settings")
async def put_billing_settings(
    payload: BillingSettingsIn, request: Request, user: CurrentUser = SUPER, db: AsyncSession = Depends(get_db)
) -> dict:
    data = payload.model_dump()
    cols = ", ".join(data)
    try:
        placeholders = ", ".join(":" + k for k in data)
        updates = ", ".join(f"{k} = excluded.{k}" for k in data)
        await db.execute(
            text(
                f"insert into public.billing_settings ({cols}, updated_by) values ({placeholders}, :by) "
                f"on conflict (id) do update set {updates}, updated_by = excluded.updated_by"
            ),
            {**data, "by": user.id},
        )
        await write_audit(
            db,
            request,
            action="billing.settings_saved",
            entity_type="billing_settings",
            metadata={k: str(v) for k, v in data.items()},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await get_billing_settings(_=user, db=db)


@router.post("/admin/billing/run")
async def run_billing(request: Request, _: CurrentUser = SUPER, db: AsyncSession = Depends(get_db)) -> dict:
    """Issues every renewal invoice that is due now (the API also does this every hour)."""
    try:
        n = await db.scalar(text("select private.billing_run()"))
        await write_audit(db, request, action="billing.run", entity_type="billing", metadata={"invoices_issued": n})
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return {"invoices_issued": n}


@router.get("/admin/billing/webhook-events")
async def webhook_events(_: CurrentUser = SUPER, db: AsyncSession = Depends(get_db)) -> list[dict]:
    rows = await db.execute(text("select * from public.billing_webhook_events order by received_at desc limit 100"))
    return [dict(r._mapping) for r in rows.all()]


# ================================================================== super admin: invoices and payments
@router.get("/admin/invoices")
async def list_invoices(
    _: CurrentUser = SUPER,
    db: AsyncSession = Depends(get_db),
    school_id: uuid.UUID | None = None,
    state: Literal["open", "overdue", "partly_paid", "paid", "void", "unpaid"] | None = None,
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    where, p = ["true"], {"lim": page_size, "off": (page - 1) * page_size}
    if school_id:
        where.append("i.school_id = :s")
        p["s"] = school_id
    if state == "unpaid":
        where.append("private.invoice_state(i.id) in ('open', 'overdue', 'partly_paid')")
    elif state:
        where.append("private.invoice_state(i.id) = :st")
        p["st"] = state
    w = " and ".join(where)
    total = await db.scalar(text(f"select count(*) from public.subscription_invoices i where {w}"), p)
    totals = (
        await db.execute(
            text(
                f"select coalesce(sum(i.total), 0) as invoiced, coalesce(sum(private.invoice_paid_amount(i.id)), 0) "
                f"as received "
                f"from public.subscription_invoices i where {w} and i.voided_at is null"
            ),
            p,
        )
    ).one()
    rows = await db.execute(
        text(
            "select i.id, i.invoice_number, i.school_id, sc.name as school_name, i.kind, i.plan_name, i.period_start, "
            "i.period_end, "
            "i.total, i.issued_on, i.due_on, private.invoice_state(i.id) as state, private.invoice_paid_amount(i.id) "
            "as paid "
            f"from public.subscription_invoices i join public.schools sc on sc.id = i.school_id where {w} "
            "order by i.issued_on desc, i.invoice_number desc limit :lim offset :off"
        ),
        p,
    )
    return {
        "items": [exact(dict(r._mapping)) for r in rows.all()],
        "total": total,
        "page": page,
        "page_size": page_size,
        "totals": exact(dict(totals._mapping)),
    }


@router.get("/admin/invoices/{invoice_id}/pdf")
async def admin_invoice_pdf(
    invoice_id: uuid.UUID, _: CurrentUser = SUPER, db: AsyncSession = Depends(get_db)
) -> Response:
    return await _invoice_for_pdf(db, invoice_id, None)


class ManualPaymentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    method: Literal["bank_transfer", "upi", "cheque", "cash", "other"]
    reference: str | None = Field(default=None, max_length=100)
    paid_on: date

    @model_validator(mode="after")
    def _ref(self) -> "ManualPaymentIn":
        self.reference = (self.reference or "").strip() or None
        if self.method != "cash" and not self.reference:
            raise ValueError("Enter the reference (UTR, UPI transaction id or cheque number).")
        return self


async def _school_of_invoice(db: AsyncSession, invoice_id: uuid.UUID) -> uuid.UUID:
    s = await db.scalar(text("select school_id from public.subscription_invoices where id = :id"), {"id": invoice_id})
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found.")
    return s


@router.post("/admin/invoices/{invoice_id}/payments", status_code=status.HTTP_201_CREATED)
async def record_payment(
    invoice_id: uuid.UUID,
    payload: ManualPaymentIn,
    request: Request,
    _: CurrentUser = SUPER,
    db: AsyncSession = Depends(get_db),
) -> dict:
    school = await _school_of_invoice(db, invoice_id)
    try:
        pid = await db.scalar(
            text("select private.billing_record_payment(:i, :a, :m, null, :r, :d, 'manual', null, null)"),
            {"i": invoice_id, "a": payload.amount, "m": payload.method, "r": payload.reference, "d": payload.paid_on},
        )
        await write_audit(
            db,
            request,
            action="billing.payment_recorded",
            entity_type="subscription_payment",
            entity_id=str(pid),
            school_id=school,
            metadata={"invoice": str(invoice_id), "amount": str(payload.amount), "method": payload.method},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await subscription_view(db, school)


class VoidIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: str = Field(min_length=3, max_length=300)


@router.post("/admin/invoices/{invoice_id}/void")
async def void_invoice(
    invoice_id: uuid.UUID, payload: VoidIn, request: Request, _: CurrentUser = SUPER, db: AsyncSession = Depends(get_db)
) -> dict:
    school = await _school_of_invoice(db, invoice_id)
    try:
        await db.execute(text("select private.billing_void_invoice(:i, :r)"), {"i": invoice_id, "r": payload.reason})
        await write_audit(
            db,
            request,
            action="billing.invoice_voided",
            entity_type="subscription_invoice",
            entity_id=str(invoice_id),
            school_id=school,
            metadata={"reason": payload.reason},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await subscription_view(db, school)


class RefundIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)


@router.post("/admin/payments/{payment_id}/refund")
async def record_refund(
    payment_id: uuid.UUID,
    payload: RefundIn,
    request: Request,
    _: CurrentUser = SUPER,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Records money given back by hand. Card/UPI payments taken online are refunded in the Razorpay dashboard:
    its webhook records the refund here."""
    row = (
        await db.execute(
            text("select school_id, method from public.subscription_payments where id = :id"), {"id": payment_id}
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payment not found.")
    if row.method == "razorpay":
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Refund online payments in the Razorpay dashboard; the refund is recorded here automatically.",
        )
    try:
        await db.execute(
            text("select private.billing_record_refund(:p, null, :a)"), {"p": payment_id, "a": payload.amount}
        )
        await write_audit(
            db,
            request,
            action="billing.refund_recorded",
            entity_type="subscription_payment",
            entity_id=str(payment_id),
            school_id=row.school_id,
            metadata={"amount": str(payload.amount)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await subscription_view(db, row.school_id)


# ================================================================== super admin: a school's subscription
class SubscriptionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: uuid.UUID
    billing_cycle: Cycle
    price: Decimal | None = Field(
        default=None,
        ge=0,
        max_digits=12,
        decimal_places=2,
        description="Agreed price per billing cycle; empty = the plan's price at each invoice",
    )
    started_on: date | None = None  # new subscriptions; default today
    trial: Literal["plan", "none", "until"] | None = (
        None  # new subscriptions: the plan's trial, none, or until trial_ends_at
    )
    trial_ends_at: date | None = None  # with trial="until"; on a running trial, extends it
    billing_gstin: str | None = Field(default=None, pattern=GSTIN)
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("billing_gstin", mode="before")
    @classmethod
    def _gstin(cls, v: object) -> object:
        return (v.strip().upper() or None) if isinstance(v, str) else v

    @model_validator(mode="after")
    def _checks(self) -> "SubscriptionIn":
        if self.trial == "until" and self.trial_ends_at is None:
            raise ValueError("Choose when the trial ends.")
        if self.notes is not None:
            self.notes = self.notes.strip() or None
        return self


@router.get("/admin/schools/{school_id}/subscription")
async def get_subscription(school_id: uuid.UUID, _: CurrentUser = SUPER, db: AsyncSession = Depends(get_db)) -> dict:
    if not await db.scalar(text("select exists (select 1 from public.schools where id = :id)"), {"id": school_id}):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")
    return await subscription_view(db, school_id)


@router.put("/admin/schools/{school_id}/subscription")
async def put_subscription(
    school_id: uuid.UUID,
    payload: SubscriptionIn,
    request: Request,
    user: CurrentUser = SUPER,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Starts a school's subscription (with the plan's trial, none, or a chosen end date; without a trial the
    first invoice is issued at once), or changes it: plan, billing cycle, agreed price, trial end, GSTIN, notes.
    A plan change takes effect now for what the school may use, and on the next invoice for the price."""
    if not await db.scalar(text("select exists (select 1 from public.schools where id = :id)"), {"id": school_id}):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")
    plan = (
        await db.execute(
            text("select name, trial_days, is_active from public.subscription_plans where id = :id"),
            {"id": payload.plan_id},
        )
    ).first()
    if plan is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Plan not found.")
    existing = (
        await db.execute(text("select * from public.school_subscriptions where school_id = :s"), {"s": school_id})
    ).first()
    today = ist_today()
    issued: str | None = None
    try:
        if existing is None:
            start = payload.started_on or today
            if start > today:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A subscription starts today or earlier.")
            trial_end = None
            if payload.trial == "until":
                trial_end = payload.trial_ends_at
            elif payload.trial in (None, "plan") and plan.trial_days > 0:
                trial_end = start + timedelta(days=plan.trial_days - 1)
            if trial_end is not None and trial_end < start:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, "The trial can't end before the subscription starts."
                )
            await db.execute(
                text(
                    "insert into public.school_subscriptions (school_id, plan_id, billing_cycle, price, started_on, "
                    "trial_ends_at, "
                    "billing_gstin, notes, updated_by) values (:s, :p, cast(:c as public.billing_cycle), :pr, :st, "
                    ":tr, :g, :n, :by)"
                ),
                {
                    "s": school_id,
                    "p": payload.plan_id,
                    "c": payload.billing_cycle,
                    "pr": payload.price,
                    "st": start,
                    "tr": trial_end,
                    "g": payload.billing_gstin,
                    "n": payload.notes,
                    "by": user.id,
                },
            )
            if trial_end is None:  # no trial: bill the first period now (if the billing details are in)
                if await db.scalar(text("select exists (select 1 from public.billing_settings)")):
                    inv = await db.scalar(
                        text("select private.billing_issue_invoice(:s, :d, 'subscription')"),
                        {"s": school_id, "d": start},
                    )
                    issued = await db.scalar(
                        text("select invoice_number from public.subscription_invoices where id = :i"), {"i": inv}
                    )
            await write_audit(
                db,
                request,
                action="subscription.started",
                entity_type="school_subscription",
                entity_id=str(school_id),
                school_id=school_id,
                metadata={
                    "plan": plan.name,
                    "cycle": payload.billing_cycle,
                    "trial_ends_at": str(trial_end),
                    "price": str(payload.price),
                    "first_invoice": issued,
                },
            )
        else:
            sets, params = [], {"s": school_id, "by": user.id}
            if payload.plan_id != existing.plan_id:
                sets.append("plan_id = :p")
                params["p"] = payload.plan_id
            if payload.billing_cycle != existing.billing_cycle:
                sets.append("billing_cycle = cast(:c as public.billing_cycle)")
                params["c"] = payload.billing_cycle
            for col in ("price", "billing_gstin", "notes"):
                if col in payload.model_fields_set and getattr(payload, col) != getattr(existing, col):
                    sets.append(f"{col} = :{col}")
                    params[col] = getattr(payload, col)
            if payload.trial_ends_at is not None and payload.trial_ends_at != existing.trial_ends_at:
                sets.append("trial_ends_at = :tr")
                params["tr"] = payload.trial_ends_at
            if sets:
                await db.execute(
                    text(
                        f"update public.school_subscriptions set {', '.join(sets)}, updated_by = :by where school_id "
                        f"= :s"
                    ),
                    params,
                )
                await write_audit(
                    db,
                    request,
                    action="subscription.changed",
                    entity_type="school_subscription",
                    entity_id=str(school_id),
                    school_id=school_id,
                    metadata={k: str(v) for k, v in params.items() if k not in ("s", "by")},
                )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    out = await subscription_view(db, school_id)
    out["issued_invoice"] = issued
    return out


class CancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["at_period_end", "resume", "now", "reactivate"]
    reason: str | None = Field(default=None, max_length=500)


async def _cancel(db: AsyncSession, request: Request, school_id: uuid.UUID, payload: CancelIn) -> None:
    try:
        await db.execute(
            text("select private.subscription_cancel(:s, :m, :r)"),
            {"s": school_id, "m": payload.mode, "r": payload.reason},
        )
        await write_audit(
            db,
            request,
            action=f"subscription.{payload.mode}",
            entity_type="school_subscription",
            entity_id=str(school_id),
            school_id=school_id,
            metadata={"reason": payload.reason},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None


@router.post("/admin/schools/{school_id}/subscription/cancel")
async def admin_cancel(
    school_id: uuid.UUID,
    payload: CancelIn,
    request: Request,
    _: CurrentUser = SUPER,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _cancel(db, request, school_id, payload)
    return await subscription_view(db, school_id)


@router.post("/admin/schools/{school_id}/invoices", status_code=status.HTTP_201_CREATED)
async def issue_next_invoice(
    school_id: uuid.UUID, request: Request, _: CurrentUser = SUPER, db: AsyncSession = Depends(get_db)
) -> dict:
    """Issues the invoice for the school's next period now (e.g. a school renewing early, or after an expiry)."""
    try:
        nxt = await db.scalar(text("select private.billing_next_period(:s)"), {"s": school_id})
        if nxt is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "This school has no subscription.")
        status_now = await db.scalar(text("select private.subscription_overview(:s) ->> 'status'"), {"s": school_id})
        if status_now in ("expired",) and nxt < ist_today():
            nxt = ist_today()  # an expired school starts again from today, not from the gap
        inv = await db.scalar(
            text("select private.billing_issue_invoice(:s, :d, 'renewal')"), {"s": school_id, "d": nxt}
        )
        await write_audit(
            db,
            request,
            action="billing.invoice_issued",
            entity_type="subscription_invoice",
            entity_id=str(inv),
            school_id=school_id,
            metadata={"period_start": str(nxt)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await subscription_view(db, school_id)


# ================================================================== school admins
@router.get("/school/billing")
async def my_billing(ctx: SchoolContext = SCHOOL_ADMIN, db: AsyncSession = Depends(get_db)) -> dict:
    """The school's plan, what it includes, where the subscription stands, invoices and payments, and usage."""
    view = await subscription_view(db, ctx.school_id, for_school=True)
    try:
        view["usage"] = await db.scalar(text("select private.school_usage(:s)"), {"s": ctx.school_id})
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    view["online_payments"] = get_settings().platform_payments_enabled
    return view


class SchoolCancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["at_period_end", "resume"]
    reason: str | None = Field(default=None, max_length=500)


@router.post("/school/billing/cancel")
async def school_cancel(
    payload: SchoolCancelIn, request: Request, ctx: SchoolContext = SCHOOL_ADMIN, db: AsyncSession = Depends(get_db)
) -> dict:
    await _cancel(db, request, ctx.school_id, CancelIn(mode=payload.mode, reason=payload.reason))
    return await my_billing(ctx=ctx, db=db)


@router.get("/school/billing/invoices/{invoice_id}/pdf")
async def school_invoice_pdf(
    invoice_id: uuid.UUID, ctx: SchoolContext = SCHOOL_ADMIN, db: AsyncSession = Depends(get_db)
) -> Response:
    return await _invoice_for_pdf(db, invoice_id, ctx.school_id)


@router.post("/school/billing/invoices/{invoice_id}/pay")
async def pay_invoice(
    invoice_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = SCHOOL_ADMIN,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Opens a Razorpay order for what is still due on one of the school's invoices (the platform's account)."""
    row = (
        await db.execute(
            text(
                "select i.invoice_number, i.total - private.invoice_paid_amount(i.id) as balance, "
                "private.invoice_state(i.id) as state, "
                "i.seller ->> 'name' as seller, i.description from public.subscription_invoices i where i.id = :id "
                "and i.school_id = :s"
            ),
            {"id": invoice_id, "s": ctx.school_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found.")
    if row.state in ("paid", "void") or row.balance <= 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "Nothing is due on this invoice.")
    client = platform_client()
    try:
        order = await client.create_order(
            to_paise(row.balance),
            row.invoice_number,
            {"invoice_id": str(invoice_id), "school_id": str(ctx.school_id), "purpose": "subscription"},
        )
    except GatewayError as exc:
        raise _gateway_error(exc) from None
    try:
        await db.execute(
            text("select private.billing_open_order(:i, :o, :a)"), {"i": invoice_id, "o": order["id"], "a": row.balance}
        )
        await write_audit(
            db,
            request,
            action="billing.order_created",
            entity_type="billing_order",
            entity_id=order["id"],
            school_id=ctx.school_id,
            metadata={"invoice": row.invoice_number, "amount": str(row.balance)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return {
        "key_id": get_settings().platform_razorpay_key_id,
        "order_id": order["id"],
        "amount": to_paise(row.balance),
        "currency": "INR",
        "name": row.seller or "Subscription",
        "description": row.description,
        "invoice_number": row.invoice_number,
        "prefill": {"email": user.email, "name": user.full_name},
    }


class VerifyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    razorpay_order_id: str = Field(min_length=6, max_length=60)
    razorpay_payment_id: str = Field(min_length=6, max_length=60)
    razorpay_signature: str = Field(min_length=20, max_length=200)


async def _settle(bdb: AsyncSession, order: dict, payment: dict, client: RazorpayClient, via: str) -> str:
    """Records what Razorpay says about a payment of one of our orders. Idempotent."""
    if payment.get("order_id") != order["gateway_order_id"]:
        raise GatewayError("That payment belongs to a different order.")
    st = payment.get("status")
    if st == "authorized":  # accounts without automatic capture: capture exactly the order amount
        payment = await client.capture(payment["id"], to_paise(order["amount"]))
        st = payment.get("status")
    if st == "captured":
        if payment.get("currency") != "INR":
            raise GatewayError("Payment in an unexpected currency.")
        method, detail = describe_method(payment)
        await bdb.execute(
            text("select private.billing_record_payment(:i, :a, 'razorpay', :d, null, :on, :via, :o, :p)"),
            {
                "i": order["invoice_id"],
                "a": from_paise(int(payment.get("amount", 0))),
                "d": detail or method or None,
                "on": ist_today(),
                "via": via,
                "o": order["gateway_order_id"],
                "p": payment["id"],
            },
        )
        return "paid"
    if st == "failed":
        await bdb.execute(
            text("select private.billing_order_outcome(:o, :r)"),
            {"o": order["gateway_order_id"], "r": "failed: " + (payment.get("error_description") or "")},
        )
        return "failed"
    return "processing"


@router.post("/school/billing/payments/verify")
async def verify_payment(
    payload: VerifyIn, request: Request, ctx: SchoolContext = SCHOOL_ADMIN, db: AsyncSession = Depends(get_db)
) -> dict:
    """After Razorpay's checkout: check the signature, then ask Razorpay itself before counting the payment."""
    s = get_settings()
    client = platform_client()
    if not payment_signature_ok(
        payload.razorpay_order_id,
        payload.razorpay_payment_id,
        payload.razorpay_signature,
        s.platform_razorpay_key_secret,
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The payment couldn't be verified.")
    try:
        async with billing_session() as bdb:
            o = (
                await bdb.execute(
                    text("select * from private.billing_find_order(:o)"), {"o": payload.razorpay_order_id}
                )
            ).first()
            if o is None or o.school_id != ctx.school_id:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Order not found.")
            payment = await client.fetch_payment(payload.razorpay_payment_id)
            outcome = await _settle(
                bdb,
                {"gateway_order_id": payload.razorpay_order_id, "invoice_id": o.invoice_id, "amount": o.amount},
                payment,
                client,
                "checkout",
            )
            await bdb.commit()
    except GatewayError as exc:
        raise _gateway_error(exc) from None
    except DBAPIError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, pg_error(exc).message) from None
    await write_audit(
        db,
        request,
        action="billing.payment_verified",
        entity_type="billing_order",
        entity_id=payload.razorpay_order_id,
        school_id=ctx.school_id,
        metadata={"payment": payload.razorpay_payment_id, "outcome": outcome},
    )
    await db.commit()
    return {**(await my_billing(ctx=ctx, db=db)), "outcome": outcome}


# ================================================================== the platform's Razorpay webhook
@router.post("/billing/webhooks/razorpay", include_in_schema=False)
async def billing_webhook(request: Request) -> dict:
    """Signed by Razorpay with the platform's webhook secret. 2xx = handled (or safely ignored); any other
    answer makes Razorpay retry later."""
    s = get_settings()
    body = await request.body()
    if len(body) > 1_000_000:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Too large.")
    if not s.platform_razorpay_webhook_secret or not webhook_signature_ok(
        body, request.headers.get("x-razorpay-signature"), s.platform_razorpay_webhook_secret
    ):
        log.warning("rejected billing webhook (bad or missing signature)")
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid signature.")
    try:
        event = json.loads(body)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid body.") from None
    event_id = request.headers.get("x-razorpay-event-id") or "sha256:" + hashlib.sha256(body).hexdigest()
    kind = str(event.get("event") or "")
    payload = event.get("payload") or {}
    payment = (payload.get("payment") or {}).get("entity") or {}
    refund = (payload.get("refund") or {}).get("entity") or {}
    order_id = payment.get("order_id") or ((payload.get("order") or {}).get("entity") or {}).get("id")
    try:
        async with billing_session() as bdb:
            first = await bdb.scalar(
                text("select private.billing_log_event(:e, :k, :o, :p)"),
                {
                    "e": event_id[:200],
                    "k": kind[:60],
                    "o": order_id,
                    "p": payment.get("id") or refund.get("payment_id"),
                },
            )
            if not first:
                return {"status": "duplicate"}
            outcome = "ignored"
            if kind in ("payment.captured", "payment.authorized", "order.paid", "payment.failed") and payment:
                o = (await bdb.execute(text("select * from private.billing_find_order(:o)"), {"o": order_id})).first()
                if o is None:
                    outcome = "not a subscription order"
                else:
                    client = (
                        platform_client()
                        if kind == "payment.authorized"
                        else RazorpayClient(s.platform_razorpay_key_id, s.platform_razorpay_key_secret)
                    )
                    outcome = await _settle(
                        bdb,
                        {"gateway_order_id": order_id, "invoice_id": o.invoice_id, "amount": o.amount},
                        payment,
                        client,
                        "webhook",
                    )
            elif kind == "refund.processed" and refund.get("payment_id"):
                done = await bdb.scalar(
                    text("select private.billing_record_refund(null, :p, :a)"),
                    {"p": refund["payment_id"], "a": from_paise(int(refund.get("amount", 0)))},
                )
                outcome = "refund recorded" if done else "refund for an unknown payment"
            await bdb.execute(text("select private.billing_event_outcome(:e, :o)"), {"e": event_id[:200], "o": outcome})
            await bdb.commit()
            return {"status": outcome}
    except GatewayError as exc:
        raise _gateway_error(exc) from None
    except DBAPIError as exc:
        # a permanent conflict (e.g. an over-refund): record it for the platform, don't make Razorpay retry for a day
        err = pg_error(exc)
        if err.sqlstate not in ("23514", "P0002"):
            raise
        log.error("billing webhook %s: %s", event_id, err.message)
        async with billing_session() as bdb:
            await bdb.execute(
                text("select private.billing_log_event(:e, :k, :o, null)"),
                {"e": event_id[:200], "k": kind[:60], "o": order_id},
            )
            await bdb.execute(
                text("select private.billing_event_outcome(:e, :o)"),
                {"e": event_id[:200], "o": "needs review: " + err.message},
            )
            await bdb.commit()
        return {"status": "needs review"}
