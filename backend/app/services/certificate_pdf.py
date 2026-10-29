"""Printable certificates (A4) and shared drawing helpers for documents.

Everything printed comes from the issued certificate row (its wording was filled
in by the database when it was issued) and the school's records; this module only
lays it out: letterhead with logo, number and date, title, wording, photo, the
signatory with their signature, and a QR code that opens the public verification
page. A revoked certificate is printed with a REVOKED watermark.
"""

import io
from dataclasses import dataclass
from datetime import date
from xml.sax.saxutils import escape

from PIL import Image as PILImage
from reportlab.graphics import renderPDF
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

from app.services.pdf_fonts import text_width as stringWidth
from app.services.receipts import _fonts
from app.services.report_card_pdf import SchoolInfo

INK = colors.HexColor("#1a2321")
MUTED = colors.HexColor("#5d6b67")
LINE = colors.HexColor("#c9d1cd")
RED = colors.HexColor("#b42318")


def hex_color(c: str | None) -> colors.Color:
    try:
        return colors.HexColor(c or "#2f6b57")
    except ValueError:
        return colors.HexColor("#2f6b57")


def long_date(d: date) -> str:
    return f"{d.day} {d:%B %Y}"


def image_reader(data: bytes | None, box: tuple[float, float] | None = None) -> ImageReader | None:
    """An image for the PDF. With `box` (w, h) it is centre-cropped to that shape (photos)."""
    if not data:
        return None
    try:
        img = PILImage.open(io.BytesIO(data))
        img.load()
    except Exception:  # noqa: BLE001 - a damaged image must never break a document
        return None
    if box:
        w, h = img.size
        want = box[0] / box[1]
        if w / h > want:  # too wide: trim the sides
            nw = int(h * want)
            img = img.crop(((w - nw) // 2, 0, (w - nw) // 2 + nw, h))
        else:  # too tall: trim mostly from the bottom (keeps the face)
            nh = int(w / want)
            top = min((h - nh) // 4, h - nh)
            img = img.crop((0, top, w, top + nh))
        if img.mode not in ("RGB", "L"):
            bg = PILImage.new("RGB", img.size, (255, 255, 255))
            bg.paste(img.convert("RGBA"), mask=img.convert("RGBA").split()[-1])
            img = bg
    return ImageReader(img)


def draw_image(
    c: canvas.Canvas, data: bytes | None, x: float, y: float, w: float, h: float, crop: bool = False
) -> bool:
    """Draws an image fitted into the box (bottom-left x, y). False when there is no usable image."""
    r = image_reader(data, (w, h) if crop else None)
    if r is None:
        return False
    if crop:
        c.drawImage(r, x, y, w, h, mask="auto")
    else:
        c.drawImage(r, x, y, w, h, preserveAspectRatio=True, anchor="c", mask="auto")
    return True


def draw_qr(c: canvas.Canvas, value: str, x: float, y: float, size: float) -> None:
    widget = QrCodeWidget(value, barLevel="M")
    b = widget.getBounds()
    w, h = b[2] - b[0], b[3] - b[1]
    d = Drawing(size, size, transform=[size / w, 0, 0, size / h, 0, 0])
    d.add(widget)
    renderPDF.draw(d, c, x, y)


def fit_font(text: str, font: str, max_size: float, min_size: float, width: float) -> float:
    size = max_size
    while size > min_size and stringWidth(text, font, size) > width:
        size -= 0.25
    return size


def clip_text(text: str, font: str, size: float, width: float) -> str:
    if stringWidth(text, font, size) <= width:
        return text
    while text and stringWidth(text + "…", font, size) > width:
        text = text[:-1]
    return text.rstrip() + "…"


def watermark(c: canvas.Canvas, text: str, cx: float, cy: float, size: float, angle: float = 35) -> None:
    _, bold = _fonts()
    c.saveState()
    c.setFillColor(RED)
    c.setFillAlpha(0.18)
    c.translate(cx, cy)
    c.rotate(angle)
    c.setFont(bold, size)
    c.drawCentredString(0, -size / 3, text)
    c.restoreState()


@dataclass
class CertificateDoc:
    school: SchoolInfo
    number: str
    title: str
    body: str
    issued_on: date
    place: str | None
    signatory_name: str | None
    signatory_title: str
    verify_url: str
    accent: str = "#2f6b57"
    signature_png: bytes | None = None
    photo: bytes | None = None
    show_logo: bool = True
    show_photo: bool = False
    show_qr: bool = True
    revoked: bool = False


def _body_html(body: str) -> list[str]:
    """Blank lines separate paragraphs; single line breaks are kept (e.g. the lines of a TC)."""
    paras = [p.strip("\n") for p in body.replace("\r\n", "\n").split("\n\n")]
    return [escape(p).replace("\n", "<br/>") for p in paras if p.strip()]


def _draw_certificate(c: canvas.Canvas, d: CertificateDoc) -> None:
    regular, bold = _fonts()
    W, H = A4
    accent = hex_color(d.accent)
    margin = 14 * mm

    # double border
    c.setStrokeColor(accent)
    c.setLineWidth(2.2)
    c.rect(margin - 5 * mm, margin - 5 * mm, W - 2 * (margin - 5 * mm), H - 2 * (margin - 5 * mm))
    c.setLineWidth(0.6)
    c.rect(margin - 3.5 * mm, margin - 3.5 * mm, W - 2 * (margin - 3.5 * mm), H - 2 * (margin - 3.5 * mm))

    left, right = margin + 6 * mm, W - margin - 6 * mm
    width = right - left
    top = H - margin - 6 * mm

    # letterhead
    logo_w = 24 * mm
    has_logo = d.show_logo and draw_image(c, d.school.logo_png, left, top - logo_w, logo_w, logo_w)
    text_left = left + (logo_w + 4 * mm if has_logo else 0)
    text_right = right - (logo_w + 4 * mm if has_logo else 0)  # keep the name centred on the page
    tw = text_right - text_left
    cx = (text_left + text_right) / 2
    size = fit_font(d.school.name.upper(), bold, 22, 12, tw)
    c.setFillColor(accent)
    c.setFont(bold, size)
    y = top - size
    c.drawCentredString(cx, y, d.school.name.upper())
    c.setFillColor(MUTED)
    for line in (d.school.address, d.school.affiliation, d.school.contact):
        if line:
            y -= 13
            c.setFont(regular, 9.5)
            c.drawCentredString(cx, y, clip_text(line, regular, 9.5, tw))
    y = min(y, top - (logo_w if has_logo else 0)) - 6 * mm
    c.setStrokeColor(accent)
    c.setLineWidth(1.4)
    c.line(left, y, right, y)
    c.setLineWidth(0.5)
    c.line(left, y - 2, right, y - 2)

    # number and date
    y -= 9 * mm
    c.setFillColor(INK)
    c.setFont(regular, 10)
    c.drawString(left, y, "No.: ")
    c.setFont(bold, 10)
    c.drawString(left + stringWidth("No.: ", regular, 10), y, d.number)
    date_text = long_date(d.issued_on)
    c.setFont(bold, 10)
    c.drawRightString(right, y, date_text)
    c.setFont(regular, 10)
    c.drawRightString(right - stringWidth(date_text, bold, 10), y, "Date: ")

    # photo (top right, under the date)
    photo_bottom = None
    if d.show_photo:
        pw, ph = 28 * mm, 34 * mm
        px, py = right - pw, y - 6 * mm - ph
        if not draw_image(c, d.photo, px, py, pw, ph, crop=True):
            c.setFillColor(colors.HexColor("#f2f4f3"))
            c.rect(px, py, pw, ph, stroke=0, fill=1)
            c.setFillColor(MUTED)
            c.setFont(regular, 8)
            c.drawCentredString(px + pw / 2, py + ph / 2, "Photo")
        c.setStrokeColor(LINE)
        c.setLineWidth(0.8)
        c.rect(px, py, pw, ph)
        photo_bottom = py

    # title
    y -= 20 * mm
    title = d.title.upper()
    title_w = width - (2 * 30 * mm if d.show_photo else 0)
    tsize = fit_font(title, bold, 20, 12, title_w)
    c.setFillColor(INK)
    c.setFont(bold, tsize)
    c.drawCentredString(W / 2, y, title)
    tl = stringWidth(title, bold, tsize)
    c.setStrokeColor(accent)
    c.setLineWidth(1)
    c.line(W / 2 - tl / 2, y - 5, W / 2 + tl / 2, y - 5)

    # wording (shrinks to fit the page)
    footer_top = margin + 50 * mm
    y_body_top = y - 12 * mm
    if photo_bottom is not None:  # start the wording below the photo
        y_body_top = min(y_body_top, photo_bottom - 6 * mm)
    avail = y_body_top - footer_top
    paras = _body_html(d.body)
    for fs in (13, 12.5, 12, 11.5, 11, 10.5, 10, 9.5, 9, 8.5, 8, 7.5, 7):
        style = ParagraphStyle(
            "b", fontName=regular, fontSize=fs, leading=fs * 1.75, alignment=TA_JUSTIFY, textColor=INK,
            spaceAfter=fs * 0.9, firstLineIndent=0,
        )  # fmt: skip
        flow = [Paragraph(p, style) for p in paras]
        heights = [f.wrap(width, avail)[1] for f in flow]
        total = sum(heights) + style.spaceAfter * (len(flow) - 1)
        if total <= avail:
            break
    yy = y_body_top
    for f, h in zip(flow, heights, strict=True):
        yy -= h
        f.drawOn(c, left, yy)
        yy -= style.spaceAfter

    # footer: place/date, QR, signature
    base = margin + 6 * mm
    c.setFillColor(INK)
    c.setFont(regular, 10)
    fy = footer_top - 8 * mm
    if d.place:
        c.drawString(left, fy, f"Place: {d.place}")
        fy -= 14
    c.drawString(left, fy, f"Date: {long_date(d.issued_on)}")
    if d.show_qr:
        q = 26 * mm
        draw_qr(c, d.verify_url, left - 2 * mm, base - 2 * mm, q)
        c.setFillColor(MUTED)
        c.setFont(regular, 7.5)
        c.drawString(left + q, base + 12 * mm, "Scan to verify this")
        c.drawString(left + q, base + 12 * mm - 10, "certificate online.")
    sig_w, sig_h = 52 * mm, 18 * mm
    sx = right - sig_w
    sy = base + 12 * mm
    draw_image(c, d.signature_png, sx, sy, sig_w, sig_h)
    c.setStrokeColor(INK)
    c.setLineWidth(0.6)
    c.line(sx, sy - 1 * mm, right, sy - 1 * mm)
    c.setFillColor(INK)
    ny = sy - 5 * mm
    if d.signatory_name:
        c.setFont(bold, 10)
        c.drawCentredString(sx + sig_w / 2, ny, clip_text(d.signatory_name, bold, 10, sig_w + 10 * mm))
        ny -= 13
    c.setFont(regular, 10)
    c.drawCentredString(sx + sig_w / 2, ny, clip_text(d.signatory_title, regular, 10, sig_w + 10 * mm))
    ny -= 12
    c.setFillColor(MUTED)
    c.setFont(regular, 8.5)
    c.drawCentredString(sx + sig_w / 2, ny, clip_text(d.school.name, regular, 8.5, sig_w + 14 * mm))

    if d.revoked:
        watermark(c, "REVOKED", W / 2, H / 2, 96)


def build_certificate_pdf(d: CertificateDoc) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(f"{d.title} {d.number}")
    c.setAuthor(d.school.name)
    _draw_certificate(c, d)
    c.showPage()
    c.save()
    return buf.getvalue()
