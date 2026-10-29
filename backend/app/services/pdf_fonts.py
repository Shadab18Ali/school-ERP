"""Fonts for every PDF the ERP makes (receipts, certificates, ID cards, report cards, payslips,
invoices, timetables, exports).

ErpSans is DejaVu Sans (Latin, ₹, symbols) with the Noto Sans fonts for India's scripts merged in:
Devanagari (Hindi, Marathi, Sanskrit, Nepali), Bengali/Assamese, Gurmukhi, Gujarati, Oriya, Tamil,
Telugu, Kannada and Malayalam (built by scripts/build_pdf_fonts.py). These scripts also need
*shaping* — conjuncts, vowel signs placed before a consonant, reph — which ReportLab does with
HarfBuzz (uharfbuzz):

* paragraphs and table text: every ParagraphStyle shapes;
* text drawn straight on the page (certificates, ID cards, table cells): ReportLab only shapes
  that when its optional bidi module is installed, so `install()` makes drawString and its centred
  and right-aligned forms shape any text that contains one of these scripts. Latin-only text is
  drawn exactly as before.

Urdu and other right-to-left scripts are not supported (they print as empty boxes).
"""

import re
from pathlib import Path

from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as rl_canvas

FONT_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"
REGULAR, BOLD = "ErpSans", "ErpSans-Bold"
# Devanagari … Malayalam, plus the joiners and Vedic signs used with them
_INDIC = re.compile("[ऀ-ൿ᳐-᳿꣠-ꣿ]")
_installed = False

try:
    import uharfbuzz  # noqa: F401  (ReportLab shapes with it)
    from reportlab.pdfbase.ttfonts import shapeStr

    SHAPING = True
except ImportError:  # pragma: no cover - the requirements include uharfbuzz
    SHAPING = False


def needs_shaping(text: object) -> bool:
    return SHAPING and isinstance(text, str) and _INDIC.search(text) is not None


def text_width(text: str, font: str, size: float) -> float:
    """The width the text will take on the page (shaped, for the Indian scripts)."""
    if needs_shaping(text) and pdfmetrics.getFont(font).shapable:
        s = shapeStr(text, font, size, force=True)
        return sum(g.x_advance for g in s.__shapeData__) * size / 1000
    return pdfmetrics.stringWidth(text, font, size)


def _draw(c: rl_canvas.Canvas, x: float, y: float, text: str, anchor: str) -> None:
    font, size = c._fontname, c._fontsize
    s = shapeStr(text, font, size, force=True)
    width = sum(g.x_advance for g in s.__shapeData__) * size / 1000
    t = c.beginText(x - (width if anchor == "end" else width / 2 if anchor == "middle" else 0), y)
    t.setFont(font, size, c._leading)
    t.textOut(s)
    c.drawText(t)


def install() -> tuple[str, str]:
    """Registers the fonts (once) and turns shaping on. Returns (regular, bold) font names."""
    global _installed
    if _installed:
        return REGULAR, BOLD
    pdfmetrics.registerFont(TTFont(REGULAR, str(FONT_DIR / "ErpSans-Regular.ttf")))
    pdfmetrics.registerFont(TTFont(BOLD, str(FONT_DIR / "ErpSans-Bold.ttf")))
    pdfmetrics.registerFontFamily(REGULAR, normal=REGULAR, bold=BOLD, italic=REGULAR, boldItalic=BOLD)
    if SHAPING:
        ParagraphStyle.defaults["shaping"] = 1
        Canvas = rl_canvas.Canvas
        originals = {
            "drawString": Canvas.drawString,
            "drawCentredString": Canvas.drawCentredString,
            "drawRightString": Canvas.drawRightString,
        }
        anchors = {"drawString": "start", "drawCentredString": "middle", "drawRightString": "end"}

        def wrap(name):  # type: ignore[no-untyped-def]
            original = originals[name]

            def draw(self, x, y, text, *args, **kwargs):  # type: ignore[no-untyped-def]
                if (
                    needs_shaping(text)
                    and pdfmetrics.getFont(self._fontname).shapable
                    and not args
                    and not kwargs.get("charSpace")
                ):
                    return _draw(self, x, y, text, anchors[name])
                return original(self, x, y, text, *args, **kwargs)

            draw.__wrapped__ = original  # type: ignore[attr-defined]
            return draw

        for name in originals:
            if not hasattr(getattr(Canvas, name), "__wrapped__"):
                setattr(Canvas, name, wrap(name))
    _installed = True
    return REGULAR, BOLD
