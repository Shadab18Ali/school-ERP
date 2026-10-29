"""Teacher portal. Everything here is read through RLS, which limits a teacher to
the sections assigned to them; the explicit assignment check below is the first
line of defence and makes "not yours" answer 404 rather than an empty page."""

import uuid
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.services import storage
from app.services.academics import resolve_session

router = APIRouter(prefix="/teaching", tags=["teacher-portal"])
TEACHER = Depends(require_permission(Permission.TEACHING_VIEW))
NOT_LINKED = "No teacher record is linked to your account. Please contact the school office."


class MyProfile(BaseModel):
    id: uuid.UUID
    employee_id: str
    full_name: str
    phone: str
    email: str
    qualification: str | None
    subject: str | None
    joining_date: date
    status: str
    photo_url: str | None


class MyClass(BaseModel):
    section_id: uuid.UUID
    class_id: uuid.UUID
    class_name: str
    section_name: str
    session_name: str
    subjects: list[str]
    is_class_teacher: bool
    students: int
    marked_today: int
    attendance_percentage: Decimal | None


class MyClasses(BaseModel):
    session_id: uuid.UUID | None
    session_name: str | None
    today: date
    items: list[MyClass]


class SectionStudent(BaseModel):
    student_id: uuid.UUID
    enrollment_id: uuid.UUID
    full_name: str
    student_code: str
    admission_number: str
    gender: str
    photo_url: str | None
    present: int
    marked: int
    attendance_percentage: Decimal | None
    today: str | None


class SectionView(BaseModel):
    section_id: uuid.UUID
    class_name: str
    section_name: str
    session_name: str
    session_is_archived: bool
    subjects: list[str]
    is_class_teacher: bool
    students: list[SectionStudent]


async def _me(db: AsyncSession, ctx: SchoolContext, user: CurrentUser):
    row = (
        (
            await db.execute(
                text("select * from public.teachers where account_id = :u and school_id = :s"),
                {"u": user.id, "s": ctx.school_id},
            )
        )
        .mappings()
        .first()
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_LINKED)
    return row


@router.get("/me", response_model=MyProfile)
async def my_profile(
    ctx: SchoolContext = TEACHER, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> MyProfile:
    t = await _me(db, ctx, user)
    photo = (
        (await storage.signed_urls(storage.STAFF_PHOTO_BUCKET, [t["photo_path"]])).get(t["photo_path"])
        if t["photo_path"]
        else None
    )
    return MyProfile(**{k: t[k] for k in MyProfile.model_fields if k != "photo_url"}, photo_url=photo)


@router.get("/classes", response_model=MyClasses)
async def my_classes(
    session_id: uuid.UUID | None = None,
    ctx: SchoolContext = TEACHER,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MyClasses:
    t = await _me(db, ctx, user)
    session = await resolve_session(db, ctx, session_id)
    today = date.today()
    if session is None:
        return MyClasses(session_id=None, session_name=None, today=today, items=[])
    rows = (
        await db.execute(
            text(
                "select a.section_id, a.class_id, c.name, sec.name, s.name, "
                "coalesce(array_agg(a.subject order by lower(a.subject)) filter (where a.subject is not null), '{}'), "
                "bool_or(a.is_class_teacher), "
                "(select count(*) from public.student_enrollments e join public.students st on st.id = e.student_id "
                " where e.section_id = a.section_id and st.status = 'active'), "
                "(select count(*) from public.attendance_records r where r.section_id = a.section_id and "
                "r.attendance_date = :d), "
                "(select round(100.0 * count(*) filter (where r.status = 'present') / nullif(count(*), 0), 1) "
                " from public.attendance_records r where r.section_id = a.section_id) "
                "from public.teacher_assignments a join public.classes c on c.id = a.class_id "
                "join public.sections sec on sec.id = a.section_id and sec.deleted_at is null "
                "join public.academic_sessions s on s.id = a.academic_session_id "
                "where a.teacher_id = :t and a.academic_session_id = :sid "
                "group by a.section_id, a.class_id, c.name, sec.name, s.name, c.display_order "
                "order by c.display_order, lower(c.name), lower(sec.name)"
            ),
            {"t": t["id"], "sid": session.id, "d": today},
        )
    ).all()
    return MyClasses(
        session_id=session.id,
        session_name=session.name,
        today=today,
        items=[
            MyClass(
                section_id=r[0],
                class_id=r[1],
                class_name=r[2],
                section_name=r[3],
                session_name=r[4],
                subjects=list(r[5]),
                is_class_teacher=bool(r[6]),
                students=r[7],
                marked_today=r[8],
                attendance_percentage=r[9],
            )
            for r in rows
        ],
    )


@router.get("/sections/{section_id}", response_model=SectionView)
async def my_section(
    section_id: uuid.UUID,
    ctx: SchoolContext = TEACHER,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SectionView:
    t = await _me(db, ctx, user)
    head = (
        await db.execute(
            text(
                "select c.name, sec.name, s.name, s.archived_at is not null, "
                "coalesce(array_agg(a.subject order by lower(a.subject)) filter (where a.subject is not null), '{}'), "
                "bool_or(a.is_class_teacher) "
                "from public.teacher_assignments a join public.sections sec on sec.id = a.section_id "
                "join public.classes c on c.id = a.class_id join public.academic_sessions s on s.id = "
                "a.academic_session_id "
                "where a.teacher_id = :t and a.section_id = :sec group by c.name, sec.name, s.name, s.archived_at"
            ),
            {"t": t["id"], "sec": section_id},
        )
    ).first()
    if head is None:  # not assigned to this teacher: answer exactly as if it didn't exist
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Class not found.")
    rows = (
        await db.execute(
            text(
                "select st.id, e.id, st.full_name, st.student_code, e.admission_number, st.gender, st.photo_path, "
                "count(r.id) filter (where r.status = 'present'), count(r.id), "
                "(select r2.status::text from public.attendance_records r2 where r2.enrollment_id = e.id "
                " and r2.attendance_date = current_date) "
                "from public.student_enrollments e join public.students st on st.id = e.student_id and st.status = "
                "'active' "
                "left join public.attendance_records r on r.enrollment_id = e.id "
                "where e.section_id = :sec group by st.id, e.id order by lower(st.full_name)"
            ),
            {"sec": section_id},
        )
    ).all()
    photos = await storage.signed_urls(storage.PHOTO_BUCKET, [r[6] for r in rows if r[6]])
    return SectionView(
        section_id=section_id,
        class_name=head[0],
        section_name=head[1],
        session_name=head[2],
        session_is_archived=head[3],
        subjects=list(head[4]),
        is_class_teacher=bool(head[5]),
        students=[
            SectionStudent(
                student_id=r[0],
                enrollment_id=r[1],
                full_name=r[2],
                student_code=r[3],
                admission_number=r[4],
                gender=r[5],
                photo_url=photos.get(r[6] or ""),
                present=r[7],
                marked=r[8],
                attendance_percentage=None
                if not r[8]
                else (Decimal(100 * r[7]) / Decimal(r[8])).quantize(Decimal("0.1")),
                today=r[9],
            )
            for r in rows
        ],
    )


@router.get("/timetable")
async def my_timetable(
    session_id: uuid.UUID | None = None,
    ctx: SchoolContext = TEACHER,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes.timetable import teacher_grid

    t = await _me(db, ctx, user)
    return await teacher_grid(db, ctx, t["id"], session_id)


@router.get("/timetable/pdf")
async def my_timetable_pdf(
    session_id: uuid.UUID | None = None,
    ctx: SchoolContext = TEACHER,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes.timetable import grid_pdf, teacher_grid

    t = await _me(db, ctx, user)
    g = await teacher_grid(db, ctx, t["id"], session_id)
    return await grid_pdf(db, ctx, g, g.title)
