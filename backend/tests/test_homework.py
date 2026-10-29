import io
import zipfile
from datetime import UTC, datetime, timedelta

import pytest
from PIL import Image
from pydantic import ValidationError

from app.api.v1.routes.homework import HomeworkIn, ReviewIn, _money
from app.services.documents import DocumentError, clean_homework_file

SECTION = "00000000-0000-4000-8000-000000000001"


def office(main: str, ctype: str, extra: dict[str, str] | None = None) -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("[Content_Types].xml", f'<Types><Override PartName="/{main}" ContentType="{ctype}"/></Types>')
        z.writestr(main, "<x/>")
        for k, v in (extra or {}).items():
            z.writestr(k, v)
    return b.getvalue()


def png() -> bytes:
    b = io.BytesIO()
    Image.new("RGB", (200, 150), (10, 20, 30)).save(b, "PNG")
    return b.getvalue()


@pytest.mark.parametrize(
    ("main", "ext"),
    [("word/document.xml", "docx"), ("xl/workbook.xml", "xlsx"), ("ppt/presentation.xml", "pptx")],
)
def test_office_files_are_recognised_by_content(main, ext):
    f = clean_homework_file(office(main, "application/xml"), "anything.bin")
    assert f.extension == ext


@pytest.mark.parametrize(
    "extra",
    [{"word/vbaProject.bin": "x"}, {"word/activeX/activeX1.xml": "x"}, {"word/embeddings/oleObject1.bin": "x"}],
)
def test_macros_controls_and_embedded_objects_are_refused(extra):
    with pytest.raises(DocumentError, match="macros"):
        clean_homework_file(office("word/document.xml", "application/xml", extra), "a.docx")


def test_macro_enabled_content_type_is_refused():
    with pytest.raises(DocumentError, match="macros"):
        clean_homework_file(
            office("word/document.xml", "application/vnd.ms-word.document.macroEnabled.main+xml"), "a.docx"
        )


def test_zip_that_is_not_office_is_refused():
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("evil.exe", "MZ")
    with pytest.raises(DocumentError):
        clean_homework_file(b.getvalue(), "homework.docx")


def test_text_needs_txt_name_and_utf8():
    assert clean_homework_file("नमस्ते".encode(), "notes.txt").mime_type == "text/plain"
    with pytest.raises(DocumentError):
        clean_homework_file(b"plain words", "notes.exe")
    with pytest.raises(DocumentError):
        clean_homework_file(b"\x00\x01binary", "notes.txt")


def test_images_are_reencoded_and_executables_refused():
    assert clean_homework_file(png(), "photo.png").mime_type == "image/png"
    with pytest.raises(DocumentError):
        clean_homework_file(b"MZ\x90\x00" * 50, "photo.png")
    with pytest.raises(DocumentError, match="empty"):
        clean_homework_file(b"", "a.pdf")


def test_deadline_must_carry_a_time_zone():
    with pytest.raises(ValidationError, match="time zone"):
        HomeworkIn(section_id=SECTION, title="Essay", due_at=datetime(2030, 1, 1, 10, 0))
    ok = HomeworkIn(section_id=SECTION, title="  Essay  ", due_at=datetime.now(UTC) + timedelta(days=1))
    assert ok.title == "Essay" and ok.kind == "homework"


def test_marks_rules():
    with pytest.raises(ValidationError):
        HomeworkIn(section_id=SECTION, title="Essay", due_at=datetime.now(UTC), max_marks="0")
    with pytest.raises(ValidationError):
        ReviewIn(marks="-1")
    with pytest.raises(ValidationError):
        ReviewIn(marks="1.234")
    with pytest.raises(ValidationError):
        HomeworkIn(section_id=SECTION, title="Essay", due_at=datetime.now(UTC), kind="quiz")
    assert _money(None) is None
    assert ReviewIn(marks="17.5", feedback="  ok ").feedback == "ok"


@pytest.mark.parametrize(("v", "out"), [("20.00", "20"), ("17.50", "17.5"), ("0.25", "0.25")])
def test_marks_display(v, out):
    from decimal import Decimal

    assert _money(Decimal(v)) == out
