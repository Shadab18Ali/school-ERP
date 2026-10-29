"""Professional report cards (A4 portrait), styled by a school's template.

One page per student. Everything shown comes from the database; nothing is
invented. The preview (sample=True) is watermarked SAMPLE and uses obviously
example data.
"""

import io
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    Image,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.services.exam_pdf import StudentResult, SubjectLine, num
from app.services.receipts import _fonts

INK = colors.HexColor("#1a2321")
MUTED = colors.HexColor("#5d6b67")
LINE = colors.HexColor("#c9d1cd")
RED = colors.HexColor("#b42318")
RESULT = {"pass": "PASS", "fail": "FAIL", "incomplete": "INCOMPLETE"}


@dataclass
class TemplateSettings:
    layout: str = "classic"
    accent_color: str = "#2f6b57"
    title: str = "Report Card"
    show_logo: bool = True
    show_photo: bool = True
    show_rank: bool = True
    show_attendance: bool = True
    show_subject_grades: bool = True
    show_pass_marks: bool = True
    show_grade_scale: bool = True
    show_teacher_remarks: bool = True
    show_principal_remarks: bool = True
    signature_1: str | None = "Class Teacher"
    signature_2: str | None = "Principal"
    signature_3: str | None = "Parent / Guardian"
    principal_name: str | None = None
    principal_signature_png: bytes | None = None
    footer_note: str | None = None


@dataclass
class SchoolInfo:
    name: str
    address: str | None = None
    contact: str | None = None
    affiliation: str | None = None
    logo_png: bytes | None = None


@dataclass
class Attendance:
    present: int
    total: int
    period_from: date
    period_to: date

    @property
    def percentage(self) -> Decimal | None:
        if not self.total:
            return None
        return (Decimal(100 * self.present) / Decimal(self.total)).quantize(Decimal("0.1"))


@dataclass
class CardStudent:
    full_name: str
    admission_number: str
    student_code: str
    class_section: str
    date_of_birth: date | None = None
    father_name: str | None = None
    mother_name: str | None = None
    photo: bytes | None = None


@dataclass
class Card:
    student: CardStudent
    result: StudentResult
    out_of: int
    attendance: Attendance | None = None
    teacher_remarks: str | None = None
    principal_remarks: str | None = None
    class_teacher: str | None = None


@dataclass
class CardSet:
    school: SchoolInfo
    template: TemplateSettings
    exam_name: str
    session_name: str
    grades: list[tuple[str, Decimal, str | None]] = field(default_factory=list)  # (grade, min %, remark), highest first
    issued_on: date | None = None


def _hex(c: str) -> colors.Color:
    try:
        return colors.HexColor(c)
    except ValueError:
        return colors.HexColor("#2f6b57")


def _tint(c: colors.Color, amount: float) -> colors.Color:
    """Mix a colour with white (amount 0..1 of white)."""
    return colors.Color(c.red + (1 - c.red) * amount, c.green + (1 - c.green) * amount, c.blue + (1 - c.blue) * amount)


def _image(data: bytes | None, w: float, h: float):
    if not data:
        return None
    try:
        img = Image(io.BytesIO(data), width=w, height=h, kind="proportional")
        img.hAlign = "CENTER"
        return img
    except Exception:  # noqa: BLE001 - a broken image must never block a report card
        return None


@dataclass(frozen=True)
class _Density:
    pad: float  # table row padding (points)
    gap: float  # spacer between blocks (mm)
    remark_h: float  # minimum height of a remarks box (mm)
    sig_h: float  # space for a signature (mm)
    scale: bool  # room for the grading-scale legend


DENSITIES = [
    _Density(pad=3.5, gap=3, remark_h=15, sig_h=15, scale=True),
    _Density(pad=2.2, gap=2, remark_h=11, sig_h=12, scale=True),
    _Density(pad=1.4, gap=1.5, remark_h=9, sig_h=10, scale=False),
]


class _Styles:
    def __init__(self, accent: colors.Color):
        self.regular, self.bold = _fonts()
        r, b = self.regular, self.bold
        self.school = ParagraphStyle("school", fontName=b, fontSize=16, leading=19, alignment=1, textColor=INK)
        self.school_w = ParagraphStyle("school_w", parent=self.school, textColor=colors.white)
        self.meta = ParagraphStyle("meta", fontName=r, fontSize=8, leading=10, alignment=1, textColor=MUTED)
        self.meta_w = ParagraphStyle("meta_w", parent=self.meta, textColor=_tint(accent, 0.75))
        self.title = ParagraphStyle("title", fontName=b, fontSize=12.5, leading=15, alignment=1, textColor=accent)
        self.label = ParagraphStyle("label", fontName=r, fontSize=7.5, leading=9, textColor=MUTED)
        self.value = ParagraphStyle("value", fontName=b, fontSize=9.5, leading=12, textColor=INK)
        self.cell = ParagraphStyle("cell", fontName=r, fontSize=9, leading=11, textColor=INK)
        self.section = ParagraphStyle("section", fontName=b, fontSize=9, leading=11, textColor=accent)
        self.small = ParagraphStyle("small", fontName=r, fontSize=7.5, leading=9.5, textColor=MUTED)
        self.small_c = ParagraphStyle("small_c", parent=self.small, alignment=1)
        self.big = ParagraphStyle("big", fontName=b, fontSize=13, leading=16, alignment=1, textColor=INK)
        self.remark = ParagraphStyle("remark", fontName=r, fontSize=9.5, leading=13, textColor=INK)


def _header(cs: CardSet, st: _Styles, width: float, accent: colors.Color, d: _Density) -> list:
    t, s = cs.template, cs.school
    modern = t.layout == "modern"
    lines = [Paragraph(escape(s.name), st.school_w if modern else st.school)]
    for extra in (s.address, s.contact, s.affiliation):
        if extra:
            lines.append(Paragraph(escape(extra), st.meta_w if modern else st.meta))
    logo = _image(s.logo_png, 20 * mm, 20 * mm) if t.show_logo else None
    side = 24 * mm
    row = [[logo or "", lines, ""]]
    table = Table(row, colWidths=[side, width - 2 * side, side])
    style = [("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("ALIGN", (0, 0), (0, 0), "CENTER")]
    if modern:
        style += [
            ("BACKGROUND", (0, 0), (-1, -1), accent),
            ("TOPPADDING", (0, 0), (-1, -1), 8),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ]
    else:
        style += [("LINEBELOW", (0, 0), (-1, -1), 1.4, accent)]
    table.setStyle(TableStyle(style))
    title = Paragraph(
        f"{escape(t.title).upper()}<br/><font size='9' color='#5d6b67'>{escape(cs.exam_name)} · "
        f"Session {escape(cs.session_name)}</font>",
        st.title,
    )
    return [table, Spacer(1, d.gap * mm), title, Spacer(1, d.gap * mm)]


def _student_block(card: Card, cs: CardSet, st: _Styles, width: float, accent: colors.Color, d: _Density) -> Table:
    s = card.student
    pairs = [
        ("Student name", s.full_name),
        ("Class & section", s.class_section),
        ("Admission no.", s.admission_number),
        ("Student ID", s.student_code),
        ("Date of birth", s.date_of_birth.strftime("%d %b %Y") if s.date_of_birth else "—"),
        ("Father's name", s.father_name or "—"),
        ("Mother's name", s.mother_name or "—"),
        ("Class teacher", card.class_teacher or "—"),
    ]
    cells = [[Paragraph(k, st.label), Paragraph(escape(str(v)), st.value)] for k, v in pairs]
    grid = [cells[i] + cells[i + 1] for i in range(0, len(cells), 2)]
    photo_w = 28 * mm if cs.template.show_photo else 0
    details_w = width - photo_w - (4 * mm if photo_w else 0)
    inner = Table(grid, colWidths=[details_w * 0.17, details_w * 0.33, details_w * 0.17, details_w * 0.33])
    inner.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LINEBELOW", (0, 0), (-1, -2), 0.3, LINE),
                ("TOPPADDING", (0, 0), (-1, -1), d.pad),
                ("BOTTOMPADDING", (0, 0), (-1, -1), d.pad),
            ]
        )
    )
    if not photo_w:
        return inner
    photo = _image(s.photo, photo_w, 34 * mm)
    if photo is None:  # an empty frame, never a stock picture
        initials = "".join(p[0] for p in s.full_name.split()[:2]).upper()
        photo = Table(
            [[Paragraph(f"<font size='16' color='#5d6b67'>{escape(initials)}</font>", st.small_c)]],
            colWidths=[photo_w],
            rowHeights=[34 * mm],
        )
        photo.setStyle(
            TableStyle(
                [
                    ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f6f7f5")),
                ]
            )
        )
    outer = Table([[inner, photo]], colWidths=[details_w + 4 * mm, photo_w])
    outer.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return outer


def _mark(s: SubjectLine) -> str:
    if not s.entered:
        return "—"
    return "AB" if s.is_absent else num(s.marks)


def _marks_table(card: Card, cs: CardSet, st: _Styles, width: float, accent: colors.Color, d: _Density) -> Table:
    t, r = cs.template, card.result
    head = ["Subject", "Max."] + (["Pass"] if t.show_pass_marks else []) + ["Marks"]
    head += (["Grade"] if t.show_subject_grades else []) + ["Result"]
    rows: list[list] = [head]
    style = [
        ("FONT", (0, 0), (-1, 0), st.bold, 8.5),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BACKGROUND", (0, 0), (-1, 0), accent),
        ("FONT", (0, 1), (-1, -1), st.regular, 9),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), d.pad),
        ("BOTTOMPADDING", (0, 0), (-1, -1), d.pad),
    ]
    for i, s in enumerate(r.subjects, start=1):
        line = [Paragraph(escape(s.subject), st.cell), num(s.max_marks)]
        if t.show_pass_marks:
            line.append(num(s.pass_marks))
        line.append(_mark(s))
        if t.show_subject_grades:
            line.append(s.grade or "—")
        line.append("—" if s.passed is None else ("Pass" if s.passed else "Fail"))
        rows.append(line)
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), _tint(accent, 0.94)))
        if s.passed is False:  # marks and result in red
            marks_col = 3 if t.show_pass_marks else 2
            style += [
                ("TEXTCOLOR", (marks_col, i), (marks_col, i), RED),
                ("TEXTCOLOR", (len(line) - 1, i), (len(line) - 1, i), RED),
            ]
    total = ["Total", num(r.max_total)] + ([""] if t.show_pass_marks else [])
    total += (
        [num(r.total) if r.result != "incomplete" else "—"] + ([r.grade or "—"] if t.show_subject_grades else []) + [""]
    )
    rows.append(total)
    style += [("FONT", (0, -1), (-1, -1), st.bold, 9), ("LINEABOVE", (0, -1), (-1, -1), 1, accent)]
    n = len(head)
    first = width * 0.34
    table = Table(rows, colWidths=[first] + [(width - first) / (n - 1)] * (n - 1), repeatRows=1)
    table.setStyle(TableStyle(style))
    return table


def _summary(card: Card, cs: CardSet, st: _Styles, width: float, accent: colors.Color) -> Table:
    r = card.result
    items = [
        ("TOTAL", f"{num(r.total)}/{num(r.max_total)}" if r.result != "incomplete" else "—"),
        ("PERCENTAGE", f"{num(r.percentage)}%" if r.percentage is not None else "—"),
        ("GRADE", r.grade or "—"),
        ("RESULT", RESULT[r.result]),
    ]
    if cs.template.show_rank:
        items.append(("RANK IN SECTION", f"{r.rank} of {card.out_of}" if r.rank else "—"))
    values = [escape(v) for _, v in items]
    if r.result == "fail":
        values[3] = f"<font color='#b42318'>{values[3]}</font>"
    cells = [[Paragraph(k, st.small_c) for k, _ in items], [Paragraph(v, st.big) for v in values]]
    table = Table(cells, colWidths=[width / len(items)] * len(items))
    style = [
        ("BOX", (0, 0), (-1, -1), 0.8, accent),
        ("INNERGRID", (0, 0), (-1, -1), 0.3, _tint(accent, 0.6)),
        ("BACKGROUND", (0, 0), (-1, -1), _tint(accent, 0.93)),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]
    table.setStyle(TableStyle(style))
    return table


def _box(title: str, body, st: _Styles, width: float, accent: colors.Color, min_h: float = 0) -> Table:
    t = Table([[Paragraph(escape(title), st.section)], [body]], colWidths=[width], rowHeights=[None, min_h or None])
    t.setStyle(
        TableStyle(
            [
                ("BOX", (0, 0), (-1, -1), 0.5, LINE),
                ("LINEBELOW", (0, 0), (-1, 0), 0.3, LINE),
                ("BACKGROUND", (0, 0), (-1, 0), _tint(accent, 0.94)),
                ("VALIGN", (0, 1), (-1, 1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return t


def _attendance(card: Card, st: _Styles) -> Paragraph:
    a = card.attendance
    if a is None or a.total == 0:
        return Paragraph("No attendance has been recorded for this period.", st.remark)
    period = f"{a.period_from.strftime('%d %b %Y')} – {a.period_to.strftime('%d %b %Y')}"
    return Paragraph(
        f"Present on <b>{a.present}</b> of <b>{a.total}</b> recorded school days "
        f"(<b>{num(a.percentage)}%</b>) <font color='#5d6b67'>· {period}</font>",
        st.remark,
    )


def _grade_scale(cs: CardSet, st: _Styles, width: float) -> Table | None:
    if not cs.grades:
        return None
    cells, prev = [], None
    for g, mn, _ in cs.grades:  # highest first
        rng = f"{num(mn)}–100" if prev is None else f"{num(mn)}–<{num(prev)}"
        cells.append(Paragraph(f"<b>{escape(g)}</b> {rng}%", st.small_c))
        prev = mn
    per_row = 8
    rows = [cells[i : i + per_row] for i in range(0, len(cells), per_row)]
    rows[-1] += [""] * (per_row - len(rows[-1]))
    t = Table(
        [[Paragraph("Grading scale", st.small)] + [""] * (per_row - 1)] + rows, colWidths=[width / per_row] * per_row
    )
    t.setStyle(
        TableStyle(
            [("SPAN", (0, 0), (-1, 0)), ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]
        )
    )
    return t


def _signatures(card: Card, cs: CardSet, st: _Styles, width: float, d: _Density) -> Table | None:
    t = cs.template
    cols = []
    for i, label in enumerate((t.signature_1, t.signature_2, t.signature_3), start=1):
        if not label:
            continue
        above = ""
        if i == 2 and t.principal_signature_png:
            above = _image(t.principal_signature_png, 38 * mm, (d.sig_h - 1) * mm) or ""
        name = card.class_teacher if i == 1 else (t.principal_name if i == 2 else None)
        under = escape(label) + (f"<br/><font color='#5d6b67'>{escape(name)}</font>" if name else "")
        cols.append((above, Paragraph(under, st.small_c)))
    if not cols:
        return None
    gap = 12 * mm
    w = (width - gap * (len(cols) - 1)) / len(cols)
    top, bottom, widths = [], [], []
    for i, c in enumerate(cols):
        if i:
            top.append("")
            bottom.append("")
            widths.append(gap)
        top.append(c[0])
        bottom.append(c[1])
        widths.append(w)
    table = Table([top, bottom], colWidths=widths, rowHeights=[d.sig_h * mm, None])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, 0), "BOTTOM"),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                *[("LINEABOVE", (2 * i, 1), (2 * i, 1), 0.6, INK) for i in range(len(cols))],
            ]
        )
    )
    return table


def _card_flow(card: Card, cs: CardSet, st: _Styles, width: float, d: _Density) -> list:
    t = cs.template
    accent = _hex(t.accent_color)
    gap = Spacer(1, d.gap * mm)
    flow = _header(cs, st, width, accent, d)
    flow += [_student_block(card, cs, st, width, accent, d), Spacer(1, (d.gap + 1) * mm)]
    flow += [_marks_table(card, cs, st, width, accent, d), gap, _summary(card, cs, st, width, accent), gap]
    if t.show_attendance:
        flow += [_box("Attendance", _attendance(card, st), st, width, accent), gap]
    remarks = []
    if t.show_teacher_remarks:
        remarks.append(("Class teacher's remarks", card.teacher_remarks))
    if t.show_principal_remarks:
        remarks.append(("Principal's remarks", card.principal_remarks))
    if remarks:
        w = (width - 4 * mm * (len(remarks) - 1)) / len(remarks)
        boxes = [
            _box(
                title,
                Paragraph(escape(text) if text else "<font color='#9aa5a1'>—</font>", st.remark),
                st,
                w,
                accent,
                d.remark_h * mm,
            )
            for title, text in remarks
        ]
        row = (
            Table([[boxes[0], "", boxes[1]]], colWidths=[w, 4 * mm, w])
            if len(boxes) == 2
            else Table([[boxes[0]]], colWidths=[w])
        )
        row.setStyle(
            TableStyle(
                [
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ]
            )
        )
        flow += [row, gap]
    if t.show_grade_scale and d.scale:
        scale = _grade_scale(cs, st, width)
        if scale is not None:
            flow += [scale, Spacer(1, 1.5 * mm)]
    flow.append(Paragraph("A subject is passed at or above its pass marks. AB = absent (counted as 0).", st.small))
    sig = _signatures(card, cs, st, width, d)
    if sig is not None:
        flow += [Spacer(1, (d.gap + 2) * mm), sig]
    issued = cs.issued_on.strftime("%d %b %Y") if cs.issued_on else None
    tail = " · ".join(x for x in ((f"Date of issue: {issued}" if issued else None), t.footer_note) if x)
    if tail:
        flow += [gap, Paragraph(escape(tail), st.small_c)]
    return flow


def build_report_card_pdf(cs: CardSet, cards: list[Card], *, sample: bool = False) -> bytes:
    accent = _hex(cs.template.accent_color)
    st = _Styles(accent)
    buf = io.BytesIO()
    margin = 13 * mm

    def decorate(canvas, doc):
        canvas.saveState()
        w, h = A4
        canvas.setStrokeColor(accent)
        if cs.template.layout == "classic":
            canvas.setLineWidth(1.2)
            canvas.rect(7 * mm, 7 * mm, w - 14 * mm, h - 14 * mm)
            canvas.setLineWidth(0.4)
            canvas.rect(8.5 * mm, 8.5 * mm, w - 17 * mm, h - 17 * mm)
        else:
            canvas.setFillColor(accent)
            canvas.rect(0, 0, w, 4 * mm, stroke=0, fill=1)
        if sample:
            canvas.setFont(st.bold, 70)
            canvas.setFillColor(colors.Color(0.85, 0.2, 0.15, alpha=0.12))
            canvas.translate(w / 2, h / 2)
            canvas.rotate(35)
            canvas.drawCentredString(0, 0, "SAMPLE")
        canvas.restoreState()

    def new_doc(target) -> SimpleDocTemplate:
        return SimpleDocTemplate(
            target,
            pagesize=A4,
            leftMargin=margin,
            rightMargin=margin,
            topMargin=margin,
            bottomMargin=margin,
            title=f"{cs.template.title} – {cs.exam_name}",
            author=cs.school.name,
        )

    width = new_doc(io.BytesIO()).width
    flow: list = []
    for i, card in enumerate(cards):
        if i:
            flow.append(PageBreak())
        flow += _fit(card, cs, st, width, new_doc)
    new_doc(buf).build(flow, onFirstPage=decorate, onLaterPages=decorate)
    return buf.getvalue()


def _fit(card: Card, cs: CardSet, st: _Styles, width: float, new_doc) -> list:
    """The most spacious layout that keeps this student's card on one page (a card with a very
    long subject list may still need a second page at the tightest spacing)."""
    for d in DENSITIES:
        trial = new_doc(io.BytesIO())
        pages = {"n": 0}

        def count(canvas, doc, pages=pages):
            pages["n"] += 1

        trial.build(_card_flow(card, cs, st, width, d), onFirstPage=count, onLaterPages=count)
        if pages["n"] == 1:
            return _card_flow(card, cs, st, width, d)
    return _card_flow(card, cs, st, width, DENSITIES[-1])


def sample_cards(template: TemplateSettings, school: SchoolInfo, grades) -> tuple[CardSet, list[Card]]:
    """Clearly fictional data for the template preview (the PDF is watermarked SAMPLE)."""
    subjects = [
        SubjectLine("English", date(2026, 9, 21), Decimal(100), Decimal(33), Decimal(78), False, True, "B1", True),
        SubjectLine("Hindi", date(2026, 9, 22), Decimal(100), Decimal(33), Decimal(85), False, True, "A2", True),
        SubjectLine("Mathematics", date(2026, 9, 23), Decimal(100), Decimal(33), Decimal(92), False, True, "A1", True),
        SubjectLine("Science", date(2026, 9, 24), Decimal(100), Decimal(33), Decimal("67.5"), False, True, "B2", True),
        SubjectLine(
            "Social Science", date(2026, 9, 25), Decimal(100), Decimal(33), Decimal(71), False, True, "B1", True
        ),
    ]
    result = StudentResult(
        "Sample Student", "SAMPLE-001", Decimal("393.5"), Decimal(500), Decimal("78.70"), "B1", "pass", 4, subjects
    )
    card = Card(
        student=CardStudent(
            "Sample Student",
            "SAMPLE-001",
            "STU-SAMPLE",
            "Class 5 – A",
            date(2016, 6, 15),
            "Father's Name",
            "Mother's Name",
        ),
        result=result,
        out_of=40,
        attendance=Attendance(88, 96, date(2026, 4, 1), date(2026, 9, 25)),
        teacher_remarks="Sample remark: attentive in class and completes work on time.",
        principal_remarks="Sample remark: keep up the good work.",
        class_teacher="Class Teacher's Name",
    )
    cs = CardSet(
        school=school,
        template=template,
        exam_name="Half Yearly (sample)",
        session_name="2026-27",
        grades=grades,
        issued_on=date.today(),
    )
    return cs, [card]
