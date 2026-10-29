import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DocumentType = Literal[
    "birth_certificate", "previous_marksheet", "transfer_certificate", "address_proof", "student_id_document", "other"
]


def clean_title(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


class DocumentUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_type: DocumentType | None = None
    title: str | None = Field(default=None, max_length=120)

    _t = field_validator("title", mode="before")(classmethod(lambda cls, v: clean_title(v)))

    @model_validator(mode="after")
    def _type_not_null(self) -> "DocumentUpdate":
        if "document_type" in self.model_fields_set and self.document_type is None:
            raise ValueError("document type cannot be empty")
        return self


class DocumentOut(BaseModel):
    """Deliberately has no storage path or URL: files are only reachable through the API."""

    id: uuid.UUID
    document_type: DocumentType
    title: str | None
    file_name: str
    mime_type: str
    size_bytes: int
    uploaded_at: datetime
    uploaded_by_name: str | None
