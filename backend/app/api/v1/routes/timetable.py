"""Timetables: subjects, the bell schedule (periods) and class / teacher timetables.

Clashes are checked here first so the message can name them ("Meera Iyer is
already teaching Class 2 – A in Period 3 on Monday"); unique indexes in the
database (tt_class_slot / tt_teacher_slot / tt_room_slot) make them impossible
even if two people save at the same moment. Who may see a class timetable is
decided by private.can_view_section_timetable (RLS on timetable_entries)."""

import re
import uuid
from datetime import UTC, datetime, time

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services.academics import resolve_session
from app.services.audit import write_audit
from app.services.timetable_pdf import DAY_NAMES, PdfCell, PdfPeriod, build_timetable_pdf

router = APIRouter(prefix="/timetable", tags=["timetable"])
VIEW = Depends(require_permission(Permission.TIMETABLE_VIEW))
MANAGE = Depends(require_permission(Permission.TIMETABLE_MANAGE))

UNIQUE = {
    "subjects_school_name_key": "A subject with this name already exists.",
    "subjects_school_code_key": "Another subject already uses this code.",
    "periods_number_key": "That period number already exists in this session.",
    # backstops for two saves at the same moment (the API normally names the clash first)
    "tt_class_slot": "This class already has a subject at that time.",
    "tt_teacher_slot": "That teacher is already teaching another class at that time.",
    "tt_room_slot": "That room is already in use at that time.",
}
COMMON_SUBJECTS = [
    "English",
    "Hindi",
    "Mathematics",
    "Science",
    "Social Science",
    "Computer Science",
    "Sanskrit",
    "Physical Education",
    "Art",
    "Music",
    "General Knowledge",
    "Environmental Studies",
]


# ------------------------------------------------------------------ schemas
class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _clean(v: object) -> object:
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


def check_code(v: str | None) -> str | None:
    if v is None:
        return None
    if not re.fullmatch(r"[A-Za-z0-9-]{1,12}", v):
        raise ValueError("Codes use letters, numbers and - only (up to 12).")
    return v.upper()


class SubjectIn(_Strict):
    name: str = Field(min_length=1, max_length=60)
    code: str | None = Field(default=None, max_length=12)

    _c = field_validator("name", "code", mode="before")(classmethod(lambda cls, v: _clean(v)))
    _code = field_validator("code")(classmethod(lambda cls, v: check_code(v)))


class SubjectUpdate(_Strict):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    code: str | None = Field(default=None, max_length=12)
    is_active: bool | None = None

    _c = field_validator("name", "code", mode="before")(classmethod(lambda cls, v: _clean(v)))
    _code = field_validator("code")(classmethod(lambda cls, v: check_code(v)))


class SubjectOut(BaseModel):
    id: uuid.UUID
    name: str
    code: str | None
    is_active: bool
    periods_per_week: int


class PeriodIn(_Strict):
    period_number: int = Field(ge=1, le=20)
    label: str | None = Field(default=None, max_length=40)
    start_time: time
    end_time: time
    is_break: bool = False

    _c = field_validator("label", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _times(self) -> "PeriodIn":
        if self.end_time <= self.start_time:
            raise ValueError("A period must end after it starts.")
        return self


class PeriodCreate(PeriodIn):
    academic_session_id: uuid.UUID


class GenerateDay(_Strict):
    academic_session_id: uuid.UUID
    first_start: time = time(8, 0)
    period_minutes: int = Field(default=40, ge=20, le=120)
    periods: int = Field(default=8, ge=1, le=12)
    break_after: int | None = Field(default=4, ge=1, le=11, description="Insert a break after this period")
    break_minutes: int = Field(default=30, ge=5, le=90)
    break_label: str = Field(default="Lunch", max_length=40)


class PeriodOut(BaseModel):
    id: uuid.UUID
    period_number: int
    label: str | None
    start_time: time
    end_time: time
    is_break: bool
    in_use: int


class EntryIn(_Strict):
    section_id: uuid.UUID
    day_of_week: int = Field(ge=1, le=7)
    period_id: uuid.UUID
    subject_id: uuid.UUID
    teacher_id: uuid.UUID | None = None
    room: str | None = Field(default=None, max_length=30)

    _c = field_validator("room", mode="before")(classmethod(lambda cls, v: _clean(v)))


class EntryUpdate(_Strict):
    subject_id: uuid.UUID | None = None
    teacher_id: uuid.UUID | None = None
    room: str | None = Field(default=None, max_length=30)

    _c = field_validator("room", mode="before")(classmethod(lambda cls, v: _clean(v)))

    @model_validator(mode="after")
    def _subject(self) -> "EntryUpdate":
        if "subject_id" in self.model_fields_set and self.subject_id is None:
            raise ValueError("Choose a subject.")
        return self


class CheckIn(_Strict):
    section_id: uuid.UUID
    day_of_week: int = Field(ge=1, le=7)
    period_id: uuid.UUID
    teacher_id: uuid.UUID | None = None
    room: str | None = Field(default=None, max_length=30)
    entry_id: uuid.UUID | None = None


class Cell(BaseModel):
    id: uuid.UUID
    day_of_week: int
    period_id: uuid.UUID
    subject_id: uuid.UUID
    subject_name: str
    subject_code: str | None
    teacher_id: uuid.UUID | None
    teacher_name: str | None
    room: str | None
    section_id: uuid.UUID
    class_name: str
    section_name: str


class Grid(BaseModel):
    kind: str  # "class" | "teacher"
    title: str
    session_id: uuid.UUID | None
    session_name: str | None
    session_is_archived: bool
    periods: list[PeriodOut]
    days: list[int]
    cells: list[Cell]


# ------------------------------------------------------------------ helpers
def _hm(t: time) -> str:
    return t.strftime("%H:%M")


async def _periods(db: AsyncSession, session_id: uuid.UUID) -> list[PeriodOut]:
    rows = (
        await db.execute(
            text(
                "select p.id, p.period_number, p.label, p.start_time, p.end_time, p.is_break, "
                "(select count(*) from public.timetable_entries e where e.period_id = p.id) "
                "from public.timetable_periods p where p.academic_session_id = :sid order by p.start_time"
            ),
            {"sid": session_id},
        )
    ).all()
    return [
        PeriodOut(id=r[0], period_number=r[1], label=r[2], start_time=r[3], end_time=r[4], is_break=r[5], in_use=r[6])
        for r in rows
    ]


_CELLS = (
    "select e.id, e.day_of_week, e.period_id, e.subject_id, sub.name, sub.code, e.teacher_id, "
    "private.teacher_display_name(e.teacher_id), e.room, e.section_id, c.name, sec.name "
    "from public.timetable_entries e join public.subjects sub on sub.id = e.subject_id "
    "join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id "
)


def _cells(rows) -> list[Cell]:
    return [
        Cell(
            id=r[0],
            day_of_week=r[1],
            period_id=r[2],
            subject_id=r[3],
            subject_name=r[4],
            subject_code=r[5],
            teacher_id=r[6],
            teacher_name=r[7],
            room=r[8],
            section_id=r[9],
            class_name=r[10],
            section_name=r[11],
        )
        for r in rows
    ]


def _days(cells: list[Cell]) -> list[int]:
    days = [1, 2, 3, 4, 5, 6]
    return days + [7] if any(c.day_of_week == 7 for c in cells) else days


async def _section(db: AsyncSession, ctx: SchoolContext, section_id: uuid.UUID):
    row = (
        await db.execute(
            text(
                "select sec.id, c.name || ' – ' || sec.name, a.id, a.name, a.archived_at is not null, "
                "private.can_view_section_timetable(sec.id) "
                "from public.sections sec join public.classes c on c.id = sec.class_id "
                "join public.academic_sessions a on a.id = sec.academic_session_id "
                "where sec.id = :id and sec.school_id = :s and sec.deleted_at is null"
            ),
            {"id": section_id, "s": ctx.school_id},
        )
    ).first()
    if row is None or not row[5]:  # not visible to this user: same answer as "doesn't exist"
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Class not found.")
    return row


async def class_grid(db: AsyncSession, ctx: SchoolContext, section_id: uuid.UUID) -> Grid:
    sec = await _section(db, ctx, section_id)
    cells = _cells((await db.execute(text(_CELLS + "where e.section_id = :sec"), {"sec": section_id})).all())
    return Grid(
        kind="class",
        title=sec[1],
        session_id=sec[2],
        session_name=sec[3],
        session_is_archived=sec[4],
        periods=await _periods(db, sec[2]),
        days=_days(cells),
        cells=cells,
    )


async def teacher_grid(
    db: AsyncSession, ctx: SchoolContext, teacher_id: uuid.UUID, session_id: uuid.UUID | None
) -> Grid:
    name = (
        await db.execute(
            text("select full_name from public.teachers where id = :t and school_id = :s"),
            {"t": teacher_id, "s": ctx.school_id},
        )
    ).scalar()
    if name is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Teacher not found.")
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return Grid(
            kind="teacher",
            title=name,
            session_id=None,
            session_name=None,
            session_is_archived=False,
            periods=[],
            days=_days([]),
            cells=[],
        )
    cells = _cells(
        (
            await db.execute(
                text(_CELLS + "where e.teacher_id = :t and e.academic_session_id = :sid"),
                {"t": teacher_id, "sid": session.id},
            )
        ).all()
    )
    return Grid(
        kind="teacher",
        title=name,
        session_id=session.id,
        session_name=session.name,
        session_is_archived=session.archived_at is not None,
        periods=await _periods(db, session.id),
        days=_days(cells),
        cells=cells,
    )


async def grid_pdf(db: AsyncSession, ctx: SchoolContext, grid: Grid, filename: str) -> Response:
    school = (
        await db.execute(text("select name from public.schools where id = :s"), {"s": ctx.school_id})
    ).scalar_one()
    kind = "Class timetable" if grid.kind == "class" else "Teacher timetable"
    pdf = build_timetable_pdf(
        school,
        f"{grid.title} – timetable",
        f"{kind} · Session {grid.session_name or '—'}",
        [PdfPeriod(str(p.id), p.period_number, p.label, p.start_time, p.end_time, p.is_break) for p in grid.periods],
        grid.days,
        [
            PdfCell(
                c.day_of_week,
                str(c.period_id),
                c.subject_name,
                c.teacher_name if grid.kind == "class" else f"{c.class_name} – {c.section_name}",
                c.room,
            )
            for c in grid.cells
        ],
    )
    safe = re.sub(r"[^A-Za-z0-9]+", "-", filename).strip("-").lower() or "timetable"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="timetable-{safe}-{datetime.now(UTC):%Y%m%d}.pdf"',
            "Cache-Control": "private, no-store",
        },
    )


async def find_conflicts(db: AsyncSession, ctx: SchoolContext, c: CheckIn) -> list[str]:
    """Human-readable clashes for a slot (empty list = free). Runs with admin rights."""
    p = (
        await db.execute(
            text(
                "select period_number, label, is_break, academic_session_id from public.timetable_periods "
                "where id = :p and school_id = :s"
            ),
            {"p": c.period_id, "s": ctx.school_id},
        )
    ).first()
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Period not found.")
    when = f"{p[1] or f'Period {p[0]}'} on {DAY_NAMES[c.day_of_week]}"
    out: list[str] = []
    excl = c.entry_id or uuid.UUID(int=0)
    base = _CELLS + "where e.day_of_week = :d and e.period_id = :p and e.id <> :x "
    args = {"d": c.day_of_week, "p": c.period_id, "x": excl}
    for r in _cells((await db.execute(text(base + "and e.section_id = :sec"), {**args, "sec": c.section_id})).all()):
        out.append(f"{r.class_name} – {r.section_name} already has {r.subject_name} in {when}.")
    if c.teacher_id:
        for r in _cells((await db.execute(text(base + "and e.teacher_id = :t"), {**args, "t": c.teacher_id})).all()):
            out.append(f"{r.teacher_name} is already teaching {r.class_name} – {r.section_name} in {when}.")
    room = " ".join(c.room.split()).upper() if c.room else None
    if room:
        for r in _cells(
            (await db.execute(text(base + "and lower(e.room) = lower(:room)"), {**args, "room": room})).all()
        ):
            out.append(f"Room {room} is already used by {r.class_name} – {r.section_name} in {when}.")
    return out


# ------------------------------------------------------------------ setup: subjects & periods
@router.get("/setup")
async def setup(
    session_id: uuid.UUID | None = None, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> dict:
    session = await resolve_session(db, ctx, session_id)
    subjects = await list_subjects(ctx=ctx, db=db, include_inactive=True)
    return {
        "session": {"id": str(session.id), "name": session.name, "is_archived": session.archived_at is not None}
        if session
        else None,
        "periods": [p.model_dump(mode="json") for p in (await _periods(db, session.id) if session else [])],
        "subjects": [s.model_dump(mode="json") for s in subjects],
    }


@router.get("/subjects", response_model=list[SubjectOut])
async def list_subjects(
    ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db), include_inactive: bool = False
) -> list[SubjectOut]:
    rows = (
        await db.execute(
            text(
                "select s.id, s.name, s.code, s.is_active, "
                "(select count(*) from public.timetable_entries e join public.academic_sessions a "
                " on a.id = e.academic_session_id and a.is_current where e.subject_id = s.id) "
                "from public.subjects s where s.school_id = :s "
                + ("" if include_inactive else "and s.is_active ")
                + "order by s.is_active desc, lower(s.name)"
            ),
            {"s": ctx.school_id},
        )
    ).all()
    return [SubjectOut(id=r[0], name=r[1], code=r[2], is_active=r[3], periods_per_week=r[4]) for r in rows]


@router.post("/subjects", response_model=list[SubjectOut], status_code=status.HTTP_201_CREATED)
async def create_subject(
    payload: SubjectIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[SubjectOut]:
    try:
        await db.execute(
            text("insert into public.subjects (school_id, name, code) values (:s, :n, :c)"),
            {"s": ctx.school_id, "n": payload.name, "c": payload.code},
        )
        await write_audit(
            db,
            request,
            action="subject.created",
            entity_type="subject",
            school_id=ctx.school_id,
            metadata={"name": payload.name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await list_subjects(ctx=ctx, db=db, include_inactive=True)


@router.post("/subjects/common", response_model=list[SubjectOut], status_code=status.HTTP_201_CREATED)
async def add_common_subjects(
    request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[SubjectOut]:
    """Adds the usual school subjects; names that already exist are skipped."""
    res = await db.execute(
        text(
            "insert into public.subjects (school_id, name) select :s, n from unnest(cast(:names as text[])) n "
            "on conflict do nothing returning name"
        ),
        {"s": ctx.school_id, "names": COMMON_SUBJECTS},
    )
    added = [r[0] for r in res.all()]
    if added:
        await write_audit(
            db,
            request,
            action="subject.common_added",
            entity_type="subject",
            school_id=ctx.school_id,
            metadata={"names": added},
        )
    await db.commit()
    return await list_subjects(ctx=ctx, db=db, include_inactive=True)


@router.patch("/subjects/{subject_id}", response_model=list[SubjectOut])
async def update_subject(
    subject_id: uuid.UUID,
    payload: SubjectUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> list[SubjectOut]:
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and not data["name"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A subject needs a name.")
    if "is_active" in data and data["is_active"] is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose active or inactive.")
    if not data and not await db.scalar(
        text("select exists (select 1 from public.subjects where id = :id and school_id = :s)"),
        {"id": subject_id, "s": ctx.school_id},
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Subject not found.")
    if data:
        sets = ", ".join(f"{k} = :{k}" for k in data)
        try:
            res = await db.execute(
                text(f"update public.subjects set {sets} where id = :id and school_id = :s"),
                {"id": subject_id, "s": ctx.school_id, **data},
            )
            if res.rowcount != 1:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Subject not found.")
            await write_audit(
                db,
                request,
                action="subject.updated",
                entity_type="subject",
                entity_id=str(subject_id),
                school_id=ctx.school_id,
                metadata={k: str(v) for k, v in data.items()},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await list_subjects(ctx=ctx, db=db, include_inactive=True)


@router.post("/periods", response_model=list[PeriodOut], status_code=status.HTTP_201_CREATED)
async def create_period(
    payload: PeriodCreate, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[PeriodOut]:
    session = await resolve_session(db, ctx, payload.academic_session_id)
    try:
        await db.execute(
            text(
                "insert into public.timetable_periods (school_id, academic_session_id, period_number, label, "
                "start_time, "
                "end_time, is_break) values (:s, :sid, :n, :l, :st, :et, :b)"
            ),
            {
                "s": ctx.school_id,
                "sid": session.id,
                "n": payload.period_number,
                "l": payload.label,
                "st": payload.start_time,
                "et": payload.end_time,
                "b": payload.is_break,
            },
        )
        await write_audit(
            db,
            request,
            action="period.created",
            entity_type="timetable",
            school_id=ctx.school_id,
            metadata={
                "session": session.name,
                "period": payload.period_number,
                "time": f"{_hm(payload.start_time)}-{_hm(payload.end_time)}",
            },
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _periods(db, session.id)


@router.post("/periods/generate", response_model=list[PeriodOut], status_code=status.HTTP_201_CREATED)
async def generate_day(
    payload: GenerateDay, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[PeriodOut]:
    """Quick set-up of a standard school day for a session that has no periods yet."""
    session = await resolve_session(db, ctx, payload.academic_session_id)
    if await _periods(db, session.id):
        raise HTTPException(status.HTTP_409_CONFLICT, "This session already has periods. Edit them instead.")
    if payload.break_after is not None and payload.break_after >= payload.periods:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The break must come before the last period.")
    rows, minute, number = [], payload.first_start.hour * 60 + payload.first_start.minute, 1
    for i in range(1, payload.periods + 1):
        # teaching periods are named 1..N; a break takes a slot in the order but not a teaching number
        rows.append((number, f"Period {i}", minute, minute + payload.period_minutes, False))
        minute += payload.period_minutes
        number += 1
        if payload.break_after == i:
            rows.append((number, payload.break_label or "Break", minute, minute + payload.break_minutes, True))
            minute += payload.break_minutes
            number += 1
    if minute > 24 * 60:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "That day would run past midnight.")
    try:
        for n, label, a, b, is_break in rows:
            await db.execute(
                text(
                    "insert into public.timetable_periods (school_id, academic_session_id, period_number, label, "
                    "start_time, end_time, is_break) values (:s, :sid, :n, :l, :st, :et, :b)"
                ),
                {
                    "s": ctx.school_id,
                    "sid": session.id,
                    "n": n,
                    "l": label,
                    "st": time(a // 60, a % 60),
                    "et": time(b // 60 % 24, b % 60),
                    "b": is_break,
                },
            )
        await write_audit(
            db,
            request,
            action="period.day_generated",
            entity_type="timetable",
            school_id=ctx.school_id,
            metadata={"session": session.name, "periods": len(rows)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _periods(db, session.id)


@router.patch("/periods/{period_id}", response_model=list[PeriodOut])
async def update_period(
    period_id: uuid.UUID,
    payload: PeriodIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> list[PeriodOut]:
    sid = (
        await db.execute(
            text("select academic_session_id from public.timetable_periods where id = :p and school_id = :s"),
            {"p": period_id, "s": ctx.school_id},
        )
    ).scalar()
    if sid is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Period not found.")
    try:
        await db.execute(
            text(
                "update public.timetable_periods set period_number = :n, label = :l, start_time = :st, end_time = :et, "
                "is_break = :b where id = :p"
            ),
            {
                "p": period_id,
                "n": payload.period_number,
                "l": payload.label,
                "st": payload.start_time,
                "et": payload.end_time,
                "b": payload.is_break,
            },
        )
        await write_audit(
            db,
            request,
            action="period.updated",
            entity_type="timetable",
            school_id=ctx.school_id,
            metadata={"period": payload.period_number, "time": f"{_hm(payload.start_time)}-{_hm(payload.end_time)}"},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _periods(db, sid)


@router.delete("/periods/{period_id}", response_model=list[PeriodOut])
async def delete_period(
    period_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[PeriodOut]:
    try:
        sid = (
            await db.execute(
                text(
                    "delete from public.timetable_periods where id = :p and school_id = :s "
                    "returning academic_session_id"
                ),
                {"p": period_id, "s": ctx.school_id},
            )
        ).scalar()
        if sid is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Period not found.")
        await write_audit(
            db,
            request,
            action="period.deleted",
            entity_type="timetable",
            school_id=ctx.school_id,
            metadata={"period_id": str(period_id)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _periods(db, sid)


# ------------------------------------------------------------------ timetables
@router.get("/sections/{section_id}", response_model=Grid)
async def get_class_timetable(
    section_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> Grid:
    return await class_grid(db, ctx, section_id)


@router.get("/sections/{section_id}/pdf")
async def class_timetable_pdf(
    section_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> Response:
    g = await class_grid(db, ctx, section_id)
    return await grid_pdf(db, ctx, g, g.title)


@router.get("/teachers/{teacher_id}", response_model=Grid)
async def get_teacher_timetable(
    teacher_id: uuid.UUID,
    session_id: uuid.UUID | None = None,
    ctx: SchoolContext = Depends(require_permission(Permission.TEACHERS_VIEW)),
    db: AsyncSession = Depends(get_db),
) -> Grid:
    return await teacher_grid(db, ctx, teacher_id, session_id)


@router.get("/teachers/{teacher_id}/pdf")
async def teacher_timetable_pdf(
    teacher_id: uuid.UUID,
    session_id: uuid.UUID | None = None,
    ctx: SchoolContext = Depends(require_permission(Permission.TEACHERS_VIEW)),
    db: AsyncSession = Depends(get_db),
) -> Response:
    g = await teacher_grid(db, ctx, teacher_id, session_id)
    return await grid_pdf(db, ctx, g, g.title)


@router.post("/check")
async def check(payload: CheckIn, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    return {"conflicts": await find_conflicts(db, ctx, payload)}


@router.post("/entries", response_model=Grid, status_code=status.HTTP_201_CREATED)
async def create_entry(
    payload: EntryIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Grid:
    sec = (
        await db.execute(
            text(
                "select class_id, academic_session_id from public.sections "
                "where id = :id and school_id = :s and deleted_at is null"
            ),
            {"id": payload.section_id, "s": ctx.school_id},
        )
    ).first()
    if sec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Class not found.")
    clashes = await find_conflicts(
        db,
        ctx,
        CheckIn(
            section_id=payload.section_id,
            day_of_week=payload.day_of_week,
            period_id=payload.period_id,
            teacher_id=payload.teacher_id,
            room=payload.room,
        ),
    )
    if clashes:
        raise HTTPException(status.HTTP_409_CONFLICT, " ".join(clashes))
    try:
        await db.execute(
            text(
                "insert into public.timetable_entries (school_id, academic_session_id, class_id, section_id, "
                "day_of_week, "
                "period_id, subject_id, teacher_id, room, created_by) values (:s, :sid, :cid, :sec, :d, :p, :sub, "
                ":t, :r, :by)"
            ),
            {
                "s": ctx.school_id,
                "sid": sec[1],
                "cid": sec[0],
                "sec": payload.section_id,
                "d": payload.day_of_week,
                "p": payload.period_id,
                "sub": payload.subject_id,
                "t": payload.teacher_id,
                "r": payload.room,
                "by": user.id,
            },
        )
        await write_audit(
            db,
            request,
            action="timetable.slot_set",
            entity_type="timetable",
            entity_id=str(payload.section_id),
            school_id=ctx.school_id,
            metadata=payload.model_dump(mode="json"),
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await class_grid(db, ctx, payload.section_id)


@router.patch("/entries/{entry_id}", response_model=Grid)
async def update_entry(
    entry_id: uuid.UUID,
    payload: EntryUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> Grid:
    e = (
        (
            await db.execute(
                text(
                    "select section_id, day_of_week, period_id, subject_id, teacher_id, room "
                    "from public.timetable_entries where id = :id and school_id = :s"
                ),
                {"id": entry_id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if e is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Timetable slot not found.")
    data = payload.model_dump(exclude_unset=True)
    after = {**dict(e), **data}
    clashes = await find_conflicts(
        db,
        ctx,
        CheckIn(
            section_id=e["section_id"],
            day_of_week=e["day_of_week"],
            period_id=e["period_id"],
            teacher_id=after["teacher_id"],
            room=after["room"],
            entry_id=entry_id,
        ),
    )
    if clashes:
        raise HTTPException(status.HTTP_409_CONFLICT, " ".join(clashes))
    if data:
        sets = ", ".join(f"{k} = :{k}" for k in data)
        try:
            await db.execute(
                text(f"update public.timetable_entries set {sets} where id = :id"), {"id": entry_id, **data}
            )
            await write_audit(
                db,
                request,
                action="timetable.slot_changed",
                entity_type="timetable",
                entity_id=str(e["section_id"]),
                school_id=ctx.school_id,
                metadata={"before": {k: str(e[k]) for k in data}, "after": {k: str(v) for k, v in data.items()}},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await class_grid(db, ctx, e["section_id"])


@router.delete("/entries/{entry_id}", response_model=Grid)
async def delete_entry(
    entry_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> Grid:
    try:
        sec = (
            await db.execute(
                text("delete from public.timetable_entries where id = :id and school_id = :s returning section_id"),
                {"id": entry_id, "s": ctx.school_id},
            )
        ).scalar()
        if sec is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Timetable slot not found.")
        await write_audit(
            db,
            request,
            action="timetable.slot_cleared",
            entity_type="timetable",
            entity_id=str(sec),
            school_id=ctx.school_id,
            metadata={"entry_id": str(entry_id)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await class_grid(db, ctx, sec)


@router.get("/sections/{section_id}/teachers")
async def section_teachers(
    section_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    """Active teachers assigned to this class: the only ones who can be timetabled in it."""
    await _section(db, ctx, section_id)
    rows = (
        await db.execute(
            text(
                "select t.id, t.full_name, t.employee_id, "
                "coalesce(array_agg(a.subject order by lower(a.subject)) filter (where a.subject is not null), '{}') "
                "from public.teacher_assignments a "
                "join public.teachers t on t.id = a.teacher_id and t.status = 'active' "
                "where a.section_id = :sec group by t.id, t.full_name, t.employee_id order by lower(t.full_name)"
            ),
            {"sec": section_id},
        )
    ).all()
    return [{"id": str(r[0]), "full_name": r[1], "employee_id": r[2], "subjects": list(r[3])} for r in rows]
