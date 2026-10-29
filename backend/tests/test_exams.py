import io
from datetime import date, time
from decimal import Decimal

import pytest
from pydantic import ValidationError
from pypdf import PdfReader

from app.api.v1.routes.exams import STANDARD_GRADES, STANDARD_TYPES, Band, MarkEntry, PaperIn, Scale, TypeIn
from app.services.exam_pdf import StudentResult, SubjectLine, build_result_sheet, num

ENR = "00000000-0000-4000-8000-000000000001"


def test_standard_types_and_grades():
    assert STANDARD_TYPES == ["Unit Test", "Half Yearly", "Annual"]
    mins = [m for _, m, _ in STANDARD_GRADES]
    assert mins == sorted(mins, reverse=True) and mins[-1] == 0


def test_scale_needs_zero_and_unique_grades():
    with pytest.raises(ValidationError, match="start at 0%"):
        Scale(bands=[Band(grade="A", min_percentage=90), Band(grade="B", min_percentage=40)])
    with pytest.raises(ValidationError, match="only once"):
        Scale(bands=[Band(grade="A", min_percentage=90), Band(grade="a", min_percentage=0)])
    with pytest.raises(ValidationError, match="same percentage"):
        Scale(bands=[Band(grade="A", min_percentage=0), Band(grade="B", min_percentage=0)])
    with pytest.raises(ValidationError):
        Band(grade="TOO-LONG", min_percentage=10)
    with pytest.raises(ValidationError):
        Band(grade="A", min_percentage=101)


def paper(**kw):
    base = {
        "class_ids": [ENR],
        "subject_id": ENR,
        "exam_date": date(2026, 9, 20),
        "start_time": time(9),
        "end_time": time(12),
        "max_marks": Decimal(100),
        "pass_marks": Decimal(33),
    }
    return PaperIn(**{**base, **kw})


def test_paper_rules():
    assert paper().pass_marks == 33
    with pytest.raises(ValidationError, match="Passing marks"):
        paper(pass_marks=Decimal(101))
    with pytest.raises(ValidationError, match="end after"):
        paper(end_time=time(9))
    with pytest.raises(ValidationError):
        paper(max_marks=Decimal(0))
    with pytest.raises(ValidationError):
        paper(max_marks=Decimal("10.555"))


@pytest.mark.parametrize("marks", ["-1", "1000.01", "12.345"])
def test_invalid_marks_are_refused(marks):
    with pytest.raises(ValidationError):
        MarkEntry(enrollment_id=ENR, marks=marks)


def test_absent_and_marks_are_exclusive():
    with pytest.raises(ValidationError, match="absent"):
        MarkEntry(enrollment_id=ENR, marks="10", absent=True)
    assert MarkEntry(enrollment_id=ENR, absent=True).marks is None
    assert MarkEntry(enrollment_id=ENR).marks is None  # empty = clear the entry


def test_type_name_is_tidied():
    assert TypeIn(name="  Unit   Test ").name == "Unit Test"


@pytest.mark.parametrize(
    ("v", "out"), [(Decimal("95.50"), "95.5"), (Decimal("100.00"), "100"), (None, "—"), (Decimal("0"), "0")]
)
def test_num(v, out):
    assert num(v) == out


def _result(name: str, result: str, pct: str | None, rank: int | None) -> StudentResult:
    return StudentResult(
        full_name=name,
        admission_number="A1",
        total=Decimal("95.5"),
        max_total=Decimal(180),
        percentage=Decimal(pct) if pct else None,
        grade="C1" if pct else None,
        result=result,
        rank=rank,
        subjects=[
            SubjectLine(
                "Mathematics", date(2026, 9, 20), Decimal(100), Decimal(33), Decimal("95.5"), False, True, "A1", True
            ),
            SubjectLine("English", date(2026, 9, 21), Decimal(80), Decimal("26.5"), None, True, True, "AB", False),
        ],
    )


def test_result_sheet_pdf():
    rs = build_result_sheet(
        "School",
        "Half Yearly",
        "2026-27",
        "Class 5 – A",
        [("Mathematics", Decimal(100)), ("English", Decimal(80))],
        [_result("Asha", "fail", "53.06", 2), _result("Ravi", "incomplete", None, None)],
    )
    text = PdfReader(io.BytesIO(rs)).pages[0].extract_text()
    assert "1 failed" in text and "1 incomplete" in text and "INCOMPLETE" in text
