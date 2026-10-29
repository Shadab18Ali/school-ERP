import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.fees import Frequency, Money, check_amount

PaymentMode = Literal["cash", "upi", "bank_transfer", "cheque", "other"]  # what staff can record
RecordedMode = Literal["cash", "upi", "bank_transfer", "cheque", "other", "online"]  # "online": through the gateway
NEEDS_REFERENCE = {"upi", "bank_transfer", "cheque"}
MODE_LABELS = {
    "cash": "Cash",
    "upi": "UPI",
    "bank_transfer": "Bank transfer",
    "cheque": "Cheque",
    "other": "Other",
    "online": "Online payment",
}


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


class AllocationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    due_id: uuid.UUID
    amount: Decimal

    _a = field_validator("amount")(classmethod(lambda cls, v: check_amount(v)))


class PaymentCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: uuid.UUID = Field(description="New UUID per payment form; resending it returns the same receipt")
    payment_date: date
    payment_mode: PaymentMode
    reference_number: str | None = Field(default=None, max_length=60)
    remarks: str | None = Field(default=None, max_length=300)
    allocations: list[AllocationIn] = Field(min_length=1, max_length=60)

    _c = field_validator("reference_number", "remarks", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _rules(self) -> "PaymentCreate":
        if self.payment_mode in NEEDS_REFERENCE and not self.reference_number:
            label = {"upi": "UPI transaction ID", "bank_transfer": "bank reference (UTR)", "cheque": "cheque number"}
            raise ValueError(f"Enter the {label[self.payment_mode]}.")
        if self.payment_date > date.today():
            raise ValueError("The payment date can't be in the future.")
        ids = [a.due_id for a in self.allocations]
        if len(ids) != len(set(ids)):
            raise ValueError("The same fee appears twice in this payment.")
        return self


class OptinsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fee_item_ids: list[uuid.UUID] = Field(max_length=50)


class DueOut(BaseModel):
    due_id: uuid.UUID
    fee_item_id: uuid.UUID
    fee_head_name: str
    frequency: Frequency
    is_optional: bool
    due_month: date
    amount: Money
    paid: Money
    balance: Money


class FeeTotalsOut(BaseModel):
    total: Money
    paid: Money
    outstanding: Money
    overdue: Money


class OptionalFeeOut(BaseModel):
    fee_item_id: uuid.UUID
    fee_head_name: str
    amount: Money
    frequency: Frequency
    opted_in: bool


class PaymentSummary(BaseModel):
    id: uuid.UUID
    receipt_number: str
    payment_date: date
    amount: Money
    payment_mode: RecordedMode
    reference_number: str | None
    balance_after: Money
    received_by_name: str | None
    created_at: datetime
    cancelled_at: datetime | None = None  # refunded: the receipt no longer counts
    cancel_reason: str | None = None


class PaymentLine(BaseModel):
    fee_head_name: str
    due_month: date
    frequency: Frequency
    amount: Money


class PaymentDetail(PaymentSummary):
    remarks: str | None
    student_id: uuid.UUID
    student_name: str
    student_code: str
    class_section: str
    admission_number: str
    session_name: str
    lines: list[PaymentLine]


class PaymentResult(BaseModel):
    payment: PaymentDetail
    duplicate: bool = Field(description="True when this submission had already been recorded")


class StudentFeeAccount(BaseModel):
    student_id: uuid.UUID
    student_name: str
    student_code: str
    status: str
    enrollment_id: uuid.UUID | None
    session_id: uuid.UUID | None
    session_name: str | None
    session_is_archived: bool
    class_section: str | None
    admission_number: str | None
    has_structure: bool
    structure_active: bool
    totals: FeeTotalsOut
    dues: list[DueOut]
    optional_fees: list[OptionalFeeOut]
    payments: list[PaymentSummary]


class StudentBalanceRow(BaseModel):
    student_id: uuid.UUID
    enrollment_id: uuid.UUID
    student_name: str
    student_code: str
    class_section: str
    admission_number: str
    status: str
    totals: FeeTotalsOut


class StudentBalanceList(BaseModel):
    items: list[StudentBalanceRow]
    total: int
    page: int
    page_size: int
    session_id: uuid.UUID | None
    session_name: str | None
