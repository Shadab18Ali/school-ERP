"""Students of the active school. Staff can view; school admins manage.

Students are never deleted through the API: they are deactivated (with a reason)
so fees, attendance and results history always has someone to belong to.
"""

import re
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy import func, or_, select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.models.academic import AcademicSession, SchoolClass, Section
from app.models.students import Student, StudentEnrollment
from app.schemas.students import (
    EnrollmentIn,
    EnrollmentOut,
    EnrollmentUpdate,
    Gender,
    NextAdmissionNumber,
    StatusUpdate,
    StudentCreate,
    StudentDetail,
    StudentList,
    StudentListItem,
    StudentSort,
    StudentStatus,
    StudentUpdate,
    same_phone,
)
from app.services import storage
from app.services.academics import phone_digits, resolve_session
from app.services.audit import write_audit
from app.services.images import MAX_UPLOAD_BYTES, PhotoError, process_photo

router = APIRouter(prefix="/students", tags=["students"])
VIEW = Depends(require_permission(Permission.STUDENTS_VIEW))
MANAGE = Depends(require_permission(Permission.STUDENTS_MANAGE))
UNIQUE = {
    "student_enrollments_admission_number_key": "This admission number is already used in this session.",
    "student_enrollments_one_per_session": "This student is already enrolled in that session.",
}


def _like(term: str) -> str:
    return "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _enrollment_cols():
    return (
        StudentEnrollment,
        AcademicSession.name,
        AcademicSession.is_current,
        AcademicSession.archived_at,
        SchoolClass.name,
        Section.name,
    )


def _joins(q):
    return (
        q.join(AcademicSession, AcademicSession.id == StudentEnrollment.academic_session_id)
        .join(SchoolClass, SchoolClass.id == StudentEnrollment.class_id)
        .join(Section, Section.id == StudentEnrollment.section_id)
    )


def _enr(e: StudentEnrollment, sname: str, scur: bool, sarch, cname: str, secname: str) -> EnrollmentOut:
    return EnrollmentOut(
        id=e.id,
        academic_session_id=e.academic_session_id,
        session_name=sname,
        session_is_current=scur,
        session_is_archived=sarch is not None,
        class_id=e.class_id,
        class_name=cname,
        section_id=e.section_id,
        section_name=secname,
        admission_number=e.admission_number,
        admission_date=e.admission_date,
    )


async def _get(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID) -> Student:
    s = await db.scalar(select(Student).where(Student.id == student_id, Student.school_id == ctx.school_id))
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found.")
    return s


async def _check_placement(
    db: AsyncSession, ctx: SchoolContext, session_id: uuid.UUID, class_id: uuid.UUID, section_id: uuid.UUID
) -> None:
    """Friendly checks before the database's own (composite keys + guard trigger)."""
    session = await db.scalar(
        select(AcademicSession).where(AcademicSession.id == session_id, AcademicSession.school_id == ctx.school_id)
    )
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Academic session not found.")
    if session.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Session {session.name} is archived. Restore it first.")
    ok = await db.scalar(
        select(Section.id).where(
            Section.id == section_id,
            Section.school_id == ctx.school_id,
            Section.class_id == class_id,
            Section.academic_session_id == session_id,
            Section.deleted_at.is_(None),
        )
    )
    if ok is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Choose a section of that class in this session.")


async def _detail(db: AsyncSession, ctx: SchoolContext, s: Student) -> StudentDetail:
    rows = (
        await db.execute(
            _joins(select(*_enrollment_cols()))
            .where(StudentEnrollment.student_id == s.id, StudentEnrollment.school_id == ctx.school_id)
            .order_by(AcademicSession.start_date.desc())
        )
    ).all()
    enrollments = [_enr(*r) for r in rows]
    photo = (await storage.signed_urls(storage.PHOTO_BUCKET, [s.photo_path])).get(s.photo_path or "")
    return StudentDetail(
        id=s.id,
        student_code=s.student_code,
        full_name=s.full_name,
        father_name=s.father_name,
        mother_name=s.mother_name,
        date_of_birth=s.date_of_birth,
        gender=s.gender,
        mobile=s.mobile,
        alternate_mobile=s.alternate_mobile,
        address=s.address,
        photo_url=photo,
        status=s.status,
        status_reason=s.status_reason,
        created_at=s.created_at,
        updated_at=s.updated_at,
        enrollments=enrollments,
        current_enrollment=next((e for e in enrollments if e.session_is_current), None),
    )


# ---------------------------------------------------------------- list
@router.get("", response_model=StudentList)
async def list_students(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    session_id: uuid.UUID | None = Query(default=None, description="Defaults to the current session"),
    class_id: uuid.UUID | None = None,
    section_id: uuid.UUID | None = None,
    status_filter: StudentStatus | None = Query(default=None, alias="status"),
    gender: Gender | None = None,
    search: str | None = Query(default=None, max_length=100),
    sort: StudentSort = "class",
    page: int = Query(default=1, ge=1, le=100_000),
    page_size: int = Query(default=25, ge=1, le=100),
) -> StudentList:
    session = await resolve_session(db, ctx, session_id)
    if session is None:
        return StudentList(items=[], total=0, page=page, page_size=page_size, session_id=None, session_name=None)

    q = _joins(
        select(Student, *_enrollment_cols()).join(StudentEnrollment, StudentEnrollment.student_id == Student.id)
    ).where(Student.school_id == ctx.school_id, StudentEnrollment.academic_session_id == session.id)
    if class_id:
        q = q.where(StudentEnrollment.class_id == class_id)
    if section_id:
        q = q.where(StudentEnrollment.section_id == section_id)
    if status_filter:
        q = q.where(Student.status == status_filter)
    if gender:
        q = q.where(Student.gender == gender)
    if search and search.strip():
        term = " ".join(search.split())
        p = _like(term)
        conds = [
            Student.full_name.ilike(p, escape="\\"),
            Student.father_name.ilike(p, escape="\\"),
            Student.mother_name.ilike(p, escape="\\"),
            Student.student_code.ilike(p, escape="\\"),
            StudentEnrollment.admission_number.ilike(p, escape="\\"),
        ]
        digits = phone_digits(term)
        if digits:  # only phone-like searches ("98765 43210", "+91-98765"), never "ADM-2024-001"
            conds += [Student.mobile.contains(digits), Student.alternate_mobile.contains(digits)]
        q = q.where(or_(*conds))

    order = {
        "class": (
            SchoolClass.display_order,
            func.lower(SchoolClass.name),
            func.lower(Section.name),
            func.lower(Student.full_name),
        ),
        "name": (func.lower(Student.full_name),),
        "admission_number": (func.lower(StudentEnrollment.admission_number),),
        "newest": (Student.created_at.desc(),),
    }[sort]
    total = await db.scalar(select(func.count()).select_from(q.subquery())) or 0
    rows = (await db.execute(q.order_by(*order, Student.id).offset((page - 1) * page_size).limit(page_size))).all()
    photos = await storage.signed_urls(storage.PHOTO_BUCKET, [r[0].photo_path for r in rows])
    items = [
        StudentListItem(
            id=s.id,
            student_code=s.student_code,
            full_name=s.full_name,
            father_name=s.father_name,
            mother_name=s.mother_name,
            gender=s.gender,
            date_of_birth=s.date_of_birth,
            mobile=s.mobile,
            status=s.status,
            photo_url=photos.get(s.photo_path or ""),
            enrollment=_enr(*rest),
        )
        for s, *rest in rows
    ]
    return StudentList(
        items=items, total=total, page=page, page_size=page_size, session_id=session.id, session_name=session.name
    )


@router.get("/next-admission-number", response_model=NextAdmissionNumber)
async def next_admission_number(
    session_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> NextAdmissionNumber:
    """Suggests the next number following the school's most recent pattern, e.g. ADM-0042 -> ADM-0043."""
    taken = list(
        (
            await db.scalars(
                select(StudentEnrollment.admission_number)
                .where(
                    StudentEnrollment.school_id == ctx.school_id, StudentEnrollment.academic_session_id == session_id
                )
                .order_by(StudentEnrollment.created_at.desc())
            )
        ).all()
    )
    pattern = re.compile(r"^(.*?)(\d+)$")
    latest = next((m for m in map(pattern.match, taken) if m), None)
    if latest is None:
        return NextAdmissionNumber(suggestion=None)
    prefix, width = latest.group(1), len(latest.group(2))
    highest = max(int(m.group(2)) for m in map(pattern.match, taken) if m and m.group(1) == prefix)
    used = {t.casefold() for t in taken}
    n = highest + 1
    while (candidate := f"{prefix}{str(n).zfill(width)}").casefold() in used:
        n += 1
    return NextAdmissionNumber(suggestion=candidate)


# ---------------------------------------------------------------- one student
@router.get("/{student_id}", response_model=StudentDetail)
async def get_student(
    student_id: uuid.UUID, ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)
) -> StudentDetail:
    return await _detail(db, ctx, await _get(db, ctx, student_id))


@router.post("", response_model=StudentDetail, status_code=status.HTTP_201_CREATED)
async def create_student(
    payload: StudentCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StudentDetail:
    e = payload.enrollment
    await _check_placement(db, ctx, e.academic_session_id, e.class_id, e.section_id)
    s = Student(school_id=ctx.school_id, created_by=user.id, **payload.model_dump(exclude={"enrollment"}))
    db.add(s)
    try:
        await db.flush()  # assigns the Student ID
        db.add(StudentEnrollment(school_id=ctx.school_id, student_id=s.id, created_by=user.id, **e.model_dump()))
        await db.flush()
        # recorded in the audit log by the database (student.created, migration 0032)
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    await db.refresh(s)
    return await _detail(db, ctx, s)


@router.patch("/{student_id}", response_model=StudentDetail)
async def update_student(
    student_id: uuid.UUID,
    payload: StudentUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> StudentDetail:
    s = await _get(db, ctx, student_id)
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if getattr(s, k) != v}
    merged_father = changes.get("father_name", s.father_name)
    merged_mother = changes.get("mother_name", s.mother_name)
    if not (merged_father or merged_mother):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Enter the father's or the mother's name.")
    if same_phone(changes.get("alternate_mobile", s.alternate_mobile), changes.get("mobile", s.mobile)):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The alternate mobile is the same as the mobile.")
    if changes:
        for k, v in changes.items():
            setattr(s, k, v)
        try:
            await db.flush()
            # recorded by the database, with each changed field as from → to (student.updated, migration 0032)
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
        await db.refresh(s)
    return await _detail(db, ctx, s)


@router.patch("/{student_id}/enrollments/{enrollment_id}", response_model=StudentDetail)
async def update_enrollment(
    student_id: uuid.UUID,
    enrollment_id: uuid.UUID,
    payload: EnrollmentUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> StudentDetail:
    s = await _get(db, ctx, student_id)
    e = await db.scalar(
        select(StudentEnrollment).where(
            StudentEnrollment.id == enrollment_id,
            StudentEnrollment.student_id == s.id,
            StudentEnrollment.school_id == ctx.school_id,
        )
    )
    if e is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Enrollment not found.")
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if getattr(e, k) != v}
    if "section_id" in changes or "class_id" in changes:
        await _check_placement(db, ctx, e.academic_session_id, payload.class_id, payload.section_id)  # type: ignore[arg-type]
    if changes:
        before = {k: str(getattr(e, k)) for k in changes}
        for k, v in changes.items():
            setattr(e, k, v)
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="student.enrollment_updated",
                entity_type="student",
                entity_id=str(s.id),
                school_id=ctx.school_id,
                metadata={"before": before, "after": {k: str(v) for k, v in changes.items()}},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, s)


@router.post("/{student_id}/enrollments", response_model=StudentDetail, status_code=status.HTTP_201_CREATED)
async def enroll_student(
    student_id: uuid.UUID,
    payload: EnrollmentIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StudentDetail:
    """Enrol an existing student in another session (e.g. the new school year)."""
    s = await _get(db, ctx, student_id)
    await _check_placement(db, ctx, payload.academic_session_id, payload.class_id, payload.section_id)
    db.add(StudentEnrollment(school_id=ctx.school_id, student_id=s.id, created_by=user.id, **payload.model_dump()))
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="student.enrolled",
            entity_type="student",
            entity_id=str(s.id),
            school_id=ctx.school_id,
            metadata={"session_id": str(payload.academic_session_id)},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc, UNIQUE) from None
    return await _detail(db, ctx, s)


@router.post("/{student_id}/status", response_model=StudentDetail)
async def set_status(
    student_id: uuid.UUID,
    payload: StatusUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> StudentDetail:
    s = await _get(db, ctx, student_id)
    reason = payload.reason if payload.status == "inactive" else None
    if s.status != payload.status or s.status_reason != reason:
        s.status, s.status_reason = payload.status, reason
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action=f"student.{'activated' if payload.status == 'active' else 'deactivated'}",
                entity_type="student",
                entity_id=str(s.id),
                school_id=ctx.school_id,
                metadata={"reason": reason},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await http_error_from_db(db, exc) from None
        await db.refresh(s)
    return await _detail(db, ctx, s)


@router.post("/{student_id}/photo", response_model=StudentDetail)
async def upload_photo(
    student_id: uuid.UUID,
    request: Request,
    file: UploadFile = File(...),
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> StudentDetail:
    s = await _get(db, ctx, student_id)
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    try:
        jpeg = await run_in_threadpool(process_photo, data)
    except PhotoError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    path = f"{ctx.school_id}/{s.id}/{uuid.uuid4().hex}.jpg"
    try:
        await storage.upload(storage.PHOTO_BUCKET, path, jpeg, "image/jpeg")
    except storage.StorageError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    old = s.photo_path
    s.photo_path = path
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="student.photo_updated",
            entity_type="student",
            entity_id=str(s.id),
            school_id=ctx.school_id,
        )
        await db.commit()
    except DBAPIError:
        await db.rollback()
        await storage.delete(storage.PHOTO_BUCKET, path)
        raise
    if old:
        await storage.delete(storage.PHOTO_BUCKET, old)
    await db.refresh(s)
    return await _detail(db, ctx, s)


@router.delete("/{student_id}/photo", response_model=StudentDetail)
async def remove_photo(
    student_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> StudentDetail:
    s = await _get(db, ctx, student_id)
    old = s.photo_path
    if old:
        s.photo_path = None
        await db.flush()
        await write_audit(
            db,
            request,
            action="student.photo_removed",
            entity_type="student",
            entity_id=str(s.id),
            school_id=ctx.school_id,
        )
        await db.commit()
        await storage.delete(storage.PHOTO_BUCKET, old)
        await db.refresh(s)
    return await _detail(db, ctx, s)
