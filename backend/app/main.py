import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.db.errors import pg_error

log = logging.getLogger("api")

# Database errors a route didn't translate itself.
_DB_STATUS: tuple[tuple[str, int, str], ...] = (
    ("22", 422, "One of the values isn't valid."),
    ("23503", 404, "A related record wasn't found in this school."),
    ("23505", 409, "That already exists."),
    ("23", 422, "One of the values isn't valid."),
    ("42501", 403, "Your role doesn't allow this action."),
    ("P0002", 404, "Not found."),
    (
        "40001",
        409,
        "Someone else changed this at the same moment. Please try again.",
    ),
    (
        "40P01",
        409,
        "Someone else changed this at the same moment. Please try again.",
    ),
    (
        "57014",
        503,
        "That took too long. Please try again, or narrow it down.",
    ),
)


async def _db_error(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, DBAPIError)
    err = pg_error(exc)
    state = err.sqlstate or ""

    for prefix, code, message in _DB_STATUS:
        if state.startswith(prefix):
            log.info(
                "database refused %s %s: %s %s",
                request.method,
                request.url.path,
                state,
                err.message[:200],
            )
            return JSONResponse({"detail": message}, status_code=code)

    log.error(
        "database error on %s %s",
        request.method,
        request.url.path,
        exc_info=exc,
    )
    return JSONResponse(
        {"detail": "Something went wrong on our side. Please try again."},
        status_code=500,
    )


@contextlib.asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Starts the notification sender and billing renewal worker."""
    from app.services.billing_worker import run_forever as billing_forever
    from app.services.notify.sender import run_forever

    stop = asyncio.Event()
    tasks = []

    if get_settings().notify_worker:
        tasks.append(asyncio.create_task(run_forever(stop)))

    if get_settings().billing_worker:
        tasks.append(asyncio.create_task(billing_forever(stop)))

    try:
        yield
    finally:
        stop.set()
        for task in tasks:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(task, timeout=10)


MB = 1024 * 1024

# Routes that legitimately accept several files in one request.
LARGER_BODIES = (
    ("/api/v1/public/admissions/", 95 * MB),
    ("/api/v1/homework", 60 * MB),
)


class BodyTooLarge(Exception):
    pass


class BodySizeLimit:
    """Reject oversized bodies before a route reads them."""

    def __init__(self, app, default_bytes: int) -> None:
        self.app = app
        self.default = default_bytes

    def limit_for(self, path: str) -> int:
        return next(
            (n for prefix, n in LARGER_BODIES if path.startswith(prefix)),
            self.default,
        )

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        limit = self.limit_for(scope.get("path", ""))
        declared = dict(scope.get("headers") or []).get(b"content-length")

        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            await self._refuse(send, limit)
            return

        received = 0
        started = False
        exceeded = False

        async def counting_receive():
            nonlocal received, exceeded
            message = await receive()

            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise BodyTooLarge

            return message

        async def guarded_send(message):
            nonlocal started

            if exceeded:
                if message["type"] == "http.response.start" and not started:
                    started = True
                    await self._refuse(send, limit)
                return

            if message["type"] == "http.response.start":
                started = True

            await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        except BodyTooLarge:
            if not started:
                await self._refuse(send, limit)

    @staticmethod
    async def _refuse(send, limit: int) -> None:
        body = json.dumps({"detail": (f"The request is too large (the limit is {limit // MB} MB).")}).encode()

        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": body,
            }
        )


def create_app() -> FastAPI:
    s = get_settings()
    problems = s.production_problems()

    if problems:
        raise RuntimeError("Unsafe settings for a deployment (APP_ENV=" + s.app_env + "):\n- " + "\n- ".join(problems))

    app = FastAPI(
        lifespan=lifespan,
        title="School ERP API",
        version="0.1.0",
        docs_url="/docs" if s.is_development else None,
        redoc_url=None,
        openapi_url="/openapi.json" if s.is_development else None,
    )

    # Reject oversized request bodies.
    app.add_middleware(
        BodySizeLimit,
        default_bytes=s.max_request_mb * MB,
    )

    # CORS configuration.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=s.cors_origin_list,
        allow_credentials=False,
        allow_methods=[
            "GET",
            "POST",
            "PATCH",
            "PUT",
            "DELETE",
            "OPTIONS",
        ],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-School-Id",
        ],
        expose_headers=["Content-Disposition"],
    )

    @app.middleware("http")
    async def security_headers(
        request: Request,
        call_next,
    ):
        response = await call_next(request)

        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"

        # API responses are data, not executable pages.
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'none'; frame-ancestors 'none'",
        )

        # Prevent school records from being stored by browsers or caches.
        response.headers.setdefault("Cache-Control", "no-store")

        if not s.is_development:
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"

        return response

    app.add_exception_handler(DBAPIError, _db_error)
    app.include_router(api_router, prefix="/api/v1")

    return app


app = create_app()
