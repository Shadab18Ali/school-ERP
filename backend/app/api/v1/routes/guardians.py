"""Parent–child links, managed by school admins. Linking gives the parent account
the school's parent role if it lacks it; the database refuses links to accounts
that aren't parents of the same school."""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services.audit import write_audit
from app.services.supabase_admin import SupabaseAdminError, invite_user

router = APIRouter(prefix="/students/{student_id}/guardians", tags=["guardians"])
MANAGE = Depends(require_permission(Permission.STUDENTS_MANAGE))
Relationship = Literal["father", "mother", "guardian", "other"]


class GuardianIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=150)
    relationship: Relationship


class GuardianOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    full_name: str | None
    email: str | None
    relationship: Relationship
    created_at: datetime


async def _student(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID) -> None:
    if not (
        await db.execute(
            text("select 1 from public.students where id = :id and school_id = :s"),
            {"id": student_id, "s": ctx.school_id},
        )
    ).scalar():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found.")


async def _list(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID) -> list[GuardianOut]:
    rows = (
        await db.execute(
            text(
                "select g.id, g.user_id, p.full_name, p.email, g.relationship, g.created_at "
                "from public.student_guardians g left join public.profiles p on p.id = g.user_id "
                "where g.student_id = :st and g.school_id = :s order by g.created_at"
            ),
            {"st": student_id, "s": ctx.school_id},
        )
    ).all()
    return [
        GuardianOut(id=r[0], user_id=r[1], full_name=r[2], email=r[3], relationship=r[4], created_at=r[5]) for r in rows
    ]


@router.get("", response_model=list[GuardianOut])
async def list_guardians(student_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)):
    await _student(db, ctx, student_id)
    return await _list(db, ctx, student_id)


@router.post("", response_model=list[GuardianOut], status_code=status.HTTP_201_CREATED)
async def link_guardian(
    student_id: uuid.UUID,
    payload: GuardianIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await _student(db, ctx, student_id)
    email = payload.email.lower()
    try:
        account = await invite_user(email, payload.full_name)  # emails a sign-in invite to new accounts
    except SupabaseAdminError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    invited = account is not None
    if account is None:
        account = (
            await db.execute(text("select private.find_account_by_email(:s, :e)"), {"s": ctx.school_id, "e": email})
        ).scalar()
        if account is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "That email has a sign-in but no profile; ask support to check it."
            )
    staff = (
        await db.execute(
            text(
                "select string_agg(role::text, ', ') from public.school_memberships "
                "where user_id = :u and school_id = :s "
                "and role <> 'parent' and status = 'active'"
            ),
            {"u": account, "s": ctx.school_id},
        )
    ).scalar()
    try:
        await db.execute(
            text(
                "insert into public.school_memberships (school_id, user_id, role, created_by) values (:s, :u, "
                "'parent', :by) "
                "on conflict (school_id, user_id, role) do update set status = 'active'"
            ),
            {"s": ctx.school_id, "u": account, "by": user.id},
        )
        await db.execute(
            text(
                "insert into public.student_guardians (school_id, student_id, user_id, relationship, created_by) "
                "values (:s, :st, :u, cast(:r as public.guardian_relationship), :by)"
            ),
            {"s": ctx.school_id, "st": student_id, "u": account, "r": payload.relationship, "by": user.id},
        )
        await write_audit(
            db,
            request,
            action="guardian.linked",
            entity_type="student",
            entity_id=str(student_id),
            school_id=ctx.school_id,
            metadata={"email": email, "relationship": payload.relationship, "invited": invited, "also_staff": staff},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(
            db, exc, {"guardians_one_link": "This person is already linked to this student."}
        ) from None
    return await _list(db, ctx, student_id)


@router.delete("/{guardian_id}", response_model=list[GuardianOut])
async def unlink_guardian(
    student_id: uuid.UUID,
    guardian_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(
        text(
            "delete from public.student_guardians where id = :g and student_id = :st and "
            "school_id = :s "
            "returning user_id"
        ),
        {"g": guardian_id, "st": student_id, "s": ctx.school_id},
    )
    removed = res.scalar()
    if removed is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Link not found.")
    await write_audit(
        db,
        request,
        action="guardian.unlinked",
        entity_type="student",
        entity_id=str(student_id),
        school_id=ctx.school_id,
        metadata={"user_id": str(removed)},
    )
    await db.commit()
    return await _list(db, ctx, student_id)
