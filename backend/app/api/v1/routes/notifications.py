"""Notifications: the in-app inbox (everyone), preferences (everyone), and for school
admins the templates, channels (email / SMS / WhatsApp), history and test messages.
Fee reminders can be sent by admins and accountants. No voice calls of any kind.
"""

import json
import logging
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_feature, require_permission
from app.core.permissions import Permission
from app.core.ratelimit import limit
from app.db.errors import http_error_from_db
from app.db.session import notify_session
from app.services import secrets
from app.services.audit import write_audit
from app.services.notify import providers
from app.services.notify.catalog import EVENTS
from app.services.notify.render import TemplateError, render, sample_values, sms_info, validate
from app.services.notify.sender import templates_for

log = logging.getLogger("notify")
router = APIRouter(prefix="/notifications", tags=["notifications"])
ANYONE = Depends(require_permission(Permission.DASHBOARD_VIEW))  # every role of a school
ADMIN = Depends(require_permission(Permission.NOTIFICATIONS_MANAGE))
FEES = Depends(require_permission(Permission.FEES_COLLECT))
Channel = Literal["in_app", "email", "sms", "whatsapp"]
Outbound = Literal["email", "sms", "whatsapp"]


# ------------------------------------------------------------------ inbox (everyone)
@router.get("")
async def inbox(
    ctx: SchoolContext = ANYONE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    unread: bool = False,
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=20, ge=1, le=50),
) -> dict:
    where = "school_id = :s and user_id = :u" + (" and read_at is null" if unread else "")
    p = {"s": ctx.school_id, "u": user.id}
    total = (await db.execute(text(f"select count(*) from public.notifications where {where}"), p)).scalar_one()
    unread_n = (
        await db.execute(
            text("select count(*) from public.notifications where school_id = :s and user_id = :u and read_at is null"),
            p,
        )
    ).scalar_one()
    rows = (
        await db.execute(
            text(
                f"select id, event_key, title, body, link, read_at, created_at from public.notifications where {where} "
                "order by created_at desc limit :lim offset :off"
            ),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).all()
    return {
        "items": [
            {
                "id": str(r[0]),
                "event_key": r[1],
                "title": r[2],
                "body": r[3],
                "link": r[4],
                "read": r[5] is not None,
                "created_at": r[6].isoformat(),
            }
            for r in rows
        ],
        "total": total,
        "unread": unread_n,
        "page": page,
        "page_size": page_size,
    }


@router.get("/unread-count")
async def unread_count(
    ctx: SchoolContext = ANYONE, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    n = (
        await db.execute(
            text("select count(*) from public.notifications where school_id = :s and user_id = :u and read_at is null"),
            {"s": ctx.school_id, "u": user.id},
        )
    ).scalar_one()
    return {"unread": n}


@router.post("/read-all")
async def read_all(
    ctx: SchoolContext = ANYONE, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    res = await db.execute(
        text(
            "update public.notifications set read_at = now() where school_id = :s and user_id = :u and read_at is null"
        ),
        {"s": ctx.school_id, "u": user.id},
    )
    await db.commit()
    return {"marked": res.rowcount}


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: uuid.UUID,
    ctx: SchoolContext = ANYONE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    res = await db.execute(
        text(
            "update public.notifications set read_at = coalesce(read_at, now()) "
            "where id = :id and school_id = :s and user_id = :u"  # RLS also limits it to the user's own
        ),
        {"id": notification_id, "s": ctx.school_id, "u": user.id},
    )
    await db.commit()
    if res.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found.")
    return {"ok": True}


# ------------------------------------------------------------------ preferences (everyone)
class PreferencesIn(BaseModel):
    model_config = {"extra": "forbid"}
    email: bool
    sms: bool
    whatsapp: bool


@router.get("/preferences")
async def get_preferences(user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)) -> dict:
    rows = dict(
        (
            await db.execute(
                text("select channel, enabled from public.notification_preferences where user_id = :u"), {"u": user.id}
            )
        ).all()
    )
    return {ch: rows.get(ch, True) for ch in ("email", "sms", "whatsapp")}


@router.put("/preferences")
async def save_preferences(
    payload: PreferencesIn, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    for ch, on in payload.model_dump().items():
        await db.execute(
            text(
                "insert into public.notification_preferences (user_id, channel, enabled) values (:u, :c, :e) "
                "on conflict (user_id, channel) do update set enabled = excluded.enabled, updated_at = now()"
            ),
            {"u": user.id, "c": ch, "e": on},
        )
    await db.commit()
    return payload.model_dump()


# ------------------------------------------------------------------ fee reminders (admins, accountants)
class RemindersIn(BaseModel):
    model_config = {"extra": "forbid"}
    class_id: uuid.UUID | None = None


@router.post("/fee-reminders")
async def send_fee_reminders(
    payload: RemindersIn, request: Request, ctx: SchoolContext = FEES, db: AsyncSession = Depends(get_db)
) -> dict:
    try:
        n = (
            await db.execute(
                text("select private.send_fee_reminders(:s, :c)"), {"s": ctx.school_id, "c": payload.class_id}
            )
        ).scalar_one()
        await write_audit(
            db,
            request,
            action="notifications.fee_reminders",
            entity_type="school",
            entity_id=str(ctx.school_id),
            school_id=ctx.school_id,
            metadata={"class_id": str(payload.class_id) if payload.class_id else None, "students": n},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return {"students": n}


# ------------------------------------------------------------------ templates (admins)
def _setup_templates(rows: list[Any]) -> dict[str, Any]:
    return {"templates": [dict(r._mapping) for r in rows]}


async def _template_rows(db: AsyncSession, ctx: SchoolContext) -> list[Any]:
    return (
        await db.execute(
            text(
                "select event_key, channel, is_enabled, subject, body, wa_template, wa_language, wa_params, updated_at "
                "from public.notification_templates where school_id = :s"
            ),
            {"s": ctx.school_id},
        )
    ).all()


@router.get("/admin/events")
async def admin_events(ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)) -> list[dict]:
    rows = await _template_rows(db, ctx)
    customised = {(r.event_key, r.channel) for r in rows}
    out = []
    for key, ev in EVENTS.items():
        tpl = templates_for(key, _setup_templates(rows))
        out.append(
            {
                "key": key,
                "label": ev.label,
                "description": ev.description,
                "audience": ev.audience,
                "variables": ev.variables,
                "channels": {
                    ch: {
                        "enabled": t.enabled,
                        "subject": t.subject,
                        "body": t.body,
                        "wa_template": t.wa_template,
                        "wa_language": t.wa_language,
                        "wa_params": t.wa_params,
                        "customised": (key, ch) in customised,
                    }
                    for ch, t in tpl.items()
                },
            }
        )
    return out


class TemplateIn(BaseModel):
    model_config = {"extra": "forbid"}
    is_enabled: bool
    subject: str | None = Field(default=None, max_length=200)
    body: str | None = Field(default=None, max_length=2000)
    wa_template: str | None = Field(default=None, pattern=r"^[a-z0-9_]{1,512}$")
    wa_language: str | None = Field(default=None, pattern=r"^[a-z]{2,3}(_[A-Z]{2})?$")
    wa_params: list[str] | None = Field(default=None, max_length=10)

    @field_validator("subject", "body", "wa_template", "wa_language", mode="before")
    @classmethod
    def _blank(cls, v: object) -> object:
        return (v.strip() or None) if isinstance(v, str) else v


def _check_template(event_key: str, channel: str, t: TemplateIn) -> None:
    ev = EVENTS.get(event_key)
    if ev is None or channel not in ev.channels:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown message.")
    try:
        validate(ev, t.subject, t.body)
    except TemplateError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    unknown = [p for p in (t.wa_params or []) if p not in ev.variables]
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Unknown WhatsApp parameter: {unknown[0]}.")
    if channel == "whatsapp" and t.is_enabled and not t.wa_template:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter the name of the WhatsApp template approved by Meta."
        )
    if channel == "sms" and t.body and len(t.body) > 640:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Keep SMS text under 640 characters.")


@router.put("/admin/templates/{event_key}/{channel}")
async def save_template(
    event_key: str,
    channel: Channel,
    payload: TemplateIn,
    request: Request,
    ctx: SchoolContext = ADMIN,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    _check_template(event_key, channel, payload)
    try:
        await db.execute(
            text(
                "insert into public.notification_templates (school_id, event_key, channel, is_enabled, subject, body, "
                "wa_template, wa_language, wa_params, updated_by) values (:s, :e, :c, :en, :su, :b, :wt, :wl, "
                "cast(:wp as jsonb), :u) on conflict (school_id, event_key, channel) do update set "
                "is_enabled = excluded.is_enabled, subject = excluded.subject, body = excluded.body, "
                "wa_template = excluded.wa_template, wa_language = excluded.wa_language, "
                "wa_params = excluded.wa_params, "
                "updated_by = excluded.updated_by, updated_at = now()"
            ),
            {
                "s": ctx.school_id,
                "e": event_key,
                "c": channel,
                "en": payload.is_enabled,
                "su": payload.subject,
                "b": payload.body,
                "wt": payload.wa_template,
                "wl": payload.wa_language,
                "wp": json.dumps(payload.wa_params) if payload.wa_params is not None else None,
                "u": user.id,
            },
        )
        await write_audit(
            db,
            request,
            action="notifications.template_saved",
            entity_type="school",
            entity_id=str(ctx.school_id),
            school_id=ctx.school_id,
            metadata={"event": event_key, "channel": channel, "enabled": payload.is_enabled},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await admin_events(ctx=ctx, db=db)


@router.delete("/admin/templates/{event_key}/{channel}")
async def reset_template(
    event_key: str, channel: Channel, request: Request, ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    await db.execute(
        text("delete from public.notification_templates where school_id = :s and event_key = :e and channel = :c"),
        {"s": ctx.school_id, "e": event_key, "c": channel},
    )
    await write_audit(
        db,
        request,
        action="notifications.template_reset",
        entity_type="school",
        entity_id=str(ctx.school_id),
        school_id=ctx.school_id,
        metadata={"event": event_key, "channel": channel},
    )
    await db.commit()
    return await admin_events(ctx=ctx, db=db)


class PreviewIn(BaseModel):
    model_config = {"extra": "forbid"}
    event_key: str
    channel: Channel
    subject: str | None = Field(default=None, max_length=200)
    body: str = Field(max_length=2000)


@router.post("/admin/preview")
async def preview(payload: PreviewIn, ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)) -> dict:
    ev = EVENTS.get(payload.event_key)
    if ev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown message.")
    try:
        validate(ev, payload.subject, payload.body)
    except TemplateError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    school = (
        await db.execute(text("select name, phone from public.schools where id = :s"), {"s": ctx.school_id})
    ).first()
    values = {**sample_values(ev), "school_name": school[0], "school_phone": school[1] or ""}
    if payload.channel == "sms":
        values = {k: v.replace("₹", "Rs ") for k, v in values.items()}
    body = render(payload.body, values)
    return {
        "subject": render(payload.subject, values) if payload.subject else None,
        "body": body,
        "sms": sms_info(body) if payload.channel == "sms" else None,
        "note": "Sample data, for the preview only.",
    }


# ------------------------------------------------------------------ settings (admins)
class SettingsIn(BaseModel):
    model_config = {"extra": "forbid"}
    email_enabled: bool
    reply_to: EmailStr | None = None
    quiet_start: int = Field(ge=0, le=23)
    quiet_end: int = Field(ge=0, le=23)
    fee_reminder_days: list[int] = Field(default_factory=list, max_length=6)
    sms_daily_limit: int = Field(ge=0, le=100000)
    whatsapp_daily_limit: int = Field(ge=0, le=100000)

    @field_validator("fee_reminder_days")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        if any(d < 1 or d > 28 for d in v):
            raise ValueError("Reminder days must be between 1 and 28 (every month has them).")
        return sorted(set(v))

    @field_validator("reply_to", mode="before")
    @classmethod
    def _blank(cls, v: object) -> object:
        return (v.strip() or None) if isinstance(v, str) else v


DEFAULT_SETTINGS = {
    "email_enabled": True,
    "reply_to": None,
    "quiet_start": 21,
    "quiet_end": 8,
    "fee_reminder_days": [],
    "sms_daily_limit": 500,
    "whatsapp_daily_limit": 500,
}


async def _settings_out(db: AsyncSession, ctx: SchoolContext) -> dict:
    r = (
        (
            await db.execute(
                text(
                    "select email_enabled, reply_to, quiet_start, quiet_end, fee_reminder_days, sms_daily_limit, "
                    "whatsapp_daily_limit from public.notification_settings where school_id = :s"
                ),
                {"s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    s = get_settings()
    out = {**DEFAULT_SETTINGS, **(dict(r) if r else {})}
    out["fee_reminder_days"] = list(out["fee_reminder_days"] or [])
    out["email_server"] = {"configured": providers.email_configured(), "from": s.email_from or None}
    return out


@router.get("/admin/settings")
async def get_notify_settings(ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)) -> dict:
    return await _settings_out(db, ctx)


@router.put("/admin/settings")
async def save_notify_settings(
    payload: SettingsIn,
    request: Request,
    ctx: SchoolContext = ADMIN,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    v = payload.model_dump()
    try:
        await db.execute(
            text(
                "insert into public.notification_settings (school_id, email_enabled, reply_to, quiet_start, quiet_end, "
                "fee_reminder_days, sms_daily_limit, whatsapp_daily_limit, updated_by) values (:s, :ee, :rt, :qs, :qe, "
                "cast(:fd as smallint[]), :sl, :wl, "
                ":u) on conflict (school_id) do update set email_enabled = excluded.email_enabled, "
                "reply_to = excluded.reply_to, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, "
                "fee_reminder_days = excluded.fee_reminder_days, sms_daily_limit = excluded.sms_daily_limit, "
                "whatsapp_daily_limit = excluded.whatsapp_daily_limit, updated_by = excluded.updated_by, "
                "updated_at = now()"
            ),
            {
                "s": ctx.school_id,
                "ee": v["email_enabled"],
                "rt": v["reply_to"],
                "qs": v["quiet_start"],
                "qe": v["quiet_end"],
                "fd": v["fee_reminder_days"],
                "sl": v["sms_daily_limit"],
                "wl": v["whatsapp_daily_limit"],
                "u": user.id,
            },
        )
        await write_audit(
            db,
            request,
            action="notifications.settings_saved",
            entity_type="school",
            entity_id=str(ctx.school_id),
            school_id=ctx.school_id,
            metadata={k: v[k] for k in ("email_enabled", "quiet_start", "quiet_end", "fee_reminder_days")},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _settings_out(db, ctx)


# ------------------------------------------------------------------ channels (admins)
def _webhooks(ctx: SchoolContext) -> dict:
    base = get_settings().public_api_url.rstrip("/")
    return {
        "sms": f"{base}/api/v1/notifications/webhooks/twilio/{ctx.school_id}",
        "whatsapp": f"{base}/api/v1/notifications/webhooks/whatsapp/{ctx.school_id}",
    }


async def _channels_out(db: AsyncSession, ctx: SchoolContext) -> dict:
    rows = (
        (
            await db.execute(
                text(
                    "select channel, provider, config, has_webhook_secret, verify_token, is_enabled, updated_at "
                    "from private.messaging_account_info(:s)"
                ),
                {"s": ctx.school_id},
            )
        )
        .mappings()
        .all()
    )
    acc = {r["channel"]: r for r in rows}
    hooks = _webhooks(ctx)
    out: dict[str, Any] = {}
    for ch in ("sms", "whatsapp"):
        r = acc.get(ch)
        out[ch] = {
            "configured": r is not None,
            "enabled": bool(r and r["is_enabled"]),
            "provider": "twilio" if ch == "sms" else "meta",
            "config": dict(r["config"]) if r else {},
            "has_app_secret": bool(r and r["has_webhook_secret"]),
            "verify_token": r["verify_token"] if r and ch == "whatsapp" else None,
            "updated_at": r["updated_at"].isoformat() if r else None,
            "webhook_url": hooks[ch],
        }
    return out


@router.get("/admin/channels")
async def get_channels(ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)) -> dict:
    return await _channels_out(db, ctx)


class SmsIn(BaseModel):
    model_config = {"extra": "forbid"}
    account_sid: str = Field(pattern=r"^AC[0-9a-fA-F]{32}$")
    auth_token: str | None = Field(default=None, min_length=16, max_length=100)  # empty = keep
    from_number: str | None = Field(default=None, pattern=r"^\+[1-9][0-9]{6,14}$")
    messaging_service_sid: str | None = Field(default=None, pattern=r"^MG[0-9a-fA-F]{32}$")
    enabled: bool

    @field_validator("auth_token", "from_number", "messaging_service_sid", mode="before")
    @classmethod
    def _blank(cls, v: object) -> object:
        return (v.strip() or None) if isinstance(v, str) else v


class WhatsAppIn(BaseModel):
    model_config = {"extra": "forbid"}
    phone_number_id: str = Field(pattern=r"^[0-9]{6,30}$")
    access_token: str | None = Field(default=None, min_length=20, max_length=1000)  # empty = keep
    app_secret: str | None = Field(default=None, min_length=16, max_length=200)
    enabled: bool

    @field_validator("access_token", "app_secret", mode="before")
    @classmethod
    def _blank(cls, v: object) -> object:
        return (v.strip() or None) if isinstance(v, str) else v


async def _save_account(
    db: AsyncSession,
    request: Request,
    ctx: SchoolContext,
    channel: str,
    config: dict,
    secret: str | None,
    hook: str | None,
    enabled: bool,
) -> dict:
    try:
        secret_enc = secrets.encrypt(secret) if secret else None
        hook_enc = secrets.encrypt(hook) if hook else None
    except secrets.SecretsUnavailable as exc:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from None
    try:
        await db.execute(
            text("select private.save_messaging_account(:s, :c, cast(:cfg as jsonb), :se, :he, :en)"),
            {
                "s": ctx.school_id,
                "c": channel,
                "cfg": json.dumps(config),
                "se": secret_enc,
                "he": hook_enc,
                "en": enabled,
            },
        )
        await write_audit(
            db,
            request,
            action="notifications.channel_saved",
            entity_type="school",
            entity_id=str(ctx.school_id),
            school_id=ctx.school_id,
            metadata={
                "channel": channel,
                "enabled": enabled,
                "token_changed": bool(secret),
                "secret_changed": bool(hook),
            },
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _channels_out(db, ctx)


@router.put("/admin/channels/sms")
async def save_sms(
    payload: SmsIn, request: Request, ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)
) -> dict:
    if not (payload.from_number or payload.messaging_service_sid):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter the sender number or a messaging service SID."
        )
    cfg = {
        "account_sid": payload.account_sid,
        "from_number": payload.from_number,
        "messaging_service_sid": payload.messaging_service_sid,
    }
    return await _save_account(db, request, ctx, "sms", cfg, payload.auth_token, None, payload.enabled)


@router.put("/admin/channels/whatsapp", dependencies=[Depends(require_feature("whatsapp"))])
async def save_whatsapp(
    payload: WhatsAppIn, request: Request, ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)
) -> dict:
    return await _save_account(
        db,
        request,
        ctx,
        "whatsapp",
        {"phone_number_id": payload.phone_number_id},
        payload.access_token,
        payload.app_secret,
        payload.enabled,
    )


class TestIn(BaseModel):
    model_config = {"extra": "forbid"}
    channel: Outbound
    address: str = Field(min_length=5, max_length=200)


@router.post("/admin/test")
async def send_test(
    payload: TestIn, request: Request, ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)
) -> dict:
    await limit(request, "notify-test", 20, 600, key=str(ctx.school_id))
    address = payload.address.strip()
    if payload.channel == "email":
        if "@" not in address:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter an email address.")
    elif providers.e164(address) is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter a mobile number with the country code, e.g. +91 98765 43210."
        )
    try:
        event_id = (
            await db.execute(
                text("select private.notify_test(:s, :c, :a)"), {"s": ctx.school_id, "c": payload.channel, "a": address}
            )
        ).scalar_one()
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return {"event_id": str(event_id), "message": "Queued. It appears in the history within a few seconds."}


# ------------------------------------------------------------------ history (admins)
@router.get("/admin/history")
async def history(
    ctx: SchoolContext = ADMIN,
    db: AsyncSession = Depends(get_db),
    event_key: str | None = Query(default=None, max_length=40),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    where, p = "e.school_id = :s", {"s": ctx.school_id}
    if event_key:
        where += " and e.event_key = :k"
        p["k"] = event_key
    total = (await db.execute(text(f"select count(*) from public.notification_events e where {where}"), p)).scalar_one()
    rows = (
        await db.execute(
            text(
                "select e.id, e.event_key, e.status, e.error, e.recipients, e.created_at, e.processed_at, "
                "pr.full_name, "
                "0 as in_app, "
                "(select coalesce(jsonb_object_agg(x.k, x.n), '{}') from (select d.channel || ':' || d.status as k, "
                "count(*) as n "
                " from public.notification_deliveries d where d.event_id = e.id group by 1) x) as counts "
                f"from public.notification_events e left join public.profiles pr on pr.id = e.created_by where {where} "
                "order by e.created_at desc limit :lim offset :off"
            ),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).all()
    labels = {k: e.label for k, e in EVENTS.items()} | {"test": "Test message"}
    stats = {
        str(r[0]): r[1]
        for r in (
            await db.execute(
                text("select event_id, sent from private.notify_in_app_stats(:s, cast(:ids as uuid[]))"),
                {"s": ctx.school_id, "ids": [str(r[0]) for r in rows]},
            )
        ).all()
    }
    return {
        "items": [
            {
                "id": str(r[0]),
                "event_key": r[1],
                "label": labels.get(r[1], r[1]),
                "status": r[2],
                "error": r[3],
                "recipients": r[4],
                "created_at": r[5].isoformat(),
                "processed_at": r[6].isoformat() if r[6] else None,
                "triggered_by": r[7],
                "in_app": stats.get(str(r[0]), 0),
                "counts": r[9],
            }
            for r in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/admin/history/{event_id}")
async def history_detail(event_id: uuid.UUID, ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)) -> dict:
    e = (
        await db.execute(
            text(
                "select id, event_key, status, error, recipients, payload, created_at from public.notification_events "
                "where id = :id and school_id = :s"
            ),
            {"id": event_id, "s": ctx.school_id},
        )
    ).first()
    if e is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found.")
    rows = (
        (
            await db.execute(
                text(
                    "select id, channel, recipient_name, recipient_kind, address, subject, body, wa_template, "
                    "status, error, "
                    "attempts, provider, provider_message_id, sent_at, updated_at, next_attempt_at "
                    "from public.notification_deliveries where event_id = :id order by channel, recipient_name"
                ),
                {"id": event_id},
            )
        )
        .mappings()
        .all()
    )
    in_app = (
        await db.execute(
            text("select sent, read from private.notify_in_app_stats(:s, array[cast(:id as uuid)])"),
            {"s": ctx.school_id, "id": str(event_id)},
        )
    ).first() or (0, 0)
    return {
        "id": str(e[0]),
        "event_key": e[1],
        "status": e[2],
        "error": e[3],
        "recipients": e[4],
        "created_at": e[6].isoformat(),
        "in_app": {"sent": in_app[0], "read": in_app[1]},
        "deliveries": [
            {
                **{k: v for k, v in r.items() if k not in ("sent_at", "updated_at", "next_attempt_at")},
                "id": str(r["id"]),
                "sent_at": r["sent_at"].isoformat() if r["sent_at"] else None,
                "updated_at": r["updated_at"].isoformat(),
                "next_attempt_at": r["next_attempt_at"].isoformat(),
            }
            for r in rows
        ],
    }


@router.post("/admin/deliveries/{delivery_id}/retry")
async def retry(delivery_id: uuid.UUID, ctx: SchoolContext = ADMIN, db: AsyncSession = Depends(get_db)) -> dict:
    try:
        await db.execute(text("select private.notify_retry(:d)"), {"d": delivery_id})
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return {"ok": True}


# ------------------------------------------------------------------ delivery reports (providers -> API)
async def _account(school_id: uuid.UUID, channel: str) -> dict | None:
    async with notify_session() as db:
        r = (
            (
                await db.execute(
                    text("select * from private.notify_channel_secrets(:s, :c)"), {"s": school_id, "c": channel}
                )
            )
            .mappings()
            .first()
        )
    return dict(r) if r else None


async def _report(school_id: uuid.UUID, provider: str, pid: str, st: str, error: str | None) -> bool:
    async with notify_session() as db:
        changed = (
            await db.execute(
                text("select private.notify_delivery_status(:s, :p, :id, :st, :e)"),
                {"s": school_id, "p": provider, "id": pid, "st": st, "e": error},
            )
        ).scalar()
        await db.commit()
    return bool(changed)


@router.post("/webhooks/twilio/{school_id}", include_in_schema=False)
async def twilio_status(school_id: uuid.UUID, request: Request) -> dict:
    form = {k: str(v) for k, v in (await request.form()).items()}
    acc = await _account(school_id, "sms")
    if acc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found.")
    try:
        token = secrets.decrypt(acc["secret_enc"])
    except secrets.SecretsUnavailable:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Not configured.") from None
    url = f"{get_settings().public_api_url.rstrip('/')}/api/v1/notifications/webhooks/twilio/{school_id}"
    if not providers.twilio_signature_ok(url, form, request.headers.get("x-twilio-signature"), token):
        log.warning("rejected Twilio status report for school %s (bad signature)", school_id)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid signature.")
    st = providers.TWILIO_STATUS.get(form.get("MessageStatus", ""))
    if st and form.get("MessageSid"):
        err = f"Twilio error {form['ErrorCode']}" if form.get("ErrorCode") else None
        await _report(school_id, "twilio", form["MessageSid"], st, err)
    return {"ok": True}


@router.get("/webhooks/whatsapp/{school_id}", include_in_schema=False)
async def whatsapp_verify(school_id: uuid.UUID, request: Request) -> PlainTextResponse:
    """Meta's one-time check when the webhook is added: echo the challenge if the token matches."""
    q = request.query_params
    acc = await _account(school_id, "whatsapp")
    if acc and q.get("hub.mode") == "subscribe" and q.get("hub.verify_token") == acc["verify_token"]:
        return PlainTextResponse(q.get("hub.challenge", ""))
    raise HTTPException(status.HTTP_403_FORBIDDEN, "Verification failed.")


@router.post("/webhooks/whatsapp/{school_id}", include_in_schema=False)
async def whatsapp_status(school_id: uuid.UUID, request: Request) -> dict:
    body = await request.body()
    acc = await _account(school_id, "whatsapp")
    if acc is None or not acc["webhook_secret_enc"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found.")
    try:
        app_secret = secrets.decrypt(acc["webhook_secret_enc"])
    except secrets.SecretsUnavailable:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Not configured.") from None
    if not providers.meta_signature_ok(body, request.headers.get("x-hub-signature-256"), app_secret):
        log.warning("rejected WhatsApp webhook for school %s (bad signature)", school_id)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Invalid signature.")
    try:
        data = json.loads(body)
    except ValueError:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid body.") from None
    for entry in data.get("entry") or []:
        for change in entry.get("changes") or []:
            for s in (change.get("value") or {}).get("statuses") or []:
                st = providers.WHATSAPP_STATUS.get(s.get("status", ""))
                if st and s.get("id"):
                    errs = s.get("errors") or []
                    err = (
                        f"WhatsApp {errs[0].get('code')}: {errs[0].get('title') or errs[0].get('message')}"
                        if errs
                        else None
                    )
                    await _report(school_id, "meta", s["id"], st, err)
    return {"ok": True}
