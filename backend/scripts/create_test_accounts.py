"""Create the accounts used by the end-to-end tests (frontend/e2e).

    cd backend && python -m scripts.create_test_accounts

Creates three schools (E2E-A, E2E-B, and E2E-C for the subscription-billing tests) and
the users: a super admin, one user per school role in School A, and an admin of Schools
B and C. It's safe to re-run: existing accounts get their password reset, memberships are
re-applied, and the test schools' subscriptions and billing records are cleared.

Writes frontend/.env.e2e with the emails, shared password and school ids.
Refuses to run when APP_ENV=production. Use a separate Supabase project for testing.
"""

import argparse
import asyncio
import secrets
import sys
import uuid
from datetime import date
from pathlib import Path

import asyncpg
import httpx

from app.core.config import get_settings

ACCOUNTS = [
    # key,          full name,             school, role ("super" = platform admin)
    ("SUPER", "E2E Super Admin", None, "super"),
    ("ADMIN_A", "E2E Admin A", "A", "school_admin"),
    ("ACCOUNTANT_A", "E2E Accountant A", "A", "accountant"),
    ("TEACHER_A", "E2E Teacher A", "A", "teacher"),
    ("PARENT_A", "E2E Parent A", "A", "parent"),
    ("STUDENT_A", "E2E Student A", "A", "student"),
    ("LIBRARIAN_A", "E2E Librarian A", "A", "librarian"),
    ("ADMIN_B", "E2E Admin B", "B", "school_admin"),
    ("ADMIN_C", "E2E Admin C", "C", "school_admin"),
]
SCHOOLS = {
    "A": ("E2E Test School A", "E2E-A"),
    "B": ("E2E Test School B", "E2E-B"),
    "C": ("E2E Billing School C", "E2E-C"),
}
# subscription billing records of test schools (cleared on every run; they restrict deleting a school)
BILLING_TABLES = (
    "billing_orders",
    "subscription_payments",
    "subscription_invoices",
    "school_subscription_events",
    "school_subscriptions",
)


async def upsert_auth_user(
    client: httpx.AsyncClient, base: str, db: asyncpg.Connection, email: str, password: str, name: str
) -> uuid.UUID:
    res = await client.post(
        f"{base}/admin/users",
        json={
            "email": email,
            "password": password,
            "email_confirm": True,
            "user_metadata": {"full_name": name},
        },
    )
    if res.status_code in (200, 201):
        return uuid.UUID(res.json()["id"])
    if res.status_code in (400, 409, 422) and ("already" in res.text.lower() or "exists" in res.text.lower()):
        user_id = await db.fetchval("select id from public.profiles where lower(email) = lower($1)", email)
        if user_id is None:
            sys.exit(f"{email} exists in Auth but has no profile row. Is migration 0001 applied?")
        upd = await client.put(f"{base}/admin/users/{user_id}", json={"password": password})
        upd.raise_for_status()
        return user_id
    sys.exit(f"Could not create {email}: {res.status_code} {res.text}")


async def main(domain: str, password: str) -> None:
    s = get_settings()
    if s.is_production:
        sys.exit("Refusing to create test accounts with APP_ENV=production.")
    if not s.supabase_service_role_key:
        sys.exit("SUPABASE_SERVICE_ROLE_KEY is required (backend/.env).")

    dsn = s.database_url.replace("postgresql+asyncpg://", "postgresql://")
    db = await asyncpg.connect(dsn, ssl="require" if s.database_ssl else None, statement_cache_size=0)
    headers = {"apikey": s.supabase_service_role_key, "Authorization": f"Bearer {s.supabase_service_role_key}"}
    env: dict[str, str] = {"E2E_PASSWORD": password}

    try:
        async with httpx.AsyncClient(headers=headers, timeout=20) as client:
            # Subscriptions and billing records of the test schools start empty on every run, and
            # plans made by earlier runs (codes E2E-...) go once nothing uses them.
            test_schools = "select id from public.schools where code like 'E2E-%'"
            for table in BILLING_TABLES:
                await db.execute(f"delete from public.{table} where school_id in ({test_schools})")
            await db.execute(
                "delete from public.subscription_plans p where p.code like 'E2E-%' and not exists "
                "(select 1 from public.school_subscriptions s where s.plan_id = p.id) and not exists "
                "(select 1 from public.subscription_invoices i where i.plan_id = p.id)"
            )
            # Schools created by previous e2e runs (codes E2E-T...) are cleaned up.
            await db.execute("delete from public.schools where code like 'E2E-T%'")
            school_ids: dict[str, uuid.UUID] = {}
            for key, (name, code) in SCHOOLS.items():
                school_ids[key] = await db.fetchval(
                    """insert into public.schools (name, code) values ($1, $2)
                       on conflict (code) do update set name = excluded.name, status = 'active'
                       returning id""",
                    name,
                    code,
                )
                env[f"E2E_SCHOOL_{key}_ID"] = str(school_ids[key])

            # Sessions: A has a past year holding a section (so it can't be deleted)
            # and a current year; B has a current year.
            async def session(school: str, name: str, start: str, end: str, current: bool) -> uuid.UUID:
                return await db.fetchval(
                    """insert into public.academic_sessions (school_id, name, start_date, end_date, is_current)
                       values ($1, $2, $3, $4, $5)
                       on conflict (school_id, lower(btrim(name)))
                       do update set archived_at = null, is_current = excluded.is_current
                       returning id""",
                    school_ids[school],
                    name,
                    date.fromisoformat(start),
                    date.fromisoformat(end),
                    current,
                )

            await db.execute(
                "update public.academic_sessions set is_current = false where school_id = any($1::uuid[])",
                list(school_ids.values()),
            )
            # Sessions left behind by interrupted e2e runs (far-future years, never used).
            await db.execute(
                "delete from public.academic_sessions where school_id = any($1::uuid[]) and start_date >= '2060-01-01'",
                list(school_ids.values()),
            )
            # Reset the academic structure of the two test schools: e2e runs add
            # classes and sections. Hard delete is fine here (test data only).
            ids = list(school_ids.values())
            # library (loans are history and normally can't be deleted; this is a test school)
            await db.execute("select set_config('library.allow_delete', 'on', false)")
            for table in (
                "public.library_loans",
                "public.library_copies",
                "public.library_book_authors",
                "public.library_books",
                "public.library_authors",
                "public.library_categories",
                "public.library_settings",
            ):
                await db.execute(f"delete from {table} where school_id = any($1::uuid[])", ids)
            await db.execute(
                "delete from private.school_counters where school_id = any($1::uuid[]) and kind like 'library_%'", ids
            )
            # payroll and leave (finalized payrolls and leave history are normally kept; this is a test school)
            await db.execute("select set_config('hr.allow_delete', 'on', false)")
            for table in (
                "public.payroll_runs",
                "public.salary_structures",
                "public.salary_components",
                "public.staff_attendance",
                "public.leave_applications",
                "public.leave_allocations",
                "public.leave_types",
                "public.staff_holidays",
                "public.hr_settings",
            ):
                await db.execute(f"delete from {table} where school_id = any($1::uuid[])", ids)
            await db.execute("select set_config('hr.allow_delete', '', false)")
            # certificates and ID cards (normally kept for the record; this is a test school)
            await db.execute("select set_config('docs.allow_delete', 'on', false)")
            for table in (
                "public.certificates",
                "public.id_cards",
                "public.certificate_templates",
                "public.document_settings",
            ):
                await db.execute(f"delete from {table} where school_id = any($1::uuid[])", ids)
            await db.execute("select set_config('docs.allow_delete', '', false)")
            await db.execute(
                "delete from private.school_counters where school_id = any($1::uuid[]) "
                "and (kind like 'certificate:%' or kind = 'transport_staff_card')",
                ids,
            )
            # inventory (items with stock history are normally kept; this is a test school)
            await db.execute("select set_config('inventory.allow_delete', 'on', false)")
            await db.execute("delete from public.inventory_items where school_id = any($1::uuid[])", ids)
            await db.execute("select set_config('inventory.allow_delete', '', false)")
            # transport (assignments reference students; zones reference fee heads)
            for table in (
                "public.transport_assignments",
                "public.transport_stops",
                "public.transport_routes",
                "public.transport_documents",
                "public.transport_staff",
                "public.transport_vehicles",
                "public.transport_fare_zones",
            ):
                await db.execute(f"delete from {table} where school_id = any($1::uuid[])", ids)
            # notifications (history, in-app items, templates, settings, SMS/WhatsApp accounts)
            for table in (
                "public.notification_deliveries",
                "public.notifications",
                "public.notification_events",
                "public.notification_templates",
                "public.notification_settings",
                "private.messaging_accounts",
            ):
                await db.execute(f"delete from {table} where school_id = any($1::uuid[])", ids)
            await db.execute("delete from public.notices where school_id = any($1::uuid[])", ids)
            # admissions (applications reference students, so they go first)
            for table in ("admission_enquiries", "admission_applications", "admission_windows"):
                await db.execute(f"delete from public.{table} where school_id = any($1::uuid[])", ids)
            await db.execute(
                "delete from private.school_counters where school_id = any($1::uuid[]) "
                "and (kind like 'admission%' or kind = 'enquiry')",
                ids,
            )
            # exams: unpublish first (published marks are locked), then marks, papers, exams, setup
            await db.execute(
                "update public.exams set status = 'scheduled' where school_id = any($1::uuid[]) and "
                "status = 'published'",
                ids,
            )
            for table in ("report_card_remarks", "exam_marks", "exam_papers", "exams", "exam_types", "grade_bands"):
                await db.execute(f"delete from public.{table} where school_id = any($1::uuid[])", ids)
            # report card templates (the default can't be deleted while it is the default)
            await db.execute(
                "update public.report_card_templates set is_default = false where school_id = any($1::uuid[])", ids
            )
            await db.execute("delete from public.report_card_templates where school_id = any($1::uuid[])", ids)
            # homework: submissions first (their files go with them), then the homework itself
            for table in ("homework_submissions", "homework"):
                await db.execute(f"delete from public.{table} where school_id = any($1::uuid[])", ids)
            for table in ("timetable_entries", "timetable_periods", "subjects"):
                await db.execute(f"delete from public.{table} where school_id = any($1::uuid[])", ids)
            await db.execute("delete from public.teachers where school_id = any($1::uuid[])", ids)
            await db.execute("delete from public.attendance_records where school_id = any($1::uuid[])", ids)
            # online payments (Phase 21) reference receipts, so they go first; the gateway account too
            for table in ("payment_webhook_events", "online_payment_refunds", "online_payments"):
                await db.execute(f"delete from public.{table} where school_id = any($1::uuid[])", ids)
            await db.execute("delete from private.payment_gateway_accounts where school_id = any($1::uuid[])", ids)
            for table in ("fee_payment_allocations", "fee_payments", "student_fee_dues", "student_fee_optins"):
                await db.execute(f"delete from public.{table} where school_id = any($1::uuid[])", ids)
            await db.execute(
                "delete from private.school_counters where school_id = any($1::uuid[]) and kind like 'receipt:%'", ids
            )
            # (the transport fee structure is normally kept by Transport → Fare zones only)
            await db.execute("select set_config('erp.transport_sync', 'on', false)")
            await db.execute("delete from public.fee_structures where school_id = any($1::uuid[])", ids)
            await db.execute("select set_config('erp.transport_sync', '', false)")
            await db.execute("delete from public.fee_heads where school_id = any($1::uuid[])", ids)
            await db.execute("delete from public.student_enrollments where school_id = any($1::uuid[])", ids)
            await db.execute("delete from public.students where school_id = any($1::uuid[])", ids)
            await db.execute(
                "delete from private.school_counters where school_id = any($1::uuid[]) and kind = 'student'", ids
            )
            await db.execute("delete from public.sections where school_id = any($1::uuid[])", ids)
            await db.execute(
                "delete from public.classes where school_id = any($1::uuid[]) and lower(name) <> 'class 1'", ids
            )
            await db.execute(
                """update public.classes set deleted_at = null, deleted_by = null, is_active = true, display_order = 4
                   where school_id = any($1::uuid[])""",
                ids,
            )
            # sessions other than the two seeded years (created by tests) are removed
            await db.execute(
                """delete from public.academic_sessions where school_id = any($1::uuid[])
                   and name not in ('2025-26', '2026-27')""",
                ids,
            )
            past_a = await session("A", "2025-26", "2025-04-01", "2026-03-31", False)
            await session("A", "2026-27", "2026-04-01", "2027-03-31", True)
            await session("B", "2026-27", "2026-04-01", "2027-03-31", True)
            await session("C", "2026-27", "2026-04-01", "2027-03-31", True)
            class_id = await db.fetchval(
                """insert into public.classes (school_id, name, display_order) values ($1, 'Class 1', 4)
                   on conflict (school_id, lower(btrim(name))) where deleted_at is null
                   do update set is_active = true returning id""",
                school_ids["A"],
            )
            await db.execute(
                """insert into public.sections (school_id, class_id, academic_session_id, name) values ($1, $2, $3, 'A')
                   on conflict (academic_session_id, class_id, lower(btrim(name))) where deleted_at is null
                   do nothing""",
                school_ids["A"],
                class_id,
                past_a,
            )

            for key, name, school, role in ACCOUNTS:
                email = f"e2e-{key.lower().replace('_', '-')}@{domain}"
                user_id = await upsert_auth_user(client, s.supabase_issuer, db, email, password, name)
                await db.execute(
                    "update public.profiles set full_name = $2, phone = null, is_super_admin = $3 where id = $1",
                    user_id,
                    name,
                    role == "super",
                )
                await db.execute("delete from public.notification_preferences where user_id = $1", user_id)
                await db.execute("delete from public.push_subscriptions where user_id = $1", user_id)
                # each test account has exactly its one role: drop any it picked up during
                # earlier runs (e.g. a teacher linked as a parent)
                await db.execute(
                    "delete from public.school_memberships where user_id = $1 and school_id = any($2::uuid[])"
                    " and not (school_id is not distinct from $3 and role::text = $4)",
                    user_id,
                    list(school_ids.values()),
                    school_ids.get(school) if school else None,
                    role,
                )
                if school:
                    await db.execute(
                        """insert into public.school_memberships (school_id, user_id, role) values ($1, $2, $3)
                           on conflict (school_id, user_id, role) do update set status = 'active'""",
                        school_ids[school],
                        user_id,
                        role,
                    )
                if role == "teacher" and school:
                    # a staff record linked to the login; tests assign the classes they need
                    await db.execute(
                        """insert into public.teachers (school_id, employee_id, full_name, phone, email, joining_date,
                                                        subject, account_id)
                           values ($1, $2, $3, '9800099999', $4, date '2022-04-01', 'Mathematics', $5)""",
                        school_ids[school],
                        f"EMP-E2E-{school}",
                        name,
                        email,
                        user_id,
                    )
                env[f"E2E_{key}_EMAIL"] = email
                print(f"  {role:<13} {email}")
    finally:
        await db.close()

    out = Path(__file__).resolve().parents[2] / "frontend" / ".env.e2e"
    out.write_text("".join(f"{k}={v}\n" for k, v in env.items()))
    print(f"\nWrote {out} (git-ignored). Run the tests with: cd frontend && npm run test:e2e")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--domain", default="example.com", help="email domain for test accounts")
    parser.add_argument("--password", default=None, help="shared password (random if omitted)")
    args = parser.parse_args()
    asyncio.run(main(args.domain, args.password or f"E2e-{secrets.token_urlsafe(12)}"))
