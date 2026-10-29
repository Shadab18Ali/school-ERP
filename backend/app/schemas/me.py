import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.school import SchoolOut
from app.schemas.session import CurrentSessionOut


class MembershipOut(BaseModel):
    school_id: uuid.UUID
    school_name: str
    school_code: str
    school_status: str
    roles: list[str]
    permissions: list[str]
    current_session: CurrentSessionOut | None = None
    access: str = "full"  # "read_only" while the subscription has expired or been cancelled
    features: list[str] | None = None  # the plan's features; None = no subscription recorded (everything)


class MeOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    phone: str | None = None
    is_super_admin: bool
    platform_permissions: list[str]
    memberships: list[MembershipOut]


class CurrentSchoolOut(BaseModel):
    school: SchoolOut
    roles: list[str]
    permissions: list[str]
    is_super_admin: bool
    current_session: CurrentSessionOut | None = None


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    full_name: str | None = Field(default=None, min_length=2, max_length=150)
    phone: str | None = Field(default=None, max_length=20, pattern=r"^[0-9+\-\s()]*$")

    @field_validator("phone", mode="before")
    @classmethod
    def _blank_phone(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v
