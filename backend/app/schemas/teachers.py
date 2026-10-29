import re
import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.schemas.students import normalize_phone

TeacherStatus = Literal["active", "inactive"]
StaffType = Literal["teaching", "non_teaching"]
_EMPLOYEE_ID = re.compile(r"^[A-Za-z0-9/_-]{1,30}$")


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


def check_joining_date(v: date) -> date:
    if v > date.today():
        raise ValueError("The joining date can't be in the future.")
    if v.year < 1950:
        raise ValueError("Check the joining date.")
    return v


def check_employee_id(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip().upper()
    if not v:
        return None
    if not _EMPLOYEE_ID.match(v):
        raise ValueError("Employee IDs use letters, numbers, - / and _ only (up to 30).")
    return v


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TeacherCreate(_Strict):
    employee_id: str | None = Field(default=None, description="Leave empty to allocate EMP0001, EMP0002 ...")
    full_name: str = Field(min_length=2, max_length=150)
    phone: str
    email: EmailStr
    qualification: str | None = Field(default=None, max_length=150)
    subject: str | None = Field(default=None, max_length=100)
    joining_date: date
    address: str | None = Field(default=None, max_length=500)
    staff_type: StaffType = "teaching"  # non-teaching staff (office, peon, guard...) get staff ID cards
    designation: str | None = Field(default=None, min_length=2, max_length=60)  # e.g. PGT Physics, Clerk

    _c = field_validator("full_name", "qualification", "subject", "address", "designation", mode="before")(
        classmethod(lambda cls, v: _clean(v))
    )
    _e = field_validator("employee_id")(classmethod(lambda cls, v: check_employee_id(v)))
    _p = field_validator("phone", mode="before")(classmethod(lambda cls, v: normalize_phone(v)))
    _j = field_validator("joining_date")(classmethod(lambda cls, v: check_joining_date(v)))

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.lower()


class TeacherUpdate(_Strict):
    employee_id: str | None = None
    full_name: str | None = Field(default=None, min_length=2, max_length=150)
    phone: str | None = None
    email: EmailStr | None = None
    qualification: str | None = Field(default=None, max_length=150)
    subject: str | None = Field(default=None, max_length=100)
    joining_date: date | None = None
    address: str | None = Field(default=None, max_length=500)
    staff_type: StaffType | None = None
    designation: str | None = Field(default=None, min_length=2, max_length=60)

    _c = field_validator("full_name", "qualification", "subject", "address", "designation", mode="before")(
        classmethod(lambda cls, v: _clean(v))
    )
    _e = field_validator("employee_id")(classmethod(lambda cls, v: check_employee_id(v)))
    _p = field_validator("phone", mode="before")(classmethod(lambda cls, v: normalize_phone(v)))

    @field_validator("joining_date")
    @classmethod
    def _j(cls, v: date | None) -> date | None:
        return None if v is None else check_joining_date(v)

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str | None) -> str | None:
        return v.lower() if v else v

    @model_validator(mode="after")
    def _required(self) -> "TeacherUpdate":
        for f in ("employee_id", "full_name", "phone", "email", "joining_date", "staff_type"):
            if f in self.model_fields_set and getattr(self, f) is None:
                raise ValueError(f"{f.replace('_', ' ').capitalize()} can't be empty.")
        return self


class StatusChange(_Strict):
    status: TeacherStatus
    reason: str | None = Field(default=None, max_length=300)

    _c = field_validator("reason", mode="before")(classmethod(lambda cls, v: _clean(v)))


class AssignmentIn(_Strict):
    section_id: uuid.UUID
    subject: str | None = Field(default=None, max_length=100)
    is_class_teacher: bool = False

    _c = field_validator("subject", mode="before")(classmethod(lambda cls, v: _clean(v)))


class AssignmentUpdate(_Strict):
    subject: str | None = Field(default=None, max_length=100)
    is_class_teacher: bool | None = None

    _c = field_validator("subject", mode="before")(classmethod(lambda cls, v: _clean(v)))


class AssignmentOut(BaseModel):
    id: uuid.UUID
    section_id: uuid.UUID
    class_id: uuid.UUID
    class_name: str
    section_name: str
    academic_session_id: uuid.UUID
    session_name: str
    session_is_current: bool
    session_is_archived: bool
    subject: str | None
    is_class_teacher: bool


class TeacherSummary(BaseModel):
    id: uuid.UUID
    employee_id: str
    full_name: str
    phone: str
    email: str
    qualification: str | None
    subject: str | None
    joining_date: date
    staff_type: StaffType
    designation: str | None
    status: TeacherStatus
    photo_url: str | None
    has_login: bool
    assigned_sections: int = Field(description="Sections assigned in the current session")


class LoginInfo(BaseModel):
    linked: bool
    email: str | None = None
    library_duty: bool = False  # the login also holds the librarian role (runs the school library)


class TeacherDetail(TeacherSummary):
    address: str | None
    status_reason: str | None
    login: LoginInfo
    assignments: list[AssignmentOut]
    created_at: datetime


class TeacherList(BaseModel):
    items: list[TeacherSummary]
    total: int
    page: int
    page_size: int
