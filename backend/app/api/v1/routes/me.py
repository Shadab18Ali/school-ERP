from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, get_current_user, get_db
from app.core.permissions import sorted_values
from app.models.core import Profile
from app.schemas.me import MembershipOut, MeOut, ProfileUpdate
from app.schemas.session import CurrentSessionOut
from app.services.audit import write_audit

router = APIRouter(tags=["me"])


def _me_out(user: CurrentUser) -> MeOut:
    return MeOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        phone=user.phone,
        is_super_admin=user.is_super_admin,
        platform_permissions=sorted_values(user.platform_permissions),
        memberships=[
            MembershipOut(
                school_id=m.school_id,
                school_name=m.school_name,
                school_code=m.school_code,
                school_status=m.school_status,
                roles=list(m.roles),
                permissions=sorted_values(m.permissions),
                current_session=(
                    CurrentSessionOut(id=m.current_session_id, name=m.current_session_name)
                    if m.current_session_id
                    else None
                ),
                access=m.access,
                features=list(m.features) if m.features is not None else None,
            )
            for m in user.memberships
        ],
    )


@router.get("/me", response_model=MeOut)
async def read_me(user: CurrentUser = Depends(get_current_user)) -> MeOut:
    return _me_out(user)


@router.patch("/me", response_model=MeOut)
async def update_me(
    payload: ProfileUpdate,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MeOut:
    """Users edit only their own name and phone. Email and password are changed
    through Supabase Auth; is_super_admin is not writable by any user (RLS + column grants)."""
    values = payload.model_dump(exclude_unset=True)
    if "full_name" in values and values["full_name"] is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Name cannot be empty.")
    changes = {k: v for k, v in values.items() if getattr(user, k) != v}
    if not changes:
        return _me_out(user)

    result = await db.execute(update(Profile).where(Profile.id == user.id).values(**changes))
    if result.rowcount != 1:  # RLS hides/blocks anything but the caller's own row
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only edit your own profile.")
    await write_audit(
        db,
        request,
        action="profile.updated",
        entity_type="profile",
        entity_id=str(user.id),
        metadata={"fields": sorted(changes)},
    )
    await db.commit()

    updated = CurrentUser(
        user.id,
        user.email,
        changes.get("full_name", user.full_name),
        user.is_super_admin,
        user.memberships,
        phone=changes.get("phone", user.phone),
    )
    return _me_out(updated)
