"""Issues renewal invoices on time: every hour (BILLING_INTERVAL_SECONDS) the API runs
private.billing_run() as the erp_billing role. Safe to run any number of times, in any number of
processes: an invoice is issued once per school and period (the database refuses a second)."""

import asyncio
import contextlib
import logging

from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import billing_session

log = logging.getLogger("billing")


async def run_once() -> int:
    async with billing_session() as db:
        n = await db.scalar(text("select private.billing_run()"))
        await db.commit()
        return int(n or 0)


async def run_forever(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            n = await run_once()
            if n:
                log.info("billing run: %s invoice(s) issued", n)
        except Exception:  # never let one failed run stop renewals
            log.exception("billing run failed")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=get_settings().billing_interval_seconds)
