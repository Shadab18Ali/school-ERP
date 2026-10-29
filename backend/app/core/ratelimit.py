"""Rate limits for public (no-login) and costly endpoints.

Counts are kept in the database (private.rate_hit, migration 0033) so every API process and server
shares them — with uvicorn --workers N an in-memory count would allow N times the limit. In
development (RATE_LIMIT_BACKEND=auto) or with RATE_LIMIT_BACKEND=memory they are kept in this
process. If the database can't be reached the in-memory count is used, so a limit still applies.
"""

import logging
import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import HTTPException, Request, status

from app.core.config import get_settings

log = logging.getLogger("ratelimit")

_hits: dict[str, deque[float]] = defaultdict(deque)
_lock = Lock()
_calls = 0
MAX_WINDOW = 3600  # the longest window in use; older entries are swept


def client_ip(request: Request, trusted_hops: int | None = None) -> str:
    """The caller's IP.

    X-Forwarded-For is set by the client too, so it is only used when the API runs
    behind proxies we trust (TRUSTED_PROXY_HOPS = how many). Each trusted proxy
    appends the address it received the request from, so the client is the entry
    `hops` places from the right; anything further left could be forged.
    """
    hops = get_settings().trusted_proxy_hops if trusted_hops is None else trusted_hops
    direct = request.client.host if request.client else "unknown"
    if hops <= 0:
        return direct
    chain = [x.strip() for x in request.headers.get("x-forwarded-for", "").split(",") if x.strip()]
    # fewer entries than trusted proxies: the request didn't come through them all, so nothing in the
    # header can be trusted — use the address that actually connected
    return chain[-hops] if len(chain) >= hops else direct


def _sweep(now: float) -> None:
    for k in [k for k, q in _hits.items() if not q or q[-1] <= now - MAX_WINDOW]:
        del _hits[k]


def _too_many(retry: int) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        "Too many requests. Please wait a little and try again.",
        headers={"Retry-After": str(retry)},
    )


async def _shared_hit(key: str, max_hits: int, per_seconds: int) -> int:
    """Seconds to wait (0 = allowed), counted in the database for every API process."""
    from sqlalchemy import text

    from app.db.session import ratelimit_session

    async with ratelimit_session() as db:
        retry = await db.scalar(
            text("select private.rate_hit(:k, :m, :w)"), {"k": key, "m": max_hits, "w": per_seconds}
        )
        await db.commit()
        return int(retry or 0)


async def limit(request: Request, bucket: str, max_hits: int, per_seconds: int, *, key: str | None = None) -> None:
    """At most max_hits per per_seconds for this client IP (or for `key`, e.g. a user id)."""
    key = f"{bucket}:{key or client_ip(request)}"
    if get_settings().rate_limit_shared:
        try:
            retry = await _shared_hit(key, max_hits, per_seconds)
        except Exception:  # the database is down or not migrated: fall back to this process's count
            log.exception("shared rate limit unavailable; counting in this process")
        else:
            if retry:
                raise _too_many(retry)
            return
    _memory_hit(key, max_hits, per_seconds)


def _memory_hit(key: str, max_hits: int, per_seconds: int) -> None:
    now = time.monotonic()
    global _calls
    with _lock:
        _calls += 1
        if _calls % 1000 == 0:  # forget clients that have gone quiet, so memory stays bounded
            _sweep(now)
        q = _hits[key]
        while q and q[0] <= now - per_seconds:
            q.popleft()
        if len(q) >= max_hits:
            raise _too_many(int(per_seconds - (now - q[0])) + 1)
        q.append(now)


def reset() -> None:
    """Tests only."""
    with _lock:
        _hits.clear()
