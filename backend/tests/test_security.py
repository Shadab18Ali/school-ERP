"""Security controls that don't need a database: request size limits, production settings, response
headers, trusted client IPs, ended sessions, who may read the audit log and reverse receipts, CSV
injection, storage paths and the logo fetch (no SSRF)."""

import asyncio
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import app.core.deps as deps
from app.api.v1.routes import collection
from app.api.v1.routes.audit import _cell
from app.core.config import Settings
from app.core.deps import CurrentUser, MembershipInfo, get_claims, get_current_user, get_db
from app.core.ratelimit import client_ip
from app.main import MB, create_app
from app.services import storage

SCHOOL = uuid.uuid4()
KEY = "8d1Yb9Qe0b0vO0m3jOEPq3lN3o5a0qK0mVx7nJm2Vh8="  # a valid Fernet key (tests only)
H = {"X-School-Id": str(SCHOOL)}


class _NoDb:
    def __getattr__(self, name):
        raise AssertionError(f"database used ({name}) before the guard answered")


def _client(role: str | None, *, super_admin=False) -> TestClient:
    app = create_app()
    memberships = () if role is None else (MembershipInfo(SCHOOL, "School", "SCH", "active", (role,)),)
    user = CurrentUser(uuid.uuid4(), "u@example.com", "U", super_admin, memberships)

    async def _db():
        yield _NoDb()

    app.dependency_overrides = {get_claims: lambda: {"sub": str(user.id)}, get_db: _db, get_current_user: lambda: user}
    return TestClient(app)


# ------------------------------------------------------------------ request size
def test_oversized_bodies_are_refused_before_anything_reads_them():
    c = _client("school_admin")
    big = b"x" * (12 * MB + 1)
    r = c.post(
        f"/api/v1/students/{uuid.uuid4()}/documents",
        headers={**H, "Content-Type": "application/octet-stream"},
        content=big,
    )
    assert r.status_code == 413 and "too large" in r.json()["detail"]
    # a body sent without a length (chunked) is counted as it arrives
    r = c.post("/api/v1/students", headers=H, content=iter([b"x" * MB] * 13))
    assert r.status_code == 413
    # a lying length header is refused too
    assert c.post("/api/v1/students", headers={**H, "Content-Length": "abc"}, content=b"{}").status_code in (400, 413)


def test_the_admission_form_and_homework_may_send_more():
    app = create_app()
    limiter = next(m for m in app.user_middleware if m.cls.__name__ == "BodySizeLimit")
    inst = limiter.cls(lambda *a: None, **limiter.kwargs)
    assert inst.limit_for("/api/v1/public/admissions/ABC123") == 95 * MB
    assert inst.limit_for("/api/v1/homework/x/files") == 60 * MB
    assert inst.limit_for("/api/v1/students") == 12 * MB


# ------------------------------------------------------------------ settings and headers
def _settings(**kw) -> Settings:
    base = {
        "database_url": "postgresql+asyncpg://u:p@db.example.supabase.co/postgres",
        "database_ssl": True,
        "supabase_url": "https://p.supabase.co",
    }
    return Settings(_env_file=None, **{**base, **kw})


def test_a_deployment_refuses_unsafe_settings():
    good = dict(
        app_env="production",
        cors_origins="https://app.school.in",
        frontend_url="https://app.school.in",
        SECRETS_KEY=KEY,
        supabase_service_role_key="service-role",
    )
    assert _settings(**good).production_problems() == []
    for bad, needle in (
        ({"cors_origins": "*"}, "CORS"),
        ({"cors_origins": "http://app.school.in"}, "CORS"),
        ({"supabase_url": "http://p.supabase.co"}, "SUPABASE_URL"),
        ({"SECRETS_KEY": ""}, "SECRETS_KEY"),
        ({"platform_razorpay_key_id": "rzp_live_x", "platform_razorpay_webhook_secret": ""}, "WEBHOOK"),
        # Phase 34
        ({"SECRETS_KEY": "k" * 44}, "Fernet"),
        (
            {"database_ssl": False, "database_url": "postgresql+asyncpg://u:p@db.abc.supabase.co/postgres"},
            "DATABASE_SSL",
        ),
        ({"supabase_service_role_key": ""}, "SERVICE_ROLE"),
        ({"rate_limit_backend": "redis"}, "RATE_LIMIT_BACKEND"),
        ({"vapid_public_key": "BPub", "vapid_private_key": ""}, "VAPID"),
    ):
        problems = _settings(**{**good, **bad}).production_problems()
        assert any(needle in p for p in problems), (bad, problems)
    # a missing or misspelt APP_ENV is a deployment, not development
    assert not _settings(app_env="prod").is_development and _settings(app_env="prod").production_problems()
    assert _settings(app_env="development", cors_origins="*").production_problems() == []
    # a database on the same machine may be reached without TLS
    assert (
        _settings(
            **good, database_ssl=False, database_url="postgresql+asyncpg://u:p@localhost/db"
        ).production_problems()
        == []
    )


def test_api_docs_only_in_development(monkeypatch):
    import app.main as main

    for env, visible in (("development", True), ("staging", False)):
        s = _settings(
            app_env=env,
            cors_origins="https://a.in",
            frontend_url="https://a.in",
            SECRETS_KEY=KEY,
            supabase_service_role_key="s",
        )
        monkeypatch.setattr(main, "get_settings", lambda s=s: s)
        c = TestClient(main.create_app())
        assert (c.get("/openapi.json").status_code == 200) == visible, env
        r = c.get("/api/v1/health")
        assert ("Strict-Transport-Security" in r.headers) == (not visible)


def test_security_headers_on_every_answer():
    r = TestClient(create_app()).get("/api/v1/health")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Cache-Control"] == "no-store"
    assert "default-src 'none'" in r.headers["Content-Security-Policy"]
    assert "camera=()" in r.headers["Permissions-Policy"]


# ------------------------------------------------------------------ client IP
def _req(xff: str | None, peer="10.0.0.5"):
    return SimpleNamespace(client=SimpleNamespace(host=peer), headers={"x-forwarded-for": xff} if xff else {})


def test_forwarded_for_is_only_trusted_through_known_proxies():
    assert client_ip(_req("6.6.6.6"), trusted_hops=0) == "10.0.0.5"  # no proxy: a header can't change the IP
    assert client_ip(_req("6.6.6.6, 203.0.113.9"), trusted_hops=1) == "203.0.113.9"  # what our proxy saw
    assert client_ip(_req("203.0.113.9"), trusted_hops=2) == "10.0.0.5"  # chain too short: trust the socket


# ------------------------------------------------------------------ ended sessions
def test_a_token_whose_session_has_ended_is_refused(monkeypatch):
    class _Db:
        def __init__(self, active):
            self.active = active

        async def scalar(self, *_a, **_k):
            return self.active

    class _Ctx:
        def __init__(self, active):
            self.db = _Db(active)

        async def __aenter__(self):
            return self.db

        async def __aexit__(self, *a):
            return False

    req = SimpleNamespace(client=SimpleNamespace(host="1.2.3.4"), headers={})

    async def run(active):
        monkeypatch.setattr(deps, "rls_session", lambda *_a, **_k: _Ctx(active))
        gen = deps.get_db(req, {"sub": str(uuid.uuid4()), "session_id": str(uuid.uuid4())})
        return await gen.__anext__()

    with pytest.raises(deps.HTTPException) as e:
        asyncio.run(run(False))
    assert e.value.status_code == 401 and "signed out" in e.value.detail
    assert asyncio.run(run(True)) is not None
    assert asyncio.run(run(None)) is not None  # this database can't tell: the token's expiry applies


# ------------------------------------------------------------------ who may do what
@pytest.mark.parametrize("role", ["accountant", "teacher", "librarian", "parent", "student"])
def test_only_school_admins_read_the_audit_log_or_reverse_receipts(role):
    c = _client(role)
    assert c.get("/api/v1/audit", headers=H).status_code == 403
    assert c.get("/api/v1/audit/export", headers=H).status_code == 403
    r = c.post(f"/api/v1/fee-payments/{uuid.uuid4()}/cancel", headers=H, json={"reason": "Wrong amount entered"})
    assert r.status_code == 403
    assert c.get("/api/v1/admin/audit").status_code == 403


def test_the_platform_admin_reads_the_log_but_does_not_reverse_a_schools_receipts():
    c = _client(None, super_admin=True)
    r = c.post(f"/api/v1/fee-payments/{uuid.uuid4()}/cancel", headers=H, json={"reason": "Wrong amount entered"})
    assert r.status_code == 403
    with pytest.raises(AssertionError, match="database used"):
        c.get("/api/v1/admin/audit")


def test_input_is_checked_first():
    c = _client("school_admin")
    assert c.post(f"/api/v1/fee-payments/{uuid.uuid4()}/cancel", headers=H, json={"reason": "no"}).status_code == 422
    assert c.get("/api/v1/audit", headers=H, params={"category": "everything"}).status_code == 422
    assert c.get("/api/v1/audit", headers=H, params={"page_size": 5000}).status_code == 422
    c2 = _client(None)
    assert c2.post("/api/v1/auth/events", json={"event": "hacked"}).status_code == 422


def test_csv_cells_never_start_a_formula():
    for evil in ('=HYPERLINK("http://x")', "+1", "-2", "@SUM(A1)"):
        assert _cell(evil).startswith("'")
    assert _cell("Ravi Kumar") == "Ravi Kumar"


# ------------------------------------------------------------------ storage paths and the logo
def test_storage_paths_are_plain_and_relative():
    sid = str(uuid.uuid4())
    assert storage._checked(f"{sid}/{uuid.uuid4()}/abc.pdf")
    for bad in (
        "../other/x.pdf",
        f"{sid}/../../x",
        "/etc/passwd",
        f"{sid}/a%2F..%2Fb",
        f"{sid}/x?download",
        f"{sid}\\x",
        "",
    ):
        with pytest.raises(storage.StorageError):
            storage._checked(bad)


def test_the_logo_is_only_fetched_from_the_platforms_logo_storage(monkeypatch):
    fetched: list[str] = []

    class _Http:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            fetched.append(url)
            return SimpleNamespace(status_code=200, content=b"\x89PNG\r\n\x1a\n...")

    monkeypatch.setattr(collection.httpx, "AsyncClient", _Http)
    good = storage.public_url(storage.LOGO_BUCKET, f"{uuid.uuid4()}/logo-{uuid.uuid4().hex}.png")
    assert asyncio.run(collection._logo(good)) is not None
    for evil in (
        "http://169.254.169.254/latest/meta-data/",
        "http://localhost:5432/",
        storage.public_url(storage.LOGO_BUCKET, "../student-documents/x.png"),
        storage.public_url("student-documents", f"{uuid.uuid4()}/logo-{uuid.uuid4().hex}.png"),
    ):
        assert asyncio.run(collection._logo(evil)) is None
    assert fetched == [good]


# ------------------------------------------------------------------ shared rate limits (Phase 34)
def test_rate_limits_are_shared_between_processes_in_a_deployment(monkeypatch):
    from fastapi import HTTPException

    from app.core import ratelimit

    calls: list[tuple] = []

    async def shared(key, m, w):
        calls.append((key, m, w))
        return 0 if len(calls) <= 2 else 42

    monkeypatch.setattr(ratelimit, "_shared_hit", shared)
    for env, backend, shared_expected in (
        ("production", "auto", True),
        ("development", "auto", False),
        ("development", "database", True),
        ("production", "memory", False),
    ):
        s = _settings(app_env=env, rate_limit_backend=backend)
        assert s.rate_limit_shared is shared_expected, (env, backend)
    s = _settings(app_env="production", rate_limit_backend="auto")
    monkeypatch.setattr(ratelimit, "get_settings", lambda: s)
    req = _req(None, peer="203.0.113.5")
    asyncio.run(ratelimit.limit(req, "b", 2, 60))
    asyncio.run(ratelimit.limit(req, "b", 2, 60))
    with pytest.raises(HTTPException) as e:
        asyncio.run(ratelimit.limit(req, "b", 2, 60))
    assert e.value.status_code == 429 and e.value.headers["Retry-After"] == "42"
    assert calls[0] == ("b:203.0.113.5", 2, 60)


def test_a_limit_still_applies_when_the_database_cannot_count(monkeypatch):
    from fastapi import HTTPException

    from app.core import ratelimit

    async def down(*_a):
        raise ConnectionError("database unavailable")

    monkeypatch.setattr(ratelimit, "_shared_hit", down)
    s = _settings(app_env="production")
    monkeypatch.setattr(ratelimit, "get_settings", lambda: s)
    ratelimit.reset()
    req = _req(None, peer="198.51.100.7")
    for _ in range(3):
        asyncio.run(ratelimit.limit(req, "fallback", 3, 60))
    with pytest.raises(HTTPException):
        asyncio.run(ratelimit.limit(req, "fallback", 3, 60))
    ratelimit.reset()


# ------------------------------------------------------------------ readiness (Phase 34)
def test_readiness_reports_an_unreachable_or_unmigrated_database(monkeypatch):
    from app.api.v1.routes import health

    class _Conn:
        def __init__(self, migrated):
            self.migrated = migrated

        async def __aenter__(self):
            if self.migrated is None:
                raise OSError("connection refused")
            return self

        async def __aexit__(self, *a):
            return False

        async def scalar(self, *_a, **_k):
            return self.migrated

    for migrated, code, db in ((True, 200, "ok"), (False, 503, "migrations missing"), (None, 503, "unreachable")):
        monkeypatch.setattr(health, "get_engine", lambda m=migrated: SimpleNamespace(connect=lambda: _Conn(m)))
        r = TestClient(create_app()).get("/api/v1/health/ready")
        assert (r.status_code, r.json()["database"]) == (code, db)
        assert "postgres" not in r.text.lower()  # nothing about the server leaks
    assert TestClient(create_app()).get("/api/v1/health").json() == {"status": "ok"}


# ------------------------------------------------------------------ database errors (Phase 34)
def test_database_errors_a_route_did_not_translate_are_not_500s():
    from fastapi import APIRouter
    from sqlalchemy.exc import DBAPIError

    class _PgErr(Exception):
        def __init__(self, sqlstate):
            super().__init__("boom")
            self.sqlstate = sqlstate

    app = create_app()
    r = APIRouter()

    @r.get("/raise/{state}")
    async def boom(state: str):
        raise DBAPIError("select 1", {}, _PgErr(state))

    app.include_router(r)
    c = TestClient(app, raise_server_exceptions=False)
    for state, code in (
        ("22003", 422),
        ("22008", 422),
        ("22P02", 422),
        ("23502", 422),
        ("23503", 404),
        ("23505", 409),
        ("42501", 403),
        ("40001", 409),
        ("57014", 503),
        ("XX000", 500),
    ):
        res = c.get(f"/raise/{state}")
        assert res.status_code == code, state
        assert "boom" not in res.text and "select" not in res.text  # nothing about the query leaks


def test_every_page_number_has_an_upper_limit():
    # page=9223372036854775808 overflowed the database's OFFSET on 22 list routes (a 500 each)
    from fastapi.routing import APIRoute

    from app.main import app as main_app

    unbounded = []
    for r in main_app.routes:
        if not isinstance(r, APIRoute):
            continue
        for p in r.dependant.query_params:
            if p.name == "page":
                le = [m.le for m in p.field_info.metadata if getattr(m, "le", None) is not None]
                if not le or le[0] > 1_000_000:
                    unbounded.append(r.path)
    assert not unbounded, unbounded


def test_a_payroll_month_must_be_sensible():
    from app.api.v1.routes.payroll import MonthIn

    for bad in ("0001-01-01", "9999-12-01"):
        with pytest.raises(ValueError):
            MonthIn(month=bad)
    assert MonthIn(month="2026-04-01").month.year == 2026
