from datetime import date, timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.api.v1.routes.library import (
    BookIn,
    CollectIn,
    CopiesIn,
    IssueIn,
    NewBookIn,
    ReturnIn,
    SettingsIn,
    WaiveIn,
    _loan_out,
    isbn13,
)
from app.services.notify.catalog import EVENTS
from app.services.notify.render import render, sample_values, validate
from app.services.notify.sender import in_app_link


# ---------------------------------------------------------------- ISBN (same rules as private.isbn13)
@pytest.mark.parametrize(
    ("raw", "want"),
    [
        ("0-306-40615-2", "9780306406157"),
        ("978-0-306-40615-7", "9780306406157"),
        ("978 0 306 40615 7", "9780306406157"),
        ("080442957X", "9780804429573"),
        ("080442957x", "9780804429573"),
        ("9798886451740", "9798886451740"),
        ("", None),
        (None, None),
    ],
)
def test_isbn_normalised(raw, want):
    assert isbn13(raw) == want


@pytest.mark.parametrize("raw", ["0-306-40615-3", "978-0-306-40615-8", "12345", "9770306406157", "ABCDEFGHIJ"])
def test_isbn_refused(raw):
    with pytest.raises(ValueError):
        isbn13(raw)


# ---------------------------------------------------------------- input
def test_book_input_is_cleaned():
    b = BookIn(title="  Swami   and Friends ", isbn="0-306-40615-2", authors=[" R. K.  Narayan", "r. k. narayan", ""])
    assert b.title == "Swami and Friends"
    assert b.isbn == "9780306406157"
    assert b.authors == ["R. K. Narayan"]  # duplicates and blanks dropped
    with pytest.raises(ValidationError, match="check digit"):
        BookIn(title="X", isbn="0-306-40615-3")
    with pytest.raises(ValidationError):
        BookIn(title="X", authors=["A"])  # too short
    with pytest.raises(ValidationError):
        BookIn(title="   ")
    with pytest.raises(ValidationError):
        BookIn(title="X", publication_year=3000)


def test_new_book_accession_numbers():
    b = NewBookIn(title="X", accession_numbers="R-1, R-2  R-3")
    assert b.accession_numbers == ["R-1", "R-2", "R-3"]
    with pytest.raises(ValidationError, match="twice"):
        NewBookIn(title="X", accession_numbers=["R-1", "r-1"])
    with pytest.raises(ValidationError):
        NewBookIn(title="X", accession_numbers=["has space?"])
    with pytest.raises(ValidationError):
        NewBookIn(title="X", copies=101)
    with pytest.raises(ValidationError):
        NewBookIn(title="X", price="-1")


def test_copies_input():
    assert CopiesIn(count=2).count == 2
    with pytest.raises(ValidationError, match="at least one"):
        CopiesIn(count=0)
    assert CopiesIn(count=0, accession_numbers="A1").accession_numbers == ["A1"]


def test_issue_needs_one_copy_and_one_borrower():
    IssueIn(accession_number="ACC-1", student_id="00000000-0000-4000-8000-000000000001")
    with pytest.raises(ValidationError, match="copy"):
        IssueIn(student_id="00000000-0000-4000-8000-000000000001")
    with pytest.raises(ValidationError, match="one borrower"):
        IssueIn(accession_number="A", student_id="00000000-0000-4000-8000-000000000001",
                teacher_id="00000000-0000-4000-8000-000000000002")  # fmt: skip
    with pytest.raises(ValidationError, match="one borrower"):
        IssueIn(accession_number="A")


def test_return_collect_waive_inputs():
    assert ReturnIn().condition == "good"
    with pytest.raises(ValidationError):
        ReturnIn(condition="burnt")
    with pytest.raises(ValidationError):
        ReturnIn(condition="lost", charge="-5")
    assert CollectIn(mode="upi", reference="  UPI 77 ").reference == "UPI 77"
    with pytest.raises(ValidationError):
        CollectIn(mode="bitcoin")
    with pytest.raises(ValidationError):
        WaiveIn(reason="  ")


def test_settings_bounds():
    ok = dict(loan_days_student=14, loan_days_staff=30, max_books_student=2, max_books_staff=5, fine_per_day="1.50",
              grace_days=0, max_renewals=1, block_when_overdue=True, block_when_fines_due=True)  # fmt: skip
    s = SettingsIn(**ok)
    assert s.fine_per_day == Decimal("1.50") and s.max_fine is None
    for bad in ({"fine_per_day": "-1"}, {"fine_per_day": "1.555"}, {"loan_days_student": 0}, {"max_fine": "0"},
                {"grace_days": 31}, {"max_renewals": 6}, {"surprise": 1}):  # fmt: skip
        with pytest.raises(ValidationError):
            SettingsIn(**{**ok, **bad})


# ---------------------------------------------------------------- loan shaping
def _row(**kw):
    today = date(2026, 10, 12)
    base = {
        "id": "l1", "copy_id": "c1", "accession_number": "ACC-1", "book_id": "b1", "title": "T",
        "student_id": "s1", "teacher_id": None, "borrower_name": "Child", "borrower_code": "S1",
        "borrower_class": "Class 1 – A", "issued_on": today - timedelta(days=20),
        "due_date": today - timedelta(days=6), "returned_on": None, "return_condition": None, "renewals": 0,
        "fine_per_day": Decimal("2"), "grace_days": 1, "max_fine": None, "fine_amount": Decimal("0"),
        "book_charge": Decimal("0"), "fine_status": "none", "fine_paid_amount": None, "fine_paid_at": None,
        "fine_payment_mode": None, "fine_reference": None, "fine_receipt_number": None, "fine_waived_at": None,
        "fine_waive_reason": None, "note": None, "amount_due": Decimal("10"), "today": today,
        "issued_by_name": "L", "returned_by_name": None,
    }  # fmt: skip
    return {**base, **kw}


def test_loan_out_open_and_overdue():
    d = _loan_out(_row())
    assert d["is_open"] and d["is_overdue"] and d["days_overdue"] == 6
    assert d["amount_due"] == "10.00" and d["borrower_kind"] == "student"
    assert d["due_date"] == "2026-10-06"


def test_loan_out_returned_late_and_staff():
    d = _loan_out(_row(returned_on=date(2026, 10, 9), return_condition="good", teacher_id="t1", student_id=None,
                       fine_amount=Decimal("4"), fine_status="unpaid", amount_due=Decimal("4")))  # fmt: skip
    assert not d["is_open"] and not d["is_overdue"] and d["days_overdue"] == 3
    assert d["borrower_kind"] == "staff" and d["fine_amount"] == "4.00"


def test_loan_out_not_yet_due():
    d = _loan_out(_row(due_date=date(2026, 10, 20), amount_due=Decimal("0")))
    assert not d["is_overdue"] and d["days_overdue"] == 0


# ---------------------------------------------------------------- the overdue message (Phase 22)
def test_overdue_message_templates():
    ev = EVENTS["library_overdue"]
    for d in ev.defaults.values():
        validate(ev, d.subject, d.body)
        assert "{{" not in render(d.body, sample_values(ev))
    assert not ev.defaults["sms"].enabled and not ev.defaults["whatsapp"].enabled
    assert in_app_link("library_overdue", "parent", "s1", {}) == "/portal/s1?tab=Library"
    assert in_app_link("library_overdue", "student", "s1", {}) == "/my?tab=Library"


# ---------------------------------------------------------------- database messages reach the user
class _Orig(Exception):
    def __init__(self, sqlstate, message, constraint=None):
        super().__init__(message)
        self.sqlstate, self.message, self.constraint_name = sqlstate, message, constraint


class _Db:
    async def rollback(self):
        pass


def _http(sqlstate, message, constraint=None, unique=None):
    import asyncio

    from sqlalchemy.exc import DBAPIError

    from app.db.errors import http_error_from_db

    exc = DBAPIError("select 1", {}, _Orig(sqlstate, message, constraint))
    return asyncio.run(http_error_from_db(_Db(), exc, unique))


def test_error_messages():
    e = _http("42501", "Only school admins can waive a fine.")
    assert e.status_code == 403 and e.detail == "Only school admins can waive a fine."
    assert _http("42501", "permission denied for table library_loans").detail == "Your role doesn't allow this action."
    assert _http("42501", 'new row violates row-level security policy for table "x"').detail.startswith("Your role")
    assert _http("23505", "Accession number R-1 is already used.").detail == "Accession number R-1 is already used."
    assert (
        _http("23505", "dup", "library_books_isbn_key", {"library_books_isbn_key": "Same ISBN."}).detail == "Same ISBN."
    )
    assert _http("23514", "Copy ACC-1 is not available (it is issued).").status_code == 409
