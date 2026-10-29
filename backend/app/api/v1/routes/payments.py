"""Online fee payments through Razorpay (UPI, cards, net banking).

Flow:
  1. A parent chooses fees; POST /payments/orders. The database fixes the amount from
     the dues (never from the browser); the API creates a Razorpay order.
  2. The browser opens Razorpay Checkout with the key id and order id only.
  3. On success the browser sends the ids and signature to POST /payments/{id}/verify.
     The API checks the signature with the key secret AND fetches the payment from
     Razorpay (order, amount, currency, status) before anything is recorded.
  4. Webhooks (signed with the webhook secret) record the same result even if the
     browser never comes back. Recording is idempotent: one order, one receipt.
  5. Staff see every online payment, can re-check one with Razorpay, and admins can
     refund (full refunds; the receipt is cancelled and its fees become payable again).

Secrets: the key secret and webhook secret are stored encrypted (PAYMENT_SECRETS_KEY)
and are only ever decrypted inside the API.
"""

import hashlib
import json
import logging
import uuid
from datetime import date
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.core.ratelimit import limit
from app.db.errors import http_error_from_db, pg_error
from app.db.session import payments_session
from app.services import secrets
from app.services.audit import write_audit
from app.services.razorpay import (
    GatewayError,
    RazorpayClient,
    describe_method,
    from_paise,
    payment_signature_ok,
    to_paise,
    webhook_signature_ok,
)

log = logging.getLogger("payments")
router = APIRouter(prefix="/payments", tags=["payments"])
PARENT = Depends(require_permission(Permission.PORTAL_VIEW))
SETTINGS = Depends(require_permission(Permission.SETTINGS_MANAGE))
STAFF = Depends(require_permission(Permission.FEES_VIEW))
COLLECT = Depends(require_permission(Permission.FEES_COLLECT))
REFUND = Depends(require_permission(Permission.PAYMENTS_REFUND))
NOT_FOUND = HTTPException(status.HTTP_404_NOT_FOUND, "Payment not found.")
KEY_ID = r"^rzp_(test|live)_[A-Za-z0-9]{6,40}$"
Status = Literal[
    "created", "paid", "failed", "cancelled", "needs_review", "refund_pending", "refunded", "refund_failed"
]


def _gateway_error(exc: GatewayError) -> HTTPException:
    return HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message)


def _secrets_error(exc: secrets.SecretsUnavailable) -> HTTPException:
    return HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc))


# ------------------------------------------------------------------ gateway access (server only)
class _Creds:
    def __init__(self, key_id: str, key_secret: str, webhook_secret: str | None, enabled: bool):
        self.key_id, self.key_secret, self.webhook_secret, self.enabled = key_id, key_secret, webhook_secret, enabled

    def client(self) -> RazorpayClient:
        return RazorpayClient(self.key_id, self.key_secret)


async def _creds(pdb: AsyncSession, school_id: uuid.UUID, *, need_webhook: bool = False) -> _Creds | None:
    r = (
        await pdb.execute(
            text("select key_id, key_secret_enc, webhook_secret_enc, is_enabled from private.pay_gateway_secrets(:s)"),
            {"s": school_id},
        )
    ).first()
    if r is None:
        return None
    key_secret = secrets.decrypt(r[1])
    hook = secrets.decrypt(r[2]) if (r[2] and need_webhook) else None
    return _Creds(r[0], key_secret, hook, r[3])


async def _settle(pdb: AsyncSession, op: Any, payment: dict, client: RazorpayClient, via: str) -> dict:
    """Record what Razorpay says about one payment of our order. Idempotent."""
    if payment.get("order_id") != op.gateway_order_id:
        raise GatewayError("That payment belongs to a different order.")
    st = payment.get("status")
    if st == "authorized":  # accounts without automatic capture: capture exactly the order amount
        payment = await client.capture(payment["id"], to_paise(op.amount))
        st = payment.get("status")
    if st == "captured":
        amount = from_paise(int(payment.get("amount", 0))) if payment.get("currency") == "INR" else Decimal(0)
        method, detail = describe_method(payment)
        r = (
            await pdb.execute(
                text(
                    "select status::text, receipt_number, fee_payment_id "
                    "from private.pay_apply(:id, :pid, :amt, :m, :md, :via)"
                ),
                {"id": op.id, "pid": payment["id"], "amt": amount, "m": method, "md": detail, "via": via},
            )
        ).first()
        return {"status": r[0], "receipt_number": r[1], "fee_payment_id": str(r[2]) if r[2] else None}
    if st == "failed":
        reason = payment.get("error_description") or "The payment failed."
        await pdb.execute(
            text("select private.pay_mark_failed(:id, :pid, :r)"), {"id": op.id, "pid": payment.get("id"), "r": reason}
        )
        return {"status": "failed", "message": reason}
    return {"status": "processing"}


# ------------------------------------------------------------------ settings (school admins)
class SettingsIn(BaseModel):
    model_config = {"extra": "forbid"}
    key_id: str = Field(pattern=KEY_ID)
    key_secret: str | None = Field(default=None, min_length=8, max_length=200)  # empty = keep the stored one
    webhook_secret: str | None = Field(default=None, min_length=8, max_length=200)
    enabled: bool

    @field_validator("key_id", "key_secret", "webhook_secret", mode="before")
    @classmethod
    def _strip(cls, v: object) -> object:
        return (v.strip() or None) if isinstance(v, str) else v


async def _settings_out(db: AsyncSession, ctx: SchoolContext) -> dict:
    r = (
        await db.execute(
            text(
                "select key_id, is_enabled, mode, has_webhook_secret, updated_at from private.gateway_account_info(:s)"
            ),
            {"s": ctx.school_id},
        )
    ).first()
    return {
        "provider": "razorpay",
        "configured": r is not None,
        "key_id": r[0] if r else None,
        "enabled": bool(r and r[1]),
        "mode": r[2] if r else None,
        "has_webhook_secret": bool(r and r[3]),
        "updated_at": r[4].isoformat() if r else None,
        "webhook_path": f"/api/v1/payments/webhooks/razorpay/{ctx.school_id}",
        "webhook_events": ["payment.captured", "payment.failed", "order.paid", "refund.processed", "refund.failed"],
    }


@router.get("/settings")
async def get_settings_(ctx: SchoolContext = SETTINGS, db: AsyncSession = Depends(get_db)) -> dict:
    return await _settings_out(db, ctx)


@router.put("/settings")
async def save_settings(
    payload: SettingsIn, request: Request, ctx: SchoolContext = SETTINGS, db: AsyncSession = Depends(get_db)
) -> dict:
    await limit(request, "pay-settings", 20, 600, key=str(ctx.school_id))
    try:
        if payload.key_secret:  # check the pair with Razorpay before saving it
            await RazorpayClient(payload.key_id, payload.key_secret).check_keys()
        key_enc = secrets.encrypt(payload.key_secret) if payload.key_secret else None
        hook_enc = secrets.encrypt(payload.webhook_secret) if payload.webhook_secret else None
    except GatewayError as exc:
        if exc.status == 401:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, exc.message) from None
        raise _gateway_error(exc) from None
    except secrets.SecretsUnavailable as exc:
        raise _secrets_error(exc) from None
    try:
        await db.execute(
            text("select private.save_gateway_account(:s, :k, :ks, :ws, :en)"),
            {"s": ctx.school_id, "k": payload.key_id, "ks": key_enc, "ws": hook_enc, "en": payload.enabled},
        )
        await write_audit(
            db,
            request,
            action="payments.settings_saved",
            entity_type="school",
            entity_id=str(ctx.school_id),
            school_id=ctx.school_id,
            # never the secrets: only whether they were changed
            metadata={
                "key_id": payload.key_id,
                "enabled": payload.enabled,
                "key_secret_changed": bool(payload.key_secret),
                "webhook_secret_changed": bool(payload.webhook_secret),
            },
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _settings_out(db, ctx)


@router.get("/config")
async def portal_config(ctx: SchoolContext = PARENT, db: AsyncSession = Depends(get_db)) -> dict:
    enabled = (await db.execute(text("select private.online_payments_enabled(:s)"), {"s": ctx.school_id})).scalar()
    return {"enabled": bool(enabled), "methods": ["upi", "card", "netbanking"]}


# ------------------------------------------------------------------ parents: pay
class OrderIn(BaseModel):
    model_config = {"extra": "forbid"}
    student_id: uuid.UUID
    due_ids: list[uuid.UUID] = Field(min_length=1, max_length=60)


@router.post("/orders", status_code=status.HTTP_201_CREATED)
async def create_order(
    payload: OrderIn,
    request: Request,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    await limit(request, "pay-order", 20, 600, key=str(user.id))
    try:
        r = (
            await db.execute(
                text(
                    "select online_payment_id, amount, gateway_order_id, reused "
                    "from private.prepare_online_payment(:st, :d)"
                ).bindparams(bindparam("d", type_=ARRAY(UUID(as_uuid=True)))),
                {"st": payload.student_id, "d": list(dict.fromkeys(payload.due_ids))},
            )
        ).first()
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    op_id, amount, order_id = r[0], r[1], r[2]
    if amount < 1:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Online payments must be at least ₹1.")
    info = (
        await db.execute(
            text(
                "select o.description, s.name, st.full_name from public.online_payments o "
                "join public.schools s on s.id = o.school_id join public.students st on st.id = o.student_id "
                "where o.id = :id"
            ),
            {"id": op_id},
        )
    ).first()
    try:
        async with payments_session() as pdb:
            creds = await _creds(pdb, ctx.school_id)
            if creds is None or not creds.enabled:
                raise HTTPException(status.HTTP_409_CONFLICT, "Online payment isn't available for this school.")
            if order_id is None:
                try:
                    order = await creds.client().create_order(
                        to_paise(amount),
                        receipt=f"OP-{op_id.hex[:20]}",
                        notes={
                            "online_payment_id": str(op_id),
                            "school_id": str(ctx.school_id),
                            "student": info[2][:200],
                        },
                    )
                except GatewayError as exc:
                    await pdb.execute(text("select private.pay_cancel(:id, :r)"), {"id": op_id, "r": exc.message})
                    await pdb.commit()
                    raise _gateway_error(exc) from None
                if order.get("amount") != to_paise(amount) or order.get("currency") != "INR" or not order.get("id"):
                    await pdb.execute(
                        text("select private.pay_cancel(:id, :r)"), {"id": op_id, "r": "Unexpected order from gateway"}
                    )
                    await pdb.commit()
                    raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Couldn't start the payment. Please try again.")
                order_id = order["id"]
                await pdb.execute(text("select private.pay_attach_order(:id, :o)"), {"id": op_id, "o": order_id})
                await pdb.commit()
            key_id = creds.key_id
    except secrets.SecretsUnavailable as exc:
        raise _secrets_error(exc) from None
    return {
        "online_payment_id": str(op_id),
        "key_id": key_id,  # public by design; the key secret never leaves the server
        "order_id": order_id,
        "amount": f"{amount:.2f}",
        "amount_paise": to_paise(amount),
        "currency": "INR",
        "name": info[1],
        "description": info[0],
        "prefill": {"name": user.full_name, "email": user.email, "contact": user.phone or ""},
    }


class VerifyIn(BaseModel):
    model_config = {"extra": "forbid"}
    razorpay_order_id: str = Field(min_length=6, max_length=60)
    razorpay_payment_id: str = Field(min_length=6, max_length=60)
    razorpay_signature: str = Field(min_length=20, max_length=200)


async def _visible(db: AsyncSession, ctx: SchoolContext, op_id: uuid.UUID) -> Any:
    """The order, if this user may see it (RLS: staff of the school, or the child's parent)."""
    r = (
        await db.execute(
            text(
                "select id, school_id, student_id, amount, gateway_order_id, gateway_payment_id, status::text, "
                "created_at from public.online_payments where id = :id and school_id = :s"
            ),
            {"id": op_id, "s": ctx.school_id},
        )
    ).first()
    if r is None:
        raise NOT_FOUND
    return r


@router.post("/{op_id}/verify")
async def verify_payment(
    op_id: uuid.UUID,
    payload: VerifyIn,
    request: Request,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Checkout says the payment succeeded. Believe it only after Razorpay confirms it."""
    await limit(request, "pay-verify", 30, 600, key=str(user.id))
    op = await _visible(db, ctx, op_id)
    if payload.razorpay_order_id != op.gateway_order_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "This payment doesn't belong to this order.")
    try:
        async with payments_session() as pdb:
            creds = await _creds(pdb, ctx.school_id)
            if creds is None:
                raise NOT_FOUND
            if not payment_signature_ok(
                payload.razorpay_order_id, payload.razorpay_payment_id, payload.razorpay_signature, creds.key_secret
            ):
                log.warning("payment signature mismatch for %s", op_id)
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "The payment couldn't be verified.")
            client = creds.client()
            payment = await client.fetch_payment(payload.razorpay_payment_id)
            result = await _settle(pdb, op, payment, client, "checkout")
            await pdb.commit()
    except GatewayError as exc:
        raise _gateway_error(exc) from None
    except secrets.SecretsUnavailable as exc:
        raise _secrets_error(exc) from None
    except DBAPIError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, pg_error(exc).message) from None
    return result


async def _reconcile(ctx: SchoolContext, op: Any) -> dict:
    """Ask Razorpay what happened to an order and record it (used by staff and parents)."""
    async with payments_session() as pdb:
        if op.gateway_order_id is None:
            await pdb.execute(
                text("select private.pay_cancel(:id, :r)"), {"id": op.id, "r": "The order was never created."}
            )
            await pdb.commit()
            return {"status": "cancelled"}
        creds = await _creds(pdb, ctx.school_id)
        if creds is None:
            raise HTTPException(status.HTTP_409_CONFLICT, "The payment gateway isn't set up.")
        client = creds.client()
        attempts = await client.order_payments(op.gateway_order_id)
        done = [p for p in attempts if p.get("status") in ("captured", "authorized")]
        if done:
            result = await _settle(pdb, op, done[0], client, "reconcile")
        elif attempts:
            failed = sorted(attempts, key=lambda p: p.get("created_at") or 0)[-1]
            result = await _settle(pdb, op, failed, client, "reconcile")
        else:
            age = await pdb.scalar(
                text("select now() - cast(:c as timestamptz) > interval '1 day'"), {"c": op.created_at}
            )
            if age and op.status == "created":
                await pdb.execute(
                    text("select private.pay_cancel(:id, :r)"), {"id": op.id, "r": "No payment was made."}
                )
                result = {"status": "cancelled"}
            else:
                result = {"status": op.status}
        await pdb.commit()
        return result


@router.post("/{op_id}/check")
async def check_payment(
    op_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """A parent asks again ("I paid but it says pending")."""
    await limit(request, "pay-check", 10, 60, key=str(user.id))
    op = await _visible(db, ctx, op_id)
    if op.status not in ("created", "failed"):
        return {"status": op.status}
    try:
        return await _reconcile(ctx, op)
    except GatewayError as exc:
        raise _gateway_error(exc) from None
    except secrets.SecretsUnavailable as exc:
        raise _secrets_error(exc) from None


def _row(r: Any) -> dict:
    return {
        "id": str(r.id),
        "student_id": str(r.student_id),
        "student_name": r.student_name,
        "class_section": r.class_section,
        "amount": f"{r.amount:.2f}",
        "description": r.description,
        "status": r.status,
        "method": r.method,
        "method_detail": r.method_detail,
        "failure_reason": r.failure_reason,
        "gateway_order_id": r.gateway_order_id,
        "gateway_payment_id": r.gateway_payment_id,
        "fee_payment_id": str(r.fee_payment_id) if r.fee_payment_id else None,
        "receipt_number": r.receipt_number,
        "verified_via": r.verified_via,
        "refunded_amount": f"{r.refunded_amount:.2f}",
        "created_at": r.created_at.isoformat(),
        "paid_at": r.paid_at.isoformat() if r.paid_at else None,
    }


_SELECT = (
    "select o.id, o.student_id, st.full_name as student_name, c.name || ' – ' || sec.name as class_section, "
    "o.amount, o.description, o.status::text as status, o.method, o.method_detail, o.failure_reason, "
    "o.gateway_order_id, o.gateway_payment_id, o.fee_payment_id, fp.receipt_number, o.verified_via, "
    "o.refunded_amount, o.created_at, o.paid_at "
    "from public.online_payments o join public.students st on st.id = o.student_id "
    "join public.student_enrollments e on e.id = o.enrollment_id join public.classes c on c.id = e.class_id "
    "join public.sections sec on sec.id = e.section_id left join public.fee_payments fp on fp.id = o.fee_payment_id "
)


async def _refunds(db: AsyncSession, ids: list[uuid.UUID]) -> dict[str, list[dict]]:
    if not ids:
        return {}
    rows = (
        await db.execute(
            text(
                "select online_payment_id, gateway_refund_id, amount, status, reason, failure_reason, created_at, "
                "processed_at from public.online_payment_refunds where online_payment_id = any(:ids) "
                "order by created_at"
            ).bindparams(bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))),
            {"ids": ids},
        )
    ).all()
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(str(r[0]), []).append(
            {
                "gateway_refund_id": r[1],
                "amount": f"{r[2]:.2f}",
                "status": r[3],
                "reason": r[4],
                "failure_reason": r[5],
                "created_at": r[6].isoformat(),
                "processed_at": r[7].isoformat() if r[7] else None,
            }
        )
    return out


@router.get("/students/{student_id}")
async def student_history(
    student_id: uuid.UUID,
    ctx: SchoolContext = PARENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """A parent's online payments for one child (RLS limits rows to their own children)."""
    from app.api.v1.routes.portal import _link

    await _link(db, ctx, user, student_id)
    rows = (
        await db.execute(
            # abandoned attempts (closed without paying) drop out after a day; staff still see them
            text(
                _SELECT + "where o.student_id = :st and o.school_id = :s and o.status <> 'cancelled' "
                "and not (o.status = 'created' and o.created_at < now() - interval '1 day') "
                "order by o.created_at desc limit 100"
            ),
            {"st": student_id, "s": ctx.school_id},
        )
    ).all()
    refunds = await _refunds(db, [r.id for r in rows])
    return [{**_row(r), "refunds": refunds.get(str(r.id), [])} for r in rows]


async def _one(db: AsyncSession, ctx: SchoolContext, op_id: uuid.UUID) -> dict:
    r = (
        await db.execute(text(_SELECT + "where o.id = :id and o.school_id = :s"), {"id": op_id, "s": ctx.school_id})
    ).first()
    if r is None:
        raise NOT_FOUND
    return {**_row(r), "refunds": (await _refunds(db, [r.id])).get(str(r.id), [])}


@router.get("/{op_id}")
async def get_one(op_id: uuid.UUID, ctx: SchoolContext = PARENT, db: AsyncSession = Depends(get_db)) -> dict:
    """For the parent's page after paying (RLS: their own children's payments only)."""
    return await _one(db, ctx, op_id)


# ------------------------------------------------------------------ staff
@router.get("/online/list")
async def list_online(
    ctx: SchoolContext = STAFF,
    db: AsyncSession = Depends(get_db),
    status_filter: Status | None = Query(default=None, alias="status"),
    search: str | None = Query(default=None, max_length=100),
    date_from: date | None = None,
    date_to: date | None = None,
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    where, p = ["o.school_id = :s"], {"s": ctx.school_id}
    if date_from:
        where.append("o.created_at >= cast(:df as date)")
        p["df"] = date_from
    if date_to:
        where.append("o.created_at < cast(:dt as date) + 1")
        p["dt"] = date_to
    if search and search.strip():
        where.append(
            "(st.full_name ilike :q or st.student_code ilike :q or o.gateway_payment_id ilike :q "
            "or o.gateway_order_id ilike :q or fp.receipt_number ilike :q)"
        )
        p["q"] = "%" + search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    joins = (
        "from public.online_payments o join public.students st on st.id = o.student_id "
        "left join public.fee_payments fp on fp.id = o.fee_payment_id where "
    )
    base = " and ".join(where)
    counts = {
        r[0]: r[1]
        for r in (await db.execute(text(f"select o.status::text, count(*) {joins}{base} group by 1"), p)).all()
    }
    sums = (
        await db.execute(
            text(
                "select coalesce(sum(o.amount) filter (where o.gateway_payment_id is not null "
                "and o.status not in ('failed', 'created', 'cancelled')), 0), "
                f"coalesce(sum(o.refunded_amount), 0) {joins}{base}"
            ),
            p,
        )
    ).first()
    if status_filter:
        base += " and o.status = cast(:st as public.online_payment_status)"
        p["st"] = status_filter
    total = (await db.execute(text(f"select count(*) {joins}{base}"), p)).scalar_one()
    rows = (
        await db.execute(
            text(_SELECT + "where " + base + " order by o.created_at desc limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).all()
    refunds = await _refunds(db, [r.id for r in rows])
    return {
        "items": [{**_row(r), "refunds": refunds.get(str(r.id), [])} for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "counts": counts,
        "received": f"{sums[0]:.2f}",
        "refunded": f"{sums[1]:.2f}",
    }


@router.get("/online/{op_id}")
async def staff_get_one(op_id: uuid.UUID, ctx: SchoolContext = STAFF, db: AsyncSession = Depends(get_db)) -> dict:
    out = await _one(db, ctx, op_id)
    out["events"] = [
        {"event_type": r[0], "outcome": r[1], "received_at": r[2].isoformat()}
        for r in (
            await db.execute(
                text(
                    "select event_type, outcome, received_at from public.payment_webhook_events "
                    "where school_id = :s and gateway_order_id = :o order by id"
                ),
                {"s": ctx.school_id, "o": out["gateway_order_id"]},
            )
        ).all()
    ]
    return out


@router.post("/online/{op_id}/reconcile")
async def reconcile(
    op_id: uuid.UUID, request: Request, ctx: SchoolContext = COLLECT, db: AsyncSession = Depends(get_db)
) -> dict:
    op = await _visible(db, ctx, op_id)
    try:
        result = await _reconcile(ctx, op)
    except GatewayError as exc:
        raise _gateway_error(exc) from None
    except secrets.SecretsUnavailable as exc:
        raise _secrets_error(exc) from None
    await write_audit(
        db,
        request,
        action="payments.reconciled",
        entity_type="online_payment",
        entity_id=str(op_id),
        school_id=ctx.school_id,
        metadata={"result": result.get("status")},
    )
    await db.commit()
    return await staff_get_one(op_id, ctx=ctx, db=db)


class RefundIn(BaseModel):
    model_config = {"extra": "forbid"}
    reason: str = Field(min_length=3, max_length=300)

    @field_validator("reason", mode="before")
    @classmethod
    def _clean(cls, v: object) -> object:
        return " ".join(v.split()) if isinstance(v, str) else v


@router.post("/online/{op_id}/refund")
async def refund(
    op_id: uuid.UUID,
    payload: RefundIn,
    request: Request,
    ctx: SchoolContext = REFUND,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Full refund through Razorpay. The order row stays locked while the gateway is called,
    so two clicks can't refund twice."""
    await _visible(db, ctx, op_id)
    try:
        async with payments_session() as pdb:
            op = (
                await pdb.execute(
                    text(
                        "select id, amount, status::text as status, gateway_payment_id "
                        "from private.pay_lock_for_refund(:id, :s)"
                    ),
                    {"id": op_id, "s": ctx.school_id},
                )
            ).first()
            if op is None:
                raise NOT_FOUND
            if op.status not in ("paid", "needs_review", "refund_failed") or not op.gateway_payment_id:
                raise HTTPException(status.HTTP_409_CONFLICT, "Only a completed payment can be refunded.")
            creds = await _creds(pdb, ctx.school_id)
            if creds is None:
                raise HTTPException(status.HTTP_409_CONFLICT, "The payment gateway isn't set up.")
            res = await creds.client().refund(
                op.gateway_payment_id,
                to_paise(op.amount),
                notes={"online_payment_id": str(op_id), "reason": payload.reason[:200]},
                receipt=f"RF-{op_id.hex[:20]}",
            )
            if not res.get("id"):
                raise GatewayError("Razorpay didn't return a refund.")
            refund_status = {"processed": "processed", "failed": "failed"}.get(res.get("status") or "", "pending")
            await pdb.execute(
                text("select private.pay_record_refund(:id, :rid, :amt, :st, :reason, :actor)"),
                {
                    "id": op_id,
                    "rid": res["id"],
                    "amt": from_paise(int(res.get("amount") or 0)),
                    "st": refund_status,
                    "reason": payload.reason,
                    "actor": user.id,
                },
            )
            await pdb.commit()
    except GatewayError as exc:
        raise _gateway_error(exc) from None
    except secrets.SecretsUnavailable as exc:
        raise _secrets_error(exc) from None
    except DBAPIError as exc:
        # Razorpay accepted the refund but recording it failed: say so plainly (the webhook will retry).
        log.error("refund for %s accepted by Razorpay but not recorded: %s", op_id, pg_error(exc).message)
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Razorpay accepted the refund, but it couldn't be recorded: {pg_error(exc).message}",
        ) from None
    await write_audit(
        db,
        request,
        action="payments.refunded",
        entity_type="online_payment",
        entity_id=str(op_id),
        school_id=ctx.school_id,
        metadata={"reason": payload.reason},
    )
    await db.commit()
    return await staff_get_one(op_id, ctx=ctx, db=db)


# ------------------------------------------------------------------ webhooks (Razorpay -> API)
@router.post("/webhooks/razorpay/{school_id}", include_in_schema=False)
async def razorpay_webhook(school_id: uuid.UUID, request: Request) -> dict:
    """Signed by Razorpay with the school's webhook secret. 2xx = handled (or safely ignored);
    any other answer makes Razorpay retry later."""
    body = await request.body()
    if len(body) > 1_000_000:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Too large.")
    signature = request.headers.get("x-razorpay-signature")
    event_id = request.headers.get("x-razorpay-event-id") or "sha256:" + hashlib.sha256(body).hexdigest()
    try:
        async with payments_session() as pdb:
            creds = await _creds(pdb, school_id, need_webhook=True)
            if (
                creds is None
                or not creds.webhook_secret
                or not webhook_signature_ok(body, signature, creds.webhook_secret)
            ):
                log.warning("rejected webhook for school %s (bad or missing signature)", school_id)
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid signature.")
            try:
                event = json.loads(body)
            except ValueError:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid body.") from None
            kind = str(event.get("event") or "")
            payload = event.get("payload") or {}
            payment = (payload.get("payment") or {}).get("entity") or {}
            refund_e = (payload.get("refund") or {}).get("entity") or {}
            order_id = payment.get("order_id") or ((payload.get("order") or {}).get("entity") or {}).get("id")
            first = await pdb.scalar(
                text("select private.pay_log_event(:s, :e, :k, :o, :p, 'received')"),
                {"s": school_id, "e": event_id[:200], "k": kind[:60], "o": order_id, "p": payment.get("id")},
            )
            if not first:
                return {"status": "duplicate"}
            outcome = "ignored"
            if kind in ("payment.captured", "payment.authorized", "order.paid", "payment.failed") and payment:
                op = (
                    await pdb.execute(text("select * from private.pay_find(:s, :o)"), {"s": school_id, "o": order_id})
                ).first()
                if op is None:
                    outcome = "unknown order"
                else:
                    outcome = (await _settle(pdb, op, payment, creds.client(), "webhook"))["status"]
            elif kind.startswith("refund.") and refund_e.get("id"):
                st = {"refund.processed": "processed", "refund.failed": "failed"}.get(kind)
                if st:
                    changed = await pdb.scalar(
                        text("select private.pay_refund_update(:s, :r, :st, :f)"),
                        {"s": school_id, "r": refund_e["id"], "st": st, "f": refund_e.get("error_description")},
                    )
                    outcome = f"refund {st}" if changed else "refund unchanged"
            await pdb.execute(
                text("select private.pay_event_outcome(:s, :e, :o)"),
                {"s": school_id, "e": event_id[:200], "o": outcome},
            )
            await pdb.commit()
            return {"status": outcome}
    except DBAPIError as exc:
        # A permanent conflict (e.g. a second payment for one order): record it for staff, don't make
        # Razorpay retry for a day. Transient database errors still answer 500 so it retries.
        err = pg_error(exc)
        if err.sqlstate not in ("23514", "P0002"):
            raise
        log.error("webhook for school %s: %s", school_id, err.message)
        async with payments_session() as pdb:
            await pdb.execute(
                text("select private.pay_log_event(:s, :e, 'error', null, null, :o)"),
                {"s": school_id, "e": event_id[:200], "o": err.message[:300]},
            )
            await pdb.commit()
        return {"status": "error", "message": err.message}
    except GatewayError as exc:
        log.error("webhook for school %s: gateway error %s", school_id, exc.message)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Gateway error; please retry.") from None
    except secrets.SecretsUnavailable:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Not configured.") from None
