"""Push notifications on this device (any signed-in person: parents, students, teachers, staff).

A device that allows notifications registers here; from then on every in-app notification
for that person is also pushed to it (the background sender does the sending). People see,
adjust and remove only their own devices (RLS). Device addresses are never sent back to
the browser — only a short fingerprint, so the app can tell which entry is "this device".
"""

import hashlib
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser, get_current_user, get_db
from app.core.ratelimit import limit
from app.db.errors import http_error_from_db
from app.services import push

router = APIRouter(prefix="/push", tags=["push"])


def fingerprint(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode()).hexdigest()[:16]


class Keys(BaseModel):
    p256dh: str = Field(min_length=80, max_length=100)
    auth: str = Field(min_length=16, max_length=30)


class SubscriptionIn(BaseModel):
    model_config = {"extra": "ignore"}  # browsers add fields such as expirationTime

    endpoint: str = Field(min_length=10, max_length=1000)
    keys: Keys
    device_label: str | None = Field(default=None, max_length=100)
    show_preview: bool | None = None

    @field_validator("device_label", mode="before")
    @classmethod
    def _label(cls, v: object) -> object:
        return " ".join(v.split())[:100] or None if isinstance(v, str) else v


class SubscriptionUpdate(BaseModel):
    model_config = {"extra": "forbid"}

    show_preview: bool | None = None
    device_label: str | None = Field(default=None, min_length=1, max_length=100)


class SubscriptionOut(BaseModel):
    id: uuid.UUID
    fingerprint: str
    device_label: str | None
    show_preview: bool
    created_at: datetime
    last_seen_at: datetime
    last_success_at: datetime | None
    failing: bool


def _out(r) -> SubscriptionOut:
    return SubscriptionOut(
        id=r["id"], fingerprint=fingerprint(r["endpoint"]), device_label=r["device_label"],
        show_preview=r["show_preview"],
        created_at=r["created_at"], last_seen_at=r["last_seen_at"], last_success_at=r["last_success_at"],
        failing=r["failures"] > 0,
    )  # fmt: skip


@router.get("/config")
async def config(_: CurrentUser = Depends(get_current_user)) -> dict:
    """Whether push works on this server, and the key browsers need to subscribe."""
    if not push.configured():
        return {"enabled": False, "public_key": None}
    return {"enabled": True, "public_key": push.vapid().public_key_b64}


async def _list(db: AsyncSession) -> list[SubscriptionOut]:
    rows = (
        (await db.execute(text("select * from public.push_subscriptions order by last_seen_at desc"))).mappings().all()
    )  # RLS: only the caller's own
    return [_out(r) for r in rows]


@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(_: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    return await _list(db)


@router.post("/subscriptions", response_model=SubscriptionOut, status_code=status.HTTP_201_CREATED)
async def subscribe(
    payload: SubscriptionIn,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SubscriptionOut:
    await limit(request, f"push-subscribe:{user.id}", 30, 600)
    if not push.configured():
        raise HTTPException(status.HTTP_409_CONFLICT, "Push notifications aren't set up on this server.")
    if not push.endpoint_allowed(payload.endpoint):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "This browser's push service isn't supported.")
    if not push.valid_keys(payload.keys.p256dh, payload.keys.auth):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The browser sent invalid notification keys.")
    try:
        sid = (
            await db.execute(
                text("select private.push_subscribe(:e, :k, :a, :l, :p)"),
                {"e": payload.endpoint, "k": payload.keys.p256dh.rstrip("="), "a": payload.keys.auth.rstrip("="),
                 "l": payload.device_label, "p": payload.show_preview},
            )
        ).scalar_one()  # fmt: skip
        await db.commit()
    except DBAPIError as exc:
        raise await http_error_from_db(db, exc) from None
    r = (await db.execute(text("select * from public.push_subscriptions where id = :id"), {"id": sid})).mappings().one()
    return _out(r)


@router.patch("/subscriptions/{sub_id}", response_model=SubscriptionOut)
async def update_subscription(
    sub_id: uuid.UUID,
    payload: SubscriptionUpdate,
    _: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SubscriptionOut:
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if changes:
        sets = ", ".join(f"{k} = :{k}" for k in changes)
        await db.execute(text(f"update public.push_subscriptions set {sets} where id = :id"), {"id": sub_id, **changes})
        await db.commit()
    r = (
        (await db.execute(text("select * from public.push_subscriptions where id = :id"), {"id": sub_id}))
        .mappings()
        .first()
    )
    if r is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found.")
    return _out(r)


@router.delete("/subscriptions/{sub_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_subscription(
    sub_id: uuid.UUID, _: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> Response:
    res = await db.execute(text("delete from public.push_subscriptions where id = :id"), {"id": sub_id})
    await db.commit()
    if res.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Device not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class EndpointIn(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1000)


@router.post("/unsubscribe", status_code=status.HTTP_204_NO_CONTENT)
async def unsubscribe(
    payload: EndpointIn, _: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> Response:
    """This device stops receiving (turned off here, or signing out). Unknown addresses are ignored."""
    await db.execute(text("delete from public.push_subscriptions where endpoint = :e"), {"e": payload.endpoint})
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class TestIn(BaseModel):
    endpoint: str | None = Field(default=None, max_length=1000)  # just this device; empty = all of mine


@router.post("/test")
async def send_test(
    payload: TestIn, request: Request, user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """Sends a test notification now (not through the queue), so people can see it works."""
    await limit(request, f"push-test:{user.id}", 5, 600)
    if not push.configured():
        raise HTTPException(status.HTTP_409_CONFLICT, "Push notifications aren't set up on this server.")
    q = "select * from public.push_subscriptions" + (" where endpoint = :e" if payload.endpoint else "")
    rows = (await db.execute(text(q), {"e": payload.endpoint} if payload.endpoint else {})).mappings().all()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This device isn't set up for notifications yet.")
    sent = gone = failed = 0
    async with push.client() as client:
        for r in rows:
            msg = push.message(
                "Notifications are on",
                "This is how school notifications will appear on this device." if r["show_preview"]
                else "You have a new notification. Open the app to read it.",
                "/notifications", f"test-{r['id']}", None,
            )  # fmt: skip
            result, _err = await push.send(client, r["endpoint"], r["p256dh"], r["auth"], msg, urgency="high")
            if result == "sent":
                sent += 1
            elif result == "gone":
                gone += 1
                await db.execute(text("delete from public.push_subscriptions where id = :id"), {"id": r["id"]})
            else:
                failed += 1
    await db.commit()
    return {"sent": sent, "removed": gone, "failed": failed}
