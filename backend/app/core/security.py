"""Verification of Supabase-issued access tokens.

Supports both current asymmetric signing keys (RS256/ES256 via JWKS) and the
legacy HS256 shared secret, so it works for old and new Supabase projects.
"""

from functools import lru_cache
from typing import Any

import jwt
from jwt import InvalidTokenError, PyJWKClient

from app.core.config import get_settings

ASYMMETRIC_ALGS = {"RS256", "ES256"}


class TokenVerifier:
    def __init__(self, issuer: str, jwt_secret: str = "") -> None:
        self.issuer = issuer
        self.jwt_secret = jwt_secret
        self._jwks = PyJWKClient(f"{issuer}/.well-known/jwks.json", cache_keys=True, lifespan=600)

    def verify(self, token: str) -> dict[str, Any]:
        try:
            alg = jwt.get_unverified_header(token).get("alg")
        except InvalidTokenError:
            raise
        except Exception as exc:  # malformed header
            raise InvalidTokenError("Malformed token") from exc

        if alg == "HS256":
            if not self.jwt_secret:
                raise InvalidTokenError("HS256 tokens are not accepted")
            key: Any = self.jwt_secret
        elif alg in ASYMMETRIC_ALGS:
            try:
                key = self._jwks.get_signing_key_from_jwt(token).key
            except Exception as exc:
                raise InvalidTokenError("Unable to resolve signing key") from exc
        else:
            raise InvalidTokenError("Unsupported token algorithm")

        claims = jwt.decode(
            token,
            key,
            algorithms=[alg],
            audience="authenticated",
            issuer=self.issuer,
            options={"require": ["exp", "sub", "aud", "iss"]},
        )
        if claims.get("role") != "authenticated":
            raise InvalidTokenError("Token is not for an authenticated user")
        return claims


@lru_cache
def get_verifier() -> TokenVerifier:
    s = get_settings()
    return TokenVerifier(s.supabase_issuer, s.supabase_jwt_secret)
