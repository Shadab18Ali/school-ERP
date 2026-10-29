"""Exams: types, grading scale, exams, date sheets, marks entry and results.

Results are calculated by SQL (private.exam_results / private.exam_result_marks),
which also decide who may see which rows: admins and the section's teachers see
the whole section; parents and students only their own row, once published.
Every rule about valid marks is enforced by the database (migration 0015); the
checks here only give friendlier messages first.
"""

import uuid
from datetime import date, time
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services.academics import resolve_session
from app.services.audit import write_audit
from app.services.exam_pdf import StudentResult, SubjectLine, build_result_sheet, num

router = APIRouter(prefix="/exams", tags=["exams"])
VIEW = Depends(require_permission(Permission.EXAMS_VIEW))
MANAGE = Depends(require_permission(Permission.EXAMS_MANAGE))
ENTER = Depends(require_permission(Permission.MARKS_ENTER))
NOT_FOUND = HTTPException(status.HTTP_404_NOT_FOUND, "Exam not found.")

STANDARD_TYPES = ["Unit Test", "Half Yearly", "Annual"]
# A common Indian (CBSE-style) 8-point scale; schools can change it.
STANDARD_GRADES = [
    ("A1", 91, "Outstanding"),
    ("A2", 81, "Excellent"),
    ("B1", 71, "Very good"),
    ("B2", 61, "Good"),
    ("C1", 51, "Above average"),
    ("C2", 41, "Average"),
    ("D", 33, "Pass"),
    ("E", 0, "Needs improvement"),
]
UNIQUE = {
    "exam_types_school_name_key": "An exam type with this name already exists.",
    "exams_session_name_key": "An exam with this name already exists in this session.",
    "exam_papers_one_per_subject": "This class already has a paper for that subject in this exam.",
    "grade_bands_school_grade_key": "Each grade can appear only once.",
    "grade_bands_school_min_key": "Two grades can't start at the same percentage.",
}
Marks = Decimal


# ------------------------------------------------------------------ schemas
class _Strict(BaseModel):
    model_config = {"extra": "forbid"}


def _strip(v: object) -> object:
    return " ".join(v.split()) if isinstance(v, str) else v


class TypeIn(_Strict):
    name: str = Field(min_length=2, max_length=60)
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _strip(v)))


class TypeUpdate(_Strict):
    name: str | None = Field(default=None, min_length=2, max_length=60)
    is_active: bool | None = None
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _strip(v)))


class Band(_Strict):
    grade: str = Field(pattern=r"^[A-Za-z0-9+\-]{1,4}$")
    min_percentage: Decimal = Field(ge=0, le=100, decimal_places=2)
    remark: str | None = Field(default=None, max_length=60)
    _c = field_validator("grade", "remark", mode="before")(classmethod(lambda cls, v: _strip(v) or None))


class Scale(_Strict):
    bands: list[Band] = Field(min_length=2, max_length=15)

    @model_validator(mode="after")
    def _check(self) -> "Scale":
        if not any(b.min_percentage == 0 for b in self.bands):
            raise ValueError("One grade must start at 0% so that every result gets a grade.")
        if len({b.grade.upper() for b in self.bands}) != len(self.bands):
            raise ValueError("Each grade can appear only once.")
        if len({b.min_percentage for b in self.bands}) != len(self.bands):
            raise ValueError("Two grades can't start at the same percentage.")
        return self


class ExamIn(_Strict):
    academic_session_id: uuid.UUID | None = None
    exam_type_id: uuid.UUID
    name: str = Field(min_length=2, max_length=100)
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _strip(v)))


class ExamUpdate(_Strict):
    exam_type_id: uuid.UUID | None = None
    report_card_template_id: uuid.UUID | None = None  # null = the school's default template
    name: str | None = Field(default=None, min_length=2, max_length=100)
    _c = field_validator("name", mode="before")(classmethod(lambda cls, v: _strip(v)))


class StatusIn(_Strict):
    status: Literal["draft", "scheduled", "published"]


class PaperBase(_Strict):
    subject_id: uuid.UUID
    exam_date: date
    start_time: time
    end_time: time
    max_marks: Decimal = Field(gt=0, le=1000, decimal_places=2)
    pass_marks: Decimal = Field(ge=0, le=1000, decimal_places=2)

    @model_validator(mode="after")
    def _check(self) -> "PaperBase":
        if self.end_time <= self.start_time:
            raise ValueError("The paper must end after it starts.")
        if self.pass_marks > self.max_marks:
            raise ValueError("Passing marks can't be more than maximum marks.")
        return self


class PaperIn(PaperBase):
    class_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)


class PaperUpdate(PaperBase):
    pass


class MarkEntry(_Strict):
    enrollment_id: uuid.UUID
    marks: Decimal | None = Field(default=None, ge=0, le=1000, decimal_places=2)
    absent: bool = False

    @model_validator(mode="after")
    def _check(self) -> "MarkEntry":
        if self.absent and self.marks is not None:
            raise ValueError("A student marked absent can't have marks.")
        return self


class MarksIn(_Strict):
    section_id: uuid.UUID
    entries: list[MarkEntry] = Field(max_length=200)


# ------------------------------------------------------------------ helpers
async def _exam(db: AsyncSession, ctx: SchoolContext, exam_id: uuid.UUID):
    r = (
        await db.execute(
            text(
                "select x.id, x.name, x.status::text as status, x.results_published_at, "
                "x.exam_type_id, t.name as type_name, "
                "x.academic_session_id, a.name as session_name, a.archived_at is not null as archived, "
                "a.start_date, a.end_date, x.report_card_template_id "
                "from public.exams x join public.exam_types t on t.id = x.exam_type_id "
                "join public.academic_sessions a on a.id = x.academic_session_id "
                "where x.id = :id and x.school_id = :s"
            ),
            {"id": exam_id, "s": ctx.school_id},
        )
    ).first()
    if r is None:
        raise NOT_FOUND
    return r


def _exam_out(r) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "status": r.status,
        "results_published_at": r.results_published_at.isoformat() if r.results_published_at else None,
        "exam_type_id": str(r.exam_type_id),
        "type_name": r.type_name,
        "academic_session_id": str(r.academic_session_id),
        "session_name": r.session_name,
        "session_is_archived": r.archived,
        "session_start": r.start_date.isoformat(),
        "session_end": r.end_date.isoformat(),
        "report_card_template_id": str(r.report_card_template_id) if r.report_card_template_id else None,
    }


async def _papers(db: AsyncSession, exam_id: uuid.UUID, class_id: uuid.UUID | None = None) -> list[dict]:
    rows = (
        await db.execute(
            text(
                "select p.id, p.class_id, c.name as class_name, c.display_order, p.subject_id, "
                "sub.name as subject_name, "
                "p.exam_date, p.start_time, p.end_time, p.max_marks, p.pass_marks, "
                "(select count(*) from public.exam_marks m where m.paper_id = p.id) as entered, "
                "(select count(*) from public.student_enrollments e join public.students st on st.id = e.student_id "
                " and st.status = 'active' where e.class_id = p.class_id and e.academic_session_id = "
                "p.academic_session_id) "
                " as students "
                "from public.exam_papers p join public.classes c on c.id = p.class_id "
                "join public.subjects sub on sub.id = p.subject_id "
                "where p.exam_id = :x "
                + ("and p.class_id = :c " if class_id else "")
                + "order by c.display_order, lower(c.name), p.exam_date, p.start_time"
            ),
            {"x": exam_id, "c": class_id},
        )
    ).all()
    return [
        {
            "id": str(r.id),
            "class_id": str(r.class_id),
            "class_name": r.class_name,
            "subject_id": str(r.subject_id),
            "subject_name": r.subject_name,
            "exam_date": r.exam_date.isoformat(),
            "start_time": r.start_time.strftime("%H:%M"),
            "end_time": r.end_time.strftime("%H:%M"),
            "max_marks": num(r.max_marks),
            "pass_marks": num(r.pass_marks),
            "entered": r.entered,
            "students": r.students,
        }
        for r in rows
    ]


def _is_admin(ctx: SchoolContext) -> bool:
    return ctx.is_super_admin or "school_admin" in ctx.roles


async def _section(db: AsyncSession, ctx: SchoolContext, exam, section_id: uuid.UUID):
    """A section of the exam's session that the caller may work with (teachers: assigned only)."""
    r = (
        await db.execute(
            text(
                "select sec.id, sec.class_id, c.name || ' – ' || sec.name as label, "
                "private.teacher_assigned_section(sec.id) "
                "from public.sections sec join public.classes c on c.id = sec.class_id "
                "where sec.id = :id and sec.school_id = :s and sec.academic_session_id = :sess"
            ),
            {"id": section_id, "s": ctx.school_id, "sess": exam.academic_session_id},
        )
    ).first()
    if r is None or not (_is_admin(ctx) or r[3]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Class not found.")
    return r


async def _commit(db: AsyncSession, request: Request, ctx: SchoolContext, action: str, entity_id: str, meta: dict):
    await write_audit(
        db, request, action=action, entity_type="exam", entity_id=entity_id, school_id=ctx.school_id, metadata=meta
    )
    await db.commit()


# ------------------------------------------------------------------ setup
@router.get("/setup")
async def setup(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    types = (
        await db.execute(
            text(
                "select t.id, t.name, t.is_active, (select count(*) from public.exams x where x.exam_type_id = t.id) "
                "from public.exam_types t where t.school_id = :s order by t.display_order, lower(t.name)"
            ),
            {"s": ctx.school_id},
        )
    ).all()
    bands = (
        await db.execute(
            text(
                "select grade, min_percentage, remark from public.grade_bands where school_id = :s "
                "order by min_percentage desc"
            ),
            {"s": ctx.school_id},
        )
    ).all()
    return {
        "types": [{"id": str(t[0]), "name": t[1], "is_active": t[2], "exams": t[3]} for t in types],
        "grades": [{"grade": b[0], "min_percentage": num(b[1]), "remark": b[2]} for b in bands],
    }


@router.post("/types", status_code=status.HTTP_201_CREATED)
async def add_type(
    payload: TypeIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    try:
        await db.execute(
            text(
                "insert into public.exam_types (school_id, name, display_order) values (:s, :n, "
                "(select coalesce(max(display_order), 0) + 1 from public.exam_types where school_id = :s))"
            ),
            {"s": ctx.school_id, "n": payload.name},
        )
        await _commit(db, request, ctx, "exam_type.created", "", {"name": payload.name})
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await setup(ctx=ctx, db=db)


@router.post("/types/standard", status_code=status.HTTP_201_CREATED)
async def add_standard_types(request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    """Unit Test, Half Yearly and Annual; names that already exist are skipped."""
    for i, name in enumerate(STANDARD_TYPES, start=1):
        await db.execute(
            text(
                "insert into public.exam_types (school_id, name, display_order) values (:s, :n, :o) "
                "on conflict do nothing"
            ),
            {"s": ctx.school_id, "n": name, "o": i},
        )
    await _commit(db, request, ctx, "exam_type.standard_added", "", {"names": STANDARD_TYPES})
    return await setup(ctx=ctx, db=db)


@router.patch("/types/{type_id}")
async def update_type(
    type_id: uuid.UUID,
    payload: TypeUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    fields = payload.model_dump(exclude_unset=True, exclude_none=True)
    if not fields and not await db.scalar(
        text("select exists (select 1 from public.exam_types where id = :id and school_id = :s)"),
        {"id": type_id, "s": ctx.school_id},
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Exam type not found.")
    if fields:
        try:
            res = await db.execute(
                text(
                    f"update public.exam_types set {', '.join(f'{k} = :{k}' for k in fields)} where "
                    f"id = :id and school_id = :s"
                ),
                {**fields, "id": type_id, "s": ctx.school_id},
            )
            if res.rowcount == 0:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Exam type not found.")
            await _commit(db, request, ctx, "exam_type.updated", str(type_id), {"fields": sorted(fields)})
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await setup(ctx=ctx, db=db)


@router.put("/grades")
async def save_grades(
    payload: Scale, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    """Replaces the whole grading scale at once (results always use the current scale)."""
    try:
        await db.execute(text("delete from public.grade_bands where school_id = :s"), {"s": ctx.school_id})
        for b in payload.bands:
            await db.execute(
                text(
                    "insert into public.grade_bands (school_id, grade, min_percentage, remark) values (:s, :g, :m, :r)"
                ),
                {"s": ctx.school_id, "g": b.grade.upper(), "m": b.min_percentage, "r": b.remark},
            )
        await _commit(
            db, request, ctx, "grades.saved", "", {"bands": [f"{b.grade}>={b.min_percentage}" for b in payload.bands]}
        )
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await setup(ctx=ctx, db=db)


@router.post("/grades/standard")
async def standard_grades(request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> dict:
    scale = Scale(bands=[Band(grade=g, min_percentage=Decimal(m), remark=r) for g, m, r in STANDARD_GRADES])
    return await save_grades(scale, request, ctx=ctx, db=db)


# ------------------------------------------------------------------ exams
@router.get("")
async def list_exams(
    session_id: uuid.UUID | None = None, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> dict:
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return {"session": None, "items": []}
    rows = (
        await db.execute(
            text(
                "select x.id, x.name, x.status::text, t.name, x.results_published_at, "
                "(select count(*) from public.exam_papers p where p.exam_id = x.id), "
                "(select count(distinct p.class_id) from public.exam_papers p where p.exam_id = x.id), "
                "(select min(p.exam_date) from public.exam_papers p where p.exam_id = x.id), "
                "(select max(p.exam_date) from public.exam_papers p where p.exam_id = x.id), "
                "(select count(*) from public.exam_marks m join public.exam_papers p on p.id = "
                "m.paper_id where p.exam_id = x.id), "
                "(select count(*) from public.exam_papers p join public.student_enrollments e on "
                "e.class_id = p.class_id "
                " and e.academic_session_id = p.academic_session_id join public.students st on st.id = e.student_id "
                " and st.status = 'active' where p.exam_id = x.id) "
                "from public.exams x join public.exam_types t on t.id = x.exam_type_id "
                "where x.school_id = :s and x.academic_session_id = :sess "
                "order by coalesce((select min(p.exam_date) from public.exam_papers p where "
                "p.exam_id = x.id), '9999-12-31'), "
                "t.display_order, lower(x.name)"
            ),
            {"s": ctx.school_id, "sess": session.id},
        )
    ).all()
    return {
        "session": {"id": str(session.id), "name": session.name, "is_archived": session.archived_at is not None},
        "items": [
            {
                "id": str(r[0]),
                "name": r[1],
                "status": r[2],
                "type_name": r[3],
                "results_published_at": r[4].isoformat() if r[4] else None,
                "papers": r[5],
                "classes": r[6],
                "first_date": r[7].isoformat() if r[7] else None,
                "last_date": r[8].isoformat() if r[8] else None,
                "marks_entered": r[9],  # what the caller can see (teachers: their sections)
                "marks_expected": r[10],
            }
            for r in rows
        ],
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_exam(
    payload: ExamIn, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> dict:
    session = await resolve_session(db, ctx, payload.academic_session_id)
    if session is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Create an academic session first.")
    try:
        eid = (
            await db.execute(
                text(
                    "insert into public.exams (school_id, academic_session_id, exam_type_id, name) "
                    "values (:s, :sess, :t, :n) returning id"
                ),
                {"s": ctx.school_id, "sess": session.id, "t": payload.exam_type_id, "n": payload.name},
            )
        ).scalar_one()
        await _commit(db, request, ctx, "exam.created", str(eid), {"name": payload.name})
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await get_exam(eid, ctx=ctx, db=db)


@router.get("/{exam_id}")
async def get_exam(exam_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> dict:
    x = await _exam(db, ctx, exam_id)
    return {**_exam_out(x), "papers": await _papers(db, exam_id)}


@router.patch("/{exam_id}")
async def update_exam(
    exam_id: uuid.UUID,
    payload: ExamUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _exam(db, ctx, exam_id)
    fields = {
        k: v
        for k, v in payload.model_dump(exclude_unset=True).items()
        if v is not None or k == "report_card_template_id"
    }
    if fields:
        try:
            await db.execute(
                text(
                    f"update public.exams set {', '.join(f'{k} = :{k}' for k in fields)} where id = "
                    f":id and school_id = :s"
                ),
                {**fields, "id": exam_id, "s": ctx.school_id},
            )
            await _commit(db, request, ctx, "exam.updated", str(exam_id), {"fields": sorted(fields)})
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await get_exam(exam_id, ctx=ctx, db=db)


@router.delete("/{exam_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_exam(
    exam_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> None:
    x = await _exam(db, ctx, exam_id)
    try:
        await db.execute(
            text("delete from public.exams where id = :id and school_id = :s"), {"id": exam_id, "s": ctx.school_id}
        )
        await _commit(db, request, ctx, "exam.deleted", str(exam_id), {"name": x.name})
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None


@router.post("/{exam_id}/status")
async def set_status(
    exam_id: uuid.UUID,
    payload: StatusIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """draft -> scheduled (date sheet visible to families) -> published (results visible, marks locked)."""
    x = await _exam(db, ctx, exam_id)
    if x.status != payload.status:
        try:
            await db.execute(
                text(
                    "update public.exams set status = cast(:st as public.exam_status) where id = :id and school_id = :s"
                ),
                {"st": payload.status, "id": exam_id, "s": ctx.school_id},
            )
            action = {"published": "exam.results_published", "scheduled": "exam.scheduled", "draft": "exam.unscheduled"}
            if x.status == "published":
                action["scheduled"] = "exam.results_unpublished"
            await _commit(
                db, request, ctx, action[payload.status], str(exam_id), {"from": x.status, "to": payload.status}
            )
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await get_exam(exam_id, ctx=ctx, db=db)


# ------------------------------------------------------------------ date sheet
@router.post("/{exam_id}/papers", status_code=status.HTTP_201_CREATED)
async def add_papers(
    exam_id: uuid.UUID,
    payload: PaperIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The same paper (subject, date, time, marks) for one or more classes."""
    x = await _exam(db, ctx, exam_id)
    try:
        for cid in dict.fromkeys(payload.class_ids):
            await db.execute(
                text(
                    "insert into public.exam_papers (school_id, exam_id, academic_session_id, "
                    "class_id, subject_id, exam_date, "
                    "start_time, end_time, max_marks, pass_marks) values (:s, :x, :sess, :c, :sub, "
                    ":d, :st, :et, :mx, :ps)"
                ),
                {
                    "s": ctx.school_id,
                    "x": exam_id,
                    "sess": x.academic_session_id,
                    "c": cid,
                    "sub": payload.subject_id,
                    "d": payload.exam_date,
                    "st": payload.start_time,
                    "et": payload.end_time,
                    "mx": payload.max_marks,
                    "ps": payload.pass_marks,
                },
            )
        await _commit(db, request, ctx, "exam.papers_added", str(exam_id), {"classes": len(payload.class_ids)})
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await get_exam(exam_id, ctx=ctx, db=db)


@router.patch("/{exam_id}/papers/{paper_id}")
async def update_paper(
    exam_id: uuid.UUID,
    paper_id: uuid.UUID,
    payload: PaperUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _exam(db, ctx, exam_id)
    try:
        res = await db.execute(
            text(
                "update public.exam_papers set subject_id = :sub, exam_date = :d, start_time = :st, end_time = :et, "
                "max_marks = :mx, pass_marks = :ps where id = :p and exam_id = :x"
            ),
            {
                "sub": payload.subject_id,
                "d": payload.exam_date,
                "st": payload.start_time,
                "et": payload.end_time,
                "mx": payload.max_marks,
                "ps": payload.pass_marks,
                "p": paper_id,
                "x": exam_id,
            },
        )
        if res.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Paper not found.")
        await _commit(db, request, ctx, "exam.paper_updated", str(exam_id), {"paper_id": str(paper_id)})
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await get_exam(exam_id, ctx=ctx, db=db)


@router.delete("/{exam_id}/papers/{paper_id}")
async def delete_paper(
    exam_id: uuid.UUID,
    paper_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> dict:
    await _exam(db, ctx, exam_id)
    try:
        res = await db.execute(
            text("delete from public.exam_papers where id = :p and exam_id = :x"), {"p": paper_id, "x": exam_id}
        )
        if res.rowcount == 0:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Paper not found.")
        await _commit(db, request, ctx, "exam.paper_removed", str(exam_id), {"paper_id": str(paper_id)})
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await get_exam(exam_id, ctx=ctx, db=db)


# ------------------------------------------------------------------ sections the caller works with
@router.get("/{exam_id}/sections")
async def exam_sections(
    exam_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    """Sections of classes in this exam, with marks progress (teachers: assigned sections only)."""
    x = await _exam(db, ctx, exam_id)
    rows = (
        await db.execute(
            text(
                "select sec.id, c.id, c.name, sec.name, "
                "(select count(*) from public.exam_papers p where p.exam_id = :x and p.class_id = c.id) as papers, "
                "(select count(*) from public.student_enrollments e join public.students st on st.id = e.student_id "
                " and st.status = 'active' where e.section_id = sec.id) as students, "
                "(select count(*) from public.exam_marks m join public.exam_papers p on p.id = m.paper_id "
                " where p.exam_id = :x and m.section_id = sec.id) as entered "
                "from public.sections sec join public.classes c on c.id = sec.class_id "
                "where sec.school_id = :s and sec.academic_session_id = :sess and sec.deleted_at is null "
                "and exists (select 1 from public.exam_papers p where p.exam_id = :x and p.class_id = c.id) "
                + ("" if _is_admin(ctx) else "and private.teacher_assigned_section(sec.id) ")
                + "order by c.display_order, lower(c.name), lower(sec.name)"
            ),
            {"x": exam_id, "s": ctx.school_id, "sess": x.academic_session_id},
        )
    ).all()
    return [
        {
            "section_id": str(r[0]),
            "class_id": str(r[1]),
            "class_name": r[2],
            "section_name": r[3],
            "papers": r[4],
            "students": r[5],
            "entered": r[6],
            "expected": r[4] * r[5],
        }
        for r in rows
    ]


# ------------------------------------------------------------------ marks entry
@router.get("/{exam_id}/papers/{paper_id}/marks")
async def get_marks(
    exam_id: uuid.UUID,
    paper_id: uuid.UUID,
    section_id: uuid.UUID,
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
) -> dict:
    x = await _exam(db, ctx, exam_id)
    sec = await _section(db, ctx, x, section_id)
    paper = next((p for p in await _papers(db, exam_id) if p["id"] == str(paper_id)), None)
    if paper is None or paper["class_id"] != str(sec[1]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Paper not found for this class.")
    rows = (
        await db.execute(
            text(
                "select e.id, st.id, st.full_name, e.admission_number, m.marks, "
                "coalesce(m.is_absent, false), m.id is not null "
                "from public.student_enrollments e join public.students st on st.id = e.student_id "
                "and st.status = 'active' "
                "left join public.exam_marks m on m.paper_id = :p and m.student_id = st.id "
                "where e.section_id = :sec order by lower(st.full_name), e.admission_number"
            ),
            {"p": paper_id, "sec": section_id},
        )
    ).all()
    can_enter = (
        ctx.can(Permission.MARKS_ENTER)
        and x.status != "published"
        and not x.archived
        and (_is_admin(ctx) or bool(sec[3]))
    )
    return {
        "exam": _exam_out(x),
        "paper": paper,
        "section": {"id": str(sec[0]), "label": sec[2]},
        "can_enter": can_enter,
        "students": [
            {
                "enrollment_id": str(r[0]),
                "student_id": str(r[1]),
                "full_name": r[2],
                "admission_number": r[3],
                "marks": num(r[4]) if r[4] is not None else None,
                "absent": r[5],
                "entered": r[6],
            }
            for r in rows
        ],
    }


@router.put("/{exam_id}/papers/{paper_id}/marks")
async def save_marks(
    exam_id: uuid.UUID,
    paper_id: uuid.UUID,
    payload: MarksIn,
    request: Request,
    ctx: SchoolContext = ENTER,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Saves a whole section's marks for one paper in one transaction. A row with neither
    marks nor "absent" clears that student's entry."""
    x = await _exam(db, ctx, exam_id)
    if x.status == "published":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Results of this exam are published. Unpublish them to change marks."
        )
    sec = await _section(db, ctx, x, payload.section_id)
    data = await get_marks(exam_id, paper_id, payload.section_id, ctx=ctx, db=db)
    roster = {s["enrollment_id"]: s for s in data["students"]}
    max_marks = Decimal(data["paper"]["max_marks"])
    subject = data["paper"]["subject_name"]
    for e in payload.entries:
        s = roster.get(str(e.enrollment_id))
        if s is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A student in the list isn't in this class.")
        if e.marks is not None and e.marks > max_marks:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{s['full_name']}: marks for {subject} can't be more than {num(max_marks)}.",
            )
    added = changed = cleared = 0
    try:
        for e in payload.entries:
            s = roster[str(e.enrollment_id)]
            if e.marks is None and not e.absent:
                if s["entered"]:
                    await db.execute(
                        text("delete from public.exam_marks where paper_id = :p and student_id = :st"),
                        {"p": paper_id, "st": s["student_id"]},
                    )
                    cleared += 1
                continue
            same = (
                s["entered"]
                and s["absent"] == e.absent
                and (
                    (s["marks"] is None and e.marks is None)
                    or (s["marks"] is not None and e.marks is not None and Decimal(s["marks"]) == e.marks)
                )
            )
            if same:
                continue
            await db.execute(
                text(
                    "insert into public.exam_marks (school_id, paper_id, student_id, enrollment_id, "
                    "section_id, marks, is_absent) "
                    "values (:sch, :p, :st, :en, :sec, :m, :ab) on conflict (paper_id, student_id) "
                    "do update set marks = excluded.marks, is_absent = excluded.is_absent"
                ),
                {
                    "sch": ctx.school_id,
                    "p": paper_id,
                    "st": s["student_id"],
                    "en": e.enrollment_id,
                    "sec": sec[0],
                    "m": e.marks,
                    "ab": e.absent,
                },
            )
            if s["entered"]:
                changed += 1
            else:
                added += 1
        await _commit(
            db,
            request,
            ctx,
            "exam.marks_saved",
            str(exam_id),
            {
                "paper_id": str(paper_id),
                "section_id": str(sec[0]),
                "added": added,
                "changed": changed,
                "cleared": cleared,
            },
        )
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    out = await get_marks(exam_id, paper_id, payload.section_id, ctx=ctx, db=db)
    return {**out, "saved": {"added": added, "changed": changed, "cleared": cleared}}


# ------------------------------------------------------------------ results
async def section_results(
    db: AsyncSession, exam_id: uuid.UUID, section_id: uuid.UUID
) -> tuple[list[StudentResult], list[dict], int]:
    """Results from SQL; what each caller gets back is decided there (see migration 0015)."""
    rows = (
        (await db.execute(text("select * from private.exam_results(:x, :s)"), {"x": exam_id, "s": section_id}))
        .mappings()
        .all()
    )
    marks = (
        (await db.execute(text("select * from private.exam_result_marks(:x, :s)"), {"x": exam_id, "s": section_id}))
        .mappings()
        .all()
    )
    by_student: dict[uuid.UUID, list[SubjectLine]] = {}
    subjects: dict[str, Decimal] = {}
    for m in marks:
        subjects.setdefault(m["subject_name"], m["max_marks"])
        by_student.setdefault(m["student_id"], []).append(
            SubjectLine(
                subject=m["subject_name"],
                exam_date=m["exam_date"],
                max_marks=m["max_marks"],
                pass_marks=m["pass_marks"],
                marks=m["marks"],
                is_absent=m["is_absent"],
                entered=m["entered"],
                grade=m["grade"],
                passed=m["passed"],
            )
        )
    results = [
        StudentResult(
            full_name=r["full_name"],
            admission_number=r["admission_number"],
            total=r["total"],
            max_total=r["max_total"],
            percentage=r["percentage"],
            grade=r["grade"],
            result=r["result"],
            rank=r["rank"],
            subjects=by_student.get(r["student_id"], []),
        )
        for r in rows
    ]
    ids = [r["student_id"] for r in rows]
    size = rows[0]["section_size"] if rows else 0  # the whole section, even when the caller sees one row
    return results, [{"student_id": str(i)} for i in ids], size


def _result_json(r: StudentResult, student_id: str) -> dict:
    return {
        "student_id": student_id,
        "full_name": r.full_name,
        "admission_number": r.admission_number,
        "total": num(r.total) if r.result != "incomplete" else None,
        "max_total": num(r.max_total),
        "percentage": num(r.percentage) if r.percentage is not None else None,
        "grade": r.grade,
        "result": r.result,
        "rank": r.rank,
        "subjects": [
            {
                "subject": s.subject,
                "exam_date": s.exam_date.isoformat(),
                "max_marks": num(s.max_marks),
                "pass_marks": num(s.pass_marks),
                "marks": num(s.marks) if s.marks is not None else None,
                "absent": s.is_absent,
                "entered": s.entered,
                "grade": s.grade,
                "passed": s.passed,
            }
            for s in r.subjects
        ],
    }


@router.get("/{exam_id}/results")
async def results(
    exam_id: uuid.UUID, section_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> dict:
    x = await _exam(db, ctx, exam_id)
    sec = await _section(db, ctx, x, section_id)
    res, ids, size = await section_results(db, exam_id, section_id)
    papers = await _papers(db, exam_id, sec[1])
    summary = {k: sum(1 for r in res if r.result == k) for k in ("pass", "fail", "incomplete")}
    pcts = [r.percentage for r in res if r.percentage is not None]
    return {
        "exam": _exam_out(x),
        "section": {"id": str(sec[0]), "label": sec[2]},
        "papers": papers,
        "summary": {
            **summary,
            "students": len(res),
            "average": num(sum(pcts) / len(pcts)) if pcts else None,
            "highest": num(max(pcts)) if pcts else None,
        },
        "rows": [_result_json(r, i["student_id"]) for r, i in zip(res, ids, strict=True)],
    }


def _pdf(data: bytes, name: str) -> Response:
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in name).strip("-").lower() or "result"
    return Response(
        content=data,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe}.pdf"', "Cache-Control": "private, no-store"},
    )


async def _school_name(db: AsyncSession, ctx: SchoolContext) -> str:
    return (await db.execute(text("select name from public.schools where id = :s"), {"s": ctx.school_id})).scalar_one()


@router.get("/{exam_id}/results/pdf")
async def result_sheet(
    exam_id: uuid.UUID, section_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
):
    x = await _exam(db, ctx, exam_id)
    sec = await _section(db, ctx, x, section_id)
    res, _, _size = await section_results(db, exam_id, section_id)
    papers = await _papers(db, exam_id, sec[1])
    subjects = [(p["subject_name"], Decimal(p["max_marks"])) for p in papers]
    data = build_result_sheet(await _school_name(db, ctx), x.name, x.session_name, sec[2], subjects, res)
    return _pdf(data, f"result-sheet-{x.name}-{sec[2]}")


@router.get("/{exam_id}/results/report-cards.pdf")
async def report_cards(
    exam_id: uuid.UUID,
    section_id: uuid.UUID,
    student_id: uuid.UUID | None = Query(default=None, description="One student; all of the section when omitted"),
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes.report_cards import build_cards

    x = await _exam(db, ctx, exam_id)
    sec = await _section(db, ctx, x, section_id)
    pdf = await build_cards(db, ctx, x, section_id, {str(student_id)} if student_id else None)
    if pdf is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Student not found in this class." if student_id else "No students in this class.",
        )
    name = sec[2]
    if student_id:
        name = (
            await db.execute(text("select full_name from public.students where id = :i"), {"i": student_id})
        ).scalar() or name
    return _pdf(pdf, f"report-card-{x.name}-{name}")


# ------------------------------------------------------------------ class schedule (teacher class page)
@router.get("/class-schedule/{section_id}")
async def class_schedule(
    section_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> list[dict]:
    """Exams with papers for this section's class, current session (teachers: assigned sections only)."""
    sec = (
        await db.execute(
            text(
                "select sec.class_id, sec.academic_session_id, "
                "private.teacher_assigned_section(sec.id) from public.sections sec "
                "where sec.id = :id and sec.school_id = :s"
            ),
            {"id": section_id, "s": ctx.school_id},
        )
    ).first()
    if sec is None or not (_is_admin(ctx) or sec[2]):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Class not found.")
    exams = (
        (
            await db.execute(
                text(
                    "select x.id from public.exams x where x.academic_session_id = :sess and exists "
                    "(select 1 from public.exam_papers p where p.exam_id = x.id and p.class_id = :c) "
                    "order by (select min(exam_date) from public.exam_papers p where p.exam_id = x.id)"
                ),
                {"sess": sec[1], "c": sec[0]},
            )
        )
        .scalars()
        .all()
    )
    out = []
    for eid in exams:
        x = await _exam(db, ctx, eid)
        out.append({**_exam_out(x), "papers": await _papers(db, eid, sec[0])})
    return out


# ------------------------------------------------------------------ students & parents (shared)
async def student_exams(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID) -> list[dict]:
    """Scheduled and published exams of the student's current class: date sheet and, when
    published, their result. RLS hides drafts and unpublished marks."""
    from app.api.v1.routes.portal import _child_section

    section_id = await _child_section(db, ctx, student_id)
    sec = (
        await db.execute(
            text("select class_id, academic_session_id from public.sections where id = :s"), {"s": section_id}
        )
    ).first()
    exams = (
        (
            await db.execute(
                text(
                    "select x.id from public.exams x where x.academic_session_id = :sess and "
                    "x.status <> 'draft' and exists "
                    "(select 1 from public.exam_papers p where p.exam_id = x.id and p.class_id = :c) "
                    "order by (select min(exam_date) from public.exam_papers p where p.exam_id = x.id) desc"
                ),
                {"sess": sec[1], "c": sec[0]},
            )
        )
        .scalars()
        .all()
    )
    out = []
    for eid in exams:
        x = await _exam(db, ctx, eid)
        papers = await _papers(db, eid, sec[0])
        for p in papers:  # counts across the class are staff information
            p.pop("entered", None)
            p.pop("students", None)
        item = {**_exam_out(x), "papers": papers, "result": None, "section_id": str(section_id)}
        if x.status == "published":
            res, ids, size = await section_results(db, eid, section_id)
            mine = [
                _result_json(r, i["student_id"])
                for r, i in zip(res, ids, strict=True)
                if i["student_id"] == str(student_id)
            ]
            item["result"] = mine[0] if mine else None
            item["out_of"] = size
            rem = (
                await db.execute(
                    text(
                        "select teacher_remarks, principal_remarks from public.report_card_remarks "
                        "where exam_id = :x and student_id = :st"
                    ),
                    {"x": eid, "st": student_id},
                )
            ).first()
            item["teacher_remarks"], item["principal_remarks"] = (rem[0], rem[1]) if rem else (None, None)
        out.append(item)
    return out


async def student_report_card(
    db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID, exam_id: uuid.UUID
) -> Response:
    from app.api.v1.routes.portal import _child_section
    from app.api.v1.routes.report_cards import build_cards

    x = await _exam(db, ctx, exam_id)  # RLS: drafts don't exist for families
    if x.status != "published":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Results of this exam aren't published yet.")
    section_id = await _child_section(db, ctx, student_id)
    pdf = await build_cards(db, ctx, x, section_id, {str(student_id)})
    if pdf is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No result for this exam.")
    name = (
        await db.execute(text("select full_name from public.students where id = :i"), {"i": student_id})
    ).scalar() or "student"
    return _pdf(pdf, f"report-card-{x.name}-{name}")


# ------------------------------------------------------------------ report cards: remarks
class RemarkEntry(_Strict):
    enrollment_id: uuid.UUID
    teacher_remarks: str | None = Field(default=None, max_length=500)
    principal_remarks: str | None = Field(default=None, max_length=500)


class RemarksIn(_Strict):
    section_id: uuid.UUID
    entries: list[RemarkEntry] = Field(max_length=200)


@router.get("/{exam_id}/remarks")
async def get_remarks(
    exam_id: uuid.UUID, section_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> dict:
    """Students of a section with their result and the remarks for their report card."""
    x = await _exam(db, ctx, exam_id)
    sec = await _section(db, ctx, x, section_id)
    res, ids, _size = await section_results(db, exam_id, section_id)
    by_student = {i["student_id"]: r for r, i in zip(res, ids, strict=True)}
    rows = (
        await db.execute(
            text(
                "select e.id, st.id, st.full_name, e.admission_number, r.teacher_remarks, r.principal_remarks "
                "from public.student_enrollments e join public.students st on st.id = e.student_id "
                "and st.status = 'active' "
                "left join public.report_card_remarks r on r.exam_id = :x and r.student_id = st.id "
                "where e.section_id = :sec order by lower(st.full_name), e.admission_number"
            ),
            {"x": exam_id, "sec": section_id},
        )
    ).all()
    open_ = x.status != "published" and not x.archived
    return {
        "exam": _exam_out(x),
        "section": {"id": str(sec[0]), "label": sec[2]},
        "can_edit_teacher": open_ and (_is_admin(ctx) or bool(sec[3])),
        "can_edit_principal": open_ and _is_admin(ctx),
        "students": [
            {
                "enrollment_id": str(r[0]),
                "student_id": str(r[1]),
                "full_name": r[2],
                "admission_number": r[3],
                "teacher_remarks": r[4],
                "principal_remarks": r[5],
                "percentage": num(by_student[str(r[1])].percentage)
                if str(r[1]) in by_student and by_student[str(r[1])].percentage is not None
                else None,
                "grade": by_student[str(r[1])].grade if str(r[1]) in by_student else None,
                "result": by_student[str(r[1])].result if str(r[1]) in by_student else None,
            }
            for r in rows
        ],
    }


@router.put("/{exam_id}/remarks")
async def save_remarks(
    exam_id: uuid.UUID,
    payload: RemarksIn,
    request: Request,
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Saves remarks for a section in one go. A field left out is not changed. Teachers write the
    class teacher's remarks for their sections; only admins write the principal's remarks."""
    x = await _exam(db, ctx, exam_id)
    if x.status == "published":
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Results of this exam are published. Unpublish them to change remarks."
        )
    sec = await _section(db, ctx, x, payload.section_id)
    admin = _is_admin(ctx)
    if not (admin or ctx.can(Permission.MARKS_ENTER)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow this action.")
    current = await get_remarks(exam_id, payload.section_id, ctx=ctx, db=db)
    roster = {s["enrollment_id"]: s for s in current["students"]}
    changed = 0
    try:
        for e in payload.entries:
            s = roster.get(str(e.enrollment_id))
            if s is None:
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A student in the list isn't in this class.")
            given = e.model_fields_set - {"enrollment_id"}
            if "principal_remarks" in given and not admin:
                if (e.principal_remarks or None) != (s["principal_remarks"] or None):
                    raise HTTPException(
                        status.HTTP_403_FORBIDDEN,
                        "Only the principal's office (school admins) can write the principal's remarks.",
                    )
                given.discard("principal_remarks")
            vals = {k: (" ".join((getattr(e, k) or "").split()) or None) for k in given}
            if all(vals[k] == (s[k] or None) for k in vals):
                continue
            cols = ", ".join(vals)
            await db.execute(
                text(
                    f"insert into public.report_card_remarks (school_id, exam_id, student_id, "
                    f"enrollment_id, section_id, {cols}) "
                    f"values (:sch, :x, :st, :en, :sec, {', '.join(':' + k for k in vals)}) "
                    f"on conflict (exam_id, student_id) do update set {', '.join(f'{k} = excluded.{k}' for k in vals)}"
                ),
                {
                    "sch": ctx.school_id,
                    "x": exam_id,
                    "st": s["student_id"],
                    "en": e.enrollment_id,
                    "sec": sec[0],
                    **vals,
                },
            )
            changed += 1
        await _commit(
            db, request, ctx, "exam.remarks_saved", str(exam_id), {"section_id": str(sec[0]), "changed": changed}
        )
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return {**await get_remarks(exam_id, payload.section_id, ctx=ctx, db=db), "saved": changed}
