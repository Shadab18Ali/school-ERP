import io
from datetime import time

import pytest
from pydantic import ValidationError
from pypdf import PdfReader

from app.api.v1.routes.timetable import EntryIn, EntryUpdate, GenerateDay, PeriodIn, SubjectIn, SubjectUpdate
from app.services.timetable_pdf import PdfCell, PdfPeriod, build_timetable_pdf

SEC = "11111111-1111-4111-8111-111111111111"


def test_subject_codes_and_names():
    s = SubjectIn(name="  Social   Science ", code="sst")
    assert s.name == "Social Science" and s.code == "SST"
    with pytest.raises(ValidationError):
        SubjectIn(name="Art", code="bad code")
    assert SubjectUpdate(code=None).model_fields_set == {"code"}  # a code can be removed


def test_period_must_end_after_it_starts():
    PeriodIn(period_number=1, start_time="08:00", end_time="08:40")
    with pytest.raises(ValidationError, match="end after"):
        PeriodIn(period_number=1, start_time="09:00", end_time="08:40")
    with pytest.raises(ValidationError):
        PeriodIn(period_number=21, start_time="08:00", end_time="08:40")


def test_entry_inputs():
    e = EntryIn(section_id=SEC, day_of_week=1, period_id=SEC, subject_id=SEC, room="  r 101 ")
    assert e.room == "r 101" and e.teacher_id is None
    with pytest.raises(ValidationError):
        EntryIn(section_id=SEC, day_of_week=8, period_id=SEC, subject_id=SEC)
    with pytest.raises(ValidationError, match="Choose a subject"):
        EntryUpdate(subject_id=None)
    assert EntryUpdate(teacher_id=None).model_fields_set == {"teacher_id"}  # a teacher can be removed


def test_generate_day_bounds():
    g = GenerateDay(academic_session_id=SEC)
    assert (g.periods, g.period_minutes, g.break_after) == (8, 40, 4)
    with pytest.raises(ValidationError):
        GenerateDay(academic_session_id=SEC, period_minutes=5)


def test_pdf_grid_contents():
    periods = [
        PdfPeriod("p1", 1, "Period 1", time(8), time(8, 40), False),
        PdfPeriod("b", 2, "Lunch", time(8, 40), time(9, 10), True),
    ]
    pdf = build_timetable_pdf(
        "Green Valley",
        "Class 5 – A – timetable",
        "Session 2026-27",
        periods,
        [1, 2, 3, 4, 5, 6],
        [PdfCell(1, "p1", "Mathematics", "Meera Iyer", "R-101")],
    )
    text = PdfReader(io.BytesIO(pdf)).pages[0].extract_text()
    for want in ("Class 5", "Monday", "Saturday", "Mathematics", "Meera Iyer · R-101", "LUNCH", "08:00–08:40"):
        assert want in text, want
