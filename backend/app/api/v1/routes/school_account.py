"""A school's own account with the platform (school admins): the staff sign-ins it manages itself.
(Its plan, usage and billing: billing.py, /school/billing.)

The hierarchy: the platform's super admin adds schools and their administrators; a school's
administrators give sign-ins to accountants here (teachers get theirs on the teacher's record;
parents and students on the student's), and can turn them off again. Only the platform can add
or change administrators (also enforced by the database, migration 0029)."""

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services.audit import write_audit
from app.services.supabase_admin import SupabaseAdminError, invite_user

router = APIRouter(prefix="/school", tags=["school"])

STAFF_ROLES = ("school_admin", "accountant", "teacher", "librarian")


@router.get("/staff-accounts")
async def staff_accounts(
    ctx: SchoolContext = Depends(require_permission(Permission.STAFF_ACCOUNTS_MANAGE)),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    rows = await db.execute(
        text(
            "select m.user_id, m.role::text as role, m.status::text as status, m.created_at, "
            "coalesce(nullif(p.full_name, ''), p.email) as full_name, p.email "
            "from public.school_memberships m join public.profiles p on p.id = m.user_id "
            "where m.school_id = :s and m.role::text = any (:roles) "
            "order by array_position(:roles, m.role::text), lower(coalesce(nullif(p.full_name, ''), p.email))"
        ),
        {"s": ctx.school_id, "roles": list(STAFF_ROLES)},
    )
    return [
        {
            **dict(r._mapping),
            "managed_here": r.role == "accountant",
            "managed_by": {"school_admin": "platform", "teacher": "teacher_record", "librarian": "teacher_record"}.get(
                r.role, "here"
            ),
        }
        for r in rows.all()
    ]


class AccountantIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=150)

    @field_validator("full_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


@router.post("/staff-accounts/accountants", status_code=status.HTTP_201_CREATED)
async def add_accountant(
    payload: AccountantIn,
    request: Request,
    ctx: SchoolContext = Depends(require_permission(Permission.STAFF_ACCOUNTS_MANAGE)),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Gives someone an accountant's sign-in to this school (new emails get an invitation)."""
    email = payload.email.lower()
    try:
        account = await invite_user(email, payload.full_name)
    except SupabaseAdminError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    invited = account is not None
    if account is None:
        account = await db.scalar(
            text("select private.find_account_by_email(:s, :e)"), {"s": ctx.school_id, "e": email}
        )
        if account is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "That email has a sign-in but no profile; ask support to check it."
            )
    clash = await db.scalar(
        text(
            "select role::text from public.school_memberships where user_id = :u and school_id = :s and status = "
            "'active' "
            "and role in ('student', 'parent') limit 1"
        ),
        {"u": account, "s": ctx.school_id},
    )
    if clash:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"That email belongs to a {clash} account in this school. Use a separate email for staff.",
        )
    try:
        exists = await db.scalar(
            text(
                "select status::text from public.school_memberships where school_id = :s and user_id = :u and role = "
                "'accountant'"
            ),
            {"s": ctx.school_id, "u": account},
        )
        if exists == "active":
            raise HTTPException(status.HTTP_409_CONFLICT, "This person is already an accountant here.")
        await db.execute(
            text(
                "insert into public.school_memberships (school_id, user_id, role, created_by) values (:s, :u, "
                "'accountant', :by) "
                "on conflict (school_id, user_id, role) do update set status = 'active'"
            ),
            {"s": ctx.school_id, "u": account, "by": user.id},
        )
        await write_audit(
            db,
            request,
            action="staff.accountant_added",
            entity_type="school_membership",
            entity_id=str(account),
            school_id=ctx.school_id,
            metadata={"email": email, "invited": invited},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return {"user_id": str(account), "email": email, "invited": invited}


class StatusIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["active", "disabled"]


@router.patch("/staff-accounts/accountants/{user_id}")
async def set_accountant_status(
    user_id: uuid.UUID,
    payload: StatusIn,
    request: Request,
    ctx: SchoolContext = Depends(require_permission(Permission.STAFF_ACCOUNTS_MANAGE)),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    if user_id == user.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "You can't turn off your own sign-in.")
    try:
        res = await db.execute(
            text(
                "update public.school_memberships set status = cast(:st as public.membership_status) "
                "where school_id = :s and user_id = :u and role = 'accountant' returning user_id"
            ),
            {"st": payload.status, "s": ctx.school_id, "u": user_id},
        )
        if res.first() is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "No accountant with this sign-in here.")
        await write_audit(
            db,
            request,
            action=f"staff.accountant_{'enabled' if payload.status == 'active' else 'disabled'}",
            entity_type="school_membership",
            entity_id=str(user_id),
            school_id=ctx.school_id,
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)
