import pytest
from pydantic import ValidationError

from app.schemas.school import SchoolCreate, SchoolUpdate


def test_code_normalised():
    assert SchoolCreate(name="Green Valley", code=" gvs-01 ").code == "GVS-01"


@pytest.mark.parametrize("code", ["A", "has space", "bad_char", "X" * 21])
def test_code_rejected(code):
    with pytest.raises(ValidationError):
        SchoolCreate(name="Green Valley", code=code)


def test_update_rejects_null_name():
    with pytest.raises(ValidationError):
        SchoolUpdate.model_validate({"name": None})


def test_blank_optional_fields_become_none():
    s = SchoolCreate(name="Green Valley", code="GV", email="", city="  ")
    assert s.email is None and s.city is None
