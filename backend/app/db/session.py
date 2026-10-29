"""Database sessions.

Every request runs in a session whose transactions execute as the Postgres
`authenticated` role with the caller's JWT claims set. That means Supabase RLS
policies are enforced for backend queries too — the API layer checks are a
first line of defence, RLS is the second.
"""

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Any

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

# Postgres' JIT compiler is for long analytical queries. The planner over-estimates the rows of some of
# our functions (generate_series, unnest) and then spends ~35 ms compiling a query that runs in 1 ms —
# on every call. Off for every transaction the API runs (SET LOCAL: safe behind a transaction pooler).
NO_JIT = "set_config('jit', 'off', true)"

CLAIM_KEYS = ("sub", "role", "email", "aud", "iss", "exp", "app_metadata", "session_id")


def _apply_client(connection, client: dict[str, str | None] | None) -> None:  # type: ignore[no-untyped-def]
    """The caller's IP and browser, for the audit log written by database triggers (migration 0032)."""
    if client:
        connection.execute(
            text("select set_config('app.client_ip', :ip, true), set_config('app.user_agent', :ua, true)"),
            {"ip": (client.get("ip") or "")[:64], "ua": (client.get("ua") or "")[:500]},
        )


@lru_cache
def get_engine() -> AsyncEngine:
    s = get_settings()
    connect_args: dict[str, Any] = {
        # Required behind Supabase's pooler (no server-side prepared statements).
        "statement_cache_size": 0,
    }
    if s.database_ssl:
        connect_args["ssl"] = "require"
    return create_async_engine(
        s.database_url,
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        connect_args=connect_args,
    )


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(), expire_on_commit=False, autoflush=False)


@asynccontextmanager
async def rls_session(
    claims: dict[str, Any], client: dict[str, str | None] | None = None
) -> AsyncIterator[AsyncSession]:
    session = get_sessionmaker()()
    claims_json = json.dumps({k: claims[k] for k in CLAIM_KEYS if k in claims}, default=str)

    # Re-applied at the start of EVERY transaction (including after commit),
    # so no query on this session can ever run without RLS.
    @event.listens_for(session.sync_session, "after_begin")
    def _apply_rls(_sess, _trans, connection):  # type: ignore[no-untyped-def]
        connection.execute(text("select set_config('request.jwt.claims', :c, true), " + NO_JIT), {"c": claims_json})
        connection.execute(text("set local role authenticated"))
        _apply_client(connection, client)

    try:
        yield session
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


@asynccontextmanager
async def anon_session(client: dict[str, str | None] | None = None) -> AsyncIterator[AsyncSession]:
    """For public pages (no login): runs as Postgres `anon`, which can't read or write any
    table. It may only call the few functions granted to it (the `intake` schema)."""
    session = get_sessionmaker()()

    @event.listens_for(session.sync_session, "after_begin")
    def _apply_anon(_sess, _trans, connection):  # type: ignore[no-untyped-def]
        connection.execute(text("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true), " + NO_JIT))
        connection.execute(text("set local role anon"))
        _apply_client(connection, client)

    try:
        yield session
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


@asynccontextmanager
async def payments_session(client: dict[str, str | None] | None = None) -> AsyncIterator[AsyncSession]:
    """For gateway work done AFTER the API has verified a payment with Razorpay (checkout
    verification, webhooks, reconciliation, refunds). Runs as the Postgres role
    `erp_payments`, which can only execute the private.pay_* functions (migration 0019)."""
    session = get_sessionmaker()()

    @event.listens_for(session.sync_session, "after_begin")
    def _apply_worker(_sess, _trans, connection):  # type: ignore[no-untyped-def]
        connection.execute(text("select set_config('request.jwt.claims', '{}', true), " + NO_JIT))
        connection.execute(text("set local role erp_payments"))
        _apply_client(connection, client)

    try:
        yield session
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


@asynccontextmanager
async def notify_session(client: dict[str, str | None] | None = None) -> AsyncIterator[AsyncSession]:
    """For the notification sender (and delivery-report webhooks). Runs as the Postgres role
    `erp_notify`, which can only execute the private.notify_* functions (migration 0020)."""
    session = get_sessionmaker()()

    @event.listens_for(session.sync_session, "after_begin")
    def _apply_notify(_sess, _trans, connection):  # type: ignore[no-untyped-def]
        connection.execute(text("select set_config('request.jwt.claims', '{}', true), " + NO_JIT))
        connection.execute(text("set local role erp_notify"))
        _apply_client(connection, client)

    try:
        yield session
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


@asynccontextmanager
async def billing_session(client: dict[str, str | None] | None = None) -> AsyncIterator[AsyncSession]:
    """For subscription-billing gateway work done AFTER the API verified it with Razorpay (checkout
    verification, webhooks) and for the renewal run. Runs as the Postgres role `erp_billing`, which
    can only execute the private.billing_* functions (migration 0030)."""
    session = get_sessionmaker()()

    @event.listens_for(session.sync_session, "after_begin")
    def _apply_billing(_sess, _trans, connection):  # type: ignore[no-untyped-def]
        connection.execute(text("select set_config('request.jwt.claims', '{}', true), " + NO_JIT))
        connection.execute(text("set local role erp_billing"))
        _apply_client(connection, client)

    try:
        yield session
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


@asynccontextmanager
async def ratelimit_session() -> AsyncIterator[AsyncSession]:
    """For counting requests against rate limits. Runs as the Postgres role `erp_ratelimit`, which can
    only execute private.rate_hit (migration 0033)."""
    session = get_sessionmaker()()

    @event.listens_for(session.sync_session, "after_begin")
    def _apply_ratelimit(_sess, _trans, connection):  # type: ignore[no-untyped-def]
        connection.execute(text("select set_config('request.jwt.claims', '{}', true), " + NO_JIT))
        connection.execute(text("set local role erp_ratelimit"))

    try:
        yield session
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()
