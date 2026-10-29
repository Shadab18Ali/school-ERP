from datetime import date, timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.api.v1.routes.hr import AllocationIn, AttendanceIn, DecideIn, LeaveIn, LeaveTypeIn, SettingsIn
from app.api.v1.routes.payroll import AdjustmentIn, ComponentIn, StatusIn, StructureIn, _amount
from app.services.payslips import PayslipData, build_payslip_pdf

ID = "00000000-0000-4000-8000-000000000001"


# ---------------------------------------------------------------- leave
def test_settings():
    s = SettingsIn(weekly_offs=[7, 6, 7])
    assert s.weekly_offs == [6, 7] and s.lop_basis == "working_days" and s.unmarked_as == "present"
    for bad in ({"weekly_offs": [0]}, {"weekly_offs": [8]}, {"lop_basis": "hours"}, {"weekly_offs": [1, 2, 3, 4]}):
        with pytest.raises(ValidationError):
            SettingsIn(**bad)


def test_leave_types():
    t = LeaveTypeIn(name=" Casual   leave ", code=" cl ", annual_days="12")
    assert t.name == "Casual leave" and t.code == "CL" and t.annual_days == 12 and t.is_paid
    assert LeaveTypeIn(name="Leave without pay", code="LWP", is_paid=False).annual_days is None  # no limit
    assert LeaveTypeIn(name="Half", code="HL", annual_days="7.5").annual_days == Decimal("7.5")
    for bad in ({"code": "C1"}, {"code": "TOOLONG"}, {"annual_days": "7.3"}, {"annual_days": "-1"}, {"name": "x"}):
        with pytest.raises(ValidationError):
            LeaveTypeIn(**{"name": "Casual", "code": "CL", **bad})


def test_leave_application():
    d = date(2026, 10, 12)
    a = LeaveIn(leave_type_id=ID, start_date=d, end_date=d, half_day=True, reason="  doctor's  appointment ")
    assert a.reason == "doctor's appointment"
    with pytest.raises(ValidationError, match="ends before"):
        LeaveIn(leave_type_id=ID, start_date=d, end_date=d - timedelta(days=1), reason="xyz")
    with pytest.raises(ValidationError, match="single day"):
        LeaveIn(leave_type_id=ID, start_date=d, end_date=d + timedelta(days=1), half_day=True, reason="xyz")
    with pytest.raises(ValidationError):
        LeaveIn(leave_type_id=ID, start_date=d, end_date=d, reason="x")
    with pytest.raises(ValidationError, match="reason"):
        DecideIn(approve=False, note="  ")
    assert DecideIn(approve=True).note is None
    with pytest.raises(ValidationError, match="half days"):
        AllocationIn(teacher_id=ID, leave_type_id=ID, session_id=ID, days="2.2")
    assert AllocationIn(teacher_id=ID, leave_type_id=ID, session_id=ID).days is None  # back to the yearly allowance


def test_attendance_input():
    a = AttendanceIn(date=date(2026, 10, 12), entries=[{"teacher_id": ID, "status": "half_day"}, {"teacher_id": ID}])
    assert a.entries[1].status is None  # clears the mark
    with pytest.raises(ValidationError):
        AttendanceIn(date=date(2026, 10, 12), entries=[{"teacher_id": ID, "status": "late"}])
    with pytest.raises(ValidationError):
        AttendanceIn(date=date(2026, 10, 12), entries=[])


# ---------------------------------------------------------------- payroll
def test_components_and_structures():
    c = ComponentIn(name="House rent allowance", kind="earning", calc="percent_basic", default_value="40")
    assert c.default_value == 40
    with pytest.raises(ValidationError, match="100"):
        ComponentIn(name="HRA", kind="earning", calc="percent_basic", default_value="140")
    with pytest.raises(ValidationError):
        ComponentIn(name="PF", kind="tax", default_value="1")
    with pytest.raises(ValidationError, match="2 decimals"):
        ComponentIn(name="PT", kind="deduction", default_value="200.555")
    s = StructureIn(
        effective_from=date(2026, 4, 17), basic="30000", items=[{"component_id": ID, "calc": "fixed", "value": "1600"}]
    )
    assert s.effective_from == date(2026, 4, 1)  # structures start on the 1st of a month
    with pytest.raises(ValidationError, match="only once"):
        StructureIn(
            effective_from=date(2026, 4, 1),
            basic="1",
            items=[
                {"component_id": ID, "calc": "fixed", "value": "1"},
                {"component_id": ID, "calc": "fixed", "value": "2"},
            ],
        )
    assert _amount("percent_basic", Decimal("40"), Decimal("30000")) == Decimal("12000.00")
    assert _amount("percent_basic", Decimal("12"), Decimal("12345.67")) == Decimal("1481.48")
    assert _amount("fixed", Decimal("1600"), Decimal("30000")) == Decimal("1600")


def test_adjustments_and_status():
    assert AdjustmentIn(label="Exam duty", amount="500").amount == 500
    assert AdjustmentIn(label="Advance recovery", amount="-1000").amount == -1000
    with pytest.raises(ValidationError, match="positive to add"):
        AdjustmentIn(label="Nothing", amount="0")
    with pytest.raises(ValidationError):
        StatusIn(payment_mode="crypto")


def test_payslip_pdf():
    pdf = build_payslip_pdf(
        PayslipData(
            school_name="Test School",
            school_address="1 Road, Delhi",
            logo_png=None,
            month=date(2026, 9, 1),
            status="finalized",
            staff_name="Teacher One",
            employee_id="T-1",
            designation="Mathematics",
            joining_date=date(2020, 6, 1),
            earnings=[
                {"name": "Basic", "full": 30000, "earned": 27115.38},
                {"name": "HRA", "full": 12000, "earned": 10846.15},
            ],
            deductions=[{"name": "Provident fund", "amount": 3253.85}],
            adjustments=[
                {"label": "Exam duty", "amount": "500.00"},
                {"label": "Advance recovery", "amount": "-1000.00"},
            ],
            gross_full=Decimal("42000"),
            gross_earned=Decimal("37961.53"),
            lop_days=Decimal("2.5"),
            lop_amount=Decimal("4038.47"),
            total_deductions=Decimal("3253.85"),
            net_pay=Decimal("34207.68"),
            days={
                "calendar_days": 30,
                "working_days": 26,
                "basis_days": 26,
                "present_days": Decimal("21.5"),
                "absent_days": 1,
            },
        )
    )
    assert pdf.startswith(b"%PDF") and len(pdf) > 2000
