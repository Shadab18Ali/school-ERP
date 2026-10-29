"""Request dependencies: authentication, RLS-scoped DB session, roles, tenant."""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.permissions import Permission, platform_permissions, school_permissions
from app.core.security import get_verifier
from app.db.session import rls_session
from app.models.academic import AcademicSession
from app.models.core import Profile, School, SchoolMembership
from app.services.audit import client_info

bearer = HTTPBearer(auto_error=False)

UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Your session is invalid or has expired. Sign in again.",
    headers={"WWW-Authenticate": "Bearer"},
)


@dataclass(frozen=True)
class MembershipInfo:
    school_id: uuid.UUID
    school_name: str
    school_code: str
    school_status: str
    roles: tuple[str, ...]
    current_session_id: uuid.UUID | None = None
    current_session_name: str | None = None
    # from the school's subscription (worked out in the database, migration 0030):
    access: str = "full"  # "read_only" once it has expired or been cancelled
    features: tuple[str, ...] | None = None  # None = no subscription recorded (no limits)

    @property
    def permissions(self) -> frozenset[Permission]:
        return school_permissions(self.roles)


@dataclass(frozen=True)
class CurrentUser:
    id: uuid.UUID
    email: str
    full_name: str
    is_super_admin: bool
    memberships: tuple[MembershipInfo, ...] = field(default_factory=tuple)
    phone: str | None = None

    def membership_for(self, school_id: uuid.UUID) -> MembershipInfo | None:
        return next((m for m in self.memberships if m.school_id == school_id), None)

    @property
    def platform_permissions(self) -> frozenset[Permission]:
        return platform_permissions(self.is_super_admin)


@dataclass(frozen=True)
class SchoolContext:
    school_id: uuid.UUID
    roles: frozenset[str]
    is_super_admin: bool
    permissions: frozenset[Permission] = frozenset()
    access: str = "full"
    features: tuple[str, ...] | None = None

    def has_feature(self, key: str) -> bool:
        return self.is_super_admin or self.features is None or key in self.features

    def can(self, permission: Permission) -> bool:
        return permission in self.permissions


async def get_claims(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> dict[str, Any]:
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials:
        raise UNAUTHORIZED from None
    try:
        return await run_in_threadpool(get_verifier().verify, creds.credentials)
    except InvalidTokenError:
        raise UNAUTHORIZED from None


SESSION_ENDED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="You have been signed out. Sign in again.",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_db(request: Request, claims: dict[str, Any] = Depends(get_claims)) -> AsyncIterator[AsyncSession]:
    async with rls_session(claims, client_info(request)) as session:
        # A token stays valid until it expires, but its sign-in session may have ended (signed out,
        # or ended by an admin): ask the database, which reads Supabase's own sessions (0032).
        # None = this database can't tell; the token's expiry then applies.
        if (
            get_settings().session_check
            and (await session.scalar(text("select private.session_active(:s)"), {"s": claims.get("session_id")}))
            is False
        ):
            raise SESSION_ENDED
        yield session


async def get_current_user(
    claims: dict[str, Any] = Depends(get_claims),
    db: AsyncSession = Depends(get_db),
) -> CurrentUser:
    try:
        user_id = uuid.UUID(str(claims["sub"]))
    except (KeyError, ValueError):
        raise UNAUTHORIZED from None

    profile = await db.get(Profile, user_id)
    if profile is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "No profile exists for this account.")

    rows = (
        await db.execute(
            select(
                SchoolMembership.school_id,
                SchoolMembership.role,
                School.name,
                School.code,
                School.status,
                AcademicSession.id,
                AcademicSession.name,
                func.private.school_access(School.id),
                func.private.school_features(School.id),
            )
            .join(School, School.id == SchoolMembership.school_id)
            .outerjoin(
                AcademicSession,
                (AcademicSession.school_id == School.id) & AcademicSession.is_current.is_(True),
            )
            .where(SchoolMembership.user_id == user_id, SchoolMembership.status == "active")
            .order_by(School.name)
        )
    ).all()

    grouped: dict[uuid.UUID, dict[str, Any]] = {}
    for school_id, role, name, code, school_status, session_id, session_name, access, features in rows:
        entry = grouped.setdefault(
            school_id,
            {
                "name": name,
                "code": code,
                "status": school_status,
                "roles": [],
                "sid": session_id,
                "sname": session_name,
                "access": access or "full",
                "features": tuple(features) if features is not None else None,
            },
        )
        entry["roles"].append(role)

    memberships = tuple(
        MembershipInfo(
            sid,
            e["name"],
            e["code"],
            e["status"],
            tuple(sorted(e["roles"])),
            e["sid"],
            e["sname"],
            e["access"],
            e["features"],
        )
        for sid, e in grouped.items()
    )
    return CurrentUser(
        profile.id, profile.email, profile.full_name, profile.is_super_admin, memberships, phone=profile.phone
    )


async def require_super_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if Permission.PLATFORM_SCHOOLS_MANAGE not in user.platform_permissions:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only platform administrators can do this.")
    return user


# While a school's subscription has expired or been cancelled it is read-only: its people can still
# see everything, and its admins can still pay and manage the subscription.
READ_ONLY_ALLOWED = ("/api/v1/school/billing",)
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")


async def get_school_context(
    request: Request,
    x_school_id: uuid.UUID | None = Header(default=None, alias="X-School-Id"),
    user: CurrentUser = Depends(get_current_user),
) -> SchoolContext:
    """Resolves the active tenant for school-scoped endpoints."""
    if x_school_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose a school first (X-School-Id header missing).")
    if user.is_super_admin:
        own = user.membership_for(x_school_id)  # a super admin may also be this school's own admin (payroll)
        roles = frozenset(own.roles) if own else frozenset()
        return SchoolContext(x_school_id, roles, True, school_permissions(roles, is_super_admin=True))
    membership = user.membership_for(x_school_id)
    if membership is None or membership.school_status != "active":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You don't have access to this school.")
    if (
        membership.access == "read_only"
        and request.method not in SAFE_METHODS
        and not request.url.path.startswith(READ_ONLY_ALLOWED)
    ):
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            "This school's subscription has ended, so it is read-only. Its administrators can renew it "
            "under Settings → Plan and billing.",
        )
    return SchoolContext(
        x_school_id, frozenset(membership.roles), False, membership.permissions, membership.access, membership.features
    )


FEATURE_LABEL = {
    "reports": "Reports",
    "analytics": "Analytics",
    "whatsapp": "WhatsApp notifications",
    "ai_assistant": "The AI assistant",
    "website_builder": "The website builder",
}


def require_feature(key: str):
    """The school's plan must include this feature (no subscription recorded = everything)."""

    async def _dep(ctx: SchoolContext = Depends(get_school_context)) -> SchoolContext:
        if not ctx.has_feature(key):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                f"{FEATURE_LABEL.get(key, key)} isn't included in your school's plan. "
                "Ask the platform about a plan that includes it.",
            )
        return ctx

    return _dep


def require_school_roles(*roles: str):
    """Usage: ctx: SchoolContext = Depends(require_school_roles("school_admin", "accountant"))"""
    allowed = frozenset(roles)

    async def _dep(ctx: SchoolContext = Depends(get_school_context)) -> SchoolContext:
        if ctx.is_super_admin or ctx.roles & allowed:
            return ctx
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow this action.")

    return _dep


def require_permission(*permissions: Permission):
    """School-scoped guard. Passes if the caller holds ANY of the given permissions
    in the school named by X-School-Id.

    Usage: ctx: SchoolContext = Depends(require_permission(Permission.FEES_COLLECT))
    """
    if not permissions:
        raise ValueError("require_permission needs at least one permission")
    needed = frozenset(permissions)

    async def _dep(ctx: SchoolContext = Depends(get_school_context)) -> SchoolContext:
        if ctx.permissions & needed:
            return ctx
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role doesn't allow this action.")

    return _dep
