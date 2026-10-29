"""Payroll: salary components (allowances and deductions), each staff member's salary structure,
the monthly payroll run, payslips with adjustments, salary slip PDFs and the salary register.

School admins only. Every endpoint requires payroll:manage, and the database's row-level
security returns nothing to anyone else even if application code were wrong (migration 0025).
The calculation runs in the database (private.payroll_generate): working days, attendance,
approved leave (paid / unpaid), loss of pay, earnings, deductions and net pay.
"""

import re
import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes.collection import _logo
from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services.audit import write_audit
from app.services.exports import to_csv
from app.services.payslips import PayslipData, build_payslip_pdf

router = APIRouter(prefix="/payroll", tags=["payroll"])
PAYROLL = Depends(require_permission(Permission.PAYROLL_MANAGE))
IST = ZoneInfo("Asia/Kolkata")
UNIQUE = {
    "salary_components_name_key": "A component with this name already exists.",
    "salary_structures_one_per_month": (
        "This staff member already has a salary structure from that month. Edit it instead."
    ),
    "salary_structure_items_one": "A component can be added only once.",
    "payroll_runs_one_per_month": "Payroll for this month already exists.",
}
MODE_LABEL = {"bank_transfer": "bank transfer", "cheque": "cheque", "cash": "cash", "upi": "UPI"}
MONEY = Decimal("10000000")


def today() -> date:
    return datetime.now(IST).date()


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = re.sub(r"\s+", " ", v).strip()
        return v or None
    return v


DAY_KEYS = ("days", "lop_days")


def _json(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, uuid.UUID):
            v = str(v)
        elif isinstance(v, datetime | date):
            v = v.isoformat()
        elif isinstance(v, Decimal):
            v = f"{v.normalize():f}" if k.endswith(DAY_KEYS) else f"{v:.2f}"
        out[k] = v
    return out


def _rows(result: Any) -> list[dict]:
    return [_json(dict(r)) for r in result.mappings()]


async def _call(db: AsyncSession, sql: str, params: dict[str, Any]) -> Any:
    try:
        return await db.execute(text(sql), params)
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None


def _money(v: Decimal | None) -> Decimal | None:
    if v is not None and v.as_tuple().exponent < -2:  # type: ignore[operator]
        raise ValueError("Enter amounts in rupees with at most 2 decimals.")
    return v


# ------------------------------------------------------------------ components
class ComponentIn(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=2, max_length=60)
    kind: Literal["earning", "deduction"]
    calc: Literal["fixed", "percent_basic"] = "fixed"
    default_value: Decimal = Field(default=Decimal(0), ge=0, le=MONEY)
    is_active: bool = True
    display_order: int = Field(default=0, ge=0, le=999)
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _check(self) -> "ComponentIn":
        _money(self.default_value)
        if self.calc == "percent_basic" and self.default_value > 100:
            raise ValueError("A percentage of basic is at most 100.")
        return self


@router.get("/components")
async def components(ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)) -> list[dict]:
    return _rows(
        await db.execute(
            text(
                "select c.id, c.name, c.kind, c.calc, c.default_value, c.is_active, c.display_order, "
                "(select count(*) from public.salary_structure_items i where i.component_id = c.id) as used "
                "from public.salary_components c where c.school_id = :s order by c.kind, not c.is_active, "
                "c.display_order, c.name"
            ),
            {"s": ctx.school_id},
        )
    )


@router.post("/components", status_code=status.HTTP_201_CREATED)
async def add_component(
    payload: ComponentIn, request: Request, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    v = payload.model_dump()
    cid = (
        await _call(
            db,
            f"insert into public.salary_components (school_id, {', '.join(v)}) "
            f"values (:school_id, {', '.join(':' + k for k in v)}) returning id",
            {**v, "school_id": ctx.school_id},
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="payroll.component_added",
        entity_type="salary_component",
        entity_id=str(cid),
        school_id=ctx.school_id,
        metadata={k: str(x) for k, x in v.items()},
    )
    await db.commit()
    return await components(ctx, db)


@router.put("/components/{component_id}")
async def update_component(
    component_id: uuid.UUID,
    payload: ComponentIn,
    request: Request,
    ctx: SchoolContext = PAYROLL,
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    v = payload.model_dump()
    r = await _call(
        db,
        "update public.salary_components set "
        + ", ".join(f"{k} = :{k}" for k in v)
        + " where id = :id and school_id = :s",
        {**v, "id": component_id, "s": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Component not found.")
    await write_audit(
        db,
        request,
        action="payroll.component_changed",
        entity_type="salary_component",
        entity_id=str(component_id),
        school_id=ctx.school_id,
        metadata={k: str(x) for k, x in v.items()},
    )
    await db.commit()
    return await components(ctx, db)


# ------------------------------------------------------------------ salary structures
class ItemIn(BaseModel):
    model_config = {"extra": "forbid"}
    component_id: uuid.UUID
    calc: Literal["fixed", "percent_basic"]
    value: Decimal = Field(ge=0, le=MONEY)

    @model_validator(mode="after")
    def _check(self) -> "ItemIn":
        _money(self.value)
        if self.calc == "percent_basic" and self.value > 100:
            raise ValueError("A percentage of basic is at most 100.")
        return self


class StructureIn(BaseModel):
    model_config = {"extra": "forbid"}
    effective_from: date
    basic: Decimal = Field(ge=0, le=MONEY)
    note: str | None = Field(default=None, max_length=200)
    items: list[ItemIn] = Field(default_factory=list, max_length=40)
    _c = field_validator("note", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @field_validator("effective_from")
    @classmethod
    def _month(cls, v: date) -> date:
        return v.replace(day=1)

    @model_validator(mode="after")
    def _check(self) -> "StructureIn":
        _money(self.basic)
        ids = [i.component_id for i in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("A component can be added only once.")
        return self


def _amount(calc: str, value: Decimal, basic: Decimal) -> Decimal:
    return value if calc == "fixed" else (basic * value / 100).quantize(Decimal("0.01"))


async def _structures(db: AsyncSession, teacher_id: uuid.UUID) -> list[dict]:
    rows = _rows(
        await db.execute(
            text(
                "select s.id, s.effective_from, s.basic, s.note, s.created_at, "
                "exists (select 1 from public.payslips p join public.payroll_runs r on r.id = p.run_id "
                "        where p.structure_id = s.id and r.status <> 'draft') as locked "
                "from public.salary_structures s where s.teacher_id = :t order by s.effective_from desc"
            ),
            {"t": teacher_id},
        )
    )
    items = _rows(
        await db.execute(
            text(
                "select i.structure_id, i.component_id, c.name, c.kind, i.calc, i.value from "
                "public.salary_structure_items i "
                "join public.salary_components c on c.id = i.component_id join public.salary_structures s on s.id = "
                "i.structure_id "
                "where s.teacher_id = :t order by c.kind, c.display_order, c.name"
            ),
            {"t": teacher_id},
        )
    )
    for s in rows:
        basic = Decimal(s["basic"])
        s["items"] = [i for i in items if i["structure_id"] == s["id"]]
        earn = basic + sum(
            (_amount(i["calc"], Decimal(i["value"]), basic) for i in s["items"] if i["kind"] == "earning"), Decimal(0)
        )
        ded = sum(
            (_amount(i["calc"], Decimal(i["value"]), basic) for i in s["items"] if i["kind"] == "deduction"), Decimal(0)
        )
        for i in s["items"]:
            i["amount"] = f"{_amount(i['calc'], Decimal(i['value']), basic):.2f}"
        s["gross"], s["deductions"], s["net"] = f"{earn:.2f}", f"{ded:.2f}", f"{earn - ded:.2f}"
    return rows


@router.get("/staff")
async def staff(ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Active staff with the salary structure in force today (if any)."""
    rows = _rows(
        await db.execute(
            text(
                "select t.id, t.full_name, t.employee_id, t.subject, t.joining_date, s.id as structure_id, "
                "s.effective_from, s.basic "
                "from public.teachers t left join lateral (select * from public.salary_structures x where "
                "x.teacher_id = t.id "
                "  and x.effective_from <= :today order by x.effective_from desc limit 1) s on true "
                "where t.school_id = :s and t.status = 'active' order by lower(t.full_name)"
            ),
            {"s": ctx.school_id, "today": today()},
        )
    )
    gross = _rows(
        await db.execute(
            text(
                "select i.structure_id, coalesce(sum(case when c.kind = 'earning' then case when i.calc = 'fixed' "
                "then i.value "
                "  else round(s.basic * i.value / 100, 2) end end), 0) as earn, "
                "coalesce(sum(case when c.kind = 'deduction' then case when i.calc = 'fixed' then i.value "
                "  else round(s.basic * i.value / 100, 2) end end), 0) as ded "
                "from public.salary_structure_items i join public.salary_components c on c.id = i.component_id "
                "join public.salary_structures s on s.id = i.structure_id where s.school_id = :s group by "
                "i.structure_id"
            ),
            {"s": ctx.school_id},
        )
    )
    g = {x["structure_id"]: x for x in gross}
    for r in rows:
        if r["structure_id"]:
            x = g.get(r["structure_id"], {"earn": "0", "ded": "0"})
            r["gross"] = f"{Decimal(r['basic']) + Decimal(x['earn']):.2f}"
            r["net"] = f"{Decimal(r['gross']) - Decimal(x['ded']):.2f}"
    return rows


async def _person(db: AsyncSession, ctx: SchoolContext, teacher_id: uuid.UUID) -> dict:
    r = (
        (
            await db.execute(
                text(
                    "select id, full_name, employee_id, subject, joining_date, status from public.teachers where id "
                    "= :t and school_id = :s"
                ),
                {"t": teacher_id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Staff member not found.")
    return _json(dict(r))


@router.get("/staff/{teacher_id}")
async def staff_salary(teacher_id: uuid.UUID, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)) -> dict:
    person = await _person(db, ctx, teacher_id)
    slips = _rows(
        await db.execute(
            text(
                "select p.id, p.month, p.gross_earned, p.total_deductions, p.adjustments_total, p.net_pay, "
                "p.lop_days, r.status, r.id as run_id "
                "from public.payslips p join public.payroll_runs r on r.id = p.run_id where p.teacher_id = :t order "
                "by p.month desc limit 24"
            ),
            {"t": teacher_id},
        )
    )
    return {"staff": person, "structures": await _structures(db, teacher_id), "payslips": slips}


async def _write_items(db: AsyncSession, ctx: SchoolContext, structure_id: uuid.UUID, items: list[ItemIn]) -> None:
    await _call(db, "delete from public.salary_structure_items where structure_id = :id", {"id": structure_id})
    for i in items:
        await _call(
            db,
            "insert into public.salary_structure_items (school_id, structure_id, component_id, calc, value) values "
            "(:s, :st, :c, :calc, :v)",
            {"s": ctx.school_id, "st": structure_id, "c": i.component_id, "calc": i.calc, "v": i.value},
        )


@router.post("/staff/{teacher_id}/structures", status_code=status.HTTP_201_CREATED)
async def add_structure(
    teacher_id: uuid.UUID,
    payload: StructureIn,
    request: Request,
    ctx: SchoolContext = PAYROLL,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _person(db, ctx, teacher_id)
    sid = (
        await _call(
            db,
            "insert into public.salary_structures (school_id, teacher_id, effective_from, basic, note, created_by) "
            "values (:s, :t, :f, :b, :n, auth.uid()) returning id",
            {"s": ctx.school_id, "t": teacher_id, "f": payload.effective_from, "b": payload.basic, "n": payload.note},
        )
    ).scalar_one()
    await _write_items(db, ctx, sid, payload.items)
    await write_audit(
        db,
        request,
        action="payroll.structure_added",
        entity_type="teacher",
        entity_id=str(teacher_id),
        school_id=ctx.school_id,
        metadata={
            "from": payload.effective_from.isoformat(),
            "basic": str(payload.basic),
            "components": len(payload.items),
        },
    )
    await db.commit()
    return await staff_salary(teacher_id, ctx, db)


async def _structure_owner(db: AsyncSession, ctx: SchoolContext, structure_id: uuid.UUID) -> uuid.UUID:
    t = (
        await db.execute(
            text("select teacher_id from public.salary_structures where id = :id and school_id = :s"),
            {"id": structure_id, "s": ctx.school_id},
        )
    ).scalar()
    if t is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Salary structure not found.")
    return t


@router.put("/structures/{structure_id}")
async def update_structure(
    structure_id: uuid.UUID,
    payload: StructureIn,
    request: Request,
    ctx: SchoolContext = PAYROLL,
    db: AsyncSession = Depends(get_db),
) -> dict:
    teacher_id = await _structure_owner(db, ctx, structure_id)
    await _call(
        db,
        "update public.salary_structures set effective_from = :f, basic = :b, note = :n where id = :id",
        {"id": structure_id, "f": payload.effective_from, "b": payload.basic, "n": payload.note},
    )
    await _write_items(db, ctx, structure_id, payload.items)
    await write_audit(
        db,
        request,
        action="payroll.structure_changed",
        entity_type="teacher",
        entity_id=str(teacher_id),
        school_id=ctx.school_id,
        metadata={
            "structure": str(structure_id),
            "from": payload.effective_from.isoformat(),
            "basic": str(payload.basic),
        },
    )
    await db.commit()
    return await staff_salary(teacher_id, ctx, db)


@router.delete("/structures/{structure_id}")
async def delete_structure(
    structure_id: uuid.UUID, request: Request, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)
) -> dict:
    teacher_id = await _structure_owner(db, ctx, structure_id)
    # (a draft payslip may still name it; recalculating the draft picks the structure now in force)
    await _call(db, "delete from public.salary_structures where id = :id", {"id": structure_id})
    await write_audit(
        db,
        request,
        action="payroll.structure_removed",
        entity_type="teacher",
        entity_id=str(teacher_id),
        school_id=ctx.school_id,
        metadata={"structure": str(structure_id)},
    )
    await db.commit()
    return await staff_salary(teacher_id, ctx, db)


# ------------------------------------------------------------------ monthly payroll
RUN_SELECT = """
select r.id, r.month, r.status, r.generated_at, r.finalized_at, nullif(fp.full_name, '') as finalized_by_name,
       r.paid_on, r.payment_mode, r.payment_reference, r.reopen_note, count(p.id) as staff,
       coalesce(sum(p.gross_earned), 0) as gross, coalesce(sum(p.total_deductions), 0) as deductions,
       coalesce(sum(p.adjustments_total), 0) as adjustments, coalesce(sum(p.net_pay), 0) as net,
       coalesce(sum(p.lop_amount), 0) as lop
from public.payroll_runs r
left join public.payslips p on p.run_id = r.id
left join public.profiles fp on fp.id = r.finalized_by
"""
RUN_GROUP = " group by r.id, fp.full_name"
SLIP_COLS = (
    "p.id, p.teacher_id, p.employee_id, p.staff_name, p.basic, p.gross_full, p.gross_earned, p.lop_days, p.lop_amount, "
    "p.total_deductions, p.adjustments_total, p.net_pay, p.working_days, p.present_days, p.absent_days, p.half_days, "
    "p.paid_leave_days, p.unpaid_leave_days, p.unmarked_days, p.not_joined_days"
)


class MonthIn(BaseModel):
    model_config = {"extra": "forbid"}
    month: date

    @field_validator("month")
    @classmethod
    def _sensible(cls, v: date) -> date:
        # year 1 or 9999 reached the database as an impossible date range (a 500); a payroll month is
        # from 2000 up to next year
        if not date(2000, 1, 1) <= v <= date(date.today().year + 1, 12, 31):
            raise ValueError("Choose a month between 2000 and next year.")
        return v


class StatusIn(BaseModel):
    model_config = {"extra": "forbid"}
    note: str | None = Field(default=None, max_length=300)
    paid_on: date | None = None
    payment_mode: Literal["bank_transfer", "cheque", "cash", "upi"] | None = None
    payment_reference: str | None = Field(default=None, max_length=80)


class AdjustmentIn(BaseModel):
    model_config = {"extra": "forbid"}
    label: str = Field(min_length=2, max_length=80)
    amount: Decimal = Field(ge=-MONEY, le=MONEY)
    _c = field_validator("label", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _check(self) -> "AdjustmentIn":
        _money(self.amount)
        if self.amount == 0:
            raise ValueError("Enter an amount: positive to add, negative to recover.")
        return self


@router.get("/runs")
async def runs(ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)) -> dict:
    items = _rows(
        await db.execute(
            text(f"{RUN_SELECT} where r.school_id = :s {RUN_GROUP} order by r.month desc"), {"s": ctx.school_id}
        )
    )
    missing = (
        await db.execute(
            text(
                "select count(*) from public.teachers t where t.school_id = :s and t.status = 'active' "
                "and not exists (select 1 from public.salary_structures x where x.teacher_id = t.id)"
            ),
            {"s": ctx.school_id},
        )
    ).scalar_one()
    return {"items": items, "staff_without_salary": missing, "this_month": today().replace(day=1).isoformat()}


async def _run(db: AsyncSession, ctx: SchoolContext, run_id: uuid.UUID) -> dict:
    r = (
        (
            await db.execute(
                text(f"{RUN_SELECT} where r.id = :id and r.school_id = :s {RUN_GROUP}"),
                {"id": run_id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payroll not found.")
    run = _json(dict(r))
    run["payslips"] = _rows(
        await db.execute(
            text(f"select {SLIP_COLS} from public.payslips p where p.run_id = :id order by lower(p.staff_name)"),
            {"id": run_id},
        )
    )
    month = date.fromisoformat(run["month"])
    end = (month.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    run["month_end"] = end.isoformat()
    run["can_finalize_from"] = end.isoformat()
    run["without_salary"] = _rows(
        await db.execute(
            text(
                "select t.id, t.full_name, t.employee_id from public.teachers t where t.school_id = :s and t.status "
                "= 'active' "
                "and t.joining_date <= :end and not exists (select 1 from public.salary_structures x where "
                "x.teacher_id = t.id "
                "and x.effective_from <= :end) order by lower(t.full_name)"
            ),
            {"s": ctx.school_id, "end": end},
        )
    )
    run["pending_leave"] = (
        await db.execute(
            text(
                "select count(*) from public.leave_applications where school_id = :s and status = 'pending' and "
                "start_date <= :end and end_date >= :m"
            ),
            {"s": ctx.school_id, "end": end, "m": month},
        )
    ).scalar_one()
    return run


@router.post("/runs", status_code=status.HTTP_201_CREATED)
async def generate(
    payload: MonthIn, request: Request, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)
) -> dict:
    month = payload.month.replace(day=1)
    rid = (await _call(db, "select private.payroll_generate(:s, :m)", {"s": ctx.school_id, "m": month})).scalar_one()
    await write_audit(
        db,
        request,
        action="payroll.calculated",
        entity_type="payroll_run",
        entity_id=str(rid),
        school_id=ctx.school_id,
        metadata={"month": month.isoformat()},
    )
    await db.commit()
    return await _run(db, ctx, rid)


@router.get("/runs/{run_id}")
async def run(run_id: uuid.UUID, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)) -> dict:
    return await _run(db, ctx, run_id)


@router.post("/runs/{run_id}/recalculate")
async def recalculate(
    run_id: uuid.UUID, request: Request, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)
) -> dict:
    r = await _run(db, ctx, run_id)
    return await generate(MonthIn(month=date.fromisoformat(r["month"])), request, ctx, db)


@router.post("/runs/{run_id}/{action}")
async def set_status(
    run_id: uuid.UUID,
    action: Literal["finalize", "reopen", "paid"],
    payload: StatusIn,
    request: Request,
    ctx: SchoolContext = PAYROLL,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _run(db, ctx, run_id)
    await _call(
        db,
        "select private.payroll_set_status(:id, :a, :d, :m, :ref, :n)",
        {
            "id": run_id,
            "a": action,
            "d": payload.paid_on,
            "m": payload.payment_mode,
            "ref": _clean(payload.payment_reference),
            "n": _clean(payload.note),
        },
    )
    await write_audit(
        db,
        request,
        action=f"payroll.{action}",
        entity_type="payroll_run",
        entity_id=str(run_id),
        school_id=ctx.school_id,
        metadata={k: str(v) for k, v in payload.model_dump().items() if v is not None},
    )
    await db.commit()
    return await _run(db, ctx, run_id)


@router.delete("/runs/{run_id}")
async def discard(
    run_id: uuid.UUID, request: Request, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)
) -> dict:
    r = await _run(db, ctx, run_id)
    if r["status"] != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "Only a draft payroll can be discarded.")
    await _call(db, "delete from public.payroll_runs where id = :id", {"id": run_id})
    await write_audit(
        db,
        request,
        action="payroll.discarded",
        entity_type="payroll_run",
        entity_id=str(run_id),
        school_id=ctx.school_id,
        metadata={"month": r["month"]},
    )
    await db.commit()
    return {"ok": True}


REGISTER_CSV = [
    ("employee_id", "Employee ID", "text"),
    ("staff_name", "Name", "text"),
    ("working_days", "Working days", "text"),
    ("lop_days", "Loss-of-pay days", "text"),
    ("gross_full", "Gross (full month)", "money"),
    ("lop_amount", "Leave / absence deduction", "money"),
    ("gross_earned", "Gross earned", "money"),
    ("total_deductions", "Deductions", "money"),
    ("adjustments_total", "Adjustments", "money"),
    ("net_pay", "Net pay", "money"),
]


@router.get("/runs/{run_id}/register.csv")
async def register(
    run_id: uuid.UUID, request: Request, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)
) -> Response:
    r = await _run(db, ctx, run_id)
    rows = [
        dict(x)
        for x in (
            await db.execute(
                text(f"select {SLIP_COLS} from public.payslips p where p.run_id = :id order by lower(p.staff_name)"),
                {"id": run_id},
            )
        ).mappings()
    ]
    for x in rows:
        x["lop_days"] = f"{x['lop_days'].normalize():f}"
    await write_audit(
        db,
        request,
        action="payroll.register_downloaded",
        entity_type="payroll_run",
        entity_id=str(run_id),
        school_id=ctx.school_id,
    )
    await db.commit()
    return Response(
        to_csv(REGISTER_CSV, rows),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="salary-register-{r["month"][:7]}.csv"'},
    )


# ------------------------------------------------------------------ payslips
async def _slip(db: AsyncSession, ctx: SchoolContext, payslip_id: uuid.UUID) -> dict:
    r = (
        (
            await db.execute(
                text(
                    "select p.*, r.status as run_status, r.paid_on, r.payment_mode, t.subject, t.joining_date "
                    "from public.payslips p join public.payroll_runs r on r.id = p.run_id join public.teachers t on "
                    "t.id = p.teacher_id "
                    "where p.id = :id and p.school_id = :s"
                ),
                {"id": payslip_id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Payslip not found.")
    out = _json(dict(r))
    out["adjustments"] = _rows(
        await db.execute(
            text(
                "select a.id, a.label, a.amount, a.created_at, nullif(pr.full_name, '') as created_by_name from "
                "public.payslip_adjustments a "
                "left join public.profiles pr on pr.id = a.created_by where a.payslip_id = :id order by a.created_at"
            ),
            {"id": payslip_id},
        )
    )
    return out


@router.get("/payslips/{payslip_id}")
async def payslip(payslip_id: uuid.UUID, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)) -> dict:
    return await _slip(db, ctx, payslip_id)


@router.post("/payslips/{payslip_id}/adjustments", status_code=status.HTTP_201_CREATED)
async def add_adjustment(
    payslip_id: uuid.UUID,
    payload: AdjustmentIn,
    request: Request,
    ctx: SchoolContext = PAYROLL,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _slip(db, ctx, payslip_id)
    await _call(
        db, "select private.payroll_adjust(:p, :l, :a)", {"p": payslip_id, "l": payload.label, "a": payload.amount}
    )
    await write_audit(
        db,
        request,
        action="payroll.adjusted",
        entity_type="payslip",
        entity_id=str(payslip_id),
        school_id=ctx.school_id,
        metadata={"label": payload.label, "amount": str(payload.amount)},
    )
    await db.commit()
    return await _slip(db, ctx, payslip_id)


@router.delete("/adjustments/{adjustment_id}")
async def remove_adjustment(
    adjustment_id: uuid.UUID, request: Request, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)
) -> dict:
    pid = (
        await db.execute(
            text("select payslip_id from public.payslip_adjustments where id = :id and school_id = :s"),
            {"id": adjustment_id, "s": ctx.school_id},
        )
    ).scalar()
    if pid is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Adjustment not found.")
    await _call(db, "select private.payroll_remove_adjustment(:id)", {"id": adjustment_id})
    await write_audit(
        db,
        request,
        action="payroll.adjustment_removed",
        entity_type="payslip",
        entity_id=str(pid),
        school_id=ctx.school_id,
    )
    await db.commit()
    return await _slip(db, ctx, pid)


@router.get("/payslips/{payslip_id}/pdf")
async def payslip_pdf(
    payslip_id: uuid.UUID, request: Request, ctx: SchoolContext = PAYROLL, db: AsyncSession = Depends(get_db)
) -> Response:
    s = await _slip(db, ctx, payslip_id)
    school = (
        await db.execute(
            text("select name, address, city, state, postal_code, logo_url from public.schools where id = :s"),
            {"s": ctx.school_id},
        )
    ).first()
    address = ", ".join(x for x in (school[1], school[2], school[3], school[4]) if x)
    pdf = build_payslip_pdf(
        PayslipData(
            school_name=school[0],
            school_address=address,
            logo_png=await _logo(school[5]),
            month=date.fromisoformat(s["month"]),
            status=s["run_status"],
            staff_name=s["staff_name"],
            employee_id=s["employee_id"],
            designation=s["subject"],
            joining_date=date.fromisoformat(s["joining_date"]) if s["joining_date"] else None,
            earnings=s["earnings"],
            deductions=s["deductions"],
            adjustments=s["adjustments"],
            gross_full=Decimal(s["gross_full"]),
            gross_earned=Decimal(s["gross_earned"]),
            lop_days=Decimal(s["lop_days"]),
            lop_amount=Decimal(s["lop_amount"]),
            total_deductions=Decimal(s["total_deductions"]),
            net_pay=Decimal(s["net_pay"]),
            days={
                k: Decimal(s[k])
                for k in (
                    "calendar_days",
                    "working_days",
                    "basis_days",
                    "present_days",
                    "absent_days",
                    "half_days",
                    "paid_leave_days",
                    "unpaid_leave_days",
                    "unmarked_days",
                    "not_joined_days",
                )
            },
            paid_on=date.fromisoformat(s["paid_on"]) if s["paid_on"] else None,
            payment_mode=MODE_LABEL.get(s["payment_mode"] or ""),
            generated_at=datetime.now(UTC),
        )
    )
    await write_audit(
        db,
        request,
        action="payroll.payslip_downloaded",
        entity_type="payslip",
        entity_id=str(payslip_id),
        school_id=ctx.school_id,
    )
    await db.commit()
    name = re.sub(r"[^A-Za-z0-9]+", "-", s["staff_name"]).strip("-").lower()
    return Response(
        pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="salary-slip-{s["month"][:7]}-{name}.pdf"',
            "Cache-Control": "no-store",
        },
    )
