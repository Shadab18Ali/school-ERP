"""The audit log: who did what, to which record, when and from where.

Entries are written by the API (business actions, with the request), by the database itself
(data changes to students, receipts, attendance, memberships, schools and accounts — whoever
makes them) and by Supabase Auth (sign-in, sign-out, password changes); see migration 0032.

* School admins read their own school's log; payroll entries only the school's payroll admins.
* The platform super admin reads every school's log and platform-level entries — except payroll.
* Nobody can change or delete an entry.

Row-level security decides which entries anyone sees; these routes only filter and format them.
Also here: the app reporting a sign-in or sign-out (deduplicated with Supabase's own record).
"""

import csv
import io
import uuid
from datetime import date, datetime, time, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission, require_super_admin
from app.core.permissions import Permission
from app.core.ratelimit import limit
from app.services.audit import client_ip, write_audit

router = APIRouter(tags=["audit"])
VIEW = Depends(require_permission(Permission.AUDIT_VIEW))
SUPER = Depends(require_super_admin)
IST_OFFSET = timedelta(hours=5, minutes=30)

# what people look for → which actions that means
CATEGORIES: dict[str, tuple[str, ...]] = {
    "sign_in": ("auth.",),
    "students": ("student.", "enrollment.", "guardian.", "document."),
    "fees": ("fee_payment.", "fees.", "fee_", "payments."),
    "attendance": ("attendance.",),
    "people": ("membership.", "user.", "staff.", "teacher.login", "student.login", "school.admin"),
    "school": ("school.", "session.", "class.", "section."),
    "billing": ("billing.", "subscription.", "plan."),
    "payroll": ("payroll.",),
}
Category = Literal["sign_in", "students", "fees", "attendance", "people", "school", "billing", "payroll"]
EXPORT_LIMIT = 20_000


def _filters(
    *,
    school_id: uuid.UUID | None,
    category: str | None,
    action: str | None,
    actor_id: uuid.UUID | None,
    entity_type: str | None,
    entity_id: str | None,
    from_date: date | None,
    to_date: date | None,
    q: str | None,
) -> tuple[str, dict[str, Any]]:
    where, p = ["true"], {}
    if school_id:
        where.append("a.school_id = :school")
        p["school"] = school_id
    if category:
        likes = []
        for i, prefix in enumerate(CATEGORIES[category]):
            likes.append(f"a.action like :cat{i}")
            p[f"cat{i}"] = prefix.replace("_", r"\_") + "%"
        where.append("(" + " or ".join(likes) + ")")
    if action:
        where.append("a.action = :action")
        p["action"] = action
    if actor_id:
        where.append("a.actor_id = :actor")
        p["actor"] = actor_id
    if entity_type:
        where.append("a.entity_type = :etype")
        p["etype"] = entity_type
    if entity_id:
        where.append("a.entity_id = :eid")
        p["eid"] = entity_id
    # dates are school days in India
    if from_date:
        where.append("a.created_at >= :from")
        p["from"] = datetime.combine(from_date, time.min) - IST_OFFSET
    if to_date:
        where.append("a.created_at < :to")
        p["to"] = datetime.combine(to_date + timedelta(days=1), time.min) - IST_OFFSET
    if q:
        where.append(
            "(a.actor_label ilike :q or a.action ilike :q or a.metadata ->> 'label' ilike :q "
            "or a.metadata ->> 'student' ilike :q or a.entity_id = :qexact or a.ip_address = :qexact)"
        )
        p["q"] = "%" + q.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"
        p["qexact"] = q
    return " and ".join(where), p


SELECT = (
    "select a.id, a.created_at, a.school_id, sc.name as school_name, a.actor_id, a.actor_label, a.action, "
    "a.entity_type, a.entity_id, a.metadata, a.ip_address, a.user_agent, a.source "
    "from public.audit_logs a left join public.schools sc on sc.id = a.school_id "
)


async def _page(db: AsyncSession, where: str, p: dict, page: int, page_size: int) -> dict:
    total = await db.scalar(text(f"select count(*) from public.audit_logs a where {where}"), p)
    rows = await db.execute(
        text(SELECT + f"where {where} order by a.created_at desc, a.id desc limit :lim offset :off"),
        {**p, "lim": page_size, "off": (page - 1) * page_size},
    )
    return {
        "items": [dict(r._mapping) for r in rows.all()],
        "total": total,
        "page": page,
        "page_size": page_size,
        "categories": list(CATEGORIES),
    }


def _csv(rows: list[dict], with_school: bool) -> StreamingResponse:
    buf = io.StringIO()
    w = csv.writer(buf)
    head = ["When (UTC)", "Who", "Action", "Record type", "Record", "Label", "IP", "Browser", "Source", "Details"]
    w.writerow((["School"] if with_school else []) + head)
    for r in rows:
        meta = r["metadata"] or {}
        line = [
            r["created_at"].strftime("%Y-%m-%d %H:%M:%S"),
            r["actor_label"] or "",
            r["action"],
            r["entity_type"],
            r["entity_id"] or "",
            meta.get("label") or "",
            r["ip_address"] or "",
            (r["user_agent"] or "")[:200],
            r["source"],
            _flat(meta),
        ]
        w.writerow([_cell(x) for x in ([r["school_name"] or ""] if with_school else []) + line])
    data = buf.getvalue().encode("utf-8-sig")
    return StreamingResponse(
        iter([data]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="audit-log.csv"', "Cache-Control": "private, no-store"},
    )


def _flat(meta: dict) -> str:
    import json

    return json.dumps({k: v for k, v in meta.items() if k != "label"}, default=str, ensure_ascii=False)[:2000]


def _cell(v: str) -> str:
    # a spreadsheet must not run a formula someone typed into a name (CSV injection)
    return "'" + v if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v


Q = Query(default=None, max_length=100)


# ================================================================== a school's own log
@router.get("/audit")
async def school_audit(
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    category: Category | None = None,
    action: str | None = Query(default=None, max_length=80),
    actor_id: uuid.UUID | None = None,
    entity_type: str | None = Query(default=None, max_length=60),
    entity_id: str | None = Query(default=None, max_length=80),
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    q: str | None = Q,
    page: int = Query(default=1, ge=1, le=10_000),
    page_size: int = Query(default=50, ge=1, le=200),
) -> dict:
    where, p = _filters(
        school_id=ctx.school_id,
        category=category,
        action=action,
        actor_id=actor_id,
        entity_type=entity_type,
        entity_id=entity_id,
        from_date=from_date,
        to_date=to_date,
        q=q,
    )
    return await _page(db, where, p, page, page_size)


@router.get("/audit/export")
async def school_audit_export(
    request: Request,
    ctx: SchoolContext = VIEW,
    db: AsyncSession = Depends(get_db),
    category: Category | None = None,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    q: str | None = Q,
) -> StreamingResponse:
    where, p = _filters(
        school_id=ctx.school_id,
        category=category,
        action=None,
        actor_id=None,
        entity_type=None,
        entity_id=None,
        from_date=from_date,
        to_date=to_date,
        q=q,
    )
    rows = [
        dict(r._mapping)
        for r in (
            await db.execute(
                text(SELECT + f"where {where} order by a.created_at desc, a.id desc limit {EXPORT_LIMIT}"), p
            )
        ).all()
    ]
    # exporting the log is itself recorded
    await write_audit(
        db,
        request,
        action="audit.exported",
        entity_type="audit_log",
        school_id=ctx.school_id,
        metadata={"rows": len(rows), "category": category, "from": from_date, "to": to_date, "q": q},
    )
    await db.commit()
    return _csv(rows, with_school=False)


# ================================================================== the platform's log (super admin)
@router.get("/admin/audit")
async def platform_audit(
    _: CurrentUser = SUPER,
    db: AsyncSession = Depends(get_db),
    school_id: uuid.UUID | None = None,
    platform_only: bool = False,
    category: Category | None = None,
    action: str | None = Query(default=None, max_length=80),
    actor_id: uuid.UUID | None = None,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    q: str | None = Q,
    page: int = Query(default=1, ge=1, le=10_000),
    page_size: int = Query(default=50, ge=1, le=200),
) -> dict:
    where, p = _filters(
        school_id=school_id,
        category=category,
        action=action,
        actor_id=actor_id,
        entity_type=None,
        entity_id=None,
        from_date=from_date,
        to_date=to_date,
        q=q,
    )
    if platform_only:
        where += " and a.school_id is null"
    return await _page(db, where, p, page, page_size)


@router.get("/admin/audit/export")
async def platform_audit_export(
    request: Request,
    _: CurrentUser = SUPER,
    db: AsyncSession = Depends(get_db),
    school_id: uuid.UUID | None = None,
    category: Category | None = None,
    from_date: date | None = Query(default=None, alias="from"),
    to_date: date | None = Query(default=None, alias="to"),
    q: str | None = Q,
) -> StreamingResponse:
    where, p = _filters(
        school_id=school_id,
        category=category,
        action=None,
        actor_id=None,
        entity_type=None,
        entity_id=None,
        from_date=from_date,
        to_date=to_date,
        q=q,
    )
    rows = [
        dict(r._mapping)
        for r in (
            await db.execute(
                text(SELECT + f"where {where} order by a.created_at desc, a.id desc limit {EXPORT_LIMIT}"), p
            )
        ).all()
    ]
    await write_audit(
        db,
        request,
        action="audit.exported",
        entity_type="audit_log",
        metadata={"rows": len(rows), "school": school_id, "category": category},
    )
    await db.commit()
    return _csv(rows, with_school=True)


# ================================================================== sign-in / sign-out reported by the app
class SessionEventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event: Literal["login", "logout"]


@router.post("/auth/events", status_code=status.HTTP_200_OK)
async def session_event(
    payload: SessionEventIn,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The app reports its own sign-in and sign-out. Supabase Auth normally records them first (its
    sessions table, with the IP it saw); this is the fallback where that trigger isn't available.
    The person and session come from the verified token, so nobody can report for someone else."""
    await limit(request, "auth-events", 30, 600, key=str(user.id))
    try:
        recorded = await db.scalar(
            text("select private.audit_my_session_event(:e, :ip, :ua)"),
            {"e": payload.event, "ip": client_ip(request), "ua": request.headers.get("user-agent", "")[:500]},
        )
        await db.commit()
    except Exception:  # noqa: BLE001 - recording must never stop someone signing in or out
        await db.rollback()
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Couldn't record that just now.") from None
    return {"recorded": bool(recorded)}
