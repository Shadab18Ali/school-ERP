"""Razorpay: orders, payments, captures, refunds and signature checks.

Only the API talks to Razorpay, with the school's key id and key secret. The
browser gets the key id (public by design) and an order id, nothing else.

Signatures (Razorpay's documented scheme):
  * Checkout:  HMAC-SHA256(order_id + "|" + payment_id, key_secret), hex
  * Webhooks:  HMAC-SHA256(raw request body, webhook_secret), hex, in X-Razorpay-Signature
A valid checkout signature is necessary but not enough: the payment is also
fetched from Razorpay and its order, amount, currency and status are checked.
"""

import hashlib
import hmac
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import httpx

from app.core.config import get_settings


class GatewayError(Exception):
    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.message = message
        self.status = status


def to_paise(amount: Decimal) -> int:
    """₹ to paise, exactly. Amounts with more than 2 decimals are refused, not rounded."""
    paise = amount * 100
    if paise != paise.to_integral_value():
        raise ValueError(f"{amount} has more than 2 decimal places")
    return int(paise)


def from_paise(paise: int) -> Decimal:
    return (Decimal(paise) / 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _hmac(secret: str, message: bytes) -> str:
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def payment_signature_ok(order_id: str, payment_id: str, signature: str, key_secret: str) -> bool:
    if not (order_id and payment_id and signature and key_secret):
        return False
    return hmac.compare_digest(_hmac(key_secret, f"{order_id}|{payment_id}".encode()), signature)


def webhook_signature_ok(body: bytes, signature: str | None, webhook_secret: str) -> bool:
    if not (signature and webhook_secret):
        return False
    return hmac.compare_digest(_hmac(webhook_secret, body), signature)


def mask_vpa(vpa: str | None) -> str | None:
    """ravi.kumar@okaxis -> ra***@okaxis (enough to recognise, not to reuse)."""
    if not vpa or "@" not in vpa:
        return None
    name, _, handle = vpa.partition("@")
    return f"{name[:2]}***@{handle}"


def describe_method(p: dict[str, Any]) -> tuple[str | None, str | None]:
    """(method, short human description) of a Razorpay payment entity."""
    m = p.get("method")
    if m == "upi":
        vpa = mask_vpa(p.get("vpa") or (p.get("upi") or {}).get("vpa"))
        return m, "UPI" + (f" · {vpa}" if vpa else "")
    if m == "card":
        c = p.get("card") or {}
        bits = [
            c.get("network"),
            c.get("type") and str(c["type"]).capitalize(),
            c.get("last4") and f"•••• {c['last4']}",
        ]
        return m, "Card" + (" · " + " ".join(b for b in bits if b) if any(bits) else "")
    if m == "netbanking":
        return m, "Net banking" + (f" · {p['bank']}" if p.get("bank") else "")
    if m == "wallet":
        return m, "Wallet" + (f" · {p['wallet']}" if p.get("wallet") else "")
    return m, (str(m).upper() if m else None)


class RazorpayClient:
    def __init__(
        self,
        key_id: str,
        key_secret: str,
        *,
        base_url: str | None = None,
        timeout: float = 20,
        transport: httpx.AsyncBaseTransport | None = None,  # tests
    ):
        self._base = (base_url or get_settings().razorpay_api_base).rstrip("/")
        self._auth = (key_id, key_secret)
        self._timeout = timeout
        self._transport = transport

    async def _call(self, method: str, path: str, **kw: Any) -> Any:
        try:
            async with httpx.AsyncClient(
                base_url=self._base, auth=self._auth, timeout=self._timeout, transport=self._transport
            ) as c:
                res = await c.request(method, path, **kw)
        except httpx.HTTPError:
            raise GatewayError("Couldn't reach Razorpay. Please try again.") from None
        try:
            data = res.json()
        except ValueError:
            data = {}
        if res.status_code == 401:
            raise GatewayError("Razorpay rejected the key id or key secret.", status=401)
        if res.status_code >= 400:
            desc = (data.get("error") or {}).get("description") if isinstance(data, dict) else None
            raise GatewayError(desc or f"Razorpay returned an error ({res.status_code}).", status=res.status_code)
        return data

    async def check_keys(self) -> None:
        await self._call("GET", "/orders", params={"count": 1})

    async def create_order(self, amount_paise: int, receipt: str, notes: dict[str, str]) -> dict:
        return await self._call(
            "POST",
            "/orders",
            json={"amount": amount_paise, "currency": "INR", "receipt": receipt[:40], "notes": notes},
        )

    async def fetch_payment(self, payment_id: str) -> dict:
        return await self._call("GET", f"/payments/{payment_id}", params={"expand[]": "card"})

    async def order_payments(self, order_id: str) -> list[dict]:
        data = await self._call("GET", f"/orders/{order_id}/payments")
        return list(data.get("items") or [])

    async def capture(self, payment_id: str, amount_paise: int) -> dict:
        return await self._call(
            "POST", f"/payments/{payment_id}/capture", json={"amount": amount_paise, "currency": "INR"}
        )

    async def refund(self, payment_id: str, amount_paise: int, notes: dict[str, str], receipt: str) -> dict:
        return await self._call(
            "POST",
            f"/payments/{payment_id}/refund",
            json={"amount": amount_paise, "speed": "normal", "notes": notes, "receipt": receipt[:40]},
        )
