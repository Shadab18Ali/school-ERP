"""A stand-in for a browser push service (FCM / Mozilla / Apple), for test environments only.

    uvicorn tests.e2e_support.mock_push:app --port 9996

It plays both sides a real phone would: POST /new-subscription creates a "device" with real
P-256 keys and returns what a browser's pushManager.subscribe() returns. When our server pushes
to it, it checks the VAPID signature (RFC 8292) and decrypts the message (RFC 8291) with the
device's private key — so a test sees exactly what the phone would show.
GET /received/{id} lists what arrived; POST /push/{id}/gone makes the device answer 410 Gone.
"""

import base64
import json
import os
import uuid
from typing import Any

import http_ece
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import FastAPI, Request, Response

app = FastAPI(title="Mock push service")
BASE = os.environ.get("MOCK_PUSH_BASE", "http://localhost:9996")
devices: dict[str, dict[str, Any]] = {}


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


@app.post("/new-subscription")
def new_subscription() -> dict:
    key = ec.generate_private_key(ec.SECP256R1())
    auth = os.urandom(16)
    did = uuid.uuid4().hex
    devices[did] = {"key": key, "auth": auth, "received": [], "gone": False}
    pub = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {
        "id": did,
        "endpoint": f"{BASE}/push/{did}",
        "expirationTime": None,
        "keys": {"p256dh": b64(pub), "auth": b64(auth)},
    }


@app.post("/push/{did}")
async def receive(did: str, request: Request) -> Response:
    d = devices.get(did)
    if d is None or d["gone"]:
        return Response(status_code=410)
    body = await request.body()
    entry: dict[str, Any] = {
        "encoding": request.headers.get("content-encoding"),
        "ttl": request.headers.get("ttl"),
        "urgency": request.headers.get("urgency"),
        "vapid_ok": False,
        "payload": None,
    }
    # VAPID: "vapid t=<jwt>, k=<public key>"; the token must be signed by that key, for this origin
    auth = request.headers.get("authorization", "")
    try:
        parts = dict(p.strip().split("=", 1) for p in auth.removeprefix("vapid ").split(","))
        pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), unb64(parts["k"]))
        claims = jwt.decode(parts["t"], pub, algorithms=["ES256"], audience=BASE)
        entry["vapid_ok"] = claims["sub"].startswith(("mailto:", "https://"))
        entry["vapid_key"] = parts["k"]
    except Exception as exc:  # noqa: BLE001
        entry["vapid_error"] = f"{type(exc).__name__}: {exc}"
    if not entry["vapid_ok"]:
        d["received"].append(entry)
        return Response(status_code=403)
    try:
        plain = http_ece.decrypt(body, private_key=d["key"], auth_secret=d["auth"], version="aes128gcm")
        entry["payload"] = json.loads(plain)
    except Exception as exc:  # noqa: BLE001
        entry["decrypt_error"] = f"{type(exc).__name__}: {exc}"
        d["received"].append(entry)
        return Response(status_code=400)
    d["received"].append(entry)
    return Response(status_code=201)


@app.post("/push/{did}/gone")
def gone(did: str) -> dict:
    devices[did]["gone"] = True
    return {"ok": True}


@app.get("/received/{did}")
def received(did: str) -> list[dict]:
    return [{k: v for k, v in e.items()} for e in devices.get(did, {}).get("received", [])]
