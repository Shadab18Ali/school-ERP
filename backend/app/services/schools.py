import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.core import School, SchoolMembership
from app.schemas.school import SchoolOut


def admin_count_subquery():
    return (
        select(func.count(SchoolMembership.id))
        .where(
            SchoolMembership.school_id == School.id,
            SchoolMembership.role == "school_admin",
            SchoolMembership.status == "active",
        )
        .correlate(School)
        .scalar_subquery()
    )


async def school_out(db: AsyncSession, school_id: uuid.UUID) -> SchoolOut | None:
    row = (await db.execute(select(School, admin_count_subquery()).where(School.id == school_id))).first()
    if row is None:
        return None
    school, count = row
    return SchoolOut.model_validate(school).model_copy(update={"admin_count": count or 0})
