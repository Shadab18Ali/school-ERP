"""Printable ID cards: standard CR80 size (85.6 × 54 mm), portrait.

Cards are laid out nine to an A4 sheet (3 × 3) with crop marks for cutting. With
`back=True` every sheet of fronts is followed by a sheet of backs, mirrored left to
right so they line up when printed double-sided (flip on the long edge).
The data comes from the school's records; the QR code opens the public
verification page, which shows whether the card is still valid.
"""

import io
from dataclasses import dataclass, field
from datetime import date

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

from app.services.certificate_pdf import (
    INK,
    MUTED,
    clip_text,
    draw_image,
    draw_qr,
    fit_font,
    hex_color,
    watermark,
)
from app.services.pdf_fonts import text_width as stringWidth
from app.services.receipts import _fonts
from app.services.report_card_pdf import SchoolInfo

CARD_W, CARD_H = 54 * mm, 85.6 * mm
COLS, ROWS = 3, 3
GAP = 6 * mm
KIND_LABEL = {"student": "STUDENT", "teacher": "TEACHER", "staff": "STAFF"}


@dataclass
class CardFace:
    kind: str  # student | teacher | staff
    number: str
    name: str
    line: str | None  # class – section, or designation
    rows: list[tuple[str, str]]  # small label/value lines (father, date of birth, phone ...)
    verify_url: str
    valid_until: date
    photo: bytes | None = None
    status: str = "active"  # active | replaced | revoked (old cards print as NOT VALID)
    emergency: str | None = None  # contact printed on the back


@dataclass
class CardSheet:
    school: SchoolInfo
    accent: str = "#2f6b57"
    signatory_title: str = "Principal"
    signature_png: bytes | None = None
    back_note: str | None = None
    cards: list[CardFace] = field(default_factory=list)


def _initials(name: str) -> str:
    parts = [p for p in name.split() if p[:1].isalpha() and not p.endswith(".")]  # skip Dr. / Mr.
    return ((parts[0][0] if parts else "") + (parts[-1][0] if len(parts) > 1 else "")).upper() or "?"


def _origin(i: int, mirror: bool) -> tuple[float, float]:
    W, H = A4
    col, row = i % COLS, i // COLS
    if mirror:
        col = COLS - 1 - col
    left = (W - (COLS * CARD_W + (COLS - 1) * GAP)) / 2
    top = H - (H - (ROWS * CARD_H + (ROWS - 1) * GAP)) / 2
    return left + col * (CARD_W + GAP), top - (row + 1) * CARD_H - row * GAP


def _crop_marks(c: canvas.Canvas, x: float, y: float) -> None:
    c.setStrokeColor(colors.HexColor("#9aa5a1"))
    c.setLineWidth(0.3)
    m, off = 2.5 * mm, 0.8 * mm
    for cx, sx in ((x, -1), (x + CARD_W, 1)):
        for cy, sy in ((y, -1), (y + CARD_H, 1)):
            c.line(cx + sx * off, cy, cx + sx * (off + m), cy)
            c.line(cx, cy + sy * off, cx, cy + sy * (off + m))


def _rounded_clip(c: canvas.Canvas, x: float, y: float) -> None:
    p = c.beginPath()
    p.roundRect(x, y, CARD_W, CARD_H, 3 * mm)
    c.clipPath(p, stroke=0, fill=0)


def _front(c: canvas.Canvas, s: CardSheet, f: CardFace, x: float, y: float) -> None:
    regular, bold = _fonts()
    accent = hex_color(s.accent)
    c.saveState()
    _rounded_clip(c, x, y)
    c.setFillColor(colors.white)
    c.rect(x, y, CARD_W, CARD_H, stroke=0, fill=1)

    # header band: logo, school name, card type
    band = 17 * mm
    c.setFillColor(accent)
    c.rect(x, y + CARD_H - band, CARD_W, band, stroke=0, fill=1)
    pad = 2.5 * mm
    logo = 10 * mm
    lx, ly = x + pad, y + CARD_H - pad - logo
    has_logo = False
    if s.school.logo_png:
        c.setFillColor(colors.white)
        c.circle(lx + logo / 2, ly + logo / 2, logo / 2 + 0.6 * mm, stroke=0, fill=1)
        has_logo = draw_image(c, s.school.logo_png, lx + 1 * mm, ly + 1 * mm, logo - 2 * mm, logo - 2 * mm)
    tx = lx + (logo + 2 * mm if has_logo else 0)
    tw = x + CARD_W - pad - tx
    name = s.school.name.upper()
    size = fit_font(name, bold, 8.5, 5.5, tw)
    c.setFillColor(colors.white)
    if size <= 5.5 and len(name.split()) > 1:  # long name: two lines
        words = name.split()
        half = len(words) // 2
        l1, l2 = " ".join(words[:half]), " ".join(words[half:])
        size = min(fit_font(l1, bold, 7.5, 5, tw), fit_font(l2, bold, 7.5, 5, tw))
        c.setFont(bold, size)
        c.drawString(tx, ly + logo - size, clip_text(l1, bold, size, tw))
        c.drawString(tx, ly + logo - 2 * size - 1, clip_text(l2, bold, size, tw))
    else:
        c.setFont(bold, size)
        c.drawString(tx, ly + logo / 2 + 1, name)
    c.setFont(bold, 6)
    label = KIND_LABEL.get(f.kind, f.kind.upper()) + " IDENTITY CARD"
    c.drawCentredString(x + CARD_W / 2, y + CARD_H - band + 2 * mm, label)

    # photo
    pw, ph = 20 * mm, 24 * mm
    px, py = x + (CARD_W - pw) / 2, y + CARD_H - band - 2.5 * mm - ph
    if not draw_image(c, f.photo, px, py, pw, ph, crop=True):
        c.setFillColor(colors.HexColor("#e8eeeb"))
        c.rect(px, py, pw, ph, stroke=0, fill=1)
        c.setFillColor(accent)
        c.setFont(bold, 16)
        c.drawCentredString(px + pw / 2, py + ph / 2 - 6, _initials(f.name))
    c.setStrokeColor(accent)
    c.setLineWidth(0.8)
    c.rect(px, py, pw, ph, stroke=1, fill=0)

    # name and class / post
    cy = py - 4.6 * mm
    c.setFillColor(INK)
    size = fit_font(f.name, bold, 9.5, 6.5, CARD_W - 2 * pad)
    c.setFont(bold, size)
    c.drawCentredString(x + CARD_W / 2, cy, clip_text(f.name, bold, size, CARD_W - 2 * pad))
    if f.line:
        cy -= 3.6 * mm
        c.setFillColor(accent)
        c.setFont(bold, 7)
        c.drawCentredString(x + CARD_W / 2, cy, clip_text(f.line, bold, 7, CARD_W - 2 * pad))

    # details
    cy -= 4.4 * mm
    rows = [("ID No.", f.number), *f.rows]
    label_w = 11 * mm
    floor = y + 18.5 * mm  # keep clear of the QR code
    for k, v in rows:
        if cy < floor:
            break
        c.setFillColor(MUTED)
        c.setFont(regular, 6)
        c.drawString(x + pad, cy, k)
        c.setFillColor(INK)
        c.setFont(bold if k == "ID No." else regular, 6.3)
        c.drawString(x + pad + label_w, cy, clip_text(v, regular, 6.3, CARD_W - 2 * pad - label_w))
        cy -= 2.7 * mm

    # QR (left) and signature (right), above the footer strip
    strip = 5 * mm
    q = 11.5 * mm
    draw_qr(c, f.verify_url, x + pad - 1 * mm, y + strip + 0.5 * mm, q)
    sw, sh = 20 * mm, 6.5 * mm
    sx, sy = x + CARD_W - pad - sw, y + strip + 4.2 * mm
    draw_image(c, s.signature_png, sx, sy, sw, sh)
    c.setStrokeColor(INK)
    c.setLineWidth(0.3)
    c.line(sx, sy, sx + sw, sy)
    c.setFillColor(MUTED)
    c.setFont(regular, 5.5)
    c.drawCentredString(sx + sw / 2, sy - 2.3 * mm, clip_text(s.signatory_title, regular, 5.5, sw + 2 * mm))

    c.setFillColor(accent)
    c.rect(x, y, CARD_W, strip, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont(bold, 6)
    c.drawCentredString(x + CARD_W / 2, y + 1.8 * mm, f"Valid until {f.valid_until.day} {f.valid_until:%b %Y}")

    if f.status != "active":
        watermark(c, "NOT VALID", x + CARD_W / 2, y + CARD_H / 2, 15, angle=60)
    c.restoreState()
    c.setStrokeColor(colors.HexColor("#c9d1cd"))
    c.setLineWidth(0.3)
    c.roundRect(x, y, CARD_W, CARD_H, 3 * mm, stroke=1, fill=0)


def _back(c: canvas.Canvas, s: CardSheet, f: CardFace, x: float, y: float) -> None:
    regular, bold = _fonts()
    accent = hex_color(s.accent)
    pad = 4 * mm
    w = CARD_W - 2 * pad
    c.saveState()
    _rounded_clip(c, x, y)
    c.setFillColor(accent)
    c.rect(x, y + CARD_H - 4 * mm, CARD_W, 4 * mm, stroke=0, fill=1)
    c.rect(x, y, CARD_W, 4 * mm, stroke=0, fill=1)

    cy = y + CARD_H - 12 * mm
    c.setFillColor(INK)
    c.setFont(bold, 7.5)
    c.drawCentredString(x + CARD_W / 2, cy, "If found, please return to")
    cy -= 5.5 * mm
    size = fit_font(s.school.name, bold, 8.5, 5.5, w)
    c.setFont(bold, size)
    c.setFillColor(accent)
    c.drawCentredString(x + CARD_W / 2, cy, clip_text(s.school.name, bold, size, w))
    c.setFillColor(INK)
    c.setFont(regular, 6.3)
    lines = [ln for part in (s.school.address, s.school.contact) if part for ln in _wrap(part, regular, 6.3, w)]
    for line in lines[:6]:
        cy -= 3.3 * mm
        c.drawCentredString(x + CARD_W / 2, cy, line)
    if f.emergency:
        cy -= 6 * mm
        c.setFont(bold, 6.5)
        c.drawCentredString(x + CARD_W / 2, cy, "Emergency contact")
        cy -= 3.3 * mm
        c.setFont(regular, 6.5)
        c.drawCentredString(x + CARD_W / 2, cy, clip_text(f.emergency, regular, 6.5, w))
    if s.back_note:
        cy -= 5 * mm
        c.setFillColor(MUTED)
        c.setFont(regular, 6)
        for line in _wrap(s.back_note, regular, 6, w)[:7]:
            cy -= 3 * mm
            c.drawCentredString(x + CARD_W / 2, cy, line)
    c.setFillColor(MUTED)
    c.setFont(regular, 5.5)
    c.drawCentredString(x + CARD_W / 2, y + 7 * mm, "Scan the QR code on the front to check this card.")
    c.restoreState()
    c.setStrokeColor(colors.HexColor("#c9d1cd"))
    c.setLineWidth(0.3)
    c.roundRect(x, y, CARD_W, CARD_H, 3 * mm, stroke=1, fill=0)


def _wrap(text: str, font: str, size: float, width: float) -> list[str]:
    lines, cur = [], ""
    for word in text.split():
        nxt = f"{cur} {word}".strip()
        if stringWidth(nxt, font, size) <= width or not cur:
            cur = nxt
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return [clip_text(ln, font, size, width) for ln in lines]


def build_id_cards_pdf(sheet: CardSheet, back: bool = False) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(f"ID cards – {sheet.school.name}")
    c.setAuthor(sheet.school.name)
    per = COLS * ROWS
    for start in range(0, len(sheet.cards), per):
        chunk = sheet.cards[start : start + per]
        for i, f in enumerate(chunk):
            x, y = _origin(i, mirror=False)
            _crop_marks(c, x, y)
            _front(c, sheet, f, x, y)
        c.showPage()
        if back:
            for i, f in enumerate(chunk):
                x, y = _origin(i, mirror=True)
                _crop_marks(c, x, y)
                _back(c, sheet, f, x, y)
            c.showPage()
    c.save()
    return buf.getvalue()
