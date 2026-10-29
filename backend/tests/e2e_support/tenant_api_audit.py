"""Tenant isolation audit of the running API with real records (test stack only).

For every school-scoped route whose path names records (/students/{student_id}, /exams/{exam_id}/
papers/{paper_id}...), it takes real records of School A from the database and:

  1. checks that School A's admin can open the GET routes (so the addresses are real);
  2. asks for the same addresses as School B's people (admin, accountant, teacher, parent,
     student — each in their own school): none may succeed, and no answer may contain the
     School A record's id;
  3. sends every changing method (POST/PUT/PATCH/DELETE) on those addresses as School B's
     admin: none may succeed.

Every answer to School B must be a refusal (401/403), "not found" (404) or a refused body (422):
anything else — even a 409 — means the School A record was looked at on School B's behalf.

Usage (with the test stack up and both schools populated):
  python -m tests.e2e_support.tenant_api_audit postgresql://supa:supa@localhost:5432/supa_t people.txt
where people.txt lists School B's teacher, parent, student and accountant emails (one per line).
"""

import asyncio
import sys
import typing
import uuid
from collections import Counter
from pathlib import Path

import asyncpg
import httpx

from tests.test_tenancy import ROUTES

API = "http://localhost:8000/api/v1"
AUTH = "http://localhost:9999/auth/v1"
ENV_FILE = Path(__file__).resolve().parents[3] / "frontend" / ".env.e2e"  # written by scripts/create_test_accounts.py
ENV = dict(line.strip().split("=", 1) for line in ENV_FILE.read_text().splitlines() if "=" in line)
A, B = ENV["E2E_SCHOOL_A_ID"], ENV["E2E_SCHOOL_B_ID"]
REFUSED = {401, 403, 404, 422}

# path parameter → table (where the name alone doesn't say)
TABLE = {
    "app_id": "admission_applications",
    "assignment_id": "teacher_assignments",
    "book_id": "library_books",
    "borrower_id": "students",
    "card_id": "id_cards",
    "category_id": "library_categories",
    "cert_id": "certificates",
    "class_id": "classes",
    "component_id": "salary_components",
    "copy_id": "library_copies",
    "delivery_id": "notification_deliveries",
    "doc_id": "student_documents",
    "enquiry_id": "admission_enquiries",
    "enrollment_id": "student_enrollments",
    "entry_id": "timetable_entries",
    "event_id": "notification_events",
    "exam_id": "exams",
    "file_id": "homework_attachments",
    "guardian_id": "student_guardians",
    "head_id": "fee_heads",
    "holiday_id": "staff_holidays",
    "homework_id": "homework",
    "invoice_id": "subscription_invoices",
    "item_id": "inventory_items",
    "leave_id": "leave_applications",
    "loan_id": "library_loans",
    "notice_id": "notices",
    "notification_id": "notifications",
    "op_id": "online_payments",
    "owner_id": "students",
    "paper_id": "exam_papers",
    "payment_id": "fee_payments",
    "payslip_id": "payslips",
    "period_id": "timetable_periods",
    "route_id": "transport_routes",
    "run_id": "payroll_runs",
    "section_id": "sections",
    "session_id": "academic_sessions",
    "staff_id": "transport_staff",
    "stop_id": "transport_stops",
    "structure_id": "fee_structures",
    "student_id": "students",
    "subject_id": "subjects",
    "submission_id": "homework_submissions",
    "teacher_id": "teachers",
    "template_id": "certificate_templates",
    "type_id": "exam_types",
    "vehicle_id": "transport_vehicles",
    "zone_id": "transport_fare_zones",
    "adjustment_id": "payslip_adjustments",
    "user_id": "school_memberships",
}
ALT = {  # other tables the same parameter name is used for, depending on the route
    "template_id": ["report_card_templates"],
    "structure_id": ["salary_structures"],
    "item_id": ["fee_structure_items"],
    "type_id": ["leave_types"],
    "file_id": ["homework_submission_files", "transport_documents"],
    "doc_id": ["transport_documents"],
    "staff_id": ["teachers"],
    "user_id": ["school_memberships"],
}


def token(email: str) -> str:
    return httpx.post(
        f"{AUTH}/token?grant_type=password", json={"email": email, "password": ENV["E2E_PASSWORD"]}
    ).json()["access_token"]


async def rows_of(db, table: str, school: str, n: int = 3) -> list[dict]:
    key = "user_id" if table == "school_memberships" else "id"
    rs = await db.fetch(
        f"select *, {key}::text as _key from public.{table} where school_id = $1 order by 1 limit {n}",
        uuid.UUID(school),
    )
    return [dict(r) for r in rs]


def fill(route, choice: dict[str, str]) -> str:
    path = route.path
    for p in route.dependant.path_params:
        t = p.field_info.annotation if hasattr(p, "field_info") else p.type_
        if p.name in choice:
            v = choice[p.name]
        elif typing.get_origin(t) is typing.Literal:
            v = str(typing.get_args(t)[0])
        elif t is int:
            v = "1"
        else:
            v = "x"
        path = path.replace("{" + p.name + "}", v)
    return path.removeprefix("/api/v1")


async def main(dsn: str, people_file: str) -> int:
    db = await asyncpg.connect(dsn)
    emails = [e.strip() for e in open(people_file) if e.strip()]
    admin_a = httpx.Client(
        base_url=API,
        headers={"Authorization": f"Bearer {token(ENV['E2E_ADMIN_A_EMAIL'])}", "X-School-Id": A},
        timeout=60,
    )
    others = {"admin B": token(ENV["E2E_ADMIN_B_EMAIL"])} | {f"B {e.split('-')[0]}": token(e) for e in emails}
    others = {
        k: httpx.Client(base_url=API, headers={"Authorization": f"Bearer {t}", "X-School-Id": B}, timeout=60)
        for k, t in others.items()
    }

    stats, leaks, verified, skipped = Counter(), [], [], []
    for kind, method, route in ROUTES:
        if kind != "school":
            continue
        params = [p.name for p in route.dependant.path_params if p.name in TABLE]
        if not params:
            continue
        # pick a real School A record for the last parameter; fill the others from its own columns
        last = params[-1]
        candidates = [TABLE[last]] + ALT.get(last, [])
        url = None
        for table in candidates:
            for row in await rows_of(db, table, A):
                choice = {last: row["_key"]}
                for p in params[:-1]:
                    if p in row and row[p] is not None:
                        choice[p] = str(row[p])
                    else:
                        parent = await rows_of(db, TABLE[p], A, 1)
                        if parent:
                            choice[p] = parent[0]["_key"]
                if len(choice) == len(params):
                    url = fill(route, choice)
                    ids = list(choice.values())
                    if method == "GET":
                        r = admin_a.get(url)
                        if r.status_code != 200:
                            continue  # not a valid combination: try the next record
                    break
            if url:
                break
        if not url:
            skipped.append(f"{method} {route.path}")
            continue
        if method == "GET":
            verified.append(url)
            for who, c in others.items():
                r = c.get(url)
                stats[r.status_code] += 1
                body = r.text
                if r.status_code not in REFUSED or any(i in body for i in ids):
                    leaks.append(f"{who}: GET {url} -> {r.status_code}")
        else:
            r = others["admin B"].request(method, url, json={})
            stats[r.status_code] += 1
            # anything but "refused" / "not found" / "bad body" means the record was looked at for School B
            # (even a 409 says it exists and what state it is in)
            if r.status_code not in REFUSED:
                leaks.append(f"admin B: {method} {url} -> {r.status_code} {r.text[:120]}")
            verified.append(f"{method} {url}")

    print(f"routes with record ids checked: {len(verified)} (GET ones first opened by School A's admin)")
    print(f"requests by School B's people: {sum(stats.values())}; answers: {dict(sorted(stats.items()))}")
    print(f"routes without a School A record to try: {len(skipped)}")
    for s in skipped:
        print("   (no record)", s)
    for leak in leaks:
        print("LEAK", leak)
    print("TENANT API AUDIT PASSED" if not leaks else f"TENANT API AUDIT FAILED: {len(leaks)}")
    await db.close()
    return 1 if leaks else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2])))
