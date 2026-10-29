"""Supabase Storage via its REST API, using the service-role key (server only)."""

import logging
import re
from collections.abc import AsyncIterator

import httpx

from app.core.config import get_settings

log = logging.getLogger(__name__)
LOGO_BUCKET = "school-logos"
PHOTO_BUCKET = "student-photos"  # private: only reachable through signed URLs
DOCUMENT_BUCKET = "student-documents"  # private: streamed through the API only, never via URLs
HOMEWORK_BUCKET = "homework-files"  # private: streamed through the API only
STAFF_PHOTO_BUCKET = "staff-photos"  # private: signed URLs only
TRANSPORT_DOC_BUCKET = "transport-documents"  # private: vehicle and driver documents, streamed through the API only
SIGNED_URL_SECONDS = 3600


class StorageError(Exception):
    pass


_SAFE_PATH = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_.-]+)*$")


def _checked(path: str) -> str:
    """Object paths reach storage with the service key, so only plain relative paths are allowed: no
    '..', no leading '/', no '%', '?' or '#' that could change which object (or bucket) is addressed."""
    if not path or len(path) > 400 or ".." in path or not _SAFE_PATH.match(path):
        raise StorageError("That file path isn't valid.")
    return path


def _base() -> tuple[str, dict[str, str]]:
    s = get_settings()
    if not s.supabase_service_role_key:
        raise StorageError("File storage isn't configured on the server.")
    key = s.supabase_service_role_key
    return f"{s.supabase_url.rstrip('/')}/storage/v1", {"apikey": key, "Authorization": f"Bearer {key}"}


def public_url(bucket: str, path: str) -> str:
    return f"{get_settings().supabase_url.rstrip('/')}/storage/v1/object/public/{bucket}/{path}"


async def upload(bucket: str, path: str, data: bytes, content_type: str) -> str:
    base, headers = _base()
    headers |= {"Content-Type": content_type, "x-upsert": "false", "cache-control": "max-age=31536000"}
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            res = await client.post(f"{base}/object/{bucket}/{_checked(path)}", headers=headers, content=data)
        except httpx.HTTPError as exc:
            raise StorageError("Couldn't reach file storage. Try again.") from exc
    if res.status_code not in (200, 201):
        raise StorageError(f"File storage rejected the upload ({res.status_code}).")
    return public_url(bucket, path)


async def delete(bucket: str, path: str) -> None:
    """Best effort: a leftover file is harmless, a failed request must not break the caller."""
    try:
        base, headers = _base()
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.delete(f"{base}/object/{bucket}/{_checked(path)}", headers=headers)
        if res.status_code not in (200, 204, 404):
            log.warning("storage delete %s/%s returned %s", bucket, path, res.status_code)
    except Exception:  # noqa: BLE001
        log.warning("storage delete %s/%s failed", bucket, path, exc_info=True)


async def signed_urls(bucket: str, paths: list[str], expires_in: int = SIGNED_URL_SECONDS) -> dict[str, str]:
    """Short-lived links for objects in a private bucket. Missing objects are left out."""
    unique = sorted({p for p in paths if p and _SAFE_PATH.match(p) and ".." not in p})
    if not unique:
        return {}
    try:
        base, headers = _base()
        async with httpx.AsyncClient(timeout=15) as client:
            res = await client.post(
                f"{base}/object/sign/{bucket}", headers=headers, json={"expiresIn": expires_in, "paths": unique}
            )
        if res.status_code != 200:
            log.warning("signing %d paths in %s returned %s", len(unique), bucket, res.status_code)
            return {}
        root = get_settings().supabase_url.rstrip("/") + "/storage/v1"
        return {
            item["path"]: root + item["signedURL"]
            for item in res.json()
            if item.get("signedURL") and not item.get("error")
        }
    except Exception:  # noqa: BLE001 - photos are optional; never fail the request over them
        log.warning("signing paths in %s failed", bucket, exc_info=True)
        return {}


async def open_stream(bucket: str, path: str, chunk_size: int = 64 * 1024) -> AsyncIterator[bytes]:
    """Authenticated download from a private bucket, as an async byte stream.

    The connection is opened before returning, so a missing file raises
    StorageError here (and becomes a clean HTTP error) rather than mid-stream.
    """
    _checked(path)
    base, headers = _base()
    client = httpx.AsyncClient(timeout=60)
    try:
        res = await client.send(
            client.build_request("GET", f"{base}/object/{bucket}/{path}", headers=headers), stream=True
        )
    except httpx.HTTPError as exc:
        await client.aclose()
        raise StorageError("Couldn't reach file storage. Try again.") from exc
    if res.status_code != 200:
        await res.aclose()
        await client.aclose()
        raise StorageError(f"The stored file couldn't be read ({res.status_code}).")

    async def body() -> AsyncIterator[bytes]:
        try:
            async for chunk in res.aiter_bytes(chunk_size):
                yield chunk
        finally:
            await res.aclose()
            await client.aclose()

    return body()


REPORT_CARD_BUCKET = "report-card-assets"  # private: principal signatures, read by the server only
DOCUMENT_ASSET_BUCKET = "document-assets"  # private: the signature on certificates and ID cards (server only)


async def download(bucket: str, path: str | None, max_bytes: int = 5 * 1024 * 1024) -> bytes | None:
    """Whole object from a bucket (server-side use, e.g. images in PDFs). None if missing or unreachable."""
    if not path:
        return None
    try:
        body = await open_stream(bucket, path)
    except StorageError:
        return None
    out = bytearray()
    try:
        async for chunk in body:
            out += chunk
            if len(out) > max_bytes:
                return None
    except Exception:  # noqa: BLE001 - an image must never break a report
        log.warning("reading %s/%s failed", bucket, path, exc_info=True)
        return None
    return bytes(out)
