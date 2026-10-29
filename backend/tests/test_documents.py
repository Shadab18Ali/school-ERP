import io

import pytest
from PIL import Image
from pypdf import PdfWriter

from app.core.permissions import ROLE_PERMISSIONS, Permission
from app.services.documents import DocumentError, clean_document, content_disposition, safe_filename, sniff


def pdf(js: str | None = None, password: str | None = None, attachment: bool = False) -> bytes:
    w = PdfWriter()
    w.add_blank_page(width=595, height=842)
    if js:
        w.add_js(js)
    if attachment:
        w.add_attachment("payload.txt", b"hello")
    if password:
        w.encrypt(password)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


def image(fmt: str, size=(1200, 1600)) -> bytes:
    buf = io.BytesIO()
    exif = Image.Exif()
    exif[0x010F] = "SecretPhoneMaker"
    Image.new("RGB", size, (240, 240, 240)).save(buf, fmt, **({"exif": exif} if fmt == "JPEG" else {}))
    return buf.getvalue()


def test_plain_pdf_is_kept_byte_for_byte():
    data = pdf()
    out = clean_document(data)
    assert out.mime_type == "application/pdf" and out.extension == "pdf" and out.data == data


@pytest.mark.parametrize(
    "data,msg",
    [
        (pdf(js="app.alert('hi')"), "scripts or embedded files"),
        (pdf(attachment=True), "scripts or embedded files"),
        (pdf(password="secret"), "Password-protected"),
        (pdf()[:200], "damaged"),
    ],
)
def test_risky_or_broken_pdfs_rejected(data, msg):
    with pytest.raises(DocumentError, match=msg):
        clean_document(data)


def test_escaped_script_names_are_still_caught():
    data = pdf().replace(b"%%EOF", b"% /J#61vaScript\n%%EOF")
    with pytest.raises(DocumentError, match="scripts"):
        clean_document(data)


def test_jpeg_reencoded_and_metadata_stripped():
    data = image("JPEG")
    assert b"SecretPhoneMaker" in data
    out = clean_document(data)
    assert out.mime_type == "image/jpeg" and b"SecretPhoneMaker" not in out.data


def test_png_stays_png_webp_becomes_jpeg():
    assert clean_document(image("PNG")).mime_type == "image/png"
    assert clean_document(image("WEBP")).mime_type == "image/jpeg"


def test_huge_scan_is_downscaled():
    out = clean_document(image("PNG", (5000, 3000)))
    assert max(Image.open(io.BytesIO(out.data)).size) == 4000


@pytest.mark.parametrize(
    "data,msg",
    [
        (b"", "empty"),
        (b"MZ\x90\x00 windows executable", "PDF, JPEG, PNG or WebP"),
        (b"<html><script>alert(1)</script></html>", "PDF, JPEG, PNG or WebP"),
        (b"%PDF" + b"x" * (10 * 1024 * 1024), "10 MB"),
        (b"\x89PNG\r\n\x1a\n" + b"\x00" * 50, "valid"),
    ],
)
def test_bad_files_rejected(data, msg):
    with pytest.raises(DocumentError, match=msg):
        clean_document(data)


def test_tiny_image_rejected():
    with pytest.raises(DocumentError, match="at least"):
        clean_document(image("PNG", (50, 50)))


def test_type_comes_from_bytes_not_name():
    assert sniff(pdf()) == "application/pdf"
    assert sniff(b"GIF89a....") is None


@pytest.mark.parametrize(
    "name,ext,expected",
    [
        ("Birth Certificate.PDF", "pdf", "Birth Certificate.pdf"),
        ("../../etc/passwd", "pdf", "passwd.pdf"),
        ("C:\\Users\\x\\tc scan.jpeg", "jpg", "tc scan.jpg"),
        ('re<po>rt:"1"|?*.pdf', "pdf", "re po rt 1.pdf"),
        ("photo.exe", "png", "photo.png"),
        ("", "pdf", "document.pdf"),
        ("जन्म प्रमाण पत्र.pdf", "pdf", "जन्म प्रमाण पत्र.pdf"),
    ],
)
def test_safe_filename(name, ext, expected):
    assert safe_filename(name, ext) == expected


def test_content_disposition_handles_unicode():
    h = content_disposition("attachment", "जन्म प्रमाण.pdf")
    assert h.startswith('attachment; filename="document.pdf"')
    assert "filename*=UTF-8''%E0%A4" in h


def test_only_school_admins_get_document_permissions():
    for role, perms in ROLE_PERMISSIONS.items():
        has = {Permission.DOCUMENTS_VIEW, Permission.DOCUMENTS_MANAGE} & perms
        assert bool(has) == (role == "school_admin"), role


def test_content_disposition_keeps_ascii_names():
    assert content_disposition("inline", "TC 2025.pdf").startswith('inline; filename="TC 2025.pdf"')
    assert content_disposition("inline", "Résumé.pdf").startswith('inline; filename="Resume.pdf"')
