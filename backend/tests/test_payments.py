import asyncio
import base64
import hashlib
import hmac
import json
from decimal import Decimal

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import ValidationError

from app.api.v1.routes.payments import OrderIn, RefundIn, SettingsIn, VerifyIn
from app.core.config import get_settings
from app.services import razorpay as rz
from app.services import secrets


# ---------------------------------------------------------------- money
def test_paise_are_exact():
    assert rz.to_paise(Decimal("2500.00")) == 250000
    assert rz.to_paise(Decimal("0.10")) == 10
    assert rz.from_paise(250050) == Decimal("2500.50")
    with pytest.raises(ValueError):
        rz.to_paise(Decimal("10.005"))  # never rounded silently


# ---------------------------------------------------------------- signatures
def _sig(secret: str, msg: bytes) -> str:
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()


def test_checkout_signature():
    good = _sig("key_secret_x", b"order_ABC|pay_XYZ")
    assert rz.payment_signature_ok("order_ABC", "pay_XYZ", good, "key_secret_x")
    assert not rz.payment_signature_ok("order_ABC", "pay_OTHER", good, "key_secret_x")  # another payment
    assert not rz.payment_signature_ok("order_OTHER", "pay_XYZ", good, "key_secret_x")  # another order
    assert not rz.payment_signature_ok("order_ABC", "pay_XYZ", good, "wrong_secret")
    assert not rz.payment_signature_ok("order_ABC", "pay_XYZ", "", "key_secret_x")


def test_webhook_signature_is_over_the_raw_body():
    body = b'{"event":"payment.captured","payload":{}}'
    sig = _sig("hook_secret", body)
    assert rz.webhook_signature_ok(body, sig, "hook_secret")
    assert not rz.webhook_signature_ok(body + b" ", sig, "hook_secret")  # re-serialised JSON would not match
    assert not rz.webhook_signature_ok(body, None, "hook_secret")
    assert not rz.webhook_signature_ok(body, sig, "")


# ---------------------------------------------------------------- method descriptions
def test_describe_method():
    assert rz.describe_method({"method": "upi", "vpa": "ravi.kumar@okaxis"}) == ("upi", "UPI · ra***@okaxis")
    assert rz.describe_method({"method": "card", "card": {"network": "Visa", "type": "debit", "last4": "1111"}}) == (
        "card",
        "Card · Visa Debit •••• 1111",
    )
    assert rz.describe_method({"method": "netbanking", "bank": "HDFC"}) == ("netbanking", "Net banking · HDFC")
    assert rz.describe_method({"method": "upi"}) == ("upi", "UPI")
    assert rz.mask_vpa("not-a-vpa") is None


# ---------------------------------------------------------------- inputs
def test_settings_input():
    s = SettingsIn(key_id=" rzp_test_AbCdEf123456 ", key_secret="  ", webhook_secret="hook-secret-1", enabled=True)
    assert s.key_id == "rzp_test_AbCdEf123456" and s.key_secret is None  # blank = keep the stored secret
    for bad in ({"key_id": "sk_test_123456"}, {"key_id": "rzp_prod_123456"}, {"key_secret": "short"}, {"extra": 1}):
        with pytest.raises(ValidationError):
            SettingsIn(**{"key_id": "rzp_test_AbCdEf123456", "enabled": False, **bad})


def test_order_and_verify_inputs():
    with pytest.raises(ValidationError):
        OrderIn(student_id="00000000-0000-0000-0000-000000000001", due_ids=[])
    with pytest.raises(ValidationError):  # the browser can't send an amount
        OrderIn(student_id="00000000-0000-0000-0000-000000000001", due_ids=[], amount="1")  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        VerifyIn(
            razorpay_order_id="order_1234", razorpay_payment_id="pay_1234", razorpay_signature="x" * 64, status="ok"
        )
    assert RefundIn(reason="  Paid   twice  ").reason == "Paid twice"
    with pytest.raises(ValidationError):
        RefundIn(reason="x")


# ---------------------------------------------------------------- secrets at rest
def test_secrets_round_trip(monkeypatch):
    monkeypatch.setattr(get_settings(), "payment_secrets_key", Fernet.generate_key().decode())
    token = secrets.encrypt("rzp-secret-value")
    assert "rzp-secret-value" not in token
    assert secrets.decrypt(token) == "rzp-secret-value"
    monkeypatch.setattr(get_settings(), "payment_secrets_key", Fernet.generate_key().decode())  # key changed
    with pytest.raises(secrets.SecretsUnavailable):
        secrets.decrypt(token)
    monkeypatch.setattr(get_settings(), "payment_secrets_key", "")
    with pytest.raises(secrets.SecretsUnavailable):
        secrets.encrypt("x")


# ---------------------------------------------------------------- the HTTP client
def _client(handler) -> rz.RazorpayClient:
    return rz.RazorpayClient(
        "rzp_test_K", "s3cret", base_url="https://api.example/v1", transport=httpx.MockTransport(handler)
    )


def test_create_order_sends_paise_with_basic_auth():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["auth"] = req.headers["authorization"]
        seen["url"] = str(req.url)
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"id": "order_1", "amount": 250000, "currency": "INR"})

    out = asyncio.run(_client(handler).create_order(250000, "OP-" + "x" * 60, {"a": "b"}))
    assert out["id"] == "order_1"
    assert seen["url"] == "https://api.example/v1/orders"
    assert seen["auth"] == "Basic " + base64.b64encode(b"rzp_test_K:s3cret").decode()
    assert seen["body"] == {"amount": 250000, "currency": "INR", "receipt": "OP-" + "x" * 37, "notes": {"a": "b"}}


def test_gateway_errors_are_readable():
    c401 = _client(lambda r: httpx.Response(401, json={"error": {"description": "Authentication failed"}}))
    with pytest.raises(rz.GatewayError) as e:
        asyncio.run(c401.check_keys())
    assert e.value.status == 401 and "rejected the key" in e.value.message
    c400 = _client(
        lambda r: httpx.Response(400, json={"error": {"description": "The payment has been fully refunded already"}})
    )
    with pytest.raises(rz.GatewayError) as e:
        asyncio.run(c400.refund("pay_1", 100, {}, "RF-1"))
    assert e.value.message == "The payment has been fully refunded already"

    def down(r: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route")

    with pytest.raises(rz.GatewayError) as e:
        asyncio.run(_client(down).fetch_payment("pay_1"))
    assert "Couldn't reach Razorpay" in e.value.message
