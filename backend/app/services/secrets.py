"""Encryption for secrets kept in the database (payment gateway keys).

The key, SECRETS_KEY (or PAYMENT_SECRETS_KEY), lives only in the API's environment. The database
stores ciphertext, so a database dump or a leaked query result reveals nothing.
Generate a key with:  python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings


class SecretsUnavailable(RuntimeError):
    """The server has no (valid) SECRETS_KEY."""


def _fernet() -> Fernet:
    key = get_settings().payment_secrets_key
    if not key:
        raise SecretsUnavailable("Third-party accounts can't be used: SECRETS_KEY is missing on the server.")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError):
        raise SecretsUnavailable("SECRETS_KEY is not a valid key.") from None


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        raise SecretsUnavailable(
            "A stored secret can't be read with the current SECRETS_KEY. Enter the secrets again."
        ) from None
