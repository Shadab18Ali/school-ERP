"""Tenant isolation at the API, for EVERY route (no database needed).

1. Each route is school-scoped (resolves the school from X-School-Id and checks the caller's
   membership and role there), platform-only (super admin), personal (only the caller's own
   account), or public. Personal and public routes are listed here by name, so a new route that
   forgets its scoping fails this test instead of quietly serving every school.
2. Every school-scoped route refuses a member of School A who names School B — before any
   query runs — whatever the method, path or body.
3. Every platform route refuses school roles, including School A's admin.
4. Every school-scoped route refuses a school that has been deactivated.
(The database enforces the same separation again: supabase/tests/tenant_isolation_audit.sql.)
"""

import datetime as dt
import typing
import uuid

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from app.core.deps import CurrentUser, MembershipInfo, get_claims, get_current_user, get_db
from app.main import app

SCHOOL_A, SCHOOL_B = uuid.uuid4(), uuid.uuid4()

PERSONAL = {
    "GET /api/v1/me",
    "PATCH /api/v1/me",
    "GET /api/v1/notifications/preferences",
    "PUT /api/v1/notifications/preferences",
    "GET /api/v1/push/config",
    "GET /api/v1/push/subscriptions",
    "POST /api/v1/push/subscriptions",
    "PATCH /api/v1/push/subscriptions/{sub_id}",
    "DELETE /api/v1/push/subscriptions/{sub_id}",
    "POST /api/v1/push/unsubscribe",
    "POST /api/v1/push/test",
    "POST /api/v1/auth/events",  # one's own sign-in/out (person and session from the token)
}
PUBLIC = {
    "GET /api/v1/health",
    "GET /api/v1/health/ready",
    "GET /api/v1/public/admissions/{code}",
    "POST /api/v1/public/admissions/{code}",
    "POST /api/v1/public/admissions/{code}/status",
    "GET /api/v1/public/verify/{token}",
    # signed by the provider and checked against the school's own secret before anything is read
    "POST /api/v1/payments/webhooks/razorpay/{school_id}",
    "POST /api/v1/notifications/webhooks/twilio/{school_id}",
    "GET /api/v1/notifications/webhooks/whatsapp/{school_id}",
    "POST /api/v1/notifications/webhooks/whatsapp/{school_id}",
    "POST /api/v1/billing/webhooks/razorpay",
}


def _deps(dep, acc: set[str]) -> set[str]:
    for d in dep.dependencies:
        if d.call is not None:
            acc.add(getattr(d.call, "__qualname__", repr(d.call)))
        _deps(d, acc)
    return acc


def _routes():
    out = []
    for r in app.routes:
        if not isinstance(r, APIRoute):
            continue
        names = _deps(r.dependant, set())
        kind = (
            "school"
            if any("get_school_context" in n for n in names)
            else "platform"
            if any("require_super_admin" in n for n in names)
            else "personal"
            if any("get_current_user" in n for n in names)
            else "public"
        )
        for m in sorted(r.methods - {"HEAD", "OPTIONS"}):
            out.append((kind, m, r))
    return out


ROUTES = _routes()


def _url(route: APIRoute) -> str:
    path = route.path
    for p in route.dependant.path_params:
        t = p.field_info.annotation if hasattr(p, "field_info") else p.type_
        origin = typing.get_origin(t)
        if t is uuid.UUID:
            v = str(uuid.uuid4())
        elif t is int:
            v = "1"
        elif t is dt.date:
            v = "2026-01-01"
        elif origin is typing.Literal:
            v = str(typing.get_args(t)[0])
        else:
            v = "x"
        path = path.replace("{" + p.name + "}", v)
    return path


def _client(roles: dict[uuid.UUID, tuple[str, ...]], *, super_admin=False, school_status="active") -> TestClient:
    memberships = tuple(MembershipInfo(s, "School", "SCH", school_status, r) for s, r in roles.items())
    user = CurrentUser(uuid.uuid4(), "u@example.com", "U", super_admin, memberships)

    async def _db():
        raise AssertionError("no query may run before the school check")
        yield  # pragma: no cover

    app.dependency_overrides = {get_claims: lambda: {"sub": str(user.id)}, get_db: _db, get_current_user: lambda: user}
    return TestClient(app, raise_server_exceptions=True)


def _call(c: TestClient, method: str, route: APIRoute, school: uuid.UUID):
    return c.request(method, _url(route), headers={"X-School-Id": str(school)}, json={})


@pytest.fixture(autouse=True)
def _reset():
    yield
    app.dependency_overrides = {}


def test_every_route_is_scoped():
    kinds = {f"{m} {r.path}": k for k, m, r in ROUTES}
    assert {k for k, v in kinds.items() if v == "personal"} == PERSONAL
    assert {k for k, v in kinds.items() if v == "public"} == PUBLIC
    school = [k for k, v in kinds.items() if v == "school"]
    platform = [k for k, v in kinds.items() if v == "platform"]
    assert len(school) > 350 and len(platform) >= 18
    assert all(" /api/v1/admin" in k for k in platform), "platform routes live under /admin"
    assert not any(" /api/v1/admin" in k for k in school), "nothing under /admin is school-scoped"


SCHOOL_ROUTES = [(m, r) for k, m, r in ROUTES if k == "school"]


@pytest.mark.parametrize("role", ["school_admin", "accountant", "teacher", "parent", "student"])
def test_no_school_route_serves_another_school(role):
    c = _client({SCHOOL_A: (role,)})
    leaks = []
    for m, r in SCHOOL_ROUTES:
        res = _call(c, m, r, SCHOOL_B)
        if res.status_code != 403:
            leaks.append(f"{m} {r.path} -> {res.status_code}")
    assert not leaks, f"{role} of School A reached School B: {leaks[:10]}"


def test_no_school_route_serves_a_deactivated_school():
    c = _client({SCHOOL_A: ("school_admin",)}, school_status="suspended")
    open_ = [f"{m} {r.path}" for m, r in SCHOOL_ROUTES if _call(c, m, r, SCHOOL_A).status_code != 403]
    assert not open_, open_[:10]


def test_no_school_route_without_choosing_a_school():
    c = _client({SCHOOL_A: ("school_admin",)})
    bad = [f"{m} {r.path}" for m, r in SCHOOL_ROUTES if c.request(m, _url(r), json={}).status_code != 400]
    assert not bad, bad[:10]


PLATFORM_ROUTES = [(m, r) for k, m, r in ROUTES if k == "platform"]


@pytest.mark.parametrize("role", ["school_admin", "accountant", "teacher", "parent", "student"])
def test_platform_routes_are_for_the_super_admin_only(role):
    c = _client({SCHOOL_A: (role,), SCHOOL_B: (role,)})
    open_ = [f"{m} {r.path}" for m, r in PLATFORM_ROUTES if _call(c, m, r, SCHOOL_A).status_code != 403]
    assert not open_, open_
