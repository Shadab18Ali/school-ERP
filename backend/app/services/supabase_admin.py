"""Server-only calls to the Supabase Auth admin API (uses the service-role key)."""

import uuid

import httpx

from app.core.config import get_settings


class SupabaseAdminError(Exception):
    pass


async def invite_user(email: str, full_name: str) -> uuid.UUID | None:
    """Send an invite email.

    Returns the new user's ID, or None if an account with this email
    already exists.
    """
    s = get_settings()

    if not s.supabase_service_role_key:
        raise SupabaseAdminError("SUPABASE_SERVICE_ROLE_KEY is not configured on the server.")

    url = f"{s.supabase_issuer}/invite"

    headers = {
        "apikey": s.supabase_service_role_key,
        "Authorization": f"Bearer {s.supabase_service_role_key}",
    }

    params = {"redirect_to": f"{s.frontend_url.rstrip('/')}/auth/set-password"}

    payload = {
        "email": email,
        "data": {"full_name": full_name},
    }

    async with httpx.AsyncClient(timeout=15) as client:
        try:
            res = await client.post(
                url,
                headers=headers,
                params=params,
                json=payload,
            )
        except httpx.HTTPError as exc:
            raise SupabaseAdminError("Could not reach Supabase Auth.") from exc

    # Invitation succeeded.
    if res.status_code in (200, 201):
        try:
            return uuid.UUID(res.json()["id"])
        except (ValueError, KeyError, TypeError) as exc:
            raise SupabaseAdminError("Supabase accepted the invitation but returned an invalid user ID.") from exc

    # Handle an email address that already has an account.
    body = res.text.lower()

    if res.status_code in (400, 422) and ("already" in body or "email_exists" in body):
        return None

    # Extract a useful error without logging request headers or API keys.
    try:
        data = res.json()

        if isinstance(data, dict):
            detail = (
                data.get("msg")
                or data.get("message")
                or data.get("error_description")
                or data.get("error")
                or "No detailed error returned"
            )
        else:
            detail = "Supabase returned an unexpected error response"

    except (ValueError, AttributeError):
        detail = "Supabase returned an unreadable error response"

    raise SupabaseAdminError(f"Supabase Auth rejected the invite ({res.status_code}): {str(detail)[:300]}")
