"""Runs the notification sender on its own (set NOTIFY_WORKER=false for the API processes).

python -m scripts.notify_worker          # keep running
python -m scripts.notify_worker --once   # one round (e.g. from cron)
"""

import argparse
import asyncio
import logging
import signal

from app.services.notify.sender import process_events, run_forever, run_jobs, send_due


async def _main(once: bool) -> None:
    if once:
        await run_jobs()
        print(f"events: {await process_events(200)}, messages: {await send_due(500)}")
        return
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await run_forever(stop)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    p = argparse.ArgumentParser()
    p.add_argument("--once", action="store_true")
    asyncio.run(_main(p.parse_args().once))
