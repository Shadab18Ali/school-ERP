"""Result sheets (one section), as PDF. Report cards live in report_card_pdf.py."""

import io
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.services.receipts import _fonts

RESULT_LABEL = {"pass": "PASS", "fail": "FAIL", "incomplete": "INCOMPLETE"}
GRID = colors.HexColor("#c9d1cd")
HEAD = colors.HexColor("#eef5f1")


def num(v: Decimal | None) -> str:
    if v is None:
        return "—"
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s or "0"


@dataclass
class SubjectLine:
    subject: str
    exam_date: date
    max_marks: Decimal
    pass_marks: Decimal
    marks: Decimal | None
    is_absent: bool
    entered: bool
    grade: str | None
    passed: bool | None


@dataclass
class StudentResult:
    full_name: str
    admission_number: str
    total: Decimal | None
    max_total: Decimal | None
    percentage: Decimal | None
    grade: str | None
    result: str
    rank: int | None
    subjects: list[SubjectLine]


def _styles():
    regular, bold = _fonts()
    return (
        regular,
        bold,
        {
            "small": ParagraphStyle(
                "s", fontName=regular, fontSize=8, leading=10, textColor=colors.HexColor("#5d6b67")
            ),
            "h": ParagraphStyle("h", fontName=bold, fontSize=15, leading=19),
            "h2": ParagraphStyle("h2", fontName=bold, fontSize=11, leading=14),
            "cell": ParagraphStyle("c", fontName=regular, fontSize=9, leading=11),
            "cellb": ParagraphStyle("cb", fontName=bold, fontSize=9, leading=11),
        },
    )


def _mark_text(s: SubjectLine) -> str:
    if not s.entered:
        return "—"
    return "AB" if s.is_absent else num(s.marks)


def build_result_sheet(
    school: str,
    exam: str,
    session: str,
    class_section: str,
    subjects: list[tuple[str, Decimal]],
    results: list[StudentResult],
) -> bytes:
    regular, bold, st = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=landscape(A4),
        leftMargin=10 * mm,
        rightMargin=10 * mm,
        topMargin=10 * mm,
        bottomMargin=10 * mm,
        title=f"Result sheet – {exam} – {class_section}",
        author=school,
    )
    head = (
        ["Rank", "Student", "Adm. no."]
        + [f"{name}\n({num(mx)})" for name, mx in subjects]
        + ["Total", "%", "Grade", "Result"]
    )
    rows = [head]
    style = [
        ("FONT", (0, 0), (-1, 0), bold, 7.5),
        ("FONT", (0, 1), (-1, -1), regular, 8),
        ("GRID", (0, 0), (-1, -1), 0.4, GRID),
        ("BACKGROUND", (0, 0), (-1, 0), HEAD),
        ("ALIGN", (3, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]
    for i, r in enumerate(results, start=1):
        by_subject = {s.subject: s for s in r.subjects}
        cells = []
        for j, (name, _) in enumerate(subjects):
            s = by_subject.get(name)
            cells.append(_mark_text(s) if s else "")
            if s and s.passed is False:
                style.append(("TEXTCOLOR", (3 + j, i), (3 + j, i), colors.HexColor("#b42318")))
        rows.append(
            [str(r.rank or "—"), Paragraph(escape(r.full_name), st["cell"]), r.admission_number]
            + cells
            + [
                num(r.total) if r.result != "incomplete" else "—",
                num(r.percentage),
                r.grade or "—",
                RESULT_LABEL[r.result],
            ]
        )
        if r.result == "fail":
            style.append(("TEXTCOLOR", (-1, i), (-1, i), colors.HexColor("#b42318")))
    fixed = 12 * mm + 45 * mm + 22 * mm + 4 * 18 * mm
    subj_w = max((doc.width - fixed) / max(len(subjects), 1), 14 * mm)
    widths = [12 * mm, 45 * mm, 22 * mm] + [subj_w] * len(subjects) + [18 * mm] * 4
    table = Table(rows, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle(style))
    passed = sum(1 for r in results if r.result == "pass")
    failed = sum(1 for r in results if r.result == "fail")
    incomplete = sum(1 for r in results if r.result == "incomplete")
    stamp = datetime.now(UTC).strftime("%d %b %Y %H:%M")
    doc.build(
        [
            Paragraph(escape(school), st["small"]),
            Paragraph(f"Result sheet · {escape(exam)} · {escape(class_section)}", st["h"]),
            Paragraph(
                f"Session {escape(session)} · {len(results)} students · {passed} passed · {failed} failed"
                + (f" · {incomplete} incomplete" if incomplete else ""),
                st["small"],
            ),
            Spacer(1, 4 * mm),
            KeepTogether(table) if len(results) < 25 else table,
            Spacer(1, 3 * mm),
            Paragraph(f"AB = absent (counts as 0). Red = below passing marks. Generated {stamp} UTC", st["small"]),
        ]
    )
    return buf.getvalue()
