"""Student portal. There is no student id in these URLs: the student is always
the one linked to the signed-in account (students.account_id), so there is
nothing to change to reach anyone else. Data comes from the same handlers as the
parent portal, which re-check access, and RLS limits every query again."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.routes import homework as hw
from app.api.v1.routes import portal
from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission

router = APIRouter(prefix="/my", tags=["student-portal"])
STUDENT = Depends(require_permission(Permission.SELF_VIEW))


async def _me(db: AsyncSession, ctx: SchoolContext, user: CurrentUser) -> uuid.UUID:
    sid = (
        await db.execute(
            text("select id from public.students where account_id = :u and school_id = :s"),
            {"u": user.id, "s": ctx.school_id},
        )
    ).scalar()
    if sid is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "No student record is linked to your account. Please contact the school office."
        )
    return sid


@router.get("", response_model=portal.ChildProfile)
async def my_profile(
    ctx: SchoolContext = STUDENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> portal.ChildProfile:
    return await portal.child_profile(await _me(db, ctx, user), ctx, user, db)


@router.get("/attendance")
async def my_attendance(
    ctx: SchoolContext = STUDENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    return await portal.child_attendance(await _me(db, ctx, user), ctx, user, db)


@router.get("/fees", response_model=portal.ChildFees)
async def my_fees(
    ctx: SchoolContext = STUDENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> portal.ChildFees:
    return await portal.child_fees(await _me(db, ctx, user), ctx, user, db)


@router.get("/payments/{payment_id}/receipt.pdf")
async def my_receipt(
    payment_id: uuid.UUID,
    ctx: SchoolContext = STUDENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    return await portal.child_receipt(await _me(db, ctx, user), payment_id, ctx, user, db)


@router.get("/timetable")
async def my_timetable(
    ctx: SchoolContext = STUDENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await portal.child_timetable(await _me(db, ctx, user), ctx, user, db)


@router.get("/timetable/pdf")
async def my_timetable_pdf(
    ctx: SchoolContext = STUDENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    return await portal.child_timetable_pdf(await _me(db, ctx, user), ctx, user, db)


# ---------------------------------------------------------------- homework
@router.get("/homework")
async def my_homework(
    kind: str | None = None,
    ctx: SchoolContext = STUDENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if kind not in (None, "homework", "assignment"):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Unknown kind.")
    return await hw.student_homework_list(db, ctx, await _me(db, ctx, user), kind)  # type: ignore[arg-type]


@router.get("/homework/{homework_id}", response_model=hw.StudentHomeworkDetail)
async def my_homework_detail(
    homework_id: uuid.UUID,
    ctx: SchoolContext = STUDENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await hw.student_homework_detail(db, ctx, await _me(db, ctx, user), homework_id, is_self=True)


@router.post("/homework/{homework_id}/submission", response_model=hw.StudentHomeworkDetail)
async def my_submit(
    homework_id: uuid.UUID,
    request: Request,
    answer: str = hw.SubmitAnswer,
    files: list[UploadFile] = hw.SubmitFiles,
    ctx: SchoolContext = STUDENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await hw.submit_work(db, ctx, request, await _me(db, ctx, user), homework_id, answer, files)


@router.delete("/homework/{homework_id}/submission/files/{file_id}", response_model=hw.StudentHomeworkDetail)
async def my_remove_file(
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = STUDENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await hw.remove_submission_file(db, ctx, request, await _me(db, ctx, user), homework_id, file_id)


@router.get("/homework/{homework_id}/attachments/{file_id}")
async def my_attachment(
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
    download: bool = False,
    ctx: SchoolContext = STUDENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await hw.student_homework_detail(db, ctx, await _me(db, ctx, user), homework_id, is_self=True)
    return await hw.attachment_response(db, homework_id, file_id, download)


@router.get("/homework/{homework_id}/files/{file_id}")
async def my_submission_file(
    homework_id: uuid.UUID,
    file_id: uuid.UUID,
    download: bool = False,
    ctx: SchoolContext = STUDENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await hw.student_submission_file(db, ctx, await _me(db, ctx, user), homework_id, file_id, download)


# ---------------------------------------------------------------- exams
@router.get("/exams")
async def my_exams(
    ctx: SchoolContext = STUDENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> list[dict]:
    from app.api.v1.routes import exams

    return await exams.student_exams(db, ctx, await _me(db, ctx, user))


@router.get("/exams/{exam_id}/report-card.pdf")
async def my_report_card(
    exam_id: uuid.UUID,
    ctx: SchoolContext = STUDENT,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from app.api.v1.routes import exams

    return await exams.student_report_card(db, ctx, await _me(db, ctx, user), exam_id)


@router.get("/library")
async def my_library(
    ctx: SchoolContext = STUDENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    return await portal.child_library(await _me(db, ctx, user), ctx, user, db)


@router.get("/transport")
async def my_transport(
    ctx: SchoolContext = STUDENT, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    return await portal.child_transport(await _me(db, ctx, user), ctx, user, db)
