"""Public verification of certificates and ID cards (the page their QR code opens).

No login. Runs as the Postgres `anon` role, which can only call
intake.verify_document: it returns just enough to confirm a document is genuine
(type, number, name, class or post, dates, school, and whether it is still valid) —
never the certificate's wording, a date of birth, an address or a phone number.
The token is 32 random hex characters, so documents can't be guessed or listed.
"""

import json
import re

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import text

from app.core.ratelimit import limit
from app.db.session import anon_session

router = APIRouter(prefix="/public/verify", tags=["public-verify"])
TOKEN = re.compile(r"^[0-9a-f]{32}$")
NOT_FOUND = "No certificate or ID card matches this code. It may have been mistyped, or it isn't genuine."


@router.get("/{token}")
async def verify(token: str, request: Request) -> dict:
    await limit(request, "document-verify", 60, 600)
    token = token.strip().lower()
    if not TOKEN.match(token):
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    async with anon_session() as db:
        data = (await db.execute(text("select intake.verify_document(:t)"), {"t": token})).scalar()
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, NOT_FOUND)
    return json.loads(data) if isinstance(data, str) else data
