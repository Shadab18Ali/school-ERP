from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    cors_origins: str = "http://localhost:3000"
    frontend_url: str = "http://localhost:3000"

    database_url: str
    database_ssl: bool = True

    supabase_url: str
    supabase_service_role_key: str = ""
    supabase_jwt_secret: str = ""

    # Public admission pages (no login): requests per client IP
    admission_submits_per_hour: int = 10
    admission_lookups_per_10min: int = 30
    # How many reverse proxies in front of the API add X-Forwarded-For (0 = none: use the socket address)
    trusted_proxy_hops: int = 0
    # Refuse a token whose Supabase sign-in session has ended (signed out, ended by an admin), instead of
    # trusting it until it expires. One indexed lookup per request.
    session_check: bool = True
    # Largest request body, in MB (uploads are checked again per file). Bigger for the public admission
    # form (a photo and up to 8 documents) and homework (up to 5 files).
    max_request_mb: int = 12
    # Where request counts for rate limits are kept: "database" (shared by every API process and
    # server — use this whenever you run more than one), "memory" (per process), or "auto" (memory in
    # development, database in a deployment).
    rate_limit_backend: str = "auto"

    # Online payments (Razorpay). Each school enters its own keys in School settings; they are
    # stored encrypted with this key, which never leaves the API's environment.
    # Encrypts every third-party secret a school enters (Razorpay, Twilio, WhatsApp).
    # SECRETS_KEY is the name to use; PAYMENT_SECRETS_KEY (Phase 21) still works.
    payment_secrets_key: str = Field(default="", validation_alias=AliasChoices("SECRETS_KEY", "PAYMENT_SECRETS_KEY"))
    razorpay_api_base: str = "https://api.razorpay.com/v1"

    # Notifications. The API's public URL is needed for delivery-report webhooks.
    public_api_url: str = "http://localhost:8000"
    notify_worker: bool = True  # run the sender inside the API process (or run scripts.notify_worker separately)
    notify_interval_seconds: float = 5
    # Email (SMTP; any provider: Amazon SES, SendGrid, Zoho, Google Workspace...). Empty host = email off.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_security: str = "starttls"  # starttls | ssl | none
    email_from: str = ""  # e.g. notifications@yourdomain.in (must be allowed by your SMTP provider)
    twilio_api_base: str = "https://api.twilio.com"
    whatsapp_api_base: str = "https://graph.facebook.com"
    whatsapp_api_version: str = "v21.0"
    # Web Push (notifications on phones and browsers). One VAPID key pair for the platform, made with
    # `python -m scripts.generate_vapid_keys`. The private key stays here; empty = push off.
    vapid_public_key: str = ""
    vapid_private_key: str = ""
    vapid_subject: str = ""  # mailto:you@yourdomain.in or https://yourdomain.in (push services contact it if needed)
    # Push services we send to (comma-separated; "*.x" = any sub-domain). Empty = the browsers' own services.
    push_allowed_hosts: str = ""

    # Subscription billing: the PLATFORM's own Razorpay account (schools pay their subscription with it).
    # Keys stay here; empty = schools pay by bank transfer etc. and the super admin records it.
    platform_razorpay_key_id: str = ""
    platform_razorpay_key_secret: str = ""
    platform_razorpay_webhook_secret: str = ""
    billing_worker: bool = True  # issue renewal invoices inside the API process
    billing_interval_seconds: float = 3600

    @property
    def rate_limit_shared(self) -> bool:
        b = self.rate_limit_backend.lower()
        return b == "database" or (b == "auto" and not self.is_development)

    @property
    def platform_payments_enabled(self) -> bool:
        return bool(self.platform_razorpay_key_id and self.platform_razorpay_key_secret)

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"

    @property
    def is_development(self) -> bool:
        """Only an explicit development/test setting turns on the API docs; anything else (including a
        missing or misspelt APP_ENV) is treated as a real deployment."""
        return self.app_env.lower() in ("development", "dev", "local", "test")

    def production_problems(self) -> list[str]:
        """Settings that are unsafe outside development. The API refuses to start with any of them."""
        if self.is_development:
            return []
        out: list[str] = []
        for o in self.cors_origin_list:
            if o == "*" or not o.startswith("https://"):
                out.append(f"CORS_ORIGINS must list only https:// origins (found {o!r}).")
        if not self.supabase_url.startswith("https://"):
            out.append("SUPABASE_URL must be https://.")
        if not self.frontend_url.startswith("https://"):
            out.append("FRONTEND_URL must be https://.")
        if self.supabase_jwt_secret and len(self.supabase_jwt_secret) < 32:
            out.append("SUPABASE_JWT_SECRET is too short.")
        if not self.payment_secrets_key:
            out.append("SECRETS_KEY is required (it encrypts every school's gateway and messaging secrets).")
        elif not _fernet_key_ok(self.payment_secrets_key):
            out.append("SECRETS_KEY must be a Fernet key (see .env.example for how to make one).")
        if not self.database_ssl and not _local_db(self.database_url):
            out.append("DATABASE_SSL must be true for a database that isn't on this machine.")
        if not self.supabase_service_role_key:
            out.append("SUPABASE_SERVICE_ROLE_KEY is required (file storage and creating sign-ins).")
        if self.rate_limit_backend.lower() not in ("auto", "memory", "database"):
            out.append("RATE_LIMIT_BACKEND must be auto, memory or database.")
        if bool(self.vapid_public_key) != bool(self.vapid_private_key) or (
            self.vapid_public_key and not self.vapid_subject
        ):
            out.append("Push needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together (or none of them).")
        if self.platform_razorpay_key_id and not self.platform_razorpay_webhook_secret:
            out.append("PLATFORM_RAZORPAY_WEBHOOK_SECRET is required when platform payments are on.")
        return out

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def supabase_issuer(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1"


def _fernet_key_ok(key: str) -> bool:
    from cryptography.fernet import Fernet

    try:
        Fernet(key.encode())
    except (ValueError, TypeError):
        return False
    return True


def _local_db(url: str) -> bool:
    from urllib.parse import urlsplit

    try:
        host = urlsplit(url.replace("+asyncpg", "")).hostname or ""
    except ValueError:
        return False
    return host in ("localhost", "127.0.0.1", "::1")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
