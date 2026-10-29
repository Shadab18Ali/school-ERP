"""Online admission: public pages (no login).

These endpoints run as the Postgres `anon` role, which can't read or write any
table. They can only call intake.admission_form / submit_admission /
admission_status (migration 0017), which check everything themselves. Files are
validated and re-encoded before they are stored, requests are rate-limited per
client, and a hidden "website" field catches simple bots.
"""

import json
import re
import uuid
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, EmailStr, Field, ValidationError, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.config import get_settings
from app.core.ratelimit import limit
from app.db.errors import pg_error
from app.db.session import anon_session
from app.schemas.students import normalize_phone
from app.services import storage
from app.services.documents import MAX_DOCUMENT_BYTES, DocumentError, clean_document, safe_filename
from app.services.images import LogoError, process_photo

router = APIRouter(prefix="/public/admissions", tags=["public-admissions"])
ADMISSION_BUCKET = "admission-files"
MAX_DOCUMENTS = 8
DocType = Literal[
    "birth_certificate", "transfer_certificate", "previous_report_card", "address_proof", "parent_id_proof", "other"
]
CODE = re.compile(r"^[A-Za-z0-9-]{2,20}$")


def _code(code: str) -> str:
    if not CODE.match(code):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")
    return code.upper()


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


class ApplicationIn(BaseModel):
    model_config = {"extra": "forbid"}

    window_id: uuid.UUID
    student_name: str = Field(min_length=2, max_length=150)
    date_of_birth: date
    gender: Literal["male", "female", "other"]
    blood_group: Literal["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] | None = None
    father_name: str | None = Field(default=None, min_length=2, max_length=150)
    father_phone: str | None = None
    father_occupation: str | None = Field(default=None, max_length=100)
    mother_name: str | None = Field(default=None, min_length=2, max_length=150)
    mother_phone: str | None = None
    mother_occupation: str | None = Field(default=None, max_length=100)
    contact_phone: str
    contact_email: EmailStr | None = None
    address_line: str = Field(min_length=5, max_length=300)
    city: str = Field(min_length=2, max_length=80)
    state: str = Field(min_length=2, max_length=80)
    postal_code: str = Field(pattern=r"^[0-9]{6}$")
    previous_school: str | None = Field(default=None, max_length=200)
    previous_class: str | None = Field(default=None, max_length=50)
    previous_board: str | None = Field(default=None, max_length=50)
    declaration: bool = False
    website: str | None = None  # hidden field: people leave it empty, simple bots fill it

    _c = field_validator(
        "student_name",
        "father_name",
        "father_occupation",
        "mother_name",
        "mother_occupation",
        "address_line",
        "city",
        "state",
        "previous_school",
        "previous_class",
        "previous_board",
        "contact_email",
        "blood_group",
        mode="before",
    )(classmethod(lambda cls, v: _clean(v)))

    @field_validator("contact_phone", "father_phone", "mother_phone", mode="before")
    @classmethod
    def _phone(cls, v: object) -> object:
        return normalize_phone(v) if isinstance(v, str) else v

    @field_validator("postal_code", mode="before")
    @classmethod
    def _pin(cls, v: object) -> object:
        return re.sub(r"\s", "", v) if isinstance(v, str) else v

    @field_validator("date_of_birth")
    @classmethod
    def _dob(cls, v: date) -> date:
        today = date.today()
        if v > today - timedelta(days=2 * 365):
            raise ValueError("The child must be at least 2 years old.")
        if v < today.replace(year=today.year - 20):
            raise ValueError("Check the date of birth: the child would be over 20.")
        return v

    @model_validator(mode="after")
    def _checks(self) -> "ApplicationIn":
        if not (self.father_name or self.mother_name):
            raise ValueError("Enter the father's or the mother's name.")
        if not self.declaration:
            raise ValueError("Please confirm that the information is correct.")
        return self


class StatusIn(BaseModel):
    model_config = {"extra": "forbid"}
    application_number: str = Field(min_length=5, max_length=30)
    phone: str = Field(min_length=10, max_length=20)


FIELD_HINTS = {
    "window_id": "Choose the class you are applying for.",
    "student_name": "Enter the child's full name (2 to 150 letters).",
    "date_of_birth": "Enter a valid date of birth.",
    "gender": "Choose the child's gender.",
    "blood_group": "Choose a valid blood group.",
    "father_name": "Enter the father's full name.",
    "mother_name": "Enter the mother's full name.",
    "contact_email": "Enter a valid email address.",
    "address_line": "Enter the full address (house, street, area).",
    "city": "Enter the city.",
    "state": "Enter the state.",
    "postal_code": "Enter a 6-digit PIN code.",
}


def _friendly(exc: ValidationError) -> str:
    """A sentence a parent understands, not a validator message."""
    e = exc.errors()[0]
    field = next((str(x) for x in e["loc"] if isinstance(x, str)), "")
    msg = e["msg"].removeprefix("Value error, ")
    if e["type"] == "value_error" and msg[:1].isupper():  # our own messages (dates, phones, declaration)
        return msg
    return FIELD_HINTS.get(field, "Some details aren't valid. Please check the form.")


@router.get("/{code}")
async def admission_form(code: str, request: Request) -> dict:
    await limit(request, "admission-form", 120, 60)
    async with anon_session() as db:
        data = (await db.execute(text("select intake.admission_form(:c)"), {"c": _code(code)})).scalar()
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")
    return json.loads(data) if isinstance(data, str) else data


@router.post("/{code}", status_code=status.HTTP_201_CREATED)
async def submit_application(
    code: str,
    request: Request,
    data: str = Form(..., max_length=20000, description="The form fields as JSON"),
    photo: UploadFile = File(...),
    documents: list[UploadFile] = File(default=[]),
    document_types: list[str] = Form(default=[]),
) -> dict:
    s = get_settings()
    await limit(request, "admission-submit", s.admission_submits_per_hour, 3600)
    code = _code(code)
    try:
        app_in = ApplicationIn.model_validate_json(data)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, _friendly(exc)) from None
    if app_in.website:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The application couldn't be accepted.")
    if len(documents) > MAX_DOCUMENTS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Attach at most {MAX_DOCUMENTS} documents.")
    if len(document_types) != len(documents):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose the type of every document.")
    allowed = set(DocType.__args__)  # type: ignore[attr-defined]
    if any(t not in allowed for t in document_types):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown document type.")

    # validate every file before storing any
    raw_photo = await photo.read(MAX_DOCUMENT_BYTES + 1)
    try:
        photo_jpeg = await run_in_threadpool(process_photo, raw_photo)
    except LogoError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Photo: {exc}") from None
    cleaned = []
    for f, kind in zip(documents, document_types, strict=True):
        try:
            c = await run_in_threadpool(clean_document, await f.read(MAX_DOCUMENT_BYTES + 1))
        except DocumentError as exc:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{f.filename or 'Document'}: {exc}") from None
        cleaned.append((kind, safe_filename(f.filename, c.extension), c))

    folder = f"{code}/{uuid.uuid4().hex}"
    stored: list[str] = []
    try:
        photo_path = f"{folder}/photo.jpg"
        await storage.upload(ADMISSION_BUCKET, photo_path, photo_jpeg, "image/jpeg")
        stored.append(photo_path)
        docs = []
        for kind, name, c in cleaned:
            path = f"{folder}/{uuid.uuid4().hex}.{c.extension}"
            await storage.upload(ADMISSION_BUCKET, path, c.data, c.mime_type)
            stored.append(path)
            docs.append(
                {
                    "type": kind,
                    "file_name": name,
                    "mime_type": c.mime_type,
                    "size_bytes": len(c.data),
                    "file_path": path,
                }
            )
    except storage.StorageError as exc:
        for p in stored:
            await storage.delete(ADMISSION_BUCKET, p)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None

    payload = app_in.model_dump(mode="json", exclude={"declaration", "website"})
    payload |= {"photo_path": photo_path, "documents": docs}
    try:
        async with anon_session() as db:
            row = (
                await db.execute(
                    text(
                        "select application_id, application_number from intake.submit_admission(:c, cast(:d as jsonb))"
                    ),
                    {"c": code, "d": json.dumps(payload)},
                )
            ).first()
            await db.commit()
    except DBAPIError as exc:
        for p in stored:
            await storage.delete(ADMISSION_BUCKET, p)
        err = pg_error(exc)
        if err.sqlstate == "P0002":
            raise HTTPException(status.HTTP_404_NOT_FOUND, err.message) from None
        if err.sqlstate in ("23505", "23514") and err.constraint is None:
            raise HTTPException(status.HTTP_409_CONFLICT, err.message) from None
        if err.sqlstate in ("23514", "22P02", "22007", "22008"):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "Some details aren't valid. Please check the form."
            ) from None
        raise
    return {"application_number": row[1], "status": "submitted"}


@router.post("/{code}/status")
async def application_status(code: str, payload: StatusIn, request: Request) -> dict:
    """The applicant's own status. Needs the application number and the contact mobile."""
    s = get_settings()
    await limit(request, "admission-status", s.admission_lookups_per_10min, 600)
    async with anon_session() as db:
        data = (
            await db.execute(
                text("select intake.admission_status(:c, :n, :p)"),
                {"c": _code(code), "n": payload.application_number.strip(), "p": payload.phone},
            )
        ).scalar()
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No application matches that number and mobile number.")
    return json.loads(data) if isinstance(data, str) else data
