"""Phase 27: certificates, ID cards and public verification (no database needed)."""

import io
import re
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError
from pypdf import PdfReader

from app.api.v1.routes import certificates as cert_routes
from app.api.v1.routes.certificates import (
    DEFAULT_TEMPLATES,
    PLACEHOLDERS,
    IssueIn,
    SettingsIn,
    TemplateIn,
    TemplateUpdate,
)
from app.api.v1.routes.id_cards import PrintIn
from app.main import app as main_app
from app.schemas.teachers import TeacherCreate, TeacherUpdate
from app.services import certificate_pdf, id_card_pdf
from app.services.certificate_pdf import CertificateDoc, build_certificate_pdf
from app.services.id_card_pdf import CardFace, CardSheet, build_id_cards_pdf
from app.services.report_card_pdf import SchoolInfo

MIGRATION = Path(__file__).resolve().parents[2] / "supabase" / "migrations" / "0026_documents.sql"
URL = "http://localhost:3000/verify/0123456789abcdef0123456789abcdef"


def text_of(pdf: bytes) -> str:
    return "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages)


def png(color: str = "#336699", size=(120, 160)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


# ---------------------------------------------------------------- placeholders and templates
def test_placeholder_list_matches_the_database():
    sql = MIGRATION.read_text()
    block = re.search(r"function private\.certificate_placeholders\(\).*?array\[(.*?)\]::text\[\]", sql, re.S).group(1)
    in_db = re.findall(r"'([a-z_]+)'", block)
    assert [k for k, _ in PLACEHOLDERS] == in_db


@pytest.mark.parametrize("t", DEFAULT_TEMPLATES, ids=lambda t: t["kind"])
def test_starting_templates_use_only_known_placeholders(t):
    known = {k for k, _ in PLACEHOLDERS} | {f["key"] for f in t["fields"]}
    used = set(re.findall(r"\{\{([a-z_]+)\}\}", t["body"]))
    assert used <= known, used - known
    TemplateIn(**t)  # valid as the API would accept it


def test_starting_templates_cover_every_kind_but_custom():
    assert {t["kind"] for t in DEFAULT_TEMPLATES} == {"bonafide", "character", "transfer", "study"}
    tc = next(t for t in DEFAULT_TEMPLATES if t["kind"] == "transfer")
    assert {f["key"] for f in tc["fields"] if f["required"]} == {"leaving_date", "reason", "conduct"}


def base_template(**kw):
    return {
        "name": "Sports",
        "title": "Sports Certificate",
        "prefix": "sp",
        "body": "Awarded to {{student_name}}.",
        **kw,
    }


def test_template_prefix_is_upper_cased_and_letters_only():
    assert TemplateIn(**base_template()).prefix == "SP"
    with pytest.raises(ValidationError):
        TemplateIn(**base_template(prefix="S1"))
    with pytest.raises(ValidationError):
        TemplateIn(**base_template(prefix="TOOLONG"))


def test_template_extra_fields_are_checked():
    ok = TemplateIn(**base_template(fields=[{"key": "event", "label": "Event", "required": True}]))
    assert ok.fields[0].type == "text"
    with pytest.raises(ValidationError):  # duplicate keys
        TemplateIn(**base_template(fields=[{"key": "event", "label": "Event"}, {"key": "event", "label": "Again"}]))
    with pytest.raises(ValidationError):  # bad key
        TemplateIn(**base_template(fields=[{"key": "Event Name", "label": "Event"}]))
    with pytest.raises(ValidationError):  # too many
        TemplateIn(**base_template(fields=[{"key": f"f{i}x", "label": f"F {i}"} for i in range(13)]))


def test_a_template_kind_cannot_change():
    with pytest.raises(ValidationError):
        TemplateUpdate(**base_template(kind="transfer"))
    assert TemplateUpdate(**base_template()).kind is None


def test_issue_input_is_tidied():
    p = IssueIn(
        template_id="00000000-0000-4000-8000-000000000001",
        student_id="00000000-0000-4000-8000-000000000002",
        purpose="  passport   application ",
        fields={"reason": "  family   moving ", "remarks": "   "},
    )
    assert p.purpose == "passport application"
    assert p.fields == {"reason": "family moving", "remarks": None}
    with pytest.raises(ValidationError):
        IssueIn(template_id=p.template_id, student_id=p.student_id, purpose="x")
    with pytest.raises(ValidationError):  # the browser can't send the student's details
        IssueIn(template_id=p.template_id, student_id=p.student_id, student_name="Someone else")


def test_settings_colour_and_lengths():
    assert SettingsIn(accent_color="#AABBCC").accent_color == "#aabbcc"
    with pytest.raises(ValidationError):
        SettingsIn(accent_color="green")
    with pytest.raises(ValidationError):
        SettingsIn(card_back_note="x" * 201)


def test_print_request_limits_and_dedupes():
    ids = ["00000000-0000-4000-8000-000000000001"] * 3
    assert len(PrintIn(kind="student", ids=ids).ids) == 1
    with pytest.raises(ValidationError):
        PrintIn(kind="student", ids=[])
    with pytest.raises(ValidationError):
        PrintIn(kind="parent", ids=ids)


def test_teacher_staff_type_and_designation():
    t = TeacherCreate(
        full_name="Ravi Kumar", phone="9876543210", email="r@x.in", joining_date=date(2020, 1, 1),
        staff_type="non_teaching", designation="  Office   Clerk ",
    )  # fmt: skip
    assert t.staff_type == "non_teaching" and t.designation == "Office Clerk"
    assert (
        TeacherCreate(full_name="A B", phone="9876543210", email="a@x.in", joining_date=date(2020, 1, 1)).staff_type
        == "teaching"
    )
    with pytest.raises(ValidationError):
        TeacherCreate(
            full_name="A B", phone="9876543210", email="a@x.in", joining_date=date(2020, 1, 1), staff_type="guard"
        )
    with pytest.raises(ValidationError):
        TeacherUpdate(staff_type=None)


# ---------------------------------------------------------------- PDFs
def cert_doc(**kw) -> CertificateDoc:
    d = dict(
        school=SchoolInfo(name="Green Valley School", address="MG Road, Lucknow", logo_png=png()),
        number="BC-2026-0001",
        title="Bonafide Certificate",
        body="This is to certify that Aarav Sharma, son of Rakesh Sharma, is a bonafide student.\n\nFor passport.",
        issued_on=date(2026, 10, 12),
        place="Lucknow",
        signatory_name="Dr. Meera Iyer",
        signatory_title="Principal",
        verify_url=URL,
        signature_png=png("#222222", (300, 90)),
        photo=png(),
        show_photo=True,
    )
    d.update(kw)
    return CertificateDoc(**d)


def test_certificate_pdf_has_the_issued_wording(monkeypatch):
    seen = []
    real = certificate_pdf.draw_qr
    monkeypatch.setattr(certificate_pdf, "draw_qr", lambda c, v, *a: (seen.append(v), real(c, v, *a)))
    pdf = build_certificate_pdf(cert_doc())
    t = text_of(pdf)
    assert len(PdfReader(io.BytesIO(pdf)).pages) == 1
    for s in ("GREEN VALLEY SCHOOL", "BC-2026-0001", "BONAFIDE CERTIFICATE", "Aarav Sharma", "12 October 2026",
              "Dr. Meera Iyer", "Principal", "Place: Lucknow"):  # fmt: skip
        assert s in t, s
    assert "REVOKED" not in t
    assert seen == [URL]  # the QR code opens the verification page


def test_certificate_options_and_revoked_watermark(monkeypatch):
    seen = []
    monkeypatch.setattr(certificate_pdf, "draw_qr", lambda *a: seen.append(a))
    t = text_of(build_certificate_pdf(cert_doc(show_qr=False, show_photo=False, revoked=True, photo=None, place=None)))
    assert seen == [] and "REVOKED" in t and "Scan to verify" not in t and "Place:" not in t


def test_long_wording_still_fits_one_page():
    body = "\n\n".join(["A long paragraph of wording that goes on. " * 20] * 6)
    pdf = build_certificate_pdf(cert_doc(body=body[:5000]))
    assert len(PdfReader(io.BytesIO(pdf)).pages) == 1


def face(i: int, **kw) -> CardFace:
    d = dict(
        kind="student", number=f"S{i:04d}", name=f"Student {i}", line="Class 5 – A",
        rows=[("Father", "Rakesh Sharma"), ("DOB", "5 May 2015"), ("Phone", "+919876543210")],
        verify_url=URL, valid_until=date(2027, 3, 31), emergency="+919876543210",
    )  # fmt: skip
    d.update(kw)
    return CardFace(**d)


def sheet(n: int) -> CardSheet:
    return CardSheet(
        school=SchoolInfo(name="Green Valley School", address="MG Road, Lucknow"), cards=[face(i) for i in range(n)]
    )


def test_id_cards_nine_to_a_sheet_with_optional_backs():
    assert len(PdfReader(io.BytesIO(build_id_cards_pdf(sheet(9)))).pages) == 1
    assert len(PdfReader(io.BytesIO(build_id_cards_pdf(sheet(10)))).pages) == 2
    pdf = build_id_cards_pdf(sheet(10), back=True)
    pages = PdfReader(io.BytesIO(pdf)).pages
    assert len(pages) == 4  # fronts, backs, fronts, backs
    assert "If found, please return to" in pages[1].extract_text()
    assert "S0000" in pages[0].extract_text() and "Valid until 31 Mar 2027" in pages[0].extract_text()


def test_backs_are_mirrored_for_double_sided_printing():
    left_front, _ = id_card_pdf._origin(0, mirror=False)
    right_back, _ = id_card_pdf._origin(0, mirror=True)
    assert right_back == id_card_pdf._origin(2, mirror=False)[0] and right_back > left_front


def test_card_sizes_are_cr80():
    assert round(id_card_pdf.CARD_W / id_card_pdf.mm, 1) == 54.0
    assert round(id_card_pdf.CARD_H / id_card_pdf.mm, 1) == 85.6


def test_old_cards_print_as_not_valid():
    s = sheet(0)
    s.cards = [face(1, status="replaced")]
    assert "NOT VALID" in text_of(build_id_cards_pdf(s))


def test_card_qr_uses_the_verification_url(monkeypatch):
    seen = []
    monkeypatch.setattr(id_card_pdf, "draw_qr", lambda c, v, *a: seen.append(v))
    build_id_cards_pdf(sheet(3))
    assert seen == [URL] * 3


def test_initials_skip_titles():
    assert id_card_pdf._initials("Dr. Meera Iyer") == "MI"
    assert id_card_pdf._initials("Ravi") == "R"


# ---------------------------------------------------------------- public verification
def test_verify_refuses_malformed_codes_without_touching_the_database(monkeypatch):
    def boom():
        raise AssertionError("no database call expected")

    monkeypatch.setattr("app.api.v1.routes.public_verify.anon_session", boom)
    c = TestClient(main_app)
    for bad in ("nope", "0123", "Z" * 32, "0123456789abcdef0123456789abcdeg"):
        r = c.get(f"/api/v1/public/verify/{bad}")
        assert r.status_code == 404 and "isn't genuine" in r.json()["detail"]


def test_verify_url_uses_the_frontend(monkeypatch):
    class S:
        frontend_url = "https://school.example/"

    monkeypatch.setattr(cert_routes, "get_settings", lambda: S())
    assert cert_routes.frontend_verify_url("ab" * 16) == "https://school.example/verify/" + "ab" * 16
