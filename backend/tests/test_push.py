"""Web Push: keys, VAPID, encryption, the push-service allowlist and the API's guards (no database)."""

import json
import os
import uuid
from types import SimpleNamespace

import http_ece
import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser, get_claims, get_current_user, get_db
from app.main import app as main_app
from app.services import push

PRIV, PUB = push.generate_keys()


def settings(**kw):
    base = {
        "vapid_private_key": PRIV,
        "vapid_public_key": PUB,
        "vapid_subject": "mailto:ops@school.example",
        "push_allowed_hosts": "",
    }
    return SimpleNamespace(**{**base, **kw})


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(push, "get_settings", lambda: settings())


def browser_keys():
    """What a browser's pushManager.subscribe() gives: a P-256 public key and a 16-byte secret."""
    key = ec.generate_private_key(ec.SECP256R1())
    auth = os.urandom(16)
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return key, auth, push.b64url(pub), push.b64url(auth)


# ---------------------------------------------------------------- keys
def test_generated_keys_work_and_the_public_key_is_derived():
    v = push.vapid()
    assert v.public_key_b64 == PUB and len(push.b64url_decode(PUB)) == 65 and len(push.b64url_decode(PRIV)) == 32
    assert push.configured()


def test_misconfiguration_is_reported_not_crashing(monkeypatch):
    _, other_pub = push.generate_keys()
    monkeypatch.setattr(push, "get_settings", lambda: settings(vapid_public_key=other_pub))
    with pytest.raises(push.PushNotConfigured, match="doesn't match"):
        push.vapid()
    monkeypatch.setattr(push, "get_settings", lambda: settings(vapid_private_key="not-a-key!!"))
    assert not push.configured()
    monkeypatch.setattr(push, "get_settings", lambda: settings(vapid_private_key=""))
    assert not push.configured()
    monkeypatch.setattr(push, "get_settings", lambda: settings(vapid_subject=""))
    assert not push.configured()


# ---------------------------------------------------------------- where we may send
@pytest.mark.parametrize(
    "endpoint,ok",
    [
        ("https://fcm.googleapis.com/fcm/send/abc", True),
        ("https://updates.push.services.mozilla.com/wpush/v2/abc", True),
        ("https://web.push.apple.com/QAbc", True),
        ("https://wns2-pn1p.notify.windows.com/w/?token=abc", True),
        ("https://fcm.googleapis.com:443/fcm/send/abc", True),
        ("http://fcm.googleapis.com/fcm/send/abc", False),  # not https
        ("https://fcm.googleapis.com:8443/x", False),  # odd port
        ("https://evil.example/fcm.googleapis.com/x", False),  # host is what counts
        ("https://fcm.googleapis.com.evil.example/x", False),
        ("https://push.apple.com/x", False),  # "*.push.apple.com" means a sub-domain
        ("https://user:pw@fcm.googleapis.com/x", False),
        ("https://169.254.169.254/latest/meta-data", False),  # no internal addresses
        ("http://localhost:9996/push/x", False),  # the test stand-in only when listed
    ],
)
def test_only_known_push_services(endpoint, ok):
    assert push.endpoint_allowed(endpoint) is ok


def test_a_test_stand_in_must_be_listed_exactly(monkeypatch):
    monkeypatch.setattr(push, "get_settings", lambda: settings(push_allowed_hosts="http://localhost:9996"))
    assert push.endpoint_allowed("http://localhost:9996/push/x")
    assert not push.endpoint_allowed("http://localhost:9997/push/x")
    assert not push.endpoint_allowed("https://fcm.googleapis.com/x")  # the list replaces the defaults


def test_device_keys_are_checked():
    _, _, p256dh, auth = browser_keys()
    assert push.valid_keys(p256dh, auth)
    assert not push.valid_keys("A" * 87, auth)  # not a point on the curve
    assert not push.valid_keys(p256dh, push.b64url(b"short"))


# ---------------------------------------------------------------- the message itself
def test_only_the_device_can_read_the_message():
    key, auth, p256dh, auth_b64 = browser_keys()
    payload = push.message("Fee received", "₹1,500 received for Aarav.", "/portal", "n1", "Green Valley")
    body = push.encrypt(payload, p256dh, auth_b64)
    assert payload not in body
    plain = http_ece.decrypt(body, private_key=key, auth_secret=auth, version="aes128gcm")
    assert json.loads(plain) == {
        "title": "Fee received",
        "body": "₹1,500 received for Aarav.",
        "url": "/portal",
        "tag": "n1",
        "school": "Green Valley",
    }
    other, *_ = browser_keys()
    with pytest.raises(Exception):  # noqa: B017 - any failure: another key can't open it
        http_ece.decrypt(body, private_key=other, auth_secret=auth, version="aes128gcm")


def test_vapid_header_is_signed_for_the_push_service():
    header = push.vapid_header("https://fcm.googleapis.com/fcm/send/abc", push.vapid())
    parts = dict(p.strip().split("=", 1) for p in header.removeprefix("vapid ").split(","))
    assert parts["k"] == PUB
    pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), push.b64url_decode(parts["k"]))
    claims = jwt.decode(parts["t"], pub, algorithms=["ES256"], audience="https://fcm.googleapis.com")
    assert claims["sub"] == "mailto:ops@school.example"


def test_long_messages_are_trimmed_to_fit():
    raw = push.message("Notice", "x" * 1000, "/notices", "n", "S")
    assert len(raw) <= push.MAX_PAYLOAD
    raw = push.message("Notice", "अ" * 1000, "/notices", "n", "S")  # 3 bytes per character in UTF-8
    assert len(raw) <= push.MAX_PAYLOAD and json.loads(raw)["body"].endswith("…")


@pytest.mark.parametrize("code,want", [(201, "sent"), (200, "sent"), (410, "gone"), (404, "gone"), (429, "retry"),
                                       (503, "retry"), (400, "failed"), (403, "failed"), (413, "failed")])  # fmt: skip
def test_push_service_answers(code, want):
    assert push.outcome(code) == want


# ---------------------------------------------------------------- sending
def run(coro):
    import asyncio

    return asyncio.run(coro)


def test_send_posts_an_encrypted_signed_request():
    key, auth, p256dh, auth_b64 = browser_keys()
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["req"] = request
        return httpx.Response(201)

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await push.send(c, "https://fcm.googleapis.com/fcm/send/x", p256dh, auth_b64, b'{"title":"Hi"}')

    assert run(go()) == ("sent", None)
    req = seen["req"]
    assert req.headers["content-encoding"] == "aes128gcm" and req.headers["ttl"] == str(push.TTL_SECONDS)
    assert req.headers["authorization"].startswith("vapid t=")
    assert http_ece.decrypt(req.content, private_key=key, auth_secret=auth, version="aes128gcm") == b'{"title":"Hi"}'


def test_send_outcomes_and_no_request_to_unknown_hosts():
    _, _, p256dh, auth_b64 = browser_keys()
    calls = []

    def handler(request):
        calls.append(request.url.host)
        if "gone" in request.url.path:
            return httpx.Response(410)
        raise httpx.ConnectError("down")

    async def go(endpoint):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            return await push.send(c, endpoint, p256dh, auth_b64, b"{}")

    assert run(go("https://fcm.googleapis.com/gone"))[0] == "gone"
    assert run(go("https://fcm.googleapis.com/down"))[0] == "retry"
    assert run(go("https://internal.example/x"))[0] == "gone"
    assert calls == ["fcm.googleapis.com", "fcm.googleapis.com"]  # never called the unknown host


# ---------------------------------------------------------------- API guards (before the database)
def api_client(monkeypatch, **kw):
    import app.api.v1.routes.push as routes

    monkeypatch.setattr(push, "get_settings", lambda: settings(**kw))

    async def _no_limit(*a, **k):
        return None

    monkeypatch.setattr(routes, "limit", _no_limit)
    user = CurrentUser(
        id=uuid.UUID("00000000-0000-4000-8000-000000000001"),
        email="p@example.com",
        full_name="Parent",
        is_super_admin=False,
    )

    async def _db():
        yield None

    main_app.dependency_overrides = {
        get_claims: lambda: {"sub": str(user.id)},
        get_db: _db,
        get_current_user: lambda: user,
    }
    return TestClient(main_app)


def test_config_tells_the_browser_the_public_key(monkeypatch):
    try:
        c = api_client(monkeypatch)
        assert c.get("/api/v1/push/config").json() == {"enabled": True, "public_key": PUB}
        c = api_client(monkeypatch, vapid_private_key="")
        assert c.get("/api/v1/push/config").json() == {"enabled": False, "public_key": None}
    finally:
        main_app.dependency_overrides = {}


def test_subscribing_refuses_unknown_services_and_bad_keys(monkeypatch):
    _, _, p256dh, auth_b64 = browser_keys()
    try:
        c = api_client(monkeypatch)
        r = c.post(
            "/api/v1/push/subscriptions",
            json={"endpoint": "https://evil.example/x", "keys": {"p256dh": p256dh, "auth": auth_b64}},
        )
        assert r.status_code == 422 and "push service" in r.json()["detail"]
        r = c.post(
            "/api/v1/push/subscriptions",
            json={"endpoint": "https://fcm.googleapis.com/x", "keys": {"p256dh": "A" * 87, "auth": auth_b64}},
        )
        assert r.status_code == 422 and "keys" in r.json()["detail"]
        c = api_client(monkeypatch, vapid_private_key="")
        r = c.post(
            "/api/v1/push/subscriptions",
            json={"endpoint": "https://fcm.googleapis.com/x", "keys": {"p256dh": p256dh, "auth": auth_b64}},
        )
        assert r.status_code == 409
    finally:
        main_app.dependency_overrides = {}


def test_push_needs_a_signed_in_person():
    main_app.dependency_overrides = {}
    c = TestClient(main_app)
    assert c.get("/api/v1/push/config").status_code == 401
    assert c.post("/api/v1/push/test", json={}).status_code == 401
