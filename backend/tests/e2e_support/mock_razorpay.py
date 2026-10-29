"""A local stand-in for Razorpay — FOR TEST ENVIRONMENTS ONLY, never production.

Run:  uvicorn tests.e2e_support.mock_razorpay:app --port 9998   (from backend/)

Implements the parts of Razorpay's API the ERP uses (orders, payments, capture,
refunds), a fake Checkout script, and signed webhooks, following Razorpay's
documented formats. Accounts: any key id "rzp_test_<X>" whose secret is
"mock_secret_<X>"; anything else gets 401.

Test controls:
  POST /mock/pay       {key, order_id, method, outcome: success|fail|authorized, notify}
  POST /mock/webhook   {key_id, url, secret}            where to send webhooks for an account
  POST /mock/config    {refund_status: processed|pending, auto_capture: bool}
  GET  /checkout.js    window.Razorpay for the browser
"""

import asyncio
import base64
import hashlib
import hmac
import json
import secrets
import time

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ORDERS: dict[str, dict] = {}
PAYMENTS: dict[str, dict] = {}
REFUNDS: dict[str, dict] = {}
HOOKS: dict[str, dict] = {}  # key_id -> {url, secret}
CONFIG = {"refund_status": "processed", "auto_capture": True}
SENT: list[dict] = []  # webhooks sent (for tests)


def _id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(7)}"


def secret_for(key_id: str) -> str | None:
    return f"mock_secret_{key_id[9:]}" if key_id.startswith("rzp_test_") else None


def account(request: Request) -> str:
    h = request.headers.get("authorization", "")
    if not h.startswith("Basic "):
        raise HTTPException(
            401, detail={"error": {"code": "BAD_REQUEST_ERROR", "description": "Authentication failed"}}
        )
    key, _, sec = base64.b64decode(h[6:]).decode().partition(":")
    if secret_for(key) != sec:
        raise HTTPException(
            401, detail={"error": {"code": "BAD_REQUEST_ERROR", "description": "Authentication failed"}}
        )
    return key


def err(status: int, desc: str):
    return HTTPException(status, detail={"error": {"code": "BAD_REQUEST_ERROR", "description": desc}})


@app.exception_handler(HTTPException)
async def _http(_req, exc: HTTPException):  # Razorpay's error shape: {"error": {...}}
    body = exc.detail if isinstance(exc.detail, dict) else {"error": {"description": str(exc.detail)}}
    return Response(json.dumps(body), status_code=exc.status_code, media_type="application/json")


# ------------------------------------------------------------------ API
@app.get("/v1/orders")
async def list_orders(request: Request):
    key = account(request)
    items = [o for o in ORDERS.values() if o["_key"] == key]
    return {"entity": "collection", "count": len(items), "items": [_public(o) for o in items[:1]]}


@app.post("/v1/orders")
async def create_order(request: Request):
    key = account(request)
    body = await request.json()
    amount = body.get("amount")
    if not isinstance(amount, int) or amount < 100:
        raise err(400, "The amount must be atleast INR 1.00")
    if body.get("currency") != "INR":
        raise err(400, "Currency is not supported")
    if len(str(body.get("receipt") or "")) > 40:
        raise err(400, "receipt: the length must be no more than 40.")
    o = {
        "id": _id("order"),
        "entity": "order",
        "amount": amount,
        "amount_paid": 0,
        "amount_due": amount,
        "currency": "INR",
        "receipt": body.get("receipt"),
        "status": "created",
        "attempts": 0,
        "notes": body.get("notes") or {},
        "created_at": int(time.time()),
        "_key": key,
    }
    ORDERS[o["id"]] = o
    return _public(o)


@app.get("/v1/orders/{order_id}/payments")
async def order_payments(order_id: str, request: Request):
    key = account(request)
    o = ORDERS.get(order_id)
    if not o or o["_key"] != key:
        raise err(400, "The id provided does not exist")
    items = [_public(p) for p in PAYMENTS.values() if p["order_id"] == order_id]
    return {"entity": "collection", "count": len(items), "items": items}


@app.get("/v1/payments/{pid}")
async def fetch_payment(pid: str, request: Request):
    key = account(request)
    p = PAYMENTS.get(pid)
    if not p or p["_key"] != key:
        raise err(400, "The id provided does not exist")
    return _public(p)


@app.post("/v1/payments/{pid}/capture")
async def capture(pid: str, request: Request, bg: BackgroundTasks):
    key = account(request)
    p = PAYMENTS.get(pid)
    body = await request.json()
    if not p or p["_key"] != key:
        raise err(400, "The id provided does not exist")
    if p["status"] != "authorized":
        raise err(400, "This payment has already been captured")
    if body.get("amount") != p["amount"]:
        raise err(400, "Capture amount must be equal to the amount authorized")
    _capture(p, bg)
    return _public(p)


@app.post("/v1/payments/{pid}/refund")
async def refund(pid: str, request: Request, bg: BackgroundTasks):
    key = account(request)
    p = PAYMENTS.get(pid)
    body = await request.json()
    if not p or p["_key"] != key:
        raise err(400, "The id provided does not exist")
    if p["status"] not in ("captured", "refunded"):
        raise err(400, "Payment has not been captured")
    amount = body.get("amount", p["amount"] - p["amount_refunded"])
    if amount > p["amount"] - p["amount_refunded"]:
        raise err(400, "The payment has been fully refunded already")
    r = {
        "id": _id("rfnd"),
        "entity": "refund",
        "amount": amount,
        "currency": "INR",
        "payment_id": pid,
        "notes": body.get("notes") or {},
        "receipt": body.get("receipt"),
        "status": CONFIG["refund_status"],
        "speed_requested": body.get("speed", "normal"),
        "created_at": int(time.time()),
        "_key": key,
    }
    REFUNDS[r["id"]] = r
    p["amount_refunded"] += amount
    p["refund_status"] = "full" if p["amount_refunded"] == p["amount"] else "partial"
    if p["amount_refunded"] == p["amount"]:
        p["status"] = "refunded"
    if r["status"] == "processed":
        bg.add_task(
            _webhook, key, "refund.processed", {"refund": {"entity": _public(r)}, "payment": {"entity": _public(p)}}
        )
    return _public(r)


@app.post("/mock/refunds/{rid}/settle")
async def settle_refund(rid: str, request: Request, bg: BackgroundTasks):
    """Test control: a pending refund ends (processed or failed) and the webhook is sent."""
    body = await request.json()
    r = REFUNDS[rid]
    r["status"] = body.get("status", "processed")
    event = "refund.processed" if r["status"] == "processed" else "refund.failed"
    payload = {
        "refund": {
            "entity": {
                **_public(r),
                **({"error_description": "Refund failed at the bank"} if r["status"] == "failed" else {}),
            }
        }
    }
    bg.add_task(_webhook, r["_key"], event, payload)
    return _public(r)


# ------------------------------------------------------------------ checkout (browser)
def _capture(p: dict, bg: BackgroundTasks | None) -> None:
    p["status"], p["captured"] = "captured", True
    o = ORDERS[p["order_id"]]
    o["status"], o["amount_paid"], o["amount_due"] = "paid", o["amount"], 0
    if bg is not None and p.get("_notify", True):
        bg.add_task(_webhook, p["_key"], "payment.captured", {"payment": {"entity": _public(p)}})
        bg.add_task(
            _webhook, p["_key"], "order.paid", {"payment": {"entity": _public(p)}, "order": {"entity": _public(o)}}
        )


@app.post("/mock/pay")
async def pay(request: Request, bg: BackgroundTasks):
    body = await request.json()
    key, order_id = body["key"], body["order_id"]
    o = ORDERS.get(order_id)
    if not o or o["_key"] != key:
        raise err(400, "Invalid order")
    if o["status"] == "paid":
        raise err(400, "Order already paid")
    method = body.get("method", "upi")
    outcome = body.get("outcome", "success")
    o["attempts"] += 1
    p = {
        "id": _id("pay"),
        "entity": "payment",
        "amount": o["amount"],
        "currency": "INR",
        "status": "created",
        "order_id": order_id,
        "method": method,
        "captured": False,
        "description": None,
        "amount_refunded": 0,
        "refund_status": None,
        "email": "parent@example.com",
        "contact": "+919800000000",
        "fee": 0,
        "tax": 0,
        "error_code": None,
        "error_description": None,
        "created_at": int(time.time()),
        "_key": key,
        "_notify": body.get("notify", True),
    }
    if method == "upi":
        p["vpa"] = "testparent@okhdfcbank"
    elif method == "card":
        p["card"] = {"network": "Visa", "type": "debit", "last4": "1111"}
    elif method == "netbanking":
        p["bank"] = "HDFC"
    PAYMENTS[p["id"]] = p
    if outcome == "fail":
        p["status"], p["error_code"] = "failed", "BAD_REQUEST_ERROR"
        p["error_description"] = "Payment failed because the bank declined it"
        if p["_notify"]:
            bg.add_task(_webhook, key, "payment.failed", {"payment": {"entity": _public(p)}})
        return {
            "error": {
                "code": "BAD_REQUEST_ERROR",
                "description": p["error_description"],
                "source": "bank",
                "step": "payment_authorization",
                "reason": "payment_failed",
                "metadata": {"order_id": order_id, "payment_id": p["id"]},
            }
        }
    p["status"] = "authorized"
    if outcome == "success" and CONFIG["auto_capture"]:
        _capture(p, bg)
    sig = hmac.new(secret_for(key).encode(), f"{order_id}|{p['id']}".encode(), hashlib.sha256).hexdigest()
    return {"razorpay_payment_id": p["id"], "razorpay_order_id": order_id, "razorpay_signature": sig}


CHECKOUT_JS = r"""
(function () {
  var BASE = (document.currentScript && document.currentScript.src || "").replace(/\/checkout\.js.*$/, "");
  function Razorpay(options) { this.o = options || {}; this.h = {}; }
  Razorpay.prototype.on = function (ev, fn) { this.h[ev] = fn; };
  Razorpay.prototype.close = function () { var el = document.getElementById("mock-razorpay"); if (el) el.remove(); };
  Razorpay.prototype.open = function () {
    var o = this.o, self = this;
    var shown = ["upi", "card", "netbanking"].filter(function (m) { return !o.method || o.method[m] !== false; });
    var ov = document.createElement("div");
    ov.id = "mock-razorpay";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Razorpay Checkout (test)");
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999";
    var box = document.createElement("div");
    box.style.cssText = "background:#fff;padding:20px;border-radius:8px;min-width:300px;font:14px sans-serif";
    box.innerHTML = "<p><b>Razorpay test checkout</b></p><p data-testid='mock-rzp-amount'>Pay ₹" + (o.amount / 100).toFixed(2) +
      " to " + o.name + "</p><p data-testid='mock-rzp-description'>" + (o.description || "") + "</p>" +
      "<p data-testid='mock-rzp-methods'>Methods: " + shown.join(", ") + "</p>";
    function btn(label, id, fn) { var b = document.createElement("button"); b.textContent = label; b.setAttribute("data-testid", id);
      b.style.cssText = "display:block;margin:6px 0;padding:6px 10px"; b.onclick = fn; box.appendChild(b); }
    function pay(method, outcome, notifyHandler) {
      fetch(BASE + "/mock/pay", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: o.key, order_id: o.order_id, method: method, outcome: outcome }) })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res.error) {  // like Razorpay: report the failure, keep the window open for a retry
            if (self.h["payment.failed"]) self.h["payment.failed"]({ error: res.error });
            var m = document.getElementById("mock-rzp-error") || box.insertBefore(document.createElement("p"), box.firstChild);
            m.id = "mock-rzp-error"; m.setAttribute("data-testid", "mock-rzp-error"); m.textContent = "Payment failed: " + res.error.description;
            return;
          }
          self.close();
          if (notifyHandler) o.handler(res); else if (o.modal && o.modal.ondismiss) o.modal.ondismiss();
        });
    }
    shown.forEach(function (m) { btn("Pay with " + m, "mock-pay-" + m, function () { pay(m, "success", true); }); });
    btn("Fail the payment", "mock-pay-fail", function () { pay("upi", "fail", true); });
    btn("Pay, then close the window", "mock-pay-silent", function () { pay("upi", "success", false); });
    btn("Close", "mock-close", function () { self.close(); if (o.modal && o.modal.ondismiss) o.modal.ondismiss(); });
    ov.appendChild(box);
    document.body.appendChild(ov);
  };
  window.Razorpay = Razorpay;
})();
"""


@app.get("/checkout.js")
async def checkout_js():
    return Response(CHECKOUT_JS, media_type="application/javascript")


# ------------------------------------------------------------------ webhooks
@app.post("/mock/webhook")
async def set_webhook(request: Request):
    body = await request.json()
    HOOKS[body["key_id"]] = {"url": body["url"], "secret": body["secret"]}
    return {"ok": True}


@app.post("/mock/config")
async def set_config(request: Request):
    CONFIG.update(await request.json())
    return CONFIG


@app.get("/mock/sent")
async def sent():
    return SENT


async def _webhook(key: str, event: str, payload: dict) -> None:
    hook = HOOKS.get(key)
    if not hook:
        return
    await asyncio.sleep(0.2)
    body = json.dumps(
        {
            "entity": "event",
            "account_id": "acc_mock",
            "event": event,
            "contains": list(payload),
            "payload": payload,
            "created_at": int(time.time()),
        }
    ).encode()
    sig = hmac.new(hook["secret"].encode(), body, hashlib.sha256).hexdigest()
    event_id = _id("evt")
    for _ in range(3):  # Razorpay retries failed deliveries
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                res = await c.post(
                    hook["url"],
                    content=body,
                    headers={
                        "Content-Type": "application/json",
                        "X-Razorpay-Signature": sig,
                        "X-Razorpay-Event-Id": event_id,
                    },
                )
            SENT.append({"event": event, "event_id": event_id, "status": res.status_code, "response": res.text[:200]})
            if res.status_code < 300:
                return
        except httpx.HTTPError as e:
            SENT.append({"event": event, "event_id": event_id, "status": 0, "response": str(e)})
        await asyncio.sleep(1)


def _public(x: dict) -> dict:
    return {k: v for k, v in x.items() if not k.startswith("_")}
