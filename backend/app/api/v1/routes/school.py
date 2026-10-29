"""Endpoints scoped to the active tenant (X-School-Id)."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_permission
from app.core.permissions import Permission, sorted_values
from app.models.academic import AcademicSession
from app.schemas.me import CurrentSchoolOut
from app.schemas.session import CurrentSessionOut
from app.services.schools import school_out

router = APIRouter(prefix="/school", tags=["school"])


@router.get("", response_model=CurrentSchoolOut)
async def current_school(
    ctx: SchoolContext = Depends(require_permission(Permission.DASHBOARD_VIEW)),
    db: AsyncSession = Depends(get_db),
) -> CurrentSchoolOut:
    school = await school_out(db, ctx.school_id)  # RLS also enforces membership
    if school is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "School not found.")
    current = (
        await db.execute(
            select(AcademicSession.id, AcademicSession.name).where(
                AcademicSession.school_id == ctx.school_id, AcademicSession.is_current.is_(True)
            )
        )
    ).first()
    return CurrentSchoolOut(
        school=school,
        roles=sorted(ctx.roles),
        permissions=sorted_values(ctx.permissions),
        is_super_admin=ctx.is_super_admin,
        current_session=CurrentSessionOut(id=current[0], name=current[1]) if current else None,
    )
