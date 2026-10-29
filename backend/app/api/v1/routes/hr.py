"""Staff leave: leave types and yearly allowances, applications, approval and rejection, balances,
history, school holidays and staff attendance (which payroll uses for loss of pay).

Rules live in the database (migration 0025): working days (weekly offs and holidays don't count),
one leave at a time, the balance, the session, who may decide, and the payroll lock — once a
month's payroll is finalized its attendance, holidays and leave decisions can't change.
"""

import re
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services.academics import resolve_session
from app.services.audit import write_audit
from app.services.exports import to_csv

router = APIRouter(prefix="/hr", tags=["hr"])
SELF = Depends(require_permission(Permission.LEAVE_SELF))
MANAGE = Depends(require_permission(Permission.HR_MANAGE))
ANY_HR = Depends(require_permission(Permission.LEAVE_SELF, Permission.HR_MANAGE))
IST = ZoneInfo("Asia/Kolkata")

UNIQUE = {
    "leave_types_name_key": "A leave type with this name already exists.",
    "leave_types_code_key": "A leave type with this code already exists.",
    "staff_holidays_one_per_day": "There is already a holiday on that date.",
}
LeaveStatus = Literal["pending", "approved", "rejected", "cancelled"]
STATUS_LABEL = {"pending": "Pending", "approved": "Approved", "rejected": "Rejected", "cancelled": "Cancelled"}


def today() -> date:
    return datetime.now(IST).date()


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = re.sub(r"\s+", " ", v).strip()
        return v or None
    return v


def _json(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, uuid.UUID):
            v = str(v)
        elif isinstance(v, datetime | date):
            v = v.isoformat()
        elif isinstance(v, Decimal):
            v = (
                f"{v.normalize():f}"
                if k.endswith(("days", "allowance", "used", "pending", "available"))
                else f"{v:.2f}"
            )
        out[k] = v
    return out


def _rows(result: Any) -> list[dict]:
    return [_json(dict(r)) for r in result.mappings()]


async def _call(db: AsyncSession, sql: str, params: dict[str, Any]) -> Any:
    try:
        return await db.execute(text(sql), params)
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None


def _half(v: Decimal | None, label: str) -> Decimal | None:
    if v is not None and v * 2 != (v * 2).to_integral_value():
        raise ValueError(f"Enter {label} in whole or half days.")
    return v


# ------------------------------------------------------------------ settings and holidays
class SettingsIn(BaseModel):
    model_config = {"extra": "forbid"}
    weekly_offs: list[int] = Field(default=[7], max_length=3)
    lop_basis: Literal["working_days", "calendar_days"] = "working_days"
    unmarked_as: Literal["present", "absent"] = "present"

    @field_validator("weekly_offs")
    @classmethod
    def _days(cls, v: list[int]) -> list[int]:
        if any(d < 1 or d > 7 for d in v):
            raise ValueError("Weekly offs are days of the week (1 = Monday … 7 = Sunday).")
        return sorted(set(v))


async def _settings(db: AsyncSession, ctx: SchoolContext) -> dict:
    r = (
        (
            await db.execute(
                text("select weekly_offs, lop_basis, unmarked_as from public.hr_settings where school_id = :s"),
                {"s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    return dict(r) if r else {"weekly_offs": [7], "lop_basis": "working_days", "unmarked_as": "present"}


@router.get("/settings")
async def settings(ctx: SchoolContext = ANY_HR, db: AsyncSession = Depends(get_db)) -> dict:
    return await _settings(db, ctx)


@router.put("/settings")
async def save_settings(
    payload: SettingsIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    await _call(
        db,
        "insert into public.hr_settings (school_id, weekly_offs, lop_basis, unmarked_as) values (:s, cast(:w as "
        "smallint[]), :b, :u) "
        "on conflict (school_id) do update set weekly_offs = excluded.weekly_offs, lop_basis = excluded.lop_basis, "
        "unmarked_as = excluded.unmarked_as",
        {"s": ctx.school_id, "w": payload.weekly_offs, "b": payload.lop_basis, "u": payload.unmarked_as},
    )
    await write_audit(
        db,
        request,
        action="hr.settings_changed",
        entity_type="school",
        entity_id=str(ctx.school_id),
        school_id=ctx.school_id,
        metadata=payload.model_dump(),
    )
    await db.commit()
    return await _settings(db, ctx)


class HolidayIn(BaseModel):
    model_config = {"extra": "forbid"}
    holiday_on: date
    name: str = Field(min_length=2, max_length=80)
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _clean(v)))


@router.get("/holidays")
async def holidays(
    ctx: SchoolContext = ANY_HR,
    db: AsyncSession = Depends(get_db),
    year: int | None = Query(default=None, ge=2000, le=2100),
) -> list[dict]:
    y = year or today().year
    return _rows(
        await db.execute(
            text(
                "select id, holiday_on, name from public.staff_holidays where school_id = :s and extract(year from "
                "holiday_on) = :y order by holiday_on"
            ),
            {"s": ctx.school_id, "y": y},
        )
    )


@router.post("/holidays", status_code=status.HTTP_201_CREATED)
async def add_holiday(
    payload: HolidayIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    hid = (
        await _call(
            db,
            "insert into public.staff_holidays (school_id, holiday_on, name) values (:s, :d, :n) returning id",
            {"s": ctx.school_id, "d": payload.holiday_on, "n": payload.name},
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="hr.holiday_added",
        entity_type="staff_holiday",
        entity_id=str(hid),
        school_id=ctx.school_id,
        metadata={"date": payload.holiday_on.isoformat(), "name": payload.name},
    )
    await db.commit()
    return {"id": str(hid), "holiday_on": payload.holiday_on.isoformat(), "name": payload.name}


@router.delete("/holidays/{holiday_id}")
async def delete_holiday(
    holiday_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    r = await _call(
        db,
        "delete from public.staff_holidays where id = :id and school_id = :s",
        {"id": holiday_id, "s": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Holiday not found.")
    await write_audit(
        db,
        request,
        action="hr.holiday_removed",
        entity_type="staff_holiday",
        entity_id=str(holiday_id),
        school_id=ctx.school_id,
    )
    await db.commit()
    return {"ok": True}


# ------------------------------------------------------------------ leave types
class LeaveTypeIn(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=2, max_length=60)
    code: str = Field(min_length=1, max_length=6)
    annual_days: Decimal | None = Field(default=None, ge=0, le=366)
    is_paid: bool = True
    allow_half_day: bool = True
    is_active: bool = True
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @field_validator("code")
    @classmethod
    def _code(cls, v: str) -> str:
        v = v.strip().upper()
        if not re.fullmatch(r"[A-Z]{1,6}", v):
            raise ValueError("The code is 1–6 letters, e.g. CL.")
        return v

    @model_validator(mode="after")
    def _check(self) -> "LeaveTypeIn":
        _half(self.annual_days, "the yearly allowance")
        return self


@router.get("/leave-types")
async def leave_types(ctx: SchoolContext = ANY_HR, db: AsyncSession = Depends(get_db)) -> list[dict]:
    return _rows(
        await db.execute(
            text(
                "select id, name, code, annual_days, is_paid, allow_half_day, is_active, "
                "(select count(*) from public.leave_applications a where a.leave_type_id = t.id) as applications "
                "from public.leave_types t where school_id = :s order by not is_active, not is_paid, name"
            ),
            {"s": ctx.school_id},
        )
    )


@router.post("/leave-types", status_code=status.HTTP_201_CREATED)
async def add_leave_type(
    payload: LeaveTypeIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    v = payload.model_dump()
    tid = (
        await _call(
            db,
            f"insert into public.leave_types (school_id, {', '.join(v)}) "
            f"values (:school_id, {', '.join(':' + k for k in v)}) returning id",
            {**v, "school_id": ctx.school_id},
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="hr.leave_type_added",
        entity_type="leave_type",
        entity_id=str(tid),
        school_id=ctx.school_id,
        metadata={k: str(x) for k, x in v.items()},
    )
    await db.commit()
    return await leave_types(ctx, db)


@router.put("/leave-types/{type_id}")
async def update_leave_type(
    type_id: uuid.UUID,
    payload: LeaveTypeIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    v = payload.model_dump()
    r = await _call(
        db,
        "update public.leave_types set " + ", ".join(f"{k} = :{k}" for k in v) + " where id = :id and school_id = :s",
        {**v, "id": type_id, "s": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave type not found.")
    await write_audit(
        db,
        request,
        action="hr.leave_type_changed",
        entity_type="leave_type",
        entity_id=str(type_id),
        school_id=ctx.school_id,
        metadata={k: str(x) for k, x in v.items()},
    )
    await db.commit()
    return await leave_types(ctx, db)


# ------------------------------------------------------------------ leave applications
LEAVE_SELECT = """
select a.id, a.teacher_id, t.full_name as staff_name, t.employee_id, a.leave_type_id, lt.name as leave_type,
       lt.code as leave_code, lt.is_paid, a.academic_session_id, s.name as session_name, a.start_date, a.end_date,
       a.half_day, a.days, a.reason, a.status, a.applied_at, nullif(ap.full_name, '') as applied_by_name, a.applied_by,
       a.decided_at, nullif(dp.full_name, '') as decided_by_name, a.decision_note, a.cancelled_at
from public.leave_applications a
join public.teachers t on t.id = a.teacher_id
join public.leave_types lt on lt.id = a.leave_type_id
join public.academic_sessions s on s.id = a.academic_session_id
left join public.profiles ap on ap.id = a.applied_by
left join public.profiles dp on dp.id = a.decided_by
"""
LEAVE_CSV = [
    ("staff_name", "Staff", "text"),
    ("employee_id", "Employee ID", "text"),
    ("leave_type", "Leave type", "text"),
    ("start_date", "From", "text"),
    ("end_date", "To", "text"),
    ("days", "Days", "text"),
    ("status_label", "Status", "text"),
    ("reason", "Reason", "text"),
    ("decision_note", "Note", "text"),
    ("applied_at", "Applied on", "text"),
]


class LeaveIn(BaseModel):
    model_config = {"extra": "forbid"}
    leave_type_id: uuid.UUID
    start_date: date
    end_date: date
    half_day: bool = False
    reason: str = Field(min_length=3, max_length=500)
    teacher_id: uuid.UUID | None = None  # admins applying for someone
    _c = field_validator("reason", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _check(self) -> "LeaveIn":
        if self.end_date < self.start_date:
            raise ValueError("The leave ends before it starts.")
        if self.half_day and self.start_date != self.end_date:
            raise ValueError("A half day is for a single day.")
        return self


class DecideIn(BaseModel):
    model_config = {"extra": "forbid"}
    approve: bool
    note: str | None = Field(default=None, max_length=300)
    _c = field_validator("note", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _check(self) -> "DecideIn":
        if not self.approve and not self.note:
            raise ValueError("Give the reason for rejecting.")
        return self


class NoteIn(BaseModel):
    model_config = {"extra": "forbid"}
    note: str | None = Field(default=None, max_length=300)
    _c = field_validator("note", mode="before")(classmethod(lambda cls, v: _clean(v)))


async def _leave(db: AsyncSession, ctx: SchoolContext, leave_id: uuid.UUID) -> dict:
    r = (
        (
            await db.execute(
                text(f"{LEAVE_SELECT} where a.id = :id and a.school_id = :s"), {"id": leave_id, "s": ctx.school_id}
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Leave application not found.")
    return _json(dict(r))


async def _apply(
    db: AsyncSession, request: Request, ctx: SchoolContext, payload: LeaveIn, teacher_id: uuid.UUID | None
) -> dict:
    lid = (
        await _call(
            db,
            "select private.leave_apply(:s, :t, :lt, :a, :b, :h, :r)",
            {
                "s": ctx.school_id,
                "t": teacher_id,
                "lt": payload.leave_type_id,
                "a": payload.start_date,
                "b": payload.end_date,
                "h": payload.half_day,
                "r": payload.reason,
            },
        )
    ).scalar_one()
    out = await _leave(db, ctx, lid)
    await write_audit(
        db,
        request,
        action="leave.applied",
        entity_type="leave_application",
        entity_id=str(lid),
        school_id=ctx.school_id,
        metadata={
            "staff": out["staff_name"],
            "type": out["leave_code"],
            "from": out["start_date"],
            "to": out["end_date"],
            "days": out["days"],
        },
    )
    await db.commit()
    return out


@router.get("/leave-days")
async def leave_days(
    ctx: SchoolContext = ANY_HR,
    db: AsyncSession = Depends(get_db),
    start: date = Query(...),
    end: date = Query(...),
    half: bool = False,
) -> dict:
    """How many working days a leave would take (for the form)."""
    if end < start or (end - start).days > 366:
        return {"days": None}
    d = (
        await db.execute(
            text("select private.leave_days(:s, :a, :b, :h)"), {"s": ctx.school_id, "a": start, "b": end, "h": half}
        )
    ).scalar()
    return {"days": f"{Decimal(d).normalize():f}"}


@router.get("/my")
async def my_leave(
    ctx: SchoolContext = SELF, db: AsyncSession = Depends(get_db), session_id: uuid.UUID | None = None
) -> dict:
    staff = (
        (
            await db.execute(
                text("select id, full_name, employee_id from public.teachers where id = private.current_staff_id(:s)"),
                {"s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    session = await resolve_session(db, ctx, session_id)
    sessions = _rows(
        await db.execute(
            text(
                "select id, name, start_date, end_date, is_current from public.academic_sessions where school_id = "
                ":s order by start_date desc"
            ),
            {"s": ctx.school_id},
        )
    )
    if staff is None or session is None:
        return {"staff": None, "session": None, "sessions": sessions, "balances": [], "items": []}
    balances = _rows(
        await db.execute(
            text("select * from private.leave_balances(:s, :t, :ses)"),
            {"s": ctx.school_id, "t": staff["id"], "ses": session.id},
        )
    )
    items = _rows(
        await db.execute(
            text(
                f"{LEAVE_SELECT} where a.teacher_id = :t and a.academic_session_id = :ses order by a.start_date "
                "desc, a.applied_at desc"
            ),
            {"t": staff["id"], "ses": session.id},
        )
    )
    return {
        "staff": _json(dict(staff)),
        "session": {"id": str(session.id), "name": session.name},
        "sessions": sessions,
        "balances": balances,
        "items": items,
    }


@router.post("/my/leave", status_code=status.HTTP_201_CREATED)
async def apply_my_leave(
    payload: LeaveIn, request: Request, ctx: SchoolContext = SELF, db: AsyncSession = Depends(get_db)
) -> dict:
    if payload.teacher_id is not None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Apply for yourself here.")
    return await _apply(db, request, ctx, payload, None)


@router.post("/leave/{leave_id}/cancel")
async def cancel_leave(
    leave_id: uuid.UUID,
    payload: NoteIn,
    request: Request,
    ctx: SchoolContext = ANY_HR,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _call(db, "select private.leave_cancel(:id, :n)", {"id": leave_id, "n": payload.note})
    out = await _leave(db, ctx, leave_id)
    await write_audit(
        db,
        request,
        action="leave.cancelled",
        entity_type="leave_application",
        entity_id=str(leave_id),
        school_id=ctx.school_id,
        metadata={"note": payload.note},
    )
    await db.commit()
    return out


@router.get("/leave")
async def leave_list(
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
    status_: LeaveStatus | Literal["all"] = Query(default="pending", alias="status"),
    teacher_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    q: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=50, ge=1, le=200),
    format: Literal["json", "csv"] = "json",
) -> Any:
    where = ["a.school_id = :s"]
    p: dict[str, Any] = {"s": ctx.school_id}
    if status_ != "all":
        where.append("a.status = :st")
        p["st"] = status_
    if teacher_id:
        where.append("a.teacher_id = :t")
        p["t"] = teacher_id
    if session_id:
        where.append("a.academic_session_id = :ses")
        p["ses"] = session_id
    if q and q.strip():
        p["q"] = q.strip().lower()
        where.append("(lower(t.full_name) like '%' || :q || '%' or lower(t.employee_id) = :q)")
    w = " and ".join(where)
    order = "a.start_date asc, a.applied_at" if status_ == "pending" else "a.start_date desc, a.applied_at desc"
    if format == "csv":
        rows = [dict(r) for r in (await db.execute(text(f"{LEAVE_SELECT} where {w} order by {order}"), p)).mappings()]
        for r in rows:
            r["status_label"] = STATUS_LABEL[r["status"]]
            r["days"] = f"{r['days'].normalize():f}"
            r["applied_at"] = r["applied_at"].astimezone(IST).date()
        return Response(
            to_csv(LEAVE_CSV, rows),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="leave-{status_}.csv"'},
        )
    total = (
        await db.execute(
            text(
                "select count(*) from public.leave_applications a join public.teachers t on t.id = a.teacher_id "
                f"where {w}"
            ),
            p,
        )
    ).scalar_one()
    items = _rows(
        await db.execute(
            text(f"{LEAVE_SELECT} where {w} order by {order} limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    )
    pending = (
        await db.execute(
            text("select count(*) from public.leave_applications where school_id = :s and status = 'pending'"),
            {"s": ctx.school_id},
        )
    ).scalar_one()
    return {"items": items, "total": total, "page": page, "page_size": page_size, "pending": pending}


@router.post("/leave", status_code=status.HTTP_201_CREATED)
async def apply_for_staff(
    payload: LeaveIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    if payload.teacher_id is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose the staff member.")
    return await _apply(db, request, ctx, payload, payload.teacher_id)


@router.post("/leave/{leave_id}/decide")
async def decide(
    leave_id: uuid.UUID,
    payload: DecideIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _call(
        db, "select private.leave_decide(:id, :a, :n)", {"id": leave_id, "a": payload.approve, "n": payload.note}
    )
    out = await _leave(db, ctx, leave_id)
    await write_audit(
        db,
        request,
        action="leave.approved" if payload.approve else "leave.rejected",
        entity_type="leave_application",
        entity_id=str(leave_id),
        school_id=ctx.school_id,
        metadata={"staff": out["staff_name"], "days": out["days"], "note": payload.note},
    )
    await db.commit()
    return out


# ------------------------------------------------------------------ staff, balances
@router.get("/staff")
async def staff(ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> list[dict]:
    return _rows(
        await db.execute(
            text(
                "select id, full_name, employee_id, subject, joining_date, account_id is not null as has_login "
                "from public.teachers where school_id = :s and status = 'active' order by lower(full_name)"
            ),
            {"s": ctx.school_id},
        )
    )


@router.get("/balances")
async def balances(
    ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db), session_id: uuid.UUID | None = None
) -> dict:
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return {"session": None, "types": [], "staff": []}
    types = _rows(
        await db.execute(
            text(
                "select id, name, code, annual_days, is_paid from public.leave_types where school_id = :s and "
                "is_active order by not is_paid, name"
            ),
            {"s": ctx.school_id},
        )
    )
    cells = _rows(
        await db.execute(
            text(
                "select t.id as teacher_id, lt.id as leave_type_id, "
                "coalesce(al.days, lt.annual_days) as allowance, al.days is not null as overridden, "
                "coalesce(sum(a.days) filter (where a.status = 'approved'), 0) as used, "
                "coalesce(sum(a.days) filter (where a.status = 'pending'), 0) as pending "
                "from public.teachers t cross join public.leave_types lt "
                "left join public.leave_allocations al on al.teacher_id = t.id and al.leave_type_id = lt.id and "
                "al.academic_session_id = :ses "
                "left join public.leave_applications a on a.teacher_id = t.id and a.leave_type_id = lt.id and "
                "a.academic_session_id = :ses "
                "where t.school_id = :s and t.status = 'active' and lt.school_id = :s and lt.is_active "
                "group by t.id, lt.id, al.days, lt.annual_days"
            ),
            {"s": ctx.school_id, "ses": session.id},
        )
    )
    by_staff: dict[str, dict] = {}
    for c in cells:
        by_staff.setdefault(c["teacher_id"], {})[c["leave_type_id"]] = c
    people = await staff(ctx, db)
    return {
        "session": {"id": str(session.id), "name": session.name},
        "types": types,
        "staff": [{**s, "balances": by_staff.get(s["id"], {})} for s in people],
    }


class AllocationIn(BaseModel):
    model_config = {"extra": "forbid"}
    teacher_id: uuid.UUID
    leave_type_id: uuid.UUID
    session_id: uuid.UUID
    days: Decimal | None = Field(default=None, ge=0, le=366)  # none = back to the type's yearly allowance
    note: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _check(self) -> "AllocationIn":
        _half(self.days, "the allowance")
        return self


@router.put("/allocations")
async def set_allocation(
    payload: AllocationIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    p = {
        "s": ctx.school_id,
        "t": payload.teacher_id,
        "lt": payload.leave_type_id,
        "ses": payload.session_id,
        "d": payload.days,
        "n": _clean(payload.note),
    }
    if payload.days is None:
        await _call(
            db,
            "delete from public.leave_allocations where school_id = :s and teacher_id = :t and leave_type_id = :lt "
            "and academic_session_id = :ses",
            p,
        )
    else:
        await _call(
            db,
            "insert into public.leave_allocations (school_id, teacher_id, leave_type_id, academic_session_id, days, "
            "note) "
            "values (:s, :t, :lt, :ses, :d, :n) on conflict (teacher_id, leave_type_id, academic_session_id) "
            "do update set days = excluded.days, note = excluded.note",
            p,
        )
    await write_audit(
        db,
        request,
        action="leave.allowance_set",
        entity_type="teacher",
        entity_id=str(payload.teacher_id),
        school_id=ctx.school_id,
        metadata={"type": str(payload.leave_type_id), "days": str(payload.days)},
    )
    await db.commit()
    return {"ok": True}


@router.get("/staff/{teacher_id}/leave")
async def staff_leave(
    teacher_id: uuid.UUID,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = None,
) -> dict:
    person = (
        (
            await db.execute(
                text("select id, full_name, employee_id, status from public.teachers where id = :t and school_id = :s"),
                {"t": teacher_id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if person is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Staff member not found.")
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return {"staff": _json(dict(person)), "session": None, "balances": [], "items": []}
    return {
        "staff": _json(dict(person)),
        "session": {"id": str(session.id), "name": session.name},
        "balances": _rows(
            await db.execute(
                text("select * from private.leave_balances(:s, :t, :ses)"),
                {"s": ctx.school_id, "t": teacher_id, "ses": session.id},
            )
        ),
        "items": _rows(
            await db.execute(
                text(
                    f"{LEAVE_SELECT} where a.teacher_id = :t and a.academic_session_id = :ses order by a.start_date "
                    "desc"
                ),
                {"t": teacher_id, "ses": session.id},
            )
        ),
    }


# ------------------------------------------------------------------ staff attendance
AttendanceStatus = Literal["present", "absent", "half_day"]


class AttendanceEntry(BaseModel):
    model_config = {"extra": "forbid"}
    teacher_id: uuid.UUID
    status: AttendanceStatus | None = None  # none = clear the mark
    note: str | None = Field(default=None, max_length=200)


class AttendanceIn(BaseModel):
    model_config = {"extra": "forbid"}
    date: date
    entries: list[AttendanceEntry] = Field(min_length=1, max_length=1000)


@router.get("/attendance")
async def attendance_day(
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
    day: date | None = Query(default=None, alias="date"),
) -> dict:
    d = day or today()
    meta = (
        (
            await db.execute(
                text(
                    "select private.hr_working_day(:s, :d) as working, private.payroll_locked(:s, :d, :d) as locked, "
                    "(select name from public.staff_holidays where school_id = :s and holiday_on = :d) as holiday"
                ),
                {"s": ctx.school_id, "d": d},
            )
        )
        .mappings()
        .first()
    )
    rows = _rows(
        await db.execute(
            text(
                "select t.id as teacher_id, t.full_name, t.employee_id, t.joining_date, sa.status, sa.note, "
                "lv.id as leave_id, lv.code as leave_code, lv.name as leave_type, lv.half_day as leave_half_day, "
                "lv.is_paid as leave_paid "
                "from public.teachers t "
                "left join public.staff_attendance sa on sa.teacher_id = t.id and sa.attended_on = :d "
                "left join lateral (select a.id, lt.code, lt.name, a.half_day, lt.is_paid from "
                "public.leave_applications a "
                "  join public.leave_types lt on lt.id = a.leave_type_id where a.teacher_id = t.id and a.status = "
                "'approved' "
                "  and :d between a.start_date and a.end_date limit 1) lv on true "
                "where t.school_id = :s and t.status = 'active' and t.joining_date <= :d order by lower(t.full_name)"
            ),
            {"s": ctx.school_id, "d": d},
        )
    )
    return {
        "date": d.isoformat(),
        "working": meta["working"],
        "holiday": meta["holiday"],
        "locked": meta["locked"],
        "future": d > today(),
        "items": rows,
    }


@router.put("/attendance")
async def mark_attendance(
    payload: AttendanceIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    marked = cleared = 0
    for e in payload.entries:
        p = {"s": ctx.school_id, "t": e.teacher_id, "d": payload.date, "st": e.status, "n": _clean(e.note)}
        if e.status is None:
            r = await _call(
                db,
                "delete from public.staff_attendance where school_id = :s and teacher_id = :t and attended_on = :d",
                p,
            )
            cleared += r.rowcount
        else:
            await _call(
                db,
                "insert into public.staff_attendance (school_id, teacher_id, attended_on, status, note, marked_by) "
                "values (:s, :t, :d, :st, :n, auth.uid()) on conflict (teacher_id, attended_on) "
                "do update set status = excluded.status, note = excluded.note, marked_by = excluded.marked_by, "
                "marked_at = now()",
                p,
            )
            marked += 1
    await write_audit(
        db,
        request,
        action="hr.attendance_marked",
        entity_type="school",
        entity_id=str(ctx.school_id),
        school_id=ctx.school_id,
        metadata={"date": payload.date.isoformat(), "marked": marked, "cleared": cleared},
    )
    await db.commit()
    return await attendance_day(ctx, db, payload.date)


@router.get("/attendance/month")
async def attendance_month(
    ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db), month: date | None = None
) -> dict:
    """Per staff member: present / absent / half days / leave in a month (as payroll will count them)."""
    m = (month or today()).replace(day=1)
    end = (m.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    rows = _rows(
        await db.execute(
            text(
                "select t.id as teacher_id, t.full_name, t.employee_id, "
                "count(*) filter (where sa.status = 'present') as present_days, "
                "count(*) filter (where sa.status = 'absent') as absent_days, "
                "count(*) filter (where sa.status = 'half_day') as half_days "
                "from public.teachers t left join public.staff_attendance sa on sa.teacher_id = t.id and "
                "sa.attended_on between :a and :b "
                "where t.school_id = :s and t.status = 'active' group by t.id order by lower(t.full_name)"
            ),
            {"s": ctx.school_id, "a": m, "b": end},
        )
    )
    return {"month": m.isoformat(), "items": rows}
