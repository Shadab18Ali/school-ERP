import uuid

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.core.deps import (
    CurrentUser,
    MembershipInfo,
    SchoolContext,
    get_claims,
    get_current_user,
    get_db,
    require_permission,
    require_super_admin,
)
from app.core.permissions import (
    PLATFORM_PERMISSIONS,
    ROLE_PERMISSIONS,
    SCHOOL_PERMISSIONS,
    STAFF_PERMISSIONS,
    Permission,
    school_permissions,
)
from app.main import app as main_app

P = Permission
SCHOOL_A = uuid.uuid4()
SCHOOL_B = uuid.uuid4()

# What each role must be able to reach. Anything not listed must be refused.
EXPECTED = {
    "school_admin": set(STAFF_PERMISSIONS),
    "accountant": {
        P.DASHBOARD_VIEW,
        P.STUDENTS_VIEW,
        P.CLASSES_VIEW,
        P.FEES_VIEW,
        P.FEES_COLLECT,
        P.REPORTS_VIEW,
        P.SESSIONS_VIEW,
        P.FEE_STRUCTURES_VIEW,
        P.FEE_STRUCTURES_MANAGE,
        P.NOTICES_VIEW,
        P.TIMETABLE_VIEW,
        P.ADMISSIONS_VIEW,
        P.ADMISSIONS_FEE,
        P.ENQUIRIES_VIEW,
        P.ENQUIRIES_MANAGE,
        P.LIBRARY_VIEW,
        P.LIBRARY_FINES,
        P.TRANSPORT_VIEW,
        P.INVENTORY_VIEW,
        P.LEAVE_SELF,
        P.ANALYTICS_FEES,
        P.ANALYTICS_ADMISSIONS,
    },
    "teacher": {
        P.DASHBOARD_VIEW,
        P.STUDENTS_VIEW,
        P.CLASSES_VIEW,
        P.ATTENDANCE_VIEW,
        P.ATTENDANCE_MARK,
        P.REPORTS_VIEW,
        P.SESSIONS_VIEW,
        P.NOTICES_VIEW,
        P.TEACHING_VIEW,
        P.TIMETABLE_VIEW,
        P.HOMEWORK_VIEW,
        P.HOMEWORK_MANAGE,
        P.EXAMS_VIEW,
        P.MARKS_ENTER,
        P.LIBRARY_VIEW,
        P.LEAVE_SELF,
    },
    "librarian": {P.DASHBOARD_VIEW, P.NOTICES_VIEW, P.LIBRARY_VIEW, P.LIBRARY_MANAGE, P.LIBRARY_FINES, P.LEAVE_SELF},
    "parent": {P.DASHBOARD_VIEW, P.NOTICES_VIEW, P.PORTAL_VIEW},
    "student": {P.DASHBOARD_VIEW, P.NOTICES_VIEW, P.SELF_VIEW},
}


def user_with(role: str | None, *, school=SCHOOL_A, super_admin=False, status="active") -> CurrentUser:
    memberships = () if role is None else (MembershipInfo(school, "School", "SCH", status, (role,)),)
    return CurrentUser(uuid.uuid4(), "u@x.com", "U", super_admin, memberships)


# ---------- matrix ----------
@pytest.mark.parametrize("role", list(EXPECTED))
def test_role_matrix_is_exact(role):
    assert set(ROLE_PERMISSIONS[role]) == EXPECTED[role]


def test_no_school_role_gets_platform_permissions():
    for perms in ROLE_PERMISSIONS.values():
        assert not perms & PLATFORM_PERMISSIONS


def test_multiple_roles_combine():
    assert school_permissions(["parent", "teacher"]) == EXPECTED["parent"] | EXPECTED["teacher"]


def test_library_duty_adds_only_library_access():
    staff_on_duty = school_permissions(["teacher", "librarian"])
    assert staff_on_duty - EXPECTED["teacher"] == {P.LIBRARY_MANAGE, P.LIBRARY_FINES}
    assert P.STUDENTS_MANAGE not in staff_on_duty and P.FEES_COLLECT not in staff_on_duty


def test_payroll_and_hr_are_school_admins_only():
    for role, perms in ROLE_PERMISSIONS.items():
        has = {P.PAYROLL_MANAGE, P.HR_MANAGE} & perms
        assert has == ({P.PAYROLL_MANAGE, P.HR_MANAGE} if role == "school_admin" else set()), role
    # every staff role can apply for its own leave; families can't
    assert all(P.LEAVE_SELF in ROLE_PERMISSIONS[r] for r in ("school_admin", "accountant", "teacher", "librarian"))
    assert not ({P.LEAVE_SELF} & (ROLE_PERMISSIONS["parent"] | ROLE_PERMISSIONS["student"]))


def test_certificates_and_id_cards_are_school_admins_only():
    docs = {P.CERTIFICATES_MANAGE, P.ID_CARDS_MANAGE}
    for role, perms in ROLE_PERMISSIONS.items():
        assert (docs & perms) == (docs if role == "school_admin" else set()), role
    # the platform's super admin can also issue them (as in the database)
    assert docs <= school_permissions([], is_super_admin=True)


def test_analytics_are_for_the_school_office_only():
    # student analytics: admins; fee and admission analytics: admins and accountants (as in the database)
    for role, perms in ROLE_PERMISSIONS.items():
        assert (P.ANALYTICS_STUDENTS in perms) == (role == "school_admin"), role
        office = role in ("school_admin", "accountant")
        assert (P.ANALYTICS_FEES in perms) == office and (P.ANALYTICS_ADMISSIONS in perms) == office, role


def test_unknown_role_gets_nothing():
    assert school_permissions(["janitor"]) == frozenset()


def test_super_admin_gets_all_staff_permissions_except_payroll_and_reversing_receipts():
    assert school_permissions([], is_super_admin=True) == STAFF_PERMISSIONS - {P.PAYROLL_MANAGE, P.FEES_CANCEL}
    # payroll and receipt reversal only through being that school's own administrator
    assert {P.PAYROLL_MANAGE, P.FEES_CANCEL} <= school_permissions(["school_admin"], is_super_admin=True)


def test_audit_log_and_receipt_reversal_are_for_school_admins_only():
    for role, perms in ROLE_PERMISSIONS.items():
        assert (P.AUDIT_VIEW in perms) == (role == "school_admin"), role
        # the accountant records receipts; reversing one is someone else's decision
        assert (P.FEES_CANCEL in perms) == (role == "school_admin"), role
    assert Permission.PORTAL_VIEW not in STAFF_PERMISSIONS <= SCHOOL_PERMISSIONS
    assert Permission.SELF_VIEW not in STAFF_PERMISSIONS
    assert Permission.TEACHING_VIEW not in STAFF_PERMISSIONS
    assert {Permission.TEACHERS_VIEW, Permission.TEACHERS_MANAGE} <= STAFF_PERMISSIONS


# ---------- guards through real HTTP ----------
probe = FastAPI()


@probe.get("/fees/collect")
async def collect(ctx: SchoolContext = Depends(require_permission(P.FEES_COLLECT))):
    return {"school": str(ctx.school_id)}


@probe.get("/attendance/mark")
async def mark(ctx: SchoolContext = Depends(require_permission(P.ATTENDANCE_MARK))):
    return {"ok": True}


@probe.get("/settings")
async def settings(ctx: SchoolContext = Depends(require_permission(P.SETTINGS_MANAGE))):
    return {"ok": True}


@probe.get("/platform")
async def platform(_: CurrentUser = Depends(require_super_admin)):
    return {"ok": True}


@probe.get("/sessions/manage")
async def sessions_manage(ctx: SchoolContext = Depends(require_permission(P.SESSIONS_MANAGE))):
    return {"ok": True}


ROUTES = {
    "/fees/collect": P.FEES_COLLECT,
    "/attendance/mark": P.ATTENDANCE_MARK,
    "/settings": P.SETTINGS_MANAGE,
    "/sessions/manage": P.SESSIONS_MANAGE,
}


def client_for(user: CurrentUser) -> TestClient:
    async def _db():
        yield None

    probe.dependency_overrides = {
        get_claims: lambda: {"sub": str(user.id)},
        get_db: _db,
        get_current_user: lambda: user,
    }
    return TestClient(probe)


@pytest.mark.parametrize("role", list(EXPECTED))
@pytest.mark.parametrize("path", list(ROUTES))
def test_route_access_follows_matrix(role, path):
    c = client_for(user_with(role))
    res = c.get(path, headers={"X-School-Id": str(SCHOOL_A)})
    assert res.status_code == (200 if ROUTES[path] in EXPECTED[role] else 403)


@pytest.mark.parametrize("role", list(EXPECTED))
def test_member_of_school_a_is_refused_in_school_b(role):
    c = client_for(user_with(role, school=SCHOOL_A))
    for path in ROUTES:
        assert c.get(path, headers={"X-School-Id": str(SCHOOL_B)}).status_code == 403


def test_suspended_school_is_refused():
    c = client_for(user_with("school_admin", status="suspended"))
    assert c.get("/settings", headers={"X-School-Id": str(SCHOOL_A)}).status_code == 403


def test_missing_school_header_is_400():
    c = client_for(user_with("school_admin"))
    assert c.get("/settings").status_code == 400


def test_malformed_school_header_is_422():
    c = client_for(user_with("school_admin"))
    assert c.get("/settings", headers={"X-School-Id": "not-a-uuid"}).status_code == 422


@pytest.mark.parametrize("role", list(EXPECTED))
def test_school_roles_cannot_reach_platform(role):
    assert client_for(user_with(role)).get("/platform").status_code == 403


def test_super_admin_reaches_platform_and_any_school():
    c = client_for(user_with(None, super_admin=True))
    assert c.get("/platform").status_code == 200
    assert c.get("/settings", headers={"X-School-Id": str(SCHOOL_B)}).status_code == 200


# ---------- /me exposes permissions; profile validation ----------
def test_me_includes_permissions():
    async def _db():
        yield None

    user = user_with("accountant")
    main_app.dependency_overrides = {
        get_claims: lambda: {"sub": str(user.id)},
        get_db: _db,
        get_current_user: lambda: user,
    }
    try:
        body = TestClient(main_app).get("/api/v1/me").json()
    finally:
        main_app.dependency_overrides = {}
    assert body["platform_permissions"] == []
    assert set(body["memberships"][0]["permissions"]) == {p.value for p in EXPECTED["accountant"]}


@pytest.mark.parametrize(
    "payload", [{"full_name": "A"}, {"phone": "abc"}, {"is_super_admin": True}, {"email": "x@y.z"}]
)
def test_profile_update_rejects_bad_or_forbidden_fields(payload):
    async def _db():
        yield None

    user = user_with("teacher")
    main_app.dependency_overrides = {
        get_claims: lambda: {"sub": str(user.id)},
        get_db: _db,
        get_current_user: lambda: user,
    }
    try:
        res = TestClient(main_app).patch("/api/v1/me", json=payload)
    finally:
        main_app.dependency_overrides = {}
    assert res.status_code == 422


def test_every_database_role_has_permissions():
    """The ORM's role list (the database enum app_role) and the permission matrix must agree."""
    from app.models.core import app_role

    assert set(app_role.enums) == set(ROLE_PERMISSIONS)
