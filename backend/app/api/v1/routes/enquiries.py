"""Admission CRM: enquiries from parents, their follow-ups and the admission pipeline.

The school office (admins and accountants) records enquiries, works them through
the statuses and sees the pipeline. Rules live in the database (migration 0018):
status/follow-up checks, the history, and linking to online applications.
"""

import uuid
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.schemas.students import normalize_phone
from app.services.academics import resolve_session
from app.services.audit import write_audit
from app.services.exports import to_csv

router = APIRouter(prefix="/enquiries", tags=["enquiries"])
VIEW = Depends(require_permission(Permission.ENQUIRIES_VIEW))
MANAGE = Depends(require_permission(Permission.ENQUIRIES_MANAGE))
NOT_FOUND = HTTPException(status.HTTP_404_NOT_FOUND, "Enquiry not found.")

STATUSES = ("new", "contacted", "follow_up", "interested", "application", "approved", "rejected", "admitted")
OPEN = STATUSES[:6]  # rejected and admitted are closed
SOURCES = (
    "walk_in",
    "phone_call",
    "website",
    "social_media",
    "newspaper",
    "hoarding",
    "referral",
    "school_event",
    "other",
)
Status = Literal["new", "contacted", "follow_up", "interested", "application", "approved", "rejected", "admitted"]
Source = Literal[
    "walk_in", "phone_call", "website", "social_media", "newspaper", "hoarding", "referral", "school_event", "other"
]
STATUS_LABEL = {
    "new": "New",
    "contacted": "Contacted",
    "follow_up": "Follow-up",
    "interested": "Interested",
    "application": "Application",
    "approved": "Approved",
    "rejected": "Rejected",
    "admitted": "Admitted",
}
SOURCE_LABEL = {
    "walk_in": "Walk-in",
    "phone_call": "Phone call",
    "website": "Website",
    "social_media": "Social media",
    "newspaper": "Newspaper",
    "hoarding": "Hoarding / banner",
    "referral": "Referral",
    "school_event": "School event",
    "other": "Other",
}
# Funnel: an enquiry has "reached" a stage when it ever had that status or a later one.
FUNNEL = [
    ("enquiries", "Enquiries", STATUSES),
    ("contacted", "Contacted", ("contacted", "follow_up", "interested", "application", "approved", "admitted")),
    ("interested", "Interested", ("interested", "application", "approved", "admitted")),
    ("application", "Applied", ("application", "approved", "admitted")),
    ("approved", "Approved", ("approved", "admitted")),
    ("admitted", "Admitted", ("admitted",)),
]
FollowUp = Literal["overdue", "today", "week", "none"]


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


def _clean_multiline(v: object) -> object:
    if isinstance(v, str):
        v = "\n".join(" ".join(line.split()) for line in v.strip().splitlines()).strip()
        return v or None
    return v


class _Fields(BaseModel):
    model_config = {"extra": "forbid"}

    parent_name: str | None = Field(default=None, min_length=2, max_length=150)
    student_name: str | None = Field(default=None, min_length=2, max_length=150)
    phone: str | None = None
    email: EmailStr | None = None
    class_id: uuid.UUID | None = None
    source: Source | None = None
    source_detail: str | None = Field(default=None, max_length=100)
    status: Status | None = None
    follow_up_date: date | None = None
    notes: str | None = Field(default=None, max_length=2000)
    enquiry_date: date | None = None

    _c = field_validator("parent_name", "student_name", "source_detail", "email", mode="before")(
        classmethod(lambda cls, v: _clean(v))
    )
    _m = field_validator("notes", mode="before")(classmethod(lambda cls, v: _clean_multiline(v)))

    @field_validator("phone", mode="before")
    @classmethod
    def _phone(cls, v: object) -> object:
        return normalize_phone(v) if isinstance(v, str) else v

    @field_validator("enquiry_date")
    @classmethod
    def _enquiry_date(cls, v: date | None) -> date | None:
        if v is not None and v > date.today():
            raise ValueError("The enquiry date can't be in the future.")
        return v

    @field_validator("follow_up_date")
    @classmethod
    def _follow_up(cls, v: date | None) -> date | None:
        if v is not None and v > date.today() + timedelta(days=366):
            raise ValueError("Choose a follow-up date within a year.")
        return v


class EnquiryIn(_Fields):
    academic_session_id: uuid.UUID | None = None  # default: the current session
    parent_name: str = Field(min_length=2, max_length=150)
    student_name: str = Field(min_length=2, max_length=150)
    phone: str
    source: Source = "walk_in"
    status: Status = "new"

    @model_validator(mode="after")
    def _checks(self) -> "EnquiryIn":
        if self.status == "follow_up" and self.follow_up_date is None:
            raise ValueError("Choose the follow-up date.")
        return self


class EnquiryPatch(_Fields):
    """Any subset of fields; `activity_note` goes into the history with the change."""

    academic_session_id: uuid.UUID | None = None
    application_id: uuid.UUID | None = None
    activity_note: str | None = Field(default=None, max_length=1000)
    _n = field_validator("activity_note", mode="before")(classmethod(lambda cls, v: _clean_multiline(v)))


# ------------------------------------------------------------------ helpers
_ITEM = (
    "select e.id, e.enquiry_number, e.enquiry_date, e.parent_name, e.student_name, e.phone, e.email, "
    "e.class_id, c.name as class_name, e.source::text as source, e.source_detail, e.status::text as status, "
    "e.follow_up_date, e.notes, e.application_id, x.application_number, x.status::text as application_status, "
    "e.academic_session_id, a.name as session_name, a.archived_at is not null as session_archived, "
    "e.created_at, e.updated_at, "
    "(select max(v.created_at) from public.admission_enquiry_activities v "
    " where v.enquiry_id = e.id) as last_activity_at "
    "from public.admission_enquiries e "
    "join public.academic_sessions a on a.id = e.academic_session_id "
    "left join public.classes c on c.id = e.class_id "
    "left join public.admission_applications x on x.id = e.application_id "
)


def _item(r) -> dict:
    return {
        "id": str(r.id),
        "enquiry_number": r.enquiry_number,
        "enquiry_date": r.enquiry_date.isoformat(),
        "parent_name": r.parent_name,
        "student_name": r.student_name,
        "phone": r.phone,
        "email": r.email,
        "class_id": str(r.class_id) if r.class_id else None,
        "class_name": r.class_name,
        "source": r.source,
        "source_detail": r.source_detail,
        "status": r.status,
        "follow_up_date": r.follow_up_date.isoformat() if r.follow_up_date else None,
        "notes": r.notes,
        "application_id": str(r.application_id) if r.application_id else None,
        "application_number": r.application_number,
        "application_status": r.application_status,
        "academic_session_id": str(r.academic_session_id),
        "session_name": r.session_name,
        "session_is_archived": r.session_archived,
        "created_at": r.created_at.isoformat(),
        "updated_at": r.updated_at.isoformat(),
        "last_activity_at": r.last_activity_at.isoformat() if r.last_activity_at else None,
    }


def _filters(
    ctx: SchoolContext,
    session_id: uuid.UUID | None,
    status_filter: str | None,
    source: str | None,
    class_id: uuid.UUID | None,
    follow_up: str | None,
    search: str | None,
) -> tuple[list[str], dict]:
    where, p = ["e.school_id = :s"], {"s": ctx.school_id}
    if session_id:
        where.append("e.academic_session_id = :sess")
        p["sess"] = session_id
    if status_filter:
        where.append("e.status = cast(:st as public.enquiry_status)")
        p["st"] = status_filter
    if source:
        where.append("e.source = cast(:src as public.enquiry_source)")
        p["src"] = source
    if class_id:
        where.append("e.class_id = :cls")
        p["cls"] = class_id
    open_ = "e.status not in ('rejected', 'admitted')"
    if follow_up == "overdue":
        where.append(f"{open_} and e.follow_up_date < current_date")
    elif follow_up == "today":
        where.append(f"{open_} and e.follow_up_date = current_date")
    elif follow_up == "week":
        where.append(f"{open_} and e.follow_up_date between current_date and current_date + 7")
    elif follow_up == "none":
        where.append(f"{open_} and e.follow_up_date is null")
    if search and search.strip():
        q = search.strip()
        cond = "(e.student_name ilike :q or e.parent_name ilike :q or e.enquiry_number ilike :q"
        digits = "".join(ch for ch in q if ch.isdigit())
        if len(digits) >= 4:
            cond += " or e.phone like :d"
            p["d"] = f"%{digits}%"
        where.append(cond + ")")
        p["q"] = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    return where, p


async def _get(db: AsyncSession, ctx: SchoolContext, enquiry_id: uuid.UUID):
    r = (
        await db.execute(text(_ITEM + "where e.id = :id and e.school_id = :s"), {"id": enquiry_id, "s": ctx.school_id})
    ).first()
    if r is None:
        raise NOT_FOUND
    return r


async def _duplicates(db: AsyncSession, ctx: SchoolContext, phone: str, exclude: uuid.UUID | None) -> list[dict]:
    rows = (
        await db.execute(
            text(
                "select e.id, e.enquiry_number, e.student_name, e.status::text, a.name, e.enquiry_date "
                "from public.admission_enquiries e join public.academic_sessions a on a.id = e.academic_session_id "
                "where e.school_id = :s and right(e.phone, 10) = right(:p, 10) "
                "and (cast(:x as uuid) is null or e.id <> cast(:x as uuid)) order by e.created_at desc limit 10"
            ),
            {"s": ctx.school_id, "p": phone, "x": exclude},
        )
    ).all()
    return [
        {
            "id": str(r[0]),
            "enquiry_number": r[1],
            "student_name": r[2],
            "status": r[3],
            "session_name": r[4],
            "enquiry_date": r[5].isoformat(),
        }
        for r in rows
    ]


async def _detail(db: AsyncSession, ctx: SchoolContext, enquiry_id: uuid.UUID) -> dict:
    r = await _get(db, ctx, enquiry_id)
    acts = (
        await db.execute(
            text(
                "select v.kind::text, v.from_status::text, v.to_status::text, v.follow_up_date, v.note, v.created_at, "
                "p.full_name, v.actor from public.admission_enquiry_activities v "
                "left join public.profiles p on p.id = v.actor where v.enquiry_id = :e order by v.id desc"
            ),
            {"e": enquiry_id},
        )
    ).all()
    out = _item(r)
    out["activities"] = [
        {
            "kind": a[0],
            "from": a[1],
            "to": a[2],
            "follow_up_date": a[3].isoformat() if a[3] else None,
            "note": a[4],
            "at": a[5].isoformat(),
            "by": a[6] or ("Parent (online application)" if a[7] is None and a[0] == "linked" else None),
        }
        for a in acts
    ]
    out["duplicates"] = await _duplicates(db, ctx, r.phone, r.id)
    return out


# ------------------------------------------------------------------ list / export
@router.get("")
async def list_enquiries(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = None,
    status_filter: Status | None = Query(default=None, alias="status"),
    source: Source | None = None,
    class_id: uuid.UUID | None = None,
    follow_up: FollowUp | None = None,
    search: str | None = Query(default=None, max_length=100),
    sort: Literal["newest", "follow_up"] = "newest",
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> dict:
    where, p = _filters(ctx, session_id, None, source, class_id, follow_up, search)
    counts = {
        r[0]: r[1]
        for r in (
            await db.execute(
                text(
                    "select e.status::text, count(*) from public.admission_enquiries e where "
                    + " and ".join(where)
                    + " group by 1"
                ),
                p,
            )
        ).all()
    }
    if status_filter:
        where.append("e.status = cast(:st as public.enquiry_status)")
        p["st"] = status_filter
    cond = " where " + " and ".join(where)
    total = (await db.execute(text("select count(*) from public.admission_enquiries e" + cond), p)).scalar_one()
    order = (
        "e.follow_up_date nulls last, e.created_at desc"
        if sort == "follow_up"
        else "e.enquiry_date desc, e.created_at desc"
    )
    rows = (
        await db.execute(
            text(_ITEM + cond + f" order by {order} limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    ).all()
    return {
        "items": [_item(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "counts": {s: counts.get(s, 0) for s in STATUSES},
    }


@router.get("/export.csv")
async def export_enquiries(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = None,
    status_filter: Status | None = Query(default=None, alias="status"),
    source: Source | None = None,
    class_id: uuid.UUID | None = None,
    follow_up: FollowUp | None = None,
    search: str | None = Query(default=None, max_length=100),
) -> Response:
    where, p = _filters(ctx, session_id, status_filter, source, class_id, follow_up, search)
    rows = (
        await db.execute(
            text(
                _ITEM + " where " + " and ".join(where) + " order by e.enquiry_date desc, e.created_at desc limit 20000"
            ),
            p,
        )
    ).all()
    cols = [
        ("enquiry_number", "Enquiry no.", "text"),
        ("enquiry_date", "Date", "date"),
        ("student_name", "Student", "text"),
        ("parent_name", "Parent", "text"),
        ("phone", "Phone", "text"),
        ("email", "Email", "text"),
        ("class_name", "Interested class", "text"),
        ("session_name", "Session", "text"),
        ("source", "Source", "text"),
        ("source_detail", "Source detail", "text"),
        ("status", "Status", "text"),
        ("follow_up_date", "Follow-up date", "date"),
        ("application_number", "Application no.", "text"),
        ("notes", "Notes", "text"),
    ]
    data = [
        {
            **r._mapping,
            "source": SOURCE_LABEL[r.source],
            "status": STATUS_LABEL[r.status],
        }
        for r in rows
    ]
    return Response(
        to_csv(cols, data),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="enquiries-{date.today().isoformat()}.csv"'},
    )


# ------------------------------------------------------------------ pipeline (dashboard)
@router.get("/pipeline")
async def pipeline(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict:
    """Counts for the admission pipeline. Every figure comes from the enquiries themselves."""
    if date_from and date_to and date_from > date_to:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The start date is after the end date.")
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return {"session": None}
    where, p = ["e.school_id = :s", "e.academic_session_id = :sess"], {"s": ctx.school_id, "sess": session.id}
    if date_from:
        where.append("e.enquiry_date >= :df")
        p["df"] = date_from
    if date_to:
        where.append("e.enquiry_date <= :dt")
        p["dt"] = date_to
    base = "from public.admission_enquiries e where " + " and ".join(where)

    by_status = {
        r[0]: r[1] for r in (await db.execute(text(f"select e.status::text, count(*) {base} group by 1"), p)).all()
    }
    total = sum(by_status.values())
    # statuses each enquiry has ever had (its history plus where it is now)
    ever: dict[str, set] = {}
    ever_rows = (
        await db.execute(
            text(
                "select e.id, e.status::text " + base + " union "
                "select e.id, v.to_status::text from public.admission_enquiry_activities v "
                "join public.admission_enquiries e on e.id = v.enquiry_id where v.to_status is not null and "
                + " and ".join(where)
            ),
            p,
        )
    ).all()
    for eid, st in ever_rows:
        ever.setdefault(st, set()).add(eid)
    funnel = []
    for key, label, statuses in FUNNEL:
        ids: set = set()
        for st in statuses:
            ids |= ever.get(st, set())
        funnel.append({"stage": key, "label": label, "count": len(ids)})

    fu = (
        await db.execute(
            text(
                "select count(*) filter (where e.follow_up_date < current_date), "
                "count(*) filter (where e.follow_up_date = current_date), "
                "count(*) filter (where e.follow_up_date between current_date + 1 and current_date + 7), "
                "count(*) filter (where e.follow_up_date is null) "
                + base
                + " and e.status not in ('rejected', 'admitted')"
            ),
            p,
        )
    ).first()
    by_source = (
        await db.execute(
            text(
                "select e.source::text, count(*), count(*) filter (where e.status = 'admitted'), "
                "count(*) filter (where e.status = 'rejected') " + base + " group by 1 order by 2 desc, 1"
            ),
            p,
        )
    ).all()
    by_class = (
        await db.execute(
            text(
                "select coalesce(c.name, 'Not decided'), count(*), "
                "count(*) filter (where e.status not in ('rejected', 'admitted')), "
                "count(*) filter (where e.status = 'admitted') "
                "from public.admission_enquiries e left join public.classes c on c.id = e.class_id where "
                + " and ".join(where)
                + " group by c.name, c.display_order order by c.display_order nulls last, 1"
            ),
            p,
        )
    ).all()
    monthly = (
        await db.execute(
            text(
                "select to_char(date_trunc('month', e.enquiry_date), 'YYYY-MM-DD'), count(*), "
                "count(*) filter (where e.status = 'admitted') " + base + " group by 1 order by 1"
            ),
            p,
        )
    ).all()
    due = (
        await db.execute(
            text(
                _ITEM
                + "where "
                + " and ".join(where)
                + " and e.status not in ('rejected', 'admitted') and e.follow_up_date <= current_date "
                "order by e.follow_up_date, e.created_at limit 10"
            ),
            p,
        )
    ).all()
    week = (await db.execute(text(f"select count(*) {base} and e.enquiry_date > current_date - 7"), p)).scalar_one()
    admitted = by_status.get("admitted", 0)
    closed = admitted + by_status.get("rejected", 0)
    return {
        "session": {"id": str(session.id), "name": session.name, "is_archived": session.archived_at is not None},
        "total": total,
        "open": total - closed,
        "new_last_7_days": week,
        "admitted": admitted,
        "conversion_rate": round(100 * admitted / total, 1) if total else None,
        "win_rate": round(100 * admitted / closed, 1) if closed else None,
        "by_status": [{"status": s, "label": STATUS_LABEL[s], "count": by_status.get(s, 0)} for s in STATUSES],
        "funnel": funnel,
        "follow_ups": {"overdue": fu[0], "today": fu[1], "next_7_days": fu[2], "not_scheduled": fu[3]},
        "by_source": [
            {
                "source": r[0],
                "label": SOURCE_LABEL[r[0]],
                "total": r[1],
                "admitted": r[2],
                "rejected": r[3],
                "conversion_rate": round(100 * r[2] / r[1], 1) if r[1] else None,
            }
            for r in by_source
        ],
        "by_class": [{"class_name": r[0], "total": r[1], "open": r[2], "admitted": r[3]} for r in by_class],
        "monthly": [{"month": r[0], "enquiries": r[1], "admitted": r[2]} for r in monthly],
        "due": [_item(r) for r in due],
    }


@router.get("/follow-ups/summary")
async def follow_up_summary(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    """For the home dashboard: follow-ups due today and overdue, across open sessions."""
    r = (
        await db.execute(
            text(
                "select count(*) filter (where e.follow_up_date < current_date), "
                "count(*) filter (where e.follow_up_date = current_date) "
                "from public.admission_enquiries e join public.academic_sessions a on a.id = e.academic_session_id "
                "where e.school_id = :s and a.archived_at is null and e.status not in ('rejected', 'admitted')"
            ),
            {"s": ctx.school_id},
        )
    ).first()
    return {"overdue": r[0], "today": r[1]}


@router.get("/duplicates")
async def duplicates(
    phone: str = Query(min_length=10, max_length=20),
    exclude: uuid.UUID | None = None,
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Earlier enquiries with the same mobile number (any session)."""
    try:
        p = normalize_phone(phone)
    except ValueError:
        return []
    return await _duplicates(db, ctx, p or "", exclude)


# ------------------------------------------------------------------ one enquiry
@router.post("", status_code=status.HTTP_201_CREATED)
async def create_enquiry(
    payload: EnquiryIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    session = await resolve_session(db, ctx, payload.academic_session_id)
    if session is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Create an academic session first.")
    new_id = uuid.uuid4()
    try:
        await db.execute(
            text(
                "insert into public.admission_enquiries (id, school_id, academic_session_id, enquiry_date, "
                "parent_name, student_name, phone, email, class_id, source, source_detail, status, "
                "follow_up_date, notes) values "
                "(:id, :s, :sess, coalesce(cast(:d as date), current_date), :pn, :sn, :ph, :em, :cls, "
                "cast(:src as public.enquiry_source), :sd, cast(:st as public.enquiry_status), :fu, :notes)"
            ),
            {
                "id": new_id,
                "s": ctx.school_id,
                "sess": session.id,
                "d": payload.enquiry_date,
                "pn": payload.parent_name,
                "sn": payload.student_name,
                "ph": payload.phone,
                "em": payload.email,
                "cls": payload.class_id,
                "src": payload.source,
                "sd": payload.source_detail,
                "st": payload.status,
                "fu": payload.follow_up_date,
                "notes": payload.notes,
            },
        )
        await write_audit(
            db, request, action="enquiry.created", entity_type="enquiry", entity_id=str(new_id), school_id=ctx.school_id
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return await _detail(db, ctx, new_id)


@router.get("/{enquiry_id}")
async def get_enquiry(enquiry_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    return await _detail(db, ctx, enquiry_id)


@router.patch("/{enquiry_id}")
async def update_enquiry(
    enquiry_id: uuid.UUID,
    payload: EnquiryPatch,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    current = await _get(db, ctx, enquiry_id)
    fields = payload.model_dump(exclude_unset=True)
    for k in ("parent_name", "student_name", "phone", "source", "status", "enquiry_date", "academic_session_id"):
        if k in fields and fields[k] is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"{k.replace('_', ' ').capitalize()} can't be empty."
            )
    if fields.get("status") == "follow_up" and fields.get("follow_up_date", current.follow_up_date) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose the follow-up date.")
    if "application_id" in fields and fields["application_id"] is not None:
        if not ctx.can(Permission.ADMISSIONS_VIEW):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow linking applications.")
    if not fields:
        return await _detail(db, ctx, enquiry_id)
    casts = {"status": "public.enquiry_status", "source": "public.enquiry_source"}
    sets = ", ".join(f"{k} = cast(:{k} as {casts[k]})" if k in casts else f"{k} = :{k}" for k in fields)
    try:
        await db.execute(
            text(f"update public.admission_enquiries set {sets} where id = :id and school_id = :s"),
            {**fields, "id": enquiry_id, "s": ctx.school_id},
        )
        await write_audit(
            db,
            request,
            action="enquiry.updated",
            entity_type="enquiry",
            entity_id=str(enquiry_id),
            school_id=ctx.school_id,
            metadata={"fields": sorted(k for k in fields if k != "activity_note"), "status": fields.get("status")},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(
            db,
            exc,
            {"admission_enquiries_one_per_application": "That application is already linked to another enquiry."},
        ) from None
    return await _detail(db, ctx, enquiry_id)


@router.delete("/{enquiry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_enquiry(
    enquiry_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> Response:
    r = await _get(db, ctx, enquiry_id)
    if not (ctx.is_super_admin or "school_admin" in ctx.roles):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only school admins can delete enquiries.")
    try:
        res = await db.execute(
            text("delete from public.admission_enquiries where id = :id and school_id = :s"),
            {"id": enquiry_id, "s": ctx.school_id},
        )
        if res.rowcount != 1:
            await db.rollback()
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only school admins can delete enquiries.")
        await write_audit(
            db,
            request,
            action="enquiry.deleted",
            entity_type="enquiry",
            entity_id=str(enquiry_id),
            school_id=ctx.school_id,
            metadata={"enquiry_number": r.enquiry_number, "student_name": r.student_name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{enquiry_id}/application-candidates")
async def application_candidates(
    enquiry_id: uuid.UUID,
    search: str | None = Query(default=None, max_length=100),
    ctx: SchoolContext = Depends(require_permission(Permission.ADMISSIONS_VIEW)),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    """Online applications of the enquiry's session not linked to another enquiry; same mobile first."""
    e = await _get(db, ctx, enquiry_id)
    p: dict = {"s": ctx.school_id, "sess": e.academic_session_id, "ph": e.phone, "id": enquiry_id}
    cond = ""
    if search and search.strip():
        cond = " and (x.student_name ilike :q or x.application_number ilike :q)"
        p["q"] = "%" + search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    rows = (
        await db.execute(
            text(
                "select x.id, x.application_number, x.student_name, x.status::text, c.name, x.contact_phone, "
                "right(x.contact_phone, 10) = right(:ph, 10) as same_phone "
                "from public.admission_applications x join public.classes c on c.id = x.class_id "
                "where x.school_id = :s and x.academic_session_id = :sess and not exists "
                "(select 1 from public.admission_enquiries o where o.application_id = x.id and o.id <> :id)"
                + cond
                + " order by same_phone desc, x.submitted_at desc limit 20"
            ),
            p,
        )
    ).all()
    return [
        {
            "id": str(r[0]),
            "application_number": r[1],
            "student_name": r[2],
            "status": r[3],
            "class_name": r[4],
            "contact_phone": r[5],
            "same_phone": r[6],
        }
        for r in rows
    ]
