import re
import uuid
from datetime import date, datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Gender = Literal["male", "female", "other"]
StudentStatus = Literal["active", "inactive"]
StudentSort = Literal["class", "name", "admission_number", "newest"]

_PHONE = re.compile(r"^\+?[0-9]{10,15}$")
OPTIONAL_TEXT = ("father_name", "mother_name", "alternate_mobile", "address")


def normalize_phone(v: str | None) -> str | None:
    """'+91 98765-43210' -> '+919876543210'. Spaces, dashes, dots and brackets are ignored."""
    if v is None:
        return None
    v = re.sub(r"[\s\-().]", "", v)
    if not v:
        return None
    if not _PHONE.match(v):
        raise ValueError("Enter a valid mobile number (10 to 15 digits, optional +country code).")
    return v


def same_phone(a: str | None, b: str | None) -> bool:
    """Same subscriber number with or without a country code (+919876543210 == 9876543210)."""
    return bool(a and b and a[-10:] == b[-10:])


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


def check_dob(v: date) -> date:
    today = date.today()
    if v > today:
        raise ValueError("Date of birth can't be in the future.")
    if v > today - timedelta(days=365):
        raise ValueError("The student must be at least 1 year old.")
    if v < today.replace(year=today.year - 30):
        raise ValueError("Check the date of birth: the student would be over 30.")
    return v


def check_admission_date(v: date) -> date:
    if v > date.today() + timedelta(days=366):
        raise ValueError("The admission date is too far in the future.")
    if v.year < 1950:
        raise ValueError("Check the admission date.")
    return v


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _Personal(_Strict):
    full_name: str = Field(min_length=2, max_length=150)
    father_name: str | None = Field(default=None, max_length=150)
    mother_name: str | None = Field(default=None, max_length=150)
    date_of_birth: date
    gender: Gender
    mobile: str
    alternate_mobile: str | None = None
    address: str | None = Field(default=None, max_length=500)

    _clean = field_validator("full_name", "father_name", "mother_name", "address", mode="before")(
        classmethod(lambda cls, v: _clean(v))
    )
    _dob = field_validator("date_of_birth")(classmethod(lambda cls, v: check_dob(v)))

    @field_validator("mobile", "alternate_mobile", mode="before")
    @classmethod
    def _phones(cls, v: object) -> object:
        return normalize_phone(v) if isinstance(v, str) else v

    @model_validator(mode="after")
    def _parents(self) -> "_Personal":
        if not (self.father_name or self.mother_name):
            raise ValueError("Enter the father's or the mother's name.")
        if same_phone(self.alternate_mobile, self.mobile):
            raise ValueError("The alternate mobile is the same as the mobile.")
        return self


class EnrollmentIn(_Strict):
    academic_session_id: uuid.UUID
    class_id: uuid.UUID
    section_id: uuid.UUID
    admission_number: str = Field(min_length=1, max_length=30)
    admission_date: date

    _adm = field_validator("admission_number", mode="before")(classmethod(lambda cls, v: _clean(v)))
    _date = field_validator("admission_date")(classmethod(lambda cls, v: check_admission_date(v)))


class StudentCreate(_Personal):
    enrollment: EnrollmentIn


class StudentUpdate(_Strict):
    full_name: str | None = Field(default=None, min_length=2, max_length=150)
    father_name: str | None = Field(default=None, max_length=150)
    mother_name: str | None = Field(default=None, max_length=150)
    date_of_birth: date | None = None
    gender: Gender | None = None
    mobile: str | None = None
    alternate_mobile: str | None = None
    address: str | None = Field(default=None, max_length=500)

    _clean = field_validator("full_name", "father_name", "mother_name", "address", mode="before")(
        classmethod(lambda cls, v: _clean(v))
    )

    @field_validator("date_of_birth")
    @classmethod
    def _dob(cls, v: date | None) -> date | None:
        return None if v is None else check_dob(v)

    @field_validator("mobile", "alternate_mobile", mode="before")
    @classmethod
    def _phones(cls, v: object) -> object:
        return normalize_phone(v) if isinstance(v, str) else v

    @model_validator(mode="after")
    def _required(self) -> "StudentUpdate":
        for f in self.model_fields_set - set(OPTIONAL_TEXT):
            if getattr(self, f) is None:
                raise ValueError(f"{f.replace('_', ' ')} cannot be empty")
        return self


class EnrollmentUpdate(_Strict):
    class_id: uuid.UUID | None = None
    section_id: uuid.UUID | None = None
    admission_number: str | None = Field(default=None, min_length=1, max_length=30)
    admission_date: date | None = None

    _adm = field_validator("admission_number", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @field_validator("admission_date")
    @classmethod
    def _date(cls, v: date | None) -> date | None:
        return None if v is None else check_admission_date(v)

    @model_validator(mode="after")
    def _rules(self) -> "EnrollmentUpdate":
        for f in self.model_fields_set:
            if getattr(self, f) is None:
                raise ValueError(f"{f.replace('_', ' ')} cannot be empty")
        if ("class_id" in self.model_fields_set) != ("section_id" in self.model_fields_set):
            raise ValueError("Change the class and section together.")
        return self


class StatusUpdate(_Strict):
    status: StudentStatus
    reason: str | None = Field(default=None, max_length=200)

    _r = field_validator("reason", mode="before")(classmethod(lambda cls, v: _clean(v)))


# ---------------- responses ----------------
class EnrollmentOut(BaseModel):
    id: uuid.UUID
    academic_session_id: uuid.UUID
    session_name: str
    session_is_current: bool
    session_is_archived: bool
    class_id: uuid.UUID
    class_name: str
    section_id: uuid.UUID
    section_name: str
    admission_number: str
    admission_date: date


class StudentListItem(BaseModel):
    id: uuid.UUID
    student_code: str
    full_name: str
    father_name: str | None
    mother_name: str | None
    gender: Gender
    date_of_birth: date
    mobile: str
    status: StudentStatus
    photo_url: str | None
    enrollment: EnrollmentOut


class StudentList(BaseModel):
    items: list[StudentListItem]
    total: int
    page: int
    page_size: int
    session_id: uuid.UUID | None
    session_name: str | None


class StudentDetail(BaseModel):
    id: uuid.UUID
    student_code: str
    full_name: str
    father_name: str | None
    mother_name: str | None
    date_of_birth: date
    gender: Gender
    mobile: str
    alternate_mobile: str | None
    address: str | None
    photo_url: str | None
    status: StudentStatus
    status_reason: str | None
    created_at: datetime
    updated_at: datetime
    enrollments: list[EnrollmentOut] = Field(description="Newest session first")
    current_enrollment: EnrollmentOut | None = Field(description="Enrollment in the school's current session")


class NextAdmissionNumber(BaseModel):
    suggestion: str | None
