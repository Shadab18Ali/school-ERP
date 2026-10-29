"""Printable timetable: periods down the side, days across, landscape A4."""

import io
from dataclasses import dataclass
from datetime import UTC, datetime, time
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.services.receipts import _fonts

DAY_NAMES = {1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday"}


@dataclass
class PdfPeriod:
    id: str
    number: int
    label: str | None
    start: time
    end: time
    is_break: bool


@dataclass
class PdfCell:
    day: int
    period_id: str
    subject: str
    line2: str | None  # teacher (class timetable) or class (teacher timetable)
    room: str | None


def build_timetable_pdf(
    school: str, title: str, subtitle: str, periods: list[PdfPeriod], days: list[int], cells: list[PdfCell]
) -> bytes:
    regular, bold = _fonts()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=10 * mm,
        rightMargin=10 * mm,
        topMargin=10 * mm,
        bottomMargin=10 * mm,
        title=title,
        author=school,
    )
    small = ParagraphStyle("s", fontName=regular, fontSize=8, leading=10, textColor=colors.HexColor("#5d6b67"))
    h = ParagraphStyle("h", fontName=bold, fontSize=14, leading=17)
    head = ParagraphStyle("hd", fontName=bold, fontSize=8.5, leading=10, alignment=1)
    per = ParagraphStyle("p", fontName=bold, fontSize=8, leading=10)
    cell_b = ParagraphStyle("cb", fontName=bold, fontSize=8, leading=10, alignment=1)
    cell_s = ParagraphStyle(
        "cs", fontName=regular, fontSize=7, leading=9, alignment=1, textColor=colors.HexColor("#3c4744")
    )
    brk = ParagraphStyle("br", fontName=bold, fontSize=8, leading=10, alignment=1, textColor=colors.HexColor("#5d6b67"))

    by_slot = {(c.day, c.period_id): c for c in cells}
    data = [[Paragraph("Period", head)] + [Paragraph(DAY_NAMES[d], head) for d in days]]
    style = [
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c9d1cd")),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef5f1")),
        ("BACKGROUND", (0, 1), (0, -1), colors.HexColor("#f7f9f8")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    for i, p in enumerate(periods, start=1):
        times = f"{p.start.strftime('%H:%M')}–{p.end.strftime('%H:%M')}"
        name = escape(p.label or (f"Period {p.number}" if not p.is_break else "Break"))
        left = Paragraph(f"{name}<br/><font name='{regular}' size='7'>{times}</font>", per)
        if p.is_break:
            data.append([left, Paragraph(name.upper(), brk)] + [""] * (len(days) - 1))
            style += [("SPAN", (1, i), (-1, i)), ("BACKGROUND", (1, i), (-1, i), colors.HexColor("#f2f2ee"))]
            continue
        row = [left]
        for d in days:
            c = by_slot.get((d, p.id))
            if c is None:
                row.append("")
                continue
            parts = [Paragraph(escape(c.subject), cell_b)]
            extra = " · ".join(x for x in (c.line2, c.room) if x)
            if extra:
                parts.append(Paragraph(escape(extra), cell_s))
            row.append(parts)
        data.append(row)

    first = 30 * mm
    other = (doc.width - first) / max(len(days), 1)
    table = Table(data, colWidths=[first] + [other] * len(days), repeatRows=1)
    table.setStyle(TableStyle(style))
    stamp = datetime.now(UTC).strftime("%d %b %Y %H:%M")
    doc.build(
        [
            Paragraph(escape(school), small),
            Paragraph(escape(title), h),
            Paragraph(escape(subtitle), small),
            Spacer(1, 4 * mm),
            table,
            Spacer(1, 3 * mm),
            Paragraph(f"Generated {stamp} UTC", small),
        ]
    )
    return buf.getvalue()
