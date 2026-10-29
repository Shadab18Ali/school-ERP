import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_SESSION_DAYS = 731


def _check_dates(start: date | None, end: date | None) -> None:
    if start and end:
        if end <= start:
            raise ValueError("The end date must be after the start date.")
        if (end - start).days > MAX_SESSION_DAYS:
            raise ValueError("A session can't be longer than two years.")


class SessionCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str = Field(min_length=2, max_length=50, examples=["2026-27"])
    start_date: date
    end_date: date
    make_current: bool = False

    @model_validator(mode="after")
    def _dates(self) -> "SessionCreate":
        _check_dates(self.start_date, self.end_date)
        return self


class SessionUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    name: str | None = Field(default=None, min_length=2, max_length=50)
    start_date: date | None = None
    end_date: date | None = None

    @model_validator(mode="after")
    def _no_nulls(self) -> "SessionUpdate":
        for f in self.model_fields_set:
            if getattr(self, f) is None:
                raise ValueError(f"{f.replace('_', ' ')} cannot be empty")
        _check_dates(self.start_date, self.end_date)
        return self


class SessionDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_name: str = Field(description="Must match the session's name, to prevent accidental deletion.")


class SessionUsage(BaseModel):
    table: str
    count: int


class SessionOut(BaseModel):
    id: uuid.UUID
    name: str
    start_date: date
    end_date: date
    is_current: bool
    is_archived: bool
    archived_at: datetime | None
    created_at: datetime
    usage: list[SessionUsage]

    @property
    def in_use(self) -> bool:
        return bool(self.usage)


class CurrentSessionOut(BaseModel):
    id: uuid.UUID
    name: str
