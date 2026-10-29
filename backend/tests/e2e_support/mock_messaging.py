"""Local stand-ins for an SMTP server, Twilio SMS and the WhatsApp Cloud API.

FOR TEST ENVIRONMENTS ONLY, never production. Nothing is really sent: messages are kept
in memory so tests can read them back. No voice calls are offered or simulated.

Run:  uvicorn tests.e2e_support.mock_messaging:app --port 9997   (from backend/)
      The SMTP sink listens on MOCK_SMTP_PORT (default 2525), plain text, no login.

Point the API at it:
  SMTP_HOST=localhost SMTP_PORT=2525 SMTP_SECURITY=none EMAIL_FROM=school@erp.test
  TWILIO_API_BASE=http://localhost:9997  WHATSAPP_API_BASE=http://localhost:9997

Accounts:
  Twilio    any Account SID; the auth token must start with "mock_twilio_token" (else 401 / 20003).
            To +15005550001 fails with 21211 (invalid number), like Twilio's test numbers.
            After a send, a signed status callback ("sent", then "delivered") goes to StatusCallback.
  WhatsApp  the access token must start with "EAAmock" (else 401 / 190).
            To +15005550001 fails with 131026 (undeliverable).
            Signed status webhooks go to the URL registered with POST /mock/whatsapp/webhook.

Test controls:
  GET    /mock/outbox?channel=email|sms|whatsapp&to=...   messages received, newest last
  DELETE /mock/outbox
  POST   /mock/whatsapp/webhook  {phone_number_id, url, app_secret}
  POST   /mock/config            {fail_next: "sms"|"whatsapp"|"email", status: 500|429}  one temporary failure
"""

import asyncio
import base64
import contextlib
import email
import hashlib
import hmac
import json
import os
import secrets
import time
from email import policy

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

OUTBOX: list[dict] = []
WA_HOOKS: dict[str, dict] = {}
FAIL_NEXT: dict[str, int] = {}
BAD_NUMBER = "+15005550001"


# ------------------------------------------------------------------ SMTP sink
class SmtpSink(asyncio.Protocol):
    """Just enough SMTP (RFC 5321) for smtplib: EHLO/HELO, MAIL, RCPT, DATA, RSET, NOOP, QUIT."""

    def connection_made(self, transport):  # type: ignore[no-untyped-def]
        self.t = transport
        self.buf = b""
        self.data_mode = False
        self.rcpts: list[str] = []
        self.sender = ""
        self.t.write(b"220 mock-smtp ready\r\n")

    def data_received(self, data: bytes) -> None:
        self.buf += data
        while True:
            if self.data_mode:
                end = self.buf.find(b"\r\n.\r\n")
                if end < 0:
                    return
                raw, self.buf = self.buf[:end], self.buf[end + 5 :]
                raw = raw.replace(b"\r\n..", b"\r\n.")
                self._store(raw)
                self.data_mode = False
                self.t.write(b"250 2.0.0 Ok: queued\r\n")
                continue
            nl = self.buf.find(b"\r\n")
            if nl < 0:
                return
            line, self.buf = self.buf[:nl].decode(errors="replace"), self.buf[nl + 2 :]
            self._command(line)

    def _command(self, line: str) -> None:
        verb = line[:4].upper()
        if verb == "EHLO":
            self.t.write(b"250-mock-smtp\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n")
        elif verb == "HELO":
            self.t.write(b"250 mock-smtp\r\n")
        elif verb == "MAIL":
            if FAIL_NEXT.pop("email", None):
                self.t.write(b"451 4.3.0 Try again later\r\n")
                return
            self.sender = line.split(":", 1)[1].strip().split()[0].strip("<>")
            self.rcpts = []
            self.t.write(b"250 2.1.0 Ok\r\n")
        elif verb == "RCPT":
            addr = line.split(":", 1)[1].strip().split()[0].strip("<>")
            if addr.endswith("@invalid.test"):
                self.t.write(b"550 5.1.1 No such user\r\n")
                return
            self.rcpts.append(addr)
            self.t.write(b"250 2.1.5 Ok\r\n")
        elif verb == "DATA":
            self.data_mode = True
            self.t.write(b"354 End data with <CR><LF>.<CR><LF>\r\n")
        elif verb == "RSET":
            self.rcpts = []
            self.t.write(b"250 Ok\r\n")
        elif verb == "NOOP":
            self.t.write(b"250 Ok\r\n")
        elif verb == "QUIT":
            self.t.write(b"221 Bye\r\n")
            self.t.close()
        else:
            self.t.write(b"502 5.5.2 Command not recognized\r\n")

    def _store(self, raw: bytes) -> None:
        msg = email.message_from_bytes(raw, policy=policy.default)
        text_part = msg.get_body(preferencelist=("plain",))
        html_part = msg.get_body(preferencelist=("html",))
        for to in self.rcpts:
            OUTBOX.append(
                {
                    "channel": "email",
                    "id": str(msg["Message-ID"] or "").strip("<>"),
                    "to": to,
                    "from": str(msg["From"]),
                    "reply_to": str(msg["Reply-To"] or ""),
                    "subject": str(msg["Subject"]),
                    "body": text_part.get_content().strip() if text_part else "",
                    "html": html_part.get_content() if html_part else "",
                    "at": time.time(),
                }
            )


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI):  # type: ignore[no-untyped-def]
    loop = asyncio.get_running_loop()
    server = await loop.create_server(SmtpSink, "127.0.0.1", int(os.environ.get("MOCK_SMTP_PORT", "2525")))
    try:
        yield
    finally:
        server.close()


app = FastAPI(lifespan=lifespan)


def _fail_now(channel: str) -> int | None:
    return FAIL_NEXT.pop(channel, None)


# ------------------------------------------------------------------ Twilio
def _twilio_sig(url: str, params: dict[str, str], token: str) -> str:
    payload = url + "".join(k + params[k] for k in sorted(params))
    return base64.b64encode(hmac.new(token.encode(), payload.encode(), hashlib.sha1).digest()).decode()


async def _twilio_callbacks(url: str, token: str, base: dict[str, str], final: str, error: str | None) -> None:
    async with httpx.AsyncClient(timeout=10) as c:
        for st in ("sent", final):
            await asyncio.sleep(0.3)
            params = {**base, "MessageStatus": st, "SmsStatus": st}
            if st == "undelivered" and error:
                params["ErrorCode"] = error
            with contextlib.suppress(httpx.HTTPError):
                await c.post(url, data=params, headers={"X-Twilio-Signature": _twilio_sig(url, params, token)})


@app.post("/2010-04-01/Accounts/{sid}/Messages.json")
async def twilio_send(sid: str, request: Request, tasks: BackgroundTasks):
    auth = request.headers.get("authorization", "")
    user, _, token = base64.b64decode(auth[6:]).decode().partition(":") if auth.startswith("Basic ") else ("", "", "")
    if user != sid or not token.startswith("mock_twilio_token"):
        return JSONResponse({"code": 20003, "message": "Authenticate", "status": 401}, 401)
    f = {k: str(v) for k, v in (await request.form()).items()}
    code = _fail_now("sms")
    if code:
        return JSONResponse({"code": 20429, "message": "Too Many Requests", "status": code}, code)
    to = f.get("To", "")
    if to == BAD_NUMBER or not to.startswith("+"):
        return JSONResponse({"code": 21211, "message": f"The 'To' number {to} is not a valid phone number.",
                             "status": 400}, 400)  # fmt: skip
    if not (f.get("From") or f.get("MessagingServiceSid")):
        return JSONResponse({"code": 21603, "message": "A 'From' phone number is required.", "status": 400}, 400)
    msg_sid = "SM" + secrets.token_hex(16)
    OUTBOX.append({"channel": "sms", "id": msg_sid, "to": to, "from": f.get("From") or f.get("MessagingServiceSid"),
                   "body": f.get("Body", ""), "status_callback": f.get("StatusCallback"), "at": time.time()})  # fmt: skip
    if f.get("StatusCallback"):
        base = {"MessageSid": msg_sid, "SmsSid": msg_sid, "AccountSid": sid, "To": to, "From": f.get("From", "")}
        tasks.add_task(_twilio_callbacks, f["StatusCallback"], token, base, "delivered", None)
    return JSONResponse({"sid": msg_sid, "status": "queued", "to": to, "body": f.get("Body", "")}, 201)


# ------------------------------------------------------------------ WhatsApp Cloud API
async def _wa_webhooks(phone_id: str, wamid: str, to: str) -> None:
    hook = WA_HOOKS.get(phone_id)
    if not hook:
        return
    async with httpx.AsyncClient(timeout=10) as c:
        for st in ("sent", "delivered", "read"):
            await asyncio.sleep(0.3)
            body = json.dumps(
                {
                    "object": "whatsapp_business_account",
                    "entry": [
                        {
                            "id": "0",
                            "changes": [
                                {
                                    "field": "messages",
                                    "value": {
                                        "messaging_product": "whatsapp",
                                        "metadata": {"phone_number_id": phone_id},
                                        "statuses": [
                                            {
                                                "id": wamid,
                                                "status": st,
                                                "timestamp": str(int(time.time())),
                                                "recipient_id": to,
                                            }  # fmt: skip
                                        ],
                                    },
                                }
                            ],
                        }
                    ],
                }
            ).encode()
            sig = "sha256=" + hmac.new(hook["app_secret"].encode(), body, hashlib.sha256).hexdigest()
            with contextlib.suppress(httpx.HTTPError):
                await c.post(
                    hook["url"], content=body,
                    headers={"Content-Type": "application/json", "X-Hub-Signature-256": sig},
                )  # fmt: skip


@app.post("/{version}/{phone_id}/messages")
async def whatsapp_send(version: str, phone_id: str, request: Request, tasks: BackgroundTasks):
    if not request.headers.get("authorization", "").startswith("Bearer EAAmock"):
        return JSONResponse({"error": {"message": "Invalid OAuth access token.", "type": "OAuthException",
                                       "code": 190}}, 401)  # fmt: skip
    b = await request.json()
    code = _fail_now("whatsapp")
    if code:
        return JSONResponse({"error": {"message": "Rate limit hit", "code": 130429}}, code)
    if b.get("messaging_product") != "whatsapp" or b.get("type") != "template" or not b.get("template", {}).get("name"):
        return JSONResponse({"error": {"message": "Only template messages are supported here", "code": 100}}, 400)
    to = "+" + str(b.get("to", ""))
    if to == BAD_NUMBER:
        return JSONResponse({"error": {"message": "Message undeliverable", "code": 131026}}, 400)
    params = [p.get("text") for c in b["template"].get("components") or [] for p in c.get("parameters") or []]
    wamid = "wamid." + secrets.token_hex(12)
    OUTBOX.append({"channel": "whatsapp", "id": wamid, "to": to, "phone_number_id": phone_id,
                   "template": b["template"]["name"], "language": b["template"].get("language", {}).get("code"),
                   "params": params, "at": time.time()})  # fmt: skip
    tasks.add_task(_wa_webhooks, phone_id, wamid, to)
    return {"messaging_product": "whatsapp", "contacts": [{"input": b.get("to"), "wa_id": b.get("to")}],
            "messages": [{"id": wamid}]}  # fmt: skip


# ------------------------------------------------------------------ test controls
@app.get("/mock/outbox")
async def outbox(channel: str | None = None, to: str | None = None):
    return [m for m in OUTBOX if (not channel or m["channel"] == channel) and (not to or m["to"] == to)]


@app.delete("/mock/outbox")
async def clear_outbox():
    OUTBOX.clear()
    return {"ok": True}


@app.post("/mock/whatsapp/webhook")
async def register_wa_hook(request: Request):
    b = await request.json()
    if not (b.get("phone_number_id") and b.get("url") and b.get("app_secret")):
        raise HTTPException(400, "phone_number_id, url and app_secret are required")
    WA_HOOKS[str(b["phone_number_id"])] = {"url": b["url"], "app_secret": b["app_secret"]}
    return {"ok": True}


@app.post("/mock/config")
async def config(request: Request):
    b = await request.json()
    if b.get("fail_next"):
        FAIL_NEXT[b["fail_next"]] = int(b.get("status", 503))
    return {"ok": True, "fail_next": FAIL_NEXT}
