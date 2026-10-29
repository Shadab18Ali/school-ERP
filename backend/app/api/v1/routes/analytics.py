"""School analytics: students (enrollment, class strength, attendance, performance), fees
(collection, pending, by class and method, outstanding over time) and admissions (enquiries,
applications, conversion, admissions).

Every figure is computed by one SQL function per tab over the school's own records
(private.analytics_students / _fees / _admissions, migration 0028). The functions check the
caller's role in the school themselves — student analytics for school admins, fee and admission
analytics for school admins and accountants — so the route only adds the same check up front
for a clear 403 and passes the JSON through untouched (amounts stay exact decimals).
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import SchoolContext, get_db, require_feature, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services.academics import get_class, resolve_session

# the school's plan must include analytics (migration 0030; no subscription recorded = everything)
router = APIRouter(prefix="/analytics", tags=["analytics"], dependencies=[Depends(require_feature("analytics"))])

NO_SESSION = '{"session": null}'


def _check_range(date_from: date | None, date_to: date | None) -> None:
    if date_from and date_to and date_from > date_to:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The start date must be on or before the end date.")


async def _run(db: AsyncSession, sql: str, params: dict) -> Response:
    try:
        data = await db.scalar(text(sql), params)
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from exc
    return Response(content=data or NO_SESSION, media_type="application/json")


async def sync_dues(db: AsyncSession, school_id: uuid.UUID, session_id: uuid.UUID) -> None:
    """The session's dues, brought in line with the fee structures (role-checked in the database)."""
    try:
        await db.execute(text("select private.analytics_sync_dues(:s, :sid)"), {"s": school_id, "sid": session_id})
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from exc


async def _common(db, ctx, session_id, class_id, date_from, date_to):
    _check_range(date_from, date_to)
    session = await resolve_session(db, ctx, session_id)
    if class_id is not None:
        await get_class(db, ctx, class_id)
    return session


@router.get("/students")
async def student_analytics(
    session_id: uuid.UUID | None = None,
    class_id: uuid.UUID | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    exam_id: uuid.UUID | None = None,
    ctx: SchoolContext = Depends(require_permission(Permission.ANALYTICS_STUDENTS)),
    db: AsyncSession = Depends(get_db),
) -> Response:
    session = await _common(db, ctx, session_id, class_id, date_from, date_to)
    if session is None:
        return Response(content=NO_SESSION, media_type="application/json")
    return await _run(
        db,
        "select private.analytics_students(:s, :sid, :cid, :f, :t, :eid)::text",
        {"s": ctx.school_id, "sid": session.id, "cid": class_id, "f": date_from, "t": date_to, "eid": exam_id},
    )


@router.get("/fees")
async def fee_analytics(
    session_id: uuid.UUID | None = None,
    class_id: uuid.UUID | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    ctx: SchoolContext = Depends(require_permission(Permission.ANALYTICS_FEES)),
    db: AsyncSession = Depends(get_db),
) -> Response:
    session = await _common(db, ctx, session_id, class_id, date_from, date_to)
    if session is None:
        return Response(content=NO_SESSION, media_type="application/json")
    # dues follow the fee structures; bring them up to date first (as the dashboard and reports do)
    await sync_dues(db, ctx.school_id, session.id)
    return await _run(
        db,
        "select private.analytics_fees(:s, :sid, :cid, :f, :t)::text",
        {"s": ctx.school_id, "sid": session.id, "cid": class_id, "f": date_from, "t": date_to},
    )


@router.get("/admissions")
async def admission_analytics(
    session_id: uuid.UUID | None = None,
    class_id: uuid.UUID | None = None,
    date_from: date | None = Query(None, alias="from"),
    date_to: date | None = Query(None, alias="to"),
    ctx: SchoolContext = Depends(require_permission(Permission.ANALYTICS_ADMISSIONS)),
    db: AsyncSession = Depends(get_db),
) -> Response:
    session = await _common(db, ctx, session_id, class_id, date_from, date_to)
    if session is None:
        return Response(content=NO_SESSION, media_type="application/json")
    return await _run(
        db,
        "select private.analytics_admissions(:s, :sid, :cid, :f, :t)::text",
        {"s": ctx.school_id, "sid": session.id, "cid": class_id, "f": date_from, "t": date_to},
    )
