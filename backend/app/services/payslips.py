"""Salary slip PDFs. Every figure comes from the stored payslip (a snapshot taken when the
payroll was calculated); this module only lays it out."""

import io
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.services.receipts import _fonts, amount_in_words, inr

LINE = colors.HexColor("#dfe4e1")
MUTED = colors.HexColor("#5d6b67")


@dataclass
class PayslipData:
    school_name: str
    school_address: str
    logo_png: bytes | None
    month: date
    status: str  # draft | finalized | paid
    staff_name: str
    employee_id: str
    designation: str | None
    joining_date: date | None
    earnings: list[dict]  # {name, full, earned}
    deductions: list[dict]  # {name, amount}
    adjustments: list[dict]  # {label, amount}
    gross_full: Decimal
    gross_earned: Decimal
    lop_days: Decimal
    lop_amount: Decimal
    total_deductions: Decimal
    net_pay: Decimal
    days: dict[str, Decimal | int] = field(default_factory=dict)
    paid_on: date | None = None
    payment_mode: str | None = None
    generated_at: datetime | None = None


def _d(v: object) -> Decimal:
    return Decimal(str(v))


def _days(v: Decimal | int) -> str:
    d = _d(v)
    return f"{d.normalize():f}" if d != d.to_integral_value() else str(int(d))


def build_payslip_pdf(p: PayslipData) -> bytes:
    regular, bold = _fonts()
    buf = io.BytesIO()
    month = p.month.strftime("%B %Y")
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=f"Salary slip {month} — {p.staff_name}",
        author=p.school_name,
    )
    st = {
        "school": ParagraphStyle("school", fontName=bold, fontSize=14, leading=17),
        "small": ParagraphStyle("small", fontName=regular, fontSize=8, leading=10.5, textColor=MUTED),
        "title": ParagraphStyle(
            "title", fontName=bold, fontSize=12, leading=15, alignment=1, spaceBefore=8, spaceAfter=6
        ),
        "cell": ParagraphStyle("cell", fontName=regular, fontSize=9, leading=12),
        "cellb": ParagraphStyle("cellb", fontName=bold, fontSize=9, leading=12),
        "right": ParagraphStyle("right", fontName=regular, fontSize=9, leading=12, alignment=2),
        "rightb": ParagraphStyle("rightb", fontName=bold, fontSize=9, leading=12, alignment=2),
        "net": ParagraphStyle("net", fontName=bold, fontSize=12, leading=15),
        "netr": ParagraphStyle("netr", fontName=bold, fontSize=12, leading=15, alignment=2),
        "foot": ParagraphStyle("foot", fontName=regular, fontSize=7.5, leading=10, textColor=MUTED, alignment=1),
    }
    P = Paragraph
    story: list = []
    head = [P(escape(p.school_name), st["school"]), P(escape(p.school_address), st["small"])]
    if p.logo_png:
        try:
            logo = Image(io.BytesIO(p.logo_png), width=18 * mm, height=18 * mm, kind="proportional")
            story.append(
                Table(
                    [[logo, head]],
                    colWidths=[21 * mm, None],
                    style=[("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)],
                )
            )
        except Exception:  # noqa: BLE001 - a broken logo must never block a payslip
            story.extend(head)
    else:
        story.extend(head)
    story.append(P(f"SALARY SLIP — {month.upper()}" + (" (DRAFT)" if p.status == "draft" else ""), st["title"]))

    info = [
        [
            P("Name", st["cell"]),
            P(escape(p.staff_name), st["cellb"]),
            P("Employee ID", st["cell"]),
            P(escape(p.employee_id), st["cell"]),
        ],
        [
            P("Subject", st["cell"]),
            P(escape(p.designation or "—"), st["cell"]),
            P("Joined", st["cell"]),
            P(p.joining_date.strftime("%d %b %Y") if p.joining_date else "—", st["cell"]),
        ],
    ]
    t = Table(info, colWidths=[26 * mm, 62 * mm, 26 * mm, None])
    t.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(t)
    story.append(Spacer(1, 4 * mm))

    dd = p.days
    days = [
        ["Days in month", _days(dd.get("calendar_days", 0)), "Working days", _days(dd.get("working_days", 0))],
        ["Present", _days(dd.get("present_days", 0)), "Paid leave", _days(dd.get("paid_leave_days", 0))],
        ["Absent", _days(dd.get("absent_days", 0)), "Half days", _days(dd.get("half_days", 0))],
        ["Unpaid leave", _days(dd.get("unpaid_leave_days", 0)), "Not marked", _days(dd.get("unmarked_days", 0))],
    ]
    if _d(dd.get("not_joined_days", 0)) > 0:
        days.append(["Before joining", _days(dd["not_joined_days"]), "", ""])
    days.append(["Loss-of-pay days", _days(p.lop_days), "Paid on", f"{_days(dd.get('basis_days', 0))}-day basis"])
    t = Table(
        [[P(c, st["cellb"] if i % 2 else st["cell"]) for i, c in enumerate(r)] for r in days],
        colWidths=[40 * mm, 48 * mm, 40 * mm, None],
    )
    t.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, LINE),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]
        )
    )
    story.append(t)
    story.append(Spacer(1, 4 * mm))

    # earnings | deductions side by side
    left = [[P("Earnings", st["cellb"]), P("Full month", st["rightb"]), P("Earned", st["rightb"])]]
    for e in p.earnings:
        left.append(
            [P(escape(e["name"]), st["cell"]), P(inr(_d(e["full"])), st["right"]), P(inr(_d(e["earned"])), st["right"])]
        )
    right = [[P("Deductions", st["cellb"]), P("Amount", st["rightb"])]]
    for d in p.deductions:
        right.append([P(escape(d["name"]), st["cell"]), P(inr(_d(d["amount"])), st["right"])])
    for a in p.adjustments:
        amt = _d(a["amount"])
        if amt < 0:
            right.append([P(escape(a["label"]), st["cell"]), P(inr(-amt), st["right"])])
        else:
            left.append([P(escape(a["label"]), st["cell"]), P("", st["right"]), P(inr(amt), st["right"])])
    rows = max(len(left), len(right))
    left += [["", "", ""]] * (rows - len(left))
    right += [["", ""]] * (rows - len(right))
    plus = sum((_d(a["amount"]) for a in p.adjustments if _d(a["amount"]) > 0), Decimal(0))
    minus = sum((-_d(a["amount"]) for a in p.adjustments if _d(a["amount"]) < 0), Decimal(0))
    body = [lft + rgt for lft, rgt in zip(left, right, strict=True)]
    body.append(
        [
            P("Total earnings", st["cellb"]),
            P(inr(p.gross_full), st["rightb"]),
            P(inr(p.gross_earned + plus), st["rightb"]),
            P("Total deductions", st["cellb"]),
            P(inr(p.total_deductions + minus), st["rightb"]),
        ]
    )
    t = Table(body, colWidths=[36 * mm, 33 * mm, 33 * mm, 40 * mm, None])
    t.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("LINEAFTER", (2, 0), (2, -1), 0.5, LINE),
                ("LINEBELOW", (0, 0), (-1, 0), 0.5, LINE),
                ("LINEABOVE", (0, -1), (-1, -1), 0.5, LINE),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f6f7f5")),
                ("TOPPADDING", (0, 0), (-1, -1), 2.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
            ]
        )
    )
    story.append(t)
    if p.lop_amount > 0:
        story.append(
            P(
                f"Earnings are paid for the days not lost: {_days(p.lop_days)} loss-of-pay day(s) reduce the month's "
                f"earnings by {inr(p.lop_amount)}.",
                st["small"],
            )
        )
    story.append(Spacer(1, 4 * mm))
    net = Table(
        [
            [P("Net pay", st["net"]), P(inr(p.net_pay), st["netr"])],
            [P(escape(amount_in_words(p.net_pay)), st["cell"]), ""],
        ],
        colWidths=[None, 50 * mm],
    )
    net.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#2f6b57")),
                ("SPAN", (0, 1), (1, 1)),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef5f1")),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(net)
    if p.paid_on:
        story.append(Spacer(1, 2 * mm))
        story.append(
            P(
                f"Paid on {p.paid_on.strftime('%d %b %Y')}"
                + (f" by {escape(p.payment_mode)}" if p.payment_mode else ""),
                st["cell"],
            )
        )
    story.append(Spacer(1, 10 * mm))
    story.append(
        P(
            "This is a computer-generated salary slip"
            + (f", generated {p.generated_at.strftime('%d %b %Y')}" if p.generated_at else "")
            + ("." if p.status != "draft" else ". DRAFT — figures may change until the payroll is finalized."),
            st["foot"],
        )
    )
    doc.build(story)
    return buf.getvalue()
