from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from app.schemas.teachers import AssignmentIn, StatusChange, TeacherCreate, TeacherUpdate

BASE = {"full_name": "Meera Iyer", "phone": "98765 11111", "email": "Meera@Example.com", "joining_date": "2023-06-01"}


def test_create_normalises_fields():
    t = TeacherCreate(**BASE, employee_id=" emp-7 ", qualification="  M.Sc,   B.Ed ")
    assert t.employee_id == "EMP-7"
    assert t.phone == "9876511111"
    assert t.email == "meera@example.com"
    assert t.qualification == "M.Sc, B.Ed"


def test_blank_employee_id_means_automatic():
    assert TeacherCreate(**BASE, employee_id="   ").employee_id is None
    assert TeacherCreate(**BASE).employee_id is None


@pytest.mark.parametrize(
    "bad",
    [
        {"employee_id": "EMP 01!"},
        {"phone": "12-34"},
        {"email": "not-an-email"},
        {"joining_date": (date.today() + timedelta(days=1)).isoformat()},
        {"joining_date": "1900-01-01"},
        {"full_name": "X"},
        {"salary": 1},
    ],
)
def test_create_refuses_bad_values(bad):
    with pytest.raises(ValidationError):
        TeacherCreate(**{**BASE, **bad})


def test_update_cannot_blank_required_fields():
    for field in ("full_name", "phone", "email", "joining_date", "employee_id"):
        with pytest.raises(ValidationError):
            TeacherUpdate(**{field: None})
    assert TeacherUpdate(qualification=None).model_fields_set == {"qualification"}  # optional fields can be cleared


def test_status_and_assignment_inputs():
    assert StatusChange(status="inactive", reason="  Left   school ").reason == "Left school"
    with pytest.raises(ValidationError):
        StatusChange(status="retired")
    a = AssignmentIn(section_id="11111111-1111-4111-8111-111111111111", subject="  ", is_class_teacher=True)
    assert a.subject is None and a.is_class_teacher
