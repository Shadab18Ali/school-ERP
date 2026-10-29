import uuid
from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from app.schemas.attendance import RosterSave

E = [str(uuid.uuid4()) for _ in range(3)]


def body(**kw):
    return {
        "section_id": str(uuid.uuid4()),
        "date": "2026-07-01",
        "entries": [{"enrollment_id": e, "status": "present"} for e in E],
        **kw,
    }


def test_valid_save():
    s = RosterSave(**body())
    assert len(s.entries) == 3


def test_only_three_statuses():
    with pytest.raises(ValidationError):
        RosterSave(**body(entries=[{"enrollment_id": E[0], "status": "sick"}]))


def test_no_future_dates():
    with pytest.raises(ValidationError, match="future"):
        RosterSave(**body(date=(date.today() + timedelta(days=1)).isoformat()))


def test_no_duplicate_students():
    with pytest.raises(ValidationError, match="twice"):
        RosterSave(
            **body(entries=[{"enrollment_id": E[0], "status": "present"}, {"enrollment_id": E[0], "status": "absent"}])
        )


def test_remarks_trimmed_and_unknown_fields_refused():
    s = RosterSave(**body(entries=[{"enrollment_id": E[0], "status": "leave", "remarks": "  fever   (note) "}]))
    assert s.entries[0].remarks == "fever (note)"
    with pytest.raises(ValidationError):
        RosterSave(**body(entries=[{"enrollment_id": E[0], "status": "leave", "marked_by": "x"}]))


def test_empty_save_refused():
    with pytest.raises(ValidationError):
        RosterSave(**body(entries=[]))
