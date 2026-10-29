import uuid

import pytest
from pydantic import ValidationError

from app.schemas.classes import (
    ClassBulkCreate,
    ClassCreate,
    ClassUpdate,
    SectionBulkCreate,
    SectionCopy,
    SectionCreate,
    SectionUpdate,
)

U1, U2 = uuid.uuid4(), uuid.uuid4()


def test_class_name_is_trimmed_and_collapsed():
    assert ClassCreate(name="  Class    10 ").name == "Class 10"


@pytest.mark.parametrize("bad", ["", "   ", "x" * 51])
def test_class_name_rejected(bad):
    with pytest.raises(ValidationError):
        ClassCreate(name=bad)


def test_class_order_range():
    with pytest.raises(ValidationError):
        ClassCreate(name="LKG", display_order=1000)


def test_bulk_classes_limits():
    with pytest.raises(ValidationError):
        ClassBulkCreate(classes=[])
    ok = ClassBulkCreate(classes=[{"name": "Nursery", "display_order": 1}, {"name": "LKG", "display_order": 2}])
    assert [c.name for c in ok.classes] == ["Nursery", "LKG"]


def test_class_update_rejects_nulls_and_unknown_fields():
    with pytest.raises(ValidationError):
        ClassUpdate.model_validate({"name": None})
    with pytest.raises(ValidationError):
        ClassUpdate.model_validate({"school_id": str(U1)})
    with pytest.raises(ValidationError):
        ClassUpdate.model_validate({"deleted_at": "2026-01-01T00:00:00Z"})


def test_section_capacity_bounds():
    SectionCreate(class_id=U1, academic_session_id=U2, name="A", capacity=40)
    for bad in (0, 501):
        with pytest.raises(ValidationError):
            SectionCreate(class_id=U1, academic_session_id=U2, name="A", capacity=bad)


def test_bulk_section_names_dedupe_case_insensitively():
    b = SectionBulkCreate(academic_session_id=U1, class_ids=[U2], names=["A", "a", " B ", "b"])
    assert b.names == ["A", "B"]


def test_bulk_section_name_length():
    with pytest.raises(ValidationError):
        SectionBulkCreate(academic_session_id=U1, class_ids=[U2], names=["x" * 21])


def test_copy_needs_two_sessions():
    with pytest.raises(ValidationError):
        SectionCopy(from_session_id=U1, to_session_id=U1)


def test_section_update_allows_clearing_capacity_and_room():
    u = SectionUpdate.model_validate({"capacity": None, "room": "  "})
    assert u.capacity is None and u.room is None and u.model_fields_set == {"capacity", "room"}


def test_section_update_cannot_change_session():
    with pytest.raises(ValidationError):
        SectionUpdate.model_validate({"academic_session_id": str(U1)})
    with pytest.raises(ValidationError):
        SectionUpdate.model_validate({"name": None})
