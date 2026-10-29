"""Academic sessions of the active school (X-School-Id).

Every lookup is filtered by the active school id in addition to RLS, so a person
who belongs to two schools can never act on School B while working in School A.
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import pg_error
from app.models.academic import AcademicSession
from app.schemas.session import SessionCreate, SessionDelete, SessionOut, SessionUpdate, SessionUsage, _check_dates
from app.services.audit import write_audit

router = APIRouter(prefix="/sessions", tags=["academic-sessions"])

VIEW = Depends(require_permission(Permission.SESSIONS_VIEW))
MANAGE = Depends(require_permission(Permission.SESSIONS_MANAGE))

FRIENDLY_TABLES = {"sections": "sections"}


async def _usage(db: AsyncSession, session_id: uuid.UUID) -> list[SessionUsage]:
    rows = await db.execute(
        text("select table_name, row_count from private.academic_session_usage(:id)"), {"id": session_id}
    )
    return [SessionUsage(table=FRIENDLY_TABLES.get(t, t.replace("_", " ")), count=c) for t, c in rows.all()]


async def _out(db: AsyncSession, s: AcademicSession) -> SessionOut:
    return SessionOut(
        id=s.id,
        name=s.name,
        start_date=s.start_date,
        end_date=s.end_date,
        is_current=s.is_current,
        is_archived=s.archived_at is not None,
        archived_at=s.archived_at,
        created_at=s.created_at,
        usage=await _usage(db, s.id),
    )


async def _get(db: AsyncSession, ctx: SchoolContext, session_id: uuid.UUID) -> AcademicSession:
    s = await db.scalar(
        select(AcademicSession).where(AcademicSession.id == session_id, AcademicSession.school_id == ctx.school_id)
    )
    if s is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Academic session not found.")
    return s


async def _db_failure(db: AsyncSession, exc: DBAPIError) -> HTTPException:
    await db.rollback()
    err = pg_error(exc)
    if err.constraint == "academic_sessions_no_overlap":
        return HTTPException(status.HTTP_409_CONFLICT, "These dates overlap another session of this school.")
    if err.constraint == "academic_sessions_school_name_key":
        return HTTPException(status.HTTP_409_CONFLICT, "This school already has a session with that name.")
    if err.constraint == "academic_sessions_current_not_archived":
        return HTTPException(status.HTTP_409_CONFLICT, "The current session can't be archived.")
    if err.sqlstate in ("23001", "23514"):  # guard trigger / archived-current check: messages are user-facing
        return HTTPException(status.HTTP_409_CONFLICT, err.message)
    if err.sqlstate == "P0002":
        return HTTPException(status.HTTP_404_NOT_FOUND, "Academic session not found.")
    if err.sqlstate == "42501":
        return HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow this action.")
    raise exc


async def _set_current(db: AsyncSession, session_id: uuid.UUID) -> None:
    await db.execute(text("select private.set_current_academic_session(:id)"), {"id": session_id})


@router.get("", response_model=list[SessionOut])
async def list_sessions(ctx: SchoolContext = VIEW, db: AsyncSession = Depends(get_db)) -> list[SessionOut]:
    rows = await db.scalars(
        select(AcademicSession)
        .where(AcademicSession.school_id == ctx.school_id)
        .order_by(AcademicSession.start_date.desc())
    )
    return [await _out(db, s) for s in rows.all()]


@router.post("", response_model=SessionOut, status_code=status.HTTP_201_CREATED)
async def create_session(
    payload: SessionCreate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    s = AcademicSession(
        school_id=ctx.school_id,
        name=payload.name,
        start_date=payload.start_date,
        end_date=payload.end_date,
        created_by=user.id,
    )
    db.add(s)
    try:
        await db.flush()
        has_current = await db.scalar(
            select(AcademicSession.id).where(
                AcademicSession.school_id == ctx.school_id, AcademicSession.is_current.is_(True)
            )
        )
        if payload.make_current or has_current is None:  # a school's first session becomes current
            await _set_current(db, s.id)
        await write_audit(
            db,
            request,
            action="session.created",
            entity_type="academic_session",
            entity_id=str(s.id),
            school_id=ctx.school_id,
            metadata={"name": s.name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await _db_failure(db, exc) from None
    await db.refresh(s)
    return await _out(db, s)


@router.patch("/{session_id}", response_model=SessionOut)
async def update_session(
    session_id: uuid.UUID,
    payload: SessionUpdate,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    s = await _get(db, ctx, session_id)
    if s.archived_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Archived sessions can't be edited. Restore it first.")
    changes = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if getattr(s, k) != v}
    if not changes:
        return await _out(db, s)
    try:
        _check_dates(changes.get("start_date", s.start_date), changes.get("end_date", s.end_date))
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from None
    before = {k: str(getattr(s, k)) for k in changes}
    for k, v in changes.items():
        setattr(s, k, v)
    try:
        await db.flush()
        await write_audit(
            db,
            request,
            action="session.updated",
            entity_type="academic_session",
            entity_id=str(s.id),
            school_id=ctx.school_id,
            metadata={"before": before, "after": {k: str(v) for k, v in changes.items()}},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await _db_failure(db, exc) from None
    await db.refresh(s)
    return await _out(db, s)


@router.post("/{session_id}/set-current", response_model=SessionOut)
async def set_current_session(
    session_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> SessionOut:
    s = await _get(db, ctx, session_id)
    if s.is_current:
        return await _out(db, s)
    previous = await db.scalar(
        select(AcademicSession.name).where(
            AcademicSession.school_id == ctx.school_id, AcademicSession.is_current.is_(True)
        )
    )
    try:
        await _set_current(db, s.id)
        await write_audit(
            db,
            request,
            action="session.set_current",
            entity_type="academic_session",
            entity_id=str(s.id),
            school_id=ctx.school_id,
            metadata={"from": previous, "to": s.name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await _db_failure(db, exc) from None
    await db.refresh(s)
    return await _out(db, s)


@router.post("/{session_id}/archive", response_model=SessionOut)
async def archive_session(
    session_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = MANAGE,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SessionOut:
    s = await _get(db, ctx, session_id)
    if s.is_current:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "The current session can't be archived. Make another session current first."
        )
    if s.archived_at is None:
        s.archived_at = datetime.now(UTC)
        s.archived_by = user.id
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="session.archived",
                entity_type="academic_session",
                entity_id=str(s.id),
                school_id=ctx.school_id,
                metadata={"name": s.name},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await _db_failure(db, exc) from None
        await db.refresh(s)
    return await _out(db, s)


@router.post("/{session_id}/restore", response_model=SessionOut)
async def restore_session(
    session_id: uuid.UUID, request: Request, ctx: SchoolContext = MANAGE, db: AsyncSession = Depends(get_db)
) -> SessionOut:
    s = await _get(db, ctx, session_id)
    if s.archived_at is not None:
        s.archived_at = None
        s.archived_by = None
        try:
            await db.flush()
            await write_audit(
                db,
                request,
                action="session.restored",
                entity_type="academic_session",
                entity_id=str(s.id),
                school_id=ctx.school_id,
                metadata={"name": s.name},
            )
            await db.commit()
        except DBAPIError as exc:
            raise await _db_failure(db, exc) from None
        await db.refresh(s)
    return await _out(db, s)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: uuid.UUID,
    payload: SessionDelete,
    request: Request,
    ctx: SchoolContext = MANAGE,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Three safeguards: the caller must type the session's name; the API refuses
    current or in-use sessions with a clear reason; and a database trigger refuses
    them again no matter how the delete is issued."""
    s = await _get(db, ctx, session_id)
    if payload.confirm_name.strip().casefold() != s.name.strip().casefold():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Type the session name exactly to confirm deletion.")
    if s.is_current:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "The current session can't be deleted. Make another session current first."
        )
    usage = await _usage(db, s.id)
    if usage:
        what = ", ".join(f"{u.count} {u.table}" for u in usage)
        raise HTTPException(status.HTTP_409_CONFLICT, f"{s.name} still has records ({what}). Archive it instead.")
    name = s.name
    try:
        await db.delete(s)
        await db.flush()
        await write_audit(
            db,
            request,
            action="session.deleted",
            entity_type="academic_session",
            entity_id=str(session_id),
            school_id=ctx.school_id,
            metadata={"name": name},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await _db_failure(db, exc) from None
