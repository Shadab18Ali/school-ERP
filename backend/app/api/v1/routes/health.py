"""Liveness and readiness for the host's health checks and load balancer.

/health: the process is up (it does not touch the database, so a slow database doesn't get every
API container restarted). /health/ready: the database answers and has this release's migrations,
so traffic can be sent here. Neither says anything about schools or data.
"""

import asyncio

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from app.db.session import get_engine

router = APIRouter(tags=["health"])

# an object created by the newest migration this API needs (0033_production_hardening.sql)
SCHEMA_MARKER = "private.rate_hit(text,integer,integer)"


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
async def ready(response: Response) -> dict[str, str]:
    try:
        async with asyncio.timeout(3):
            async with get_engine().connect() as conn:
                migrated = await conn.scalar(text("select to_regprocedure(:m) is not null"), {"m": SCHEMA_MARKER})
    except Exception:  # unreachable, timed out, refused credentials...
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable", "database": "unreachable"}
    if not migrated:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable", "database": "migrations missing"}
    return {"status": "ok", "database": "ok"}
