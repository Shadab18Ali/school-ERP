"""Platform and billing API without a database: plan and subscription validation, billing periods,
exact amounts, read-only access once a subscription has ended, plan features, who may manage
billing and staff sign-ins, and the billing webhook's signature check."""

import hashlib
import hmac
import json
import uuid
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.api.v1.routes.billing as billing
from app.api.v1.routes.billing import BillingSettingsIn, ManualPaymentIn, SubscriptionIn
from app.api.v1.routes.platform import PlanCreate, PlanUpdate, add_cycle, exact
from app.core.deps import CurrentUser, MembershipInfo, get_claims, get_current_user, get_db
from app.core.permissions import ROLE_PERMISSIONS, Permission, school_permissions
from app.main import app

P = Permission
SCHOOL = uuid.uuid4()
H = {"X-School-Id": str(SCHOOL)}
ENTS = {
    k: {"included": True}
    for k in (
        "students",
        "teachers",
        "storage_mb",
        "whatsapp",
        "reports",
        "analytics",
        "ai_assistant",
        "website_builder",
    )
}


def test_billing_periods():
    assert add_cycle(date(2026, 4, 1), "yearly") == date(2027, 3, 31)
    assert add_cycle(date(2026, 4, 1), "monthly") == date(2026, 4, 30)
    assert add_cycle(date(2026, 1, 31), "monthly") == date(2026, 2, 27)  # to 28 Feb, one day before
    assert add_cycle(date(2026, 12, 15), "monthly") == date(2027, 1, 14)
    assert add_cycle(date(2028, 2, 29), "yearly") == date(2029, 2, 27)


def test_amounts_stay_exact():
    assert exact({"price": Decimal("15000"), "n": 3, "name": "x"}) == {"price": "15000.00", "n": 3, "name": "x"}


def test_plan_validation():
    base = {
        "code": "growth-1",
        "name": " Growth ",
        "price_monthly": Decimal("4000"),
        "price_yearly": Decimal("42000"),
        "trial_days": 14,
        "grace_period_days": 7,
        "entitlements": ENTS,
    }
    ok = PlanCreate(**base, features=[" Fees ", "", "Exams"])
    assert ok.code == "GROWTH-1" and ok.name == "Growth" and ok.features == ["Fees", "Exams"]
    for bad in (
        {"price_monthly": Decimal("-1")},
        {"price_yearly": Decimal("1.234")},
        {"code": "bad code!"},
        {"trial_days": -1},
        {"grace_period_days": 91},
        {"features": ["x" * 101]},
        {"entitlements": {"students": {"included": True, "limit": -1}}},
        {"school_id": str(SCHOOL)},  # unknown fields are refused
    ):
        with pytest.raises(ValidationError):
            PlanCreate(**{**base, **bad})
    for missing in ("trial_days", "grace_period_days", "entitlements", "price_yearly"):
        with pytest.raises(ValidationError):  # nothing is assumed: every plan states its own terms
            PlanCreate(**{k: v for k, v in base.items() if k != missing})
    with pytest.raises(ValidationError):
        PlanUpdate(name=None)
    with pytest.raises(ValidationError):
        PlanUpdate(grace_period_days=None)


def test_subscription_validation():
    pid = uuid.uuid4()
    with pytest.raises(ValidationError, match="trial ends"):
        SubscriptionIn(plan_id=pid, billing_cycle="monthly", trial="until")
    with pytest.raises(ValidationError):
        SubscriptionIn(plan_id=pid, billing_cycle="weekly")
    with pytest.raises(ValidationError):
        SubscriptionIn(plan_id=pid, billing_cycle="yearly", price=Decimal("-5"))
    with pytest.raises(ValidationError):
        SubscriptionIn(plan_id=pid, billing_cycle="yearly", status="active")  # no status can be set: it is worked out
    with pytest.raises(ValidationError):
        SubscriptionIn(plan_id=pid, billing_cycle="yearly", billing_gstin="12345")
    s = SubscriptionIn(plan_id=pid, billing_cycle="yearly", notes="  ", billing_gstin=" 07abcde1234f1z5 ")
    assert s.notes is None and s.billing_gstin == "07ABCDE1234F1Z5"


def test_manual_payment_and_settings_validation():
    with pytest.raises(ValidationError, match="reference"):
        ManualPaymentIn(amount=Decimal("100"), method="bank_transfer", paid_on=date(2026, 10, 1))
    assert ManualPaymentIn(amount=Decimal("100"), method="cash", paid_on=date(2026, 10, 1)).reference is None
    with pytest.raises(ValidationError):
        ManualPaymentIn(amount=Decimal("0"), method="cash", paid_on=date(2026, 10, 1))
    good = {
        "legal_name": "Platform Co",
        "address": "Delhi",
        "state": "Delhi",
        "invoice_prefix": "INV",
        "tax_label": "GST",
        "tax_rate": Decimal("18"),
        "renewal_lead_days": 7,
        "payment_due_days": 10,
    }
    assert BillingSettingsIn(**good, gstin=" 07abcde1234f1z5 ").gstin == "07ABCDE1234F1Z5"
    for bad in ({"tax_rate": Decimal("101")}, {"invoice_prefix": "inv/"}, {"renewal_lead_days": 61}, {"gstin": "ABC"}):
        with pytest.raises(ValidationError):
            BillingSettingsIn(**{**good, **bad})


def test_staff_sign_ins_are_managed_by_school_admins_only():
    for role, perms in ROLE_PERMISSIONS.items():
        assert (P.STAFF_ACCOUNTS_MANAGE in perms) == (role == "school_admin"), role
    assert P.STAFF_ACCOUNTS_MANAGE in school_permissions([], is_super_admin=True)


class _NoDb:
    """Any query fails the test: the guards must answer first."""

    def __getattr__(self, name):
        raise AssertionError(f"database used ({name}) before the guard answered")


def _client(role: str | None, *, super_admin=False, access="full", features=None) -> TestClient:
    memberships = (
        ()
        if role is None
        else (MembershipInfo(SCHOOL, "School", "SCH", "active", (role,), None, None, access, features),)
    )
    user = CurrentUser(uuid.uuid4(), "u@example.com", "U", super_admin, memberships)

    async def _db():
        yield _NoDb()

    app.dependency_overrides = {get_claims: lambda: {"sub": str(user.id)}, get_db: _db, get_current_user: lambda: user}
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset():
    yield
    app.dependency_overrides = {}


@pytest.mark.parametrize("role", ["accountant", "teacher", "librarian", "parent", "student"])
def test_only_school_admins_see_billing_and_manage_sign_ins(role):
    c = _client(role)
    assert c.get("/api/v1/school/billing", headers=H).status_code == 403
    assert c.post("/api/v1/school/billing/cancel", headers=H, json={"mode": "at_period_end"}).status_code == 403
    assert c.post(f"/api/v1/school/billing/invoices/{uuid.uuid4()}/pay", headers=H).status_code == 403
    assert c.get(f"/api/v1/school/billing/invoices/{uuid.uuid4()}/pdf", headers=H).status_code == 403
    assert c.get("/api/v1/school/staff-accounts", headers=H).status_code == 403
    assert (
        c.post(
            "/api/v1/school/staff-accounts/accountants", headers=H, json={"email": "a@b.co", "full_name": "A B"}
        ).status_code
        == 403
    )


def test_a_school_cannot_cancel_at_once_or_bring_back_a_cancelled_subscription():
    c = _client("school_admin")
    for mode in ("now", "reactivate"):
        assert c.post("/api/v1/school/billing/cancel", headers=H, json={"mode": mode}).status_code == 422


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/api/v1/students"),
        ("PATCH", f"/api/v1/students/{uuid.uuid4()}"),
        ("PUT", "/api/v1/attendance/roster"),
        ("POST", f"/api/v1/fee-collection/enrollments/{uuid.uuid4()}/payments"),
        ("DELETE", f"/api/v1/notices/{uuid.uuid4()}"),
    ],
)
def test_an_ended_subscription_makes_the_school_read_only(method, path):
    c = _client("school_admin", access="read_only")
    r = c.request(method, path, headers=H, json={})
    assert r.status_code == 402 and "read-only" in r.json()["detail"]


def test_read_only_still_reads_and_lets_admins_pay():
    c = _client("school_admin", access="read_only")
    # reading passes the guard (it then reaches the database, which this test doesn't have)
    with pytest.raises(AssertionError, match="database used"):
        c.get("/api/v1/students", headers=H)
    with pytest.raises(AssertionError, match="database used"):
        c.post(f"/api/v1/school/billing/invoices/{uuid.uuid4()}/pay", headers=H)


def test_the_platform_super_admin_is_never_read_only():
    c = _client("school_admin", super_admin=True, access="read_only")
    with pytest.raises(AssertionError, match="database used"):
        c.post("/api/v1/notices", headers=H, json={"title": "Hello there", "body": "Body text", "audience": "everyone"})


@pytest.mark.parametrize(
    "feature,method,path",
    [
        ("reports", "GET", "/api/v1/reports/students"),
        ("analytics", "GET", "/api/v1/analytics/fees"),
        ("whatsapp", "PUT", "/api/v1/notifications/admin/channels/whatsapp"),
    ],
)
def test_features_outside_the_plan_are_refused(feature, method, path):
    c = _client("school_admin", features=("students",))
    r = c.request(method, path, headers=H, json={})
    assert r.status_code == 403 and "isn't included in your school's plan" in r.json()["detail"]
    # no subscription recorded (features None): allowed past the guard
    c = _client("school_admin", features=None)
    try:
        r = c.request(method, path, headers=H, json={} if feature == "whatsapp" else None)
    except AssertionError as e:  # reached the database: the guard let it through
        assert "database used" in str(e)
    else:  # or the body was refused for its content (422) — either way, not by the plan guard
        assert r.status_code != 403, r.text


def test_platform_input_is_checked_before_anything_happens():
    c = _client(None, super_admin=True)
    sid = uuid.uuid4()
    assert (
        c.put(
            f"/api/v1/admin/schools/{sid}/subscription",
            json={"plan_id": str(uuid.uuid4()), "billing_cycle": "monthly", "trial": "until"},
        ).status_code
        == 422
    )
    assert (
        c.post(
            "/api/v1/admin/plans", json={"code": "X", "name": "X plan", "price_monthly": "-1", "price_yearly": "0"}
        ).status_code
        == 422
    )
    assert c.patch(f"/api/v1/admin/schools/{sid}/admins/{uuid.uuid4()}", json={"status": "deleted"}).status_code == 422
    assert (
        c.post(
            f"/api/v1/admin/invoices/{uuid.uuid4()}/payments",
            json={"amount": "10", "method": "upi", "paid_on": "2026-10-01"},
        ).status_code
        == 422
    )
    assert c.post(f"/api/v1/admin/invoices/{uuid.uuid4()}/void", json={"reason": ""}).status_code == 422
    assert c.get("/api/v1/admin/schools/not-a-uuid/usage").status_code == 422


def _sign(body: bytes, secret: str) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_billing_webhook_needs_the_platform_signature(monkeypatch):
    monkeypatch.setattr(
        billing,
        "get_settings",
        lambda: SimpleNamespace(
            platform_razorpay_webhook_secret="whsec-platform-1",
            platform_razorpay_key_id="",
            platform_razorpay_key_secret="",
        ),
    )
    app.dependency_overrides = {}
    c = TestClient(app)
    body = json.dumps({"event": "payment.captured", "payload": {}}).encode()
    assert c.post("/api/v1/billing/webhooks/razorpay", content=body).status_code == 400
    assert (
        c.post(
            "/api/v1/billing/webhooks/razorpay", content=body, headers={"x-razorpay-signature": _sign(body, "wrong")}
        ).status_code
        == 400
    )
    monkeypatch.setattr(
        billing,
        "get_settings",
        lambda: SimpleNamespace(
            platform_razorpay_webhook_secret="", platform_razorpay_key_id="", platform_razorpay_key_secret=""
        ),
    )
    # no secret configured: nothing is accepted, not even a "signed" body
    assert (
        c.post(
            "/api/v1/billing/webhooks/razorpay", content=body, headers={"x-razorpay-signature": _sign(body, "")}
        ).status_code
        == 400
    )
