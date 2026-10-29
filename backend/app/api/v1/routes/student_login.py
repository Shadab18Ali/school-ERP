"""Student logins, managed by school admins. One account <-> one student; the
database refuses accounts that aren't students of the same school, and the
students.account_id unique constraint stops one login covering two students."""

import uuid

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

router = APIRouter(prefix="/students/{student_id}/login", tags=["student-login"])
MANAGE = Depends(require_permission(Permission.STUDENTS_MANAGE))


class LoginIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    full_name: str | None = Field(default=None, max_length=150)


class LoginOut(BaseModel):
    linked: bool
    user_id: uuid.UUID | None = None
    email: str | None = None
    full_name: str | None = None


async def _student(db: AsyncSession, ctx: SchoolContext, student_id: uuid.UUID):
    row = (
        await db.execute(
            text("select full_name, account_id from public.students where id = :id and school_id = :s"),
            {"id": student_id, "s": ctx.school_id},
        )
    ).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found.")
    return row


async def _out(db: AsyncSession, account: uuid.UUID | None) -> LoginOut:
    if account is None:
        return LoginOut(linked=False)
    p = (await db.execute(text("select email, full_name from public.profiles where id = :u"), {"u": account})).first()
    return LoginOut(linked=True, user_id=account, email=p[0] if p else None, full_name=p[1] if p else None)


@router.get("", response_model=LoginOut)
async def get_login(student_id: uuid.UUID, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)) -> LoginOut:
    st = await _student(db, ctx, student_id)
    return await _out(db, st[1])


@router.put("", response_model=LoginOut)
async def set_login(
    student_id: uuid.UUID,
    payload: LoginIn,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LoginOut:
    st = await _student(db, ctx, student_id)
    if st[1] is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This student already has a login. Remove it first to change it.")
    email = payload.email.lower()
    try:
        account = await invite_user(email, payload.full_name or st[0])  # new accounts get a sign-in invitation
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
    other_roles = (
        await db.execute(
            text(
                "select string_agg(role::text, ', ') from public.school_memberships "
                "where user_id = :u and school_id = :s and role <> 'student' and status = 'active'"
            ),
            {"u": account, "s": ctx.school_id},
        )
    ).scalar()
    if other_roles:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"That email belongs to a {other_roles} account in this school. Use the student's own email.",
        )
    try:
        await db.execute(
            text(
                "insert into public.school_memberships (school_id, user_id, role, created_by) "
                "values (:s, :u, 'student', :by) "
                "on conflict (school_id, user_id, role) do update set status = 'active'"
            ),
            {"s": ctx.school_id, "u": account, "by": user.id},
        )
        await db.execute(
            text("update public.students set account_id = :u where id = :id and school_id = :s"),
            {"u": account, "id": student_id, "s": ctx.school_id},
        )
        await write_audit(
            db,
            request,
            action="student.login_linked",
            entity_type="student",
            entity_id=str(student_id),
            school_id=ctx.school_id,
            metadata={"email": email, "invited": invited},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(
            db, exc, {"students_account_unique": "That login is already used by another student."}
        ) from None
    return await _out(db, account)


@router.delete("", response_model=LoginOut)
async def remove_login(
    student_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> LoginOut:
    st = await _student(db, ctx, student_id)
    if st[1] is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This student has no login.")
    await db.execute(
        text("update public.students set account_id = null where id = :id and school_id = :s"),
        {"id": student_id, "s": ctx.school_id},
    )
    await write_audit(
        db,
        request,
        action="student.login_removed",
        entity_type="student",
        entity_id=str(student_id),
        school_id=ctx.school_id,
        metadata={"user_id": str(st[1])},
    )
    await db.commit()
    return LoginOut(linked=False)
