"""Fee schemas. Money is Decimal end to end and serialised as a string
(e.g. "1500.00"), so no amount ever passes through floating point."""

import uuid
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, field_validator, model_validator

Frequency = Literal["monthly", "quarterly", "half_yearly", "yearly", "one_time"]
Money = Annotated[Decimal, PlainSerializer(lambda v: f"{v:.2f}", return_type=str, when_used="json")]
MAX_AMOUNT = Decimal("10000000")


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


def check_amount(v: Decimal) -> Decimal:
    if not v.is_finite():
        raise ValueError("Enter a valid amount.")
    if v <= 0:
        raise ValueError("The amount must be more than zero.")
    if v > MAX_AMOUNT:
        raise ValueError("The amount is too large.")
    if v != v.quantize(Decimal("0.01")):
        raise ValueError("Amounts can have at most 2 decimal places.")
    return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def check_months(v: list[int] | None) -> list[int] | None:
    if v is None:
        return None
    if not v:
        raise ValueError("Choose at least one month, or leave months empty for every month.")
    if any(m < 1 or m > 12 for m in v):
        raise ValueError("Months are numbered 1 to 12.")
    return sorted(set(v))


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------------- fee heads ----------------
class FeeHeadCreate(_Strict):
    name: str = Field(min_length=2, max_length=60)
    description: str | None = Field(default=None, max_length=200)

    _c = field_validator("name", "description", mode="before")(classmethod(lambda cls, v: _clean(v)))


class FeeHeadBulk(_Strict):
    names: list[str] = Field(min_length=1, max_length=30)

    @field_validator("names")
    @classmethod
    def _names(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for n in v:
            n = " ".join(n.split())
            if not 2 <= len(n) <= 60:
                raise ValueError("Fee head names must be 2 to 60 characters.")
            if n.casefold() not in {x.casefold() for x in out}:
                out.append(n)
        return out


class FeeHeadUpdate(_Strict):
    name: str | None = Field(default=None, min_length=2, max_length=60)
    description: str | None = Field(default=None, max_length=200)
    is_active: bool | None = None

    _c = field_validator("name", "description", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _req(self) -> "FeeHeadUpdate":
        for f in ("name", "is_active"):
            if f in self.model_fields_set and getattr(self, f) is None:
                raise ValueError(f"{f.replace('_', ' ')} cannot be empty")
        return self


class FeeHeadOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    is_active: bool
    used_in: int = Field(description="Number of fee structures using this head")


# ---------------- items ----------------
class _ItemRules(_Strict):
    @model_validator(mode="after")
    def _frequency_rules(self):  # type: ignore[no-untyped-def]
        freq = getattr(self, "frequency", None)
        if freq is not None and freq != "monthly" and getattr(self, "billing_months", None):
            raise ValueError("Months can only be chosen for monthly fees.")
        if freq == "monthly" and getattr(self, "due_month", None):
            raise ValueError("Monthly fees don't have a due month; choose the billed months instead.")
        return self


class FeeItemCreate(_ItemRules):
    fee_head_id: uuid.UUID
    amount: Decimal
    frequency: Frequency
    is_optional: bool = False
    billing_months: list[int] | None = None
    due_month: int | None = Field(default=None, ge=1, le=12)

    _a = field_validator("amount")(classmethod(lambda cls, v: check_amount(v)))
    _m = field_validator("billing_months")(classmethod(lambda cls, v: check_months(v)))


class FeeItemUpdate(_ItemRules):
    fee_head_id: uuid.UUID | None = None
    amount: Decimal | None = None
    frequency: Frequency | None = None
    is_optional: bool | None = None
    billing_months: list[int] | None = None
    due_month: int | None = Field(default=None, ge=1, le=12)
    sort_order: int | None = Field(default=None, ge=0, le=999)

    @field_validator("amount")
    @classmethod
    def _a(cls, v: Decimal | None) -> Decimal | None:
        return None if v is None else check_amount(v)

    _m = field_validator("billing_months")(classmethod(lambda cls, v: check_months(v)))

    @model_validator(mode="after")
    def _req(self) -> "FeeItemUpdate":
        for f in ("fee_head_id", "amount", "frequency", "is_optional", "sort_order"):
            if f in self.model_fields_set and getattr(self, f) is None:
                raise ValueError(f"{f.replace('_', ' ')} cannot be empty")
        return self


class FeeItemOut(BaseModel):
    id: uuid.UUID
    fee_head_id: uuid.UUID
    fee_head_name: str
    amount: Money
    frequency: Frequency
    is_optional: bool
    billing_months: list[int] | None
    due_month: int | None
    sort_order: int
    occurrences: int = Field(description="Times this fee falls due in the session (computed in the database)")
    annual_amount: Money = Field(description="amount × occurrences (computed in the database)")
    due_months: list[date]


# ---------------- structures ----------------
class FeeStructureCreate(_Strict):
    academic_session_id: uuid.UUID
    class_id: uuid.UUID
    name: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=500)

    _c = field_validator("name", "notes", mode="before")(classmethod(lambda cls, v: _clean(v)))


class FeeStructureUpdate(_Strict):
    name: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=500)
    is_active: bool | None = None

    _c = field_validator("name", "notes", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _req(self) -> "FeeStructureUpdate":
        if "is_active" in self.model_fields_set and self.is_active is None:
            raise ValueError("is active cannot be empty")
        return self


class Totals(BaseModel):
    item_count: int
    annual_compulsory: Money
    annual_optional: Money
    monthly_compulsory: Money
    one_time_compulsory: Money


class FeeStructureSummary(BaseModel):
    id: uuid.UUID
    academic_session_id: uuid.UUID
    session_name: str
    session_is_archived: bool
    class_id: uuid.UUID
    class_name: str
    name: str | None
    is_active: bool
    copied_from_id: uuid.UUID | None
    totals: Totals


class ScheduleLine(BaseModel):
    fee_item_id: uuid.UUID
    fee_head_name: str
    amount: Money
    is_optional: bool


class ScheduleMonth(BaseModel):
    month: date
    compulsory: Money
    optional: Money
    lines: list[ScheduleLine]


class FeeStructureDetail(FeeStructureSummary):
    notes: str | None
    items: list[FeeItemOut]
    schedule: list[ScheduleMonth]


class CopyTarget(_Strict):
    academic_session_id: uuid.UUID
    class_id: uuid.UUID


class FeeStructureCopy(_Strict):
    targets: list[CopyTarget] = Field(min_length=1, max_length=40)
    increase_percent: Decimal = Field(default=Decimal("0"), ge=Decimal("-50"), le=Decimal("100"))
    round_to: Decimal = Field(default=Decimal("1"))

    @field_validator("round_to")
    @classmethod
    def _round(cls, v: Decimal) -> Decimal:
        if v not in {Decimal("1"), Decimal("5"), Decimal("10"), Decimal("50"), Decimal("100")}:
            raise ValueError("Round to ₹1, ₹5, ₹10, ₹50 or ₹100.")
        return v

    @field_validator("increase_percent")
    @classmethod
    def _pct(cls, v: Decimal) -> Decimal:
        if v != v.quantize(Decimal("0.01")):
            raise ValueError("Use at most 2 decimal places for the percentage.")
        return v


class CopyResult(BaseModel):
    created: list[uuid.UUID]
    skipped: list[str] = Field(description="Targets that already had a structure (left unchanged)")
