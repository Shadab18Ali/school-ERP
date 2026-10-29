from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from app.api.v1.routes.enquiries import (
    FUNNEL,
    SOURCE_LABEL,
    SOURCES,
    STATUS_LABEL,
    STATUSES,
    EnquiryIn,
    EnquiryPatch,
)

BASE = {"parent_name": "  Rohan   Verma ", "student_name": "Aarav Verma", "phone": "+91 98111-22233"}


def test_enquiry_is_tidied():
    e = EnquiryIn(**BASE, notes="  Wants   transport.\n\n  Call after 6 pm  ", email=" ")
    assert e.parent_name == "Rohan Verma"
    assert e.phone == "+919811122233"
    assert e.notes == "Wants transport.\n\nCall after 6 pm"
    assert e.email is None
    assert e.status == "new" and e.source == "walk_in"


@pytest.mark.parametrize(
    "extra",
    [
        {"phone": "12345"},
        {"parent_name": "A"},
        {"status": "follow_up"},  # needs a date
        {"status": "won"},
        {"source": "tv"},
        {"enquiry_date": (date.today() + timedelta(days=1)).isoformat()},
        {"follow_up_date": (date.today() + timedelta(days=400)).isoformat()},
        {"notes": "x" * 2001},
        {"school_id": "00000000-0000-0000-0000-000000000000"},  # unknown fields are refused
        {"enquiry_number": "ENQ-1"},
    ],
)
def test_bad_enquiries_are_refused(extra):
    with pytest.raises(ValidationError):
        EnquiryIn(**{**BASE, **extra})


def test_follow_up_with_a_date_is_fine():
    e = EnquiryIn(**BASE, status="follow_up", follow_up_date=date.today() + timedelta(days=2))
    assert e.status == "follow_up"


def test_patch_takes_any_subset_and_a_history_note():
    p = EnquiryPatch(status="contacted", activity_note="  Called;   will visit  ")
    assert p.model_dump(exclude_unset=True) == {"status": "contacted", "activity_note": "Called; will visit"}
    assert EnquiryPatch(application_id=None).model_dump(exclude_unset=True) == {"application_id": None}  # unlink
    with pytest.raises(ValidationError):
        EnquiryPatch(created_by="00000000-0000-0000-0000-000000000000")


def test_labels_cover_every_status_and_source():
    assert set(STATUS_LABEL) == set(STATUSES)
    assert set(SOURCE_LABEL) == set(SOURCES)
    expected = ["new", "contacted", "follow_up", "interested", "application", "approved", "rejected", "admitted"]
    assert list(STATUSES) == expected


def test_funnel_stages_narrow():
    # each stage counts a subset of the one before it, and rejection is never a stage
    stages = [set(s) for _, _, s in FUNNEL]
    for earlier, later in zip(stages, stages[1:], strict=False):
        assert later < earlier
    assert all("rejected" not in s for s in stages[1:])
    assert stages[-1] == {"admitted"}
