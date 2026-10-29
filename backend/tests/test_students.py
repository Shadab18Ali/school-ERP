import io
import uuid
from datetime import date, timedelta

import pytest
from PIL import Image
from pydantic import ValidationError

from app.schemas.students import EnrollmentUpdate, StatusUpdate, StudentCreate, StudentUpdate, normalize_phone
from app.services.images import PhotoError, process_photo

U = uuid.uuid4


def payload(**over):
    base = dict(
        full_name="Aarav Sharma",
        father_name="Rakesh Sharma",
        date_of_birth="2019-05-10",
        gender="male",
        mobile="9876543210",
        enrollment=dict(
            academic_session_id=U(),
            class_id=U(),
            section_id=U(),
            admission_number="ADM-001",
            admission_date="2026-04-01",
        ),
    )
    base.update(over)
    return base


@pytest.mark.parametrize(
    "raw,clean",
    [
        ("98765 43210", "9876543210"),
        ("+91 98765-43210", "+919876543210"),
        ("(011) 2345-6789", "01123456789"),
    ],
)
def test_phone_normalisation(raw, clean):
    assert normalize_phone(raw) == clean


@pytest.mark.parametrize("bad", ["12345", "98765abcde", "+", "1" * 16])
def test_bad_phones_rejected(bad):
    with pytest.raises(ValueError):
        normalize_phone(bad)


def test_valid_student():
    s = StudentCreate(**payload(full_name="  Aarav   Sharma ", mother_name="  "))
    assert s.full_name == "Aarav Sharma" and s.mother_name is None


def test_one_parent_name_is_enough_but_required():
    StudentCreate(**payload(father_name=None, mother_name="Meera"))
    with pytest.raises(ValidationError, match="father's or the mother's"):
        StudentCreate(**payload(father_name="", mother_name=None))


@pytest.mark.parametrize(
    "dob,msg",
    [
        ((date.today() + timedelta(days=1)).isoformat(), "future"),
        ((date.today() - timedelta(days=100)).isoformat(), "at least 1 year"),
        ("1980-01-01", "over 30"),
    ],
)
def test_date_of_birth_bounds(dob, msg):
    with pytest.raises(ValidationError, match=msg):
        StudentCreate(**payload(date_of_birth=dob))


@pytest.mark.parametrize("alt", ["98765-43210", "+91 98765 43210", "919876543210"])
def test_alternate_mobile_must_differ_even_with_country_code(alt):
    with pytest.raises(ValidationError, match="same as the mobile"):
        StudentCreate(**payload(alternate_mobile=alt))


def test_admission_number_trimmed_and_bounded():
    s = StudentCreate(**payload(enrollment={**payload()["enrollment"], "admission_number": "  ADM   7 "}))
    assert s.enrollment.admission_number == "ADM 7"
    with pytest.raises(ValidationError):
        StudentCreate(**payload(enrollment={**payload()["enrollment"], "admission_number": "x" * 31}))


def test_unknown_fields_rejected():
    with pytest.raises(ValidationError):
        StudentCreate(**payload(student_code="STU00001"))
    with pytest.raises(ValidationError):
        StudentUpdate.model_validate({"school_id": str(U())})
    with pytest.raises(ValidationError):
        StudentUpdate.model_validate({"photo_path": "x"})


def test_update_allows_clearing_optional_fields_only():
    u = StudentUpdate.model_validate({"mother_name": None, "address": None, "alternate_mobile": None})
    assert u.model_fields_set == {"mother_name", "address", "alternate_mobile"}
    with pytest.raises(ValidationError):
        StudentUpdate.model_validate({"mobile": None})


def test_class_and_section_change_together():
    with pytest.raises(ValidationError, match="together"):
        EnrollmentUpdate.model_validate({"section_id": str(U())})
    EnrollmentUpdate.model_validate({"section_id": str(U()), "class_id": str(U())})


def test_status_reason_trimmed():
    assert StatusUpdate(status="inactive", reason="  Transferred   to Pune ").reason == "Transferred to Pune"


# ---------- photos ----------
def _img(fmt, size=(800, 1000), mode="RGB"):
    buf = io.BytesIO()
    Image.new(mode, size, (200, 30, 30) if mode == "RGB" else (200, 30, 30, 0)).save(buf, fmt)
    return buf.getvalue()


def test_photo_becomes_bounded_jpeg():
    out = Image.open(io.BytesIO(process_photo(_img("PNG"))))
    assert out.format == "JPEG" and max(out.size) == 600


def test_transparent_photo_flattened_on_white():
    out = Image.open(io.BytesIO(process_photo(_img("PNG", (100, 100), "RGBA"))))
    assert out.mode == "RGB" and out.getpixel((50, 50)) == (255, 255, 255)


def test_photo_gps_metadata_stripped():
    buf = io.BytesIO()
    exif = Image.Exif()
    exif[0x8825] = {1: "N", 2: (28.0, 36.0, 0.0)}  # GPS block
    exif[0x010F] = "PhoneMaker"
    Image.new("RGB", (200, 200)).save(buf, "JPEG", exif=exif)
    out = process_photo(buf.getvalue())
    assert b"PhoneMaker" not in out
    assert not Image.open(io.BytesIO(out)).getexif()


@pytest.mark.parametrize("data", [b"", b"GIF89a" + b"\x00" * 40, b"<svg/>", _img("PNG", (40, 40))])
def test_bad_photos_rejected(data):
    with pytest.raises(PhotoError):
        process_photo(data)


def test_phone_search_only_for_phone_like_terms():
    from app.services.academics import phone_digits

    assert phone_digits("98765 43210") == "9876543210"
    assert phone_digits("+91-98765") == "9198765"
    assert phone_digits("(011) 2345") == "0112345"
    assert phone_digits("NERI0-001") is None  # admission numbers are not phone searches
    assert phone_digits("ADM-2024-001") is None
    assert phone_digits("123") is None  # too short to be meaningful
