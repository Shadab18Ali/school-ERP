import re
import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

SchoolStatus = Literal["active", "suspended"]
CODE_RE = re.compile(r"^[A-Z0-9-]{2,20}$")
NON_NULLABLE = ("name", "code", "country", "timezone", "status")


def _clean(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip()
    return v or None


class _SchoolFields(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=20, pattern=r"^[0-9+\-\s()]*$")
    address: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9 -]{3,10}$")
    registration_number: str | None = Field(default=None, max_length=50)
    affiliation_board: str | None = Field(default=None, max_length=50)
    affiliation_number: str | None = Field(default=None, max_length=50)
    udise_code: str | None = Field(default=None, pattern=r"^[0-9]{11}$", description="11-digit UDISE+ code")
    established_year: int | None = Field(default=None, ge=1800)

    @field_validator("established_year")
    @classmethod
    def _year_not_future(cls, v: int | None) -> int | None:
        if v is not None and v > date.today().year:
            raise ValueError("Established year can't be in the future.")
        return v

    @field_validator(
        "phone",
        "address",
        "city",
        "state",
        "postal_code",
        "registration_number",
        "affiliation_board",
        "affiliation_number",
        "udise_code",
        mode="before",
    )
    @classmethod
    def _empty_to_none(cls, v: object) -> object:
        return _clean(v) if isinstance(v, str) else v

    @field_validator("email", mode="before")
    @classmethod
    def _email_empty(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v


def _validate_code(v: str) -> str:
    v = v.strip().upper()
    if not CODE_RE.match(v):
        raise ValueError("Code must be 2–20 characters: letters, numbers or hyphens.")
    return v


class SchoolCreate(_SchoolFields):
    name: str = Field(min_length=2, max_length=200)
    code: str
    country: str = Field(default="India", min_length=2, max_length=100)
    timezone: str = Field(default="Asia/Kolkata", max_length=64)

    @field_validator("code")
    @classmethod
    def _code(cls, v: str) -> str:
        return _validate_code(v)


class SchoolUpdate(_SchoolFields):
    name: str | None = Field(default=None, min_length=2, max_length=200)
    code: str | None = None
    country: str | None = Field(default=None, min_length=2, max_length=100)
    timezone: str | None = Field(default=None, max_length=64)
    status: SchoolStatus | None = None

    @field_validator("code")
    @classmethod
    def _code(cls, v: str | None) -> str | None:
        return None if v is None else _validate_code(v)

    @model_validator(mode="after")
    def _no_nulls_for_required(self) -> "SchoolUpdate":
        for name in NON_NULLABLE:
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be empty")
        return self


class SchoolOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    code: str
    email: str | None
    phone: str | None
    address: str | None
    city: str | None
    state: str | None
    country: str
    timezone: str
    logo_url: str | None
    postal_code: str | None = None
    registration_number: str | None = None
    affiliation_board: str | None = None
    affiliation_number: str | None = None
    udise_code: str | None = None
    established_year: int | None = None
    status: SchoolStatus
    created_at: datetime
    updated_at: datetime
    admin_count: int = 0
    # filled in the platform's schools list (plan, size, activity)
    plan_name: str | None = None
    subscription_state: str | None = None
    current_period_end: date | None = None
    trial_ends_at: date | None = None
    students_active: int | None = None
    staff: int | None = None
    max_students: int | None = None
    last_activity_at: datetime | None = None


class SchoolList(BaseModel):
    items: list[SchoolOut]
    total: int
    page: int
    page_size: int


class InviteAdminIn(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=150)

    @field_validator("full_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class InviteAdminOut(BaseModel):
    user_id: uuid.UUID
    email: str
    invited: bool  # False when the account already existed and was just linked


class PlatformStats(BaseModel):
    total_schools: int
    active_schools: int
    suspended_schools: int
    total_users: int


class SchoolAdminOut(BaseModel):
    user_id: uuid.UUID
    full_name: str
    email: str
    status: str
    added_at: datetime
