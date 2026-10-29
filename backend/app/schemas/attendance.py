import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Status = Literal["present", "absent", "leave"]


class EntryIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enrollment_id: uuid.UUID
    status: Status
    remarks: str | None = Field(default=None, max_length=200)

    @field_validator("remarks", mode="before")
    @classmethod
    def _r(cls, v: object) -> object:
        return (" ".join(v.split()) or None) if isinstance(v, str) else v


class RosterSave(BaseModel):
    """The whole section in one request."""

    model_config = ConfigDict(extra="forbid")
    section_id: uuid.UUID
    date: date
    entries: list[EntryIn] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def _rules(self) -> "RosterSave":
        if self.date > date.today():
            raise ValueError("Attendance can't be marked for a future date.")
        ids = [e.enrollment_id for e in self.entries]
        if len(ids) != len(set(ids)):
            raise ValueError("A student appears twice in this save.")
        return self


class RosterStudent(BaseModel):
    enrollment_id: uuid.UUID
    student_id: uuid.UUID
    full_name: str
    student_code: str
    admission_number: str
    status: Status | None
    remarks: str | None
    updated_at: datetime | None


class Counts(BaseModel):
    present: int
    absent: int
    leave: int
    unmarked: int
    percentage: Decimal | None


class Roster(BaseModel):
    section_id: uuid.UUID
    section_name: str
    class_name: str
    session_id: uuid.UUID
    session_name: str
    date: date
    editable: bool
    reason: str | None = Field(description="Why the roster is read-only, if it is")
    students: list[RosterStudent]
    counts: Counts


class SaveResult(BaseModel):
    inserted: int
    updated: int
    unchanged: int
    roster: Roster


class DailyRow(BaseModel):
    section_id: uuid.UUID
    class_name: str
    section_name: str
    enrolled: int
    present: int
    absent: int
    leave: int
    unmarked: int
    percentage: Decimal | None


class Daily(BaseModel):
    date: date
    sections: list[DailyRow]
    totals: Counts


class StudentTotals(BaseModel):
    enrollment_id: uuid.UUID
    student_id: uuid.UUID
    full_name: str
    student_code: str
    admission_number: str
    present: int
    absent: int
    leave: int
    marked: int
    percentage: Decimal | None


class MonthlyStudent(StudentTotals):
    days: dict[str, Status] = Field(description="ISO date -> status")


class DayTotals(BaseModel):
    date: date
    present: int
    absent: int
    leave: int
    marked: int
    percentage: Decimal | None


class Monthly(BaseModel):
    section_id: uuid.UUID
    class_name: str
    section_name: str
    month: date
    days: list[DayTotals]
    students: list[MonthlyStudent]


class ClassReport(BaseModel):
    section_id: uuid.UUID
    class_name: str
    section_name: str
    date_from: date
    date_to: date
    days: list[DayTotals]
    students: list[StudentTotals]
    overall: Decimal | None


class MonthTotals(BaseModel):
    month: date
    present: int
    absent: int
    leave: int
    marked: int
    percentage: Decimal | None


class StudentRecord(BaseModel):
    date: date
    status: Status
    remarks: str | None
    class_section: str


class StudentAttendance(BaseModel):
    student_id: uuid.UUID
    full_name: str
    session_id: uuid.UUID | None
    session_name: str | None
    class_section: str | None
    months: list[MonthTotals]
    overall: Counts
    records: list[StudentRecord] = Field(description="Newest first")
