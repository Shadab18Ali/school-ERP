"""PDFs print names and addresses in India's scripts (Phase 34). Before, every PDF used DejaVu Sans,
which has no Devanagari, Bengali, Tamil… glyphs: a student named आरव शर्मा printed as empty boxes on
receipts, certificates, ID cards and report cards."""

import dataclasses
import io

import pytest
import uharfbuzz as hb
from fontTools.ttLib import TTFont as FtFont
from pypdf import PdfReader

from app.services import pdf_fonts
from app.services.receipts import build_receipt_pdf
from tests.test_receipts import _receipt

SAMPLES = {
    "Hindi": "आरव शर्मा क्षितिज त्रिपाठी",
    "Marathi": "श्रेया देशपांडे",
    "Bengali": "অর্পিতা বন্দ্যোপাধ্যায়",
    "Punjabi": "ਗੁਰਪ੍ਰੀਤ ਸਿੰਘ",
    "Gujarati": "વિદ્યાર્થી પટેલ",
    "Odia": "ଓଡ଼ିଆ ଶିକ୍ଷା",
    "Tamil": "தமிழ்செல்வி கிருஷ்ணன்",
    "Telugu": "తెలుగు విద్యార్థి",
    "Kannada": "ಕನ್ನಡ ವಿದ್ಯಾರ್ಥಿ",
    "Malayalam": "മലയാളം വിദ്യാർത്ഥി",
}
FONTS = [pdf_fonts.FONT_DIR / "ErpSans-Regular.ttf", pdf_fonts.FONT_DIR / "ErpSans-Bold.ttf"]


@pytest.mark.parametrize("path", FONTS, ids=["regular", "bold"])
@pytest.mark.parametrize("lang", SAMPLES)
def test_every_letter_has_a_glyph(path, lang):
    cmap = FtFont(path).getBestCmap()
    missing = {ch for ch in SAMPLES[lang] if ch != " " and ord(ch) not in cmap}
    assert not missing, f"{lang}: no glyph for {missing}"
    assert ord("₹") in cmap


def _shape(path, text):
    font = hb.Font(hb.Face(hb.Blob.from_file_path(str(path))))
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf)
    return buf.glyph_infos


@pytest.mark.parametrize("path", FONTS, ids=["regular", "bold"])
def test_conjuncts_are_formed(path):
    # क्ष (ka + virama + ssa) is one conjunct glyph, not ka-with-virama followed by ssa
    assert len(_shape(path, "क्ष")) == 1
    # the i-sign is drawn before the consonant it follows in memory
    assert len(_shape(path, "कि")) == 2
    assert len(_shape(path, "க்ஷ")) <= 2  # Tamil ksha


@pytest.mark.parametrize("path", FONTS, ids=["regular", "bold"])
def test_latin_is_drawn_as_typed(path):
    # no fi/st ligatures and no kerning: Latin text in a PDF stays copyable and searchable
    for word in ("office", "first", "Teacher", "AVATAR"):
        glyphs = _shape(path, word)
        assert len(glyphs) == len(word)
    pdf_fonts.install()
    assert pdf_fonts.text_width("Teacher", "ErpSans", 10) == pytest.approx(
        pdf_fonts.pdfmetrics.stringWidth("Teacher", "ErpSans", 10)
    )


def test_shaping_only_for_the_indian_scripts():
    assert pdf_fonts.needs_shaping("आरव") and pdf_fonts.needs_shaping("Name: தமிழ்")
    assert not pdf_fonts.needs_shaping("Aarav Sharma ₹1,500.00 — Class 5")
    assert not pdf_fonts.needs_shaping(None)
    pdf_fonts.install()
    # the shaped width (conjuncts) is narrower than the letters side by side
    assert pdf_fonts.text_width("क्षत्रिय", "ErpSans", 10) < pdf_fonts.pdfmetrics.stringWidth("क्षत्रिय", "ErpSans", 10)


def test_a_receipt_for_a_hindi_name_uses_the_indian_fonts():
    r = dataclasses.replace(
        _receipt(), student_name="आरव शर्मा", parent_name="श्री राजेश शर्मा", school_name="सरस्वती विद्या मंदिर"
    )
    pdf = build_receipt_pdf(r)
    reader = PdfReader(io.BytesIO(pdf))
    fonts = set()
    for page in reader.pages:
        for f in page["/Resources"]["/Font"].values():
            fonts.add(str(f.get_object()["/BaseFont"]))
    # (ReportLab lists Helvetica, its starting font, on every page; nothing is written in it)
    assert {f.split("+")[-1] for f in fonts} - {"/Helvetica"} == {"ErpSans-Regular", "ErpSans-Bold"}, fonts
    text = reader.pages[0].extract_text()
    assert "Tuition Fee" in text and "₹3,500.00" in text


def test_short_text_the_shaper_does_not_change_still_draws():
    # an ID card prints the holder's initials ("आत"): HarfBuzz changes nothing in such text, and ReportLab
    # then hands back a plain string — the drawing code must still work (this was a 500 on Print cards)
    from reportlab.pdfgen import canvas

    pdf_fonts.install()
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    c.setFont("ErpSans-Bold", 14)
    for t in ("आत", "क", "आरव क्षितिज", "த"):
        c.drawCentredString(100, 100, t)
        c.drawRightString(100, 120, t)
        assert pdf_fonts.text_width(t, "ErpSans-Bold", 14) > 0
    c.save()
    assert buf.getvalue().startswith(b"%PDF")


def _fonts_of(pdf: bytes) -> set[str]:
    out = set()
    for page in PdfReader(io.BytesIO(pdf)).pages:
        for f in page["/Resources"]["/Font"].values():
            out.add(str(f.get_object()["/BaseFont"]).split("+")[-1])
    # ReportLab lists Helvetica (each page's starting font) and Times-Roman (the QR drawing's default)
    # without writing any text in them
    return out - {"/Helvetica", "/Times-Roman"}


def test_id_cards_and_certificates_for_names_in_indian_scripts():
    from app.services.certificate_pdf import build_certificate_pdf
    from app.services.id_card_pdf import CardSheet, build_id_cards_pdf
    from tests.test_documents_phase27 import SchoolInfo, cert_doc, face

    names = list(SAMPLES.values())
    cards = CardSheet(
        school=SchoolInfo(name="सरस्वती शिशु मंदिर उच्चतर माध्यमिक विद्यालय", address="विवेकानंद नगर, लखनऊ"),
        cards=[
            face(i, name=n, rows=[("पिता", "श्री राजेश कुमार त्रिपाठी"), ("DOB", "5 May 2015")])
            for i, n in enumerate(names)
        ],
    )
    pdf = build_id_cards_pdf(cards, back=True)
    assert len(PdfReader(io.BytesIO(pdf)).pages) == 4  # 10 cards: two sheets, fronts and backs
    assert _fonts_of(pdf) <= {"ErpSans-Regular", "ErpSans-Bold"}
    body = (
        "यह प्रमाणित किया जाता है कि आरव क्षितिज त्रिपाठी, पुत्र श्री राजेश कुमार त्रिपाठी, इस विद्यालय का नियमित छात्र है।\n\n" * 8
    )
    pdf = build_certificate_pdf(
        cert_doc(body=body, title="बोनाफ़ाइड प्रमाणपत्र", place="लखनऊ", signatory_name="डॉ. मीरा अय्यर")
    )
    assert len(PdfReader(io.BytesIO(pdf)).pages) == 1  # long Hindi wording still fits the page
    assert _fonts_of(pdf) <= {"ErpSans-Regular", "ErpSans-Bold"}, _fonts_of(pdf)
