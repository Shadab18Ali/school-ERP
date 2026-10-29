import io
from datetime import date

import pytest
from PIL import Image
from pydantic import ValidationError

from app.schemas.school import SchoolCreate, SchoolUpdate
from app.schemas.session import SessionCreate, SessionDelete, SessionUpdate
from app.services.images import LogoError, process_logo


def _img(fmt: str, size=(300, 200), mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, (20, 120, 80)).save(buf, fmt)
    return buf.getvalue()


# ---------- logo processing ----------
@pytest.mark.parametrize("fmt", ["PNG", "JPEG", "WEBP"])
def test_logo_formats_are_reencoded_to_png(fmt):
    out = process_logo(_img(fmt))
    img = Image.open(io.BytesIO(out))
    assert img.format == "PNG" and img.size == (300, 200)


def test_large_logo_is_downscaled_to_512():
    img = Image.open(io.BytesIO(process_logo(_img("PNG", (2000, 1000)))))
    assert max(img.size) == 512


def test_exif_metadata_is_stripped():
    buf = io.BytesIO()
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraMaker"
    Image.new("RGB", (100, 100)).save(buf, "JPEG", exif=exif)
    assert b"SecretCameraMaker" in buf.getvalue()
    assert b"SecretCameraMaker" not in process_logo(buf.getvalue())


@pytest.mark.parametrize(
    "data,msg",
    [
        (b"", "empty"),
        (b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "valid"),
        (b"%PDF-1.4 not an image", "valid"),
        (b"GIF89a" + b"\x00" * 50, "valid"),
        (b"\x89PNG\r\n\x1a\n" + b"\x00" * 100, "valid"),  # truncated PNG
        (b"x" * (2 * 1024 * 1024 + 1), "2 MB"),
    ],
)
def test_bad_uploads_are_rejected(data, msg):
    with pytest.raises(LogoError, match=msg):
        process_logo(data)


def test_gif_is_rejected_even_if_valid():
    with pytest.raises(LogoError, match="PNG, JPEG or WebP"):
        process_logo(_img("GIF"))


def test_tiny_logo_is_rejected():
    with pytest.raises(LogoError, match="at least"):
        process_logo(_img("PNG", (16, 16)))


# ---------- school registration fields ----------
def test_registration_fields_accepted():
    s = SchoolCreate(
        name="Green Valley",
        code="GV",
        udise_code="09060512345",
        established_year=1998,
        affiliation_board="CBSE",
        affiliation_number="2130456",
        postal_code="110025",
    )
    assert s.udise_code == "09060512345"


@pytest.mark.parametrize(
    "field,value",
    [
        ("udise_code", "12345"),
        ("udise_code", "0906051234X"),
        ("established_year", 1700),
        ("established_year", date.today().year + 1),
        ("postal_code", "!!"),
    ],
)
def test_registration_fields_validated(field, value):
    with pytest.raises(ValidationError):
        SchoolCreate(name="Green Valley", code="GV", **{field: value})


def test_blank_registration_fields_become_null():
    assert SchoolUpdate(udise_code="  ", registration_number="").udise_code is None


# ---------- sessions ----------
def test_session_dates_validated():
    SessionCreate(name="2026-27", start_date=date(2026, 4, 1), end_date=date(2027, 3, 31))
    with pytest.raises(ValidationError, match="after the start"):
        SessionCreate(name="2026-27", start_date=date(2026, 4, 1), end_date=date(2026, 4, 1))
    with pytest.raises(ValidationError, match="two years"):
        SessionCreate(name="Long", start_date=date(2026, 1, 1), end_date=date(2029, 1, 1))


def test_session_update_rejects_nulls_and_unknown_fields():
    with pytest.raises(ValidationError):
        SessionUpdate.model_validate({"name": None})
    with pytest.raises(ValidationError):
        SessionUpdate.model_validate({"is_current": True})


def test_delete_requires_confirmation_name():
    with pytest.raises(ValidationError):
        SessionDelete.model_validate({})
