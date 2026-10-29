"""School notices. Staff see every notice of the school; parents see only what
RLS allows (published, not expired, for parents/everyone, their children's classes)."""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, SchoolContext, get_current_user, get_db, require_permission
from app.core.permissions import Permission
from app.db.errors import http_error_from_db
from app.services.audit import write_audit

router = APIRouter(prefix="/notices", tags=["notices"])
Audience = Literal["everyone", "parents", "students", "staff"]


class NoticeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=3, max_length=150)
    body: str = Field(min_length=1, max_length=5000)
    audience: Audience = "everyone"
    class_ids: list[uuid.UUID] | None = Field(default=None, max_length=50)
    is_pinned: bool = False
    publish_at: datetime | None = None
    expires_at: datetime | None = None

    @field_validator("title", "body", mode="before")
    @classmethod
    def _strip(cls, v: object) -> object:
        return v.strip() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _dates(self) -> "NoticeIn":
        if self.class_ids == []:
            self.class_ids = None
        if self.publish_at and self.expires_at and self.expires_at <= self.publish_at:
            raise ValueError("The notice must expire after it is published.")
        return self


class NoticeOut(BaseModel):
    id: uuid.UUID
    title: str
    body: str
    audience: Audience
    class_ids: list[uuid.UUID] | None
    class_names: list[str]
    is_pinned: bool
    publish_at: datetime
    expires_at: datetime | None
    state: Literal["scheduled", "live", "expired"]
    created_at: datetime


_SELECT = (
    "select n.id, n.title, n.body, n.audience, n.class_ids, "
    "coalesce((select array_agg(c.name order by c.display_order) from public.classes c where c.id = any "
    "(n.class_ids)), '{}'), "
    "n.is_pinned, n.publish_at, n.expires_at, "
    "case when n.publish_at > now() then 'scheduled' when n.expires_at is not null and n.expires_at <= now() "
    "then 'expired' "
    "else 'live' end, n.created_at from public.notices n"
)


def _out(r) -> NoticeOut:
    return NoticeOut(
        id=r[0],
        title=r[1],
        body=r[2],
        audience=r[3],
        class_ids=r[4],
        class_names=list(r[5]),
        is_pinned=r[6],
        publish_at=r[7],
        expires_at=r[8],
        state=r[9],
        created_at=r[10],
    )


@router.get("", response_model=list[NoticeOut])
async def list_notices(
    ctx: SchoolContext = Depends(require_permission(Permission.NOTICES_VIEW)),
    db: AsyncSession = Depends(get_db),
    include_inactive: bool = Query(default=False, description="Managers: include scheduled and expired notices"),
) -> list[NoticeOut]:
    where = "n.school_id = :s"
    if not (include_inactive and ctx.can(Permission.NOTICES_MANAGE)):
        where += " and n.publish_at <= now() and (n.expires_at is null or n.expires_at > now())"
    rows = (
        await db.execute(
            text(f"{_SELECT} where {where} order by n.is_pinned desc, n.publish_at desc limit 200"),
            {"s": ctx.school_id},
        )
    ).all()
    return [_out(r) for r in rows]


async def _check_classes(db: AsyncSession, ctx: SchoolContext, ids: list[uuid.UUID] | None) -> None:
    if ids:
        n = (
            await db.execute(
                text("select count(*) from public.classes where school_id = :s and id = any(:ids)").bindparams(
                    bindparam("ids", type_=ARRAY(UUID(as_uuid=True)))
                ),
                {"s": ctx.school_id, "ids": ids},
            )
        ).scalar_one()
        if n != len(set(ids)):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "One of the classes isn't in this school.")


@router.post("", response_model=NoticeOut, status_code=status.HTTP_201_CREATED)
async def create_notice(
    payload: NoticeIn,
    request: Request,
    ctx: SchoolContext = Depends(require_permission(Permission.NOTICES_MANAGE)),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NoticeOut:
    await _check_classes(db, ctx, payload.class_ids)
    try:
        nid = (
            await db.execute(
                text(
                    "insert into public.notices (school_id, title, body, audience, class_ids, is_pinned, publish_at, "
                    "expires_at, created_by) "
                    "values (:s, :t, :b, cast(:a as public.notice_audience), :c, :p, coalesce(:pa, now()), :ea, :u) "
                    "returning id"
                ).bindparams(bindparam("c", type_=ARRAY(UUID(as_uuid=True)))),
                {
                    "s": ctx.school_id,
                    "t": payload.title,
                    "b": payload.body,
                    "a": payload.audience,
                    "c": payload.class_ids,
                    "p": payload.is_pinned,
                    "pa": payload.publish_at,
                    "ea": payload.expires_at,
                    "u": user.id,
                },
            )
        ).scalar_one()
        await write_audit(
            db,
            request,
            action="notice.created",
            entity_type="notice",
            entity_id=str(nid),
            school_id=ctx.school_id,
            metadata={"title": payload.title, "audience": payload.audience},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return _out((await db.execute(text(f"{_SELECT} where n.id = :id"), {"id": nid})).one())


@router.put("/{notice_id}", response_model=NoticeOut)
async def update_notice(
    notice_id: uuid.UUID,
    payload: NoticeIn,
    request: Request,
    ctx: SchoolContext = Depends(require_permission(Permission.NOTICES_MANAGE)),
    db: AsyncSession = Depends(get_db),
) -> NoticeOut:
    await _check_classes(db, ctx, payload.class_ids)
    try:
        res = await db.execute(
            text(
                "update public.notices set title = :t, body = :b, audience = cast(:a as public.notice_audience), "
                "class_ids = :c, "
                "is_pinned = :p, publish_at = coalesce(:pa, publish_at), expires_at = :ea where id = :id and "
                "school_id = :s"
            ).bindparams(bindparam("c", type_=ARRAY(UUID(as_uuid=True)))),
            {
                "id": notice_id,
                "s": ctx.school_id,
                "t": payload.title,
                "b": payload.body,
                "a": payload.audience,
                "c": payload.class_ids,
                "p": payload.is_pinned,
                "pa": payload.publish_at,
                "ea": payload.expires_at,
            },
        )
        if res.rowcount != 1:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Notice not found.")
        await write_audit(
            db,
            request,
            action="notice.updated",
            entity_type="notice",
            entity_id=str(notice_id),
            school_id=ctx.school_id,
            metadata={"title": payload.title},
        )
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    return _out((await db.execute(text(f"{_SELECT} where n.id = :id"), {"id": notice_id})).one())


@router.delete("/{notice_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_notice(
    notice_id: uuid.UUID,
    request: Request,
    ctx: SchoolContext = Depends(require_permission(Permission.NOTICES_MANAGE)),
    db: AsyncSession = Depends(get_db),
) -> None:
    res = await db.execute(
        text("delete from public.notices where id = :id and school_id = :s returning title"),
        {"id": notice_id, "s": ctx.school_id},
    )
    title = res.scalar()
    if title is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notice not found.")
    await write_audit(
        db,
        request,
        action="notice.deleted",
        entity_type="notice",
        entity_id=str(notice_id),
        school_id=ctx.school_id,
        metadata={"title": title},
    )
    await db.commit()
