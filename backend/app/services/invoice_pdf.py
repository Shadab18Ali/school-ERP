"""Subscription invoices as PDF (tax invoice layout). Every figure comes from the stored invoice
row and its payments; this module only lays them out."""

import io
from datetime import date
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.services.receipts import _fonts, amount_in_words, inr

INK = colors.HexColor("#1a2321")
MUTED = colors.HexColor("#5d6b67")
LINE = colors.HexColor("#dfe4e1")
STATE_LABEL = {"paid": "PAID", "open": "DUE", "overdue": "OVERDUE", "partly_paid": "PART PAID", "void": "CANCELLED"}


def _d(v: date | None) -> str:
    return v.strftime("%d %b %Y") if v else "—"


def _party(title: str, p: dict, st: ParagraphStyle, label: ParagraphStyle) -> list:
    lines = [f"<b>{escape(p.get('name') or '')}</b>"]
    for k in ("address", "state"):
        if p.get(k):
            lines.append(escape(str(p[k])))
    if p.get("gstin"):
        lines.append(f"GSTIN: {escape(p['gstin'])}")
    for k in ("email", "phone"):
        if p.get(k):
            lines.append(escape(str(p[k])))
    if p.get("note"):
        lines.append(f"<i>{escape(p['note'])}</i>")
    return [Paragraph(title, label), Paragraph("<br/>".join(lines), st)]


def build_invoice_pdf(inv: dict, payments: list[dict], state: str) -> bytes:
    regular, bold = _fonts()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title=f"Invoice {inv['invoice_number']}",
        author=(inv["seller"] or {}).get("name", ""),
    )
    st = ParagraphStyle("t", fontName=regular, fontSize=9.5, leading=13, textColor=INK)
    label = ParagraphStyle("l", parent=st, fontSize=8, textColor=MUTED, spaceAfter=2)
    h1 = ParagraphStyle("h", parent=st, fontName=bold, fontSize=18, leading=22)
    right = ParagraphStyle("r", parent=st, alignment=2)
    right_b = ParagraphStyle("rb", parent=right, fontName=bold)

    story: list = []
    head = Table(
        [
            [
                Paragraph("TAX INVOICE" if Decimal(inv["tax_amount"]) > 0 else "INVOICE", h1),
                Paragraph(
                    f"<b>{escape(inv['invoice_number'])}</b><br/>Issued {_d(inv['issued_on'])}<br/>Due "
                    f"{_d(inv['due_on'])}"
                    f"<br/><b>{STATE_LABEL.get(state, state.upper())}</b>",
                    right,
                ),
            ]
        ],
        colWidths=[95 * mm, 79 * mm],
    )
    head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story += [head, Spacer(1, 8 * mm)]

    parties = Table(
        [[_party("FROM", inv["seller"] or {}, st, label), _party("BILL TO", inv["buyer"] or {}, st, label)]],
        colWidths=[87 * mm, 87 * mm],
    )
    parties.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
    story += [parties, Spacer(1, 8 * mm)]

    rows = [
        [Paragraph("<b>Description</b>", st), Paragraph("<b>Period</b>", st), Paragraph("<b>Amount</b>", right_b)],
        [
            Paragraph(escape(inv["description"]), st),
            Paragraph(f"{_d(inv['period_start'])} – {_d(inv['period_end'])}", st),
            Paragraph(inr(Decimal(inv["subtotal"])), right),
        ],
    ]
    tax_rate = Decimal(inv["tax_rate"])
    label_tax = inv.get("tax_label") or "Tax"
    if Decimal(inv["cgst"]) > 0 or Decimal(inv["sgst"]) > 0:
        half = tax_rate / 2
        rows.append(["", Paragraph(f"C{escape(label_tax)} {half:g}%", st), Paragraph(inr(Decimal(inv["cgst"])), right)])
        rows.append(["", Paragraph(f"S{escape(label_tax)} {half:g}%", st), Paragraph(inr(Decimal(inv["sgst"])), right)])
    if Decimal(inv["igst"]) > 0:
        rows.append(
            ["", Paragraph(f"I{escape(label_tax)} {tax_rate:g}%", st), Paragraph(inr(Decimal(inv["igst"])), right)]
        )
    rows.append(["", Paragraph("<b>Total</b>", st), Paragraph(f"<b>{inr(Decimal(inv['total']))}</b>", right)])
    t = Table(rows, colWidths=[92 * mm, 50 * mm, 32 * mm])
    t.setStyle(
        TableStyle(
            [
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, INK),
                ("LINEABOVE", (0, -1), (-1, -1), 0.6, INK),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story += [t, Spacer(1, 3 * mm), Paragraph(f"Amount in words: {escape(amount_in_words(Decimal(inv['total'])))}", st)]

    paid = sum((Decimal(p["amount"]) - Decimal(p["refunded_amount"]) for p in payments), Decimal(0))
    if payments:
        story += [Spacer(1, 7 * mm), Paragraph("PAYMENTS", label)]
        prow = [
            [
                Paragraph("<b>Date</b>", st),
                Paragraph("<b>Method</b>", st),
                Paragraph("<b>Reference</b>", st),
                Paragraph("<b>Amount</b>", right_b),
            ]
        ]
        for p in payments:
            ref = p.get("reference") or p.get("gateway_payment_id") or ""
            amt = inr(Decimal(p["amount"]))
            if Decimal(p["refunded_amount"]) > 0:
                amt += f" (refunded {inr(Decimal(p['refunded_amount']))})"
            prow.append(
                [
                    Paragraph(_d(p["paid_on"]), st),
                    Paragraph(escape(str(p["method"]).replace("_", " ").title()), st),
                    Paragraph(escape(str(ref)), st),
                    Paragraph(amt, right),
                ]
            )
        pt = Table(prow, colWidths=[30 * mm, 35 * mm, 69 * mm, 40 * mm])
        pt.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, 0), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story.append(pt)
    balance = Decimal(inv["total"]) - paid
    story += [Spacer(1, 4 * mm), Paragraph(f"<b>Balance due: {inr(max(balance, Decimal(0)))}</b>", right)]
    if inv.get("voided_at"):
        story += [
            Spacer(1, 4 * mm),
            Paragraph(f"<b>This invoice was cancelled:</b> {escape(inv.get('void_reason') or '')}", st),
        ]
    story += [Spacer(1, 10 * mm), Paragraph("This is a computer-generated invoice and needs no signature.", label)]
    doc.build(story)
    return buf.getvalue()
