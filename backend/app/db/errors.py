"""Translate Postgres errors raised by constraints, triggers and RLS into API errors."""

from dataclasses import dataclass

from sqlalchemy.exc import DBAPIError


@dataclass(frozen=True)
class PgError:
    sqlstate: str | None
    constraint: str | None
    message: str


def pg_error(exc: DBAPIError) -> PgError:
    orig = getattr(exc, "orig", None)
    cause = getattr(orig, "__cause__", None) or orig
    sqlstate = getattr(orig, "sqlstate", None) or getattr(cause, "sqlstate", None)
    constraint = getattr(cause, "constraint_name", None)
    message = getattr(cause, "message", None) or str(cause or exc)
    return PgError(sqlstate, constraint, message)


async def http_error_from_db(db, exc: DBAPIError, unique_messages: dict[str, str] | None = None):
    """Roll back and convert a database error into an HTTPException.

    Messages raised by our own guard triggers (no constraint name) are written for
    end users and passed through; raw constraint messages never are.
    """
    from fastapi import HTTPException, status  # local import keeps this module framework-light

    await db.rollback()
    err = pg_error(exc)
    if err.sqlstate == "23505" and err.constraint is None:  # raised by our own functions, written for users
        return HTTPException(status.HTTP_409_CONFLICT, err.message)
    if err.sqlstate == "23505":
        msg = (unique_messages or {}).get(err.constraint or "", "That name is already in use.")
        return HTTPException(status.HTTP_409_CONFLICT, msg)
    if err.sqlstate in ("23001", "23514") and err.constraint is None:
        return HTTPException(status.HTTP_409_CONFLICT, err.message)
    if err.sqlstate in ("23514", "23502", "22001"):
        return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "One of the values isn't valid.")
    if err.sqlstate == "23503":
        return HTTPException(status.HTTP_404_NOT_FOUND, "A related record wasn't found in this school.")
    if err.sqlstate == "42501":
        # our own functions explain themselves ("Only school admins can waive a fine."); Postgres's
        # own permission and RLS messages are technical, so they get the plain sentence
        own = err.message and not err.message.startswith(("permission denied", "new row violates", "Not allowed"))
        return HTTPException(status.HTTP_403_FORBIDDEN, err.message if own else "Your role doesn't allow this action.")
    if err.sqlstate == "P0002":
        return HTTPException(status.HTTP_404_NOT_FOUND, err.message)
    raise exc
