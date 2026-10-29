"""Shared lookups for classes & sections. Every query is pinned to the active school."""

import re
import uuid

from fastapi import HTTPException, status
from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext
from app.models.academic import AcademicSession, SchoolClass

_COUNTS = text("select section_id, student_count from private.section_student_counts(:ids)").bindparams(
    bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
)


async def student_counts(db: AsyncSession, section_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    if not section_ids:
        return {}
    rows = await db.execute(_COUNTS, {"ids": section_ids})
    return {sid: int(n) for sid, n in rows.all()}


async def resolve_session(db: AsyncSession, ctx: SchoolContext, session_id: uuid.UUID | None) -> AcademicSession | None:
    """The requested session of this school, or the current one when none is given."""
    q = select(AcademicSession).where(AcademicSession.school_id == ctx.school_id)
    if session_id is not None:
        s = await db.scalar(q.where(AcademicSession.id == session_id))
        if s is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Academic session not found.")
        return s
    return await db.scalar(q.where(AcademicSession.is_current.is_(True)))


async def writable_session(db: AsyncSession, ctx: SchoolContext, session_id: uuid.UUID) -> AcademicSession:
    s = await resolve_session(db, ctx, session_id)
    assert s is not None
    if s.archived_at is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"Session {s.name} is archived. Restore it before changing its sections."
        )
    return s


async def get_class(db: AsyncSession, ctx: SchoolContext, class_id: uuid.UUID) -> SchoolClass:
    c = await db.scalar(select(SchoolClass).where(SchoolClass.id == class_id, SchoolClass.school_id == ctx.school_id))
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Class not found.")
    return c


PHONE_LIKE = re.compile(r"^[\d\s+()-]+$")


def phone_digits(term: str) -> str | None:
    """Digits to match against phone numbers, only when the search looks like a phone
    number (digits, spaces, + - and brackets, at least 4 digits). Mixed terms such as
    an admission number "ADM-2024-001" are NOT treated as phone searches."""
    term = term.strip()
    if not PHONE_LIKE.match(term):
        return None
    digits = re.sub(r"\D", "", term)
    return digits if len(digits) >= 4 else None
