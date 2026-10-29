"""Web Push (the standard behind notifications on Android, iPhone home-screen apps and desktop
browsers): VAPID identification (RFC 8292) and payload encryption (RFC 8291, aes128gcm).

The browser gives us a push-service address and two keys. We encrypt each message for that
browser only — the push service (Google, Mozilla, Apple, Microsoft) relays it without being
able to read it — and sign the request with the platform's VAPID key so the service knows
it comes from us. We only ever send to known push services (PUSH_ALLOWED_HOSTS), so a
crafted "subscription" can't make the server call arbitrary addresses.
"""

import base64
import json
import os
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from urllib.parse import urlsplit

import http_ece
import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app.core.config import get_settings

DEFAULT_ALLOWED_HOSTS = "fcm.googleapis.com,*.push.services.mozilla.com,*.push.apple.com,*.notify.windows.com"
TTL_SECONDS = 24 * 3600  # a phone that is off for a day still gets it; older news isn't worth pushing
MAX_PAYLOAD = 3000  # bytes before encryption (push services accept about 4 KB)


class PushNotConfigured(RuntimeError):
    pass


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


@dataclass(frozen=True)
class Vapid:
    private_key: ec.EllipticCurvePrivateKey
    public_key_b64: str  # what browsers need as applicationServerKey
    subject: str


@lru_cache
def _vapid(private_b64: str, public_b64: str, subject: str) -> Vapid:
    try:
        raw = b64url_decode(private_b64.strip())
        key = ec.derive_private_key(int.from_bytes(raw, "big"), ec.SECP256R1())
        derived = b64url(
            key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        )
    except Exception as exc:  # noqa: BLE001
        raise PushNotConfigured("VAPID_PRIVATE_KEY isn't a valid key.") from exc
    if public_b64 and public_b64.strip().rstrip("=") != derived:
        raise PushNotConfigured("VAPID_PUBLIC_KEY doesn't match VAPID_PRIVATE_KEY.")
    return Vapid(key, derived, subject)


def vapid() -> Vapid:
    s = get_settings()
    if not s.vapid_private_key or not s.vapid_subject:
        raise PushNotConfigured("Push notifications aren't set up on this server.")
    return _vapid(s.vapid_private_key, s.vapid_public_key, s.vapid_subject)


def configured() -> bool:
    try:
        vapid()
        return True
    except PushNotConfigured:
        return False


def generate_keys() -> tuple[str, str]:
    """(private, public) in the base64url form used by Web Push tools."""
    key = ec.generate_private_key(ec.SECP256R1())
    priv = key.private_numbers().private_value.to_bytes(32, "big")
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64url(priv), b64url(pub)


# ------------------------------------------------------------------ where we may send
def _allowed() -> list[tuple[str, str, int | None]]:
    """(scheme, host pattern, port) from PUSH_ALLOWED_HOSTS. A bare host means https on 443;
    "http://localhost:9996" style entries are exact (only for a local test stand-in)."""
    out = []
    for item in (get_settings().push_allowed_hosts or DEFAULT_ALLOWED_HOSTS).split(","):
        item = item.strip().lower()
        if not item:
            continue
        if "://" in item:
            u = urlsplit(item)
            out.append((u.scheme, u.hostname or "", u.port))
        else:
            out.append(("https", item, None))
    return out


def endpoint_allowed(endpoint: str) -> bool:
    try:
        u = urlsplit(endpoint)
        host, port = (u.hostname or "").lower(), u.port
    except ValueError:
        return False
    if not host or u.username or u.password or len(endpoint) > 1000:
        return False
    for scheme, pattern, want_port in _allowed():
        if u.scheme != scheme:
            continue
        if want_port is None and port not in (None, 443):
            continue
        if want_port is not None and port != want_port:
            continue
        if pattern.startswith("*."):
            if host.endswith(pattern[1:]) and host != pattern[2:]:
                return True
        elif host == pattern:
            return True
    return False


def valid_keys(p256dh: str, auth: str) -> bool:
    try:
        pub = b64url_decode(p256dh)
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), pub)
        return len(b64url_decode(auth)) == 16
    except Exception:  # noqa: BLE001
        return False


# ------------------------------------------------------------------ building a request
def vapid_header(endpoint: str, v: Vapid, now: float | None = None) -> str:
    u = urlsplit(endpoint)
    aud = f"{u.scheme}://{u.netloc}"
    token = jwt.encode(
        {"aud": aud, "exp": int((now or time.time()) + 12 * 3600), "sub": v.subject}, v.private_key, algorithm="ES256"
    )
    return f"vapid t={token}, k={v.public_key_b64}"


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    server_key = ec.generate_private_key(ec.SECP256R1())
    return http_ece.encrypt(
        payload, salt=os.urandom(16), private_key=server_key, dh=b64url_decode(p256dh), auth_secret=b64url_decode(auth),
        version="aes128gcm",
    )  # fmt: skip


def message(title: str, body: str, url: str | None, tag: str, school: str | None) -> bytes:
    """What the service worker shows. Trimmed so the encrypted message stays under the size limit."""
    data: dict[str, Any] = {
        "title": title[:200],
        "body": body[:1000],
        "url": url or "/notifications",
        "tag": tag,
        "school": school,
    }
    raw = json.dumps(data, ensure_ascii=False).encode()
    while len(raw) > MAX_PAYLOAD and data["body"]:
        data["body"] = data["body"][: max(0, len(data["body"]) - 200)].rstrip() + "…"
        raw = json.dumps(data, ensure_ascii=False).encode()
    return raw


def outcome(status_code: int) -> str:
    """sent | gone (forget the device) | retry | failed — from the push service's answer."""
    if status_code in (200, 201, 202):
        return "sent"
    if status_code in (404, 410):
        return "gone"
    if status_code == 429 or status_code >= 500:
        return "retry"
    return "failed"  # 400 bad request, 401/403 key mismatch, 413 too large


async def send(
    client: httpx.AsyncClient, endpoint: str, p256dh: str, auth: str, payload: bytes, urgency: str = "normal"
) -> tuple[str, str | None]:
    """Returns (outcome, error)."""
    if not endpoint_allowed(endpoint):
        return "gone", "Not a known push service."
    v = vapid()
    try:
        body = encrypt(payload, p256dh, auth)
    except Exception as exc:  # noqa: BLE001 - broken keys: this device can't be reached
        return "gone", f"Bad device keys: {type(exc).__name__}"
    headers = {
        "Authorization": vapid_header(endpoint, v),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(TTL_SECONDS),
        "Urgency": urgency,
    }
    try:
        res = await client.post(endpoint, content=body, headers=headers)
    except httpx.HTTPError as exc:
        return "retry", f"{type(exc).__name__}"
    result = outcome(res.status_code)
    return result, None if result == "sent" else f"HTTP {res.status_code} {res.text[:150]}".strip()


def client() -> httpx.AsyncClient:
    # no redirects: a push service never redirects, and following one could lead off the allowlist
    return httpx.AsyncClient(timeout=10, follow_redirects=False)
