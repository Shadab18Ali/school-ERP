import io
from datetime import date
from decimal import Decimal

import pytest
from PIL import Image as PILImage
from pydantic import ValidationError
from pypdf import PdfReader

from app.api.v1.routes.report_cards import TemplateCreate, TemplateUpdate
from app.services.exam_pdf import StudentResult, SubjectLine
from app.services.images import LogoError, process_signature
from app.services.report_card_pdf import (
    Attendance,
    Card,
    CardSet,
    CardStudent,
    SchoolInfo,
    TemplateSettings,
    build_report_card_pdf,
    sample_cards,
)

GRADES = [("A1", Decimal(91), None), ("B1", Decimal(71), None), ("D", Decimal(33), None), ("E", Decimal(0), None)]


def png(w=120, h=60, mode="RGB") -> bytes:
    b = io.BytesIO()
    PILImage.new(mode, (w, h), (20, 30, 40)).save(b, "PNG")
    return b.getvalue()


def card(n_subjects=5, **kw) -> Card:
    subjects = [
        SubjectLine(
            f"Subject {i}", date(2026, 9, 20), Decimal(100), Decimal(33), Decimal(70 + i), False, True, "B1", True
        )
        for i in range(n_subjects)
    ]
    subjects[0] = SubjectLine("English", date(2026, 9, 20), Decimal(80), Decimal("26.5"), None, True, True, "AB", False)
    result = StudentResult(
        "Asha Verma", "A-101", Decimal("300"), Decimal(480), Decimal("62.50"), "B2", "fail", 7, subjects
    )
    base = dict(
        student=CardStudent(
            "Asha Verma",
            "A-101",
            "STU00001",
            "Class 5 – A",
            date(2016, 1, 2),
            "Ramesh Verma",
            "Sunita Verma",
            photo=png(300, 400),
        ),
        result=result,
        out_of=32,
        attendance=Attendance(88, 96, date(2026, 4, 1), date(2026, 9, 25)),
        teacher_remarks="Regular and attentive.",
        principal_remarks="Promoted.",
        class_teacher="Meera Iyer",
    )
    return Card(**{**base, **kw})


def text_of(pdf: bytes) -> str:
    return " ".join(" ".join(p.extract_text().split()) for p in PdfReader(io.BytesIO(pdf)).pages)


def cards_pdf(t: TemplateSettings, cards: list[Card]) -> bytes:
    cs = CardSet(
        SchoolInfo(
            "Green Valley School",
            "Ring Road, Delhi",
            "Phone 011-1",
            "CBSE affiliation no. 1",
            logo_png=png(200, 200, "RGBA"),
        ),
        t,
        "Half Yearly",
        "2026-27",
        GRADES,
        date(2026, 10, 9),
    )
    return build_report_card_pdf(cs, cards)


def test_everything_requested_is_on_the_card():
    t = TemplateSettings(
        principal_name="Dr. A. Sharma", principal_signature_png=png(), footer_note="Computer generated."
    )
    text = text_of(cards_pdf(t, [card()]))
    for part in [
        "Green Valley School",
        "REPORT CARD",
        "Asha Verma",
        "A-101",
        "STU00001",
        "Class 5 – A",
        "02 Jan 2016",
        "Ramesh Verma",
        "Sunita Verma",
        "English",
        "AB",
        "300/480",
        "62.5%",
        "B2",
        "FAIL",
        "7 of 32",
        "Present on 88 of 96",
        "91.7%",
        "Regular and attentive.",
        "Promoted.",
        "Class Teacher",
        "Meera Iyer",
        "Principal",
        "Dr. A. Sharma",
        "Parent / Guardian",
        "Grading scale",
        "Date of issue: 09 Oct 2026",
        "Computer generated.",
    ]:
        assert part in text, part


def test_template_switches_hide_sections():
    t = TemplateSettings(
        show_rank=False,
        show_attendance=False,
        show_teacher_remarks=False,
        show_principal_remarks=False,
        show_grade_scale=False,
        show_pass_marks=False,
        show_subject_grades=False,
        signature_3=None,
        title="Progress Report",
    )
    text = text_of(cards_pdf(t, [card()]))
    assert "PROGRESS REPORT" in text
    for gone in [
        "RANK IN SECTION",
        "Present on",
        "Class teacher's remarks",
        "Principal's remarks",
        "Grading scale",
        "Parent / Guardian",
    ]:
        assert gone not in text, gone


@pytest.mark.parametrize("layout", ["classic", "modern"])
@pytest.mark.parametrize("n", [3, 8, 14])
def test_one_page_per_student_even_with_many_subjects(layout, n):
    pdf = cards_pdf(TemplateSettings(layout=layout), [card(n), card(n), card(n)])
    assert len(PdfReader(io.BytesIO(pdf)).pages) == 3


def test_missing_images_and_attendance_never_break_a_card():
    c = card(attendance=Attendance(0, 0, date(2026, 4, 1), date(2026, 9, 1)), teacher_remarks=None)
    c.student.photo = b"not an image"
    t = TemplateSettings(principal_signature_png=b"garbage")
    text = text_of(cards_pdf(t, [c]))
    assert "No attendance has been recorded" in text and "Asha Verma" in text


def test_sample_preview_is_marked_and_fictional():
    t = TemplateSettings()
    cs, cards = sample_cards(t, SchoolInfo("Any School"), GRADES)
    text = text_of(build_report_card_pdf(cs, cards, sample=True))
    assert "Sample Student" in text and "SAMPLE" in text


def test_template_inputs():
    assert TemplateCreate(name="  Annual   blue ").name == "Annual blue"
    with pytest.raises(ValidationError):
        TemplateUpdate(accent_color="red")
    with pytest.raises(ValidationError):
        TemplateUpdate(layout="fancy")
    with pytest.raises(ValidationError):
        TemplateUpdate(title="x" * 61)
    assert TemplateUpdate(signature_3="").signature_3 == ""


def test_signature_images_are_cleaned():
    out = process_signature(png(1200, 400, "RGBA"))
    img = PILImage.open(io.BytesIO(out))
    assert img.format == "PNG" and img.size[0] <= 600 and img.size[1] <= 200
    with pytest.raises(LogoError):
        process_signature(b"%PDF-1.4 not an image")
