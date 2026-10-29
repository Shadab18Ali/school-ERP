"""Analytics API: who may open which tab, filter validation, dues brought up to date before fee
figures, the database's own refusal passed on as 403, and the figures passed through exactly
(no float rounding of amounts). The figures themselves are tested in supabase/tests/analytics_test.sql."""

import json
import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import DBAPIError

import app.api.v1.routes.analytics as routes
from app.core.deps import CurrentUser, MembershipInfo, get_claims, get_current_user, get_db
from app.main import app as main_app

SCHOOL = uuid.uuid4()
SESSION = uuid.uuid4()
H = {"X-School-Id": str(SCHOOL)}


class _Orig(Exception):
    def __init__(self, sqlstate, message):
        super().__init__(message)
        self.sqlstate, self.message, self.constraint_name = sqlstate, message, None


class FakeDb:
    def __init__(self, result='{"kpis": {"collected": 12345.67}}', error=None):
        self.result, self.error, self.calls, self.rolled_back = result, error, [], False

    async def scalar(self, stmt, params=None):
        self.calls.append((str(stmt), params))
        if self.error:
            raise DBAPIError(str(stmt), params, _Orig(*self.error))
        return self.result

    async def rollback(self):
        self.rolled_back = True


@pytest.fixture
def api(monkeypatch):
    events: list = []
    state = SimpleNamespace(db=FakeDb(), session=SimpleNamespace(id=SESSION, name="2026-27"), events=events)

    async def resolve(db, ctx, sid):
        events.append(("session", sid))
        return state.session

    async def get_class(db, ctx, cid):
        events.append(("class", cid))

    async def sync(db, school, sid):
        events.append(("sync", school, sid))

    monkeypatch.setattr(routes, "resolve_session", resolve)
    monkeypatch.setattr(routes, "get_class", get_class)
    monkeypatch.setattr(routes, "sync_dues", sync)

    def client(role: str | None, super_admin=False):
        memberships = () if role is None else (MembershipInfo(SCHOOL, "School", "SCH", "active", (role,)),)
        user = CurrentUser(uuid.uuid4(), "u@x.com", "U", super_admin, memberships)

        async def _db():
            yield state.db

        main_app.dependency_overrides = {
            get_claims: lambda: {"sub": str(user.id)},
            get_db: _db,
            get_current_user: lambda: user,
        }
        return TestClient(main_app)

    state.client = client
    yield state
    main_app.dependency_overrides = {}


ALLOWED = {
    "school_admin": {"students", "fees", "admissions"},
    "accountant": {"fees", "admissions"},
    "teacher": set(),
    "librarian": set(),
    "parent": set(),
    "student": set(),
}


@pytest.mark.parametrize("role", list(ALLOWED))
@pytest.mark.parametrize("tab", ["students", "fees", "admissions"])
def test_each_tab_is_for_the_right_roles(api, role, tab):
    r = api.client(role).get(f"/api/v1/analytics/{tab}", headers=H)
    assert r.status_code == (200 if tab in ALLOWED[role] else 403), (role, tab)
    if r.status_code == 403:
        assert api.db.calls == []  # refused before any query


def test_another_schools_admin_is_refused(api):
    r = api.client("school_admin").get("/api/v1/analytics/fees", headers={"X-School-Id": str(uuid.uuid4())})
    assert r.status_code == 403 and api.db.calls == []


def test_figures_pass_through_exactly(api):
    api.db.result = '{"kpis": {"collected": 1234567.89, "rate": 33.3}}'
    r = api.client("accountant").get("/api/v1/analytics/fees", headers=H)
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    assert r.text == '{"kpis": {"collected": 1234567.89, "rate": 33.3}}'


def test_filters_reach_the_database_function(api):
    cid, eid = uuid.uuid4(), uuid.uuid4()
    r = api.client("school_admin").get(
        "/api/v1/analytics/students",
        params={
            "session_id": str(SESSION),
            "class_id": str(cid),
            "from": "2026-06-01",
            "to": "2026-06-30",
            "exam_id": str(eid),
        },
        headers=H,
    )
    assert r.status_code == 200
    sql, params = api.db.calls[-1]
    assert "private.analytics_students" in sql
    assert params == {
        "s": SCHOOL,
        "sid": SESSION,
        "cid": cid,
        "f": __import__("datetime").date(2026, 6, 1),
        "t": __import__("datetime").date(2026, 6, 30),
        "eid": eid,
    }
    assert ("class", cid) in api.events  # the class must belong to the school


def test_fee_dues_are_synced_before_the_figures(api):
    api.client("accountant").get("/api/v1/analytics/fees", headers=H)
    assert ("sync", SCHOOL, SESSION) in api.events and "analytics_fees" in api.db.calls[-1][0]
    api.events.clear()
    api.client("accountant").get("/api/v1/analytics/admissions", headers=H)
    assert not any(e[0] == "sync" for e in api.events)


def test_reversed_date_range_is_rejected(api):
    r = api.client("school_admin").get(
        "/api/v1/analytics/students", params={"from": "2026-07-01", "to": "2026-06-01"}, headers=H
    )
    assert r.status_code == 422 and "start date" in r.json()["detail"]
    assert api.db.calls == []


def test_bad_values_are_rejected(api):
    c = api.client("school_admin")
    assert c.get("/api/v1/analytics/students", params={"from": "June"}, headers=H).status_code == 422
    assert c.get("/api/v1/analytics/fees", params={"class_id": "x"}, headers=H).status_code == 422


def test_no_session_yet_gives_an_empty_answer(api):
    api.session = None
    r = api.client("school_admin").get("/api/v1/analytics/fees", headers=H)
    assert r.status_code == 200 and r.json() == {"session": None}
    assert api.db.calls == [] and not any(e[0] == "sync" for e in api.events)


def test_the_databases_refusal_is_a_403(api):
    api.db.error = ("42501", "Not allowed.")
    r = api.client("school_admin").get("/api/v1/analytics/admissions", headers=H)
    assert r.status_code == 403 and r.json()["detail"] == "Your role doesn't allow this action."
    assert api.db.rolled_back


def test_super_admin_may_open_every_tab(api):
    c = api.client(None, super_admin=True)
    for tab in ("students", "fees", "admissions"):
        assert c.get(f"/api/v1/analytics/{tab}", headers=H).status_code == 200


def test_a_signed_out_request_is_refused():
    main_app.dependency_overrides = {}
    r = TestClient(main_app).get("/api/v1/analytics/fees", headers=H)
    assert r.status_code == 401
    assert json.loads(r.text)["detail"]
