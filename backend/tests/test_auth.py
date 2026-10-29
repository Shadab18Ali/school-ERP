import time
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient
from jwt import InvalidTokenError

from app.core.deps import CurrentUser, MembershipInfo, get_claims, get_current_user, get_db
from app.core.security import TokenVerifier
from app.main import app

SECRET = "test-secret-that-is-long-enough-for-hs256-ok"
ISSUER = "https://example.supabase.co/auth/v1"


def make_token(**overrides):
    claims = {
        "sub": str(uuid.uuid4()),
        "aud": "authenticated",
        "role": "authenticated",
        "iss": ISSUER,
        "exp": int(time.time()) + 300,
    }
    claims.update(overrides)
    return jwt.encode(claims, SECRET, algorithm="HS256")


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def override_user(user: CurrentUser):
    async def _db():
        yield None

    app.dependency_overrides[get_claims] = lambda: {"sub": str(user.id)}
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user


def test_health(client):
    assert client.get("/api/v1/health").json() == {"status": "ok"}


def test_verifier_accepts_valid_token():
    assert TokenVerifier(ISSUER, SECRET).verify(make_token())["role"] == "authenticated"


@pytest.mark.parametrize(
    "bad",
    [
        {"aud": "anon"},
        {"iss": "https://evil.example/auth/v1"},
        {"exp": int(time.time()) - 10},
        {"role": "anon"},
    ],
)
def test_verifier_rejects_bad_claims(bad):
    with pytest.raises(InvalidTokenError):
        TokenVerifier(ISSUER, SECRET).verify(make_token(**bad))


def test_verifier_rejects_wrong_secret():
    token = jwt.encode(
        {"sub": "x", "aud": "authenticated", "iss": ISSUER, "exp": int(time.time()) + 60, "role": "authenticated"},
        "another-secret-another-secret-123",
        algorithm="HS256",
    )
    with pytest.raises(InvalidTokenError):
        TokenVerifier(ISSUER, SECRET).verify(token)


def test_protected_route_requires_token(client):
    assert client.get("/api/v1/me").status_code == 401
    assert client.get("/api/v1/me", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_non_super_admin_blocked_from_admin_routes(client):
    override_user(CurrentUser(uuid.uuid4(), "t@x.com", "T", False))
    assert client.get("/api/v1/admin/stats").status_code == 403
    assert client.post("/api/v1/admin/schools", json={"name": "Abc", "code": "ABC"}).status_code == 403


def test_school_context_requires_membership(client):
    school_id = uuid.uuid4()
    override_user(CurrentUser(uuid.uuid4(), "t@x.com", "T", False))
    assert client.get("/api/v1/school").status_code == 400
    assert client.get("/api/v1/school", headers={"X-School-Id": str(school_id)}).status_code == 403


def test_me_returns_memberships(client):
    sid = uuid.uuid4()
    user = CurrentUser(
        uuid.uuid4(),
        "a@x.com",
        "Asha",
        False,
        (MembershipInfo(sid, "Green Valley", "GVS", "active", ("school_admin",)),),
    )
    override_user(user)
    body = client.get("/api/v1/me").json()
    assert body["memberships"][0]["school_code"] == "GVS"
    assert body["is_super_admin"] is False
