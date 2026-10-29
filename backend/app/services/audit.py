import json
import uuid
from typing import Any

from fastapi import Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.ratelimit import client_ip as ratelimit_client_ip


def client_ip(request: Request) -> str | None:
    """The caller's IP. X-Forwarded-For is trusted only through TRUSTED_PROXY_HOPS proxies (the same
    rule as the rate limiter): a client can't put an address of its choosing in the audit log."""
    ip = ratelimit_client_ip(request)
    return None if ip == "unknown" else ip[:64]


def client_info(request: Request) -> dict[str, str | None]:
    """IP and browser, handed to the database so its audit triggers record them too."""
    return {"ip": client_ip(request), "ua": request.headers.get("user-agent", "")[:500]}


async def write_audit(
    db: AsyncSession,
    request: Request,
    *,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    school_id: uuid.UUID | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Writes an audit row in the SAME transaction as the change it records.
    The actor is resolved from the JWT inside Postgres and cannot be spoofed."""
    await db.execute(
        text(
            "select private.write_audit_log(:school_id, :action, :entity_type, :entity_id, "
            "cast(:metadata as jsonb), :ip, :ua)"
        ),
        {
            "school_id": school_id,
            "action": action,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "metadata": json.dumps(metadata or {}, default=str),
            "ip": client_ip(request),
            "ua": request.headers.get("user-agent", "")[:500],
        },
    )
