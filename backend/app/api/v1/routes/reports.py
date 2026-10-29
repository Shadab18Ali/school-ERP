"""Reports: one engine, six definitions. Every number is computed in SQL; the
same definition serves the paginated screen and the CSV / Excel / PDF exports
(which return ALL matching rows, up to EXPORT_LIMIT)."""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.dashboard import session_enrollments, sync_dues
from app.core.deps import SchoolContext, get_db, require_feature, require_permission
from app.core.permissions import Permission
from app.services.academics import phone_digits, resolve_session
from app.services.audit import write_audit
from app.services.exports import to_csv, to_pdf, to_xlsx

# the school's plan must include reports (migration 0030; no subscription recorded = everything)
router = APIRouter(prefix="/reports", tags=["reports"], dependencies=[Depends(require_feature("reports"))])
EXPORT_LIMIT = 10_000
ReportName = Literal["students", "classes", "fee-collection", "pending-fees", "payments", "attendance"]

MODE = (
    "case p.payment_mode when 'cash' then 'Cash' when 'upi' then 'UPI' when 'bank_transfer' then 'Bank transfer' "
    "when 'cheque' then 'Cheque' when 'online' then 'Online payment' else 'Other' end"
)
GENDER = "case st.gender when 'male' then 'Male' when 'female' then 'Female' else 'Other' end"
STATUS = "case st.status when 'active' then 'Active' else 'Inactive' end"


@dataclass
class Spec:
    title: str
    columns: list[tuple[str, str, str]]  # key, label, kind
    sql: str  # SELECT ... FROM ... WHERE ... (no ORDER BY), selecting exactly the column keys
    order: str
    params: dict
    totals: list[str] = field(default_factory=list)  # keys summed in SQL for the totals row
    subtitle: str = ""


def _like(term: str) -> str:
    return "%" + " ".join(term.split()).replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


class Filters:
    def __init__(
        self,
        session_id: uuid.UUID | None = None,
        class_id: uuid.UUID | None = None,
        section_id: uuid.UUID | None = None,
        search: str | None = Query(default=None, max_length=100),
        status_filter: Literal["active", "inactive"] | None = Query(default=None, alias="status"),
        gender: Literal["male", "female", "other"] | None = None,
        date_from: date | None = None,
        date_to: date | None = None,
        mode: Literal["cash", "upi", "bank_transfer", "cheque", "other", "online"] | None = None,
        group_by: Literal["head", "mode", "day", "class"] = "head",
        overdue_only: bool = False,
        below: int | None = Query(default=None, ge=1, le=100, description="Attendance % below this"),
    ):
        self.session_id, self.class_id, self.section_id, self.search = session_id, class_id, section_id, search
        self.status, self.gender, self.date_from, self.date_to, self.mode = (
            status_filter,
            gender,
            date_from,
            date_to,
            mode,
        )
        self.group_by, self.overdue_only, self.below = group_by, overdue_only, below


def _where(base: list[str], params: dict, f: Filters, *, cls: str = "e.class_id", sec: str = "e.section_id") -> None:
    if f.class_id:
        base.append(f"{cls} = :class_id")
        params["class_id"] = f.class_id
    if f.section_id:
        base.append(f"{sec} = :section_id")
        params["section_id"] = f.section_id


async def build(name: str, f: Filters, ctx: SchoolContext, db: AsyncSession) -> Spec:
    need = {
        "students": Permission.STUDENTS_VIEW,
        "classes": Permission.STUDENTS_VIEW,
        "fee-collection": Permission.FEES_COLLECT,
        "pending-fees": Permission.FEES_COLLECT,
        "payments": Permission.FEES_COLLECT,
        "attendance": Permission.ATTENDANCE_MARK,
    }[name]
    if not ctx.can(need):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow this report.")
    session = await resolve_session(db, ctx, f.session_id)
    if session is None and name in ("students", "classes", "pending-fees", "attendance"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Set up an academic session first.")
    p: dict = {"s": ctx.school_id}
    if session:
        p["sid"] = session.id
    today = date.today()
    d_from = f.date_from or (
        session.start_date if session and name in ("attendance", "classes") else today.replace(day=1)
    )
    d_to = f.date_to or today
    if d_to < d_from:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The end date must be on or after the start date.")
    p.update({"d1": d_from, "d2": d_to})
    span = f"{d_from.strftime('%d %b %Y')} – {d_to.strftime('%d %b %Y')}"
    w: list[str] = []

    if name == "students":
        w = ["e.school_id = :s", "e.academic_session_id = :sid"]
        _where(w, p, f)
        if f.status:
            w.append("st.status = cast(:st as public.student_status)")
            p["st"] = f.status
        if f.gender:
            w.append("st.gender = cast(:g as public.gender)")
            p["g"] = f.gender
        if f.search:
            conds = [
                "st.full_name ilike :q escape '\\'",
                "st.student_code ilike :q escape '\\'",
                "e.admission_number ilike :q escape '\\'",
                "st.father_name ilike :q escape '\\'",
            ]
            p["q"] = _like(f.search)
            digits = phone_digits(f.search)
            if digits:  # only phone-like searches, never "ADM-2024-001"
                conds.append("st.mobile like :qd")
                p["qd"] = f"%{digits}%"
            w.append("(" + " or ".join(conds) + ")")
        return Spec(
            "Student report",
            [
                ("student_code", "Student ID", "text"),
                ("full_name", "Name", "text"),
                ("class_section", "Class", "text"),
                ("admission_number", "Adm. no.", "text"),
                ("admission_date", "Admitted", "date"),
                ("gender", "Gender", "text"),
                ("date_of_birth", "Date of birth", "date"),
                ("father_name", "Father", "text"),
                ("mother_name", "Mother", "text"),
                ("mobile", "Mobile", "text"),
                ("status", "Status", "text"),
            ],
            "select st.student_code, st.full_name, c.name || ' – ' || sec.name as class_section, e.admission_number, "
            f"e.admission_date, {GENDER} as gender, st.date_of_birth, st.father_name, st.mother_name, st.mobile, "
            f"{STATUS} as status, c.display_order as _o1, lower(c.name) as _o2, lower(sec.name) as _o3 "
            "from public.student_enrollments e join public.students st on st.id = e.student_id "
            "join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id "
            f"where {' and '.join(w)}",
            "_o1, _o2, _o3, lower(full_name)",
            p,
            subtitle=f"Session {session.name}",
        )

    if name == "classes":
        w = ["sec.school_id = :s", "sec.academic_session_id = :sid", "sec.deleted_at is null"]
        _where(w, p, f, cls="sec.class_id", sec="sec.id")
        if f.search:
            w.append("c.name ilike :q escape '\\'")
            p["q"] = _like(f.search)
        cols = [
            ("class_name", "Class", "text"),
            ("section_name", "Section", "text"),
            ("students", "Students", "int"),
            ("boys", "Boys", "int"),
            ("girls", "Girls", "int"),
            ("capacity", "Capacity", "int"),
        ]
        extra_sql, joins, totals = "", "", ["students", "boys", "girls"]
        if ctx.can(Permission.ATTENDANCE_MARK):
            cols.append(("attendance", "Attendance %", "percent"))
            extra_sql += ", att.pct as attendance"
            joins += (
                "left join lateral (select round(100.0 * count(*) filter (where a.status = 'present') "
                "/ nullif(count(*), 0), 1) as pct from public.attendance_records a "
                "where a.section_id = sec.id and a.attendance_date between :d1 and :d2) att on true "
            )
        if ctx.can(Permission.FEES_COLLECT):
            await sync_dues(db, ctx.school_id, await session_enrollments(db, ctx, session.id))
            cols += [
                ("fees_total", "Fees due", "money"),
                ("fees_paid", "Collected", "money"),
                ("fees_outstanding", "Outstanding", "money"),
            ]
            totals += ["fees_total", "fees_paid", "fees_outstanding"]
            extra_sql += (
                ", coalesce(fee.total, 0) as fees_total, coalesce(fee.paid, 0) as fees_paid, "
                "coalesce(fee.outstanding, 0) as fees_outstanding"
            )
            joins += (
                "left join lateral (select sum(t.total) as total, sum(t.paid) as paid, sum(t.outstanding) as "
                "outstanding "
                "from private.enrollment_fee_totals(array(select e2.id from public.student_enrollments e2 "
                "where e2.section_id = sec.id)) t) fee on true "
            )
        return Spec(
            "Class report",
            cols,
            "select c.name as class_name, sec.name as section_name, "
            "count(e.id) filter (where st.status = 'active') as students, "
            "count(e.id) filter (where st.status = 'active' and st.gender = 'male') as boys, "
            "count(e.id) filter (where st.status = 'active' and st.gender = 'female') as girls, "
            f"sec.capacity as capacity{extra_sql}, c.display_order as _o1 "
            "from public.sections sec join public.classes c on c.id = sec.class_id "
            "left join public.student_enrollments e on e.section_id = sec.id "
            f"left join public.students st on st.id = e.student_id {joins}"
            f"where {' and '.join(w)} group by sec.id, c.id, c.name, sec.name, sec.capacity, c.display_order"
            + (", att.pct" if ctx.can(Permission.ATTENDANCE_MARK) else "")
            + (", fee.total, fee.paid, fee.outstanding" if ctx.can(Permission.FEES_COLLECT) else ""),
            "_o1, lower(class_name), lower(section_name)",
            p,
            totals,
            subtitle=f"Session {session.name}"
            + (f" · attendance {span}" if ctx.can(Permission.ATTENDANCE_MARK) else ""),
        )

    if name == "fee-collection":
        w = [
            "p.school_id = :s",
            "p.payment_date between :d1 and :d2",
            "p.cancelled_at is null",
        ]  # refunded: not collected
        if f.mode:
            w.append("p.payment_mode = cast(:mode as public.payment_mode)")
            p["mode"] = f.mode
        _where(w, p, f)
        joins = "from public.fee_payments p join public.student_enrollments e on e.id = p.enrollment_id "
        if f.group_by == "head":
            label, sql = (
                "Fee head",
                (
                    "select h.name as label, count(distinct p.id) as receipts, sum(al.amount) as amount "
                    f"{joins} join public.fee_payment_allocations al on al.payment_id = p.id "
                    "join public.student_fee_dues d on d.id = al.due_id join public.fee_heads h on h.id = "
                    "d.fee_head_id "
                    f"where {' and '.join(w)} group by h.name"
                ),
            )
            order = "amount desc, label"
        elif f.group_by == "mode":
            label, sql, order = (
                "Payment mode",
                (
                    f"select {MODE} as label, count(*) as receipts, sum(p.amount) as amount {joins}"
                    f"where {' and '.join(w)} group by p.payment_mode"
                ),
                "amount desc, label",
            )
        elif f.group_by == "class":
            label, sql, order = (
                "Class",
                (
                    "select c.name || ' – ' || sec.name as label, count(*) as receipts, sum(p.amount) as amount, "
                    f"min(c.display_order) as _o1 {joins} join public.classes c on c.id = e.class_id "
                    "join public.sections sec on sec.id = e.section_id "
                    f"where {' and '.join(w)} group by c.name, sec.name"
                ),
                "_o1, label",
            )
        else:
            label, sql, order = (
                "Date",
                (
                    f"select to_char(p.payment_date, 'DD Mon YYYY') as label, count(*) as receipts, "
                    f"sum(p.amount) as amount, "
                    f"p.payment_date as _o1 {joins}where {' and '.join(w)} group by p.payment_date"
                ),
                "_o1",
            )
        return Spec(
            "Fee collection",
            [("label", label, "text"), ("receipts", "Receipts", "int"), ("amount", "Amount", "money")],
            sql,
            order,
            p,
            ["receipts", "amount"] if f.group_by != "head" else ["amount"],
            subtitle=f"{span} · by {label.lower()}",
        )

    if name == "pending-fees":
        await sync_dues(db, ctx.school_id, await session_enrollments(db, ctx, session.id))
        w = ["e.school_id = :s", "e.academic_session_id = :sid", "t.outstanding > 0"]
        _where(w, p, f)
        if f.overdue_only:
            w.append("t.overdue > 0")
        if f.search:
            w.append(
                "(st.full_name ilike :q escape '\\' or st.student_code ilike :q escape '\\' "
                "or e.admission_number ilike :q escape '\\')"
            )
            p["q"] = _like(f.search)
        return Spec(
            "Pending fees",
            [
                ("student_code", "Student ID", "text"),
                ("full_name", "Name", "text"),
                ("class_section", "Class", "text"),
                ("admission_number", "Adm. no.", "text"),
                ("mobile", "Mobile", "text"),
                ("total", "Total due", "money"),
                ("paid", "Paid", "money"),
                ("outstanding", "Outstanding", "money"),
                ("overdue", "Overdue", "money"),
            ],
            "select st.student_code, st.full_name, c.name || ' – ' || sec.name as class_section, e.admission_number, "
            "st.mobile, t.total, t.paid, t.outstanding, t.overdue "
            "from public.student_enrollments e join public.students st on st.id = e.student_id "
            "join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id "
            f"cross join lateral private.enrollment_fee_totals(array[e.id]) t where {' and '.join(w)}",
            "outstanding desc, lower(full_name)",
            p,
            ["total", "paid", "outstanding", "overdue"],
            subtitle=f"Session {session.name}" + (" · overdue only" if f.overdue_only else ""),
        )

    if name == "payments":
        w = [
            "p.school_id = :s",
            "p.payment_date between :d1 and :d2",
            "p.cancelled_at is null",
        ]  # refunded: not counted
        _where(w, p, f)
        if f.mode:
            w.append("p.payment_mode = cast(:mode as public.payment_mode)")
            p["mode"] = f.mode
        if f.search:
            w.append(
                "(p.receipt_number ilike :q escape '\\' or st.full_name ilike :q escape '\\' "
                "or st.student_code ilike :q escape '\\' or p.reference_number ilike :q escape '\\')"
            )
            p["q"] = _like(f.search)
        return Spec(
            "Payment history",
            [
                ("receipt_number", "Receipt", "text"),
                ("payment_date", "Date", "date"),
                ("student_code", "Student ID", "text"),
                ("full_name", "Name", "text"),
                ("class_section", "Class", "text"),
                ("mode", "Mode", "text"),
                ("reference_number", "Reference", "text"),
                ("amount", "Amount", "money"),
                ("received_by", "Received by", "text"),
            ],
            "select p.receipt_number, p.payment_date, st.student_code, st.full_name, c.name || ' – ' || "
            "sec.name as class_section, "
            f"{MODE} as mode, p.reference_number, p.amount, p.received_by_name as received_by, p.created_at as _o1 "
            "from public.fee_payments p join public.students st on st.id = p.student_id "
            "join public.student_enrollments e on e.id = p.enrollment_id join public.classes c on c.id = e.class_id "
            f"join public.sections sec on sec.id = e.section_id where {' and '.join(w)}",
            "payment_date desc, _o1 desc",
            p,
            ["amount"],
            subtitle=span,
        )

    # attendance
    w = ["e.school_id = :s", "e.academic_session_id = :sid"]
    _where(w, p, f)
    if f.search:
        w.append(
            "(st.full_name ilike :q escape '\\' or st.student_code ilike :q escape '\\' "
            "or e.admission_number ilike :q escape '\\')"
        )
        p["q"] = _like(f.search)
    having = ""
    if f.below:
        # only students with at least one marked day: an unknown % is not a low one
        having = " and x.pct is not null and x.pct < :below"
        p["below"] = f.below
    return Spec(
        "Attendance report",
        [
            ("student_code", "Student ID", "text"),
            ("full_name", "Name", "text"),
            ("class_section", "Class", "text"),
            ("present", "Present", "int"),
            ("absent", "Absent", "int"),
            ("leave", "Leave", "int"),
            ("marked", "Days marked", "int"),
            ("percentage", "Attendance %", "percent"),
        ],
        "select st.student_code, st.full_name, c.name || ' – ' || sec.name as class_section, x.present, "
        "x.absent, x.leave, "
        "x.marked, x.pct as percentage "
        "from public.student_enrollments e join public.students st on st.id = e.student_id "
        "join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id "
        "cross join lateral (select count(*) filter (where a.status = 'present') as present, "
        "count(*) filter (where a.status = 'absent') as absent, count(*) filter (where a.status = 'leave') as leave, "
        "count(*) as marked, round(100.0 * count(*) filter (where a.status = 'present') / nullif(count(*), 0), "
        "1) as pct "
        "from public.attendance_records a where a.enrollment_id = e.id and a.attendance_date between :d1 and :d2) x "
        f"where {' and '.join(w)} and st.status = 'active'{having}",
        "percentage asc nulls first, lower(full_name)",
        p,
        subtitle=f"Session {session.name} · {span}" + (f" · below {f.below}%" if f.below else ""),
    )


def _jsonable(columns: list[tuple[str, str, str]], row) -> dict:
    """Money and percentages as exact strings (never floats)."""
    m = row._mapping
    return {k: (str(m[k]) if kind in ("money", "percent") and m[k] is not None else m[k]) for k, _, kind in columns}


def _public(columns: list[tuple[str, str, str]], row) -> dict:
    m = row._mapping
    return {k: m[k] for k, _, _ in columns}


@router.get("/{name}")
async def report(
    name: ReportName,
    request: Request,
    f: Filters = Depends(),
    format: Literal["json", "csv", "xlsx", "pdf"] = "json",
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=200),
    ctx: SchoolContext = Depends(require_permission(Permission.REPORTS_VIEW)),
    db: AsyncSession = Depends(get_db),
):
    spec = await build(name, f, ctx, db)
    count = (await db.execute(text(f"select count(*) from ({spec.sql}) q"), spec.params)).scalar_one()
    totals = None
    if spec.totals:
        sums = ", ".join(f"coalesce(sum({k}), 0) as {k}" for k in spec.totals)
        row = (await db.execute(text(f"select {sums} from ({spec.sql}) q"), spec.params)).one()
        totals = dict(row._mapping)

    kind_of = {k: kind for k, _, kind in spec.columns}
    if format == "json":
        rows = (
            await db.execute(
                text(f"select * from ({spec.sql}) q order by {spec.order} limit :lim offset :off"),
                {**spec.params, "lim": page_size, "off": (page - 1) * page_size},
            )
        ).all()
        return {
            "title": spec.title,
            "subtitle": spec.subtitle,
            "columns": [{"key": k, "label": label, "kind": kind} for k, label, kind in spec.columns],
            "rows": [_jsonable(spec.columns, r) for r in rows],
            "totals": {k: (int(v) if kind_of[k] == "int" else str(v)) for k, v in totals.items()} if totals else None,
            "total": count,
            "page": page,
            "page_size": page_size,
        }

    rows = (
        await db.execute(
            text(f"select * from ({spec.sql}) q order by {spec.order} limit :lim"), {**spec.params, "lim": EXPORT_LIMIT}
        )
    ).all()
    data = [_public(spec.columns, r) for r in rows]
    note = f"Showing the first {EXPORT_LIMIT:,} of {count:,} rows." if count > EXPORT_LIMIT else None
    school = (
        await db.execute(text("select name from public.schools where id = :s"), {"s": ctx.school_id})
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="report.exported",
        entity_type="report",
        entity_id=name,
        school_id=ctx.school_id,
        metadata={"format": format, "rows": len(data), "filters": {k: str(v) for k, v in vars(f).items() if v}},
    )
    await db.commit()
    stamp = datetime.now(UTC).strftime("%Y%m%d")
    filename = f"{name}-{stamp}.{format}"
    if format == "csv":
        body, media = to_csv(spec.columns, data), "text/csv; charset=utf-8"
    elif format == "xlsx":
        body = to_xlsx(spec.title, spec.subtitle, spec.columns, data, totals)
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        body, media = to_pdf(school, spec.title, spec.subtitle, spec.columns, data, totals, note), "application/pdf"
    return Response(
        content=body,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )
