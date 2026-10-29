"""Senders: email (SMTP), SMS (Twilio) and WhatsApp (Meta WhatsApp Cloud API).

Each raises TemporaryError (try again later: network trouble, rate limits, provider
outages) or PermanentError (don't retry: invalid number, bad credentials...). No voice
calls are made by anything here.

Provider documentation followed:
  * Twilio Messages API: POST /2010-04-01/Accounts/{AccountSid}/Messages.json (form: To, From
    or MessagingServiceSid, Body, StatusCallback), HTTP Basic auth AccountSid:AuthToken.
    Status callbacks are signed: X-Twilio-Signature = base64(HMAC-SHA1(auth token,
    full URL + each POST parameter name and value, sorted by name)).
  * WhatsApp Cloud API: POST /{version}/{phone-number-id}/messages with a Bearer token; outside
    a customer's 24-hour window only approved *template* messages may be sent. Webhooks are
    signed: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body).
"""

import asyncio
import base64
import hashlib
import hmac
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any

import httpx

from app.core.config import get_settings


class SendError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message[:400]


class TemporaryError(SendError):
    pass


class PermanentError(SendError):
    pass


def e164(phone: str | None) -> str | None:
    """+91 98765 43210 / 9876543210 -> +919876543210. A bare 10-digit number is Indian."""
    if not phone:
        return None
    digits = re.sub(r"\D", "", phone)
    if phone.strip().startswith("+") and 10 <= len(digits) <= 15:
        return "+" + digits
    if len(digits) == 10 and digits[0] in "6789":
        return "+91" + digits
    if len(digits) == 12 and digits.startswith("91"):
        return "+" + digits
    return None


# ------------------------------------------------------------------ email
def email_configured() -> bool:
    s = get_settings()
    return bool(s.smtp_host and s.email_from)


def _send_email_sync(to: str, subject: str, text: str, html_body: str, from_name: str, reply_to: str | None) -> str:
    s = get_settings()
    if not email_configured():
        raise PermanentError("Email isn't set up on the server (SMTP_HOST / EMAIL_FROM).")
    msg = EmailMessage()
    msg["From"] = formataddr((from_name, s.email_from))
    msg["To"] = to
    msg["Subject"] = subject
    if reply_to:
        msg["Reply-To"] = reply_to
    msg_id = make_msgid(domain=s.email_from.split("@")[-1])
    msg["Message-ID"] = msg_id
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")
    try:
        if s.smtp_security == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(
                s.smtp_host, s.smtp_port, timeout=20, context=ssl.create_default_context()
            )
        else:
            server = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=20)
        with server:
            if s.smtp_security == "starttls":
                server.starttls(context=ssl.create_default_context())
            if s.smtp_username:
                server.login(s.smtp_username, s.smtp_password)
            server.send_message(msg)
    except smtplib.SMTPRecipientsRefused as exc:
        raise PermanentError(f"The address was refused: {to}") from exc
    except smtplib.SMTPAuthenticationError as exc:
        raise PermanentError("The SMTP server rejected the username or password.") from exc
    except smtplib.SMTPResponseException as exc:
        if 500 <= exc.smtp_code < 600:
            raise PermanentError(f"The mail server refused the message ({exc.smtp_code}).") from exc
        raise TemporaryError(f"The mail server asked to try later ({exc.smtp_code}).") from exc
    except (OSError, smtplib.SMTPException) as exc:
        raise TemporaryError(f"Couldn't reach the mail server: {type(exc).__name__}") from exc
    return msg_id.strip("<>")


async def send_email(to: str, subject: str, text: str, html_body: str, from_name: str, reply_to: str | None) -> str:
    return await asyncio.to_thread(_send_email_sync, to, subject, text, html_body, from_name, reply_to)


# ------------------------------------------------------------------ HTTP helpers
async def _post(url: str, *, transport: httpx.AsyncBaseTransport | None = None, **kw: Any) -> tuple[int, dict]:
    try:
        async with httpx.AsyncClient(timeout=20, transport=transport) as c:
            res = await c.post(url, **kw)
    except httpx.HTTPError as exc:
        raise TemporaryError(f"Couldn't reach the provider: {type(exc).__name__}") from exc
    try:
        data = res.json()
    except ValueError:
        data = {}
    return res.status_code, data if isinstance(data, dict) else {}


# ------------------------------------------------------------------ SMS: Twilio
class TwilioSms:
    def __init__(
        self,
        account_sid: str,
        auth_token: str,
        *,
        sender: str | None,
        messaging_service_sid: str | None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.sid, self.token = account_sid, auth_token
        self.sender, self.service = sender, messaging_service_sid
        self.transport = transport

    async def send(self, to: str, body: str, status_callback: str | None) -> str:
        form = {"To": to, "Body": body}
        if self.service:
            form["MessagingServiceSid"] = self.service
        elif self.sender:
            form["From"] = self.sender
        else:
            raise PermanentError("No sender number or messaging service is set for SMS.")
        if status_callback:
            form["StatusCallback"] = status_callback
        base = get_settings().twilio_api_base.rstrip("/")
        code, data = await _post(
            f"{base}/2010-04-01/Accounts/{self.sid}/Messages.json",
            data=form,
            auth=(self.sid, self.token),
            transport=self.transport,
        )
        if code in (200, 201) and data.get("sid"):
            return str(data["sid"])
        msg = f"Twilio {data.get('code') or code}: {data.get('message') or 'error'}"
        if code == 429 or code >= 500:
            raise TemporaryError(msg)
        raise PermanentError(msg)


def twilio_signature_ok(url: str, params: dict[str, str], signature: str | None, auth_token: str) -> bool:
    if not (signature and auth_token):
        return False
    payload = url + "".join(k + params[k] for k in sorted(params))
    expected = base64.b64encode(hmac.new(auth_token.encode(), payload.encode(), hashlib.sha1).digest()).decode()
    return hmac.compare_digest(expected, signature)


TWILIO_STATUS = {
    "accepted": "sent",
    "queued": "sent",
    "sending": "sent",
    "sent": "sent",
    "delivered": "delivered",
    "read": "read",
    "undelivered": "failed",
    "failed": "failed",
}


# ------------------------------------------------------------------ WhatsApp: Meta Cloud API
class WhatsAppCloud:
    def __init__(self, phone_number_id: str, access_token: str, *, transport: httpx.AsyncBaseTransport | None = None):
        self.phone_id, self.token, self.transport = phone_number_id, access_token, transport

    async def send_template(self, to: str, template: str, language: str, params: list[str]) -> str:
        s = get_settings()
        body: dict[str, Any] = {
            "messaging_product": "whatsapp",
            "to": to.lstrip("+"),
            "type": "template",
            "template": {"name": template, "language": {"code": language}},
        }
        if params:
            body["template"]["components"] = [
                {"type": "body", "parameters": [{"type": "text", "text": p[:1000] or "-"} for p in params]}
            ]
        url = f"{s.whatsapp_api_base.rstrip('/')}/{s.whatsapp_api_version}/{self.phone_id}/messages"
        code, data = await _post(
            url, json=body, headers={"Authorization": f"Bearer {self.token}"}, transport=self.transport
        )
        msgs = data.get("messages") or []
        if code == 200 and msgs and msgs[0].get("id"):
            return str(msgs[0]["id"])
        err = data.get("error") or {}
        msg = f"WhatsApp {err.get('code') or code}: {err.get('message') or 'error'}"
        if code == 429 or code >= 500 or err.get("code") in (4, 80007, 130429, 131048, 131056):  # rate limits
            raise TemporaryError(msg)
        raise PermanentError(msg)


def meta_signature_ok(body: bytes, header: str | None, app_secret: str) -> bool:
    if not (header and app_secret and header.startswith("sha256=")):
        return False
    expected = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[7:])


WHATSAPP_STATUS = {"sent": "sent", "delivered": "delivered", "read": "read", "failed": "failed"}
