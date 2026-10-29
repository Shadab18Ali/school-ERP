import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.session import CurrentSessionOut

RecordStatus = Literal["active", "inactive", "deleted"]


def _clean_name(v: str) -> str:
    v = " ".join(v.split())  # trim and collapse inner spaces
    if not v:
        raise ValueError("Name cannot be empty.")
    return v


class _Strict(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


# ---------------- classes ----------------
class ClassCreate(_Strict):
    name: str = Field(min_length=1, max_length=50, examples=["Class 1"])
    display_order: int | None = Field(default=None, ge=0, le=999, description="Omit to add at the end")

    _name = field_validator("name")(classmethod(lambda cls, v: _clean_name(v)))


class ClassBulkItem(_Strict):
    name: str = Field(min_length=1, max_length=50)
    display_order: int = Field(ge=0, le=999)

    _name = field_validator("name")(classmethod(lambda cls, v: _clean_name(v)))


class ClassBulkCreate(_Strict):
    classes: list[ClassBulkItem] = Field(min_length=1, max_length=40)


class ClassUpdate(_Strict):
    name: str | None = Field(default=None, min_length=1, max_length=50)
    display_order: int | None = Field(default=None, ge=0, le=999)
    is_active: bool | None = None

    @field_validator("name")
    @classmethod
    def _n(cls, v: str | None) -> str | None:
        return None if v is None else _clean_name(v)

    @model_validator(mode="after")
    def _no_nulls(self) -> "ClassUpdate":
        for f in self.model_fields_set:
            if getattr(self, f) is None:
                raise ValueError(f"{f.replace('_', ' ')} cannot be empty")
        return self


class SectionBrief(BaseModel):
    id: uuid.UUID
    name: str
    is_active: bool
    capacity: int | None
    student_count: int


class ClassOut(BaseModel):
    id: uuid.UUID
    name: str
    display_order: int
    is_active: bool
    is_deleted: bool
    deleted_at: datetime | None
    created_at: datetime
    sections: list[SectionBrief] = Field(description="Live sections in the selected session")
    student_count: int
    capacity_total: int | None = Field(description="Sum of section capacities; null if any section has none")


class ClassList(BaseModel):
    session: CurrentSessionOut | None
    session_archived: bool
    items: list[ClassOut]
    total_students: int


# ---------------- sections ----------------
SECTION_NAME = Field(min_length=1, max_length=20, examples=["A"])


class SectionCreate(_Strict):
    class_id: uuid.UUID
    academic_session_id: uuid.UUID
    name: str = SECTION_NAME
    capacity: int | None = Field(default=None, ge=1, le=500)
    room: str | None = Field(default=None, max_length=50)

    _name = field_validator("name")(classmethod(lambda cls, v: _clean_name(v)))


class SectionBulkCreate(_Strict):
    """Assign sections (e.g. A-D) to several classes in one session."""

    academic_session_id: uuid.UUID
    class_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    names: list[str] = Field(min_length=1, max_length=26)
    capacity: int | None = Field(default=None, ge=1, le=500)

    @field_validator("names")
    @classmethod
    def _names(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for n in v:
            n = _clean_name(n)
            if len(n) > 20:
                raise ValueError("Section names can be at most 20 characters.")
            if n.casefold() not in {x.casefold() for x in out}:
                out.append(n)
        return out


class SectionCopy(_Strict):
    from_session_id: uuid.UUID
    to_session_id: uuid.UUID

    @model_validator(mode="after")
    def _different(self) -> "SectionCopy":
        if self.from_session_id == self.to_session_id:
            raise ValueError("Choose two different sessions.")
        return self


class SectionUpdate(_Strict):
    name: str | None = Field(default=None, min_length=1, max_length=20)
    capacity: int | None = Field(default=None, ge=1, le=500)  # explicit null clears it
    room: str | None = Field(default=None, max_length=50)  # explicit null / "" clears it
    is_active: bool | None = None
    class_id: uuid.UUID | None = None

    @field_validator("name")
    @classmethod
    def _n(cls, v: str | None) -> str | None:
        return None if v is None else _clean_name(v)

    @field_validator("room", mode="before")
    @classmethod
    def _room(cls, v: object) -> object:
        return None if isinstance(v, str) and not v.strip() else v

    @model_validator(mode="after")
    def _required(self) -> "SectionUpdate":
        for f in ("name", "is_active", "class_id"):
            if f in self.model_fields_set and getattr(self, f) is None:
                raise ValueError(f"{f.replace('_', ' ')} cannot be empty")
        return self


class SectionOut(BaseModel):
    id: uuid.UUID
    class_id: uuid.UUID
    class_name: str
    class_is_active: bool
    academic_session_id: uuid.UUID
    session_name: str
    name: str
    capacity: int | None
    room: str | None
    is_active: bool
    is_deleted: bool
    student_count: int
    created_at: datetime


class SectionList(BaseModel):
    items: list[SectionOut]
    total: int
    page: int
    page_size: int


class BulkResult(BaseModel):
    created: int
    skipped: list[str] = Field(description="Names that already existed and were left unchanged")
