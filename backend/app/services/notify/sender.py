"""The background sender.

Loop (every few seconds, in the API process or as `python -m scripts.notify_worker`):
  1. regular jobs: notices that reached their time, automatic fee reminders;
  2. events -> messages: who gets what, in which channel, rendered from the templates;
  3. messages -> providers: email / SMS / WhatsApp, with retries, quiet hours and daily limits;
  4. in-app notifications -> Web Push to each of the person's devices (app/services/push.py).
Several API processes can run it at once: work is claimed with SKIP LOCKED.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import notify_session
from app.services import push, secrets
from app.services.notify import providers
from app.services.notify.catalog import MODE_LABEL, STATUS_LABEL, Default
from app.services.notify.render import email_html, event, render

log = logging.getLogger("notify")
IST = ZoneInfo("Asia/Kolkata")
MONEY = {"amount", "balance", "amount_due", "total_outstanding", "admission_fee", "fine_so_far"}
DATES = {"payment_date", "date", "due_date", "first_date", "last_date"}
RETRY_MINUTES = (1, 5, 30)  # after the 1st, 2nd and 3rd failed attempts; then it stays failed
OUTBOUND = ("email", "sms", "whatsapp")


# ------------------------------------------------------------------ formatting
def inr(v: Any) -> str:
    d = Decimal(str(v)).quantize(Decimal("0.01"))
    whole, frac = f"{d:.2f}".split(".")
    neg = whole.startswith("-")
    whole = whole.lstrip("-")
    if len(whole) > 3:  # Indian grouping: 12,34,567
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups) + "," + tail
    return ("-" if neg else "") + "₹" + whole + ("" if frac == "00" else "." + frac)


def nice_date(v: Any) -> str:
    if not v:
        return ""
    d = v if isinstance(v, date) else date.fromisoformat(str(v)[:10])
    return f"{d.day} {d:%b %Y}"


def join_names(names: list[str]) -> str:
    names = list(dict.fromkeys(n for n in names if n))
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1] if names else ""


# ------------------------------------------------------------------ links
def in_app_link(event_key: str, kind: str, student_id: str | None, v: dict[str, Any]) -> str | None:
    if event_key == "notice_published":
        return "/notices"
    if kind == "parent" and student_id:
        base = f"/portal/{student_id}"
        return {
            "fee_reminder": f"{base}?tab=Fees",
            "payment_received": f"{base}?tab=Fees",
            "student_absent": f"{base}?tab=Attendance",
            "homework_assigned": f"{base}/homework/{v.get('homework_id')}",
            "exam_scheduled": f"{base}?tab=Exam%20results",
            "results_published": f"{base}?tab=Exam%20results",
            "library_overdue": f"{base}?tab=Library",
        }.get(event_key)
    if kind == "student":
        return {
            "fee_reminder": "/my?tab=Fees",
            "payment_received": "/my?tab=Fees",
            "student_absent": "/my?tab=Attendance",
            "homework_assigned": f"/my/homework/{v.get('homework_id')}",
            "exam_scheduled": "/my?tab=Exams",
            "results_published": "/my?tab=Results",
            "library_overdue": "/my?tab=Library",
        }.get(event_key)
    return None


def status_detail(v: dict[str, Any]) -> str:
    st = v.get("status")
    if st == "rejected":
        return f"Reason: {v.get('reason')}" if v.get("reason") else "Please contact the school office for details."
    if st == "approved":
        fee = v.get("admission_fee")
        return (
            f"Please pay the admission fee of {inr(fee)} at the school office."
            if fee not in (None, 0, "0", "0.00")
            else "The school office will contact you about the next step."
        )
    return {
        "submitted": "We will review it and keep you informed.",
        "under_review": "The school is reviewing the application.",
        "verified": "Your documents have been verified.",
        "fee_paid": "Thank you. The school will complete the admission shortly.",
        "enrolled": "Welcome to the school!",
    }.get(str(st), "")


# ------------------------------------------------------------------ event -> messages (pure)
@dataclass
class Template:
    enabled: bool
    subject: str | None
    body: str
    wa_template: str | None = None
    wa_language: str | None = None
    wa_params: list[str] | None = None


def templates_for(event_key: str, setup: dict[str, Any], test_channel: str | None = None) -> dict[str, Template]:
    ev = event(event_key)
    rows = {(t["event_key"], t["channel"]): t for t in setup.get("templates") or []}
    out: dict[str, Template] = {}
    for ch in ev.channels:
        d: Default = ev.defaults[ch]
        r = rows.get((event_key, ch))
        if event_key == "test":
            out[ch] = Template(ch == test_channel, d.subject, d.body, "hello_world", "en_US", [])
            continue
        out[ch] = Template(
            enabled=r["is_enabled"] if r else d.enabled,
            subject=(r or {}).get("subject") or d.subject,
            body=(r or {}).get("body") or d.body,
            wa_template=(r or {}).get("wa_template"),
            wa_language=(r or {}).get("wa_language") or "en",
            wa_params=(r or {}).get("wa_params") or list(ev.wa_params),
        )
    return out


def quiet_until(now: datetime, start: int, end: int) -> datetime | None:
    """If `now` (any timezone) falls in the quiet hours (India time), when they end."""
    local = now.astimezone(IST)
    h = local.hour
    quiet = (start > end and (h >= start or h < end)) or (start < end and start <= h < end)
    if not quiet:
        return None
    day = local.date() if h < end else local.date() + timedelta(days=1)
    return datetime(day.year, day.month, day.day, end, tzinfo=IST)


def build_messages(
    ev_row: dict[str, Any],
    ctx: dict[str, Any],
    setup: dict[str, Any],
    opted_out: set[tuple[str, str]],
    *,
    now: datetime,
    frontend_url: str,
    email_ready: bool,
) -> tuple[list[dict], list[dict], int]:
    """(in-app items, outbound messages, number of people) for one event."""
    key = ev_row["event_key"]
    payload = ev_row.get("payload") or {}
    test_channel = payload.get("channel") if key == "test" else None
    tpl = templates_for(key, setup, test_channel)
    school = ctx.get("school") or {}
    settings = setup.get("settings") or {}
    channels_on = setup.get("channels") or {}
    base_vars: dict[str, Any] = {"school_name": school.get("name") or "", "school_phone": school.get("phone") or ""}
    v = dict(ctx.get("vars") or {})
    for k in list(v):
        if k in MONEY and v[k] is not None:
            v[k] = inr(v[k])
        elif k in DATES:
            v[k] = nice_date(v[k])
    if "payment_mode" in v:
        v["payment_mode"] = MODE_LABEL.get(str(v["payment_mode"]), v["payment_mode"])
    if key == "admission_update":
        raw = ctx.get("vars") or {}
        v["status_label"] = STATUS_LABEL.get(str(raw.get("status")), str(raw.get("status")))
        v["status_detail"] = status_detail(raw)
        code = str(school.get("code") or "").lower()
        v["track_link"] = (
            f"{frontend_url.rstrip('/')}/apply/{code}/track?number={quote(str(raw.get('application_number')))}"
        )
    front = frontend_url.rstrip("/")
    quiet_end = quiet_until(now, int(settings.get("quiet_start", 21)), int(settings.get("quiet_end", 8)))

    in_app: list[dict] = []
    seen_in_app: set[tuple[str, str | None]] = set()
    outbound: dict[tuple[str, str], dict] = {}
    people: set[str] = set()
    for r in ctx.get("recipients") or []:
        if not r:
            continue
        kind, uid, sid = r.get("kind"), r.get("user_id"), r.get("student_id")
        people.add(uid or r.get("phone") or r.get("email") or "")
        link = in_app_link(key, kind, sid, v)
        vars_r = {
            **base_vars,
            **v,
            "recipient_name": r.get("name") or "",
            "student_name": r.get("student_name") or v.get("student_name", ""),
        }
        vars_r["portal_link"] = front + (link or ("/notices" if key == "notice_published" else "/dashboard"))
        # in-app: account holders only
        t = tpl.get("in_app")
        if t and t.enabled and uid and (uid, link) not in seen_in_app:
            seen_in_app.add((uid, link))
            in_app.append(
                {
                    "user_id": uid,
                    "title": render(t.subject, vars_r)[:200] or "Notification",
                    "body": render(t.body, vars_r)[:2000],
                    "link": link,
                }
            )
        # outbound: one message per channel and address; several children are named together
        for ch in OUTBOUND:
            t = tpl.get(ch)
            if not t or not t.enabled:
                continue
            if ch == "email":
                address = (r.get("email") or "").strip().lower() or None
            else:
                address = providers.e164(r.get("phone")) if kind != "student" else None
            if not address:
                continue
            if uid and (uid, ch) in opted_out:
                continue
            k = (ch, address)
            if k in outbound:
                outbound[k]["_students"].append(r.get("student_name"))
                continue
            outbound[k] = {
                "_t": t,
                "_vars": vars_r,
                "_students": [r.get("student_name")],
                "user_id": uid,
                "student_id": sid,
                "name": r.get("name"),
                "kind": kind,
                "channel": ch,
                "address": address,
            }

    deliveries: list[dict] = []
    for (ch, _), m in outbound.items():
        t, vars_r = m.pop("_t"), m.pop("_vars")
        names = m.pop("_students")
        if any(names):
            vars_r = {**vars_r, "student_name": join_names([n for n in names if n])}
        if ch == "sms":  # "Rs" keeps an SMS in the cheaper GSM-7 alphabet (₹ makes it Unicode)
            vars_r = {k: (x.replace("₹", "Rs ") if isinstance(x, str) else x) for k, x in vars_r.items()}
        d = {**m, "body": render(t.body, vars_r)}
        if ch == "email":
            d["subject"] = render(t.subject, vars_r)[:200] or "Message from " + base_vars["school_name"]
            if not email_ready:
                d.update(status="skipped", error="Email isn't set up on the server, or is turned off for the school.")
        else:
            if not channels_on.get(ch):
                d.update(
                    status="skipped",
                    error=f"{'SMS' if ch == 'sms' else 'WhatsApp'} isn't set up or turned on for the school.",
                )
            elif quiet_end and key != "test":
                d["not_before"] = quiet_end.isoformat()
            if ch == "whatsapp":
                if not t.wa_template:
                    d.update(status="skipped", error="Choose the approved WhatsApp template for this message.")
                d.update(
                    wa_template=t.wa_template,
                    wa_language=t.wa_language,
                    wa_params=[render("{{" + p + "}}", vars_r) for p in (t.wa_params or [])],
                )
        deliveries.append(d)
    return in_app, deliveries, len(people)


# ------------------------------------------------------------------ database steps
async def process_events(limit: int = 20) -> int:
    async with notify_session() as db:
        rows = (await db.execute(text("select * from private.notify_claim_events(:n)"), {"n": limit})).mappings().all()
        await db.commit()
    for ev_row in rows:
        try:
            await _process_one(dict(ev_row))
        except Exception as exc:  # noqa: BLE001 - one bad event must not stop the others
            log.exception("notification event %s failed", ev_row["id"])
            async with notify_session() as db:
                await db.execute(
                    text("select private.notify_store(:id, '[]', '[]', 'failed', :e, 0)"),
                    {"id": ev_row["id"], "e": f"{type(exc).__name__}: {exc}"[:500]},
                )
                await db.commit()
    return len(rows)


async def _process_one(ev_row: dict[str, Any]) -> None:
    s = get_settings()
    async with notify_session() as db:
        ctx = (await db.execute(text("select private.notify_event_context(:id)"), {"id": ev_row["id"]})).scalar()
        if ctx.get("skip"):
            await db.execute(
                text("select private.notify_store(:id, '[]', '[]', 'skipped', :e, 0)"),
                {"id": ev_row["id"], "e": ctx["skip"]},
            )
            await db.commit()
            return
        setup = (await db.execute(text("select private.notify_school_setup(:s)"), {"s": ev_row["school_id"]})).scalar()
        users = list({r["user_id"] for r in ctx.get("recipients") or [] if r and r.get("user_id")})
        opted = set()
        if users:
            opted = {
                (str(r[0]), r[1])
                for r in (
                    await db.execute(
                        text("select user_id, channel from private.notify_opt_outs(cast(:u as uuid[]))"), {"u": users}
                    )
                ).all()
            }
        email_ready = providers.email_configured() and bool((setup.get("settings") or {}).get("email_enabled", True))
        in_app, deliveries, people = build_messages(
            ev_row, ctx, setup, opted, now=datetime.now(IST), frontend_url=s.frontend_url, email_ready=email_ready
        )
        status = "done" if (in_app or deliveries) else "skipped"
        await db.execute(
            text("select private.notify_store(:id, cast(:a as jsonb), cast(:d as jsonb), :st, :e, :n)"),
            {
                "id": ev_row["id"],
                "a": json.dumps(in_app),
                "d": json.dumps(deliveries),
                "st": status,
                "e": None if status == "done" else "Nobody to notify (no recipients, or every channel is off).",
                "n": people,
            },
        )
        await db.commit()


class _Accounts:
    """Decrypted provider accounts and school settings, cached for one sending round."""

    def __init__(self) -> None:
        self.creds: dict[tuple[str, str], Any] = {}
        self.setup: dict[str, dict] = {}

    async def account(self, db, school: str, channel: str):  # type: ignore[no-untyped-def]
        k = (school, channel)
        if k not in self.creds:
            r = (
                (
                    await db.execute(
                        text("select * from private.notify_channel_secrets(:s, :c)"), {"s": school, "c": channel}
                    )
                )
                .mappings()
                .first()
            )
            self.creds[k] = None if r is None else {**r, "secret": secrets.decrypt(r["secret_enc"])}
        return self.creds[k]

    async def school(self, db, school: str) -> dict:  # type: ignore[no-untyped-def]
        if school not in self.setup:
            self.setup[school] = (
                await db.execute(text("select private.notify_school_setup(:s)"), {"s": school})
            ).scalar()
        return self.setup[school]


async def send_due(limit: int = 50) -> int:
    async with notify_session() as db:
        rows = [
            dict(r)
            for r in (await db.execute(text("select * from private.notify_claim_deliveries(:n)"), {"n": limit}))
            .mappings()
            .all()
        ]
        await db.commit()
    cache = _Accounts()
    for d in rows:
        try:
            async with notify_session() as db:
                status, provider, pid, error, retry_at = await _send_one(db, d, cache)
                await db.execute(
                    text("select private.notify_delivery_result(:id, :st, :p, :pid, :e, :r)"),
                    {"id": d["id"], "st": status, "p": provider, "pid": pid, "e": error, "r": retry_at},
                )
                await db.commit()
        except Exception:  # noqa: BLE001 - one bad message must not stop the others
            # left in 'sending'; claimed again after 10 minutes
            log.exception("notification delivery %s failed", d["id"])
    return len(rows)


async def _send_one(db, d: dict, cache: _Accounts) -> tuple[str, str | None, str | None, str | None, datetime | None]:  # type: ignore[no-untyped-def]
    s = get_settings()
    school = str(d["school_id"])
    setup = await cache.school(db, school)
    settings = setup.get("settings") or {}
    ch = d["channel"]
    provider = {"email": "smtp", "sms": "twilio", "whatsapp": "meta"}[ch]
    try:
        if ch == "email":
            info = setup.get("school") or {}
            pid = await providers.send_email(
                d["address"],
                d["subject"] or "",
                d["body"],
                email_html(d["body"], info.get("name") or ""),
                info.get("name") or "School",
                settings.get("reply_to") or info.get("email"),
            )
            return "sent", provider, pid, None, None
        is_test = d["recipient_kind"] == "test"
        if not is_test:
            q = quiet_until(datetime.now(IST), int(settings.get("quiet_start", 21)), int(settings.get("quiet_end", 8)))
            if q:
                return "queued", provider, None, "Waiting for the end of quiet hours.", q
            limit = int(settings.get(f"{ch}_daily_limit", 500))
            sent = (await db.execute(text("select private.notify_sent_today(:s, :c)"), {"s": school, "c": ch})).scalar()
            if sent >= limit:
                return (
                    "skipped",
                    provider,
                    None,
                    f"Today's {'SMS' if ch == 'sms' else 'WhatsApp'} limit ({limit}) was reached.",
                    None,
                )
        acc = await cache.account(db, school, ch)
        if acc is None or not (acc["is_enabled"] or is_test):
            return "skipped", provider, None, f"{'SMS' if ch == 'sms' else 'WhatsApp'} isn't set up or turned on.", None
        cfg = acc["config"] or {}
        if ch == "sms":
            sender = providers.TwilioSms(
                cfg.get("account_sid", ""),
                acc["secret"],
                sender=cfg.get("from_number"),
                messaging_service_sid=cfg.get("messaging_service_sid"),
            )
            callback = f"{s.public_api_url.rstrip('/')}/api/v1/notifications/webhooks/twilio/{school}"
            return "sent", provider, await sender.send(d["address"], d["body"], callback), None, None
        wa = providers.WhatsAppCloud(cfg.get("phone_number_id", ""), acc["secret"])
        pid = await wa.send_template(
            d["address"], d["wa_template"] or "", d["wa_language"] or "en", list(d["wa_params"] or [])
        )
        return "sent", provider, pid, None, None
    except providers.TemporaryError as exc:
        if d["attempts"] <= len(RETRY_MINUTES):
            return (
                "failed",
                provider,
                None,
                exc.message,
                datetime.now(IST) + timedelta(minutes=RETRY_MINUTES[d["attempts"] - 1]),
            )
        return "failed", provider, None, exc.message, None
    except providers.PermanentError as exc:
        return "failed", provider, None, exc.message, None
    except secrets.SecretsUnavailable as exc:
        return "failed", provider, None, str(exc), None


LOCK_SCREEN_BODY = "You have a new notification. Open the app to read it."


async def send_push_due(limit: int = 50) -> int:
    """Pushes queued in-app notifications to devices. A notification already read is skipped;
    a device whose person chose to hide details gets only the school's name."""
    async with notify_session() as db:
        rows = [
            dict(r) for r in (await db.execute(text("select * from private.push_claim(:n)"), {"n": limit})).mappings()
        ]
        await db.commit()
    if not rows:
        return 0
    results: list[tuple[str, str, str | None]] = []
    if not push.configured():
        results = [(str(r["id"]), "skipped", "Push isn't set up on this server.") for r in rows]
    else:
        sem = asyncio.Semaphore(10)

        async def one(client, r: dict[str, Any]) -> tuple[str, str, str | None]:  # type: ignore[no-untyped-def]
            if r["read"]:
                return str(r["id"]), "skipped", None
            if r["show_preview"]:
                payload = push.message(r["title"], r["body"], r["link"], str(r["notification_id"]), r["school_name"])
            else:
                payload = push.message(
                    r["school_name"], LOCK_SCREEN_BODY, r["link"], str(r["notification_id"]), r["school_name"]
                )
            async with sem:
                result, error = await push.send(client, r["endpoint"], r["p256dh"], r["auth"], payload)
            return str(r["id"]), result, error

        async with push.client() as client:
            results = list(await asyncio.gather(*(one(client, r) for r in rows)))
    async with notify_session() as db:
        for oid, result, error in results:
            await db.execute(text("select private.push_result(:id, :o, :e)"), {"id": oid, "o": result, "e": error})
        await db.commit()
    return len(rows)


async def run_jobs() -> None:
    async with notify_session() as db:
        await db.execute(text("select private.notify_due_notices()"))
        await db.execute(text("select private.notify_auto_fee_reminders()"))
        await db.execute(text("select private.notify_library_overdue()"))
        await db.commit()


async def run_forever(stop: asyncio.Event) -> None:
    s = get_settings()
    last_jobs = 0.0
    log.info("notification sender started")
    while not stop.is_set():
        busy = False
        try:
            if time.monotonic() - last_jobs > 60:
                await run_jobs()
                last_jobs = time.monotonic()
            busy = (await process_events()) > 0
            busy = (await send_due()) > 0 or busy
            busy = (await send_push_due()) > 0 or busy
        except Exception:  # noqa: BLE001 - keep going; the database may be restarting
            log.exception("notification sender round failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=0.2 if busy else s.notify_interval_seconds)
        except TimeoutError:
            pass
