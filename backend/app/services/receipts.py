"""PDF fee receipts and Indian-style amounts in words.

All figures on a receipt come from the database (the payment row, its
allocations and the stored balance_after); this module only lays them out.
"""

import io
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A5
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.services import pdf_fonts


def _fonts() -> tuple[str, str]:
    """The PDF fonts: Latin, ₹ and India's scripts, shaped (see app/services/pdf_fonts.py)."""
    return pdf_fonts.install()


# ---------------------------------------------------------------- words
_ONES = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two(n: int) -> str:
    return _ONES[n] if n < 20 else (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else ""))


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    parts = []
    if h:
        parts.append(f"{_ONES[h]} Hundred")
    if r:
        parts.append(_two(r))
    return " ".join(parts)


def number_to_words_indian(n: int) -> str:
    """12345678 -> 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight'."""
    if n == 0:
        return "Zero"
    parts = []
    crore, n = divmod(n, 10_000_000)
    lakh, n = divmod(n, 100_000)
    thousand, n = divmod(n, 1000)
    if crore:
        parts.append(f"{number_to_words_indian(crore)} Crore")
    if lakh:
        parts.append(f"{_two(lakh)} Lakh")
    if thousand:
        parts.append(f"{_two(thousand)} Thousand")
    if n:
        parts.append(_three(n))
    return " ".join(parts)


def amount_in_words(amount: Decimal) -> str:
    rupees = int(amount)
    paise = int((amount - rupees) * 100)
    words = f"Rupees {number_to_words_indian(rupees)}"
    if paise:
        words += f" and {_two(paise)} Paise"
    return words + " Only"


def inr(amount: Decimal) -> str:
    """Indian digit grouping: 1234567.5 -> ₹12,34,567.50"""
    sign = "-" if amount < 0 else ""
    whole, frac = f"{abs(amount):.2f}".split(".")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups) + "," + tail
    return f"{sign}₹{whole}.{frac}"


# ---------------------------------------------------------------- pdf
@dataclass
class ReceiptLine:
    fee_head: str
    period: str
    amount: Decimal


@dataclass
class ReceiptData:
    school_name: str
    school_address: str
    school_contact: str
    school_affiliation: str | None
    logo_png: bytes | None
    receipt_number: str
    payment_date: date
    session_name: str
    student_name: str
    student_code: str
    class_section: str
    admission_number: str
    parent_name: str | None
    lines: list[ReceiptLine]
    total: Decimal
    payment_mode: str
    reference_number: str | None
    remarks: str | None
    balance_after: Decimal
    received_by: str | None
    generated_at: datetime
    cancelled: str | None = None  # e.g. "Refunded on 12 Oct 2026: paid twice"


def build_receipt_pdf(r: ReceiptData) -> bytes:
    regular, bold = _fonts()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A5,
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=10 * mm,
        bottomMargin=10 * mm,
        title=f"Fee receipt {r.receipt_number}",
        author=r.school_name,
    )
    st = {
        "school": ParagraphStyle("school", fontName=bold, fontSize=13, leading=16),
        "small": ParagraphStyle(
            "small", fontName=regular, fontSize=7.5, leading=10, textColor=colors.HexColor("#5d6b67")
        ),
        "title": ParagraphStyle(
            "title", fontName=bold, fontSize=11, leading=14, alignment=1, spaceBefore=4, spaceAfter=4
        ),
        "cell": ParagraphStyle("cell", fontName=regular, fontSize=8.5, leading=11),
        "cellb": ParagraphStyle("cellb", fontName=bold, fontSize=8.5, leading=11),
        "words": ParagraphStyle("words", fontName=regular, fontSize=8, leading=11),
        "foot": ParagraphStyle(
            "foot", fontName=regular, fontSize=7, leading=9, textColor=colors.HexColor("#5d6b67"), alignment=1
        ),
    }
    P = Paragraph
    story = []

    head = [P(r.school_name, st["school"]), P(r.school_address, st["small"]), P(r.school_contact, st["small"])]
    if r.school_affiliation:
        head.append(P(r.school_affiliation, st["small"]))
    if r.logo_png:
        try:
            logo = Image(io.BytesIO(r.logo_png), width=16 * mm, height=16 * mm, kind="proportional")
            story.append(
                Table(
                    [[logo, head]],
                    colWidths=[19 * mm, None],
                    style=[("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)],
                )
            )
        except Exception:  # noqa: BLE001 - a broken logo must never block a receipt
            story.extend(head)
    else:
        story.extend(head)
    story.append(P("FEE RECEIPT" + (" — CANCELLED" if r.cancelled else ""), st["title"]))
    if r.cancelled:
        story.append(
            P(
                f"<b>This receipt is cancelled.</b> {escape(r.cancelled)}",
                ParagraphStyle("cx", parent=st["cell"], textColor=colors.HexColor("#b42318"), alignment=1),
            )
        )

    # The receipt number gets a full-width line so long school codes never wrap it.
    story.append(
        Table(
            [
                [
                    P(f"Receipt no. <b>{r.receipt_number}</b>", st["cell"]),
                    P(
                        f"Date <b>{r.payment_date.strftime('%d %b %Y')}</b>",
                        ParagraphStyle("d", parent=st["cell"], alignment=2),
                    ),
                ]
            ],
            colWidths=[None, 38 * mm],
            style=[
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ],
        )
    )
    info = [
        [
            P("Student", st["cell"]),
            P(r.student_name, st["cellb"]),
            P("Student ID", st["cell"]),
            P(r.student_code, st["cell"]),
        ],
        [
            P("Class", st["cell"]),
            P(r.class_section, st["cell"]),
            P("Adm. no.", st["cell"]),
            P(r.admission_number, st["cell"]),
        ],
        [
            P("Parent", st["cell"]),
            P(r.parent_name or "—", st["cell"]),
            P("Session", st["cell"]),
            P(r.session_name, st["cell"]),
        ],
    ]
    t = Table(info, colWidths=[21 * mm, 40 * mm, 20 * mm, None])
    t.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#dfe4e1")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    story += [t, Spacer(1, 4 * mm)]

    rows = [[P("#", st["cellb"]), P("Fee", st["cellb"]), P("Period", st["cellb"]), P("Amount", st["cellb"])]]
    for i, line in enumerate(r.lines, 1):
        rows.append(
            [
                P(str(i), st["cell"]),
                P(line.fee_head, st["cell"]),
                P(line.period, st["cell"]),
                P(inr(line.amount), st["cell"]),
            ]
        )
    rows.append(["", P("Total paid", st["cellb"]), "", P(inr(r.total), st["cellb"])])
    items = Table(rows, colWidths=[7 * mm, 52 * mm, 30 * mm, None], repeatRows=1)
    items.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef5f1")),
                ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#dfe4e1")),
                ("LINEABOVE", (0, -1), (-1, -1), 0.8, colors.HexColor("#1b362b")),
                ("ALIGN", (3, 0), (3, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    story += [
        items,
        Spacer(1, 2 * mm),
        P(f"<b>In words:</b> {amount_in_words(r.total)}", st["words"]),
        Spacer(1, 3 * mm),
    ]

    mode = r.payment_mode + (f" · Ref: {r.reference_number}" if r.reference_number else "")
    pay = [
        [P("Payment mode", st["cell"]), P(mode, st["cell"])],
        [P("Balance due after this payment", st["cell"]), P(inr(r.balance_after), st["cellb"])],
    ]
    if r.remarks:
        pay.append([P("Remarks", st["cell"]), P(r.remarks, st["cell"])])
    story += [Table(pay, colWidths=[48 * mm, None]), Spacer(1, 10 * mm)]

    story.append(
        Table(
            [[P(f"Received by: {r.received_by or '—'}", st["cell"]), P("Authorised signature", st["cell"])]],
            colWidths=[None, 45 * mm],
            style=[("LINEABOVE", (1, 0), (1, 0), 0.5, colors.black), ("ALIGN", (1, 0), (1, 0), "CENTER")],
        )
    )
    story += [
        Spacer(1, 4 * mm),
        P(f"Computer-generated receipt · {r.generated_at.strftime('%d %b %Y %H:%M')} UTC", st["foot"]),
    ]

    def _stamp(canvas, _doc):  # type: ignore[no-untyped-def]
        if not r.cancelled:
            return
        canvas.saveState()
        canvas.setFont(bold, 44)
        canvas.setFillColor(colors.Color(0.71, 0.14, 0.09, alpha=0.18))
        w, h = A5
        canvas.translate(w / 2, h / 2)
        canvas.rotate(35)
        canvas.drawCentredString(0, 0, "CANCELLED")
        canvas.restoreState()

    doc.build(story, onFirstPage=_stamp, onLaterPages=_stamp)
    return buf.getvalue()
