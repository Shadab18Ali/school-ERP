from datetime import date, time, timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.api.v1.routes.transport import (
    DOC_LABEL,
    REQUIRED_VEHICLE_DOCS,
    STAFF_DOCS,
    VEHICLE_DOCS,
    AssignIn,
    EndIn,
    RouteIn,
    StaffIn,
    StopIn,
    VehicleIn,
    ZoneIn,
    _json,
    license_no,
    registration,
)

ZONE = "00000000-0000-4000-8000-000000000001"


# ---------------------------------------------------------------- identifiers (same rules as the database)
@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("dl 1p c-1234", "DL1PC1234"),
        ("MH.12.AB.1234", "MH12AB1234"),
        ("22 BH 1234 AA", "22BH1234AA"),
        ("hr26ab0001", "HR26AB0001"),
    ],
)
def test_registration_numbers(raw, want):
    assert registration(raw) == want


@pytest.mark.parametrize("raw", ["", "AB", "DL1PC1234567890", "DL#1234"])
def test_bad_registration_numbers(raw):
    with pytest.raises(ValueError):
        registration(raw)


def test_licence_numbers():
    assert license_no(" dl-04 2011 0012345 ") == "DL-0420110012345"
    assert license_no("") is None and license_no(None) is None
    with pytest.raises(ValueError):
        license_no("AB1")
    with pytest.raises(ValueError):
        license_no("DL/04/2011")


# ---------------------------------------------------------------- vehicles and staff
def test_vehicle_input():
    v = VehicleIn(registration_number="dl 1p c 1234", vehicle_type="bus", seating_capacity=40, contractor_name="X")
    assert v.registration_number == "DL1PC1234"
    assert v.contractor_name is None  # school-owned: no contractor
    with pytest.raises(ValidationError, match="contractor"):
        VehicleIn(registration_number="DL1PC1234", vehicle_type="van", seating_capacity=8, ownership="contracted")
    for bad in (
        {"seating_capacity": 0},
        {"seating_capacity": 101},
        {"vehicle_type": "rocket"},
        {"manufacture_year": 1970},
    ):
        with pytest.raises(ValidationError):
            VehicleIn(**{"registration_number": "DL1PC1234", "vehicle_type": "bus", "seating_capacity": 40, **bad})


def test_staff_input():
    ok = {
        "role": "driver",
        "full_name": "  Ramesh   Kumar ",
        "phone": "+91 98111-11111",
        "license_number": "dl0420110012345",
        "license_valid_until": date.today() + timedelta(days=100),
    }
    s = StaffIn(**ok)
    assert s.full_name == "Ramesh Kumar" and s.phone == "+919811111111" and s.license_number == "DL0420110012345"
    with pytest.raises(ValidationError, match="licence"):
        StaffIn(**{**ok, "license_number": None})
    with pytest.raises(ValidationError, match="18"):
        StaffIn(**{**ok, "date_of_birth": date.today() - timedelta(days=17 * 365)})
    a = StaffIn(role="attendant", full_name="Sunita Devi", phone="9822222222")
    assert a.license_number is None
    with pytest.raises(ValidationError):
        StaffIn(**{**ok, "phone": "12345"})


# ---------------------------------------------------------------- fares
def test_zone_months():
    z = ZoneIn(name=" Zone A ", amount="1200", billing_months=[4, 5, 5, 7])
    assert z.name == "Zone A" and z.billing_months == [4, 5, 7] and z.due_month is None
    assert ZoneIn(name="Z", amount="1", billing_months=list(range(1, 13))).billing_months is None  # every month
    q = ZoneIn(name="Q", amount="3000", frequency="quarterly", due_month=4, billing_months=[1])
    assert q.billing_months is None and q.due_month == 4
    with pytest.raises(ValidationError, match="first due"):
        ZoneIn(name="Q", amount="3000", frequency="quarterly")
    with pytest.raises(ValidationError):
        ZoneIn(name="Z", amount="0")
    with pytest.raises(ValidationError):
        ZoneIn(name="Z", amount="10.555")
    with pytest.raises(ValidationError):
        ZoneIn(name="Z", amount="10", billing_months=[13])
    with pytest.raises(ValidationError):
        ZoneIn(name="Z", amount="10", frequency="one_time")


# ---------------------------------------------------------------- routes, stops, assignments
def test_route_and_stop_input():
    r = RouteIn(name="  North  ", code="R-1")
    assert r.name == "North" and r.status == "active"
    with pytest.raises(ValidationError):
        RouteIn(name="North", code="R 1")
    s = StopIn(name="Market", pickup_time="07:10", drop_time="14:20", fare_zone_id=ZONE)
    assert s.pickup_time == time(7, 10)
    with pytest.raises(ValidationError):
        StopIn(name="M", fare_zone_id=ZONE)


def test_assignment_input():
    a = AssignIn(student_id=ZONE, route_id=ZONE, stop_id=ZONE, start_date="2026-10-12")
    assert a.trip == "both" and a.charge_fee
    with pytest.raises(ValidationError):
        AssignIn(student_id=ZONE, route_id=ZONE, stop_id=ZONE, start_date="2026-10-12", trip="sometimes")
    assert EndIn().end_date is None


# ---------------------------------------------------------------- documents
def test_document_types():
    assert set(REQUIRED_VEHICLE_DOCS) <= set(VEHICLE_DOCS)
    assert "driving_license" in STAFF_DOCS and "driving_license" not in VEHICLE_DOCS
    assert all(t in DOC_LABEL for t in (*VEHICLE_DOCS, *STAFF_DOCS))


def test_json_shapes():
    out = _json({"t": time(7, 5), "d": date(2026, 4, 1), "m": Decimal("1200"), "n": None, "s": "x"})
    assert out == {"t": "07:05", "d": "2026-04-01", "m": "1200.00", "n": None, "s": "x"}
