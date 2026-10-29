import asyncio
import base64
import hashlib
import hmac
import json
from datetime import UTC, datetime

import httpx
import pytest
from pydantic import ValidationError

from app.api.v1.routes.notifications import PreferencesIn, SettingsIn, SmsIn, TemplateIn, WhatsAppIn, _check_template
from app.services.notify import providers
from app.services.notify.catalog import EVENTS, TEST
from app.services.notify.render import TemplateError, email_html, render, sample_values, sms_info, validate
from app.services.notify.sender import (
    IST,
    build_messages,
    in_app_link,
    inr,
    join_names,
    nice_date,
    quiet_until,
    status_detail,
    templates_for,
)

FRONT = "https://erp.example.in"
DAY = datetime(2026, 10, 12, 11, 0, tzinfo=IST)  # 11am India time: not quiet
NIGHT = datetime(2026, 10, 12, 22, 30, tzinfo=IST)


# ---------------------------------------------------------------- catalog
def test_every_default_template_uses_only_its_own_variables():
    for ev in [*EVENTS.values(), TEST]:
        for ch, d in ev.defaults.items():
            assert ch in ev.channels
            validate(ev, d.subject, d.body)
        assert set(ev.defaults) == set(ev.channels)
        assert all(p in ev.variables for p in ev.wa_params)
        assert set(ev.sample) <= set(ev.variables)


def test_paid_channels_are_off_by_default():
    for ev in EVENTS.values():
        for ch in ("sms", "whatsapp"):
            assert not ev.defaults[ch].enabled, (ev.key, ch)


def test_no_voice_channel_exists():
    for ev in [*EVENTS.values(), TEST]:
        assert not any("voice" in ch or "call" in ch for ch in ev.channels)


# ---------------------------------------------------------------- templates
def test_render_fills_known_values_only():
    assert render("Hi {{ name }}, {{x}}!", {"name": "Asha"}) == "Hi Asha, !"
    assert render("{{a}}{{a}}", {"a": "1"}) == "11"
    # values are inserted as text: no second round of substitution
    assert render("{{a}}", {"a": "{{b}}", "b": "secret"}) == "{{b}}"
    assert render(None, {}) == ""


def test_validate_rejects_unknown_and_broken_placeholders():
    ev = EVENTS["payment_received"]
    validate(ev, "Received {{amount}} for {{student_name}}")
    with pytest.raises(TemplateError, match="Unknown placeholder"):
        validate(ev, "{{password}}")
    with pytest.raises(TemplateError, match="closed properly"):
        validate(ev, "Received {{amount}")
    with pytest.raises(TemplateError):
        validate(ev, "{{student.__class__}}")


def test_sample_values_cover_every_variable_in_defaults():
    for ev in EVENTS.values():
        vals = sample_values(ev)
        for d in ev.defaults.values():
            out = render(d.body, vals)
            assert "{{" not in out


def test_sms_parts():
    assert sms_info("a" * 160) == {"characters": 160, "parts": 1, "unicode": False}
    assert sms_info("a" * 161)["parts"] == 2
    assert sms_info("₹" + "a" * 69) == {"characters": 70, "parts": 1, "unicode": True}
    assert sms_info("₹" + "a" * 70)["parts"] == 2
    # GSM-7 extension characters stay in the cheap alphabet but take two places each
    assert sms_info("{" * 80) == {"characters": 160, "parts": 1, "unicode": False}
    assert sms_info("€" + "a" * 159) == {"characters": 161, "parts": 2, "unicode": False}


def test_email_html_escapes_text():
    out = email_html("<script>x</script>\n\nPay at https://erp.example.in/portal", "A & B School")
    assert "<script>" not in out and "&lt;script&gt;" in out
    assert '<a href="https://erp.example.in/portal">' in out
    assert "A &amp; B School" in out


# ---------------------------------------------------------------- formatting
def test_inr_indian_grouping():
    assert inr("4500") == "₹4,500"
    assert inr("1234567.5") == "₹12,34,567.50"
    assert inr(0) == "₹0"
    assert inr("100") == "₹100"
    assert inr("-2500") == "-₹2,500"


def test_dates_and_names():
    assert nice_date("2026-10-05") == "5 Oct 2026"
    assert nice_date(None) == ""
    assert join_names(["Aarav"]) == "Aarav"
    assert join_names(["Aarav", "Diya"]) == "Aarav and Diya"
    assert join_names(["A", "B", "A", "C"]) == "A, B and C"
    assert join_names([]) == ""


def test_phone_numbers():
    assert providers.e164("98765 43210") == "+919876543210"
    assert providers.e164("+91 98765-43210") == "+919876543210"
    assert providers.e164("919876543210") == "+919876543210"
    assert providers.e164("+1 415 555 0100") == "+14155550100"
    assert providers.e164("12345") is None
    assert providers.e164("0123456789") is None  # not a mobile number
    assert providers.e164(None) is None


def test_quiet_hours():
    assert quiet_until(DAY, 21, 8) is None
    end = quiet_until(NIGHT, 21, 8)
    assert end == datetime(2026, 10, 13, 8, 0, tzinfo=IST)
    early = datetime(2026, 10, 12, 6, 0, tzinfo=IST)
    assert quiet_until(early, 21, 8) == datetime(2026, 10, 12, 8, 0, tzinfo=IST)
    # UTC input is converted to India time (16:30 UTC = 22:00 IST)
    assert quiet_until(datetime(2026, 10, 12, 16, 30, tzinfo=UTC), 21, 8) is not None
    # a daytime window that doesn't wrap midnight
    assert quiet_until(datetime(2026, 10, 12, 13, 0, tzinfo=IST), 12, 14) == datetime(2026, 10, 12, 14, tzinfo=IST)
    assert quiet_until(DAY, 0, 0) is None  # start == end: no quiet hours


def test_links_by_role():
    v = {"homework_id": "hw1"}
    assert in_app_link("payment_received", "parent", "s1", v) == "/portal/s1?tab=Fees"
    assert in_app_link("homework_assigned", "parent", "s1", v) == "/portal/s1/homework/hw1"
    assert in_app_link("homework_assigned", "student", "s1", v) == "/my/homework/hw1"
    assert in_app_link("notice_published", "staff", None, v) == "/notices"
    assert in_app_link("admission_update", "applicant", None, v) is None
    for key in EVENTS:
        for kind in ("parent", "student", "staff"):
            link = in_app_link(key, kind, "s1", v)
            assert link is None or link.startswith("/")  # the database only accepts relative links


def test_status_detail():
    assert "Reason: Seats full" == status_detail({"status": "rejected", "reason": "Seats full"})
    assert "₹15,000" in status_detail({"status": "approved", "admission_fee": "15000"})
    assert "contact you" in status_detail({"status": "approved", "admission_fee": "0"})


# ---------------------------------------------------------------- event -> messages
def _ctx(recipients, vars_=None):
    return {
        "event_key": "payment_received",
        "school": {"name": "Green Valley School", "code": "GVS", "phone": "011 4000"},
        "vars": vars_
        or {
            "student_name": "Aarav",
            "class_section": "Class 5 – A",
            "amount": "4500.00",
            "receipt_number": "R/1",
            "payment_mode": "upi",
            "payment_date": "2026-10-12",
            "balance": "9000.00",
        },
        "recipients": recipients,
    }


def _parent(uid="u1", sid="s1", student="Aarav", email="p@example.com", phone="9876543210", name="Rohan"):
    return {"kind": "parent", "user_id": uid, "student_id": sid, "student_name": student,
            "name": name, "email": email, "phone": phone}  # fmt: skip


ALL_ON = {
    "templates": [
        {"event_key": "payment_received", "channel": ch, "is_enabled": True, "wa_template": "pay_ok"}
        for ch in ("sms", "whatsapp")
    ],
    "settings": {"quiet_start": 21, "quiet_end": 8},
    "channels": {"sms": True, "whatsapp": True},
}


def _build(recipients, setup=None, opted=frozenset(), now=DAY, email_ready=True, key="payment_received", **kw):
    return build_messages(
        {"event_key": key, "payload": kw.get("payload") or {}},
        _ctx(recipients, kw.get("vars")),
        setup if setup is not None else {},
        set(opted),
        now=now,
        frontend_url=FRONT,
        email_ready=email_ready,
    )


def test_defaults_give_in_app_and_email_only():
    in_app, out, people = _build([_parent()])
    assert people == 1
    assert [d["channel"] for d in out] == ["email"]
    assert in_app == [
        {
            "user_id": "u1",
            "title": "Payment received: ₹4,500",
            "body": "Receipt R/1 for Aarav. Still to pay: ₹9,000.",
            "link": "/portal/s1?tab=Fees",
        }
    ]
    email = out[0]
    assert email["address"] == "p@example.com"
    assert "by UPI" in email["body"] and "12 Oct 2026" in email["body"]
    assert email["subject"] == "Payment received — receipt R/1"
    assert f"{FRONT}/portal/s1?tab=Fees" in email["body"]
    assert "status" not in email  # queued normally


def test_sms_uses_rs_and_whatsapp_gets_params():
    _, out, _ = _build([_parent()], ALL_ON)
    by = {d["channel"]: d for d in out}
    assert by["sms"]["address"] == "+919876543210"
    assert "Rs 4,500" in by["sms"]["body"] and "₹" not in by["sms"]["body"]
    assert sms_info(by["sms"]["body"])["unicode"] is False
    wa = by["whatsapp"]
    assert wa["wa_template"] == "pay_ok"
    assert wa["wa_params"] == ["₹4,500", "Aarav", "R/1", "Green Valley School"]


def test_two_children_one_message_per_address():
    recips = [_parent(sid="s1", student="Aarav"), _parent(sid="s2", student="Diya")]
    in_app, out, people = _build(recips, ALL_ON)
    assert people == 1
    assert len(in_app) == 2  # one per child (different links)
    assert sorted(d["channel"] for d in out) == ["email", "sms", "whatsapp"]
    assert all("Aarav and Diya" in d["body"] or "Aarav and Diya" in d["wa_params"] for d in out)


def test_opt_out_and_students_get_no_sms():
    student = {"kind": "student", "user_id": "u9", "student_id": "s1", "student_name": "Aarav",
               "name": "Aarav", "email": "aarav@example.com", "phone": "9876500000"}  # fmt: skip
    _, out, _ = _build([_parent(), student], ALL_ON, opted={("u1", "sms"), ("u1", "email")})
    pairs = sorted((d["user_id"], d["channel"]) for d in out)
    assert pairs == [("u1", "whatsapp"), ("u9", "email")]


def test_skips_are_recorded_with_a_reason():
    setup = {**ALL_ON, "channels": {"sms": False, "whatsapp": True}}
    setup["templates"] = [
        {"event_key": "payment_received", "channel": "sms", "is_enabled": True},
        {"event_key": "payment_received", "channel": "whatsapp", "is_enabled": True},  # no template name
    ]
    _, out, _ = _build([_parent()], setup, email_ready=False)
    by = {d["channel"]: d for d in out}
    assert by["email"]["status"] == "skipped" and "Email" in by["email"]["error"]
    assert by["sms"]["status"] == "skipped" and "SMS" in by["sms"]["error"]
    assert by["whatsapp"]["status"] == "skipped" and "template" in by["whatsapp"]["error"]


def test_disabled_in_app_and_family_number_without_account():
    setup = {"templates": [{"event_key": "payment_received", "channel": "in_app", "is_enabled": False},
                           {"event_key": "payment_received", "channel": "sms", "is_enabled": True}],
             "channels": {"sms": True}}  # fmt: skip
    family = {"kind": "family", "user_id": None, "student_id": "s1", "student_name": "Aarav",
              "name": "Parent of Aarav", "email": None, "phone": "+91 99999 11111"}  # fmt: skip
    in_app, out, people = _build([family], setup)
    assert in_app == []
    assert [(d["channel"], d["address"]) for d in out] == [("sms", "+919999911111")]
    assert people == 1


def test_quiet_hours_delay_sms_but_not_email():
    _, out, _ = _build([_parent()], ALL_ON, now=NIGHT)
    by = {d["channel"]: d for d in out}
    assert "not_before" not in by["email"]
    assert by["sms"]["not_before"].startswith("2026-10-13T08:00")
    assert by["whatsapp"]["not_before"].startswith("2026-10-13T08:00")


def test_school_wording_is_used():
    setup = {"templates": [{"event_key": "payment_received", "channel": "email", "is_enabled": True,
                            "subject": "Thanks {{recipient_name}}", "body": "Got {{amount}}."}]}  # fmt: skip
    _, out, _ = _build([_parent()], setup)
    assert out[0]["subject"] == "Thanks Rohan" and out[0]["body"] == "Got ₹4,500."


def test_test_message_goes_only_to_the_chosen_channel():
    ctx = {"school": {"name": "GVS"}, "vars": {},
           "recipients": [{"kind": "test", "name": "Test", "phone": "9876543210", "email": None}]}  # fmt: skip
    in_app, out, _ = build_messages(
        {"event_key": "test", "payload": {"channel": "sms"}},
        ctx,
        {"channels": {"sms": True}},
        set(),
        now=NIGHT,
        frontend_url=FRONT,
        email_ready=True,
    )
    assert in_app == []
    assert [d["channel"] for d in out] == ["sms"]
    assert "not_before" not in out[0]  # a test is sent at once, even in quiet hours


def test_templates_for_test_whatsapp_uses_hello_world():
    t = templates_for("test", {}, "whatsapp")
    assert t["whatsapp"].enabled and t["whatsapp"].wa_template == "hello_world"
    assert not t["email"].enabled


def test_admission_update_has_tracking_link():
    ctx = {"school": {"name": "GVS", "code": "GVS"},
           "vars": {"status": "approved", "admission_fee": "15000", "application_number": "GVS/APP/2026/0001",
                    "student_name": "Kabir", "class_name": "Class 1"},
           "recipients": [{"kind": "applicant", "user_id": None, "name": "Meera", "email": "m@example.com",
                           "phone": "9876543210"}]}  # fmt: skip
    in_app, out, _ = build_messages(
        {"event_key": "admission_update"}, ctx, {}, set(), now=DAY, frontend_url=FRONT, email_ready=True
    )
    assert in_app == []
    body = out[0]["body"]
    assert f"{FRONT}/apply/gvs/track?number=GVS/APP/2026/0001" in body
    assert "₹15,000" in body


# ---------------------------------------------------------------- signatures
def test_twilio_signature():
    url = "https://api.example.in/api/v1/notifications/webhooks/twilio/abc"
    params = {"MessageSid": "SM1", "MessageStatus": "delivered", "AccountSid": "AC1"}
    payload = url + "AccountSidAC1" + "MessageSidSM1" + "MessageStatusdelivered"
    sig = base64.b64encode(hmac.new(b"tok" * 6, payload.encode(), hashlib.sha1).digest()).decode()
    assert providers.twilio_signature_ok(url, params, sig, "tok" * 6)
    assert not providers.twilio_signature_ok(url, {**params, "MessageStatus": "read"}, sig, "tok" * 6)
    assert not providers.twilio_signature_ok(url + "x", params, sig, "tok" * 6)
    assert not providers.twilio_signature_ok(url, params, None, "tok" * 6)
    assert not providers.twilio_signature_ok(url, params, sig, "")


def test_meta_signature():
    body = b'{"entry":[]}'
    good = "sha256=" + hmac.new(b"appsecret", body, hashlib.sha256).hexdigest()
    assert providers.meta_signature_ok(body, good, "appsecret")
    assert not providers.meta_signature_ok(body + b" ", good, "appsecret")
    assert not providers.meta_signature_ok(body, good[7:], "appsecret")  # missing prefix
    assert not providers.meta_signature_ok(body, good, "")


# ---------------------------------------------------------------- provider clients
def _run(coro):
    return asyncio.run(coro)


def test_twilio_client_sends_form_with_basic_auth():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["auth"] = req.headers["authorization"]
        seen["form"] = dict(httpx.QueryParams(req.content.decode()))
        return httpx.Response(201, json={"sid": "SM123", "status": "queued"})

    sid = "AC" + "0" * 32
    sms = providers.TwilioSms(sid, "token", sender="+15005550006", messaging_service_sid=None,
                              transport=httpx.MockTransport(handler))  # fmt: skip
    assert _run(sms.send("+919876543210", "Hello", "https://api/cb")) == "SM123"
    assert seen["url"].endswith(f"/2010-04-01/Accounts/{sid}/Messages.json")
    assert seen["auth"] == "Basic " + base64.b64encode(f"{sid}:token".encode()).decode()
    assert seen["form"] == {"To": "+919876543210", "Body": "Hello", "From": "+15005550006",
                            "StatusCallback": "https://api/cb"}  # fmt: skip


@pytest.mark.parametrize(
    ("code", "err"),
    [(400, providers.PermanentError), (401, providers.PermanentError), (429, providers.TemporaryError),
     (503, providers.TemporaryError)],
)  # fmt: skip
def test_twilio_errors_are_classified(code, err):
    t = httpx.MockTransport(lambda r: httpx.Response(code, json={"code": 21211, "message": "Invalid 'To'"}))
    sms = providers.TwilioSms("AC" + "0" * 32, "t", sender="+15005550006", messaging_service_sid=None, transport=t)
    with pytest.raises(err):
        _run(sms.send("+919876543210", "x", None))


def test_twilio_network_error_is_temporary():
    def boom(req):
        raise httpx.ConnectError("down")

    sms = providers.TwilioSms("AC" + "0" * 32, "t", sender="+1500", messaging_service_sid=None,
                              transport=httpx.MockTransport(boom))  # fmt: skip
    with pytest.raises(providers.TemporaryError):
        _run(sms.send("+919876543210", "x", None))


def test_twilio_messaging_service_wins():
    seen = {}

    def handler(req):
        seen.update(httpx.QueryParams(req.content.decode()))
        return httpx.Response(201, json={"sid": "SM9"})

    sms = providers.TwilioSms("AC" + "0" * 32, "t", sender="+1500", messaging_service_sid="MG" + "1" * 32,
                              transport=httpx.MockTransport(handler))  # fmt: skip
    _run(sms.send("+919876543210", "x", None))
    assert "From" not in seen and seen["MessagingServiceSid"] == "MG" + "1" * 32


def test_whatsapp_client_sends_a_template():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["url"] = str(req.url)
        seen["auth"] = req.headers["authorization"]
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"messages": [{"id": "wamid.X"}]})

    wa = providers.WhatsAppCloud("123456789", "EAAtoken", transport=httpx.MockTransport(handler))
    assert _run(wa.send_template("+919876543210", "pay_ok", "en", ["₹4,500", ""])) == "wamid.X"
    assert seen["url"].endswith("/123456789/messages")
    assert seen["auth"] == "Bearer EAAtoken"
    b = seen["body"]
    assert b["to"] == "919876543210" and b["type"] == "template"
    assert b["template"]["name"] == "pay_ok" and b["template"]["language"] == {"code": "en"}
    assert b["template"]["components"][0]["parameters"] == [
        {"type": "text", "text": "₹4,500"},
        {"type": "text", "text": "-"},  # Meta rejects empty parameters
    ]


def test_whatsapp_rate_limit_is_temporary_bad_number_permanent():
    t1 = httpx.MockTransport(lambda r: httpx.Response(400, json={"error": {"code": 130429, "message": "Rate"}}))
    with pytest.raises(providers.TemporaryError):
        _run(providers.WhatsAppCloud("1", "t", transport=t1).send_template("+91", "x", "en", []))
    t2 = httpx.MockTransport(
        lambda r: httpx.Response(400, json={"error": {"code": 131026, "message": "Undeliverable"}})
    )
    with pytest.raises(providers.PermanentError, match="131026"):
        _run(providers.WhatsAppCloud("1", "t", transport=t2).send_template("+91", "x", "en", []))


# ---------------------------------------------------------------- API input
def test_template_input():
    t = TemplateIn(is_enabled=True, subject="  ", body=" Hi {{student_name}} ")
    assert t.subject is None and t.body == "Hi {{student_name}}"
    with pytest.raises(ValidationError):
        TemplateIn(is_enabled=True, wa_template="Bad Name")
    with pytest.raises(ValidationError):
        TemplateIn(is_enabled=True, wa_language="english")
    with pytest.raises(ValidationError):
        TemplateIn(is_enabled=True, extra="x")


def test_check_template():
    from fastapi import HTTPException

    _check_template("payment_received", "email", TemplateIn(is_enabled=True, body="{{amount}}"))
    with pytest.raises(HTTPException) as e:
        _check_template("payment_received", "email", TemplateIn(is_enabled=True, body="{{fee_secret}}"))
    assert e.value.status_code == 422
    with pytest.raises(HTTPException) as e:
        _check_template("payment_received", "whatsapp", TemplateIn(is_enabled=True))
    assert "WhatsApp template" in e.value.detail
    with pytest.raises(HTTPException) as e:
        _check_template("payment_received", "voice", TemplateIn(is_enabled=True))
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        _check_template("admission_update", "in_app", TemplateIn(is_enabled=True))
    assert e.value.status_code == 404  # applicants have no account
    with pytest.raises(HTTPException):
        _check_template("payment_received", "whatsapp", TemplateIn(is_enabled=False, wa_params=["password"]))


def test_settings_input():
    s = SettingsIn(email_enabled=True, reply_to=" ", quiet_start=21, quiet_end=8,
                   fee_reminder_days=[10, 5, 5], sms_daily_limit=10, whatsapp_daily_limit=0)  # fmt: skip
    assert s.reply_to is None and s.fee_reminder_days == [5, 10]
    with pytest.raises(ValidationError):
        SettingsIn(email_enabled=True, quiet_start=24, quiet_end=8, sms_daily_limit=1, whatsapp_daily_limit=1)
    with pytest.raises(ValidationError):
        SettingsIn(email_enabled=True, quiet_start=21, quiet_end=8, fee_reminder_days=[31],
                   sms_daily_limit=1, whatsapp_daily_limit=1)  # fmt: skip


def test_channel_inputs():
    sid = "AC" + "a" * 32
    assert SmsIn(account_sid=sid, auth_token="", from_number="+15005550006", enabled=True).auth_token is None
    with pytest.raises(ValidationError):
        SmsIn(account_sid="AC123", from_number="+15005550006", enabled=True)
    with pytest.raises(ValidationError):
        SmsIn(account_sid=sid, from_number="98765 43210", enabled=True)
    assert WhatsAppIn(phone_number_id="1234567", access_token=" ", enabled=False).access_token is None
    with pytest.raises(ValidationError):
        WhatsAppIn(phone_number_id="abc", enabled=False)
    with pytest.raises(ValidationError):
        PreferencesIn(email=True, sms=True, whatsapp=True, voice=True)
