"""Transport: vehicles, drivers and attendants, their documents, fare zones, routes, stops,
and students on routes. No live GPS.

Rules live in the database (migration 0023): seats, licence validity, one assignment at a
time, dates within the session, and the transport fees. A fare zone is a fee head with an
item in the session's transport fee structure; assigning a student adds that item's dues to
their fee account for the months they ride, so transport fees are collected, paid online,
receipted and reported like every other fee.
"""

import re
import uuid
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db, pg_error
from app.schemas.students import normalize_phone
from app.services import storage
from app.services.academics import resolve_session
from app.services.audit import write_audit
from app.services.documents import DocumentError, clean_document, content_disposition, safe_filename
from app.services.exports import to_csv

router = APIRouter(prefix="/transport", tags=["transport"])
VIEW = Depends(require_permission(Permission.TRANSPORT_VIEW))
MANAGE = Depends(require_permission(Permission.TRANSPORT_MANAGE))

UNIQUE = {
    "transport_vehicles_reg_key": "A vehicle with this registration number is already on record.",
    "transport_staff_license_key": "Someone with this licence number is already on record.",
    "transport_routes_name_key": "A route with this name already exists.",
    "transport_routes_code_key": "A route with this code already exists.",
    "transport_stops_name_key": "This route already has a stop with that name.",
    "transport_fare_zones_name_key": "A fare zone with this name already exists.",
    "fee_heads_school_name_key": "A fee head with that name already exists. Choose another zone name.",
}
VEHICLE_DOCS = (
    "registration_certificate",
    "insurance",
    "pollution_certificate",
    "fitness_certificate",
    "permit",
    "road_tax",
    "other",
)
STAFF_DOCS = ("driving_license", "police_verification", "medical_certificate", "id_proof", "address_proof", "other")
REQUIRED_VEHICLE_DOCS = (
    "registration_certificate",
    "insurance",
    "pollution_certificate",
    "fitness_certificate",
    "permit",
)
DOC_LABEL = {
    "registration_certificate": "Registration certificate (RC)",
    "insurance": "Insurance",
    "pollution_certificate": "Pollution certificate (PUC)",
    "fitness_certificate": "Fitness certificate",
    "permit": "Permit",
    "road_tax": "Road tax",
    "driving_license": "Driving licence",
    "police_verification": "Police verification",
    "medical_certificate": "Medical certificate",
    "id_proof": "ID proof",
    "address_proof": "Address proof",
    "other": "Other",
}
MAX_DOCS = 40
EXPIRING_DAYS = 30


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = re.sub(r"\s+", " ", v).strip()
        return v or None
    return v


def registration(raw: str) -> str:
    """'dl 1p c-1234' -> 'DL1PC1234' (as the database stores it)."""
    s = re.sub(r"[\s.\-]", "", raw or "").upper()
    if not re.fullmatch(r"[A-Z0-9]{4,12}", s):
        raise ValueError("Enter the registration number as on the RC, e.g. DL 1P C 1234.")
    return s


def license_no(raw: str | None) -> str | None:
    if raw is None:
        return None
    s = re.sub(r"\s", "", raw).upper()
    if not s:
        return None
    if not re.fullmatch(r"[A-Z0-9-]{6,20}", s):
        raise ValueError("Enter the licence number as printed, e.g. DL-0420110012345.")
    return s


async def _call(db: AsyncSession, sql: str, params: dict[str, Any]) -> Any:
    try:
        return await db.execute(text(sql), params)
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None


def _json(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, uuid.UUID):
            v = str(v)
        elif isinstance(v, datetime | date):
            v = v.isoformat()
        elif isinstance(v, time):
            v = v.strftime("%H:%M")
        elif isinstance(v, Decimal):
            v = f"{v:.2f}"
        out[k] = v
    return out


def _rows(result: Any) -> list[dict]:
    return [_json(dict(r)) for r in result.mappings()]


async def _one(db: AsyncSession, sql: str, params: dict[str, Any], missing: str) -> dict:
    r = (await db.execute(text(sql), params)).mappings().first()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, missing)
    return _json(dict(r))


async def _delete_or_explain(db: AsyncSession, sql: str, params: dict[str, Any], in_use: str, missing: str) -> None:
    try:
        r = await db.execute(text(sql), params)
    except DBAPIError as exc:
        if pg_error(exc).sqlstate == "23503":
            await db.rollback()
            raise HTTPException(status.HTTP_409_CONFLICT, in_use) from None
        raise await http_error_from_db(db, exc) from None
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, missing)
    await db.commit()


# ------------------------------------------------------------------ dashboard
@router.get("/dashboard")
async def dashboard(
    ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db), session_id: uuid.UUID | None = None
) -> dict:
    session = await resolve_session(db, ctx, session_id)
    d = (
        await _call(
            db,
            "select private.transport_dashboard(:s, :sid)",
            {"s": ctx.school_id, "sid": session.id if session else None},
        )
    ).scalar()
    d["fees"] = {k: f"{Decimal(str(v)):.2f}" for k, v in d["fees"].items()}
    d["session_name"] = session.name if session else None
    d["compliance"] = (await compliance(ctx, db))[:8]
    return d


@router.get("/compliance")
async def compliance(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Expired or soon-expiring documents and licences, and vehicles missing required papers."""
    if not ctx.can(Permission.TRANSPORT_MANAGE):
        return []
    p = {"s": ctx.school_id, "days": EXPIRING_DAYS}
    docs = _rows(
        await db.execute(
            text(
                "select d.id, d.doc_type, d.title, d.valid_until, d.vehicle_id, d.staff_id, "
                "coalesce(v.registration_number, st.full_name) as owner, "
                "case when d.vehicle_id is not null then 'vehicle' else 'staff' end as owner_kind "
                "from public.transport_documents d left join public.transport_vehicles v on v.id = d.vehicle_id "
                "left join public.transport_staff st on st.id = d.staff_id "
                "where d.school_id = :s and d.valid_until <= current_date + cast(:days as integer) "
                "and coalesce(v.status, st.status) <> 'retired' and coalesce(st.status, 'active') = 'active' "
                # only the latest document of each type counts (a renewed one replaces the old)
                "and not exists (select 1 from public.transport_documents n where n.doc_type = d.doc_type "
                "  and n.doc_type <> 'other' and n.vehicle_id is not distinct from d.vehicle_id "
                "  and n.staff_id is not distinct from d.staff_id and n.valid_until > d.valid_until) "
                "order by d.valid_until"
            ),
            p,
        )
    )
    licences = _rows(
        await db.execute(
            text(
                "select id as staff_id, full_name as owner, license_valid_until as valid_until from "
                "public.transport_staff "
                "where school_id = :s and status = 'active' and role = 'driver' and license_valid_until "
                "<= current_date + cast(:days as integer) "
                "order by license_valid_until"
            ),
            p,
        )
    )
    missing = _rows(
        await db.execute(
            text(
                "select v.id as vehicle_id, v.registration_number as owner, m.doc_type from "
                "public.transport_vehicles v "
                "cross join unnest(cast(:req as text[])) as m(doc_type) "
                "where v.school_id = :s and v.status <> 'retired' and not exists (select 1 from "
                "public.transport_documents d "
                "where d.vehicle_id = v.id and d.doc_type = m.doc_type) order by v.registration_number"
            ),
            {**p, "req": list(REQUIRED_VEHICLE_DOCS)},
        )
    )
    today = date.today().isoformat()
    out = []
    for d in docs:
        out.append(
            {
                "kind": "expired" if d["valid_until"] < today else "expiring",
                "what": d["title"] or DOC_LABEL[d["doc_type"]],
                "owner": d["owner"],
                "owner_kind": d["owner_kind"],
                "owner_id": d["vehicle_id"] or d["staff_id"],
                "date": d["valid_until"],
            }
        )
    with_licence_doc = {d["staff_id"] for d in docs if d["doc_type"] == "driving_license"}
    for x in licences:
        if x["staff_id"] in with_licence_doc:  # the uploaded licence is already listed
            continue
        out.append(
            {
                "kind": "expired" if x["valid_until"] < today else "expiring",
                "what": "Driving licence (on record)",
                "owner": x["owner"],
                "owner_kind": "staff",
                "owner_id": x["staff_id"],
                "date": x["valid_until"],
            }
        )
    for m in missing:
        out.append(
            {
                "kind": "missing",
                "what": DOC_LABEL[m["doc_type"]],
                "owner": m["owner"],
                "owner_kind": "vehicle",
                "owner_id": m["vehicle_id"],
                "date": None,
            }
        )
    rank = {"expired": 0, "expiring": 1, "missing": 2}
    return sorted(out, key=lambda x: (rank[x["kind"]], x["date"] or "", x["owner"]))


# ------------------------------------------------------------------ vehicles
class VehicleIn(BaseModel):
    model_config = {"extra": "forbid"}
    registration_number: str = Field(max_length=20)
    vehicle_type: Literal["bus", "mini_bus", "van", "car", "other"]
    make_model: str | None = Field(default=None, max_length=80)
    seating_capacity: int = Field(ge=1, le=100)
    manufacture_year: int | None = Field(default=None, ge=1980, le=2100)
    ownership: Literal["school", "contracted"] = "school"
    contractor_name: str | None = Field(default=None, max_length=120)
    status: Literal["active", "maintenance", "retired"] = "active"
    notes: str | None = Field(default=None, max_length=500)

    _c = field_validator("make_model", "contractor_name", "notes", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @field_validator("registration_number")
    @classmethod
    def _reg(cls, v: str) -> str:
        return registration(v)

    @model_validator(mode="after")
    def _owner(self) -> "VehicleIn":
        if self.ownership == "school":
            self.contractor_name = None
        elif not self.contractor_name:
            raise ValueError("Enter the contractor's name for a contracted vehicle.")
        return self


VEHICLE_SELECT = """
select v.*,
       (select count(*) from public.transport_routes r where r.vehicle_id = v.id and r.status = 'active') as routes,
       (select string_agg(r.name, ',
              ' order by r.name) from public.transport_routes r where r.vehicle_id = v.id and r.status = 'active')
         as route_names,
       (select max(private.transport_route_riders(r.id)) from public.transport_routes r where r.vehicle_id = v.id
          and r.status = 'active') as riders,
       (select count(*) from public.transport_documents d where d.vehicle_id = v.id and d.valid_until < current_date)
         as documents_expired,
       (select count(*) from unnest(cast(:req as text[])) m(t) where not exists
          (select 1 from public.transport_documents d where d.vehicle_id = v.id and d.doc_type = m.t))
         as documents_missing
from public.transport_vehicles v
"""


@router.get("/vehicles")
async def vehicles(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> list[dict]:
    return _rows(
        await db.execute(
            text(f"{VEHICLE_SELECT} where v.school_id = :s order by v.status = 'retired', v.registration_number"),
            {"s": ctx.school_id, "req": list(REQUIRED_VEHICLE_DOCS)},
        )
    )


async def _documents(db: AsyncSession, owner_col: str, owner_id: uuid.UUID) -> list[dict]:
    rows = _rows(
        await db.execute(
            text(
                "select d.id, d.doc_type, d.title, d.number, d.issued_on, d.valid_until, d.file_name, d.mime_type, "
                "d.size_bytes, d.created_at, p.full_name as uploaded_by_name from public.transport_documents d "
                f"left join public.profiles p on p.id = d.uploaded_by where d.{owner_col} = :id "
                "order by d.doc_type, d.valid_until desc nulls last, d.created_at desc"
            ),
            {"id": owner_id},
        )
    )
    today = date.today().isoformat()
    soon = date.fromordinal(date.today().toordinal() + EXPIRING_DAYS).isoformat()
    for d in rows:
        d["label"] = d["title"] or DOC_LABEL[d["doc_type"]]
        vu = d["valid_until"]
        d["state"] = "expired" if vu and vu < today else "expiring" if vu and vu <= soon else "valid"
    return rows


async def _vehicle(db: AsyncSession, ctx: SchoolContext, vehicle_id: uuid.UUID) -> dict:
    v = await _one(
        db,
        f"{VEHICLE_SELECT} where v.id = :id and v.school_id = :s",
        {"id": vehicle_id, "s": ctx.school_id, "req": list(REQUIRED_VEHICLE_DOCS)},
        "Vehicle not found.",
    )
    v["documents"] = await _documents(db, "vehicle_id", vehicle_id) if ctx.can(Permission.TRANSPORT_MANAGE) else []
    have = {d["doc_type"] for d in v["documents"]}
    v["required_missing"] = [DOC_LABEL[t] for t in REQUIRED_VEHICLE_DOCS if t not in have]
    v["route_list"] = _rows(
        await db.execute(
            text(
                "select r.id, r.name, r.code, r.status, private.transport_route_riders(r.id) as riders "
                "from public.transport_routes r where r.vehicle_id = :id order by r.name"
            ),
            {"id": vehicle_id},
        )
    )
    return v


@router.get("/vehicles/{vehicle_id}")
async def vehicle(vehicle_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    return await _vehicle(db, ctx, vehicle_id)


@router.post("/vehicles", status_code=status.HTTP_201_CREATED)
async def add_vehicle(
    payload: VehicleIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    v = payload.model_dump()
    vid = (
        await _call(
            db,
            f"insert into public.transport_vehicles (school_id, {', '.join(v)}, created_by) "
            f"values (:school_id, {', '.join(':' + k for k in v)}, :by) returning id",
            {**v, "school_id": ctx.school_id, "by": user.id},
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="transport.vehicle_added",
        entity_type="transport_vehicle",
        entity_id=str(vid),
        school_id=ctx.school_id,
        metadata={"registration_number": payload.registration_number},
    )
    await db.commit()
    return await _vehicle(db, ctx, vid)


@router.put("/vehicles/{vehicle_id}")
async def update_vehicle(
    vehicle_id: uuid.UUID, payload: VehicleIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    v = payload.model_dump()
    r = await _call(
        db,
        "update public.transport_vehicles set "
        + ", ".join(f"{k} = :{k}" for k in v)
        + " where id = :id and school_id = :s",
        {**v, "id": vehicle_id, "s": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vehicle not found.")
    await db.commit()
    return await _vehicle(db, ctx, vehicle_id)


@router.delete("/vehicles/{vehicle_id}")
async def delete_vehicle(
    vehicle_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    paths = (
        await db.scalars(
            text("select file_path from public.transport_documents where vehicle_id = :id"), {"id": vehicle_id}
        )
    ).all()
    await _delete_or_explain(
        db,
        "delete from public.transport_vehicles where id = :id and school_id = :s",
        {"id": vehicle_id, "s": ctx.school_id},
        "This vehicle is on a route. Take it off the route, or mark it retired.",
        "Vehicle not found.",
    )
    for p in paths:
        await storage.delete(storage.TRANSPORT_DOC_BUCKET, p)
    return {"ok": True}


# ------------------------------------------------------------------ drivers & attendants
class StaffIn(BaseModel):
    model_config = {"extra": "forbid"}
    role: Literal["driver", "attendant"]
    full_name: str = Field(min_length=2, max_length=150)
    phone: str
    alternate_phone: str | None = None
    license_number: str | None = Field(default=None, max_length=30)
    license_valid_until: date | None = None
    date_of_birth: date | None = None
    address: str | None = Field(default=None, max_length=500)
    joined_on: date | None = None
    status: Literal["active", "inactive"] = "active"
    notes: str | None = Field(default=None, max_length=500)

    _c = field_validator("full_name", "address", "notes", mode="before")(classmethod(lambda cls, v: _clean(v)))
    _p = field_validator("phone", "alternate_phone")(classmethod(lambda cls, v: normalize_phone(v)))

    @field_validator("license_number")
    @classmethod
    def _lic(cls, v: str | None) -> str | None:
        return license_no(v)

    @model_validator(mode="after")
    def _check(self) -> "StaffIn":
        if self.role == "driver" and not (self.license_number and self.license_valid_until):
            raise ValueError("Enter the driver's licence number and the date it is valid until.")
        if self.date_of_birth:
            today = date.today()
            age = (
                today.year
                - self.date_of_birth.year
                - ((today.month, today.day) < (self.date_of_birth.month, self.date_of_birth.day))
            )
            if age < 18:
                raise ValueError("Transport staff must be at least 18 years old.")
        return self


STAFF_SELECT = """
select s.*, (select string_agg(r.name, ', ' order by r.name) from public.transport_routes r
             where (r.driver_id = s.id or r.attendant_id = s.id) and r.status = 'active') as route_names,
       (select count(*) from public.transport_documents d where d.staff_id = s.id) as documents
from public.transport_staff s
"""


@router.get("/staff")
async def staff_list(
    ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db), role: Literal["driver", "attendant"] | None = None
) -> list[dict]:
    rows = _rows(
        await db.execute(
            text(
                f"{STAFF_SELECT} where s.school_id = :s and (cast(:r as text) is null or s.role = :r) "
                "order by s.status, s.role, s.full_name"
            ),
            {"s": ctx.school_id, "r": role},
        )
    )
    if not ctx.can(Permission.TRANSPORT_MANAGE):  # accountants: names and routes only
        keep = {"id", "role", "full_name", "phone", "status", "route_names"}
        rows = [{k: v for k, v in r.items() if k in keep} for r in rows]
    return rows


async def _staff(db: AsyncSession, ctx: SchoolContext, staff_id: uuid.UUID) -> dict:
    s = await _one(
        db, f"{STAFF_SELECT} where s.id = :id and s.school_id = :s", {"id": staff_id, "s": ctx.school_id}, "Not found."
    )
    s["documents"] = await _documents(db, "staff_id", staff_id) if ctx.can(Permission.TRANSPORT_MANAGE) else []
    return s


@router.get("/staff/{staff_id}")
async def staff(staff_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    return await _staff(db, ctx, staff_id)


@router.post("/staff", status_code=status.HTTP_201_CREATED)
async def add_staff(
    payload: StaffIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    v = payload.model_dump()
    sid = (
        await _call(
            db,
            f"insert into public.transport_staff (school_id, {', '.join(v)}, created_by) "
            f"values (:school_id, {', '.join(':' + k for k in v)}, :by) returning id",
            {**v, "school_id": ctx.school_id, "by": user.id},
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="transport.staff_added",
        entity_type="transport_staff",
        entity_id=str(sid),
        school_id=ctx.school_id,
        metadata={"role": payload.role, "name": payload.full_name},
    )
    await db.commit()
    return await _staff(db, ctx, sid)


@router.put("/staff/{staff_id}")
async def update_staff(
    staff_id: uuid.UUID, payload: StaffIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    v = payload.model_dump()
    r = await _call(
        db,
        "update public.transport_staff set "
        + ", ".join(f"{k} = :{k}" for k in v)
        + " where id = :id and school_id = :s",
        {**v, "id": staff_id, "s": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found.")
    await db.commit()
    return await _staff(db, ctx, staff_id)


@router.delete("/staff/{staff_id}")
async def delete_staff(staff_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    paths = (
        await db.scalars(
            text("select file_path from public.transport_documents where staff_id = :id"), {"id": staff_id}
        )
    ).all()
    await _delete_or_explain(
        db,
        "delete from public.transport_staff where id = :id and school_id = :s",
        {"id": staff_id, "s": ctx.school_id},
        "This person is on a route. Take them off it first, or mark them inactive.",
        "Not found.",
    )
    for p in paths:
        await storage.delete(storage.TRANSPORT_DOC_BUCKET, p)
    return {"ok": True}


# ------------------------------------------------------------------ documents
async def _owner(db: AsyncSession, ctx: SchoolContext, kind: str, owner_id: uuid.UUID) -> None:
    table = "transport_vehicles" if kind == "vehicles" else "transport_staff"
    ok = (
        await db.execute(
            text(f"select 1 from public.{table} where id = :id and school_id = :s"),
            {"id": owner_id, "s": ctx.school_id},
        )
    ).first()
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found.")


def _doc_date(v: str | None, label: str) -> date | None:
    if not v:
        return None
    try:
        return date.fromisoformat(v)
    except ValueError:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{label}: enter a date.") from None


@router.post("/{kind}/{owner_id}/documents", status_code=status.HTTP_201_CREATED)
async def upload_document(
    kind: Literal["vehicles", "staff"],
    owner_id: uuid.UUID,
    request: Request,
    file: UploadFile = File(...),
    doc_type: str = Form(...),
    title: str | None = Form(default=None, max_length=120),
    number: str | None = Form(default=None, max_length=60),
    issued_on: str | None = Form(default=None),
    valid_until: str | None = Form(default=None),
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    await _owner(db, ctx, kind, owner_id)
    allowed = VEHICLE_DOCS if kind == "vehicles" else STAFF_DOCS
    if doc_type not in allowed:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose the kind of document.")
    title = _clean(title)  # type: ignore[assignment]
    if doc_type == "other" and not title:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Describe the document.")
    issued, valid = _doc_date(issued_on, "Issued on"), _doc_date(valid_until, "Valid until")
    if issued and valid and valid < issued:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "“Valid until” is before the issue date.")
    col = "vehicle_id" if kind == "vehicles" else "staff_id"
    count = (
        await db.execute(text(f"select count(*) from public.transport_documents where {col} = :id"), {"id": owner_id})
    ).scalar_one()
    if count >= MAX_DOCS:
        raise HTTPException(status.HTTP_409_CONFLICT, f"At most {MAX_DOCS} documents each.")
    data = await file.read(10 * 1024 * 1024 + 1)
    try:
        clean = await run_in_threadpool(clean_document, data)
    except DocumentError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    doc_id = uuid.uuid4()
    path = f"{ctx.school_id}/transport/{kind}/{owner_id}/{doc_id.hex}.{clean.extension}"
    try:
        await storage.upload(storage.TRANSPORT_DOC_BUCKET, path, clean.data, clean.mime_type)
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    try:
        await db.execute(
            text(
                f"insert into public.transport_documents (id, school_id, {col}, doc_type, title, number, "
                f"issued_on, valid_until, "
                "file_path, file_name, mime_type, size_bytes, uploaded_by) values (:id, :s, :o, :t, :ti, "
                ":n, :i, :v, :p, :f, :m, :b, :u)"
            ),
            {
                "id": doc_id,
                "s": ctx.school_id,
                "o": owner_id,
                "t": doc_type,
                "ti": title,
                "n": _clean(number),
                "i": issued,
                "v": valid,
                "p": path,
                "f": safe_filename(file.filename, clean.extension),
                "m": clean.mime_type,
                "b": len(clean.data),
                "u": user.id,
            },
        )
        await write_audit(
            db,
            request,
            action="transport.document_uploaded",
            entity_type="transport_document",
            entity_id=str(doc_id),
            school_id=ctx.school_id,
            metadata={"owner": f"{kind}:{owner_id}", "type": doc_type, "valid_until": valid_until},
        )
        await db.commit()
    except DBAPIError as exc:
        await storage.delete(storage.TRANSPORT_DOC_BUCKET, path)
        raise await http_error_from_db(db, exc) from None
    return await _documents(db, col, owner_id)


async def _doc(db: AsyncSession, ctx: SchoolContext, doc_id: uuid.UUID) -> dict:
    return await _one(
        db,
        "select * from public.transport_documents where id = :id and school_id = :s",
        {"id": doc_id, "s": ctx.school_id},
        "Document not found.",
    )


@router.get("/documents/{doc_id}/file")
async def document_file(
    doc_id: uuid.UUID,
    request: Request,
    download: bool = False,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    d = await _doc(db, ctx, doc_id)
    try:
        body = await storage.open_stream(storage.TRANSPORT_DOC_BUCKET, d["file_path"])
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    await write_audit(
        db,
        request,
        action="transport.document_viewed",
        entity_type="transport_document",
        entity_id=str(doc_id),
        school_id=ctx.school_id,
    )
    await db.commit()
    return StreamingResponse(
        body,
        media_type=d["mime_type"],
        headers={
            "Content-Length": str(d["size_bytes"]),
            "Content-Disposition": content_disposition("attachment" if download else "inline", d["file_name"]),
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            "Cross-Origin-Resource-Policy": "same-site",
        },
    )


class DocumentUpdate(BaseModel):
    model_config = {"extra": "forbid"}
    title: str | None = Field(default=None, max_length=120)
    number: str | None = Field(default=None, max_length=60)
    issued_on: date | None = None
    valid_until: date | None = None
    _c = field_validator("title", "number", mode="before")(classmethod(lambda cls, v: _clean(v)))


@router.patch("/documents/{doc_id}")
async def update_document(
    doc_id: uuid.UUID, payload: DocumentUpdate, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    d = await _doc(db, ctx, doc_id)
    await _call(
        db,
        "update public.transport_documents set title = :t, number = :n, issued_on = :i, valid_until = :v "
        "where id = :id",
        {"t": payload.title, "n": payload.number, "i": payload.issued_on, "v": payload.valid_until, "id": doc_id},
    )
    await db.commit()
    col = "vehicle_id" if d["vehicle_id"] else "staff_id"
    return await _documents(db, col, uuid.UUID(d[col]))


@router.delete("/documents/{doc_id}")
async def delete_document(
    doc_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    d = await _doc(db, ctx, doc_id)
    await db.execute(text("delete from public.transport_documents where id = :id"), {"id": doc_id})
    await write_audit(
        db,
        request,
        action="transport.document_deleted",
        entity_type="transport_document",
        entity_id=str(doc_id),
        school_id=ctx.school_id,
        metadata={"type": d["doc_type"], "file_name": d["file_name"]},
    )
    await db.commit()
    await storage.delete(storage.TRANSPORT_DOC_BUCKET, d["file_path"])
    col = "vehicle_id" if d["vehicle_id"] else "staff_id"
    return await _documents(db, col, uuid.UUID(d[col]))


# ------------------------------------------------------------------ fare zones
class ZoneIn(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=1, max_length=40)
    amount: Decimal = Field(gt=0, le=1000000, max_digits=9, decimal_places=2)
    frequency: Literal["monthly", "quarterly", "half_yearly", "yearly"] = "monthly"
    billing_months: list[int] | None = Field(default=None, max_length=12)
    due_month: int | None = Field(default=None, ge=1, le=12)
    is_active: bool = True
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _months(self) -> "ZoneIn":
        if self.frequency == "monthly":
            self.due_month = None
            if self.billing_months is not None:
                ms = sorted(set(self.billing_months))
                if not ms or any(m < 1 or m > 12 for m in ms):
                    raise ValueError("Choose the months to bill (1 to 12).")
                self.billing_months = None if len(ms) == 12 else ms
        else:
            self.billing_months = None
            if self.due_month is None:
                raise ValueError("Choose the month the fee is first due.")
        return self


ZONE_SELECT = """
select z.id, z.name, z.amount, z.frequency, z.billing_months, z.due_month, z.is_active, z.fee_head_id,
       h.name as fee_head,
       (select count(*) from public.transport_stops st where st.fare_zone_id = z.id) as stops,
       (select count(distinct a.student_id) from public.transport_assignments a
        join public.transport_stops st on st.id = a.stop_id
        where st.fare_zone_id = z.id and a.start_date <= current_date
          and (a.end_date is null or a.end_date >= current_date)) as riders
from public.transport_fare_zones z join public.fee_heads h on h.id = z.fee_head_id
"""


@router.get("/zones")
async def zones(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> list[dict]:
    return _rows(
        await db.execute(
            text(f"{ZONE_SELECT} where z.school_id = :s order by not z.is_active, z.amount, z.name"),
            {"s": ctx.school_id},
        )
    )


@router.post("/zones", status_code=status.HTTP_201_CREATED)
async def add_zone(
    payload: ZoneIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    zid = (
        await _call(
            db,
            "select private.transport_add_zone(:s, :n, :a, cast(:f as public.fee_frequency), cast(:bm as "
            "smallint[]), :dm)",
            {
                "s": ctx.school_id,
                "n": payload.name,
                "a": payload.amount,
                "f": payload.frequency,
                "bm": payload.billing_months,
                "dm": payload.due_month,
            },
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="transport.zone_added",
        entity_type="transport_fare_zone",
        entity_id=str(zid),
        school_id=ctx.school_id,
        metadata={"name": payload.name, "amount": str(payload.amount), "frequency": payload.frequency},
    )
    await db.commit()
    return await zones(ctx, db)


@router.put("/zones/{zone_id}")
async def update_zone(
    zone_id: uuid.UUID,
    payload: ZoneIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    r = await _call(
        db,
        "update public.transport_fare_zones set name = :n, amount = :a, frequency = cast(:f as public.fee_frequency), "
        "billing_months = cast(:bm as smallint[]), due_month = :dm, is_active = :ac where id = :id and school_id = :s",
        {
            "n": payload.name,
            "a": payload.amount,
            "f": payload.frequency,
            "bm": payload.billing_months,
            "dm": payload.due_month,
            "ac": payload.is_active,
            "id": zone_id,
            "s": ctx.school_id,
        },
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Fare zone not found.")
    await write_audit(
        db,
        request,
        action="transport.zone_changed",
        entity_type="transport_fare_zone",
        entity_id=str(zone_id),
        school_id=ctx.school_id,
        metadata={"amount": str(payload.amount), "frequency": payload.frequency, "active": payload.is_active},
    )
    await db.commit()
    return await zones(ctx, db)


# ------------------------------------------------------------------ routes & stops
class RouteIn(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=2, max_length=80)
    code: str | None = Field(default=None, pattern=r"^[A-Za-z0-9-]{1,12}$")
    vehicle_id: uuid.UUID | None = None
    driver_id: uuid.UUID | None = None
    attendant_id: uuid.UUID | None = None
    status: Literal["active", "inactive"] = "active"
    notes: str | None = Field(default=None, max_length=500)
    _c = field_validator("name", "code", "notes", mode="before")(classmethod(lambda cls, v: _clean(v)))


ROUTE_SELECT = """
select r.id, r.name, r.code, r.status, r.notes, r.vehicle_id, v.registration_number, v.vehicle_type, v.seating_capacity,
       v.status as vehicle_status, r.driver_id, d.full_name as driver_name, d.phone as driver_phone,
       d.license_valid_until as driver_license_valid_until, r.attendant_id, a.full_name as attendant_name,
       a.phone as attendant_phone, private.transport_route_riders(r.id) as riders,
       (select count(*) from public.transport_stops s where s.route_id = r.id) as stops,
       (select min(s.pickup_time) from public.transport_stops s where s.route_id = r.id) as first_pickup
from public.transport_routes r
left join public.transport_vehicles v on v.id = r.vehicle_id
left join public.transport_staff d on d.id = r.driver_id
left join public.transport_staff a on a.id = r.attendant_id
"""


@router.get("/routes")
async def routes(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> list[dict]:
    return _rows(
        await db.execute(text(f"{ROUTE_SELECT} where r.school_id = :s order by r.status, r.name"), {"s": ctx.school_id})
    )


async def _route(db: AsyncSession, ctx: SchoolContext, route_id: uuid.UUID) -> dict:
    r = await _one(
        db,
        f"{ROUTE_SELECT} where r.id = :id and r.school_id = :s",
        {"id": route_id, "s": ctx.school_id},
        "Route not found.",
    )
    r["stop_list"] = _rows(
        await db.execute(
            text(
                "select s.id, s.name, s.landmark, s.sequence, s.pickup_time, s.drop_time, s.fare_zone_id, "
                "z.name as fare_zone, "
                "z.amount as fare, z.frequency as fare_frequency, "
                "(select count(*) from public.transport_assignments a join public.students x on x.id = a.student_id "
                " and x.status = 'active' where a.stop_id = s.id and a.start_date <= current_date "
                " and (a.end_date is null or a.end_date >= current_date)) as riders, "
                "exists (select 1 from public.transport_assignments a where a.stop_id = s.id) as used "
                "from public.transport_stops s join public.transport_fare_zones z on z.id = s.fare_zone_id "
                "where s.route_id = :id order by s.sequence, s.name"
            ),
            {"id": route_id},
        )
    )
    return r


@router.get("/routes/{route_id}")
async def route(route_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    return await _route(db, ctx, route_id)


@router.post("/routes", status_code=status.HTTP_201_CREATED)
async def add_route(
    payload: RouteIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    v = payload.model_dump()
    rid = (
        await _call(
            db,
            f"insert into public.transport_routes (school_id, {', '.join(v)}, created_by) "
            f"values (:school_id, {', '.join(':' + k for k in v)}, :by) returning id",
            {**v, "school_id": ctx.school_id, "by": user.id},
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="transport.route_added",
        entity_type="transport_route",
        entity_id=str(rid),
        school_id=ctx.school_id,
        metadata={"name": payload.name},
    )
    await db.commit()
    return await _route(db, ctx, rid)


@router.put("/routes/{route_id}")
async def update_route(
    route_id: uuid.UUID,
    payload: RouteIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    v = payload.model_dump()
    r = await _call(
        db,
        "update public.transport_routes set "
        + ", ".join(f"{k} = :{k}" for k in v)
        + " where id = :id and school_id = :s",
        {**v, "id": route_id, "s": ctx.school_id},
    )
    if r.rowcount != 1:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Route not found.")
    await write_audit(
        db,
        request,
        action="transport.route_changed",
        entity_type="transport_route",
        entity_id=str(route_id),
        school_id=ctx.school_id,
        metadata={k: str(x) if x is not None else None for k, x in v.items() if k != "notes"},
    )
    await db.commit()
    return await _route(db, ctx, route_id)


@router.delete("/routes/{route_id}")
async def delete_route(route_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    await _delete_or_explain(
        db,
        "delete from public.transport_routes where id = :id and school_id = :s",
        {"id": route_id, "s": ctx.school_id},
        "Students have used this route, so it is kept for their records. Mark it inactive instead.",
        "Route not found.",
    )
    return {"ok": True}


class StopIn(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(min_length=2, max_length=80)
    landmark: str | None = Field(default=None, max_length=150)
    sequence: int | None = Field(default=None, ge=1, le=200)
    pickup_time: time | None = None
    drop_time: time | None = None
    fare_zone_id: uuid.UUID
    _c = field_validator("name", "landmark", mode="before")(classmethod(lambda cls, v: _clean(v)))


@router.post("/routes/{route_id}/stops", status_code=status.HTTP_201_CREATED)
async def add_stop(
    route_id: uuid.UUID, payload: StopIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    await _route(db, ctx, route_id)
    seq = (
        payload.sequence
        or (
            await db.execute(
                text("select coalesce(max(sequence), 0) + 1 from public.transport_stops where route_id = :r"),
                {"r": route_id},
            )
        ).scalar_one()
    )
    await _call(
        db,
        "insert into public.transport_stops (school_id, route_id, name, landmark, sequence, pickup_time, "
        "drop_time, fare_zone_id) "
        "values (:s, :r, :n, :l, :q, :p, :d, :z)",
        {
            "s": ctx.school_id,
            "r": route_id,
            "n": payload.name,
            "l": payload.landmark,
            "q": seq,
            "p": payload.pickup_time,
            "d": payload.drop_time,
            "z": payload.fare_zone_id,
        },
    )
    await db.commit()
    return await _route(db, ctx, route_id)


async def _stop_route(db: AsyncSession, ctx: SchoolContext, stop_id: uuid.UUID) -> uuid.UUID:
    r = (
        await db.execute(
            text("select route_id from public.transport_stops where id = :id and school_id = :s"),
            {"id": stop_id, "s": ctx.school_id},
        )
    ).scalar()
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Stop not found.")
    return r


@router.put("/stops/{stop_id}")
async def update_stop(
    stop_id: uuid.UUID, payload: StopIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    route_id = await _stop_route(db, ctx, stop_id)
    await _call(
        db,
        "update public.transport_stops set name = :n, landmark = :l, sequence = coalesce(:q, sequence), "
        "pickup_time = :p, "
        "drop_time = :d, fare_zone_id = :z where id = :id",
        {
            "n": payload.name,
            "l": payload.landmark,
            "q": payload.sequence,
            "p": payload.pickup_time,
            "d": payload.drop_time,
            "z": payload.fare_zone_id,
            "id": stop_id,
        },
    )
    await db.commit()
    return await _route(db, ctx, route_id)


@router.delete("/stops/{stop_id}")
async def delete_stop(stop_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    route_id = await _stop_route(db, ctx, stop_id)
    await _delete_or_explain(
        db,
        "delete from public.transport_stops where id = :id",
        {"id": stop_id},
        "Students have used this stop, so it is kept for their records.",
        "Stop not found.",
    )
    return await _route(db, ctx, route_id)


class OrderIn(BaseModel):
    model_config = {"extra": "forbid"}
    stop_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


@router.put("/routes/{route_id}/stops/order")
async def order_stops(
    route_id: uuid.UUID, payload: OrderIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    current = set(
        (
            await db.scalars(
                text("select id from public.transport_stops where route_id = :r and school_id = :s"),
                {"r": route_id, "s": ctx.school_id},
            )
        ).all()
    )
    if current != set(payload.stop_ids) or len(payload.stop_ids) != len(current):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "List every stop of the route once.")
    for i, sid in enumerate(payload.stop_ids, start=1):
        await db.execute(text("update public.transport_stops set sequence = :q where id = :id"), {"q": i, "id": sid})
    await db.commit()
    return await _route(db, ctx, route_id)


# ------------------------------------------------------------------ students on routes
ASSIGN_SELECT = """
select a.id, a.student_id, s.full_name as student_name, s.student_code, s.mobile, s.status as student_status,
       c.name || ' – ' || sec.name as class_section, a.academic_session_id, a.route_id, r.name as route_name,
              r.code as route_code,
       a.stop_id, st.name as stop_name, st.sequence as stop_sequence, st.pickup_time, st.drop_time, z.name as fare_zone,
       z.amount as fare, z.frequency as fare_frequency, a.trip, a.start_date, a.end_date, a.charge_fee, a.notes,
       (a.start_date <= current_date and (a.end_date is null or a.end_date >= current_date)) as is_current
from public.transport_assignments a
join public.students s on s.id = a.student_id
left join public.student_enrollments e on e.student_id = a.student_id and e.academic_session_id = a.academic_session_id
left join public.classes c on c.id = e.class_id
left join public.sections sec on sec.id = e.section_id
join public.transport_routes r on r.id = a.route_id
join public.transport_stops st on st.id = a.stop_id
join public.transport_fare_zones z on z.id = st.fare_zone_id
"""
AssignState = Literal["current", "future", "ended", "all"]
ASSIGN_CSV = [
    ("student_name", "Student", "text"),
    ("student_code", "Student ID", "text"),
    ("class_section", "Class", "text"),
    ("route_name", "Route", "text"),
    ("stop_name", "Stop", "text"),
    ("pickup_time", "Pickup", "text"),
    ("drop_time", "Drop", "text"),
    ("trip", "Trip", "text"),
    ("fare_zone", "Fare zone", "text"),
    ("fare", "Fare", "money"),
    ("start_date", "From", "text"),
    ("end_date", "Until", "text"),
    ("mobile", "Family mobile", "text"),
]


@router.get("/students")
async def assignments(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    state: AssignState = "current",
    route_id: uuid.UUID | None = None,
    stop_id: uuid.UUID | None = None,
    class_id: uuid.UUID | None = None,
    q: str | None = Query(default=None, max_length=100),
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=50, ge=1, le=200),
    format: Literal["json", "csv"] = "json",
) -> Any:
    where = ["a.school_id = :s"]
    p: dict[str, Any] = {"s": ctx.school_id}
    where.append(
        {
            "current": "a.start_date <= current_date and (a.end_date is null or a.end_date >= current_date)",
            "future": "a.start_date > current_date",
            "ended": "a.end_date < current_date",
            "all": "true",
        }[state]
    )
    for k, col in (("route_id", "a.route_id"), ("stop_id", "a.stop_id"), ("class_id", "e.class_id")):
        val = {"route_id": route_id, "stop_id": stop_id, "class_id": class_id}[k]
        if val:
            where.append(f"{col} = :{k}")
            p[k] = val
    if q and q.strip():
        p["q"] = q.strip().lower()
        where.append(
            "(lower(s.full_name) like '%' || :q || '%' or lower(s.student_code) = :q or lower(st.name) "
            "like '%' || :q || '%')"
        )
    w = " and ".join(where)
    order = "r.name, st.sequence, s.full_name"
    if format == "csv":
        rows = _rows(await db.execute(text(f"{ASSIGN_SELECT} where {w} order by {order}"), p))
        for r in rows:
            r["fare"] = Decimal(r["fare"]) if r["fare"] else None
        return Response(
            to_csv(ASSIGN_CSV, rows),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="transport-students-{state}.csv"'},
        )
    total = (
        await db.execute(
            text(
                "select count(*) from public.transport_assignments a join public.students s on s.id = a.student_id "
                "left join public.student_enrollments e on e.student_id = a.student_id and "
                "e.academic_session_id = a.academic_session_id "
                f"join public.transport_stops st on st.id = a.stop_id where {w}"
            ),
            p,
        )
    ).scalar_one()
    items = _rows(
        await db.execute(
            text(f"{ASSIGN_SELECT} where {w} order by {order} limit :lim offset :off"),
            {**p, "lim": page_size, "off": (page - 1) * page_size},
        )
    )
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/routes/{route_id}/sheet")
async def route_sheet(route_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    """The route's riders by stop (today), for the driver and attendant's printed sheet."""
    r = await _route(db, ctx, route_id)
    riders = _rows(
        await db.execute(
            text(
                f"{ASSIGN_SELECT} where a.route_id = :r and a.start_date <= current_date "
                "and (a.end_date is null or a.end_date >= current_date) and s.status = 'active' order by "
                "st.sequence, s.full_name"
            ),
            {"r": route_id},
        )
    )
    for st in r["stop_list"]:
        st["students"] = [x for x in riders if x["stop_id"] == st["id"]]
    return r


class AssignIn(BaseModel):
    model_config = {"extra": "forbid"}
    student_id: uuid.UUID
    route_id: uuid.UUID
    stop_id: uuid.UUID
    trip: Literal["both", "pickup", "drop"] = "both"
    start_date: date
    charge_fee: bool = True
    notes: str | None = Field(default=None, max_length=300)


@router.post("/assignments", status_code=status.HTTP_201_CREATED)
async def assign(
    payload: AssignIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    aid = (
        await _call(
            db,
            "select private.transport_assign(:st, :r, :sp, :t, :d, :c, :n)",
            {
                "st": payload.student_id,
                "r": payload.route_id,
                "sp": payload.stop_id,
                "t": payload.trip,
                "d": payload.start_date,
                "c": payload.charge_fee,
                "n": _clean(payload.notes),
            },
        )
    ).scalar_one()
    await write_audit(
        db,
        request,
        action="transport.assigned",
        entity_type="student",
        entity_id=str(payload.student_id),
        school_id=ctx.school_id,
        metadata={
            "route_id": str(payload.route_id),
            "stop_id": str(payload.stop_id),
            "from": payload.start_date.isoformat(),
            "charge_fee": payload.charge_fee,
        },
    )
    await db.commit()
    return await _one(db, f"{ASSIGN_SELECT} where a.id = :id", {"id": aid}, "Not found.")


class EndIn(BaseModel):
    model_config = {"extra": "forbid"}
    end_date: date | None = None  # none = remove an assignment that hasn't started


@router.post("/assignments/{assignment_id}/end")
async def end_assignment(
    assignment_id: uuid.UUID,
    payload: EndIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    a = await _one(
        db,
        "select student_id from public.transport_assignments where id = :id and school_id = :s",
        {"id": assignment_id, "s": ctx.school_id},
        "Not found.",
    )
    await _call(db, "select private.transport_end(:id, :d)", {"id": assignment_id, "d": payload.end_date})
    await write_audit(
        db,
        request,
        action="transport.ended" if payload.end_date else "transport.removed",
        entity_type="student",
        entity_id=a["student_id"],
        school_id=ctx.school_id,
        metadata={
            "assignment_id": str(assignment_id),
            "until": payload.end_date.isoformat() if payload.end_date else None,
        },
    )
    await db.commit()
    return {"ok": True}


class AssignUpdate(BaseModel):
    model_config = {"extra": "forbid"}
    stop_id: uuid.UUID
    trip: Literal["both", "pickup", "drop"]
    charge_fee: bool
    notes: str | None = Field(default=None, max_length=300)


@router.put("/assignments/{assignment_id}")
async def update_assignment(
    assignment_id: uuid.UUID, payload: AssignUpdate, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    await _one(
        db,
        "select 1 as x from public.transport_assignments where id = :id and school_id = :s",
        {"id": assignment_id, "s": ctx.school_id},
        "Not found.",
    )
    await _call(
        db,
        "select private.transport_update_assignment(:id, :sp, :t, :c, :n)",
        {
            "id": assignment_id,
            "sp": payload.stop_id,
            "t": payload.trip,
            "c": payload.charge_fee,
            "n": _clean(payload.notes),
        },
    )
    await db.commit()
    return await _one(db, f"{ASSIGN_SELECT} where a.id = :id", {"id": assignment_id}, "Not found.")


@router.get("/student/{student_id}")
async def student_transport(
    student_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> dict:
    """A student's transport (current and past), for the student's page."""
    ok = (
        await db.execute(
            text("select 1 from public.students where id = :id and school_id = :s"),
            {"id": student_id, "s": ctx.school_id},
        )
    ).first()
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found.")
    items = _rows(
        await db.execute(
            text(f"{ASSIGN_SELECT} where a.student_id = :id order by a.start_date desc"), {"id": student_id}
        )
    )
    return {"items": items, "current": next((i for i in items if i["is_current"]), None)}


# ------------------------------------------------------------------ families (portals)
async def family_transport(db: AsyncSession, student_id: uuid.UUID) -> dict:
    """Called after the portal has checked the parent/student link; the database checks again."""
    items = (await _call(db, "select private.transport_for_student(:s)", {"s": student_id})).scalar() or []
    for i in items:
        for k in ("pickup_time", "drop_time"):
            if i.get(k):
                i[k] = i[k][:5]
        i["fare"] = f"{Decimal(str(i['fare'])):.2f}" if i.get("fare") is not None else None
    current = next((i for i in items if i["is_current"]), None)
    upcoming = [i for i in items if not i["is_current"] and i["start_date"] > date.today().isoformat()]
    return {
        "current": current,
        "upcoming": upcoming,
        "history": [i for i in items if i is not current and i not in upcoming],
    }
