# School ERP

A multi-tenant school management system (SaaS): many schools on one platform, each school's data
kept apart by the database itself. Students, admissions and enquiries, classes and timetable,
attendance, homework, exams, results and report cards, fees with receipts and online payments,
library, transport, inventory, staff leave and payroll, certificates and ID cards, notices and
notifications (in-app, email, SMS, WhatsApp, push), analytics, an installable phone app (PWA), and
the platform's own plans, subscriptions and billing — with a complete audit trail.

Built with Next.js 15 + TypeScript + Tailwind v4 (web), FastAPI (API) and Supabase (Postgres, Auth,
Storage). Not part of the product: AI voice calling. The AI assistant and website builder are plan
settings only — the modules themselves are not built (see "Production audit").

```
school-erp/
├── supabase/
│   ├── migrations/0001_foundation.sql   # schools, profiles, memberships, audit, RLS
│   ├── migrations/0002_academic_structure.sql  # roles, sessions, classes, sections
│   ├── migrations/0003_school_profile_and_sessions.sql  # registration, logo bucket, session lifecycle
│   ├── migrations/0004_classes_sections.sql  # soft deletion, class/section guards, student counts
│   ├── migrations/0005_students.sql     # students, enrollments, Student IDs, private photo bucket
│   ├── migrations/0006_student_documents.sql  # documents table, admin-only RLS, private documents bucket
│   ├── migrations/0007_fee_structures.sql  # fee heads, structures, items + SQL calculations
│   ├── migrations/0008_fee_collection.sql  # dues, payments, receipts + record_fee_payment()
│   ├── migrations/0009_attendance.sql   # attendance records, bulk save, report functions
│   ├── migrations/0010_parent_portal.sql  # parent–child links, parent RLS, notices
│   ├── migrations/0011_student_portal.sql # student logins, shared portal RLS, dues speed-up
│   ├── migrations/0012_teachers.sql      # teachers, class assignments, assigned-sections-only access
│   ├── migrations/0013_timetable.sql     # subjects, periods, timetable entries + clash rules
│   ├── migrations/0014_homework.sql      # homework/assignments, files, submissions, marks, feedback
│   ├── migrations/0015_exams.sql         # exam types, grades, exams, date sheets, marks, results (SQL)
│   ├── migrations/0016_report_cards.sql  # report card templates, remarks, signature bucket
│   ├── migrations/0017_admissions.sql    # online admission: windows, applications, workflow, public intake functions
│   ├── migrations/0018_admission_crm.sql # admission CRM: enquiries, follow-ups, history, link to applications
│   ├── migrations/0019_online_payments.sql # Razorpay: gateway accounts (encrypted), orders, refunds, webhooks
│   ├── migrations/0020_notifications.sql # notifications: event outbox, in-app inbox, deliveries, templates, SMS/WhatsApp accounts
│   ├── migrations/0021_librarian_role.sql # the librarian role (its own file: a new enum value must be committed before use)
│   ├── migrations/0022_library.sql       # library: books, authors, categories, copies, loans, fines, rules, dashboard
│   ├── migrations/0023_transport.sql     # transport: vehicles, drivers, documents, fare zones, routes, stops, student assignments, transport dues
│   ├── migrations/0024_inventory.sql     # inventory: items by category, stock in/out history, assignments to staff, dashboard
│   ├── migrations/0025_hr_payroll.sql    # staff leave, holidays, staff attendance; payroll: components, salary structures, monthly runs, payslips
│   ├── migrations/0026_documents.sql     # certificates (templates, issue, revoke, numbering), ID cards, document settings, public QR verification
│   ├── migrations/0027_push_notifications.sql # push notifications: devices per person, queue fed by in-app notifications
│   ├── migrations/0028_analytics.sql      # analytics: one function per tab (students, fees, admissions), role-checked
│   ├── migrations/0029_platform.sql       # platform: plans, subscriptions, usage, system analytics; tighter tenancy
│   ├── migrations/0030_billing.sql        # subscription billing: plan limits & features, invoices, payments, renewal, status worked out
│   ├── migrations/0031_leave_access_fix.sql # fix: another school's staff could cancel a pending leave application by its id
│   ├── migrations/0032_security.sql       # security: complete append-only audit trail, sign-in/out, ended sessions, privileges, file paths, receipt reversal
│   ├── migrations/0033_production_hardening.sql # production audit: fast portal RLS, shared rate limits, renewal lock, no school deletion via API, indexes
│   ├── tests/                           # SQL Editor tests; roll back, leave no data
│   ├── tests/ci/                        # CI: a Supabase stand-in + run_sql_tests.sh (every migration, every SQL test)
│   ├── SCHEMA.md                        # relationships + access matrix
│   └── bootstrap_super_admin.sql        # one-time: promote your account
├── backend/                             # FastAPI
│   ├── app/core/       config, JWT verification, auth/tenant dependencies
│   ├── app/db/         RLS-scoped SQLAlchemy sessions
│   ├── app/models/     ORM mappings (schema owned by SQL migrations)
│   ├── app/schemas/    Pydantic request/response models
│   ├── app/services/   audit log, Supabase admin API, school helpers
│   ├── app/api/v1/     routes: health, me, school, admin
│   ├── tests/
│   ├── requirements.txt / requirements-dev.txt
│   └── pyproject.toml                   # ruff + pytest config
├── .github/workflows/ci.yml             # lint, tests, builds, dependency audits, migrations + SQL tests
├── backend/Dockerfile, frontend/Dockerfile  # production images (non-root, health checks)
├── Makefile                             # dev shortcuts
└── frontend/                            # Next.js 15 + Tailwind v4 + ESLint
    └── src/
        ├── app/(app)/   signed-in pages (dashboard, students, classes, fees, ...)
        ├── app/login, app/auth/   sign-in, invite and password reset
        ├── components/  ui/ (buttons, modals, toasts...) and layout/ (shell, sidebar)
        ├── lib/         config, API client, Supabase clients, types
        └── providers/   auth + active-school context
```

## 1. Supabase setup

Schema details, relationships and the access matrix are in
[`supabase/SCHEMA.md`](supabase/SCHEMA.md).

### Create the project and apply migrations (SQL Editor)

1. Create a project at supabase.com. Pick the region closest to your users (Mumbai for India).
2. **SQL Editor** → run each file **in order**, one at a time:
   1. `supabase/migrations/0001_foundation.sql`
   2. `supabase/migrations/0002_academic_structure.sql`
   3. `supabase/migrations/0003_school_profile_and_sessions.sql`
      (also creates the public `school-logos` Storage bucket)
   4. `supabase/migrations/0004_classes_sections.sql`
   5. `supabase/migrations/0005_students.sql`
      (also creates the **private** `student-photos` Storage bucket)
   6. `supabase/migrations/0006_student_documents.sql`
      (also creates the **private** `student-documents` Storage bucket)
   7. `supabase/migrations/0007_fee_structures.sql`
   8. `supabase/migrations/0008_fee_collection.sql`
   9. `supabase/migrations/0009_attendance.sql`
   10. `supabase/migrations/0010_parent_portal.sql`
   11. `supabase/migrations/0011_student_portal.sql` (also contains a large speed-up for fee dues, see below)
   12. `supabase/migrations/0012_teachers.sql` (also creates the **private** `staff-photos` Storage bucket)
   13. `supabase/migrations/0013_timetable.sql`
   14. `supabase/migrations/0014_homework.sql` (also creates the **private** `homework-files` Storage bucket)
   15. `supabase/migrations/0015_exams.sql`
   16. `supabase/migrations/0016_report_cards.sql` (also creates the **private** `report-card-assets` Storage bucket)
   17. `supabase/migrations/0017_admissions.sql` (also creates the **private** `admission-files` Storage bucket)
   18. `supabase/migrations/0018_admission_crm.sql`
   19. `supabase/migrations/0019_online_payments.sql` (also creates the database role `erp_payments` and grants it to the user running the migration — see *Online fee payments*)
   20. `supabase/migrations/0020_notifications.sql`
   21. `supabase/migrations/0021_librarian_role.sql` (run it on its own, before 0022)
   22. `supabase/migrations/0022_library.sql`
   23. `supabase/migrations/0023_transport.sql` (also creates the **private** `transport-documents` Storage bucket)
   24. `supabase/migrations/0024_inventory.sql`
   25. `supabase/migrations/0025_hr_payroll.sql`
   26. `supabase/migrations/0026_documents.sql` (also creates the **private** `document-assets` Storage bucket for the signature)
   27. `supabase/migrations/0027_push_notifications.sql`
   28. `supabase/migrations/0028_analytics.sql`
   29. `supabase/migrations/0029_platform.sql`
   30. `supabase/migrations/0030_billing.sql`
   31. `supabase/migrations/0031_leave_access_fix.sql`
   32. `supabase/migrations/0032_security.sql` (adds audit triggers on `auth.sessions` and `auth.users`; if your project refuses them, it says so and the app reports sign-ins instead)
3. **SQL Editor** → run each file in `supabase/tests/`. Each must end with
   `ALL ... TESTS PASSED`. They roll themselves back and leave no data.
   Re-run them after every future migration.
4. **Authentication → Users → Add user** → create your own account.
5. **SQL Editor** → put your email into `supabase/bootstrap_super_admin.sql` and run it.

### Or apply migrations with the Supabase CLI

```bash
npx supabase init                         # creates supabase/config.toml (keeps migrations/)
npx supabase link --project-ref <project-ref>
npx supabase db push                      # applies migrations not yet recorded
```

If you already ran a migration through the SQL Editor, tell the CLI so it
doesn't run it again: `npx supabase migration repair --status applied 0001`.

### Auth settings

- **Authentication → URL Configuration**: Site URL `http://localhost:3000`
  (your Vercel URL in production); add `http://localhost:3000/**` and the
  production URL to Redirect URLs.
- **Authentication → Email Templates**, using SSR-safe token-hash links:
  - *Invite user*: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite&next=/auth/set-password`
  - *Reset password*: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/auth/set-password`
- **Authentication → Sign In / Providers**: turn off *Allow new users to sign up*.
  Accounts are created by invitation only.
- For real email volume, configure custom SMTP.

### Where each environment variable comes from

| Variable | Used by | Where to find it |
|---|---|---|
| `DATABASE_URL` | backend | Connect → **Session pooler** URI; change `postgresql://` to `postgresql+asyncpg://` |
| `DATABASE_SSL` | backend | `true` for Supabase |
| `SUPABASE_URL` | backend | Project Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | backend **only** | Project Settings → API Keys → `service_role` / secret key |
| `SUPABASE_JWT_SECRET` | backend, optional | only for projects still on legacy HS256 JWT signing |
| `CORS_ORIGINS`, `FRONTEND_URL` | backend | your frontend URL(s) |
| `NEXT_PUBLIC_SUPABASE_URL` | frontend | same Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | frontend | `anon` / publishable key (safe in the browser; RLS protects data) |
| `NEXT_PUBLIC_API_URL` | frontend | backend URL, e.g. `http://localhost:8000` |
| `SECRETS_KEY` | backend **only** | generate once: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` — encrypts each school's Razorpay, Twilio and WhatsApp secrets in the database. Keep it safe; if it changes, schools re-enter their keys. (`PAYMENT_SECRETS_KEY`, the earlier name, still works.) |
| `PUBLIC_API_URL` | backend | the API's public address, e.g. `https://api.yourschool.in` — Twilio and WhatsApp send delivery reports there |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `EMAIL_FROM` | backend **only** | your mail provider's SMTP settings (e.g. Amazon SES, SendGrid, Postmark, Google Workspace). Empty `SMTP_HOST` = no email. |
| `NOTIFY_WORKER`, `NOTIFY_INTERVAL_SECONDS` | backend | the message sender runs inside the API (`true`, every 5 s) unless you run it separately |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | backend **only** (the public key reaches browsers through the API) | generate once: `cd backend && python -m scripts.generate_vapid_keys`. Push notifications to phones and browsers. Keep the private key secret; changing it means every device must turn notifications on again. Empty = push off (everything else still works). |
| `VAPID_SUBJECT` | backend | `mailto:you@yourdomain.in` or your site's `https://` address — push services contact it if something is wrong |
| `PUSH_ALLOWED_HOSTS` | backend, tests only | leave unset in production (Google, Mozilla, Apple and Microsoft push services are allowed); the test set-up points it at its stand-in |
| `PLATFORM_RAZORPAY_KEY_ID`, `PLATFORM_RAZORPAY_KEY_SECRET` | backend **only** | the **platform's own** Razorpay account (Dashboard → Account & Settings → API Keys), used for schools paying their subscription. Not a school's account. Empty = schools pay by bank transfer and you record it. |
| `PLATFORM_RAZORPAY_WEBHOOK_SECRET` | backend **only** | the secret you choose when adding the webhook in that Razorpay account, pointed at `<PUBLIC_API_URL>/api/v1/billing/webhooks/razorpay` (events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`). Empty = billing webhooks are refused. |
| `BILLING_WORKER`, `BILLING_INTERVAL_SECONDS` | backend | renewal invoices are issued inside the API (`true`, every 3600 s); the super admin can also run it from Billing setup |
| `APP_ENV` | backend | `production` for any real deployment. Only `development`/`test` turn on the API docs; any other value (or none) is treated as a deployment, and the API **refuses to start** with unsafe settings (non-https CORS origins or URLs, a wildcard origin, no `SECRETS_KEY`, platform payments without a webhook secret). |
| `TRUSTED_PROXY_HOPS` | backend | how many reverse proxies (load balancer, CDN) sit in front of the API and add `X-Forwarded-For`; `0` = none. It decides the IP in the audit log and rate limits. Run uvicorn with `--no-proxy-headers` so only this rule applies. |
| `SESSION_CHECK` | backend | `true` (default): a token is refused as soon as its sign-in session ends (signed out, or ended by an admin), instead of when it expires |
| `MAX_REQUEST_MB` | backend | largest request body (default 12; the admission form and homework allow more) |
| `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_APP_SHORT_NAME` | frontend, optional | the name under the app icon (default "School ERP" / "School") |

Never put the service-role key or the database password in the frontend or in Git.

## 2. Backend (FastAPI)

macOS / Linux:
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt      # runtime deps + pytest + ruff
cp .env.example .env                      # then fill in the values
uvicorn app.main:app --reload --port 8000 --no-proxy-headers
```

Windows (PowerShell):
```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements-dev.txt
copy .env.example .env
uvicorn app.main:app --reload --port 8000 --no-proxy-headers
```

> The command is `uvicorn app.main:app`, not `uvicorn app.main`. Uvicorn needs
> `module:attribute`; `app.main` is the module and `app` is the FastAPI object inside it.

- Health check: http://localhost:8000/api/v1/health returns `{"status":"ok"}`
- API docs (non-production): http://localhost:8000/docs
- `DATABASE_URL`: Supabase → Connect → **Session pooler** string, with the scheme
  changed to `postgresql+asyncpg://`. The server starts without a reachable
  database (connections are lazy); only data endpoints need it.
- `SUPABASE_JWT_SECRET`: only for projects still on the legacy HS256 secret.

| Command | Purpose |
|---|---|
| `pytest -q` | Run tests |
| `ruff check . --exclude .venv` | Lint |
| `ruff format . --exclude .venv` | Format |

`requirements.txt` holds runtime dependencies only (what production installs);
`requirements-dev.txt` adds test and lint tools. Tool settings live in `pyproject.toml`.

## 3. Frontend (Next.js)

```bash
cd frontend
npm install
cp .env.example .env.local     # Windows: copy .env.example .env.local
npm run dev                    # http://localhost:3000
```

| Script | Purpose |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` / `npm start` | Production build / serve it |
| `npm run lint` / `npm run lint:fix` | ESLint (Next.js core-web-vitals + TypeScript rules) |
| `npm run typecheck` | TypeScript check |
| `npm run check` | Typecheck + lint |
| `npm run test:e2e` | Playwright end-to-end tests (see Testing) |

If `.env.local` is missing, every page shows a plain message telling you to create it.

All public config is read in `src/lib/config.ts`; API calls go through
`src/lib/api.ts`, which adds the auth token, the active school header and
consistent error handling.

### Pages

| Route | Status |
|---|---|
| `/login`, `/auth/set-password` | Working (Supabase Auth) |
| `/dashboard` | Working: live KPIs and charts for the school (per role); platform stats for Super Admin |
| `/admin/schools` | Working: list, search, filter, add, edit, activate / deactivate |
| `/admin/schools/[id]` | Working: school profile, logo upload, administrators, sessions |
| `/sessions` | Working: create, make current, archive / restore, safe delete (view-only for accountants, teachers) |
| `/profile` | Working: edit name/phone, change password, sign out everywhere |
| `/classes` | Working: classes and sections per session, standard classes, assign sections, copy from last year, search and filters |
| `/students` | Working: search, filters, sorting, pagination (filters kept in the link) |
| `/students/new`, `/students/[id]/edit` | Working: add / edit with photo and admission details |
| `/students/[id]` | Working: profile, photo, status, enrollment history, enrol in current session, **Documents** tab |
| `/fees` | Working for admins & accountants: fee structures per class per session (parents: placeholder until fee collection) |
| `/fees/structures/[id]` | Working: fee items, totals, month-by-month schedule, activate / deactivate, copy |
| `/fees/collect` | Working: every student's total, paid, outstanding and overdue, with search and filters |
| `/fees/collect/[studentId]` | Working: dues, optional fees, record full / partial / multi-fee payments, receipts, history |
| `/fees/payments` | Working: payments register (date range, mode, search) with the period total; download / print receipts |
| `/attendance` | Working for teachers & admins: mark a section for a date (parents/students: placeholder) |
| `/attendance/reports` | Working: daily, monthly grid, class (date range); links to each student's attendance |
| `/reports` | Working: six reports with search, filters, date ranges, pagination, totals, CSV / Excel / PDF |
| `/portal`, `/portal/[studentId]` | Working for parents: own children's profile, attendance, fees, receipts, notices |
| `/teachers`, `/teachers/[id]` | Working for school admins: staff records, photo, login, class assignments, activate / deactivate |
| `/teaching`, `/teaching/[sectionId]` | Working for teachers ("My classes"): assigned classes, their students, attendance status, class timetable |
| `/teaching/timetable` | Working for teachers ("My timetable"): their week across all classes, print / PDF |
| `/homework`, `/homework/[id]` | Working for admins & teachers: set homework/assignments with files, submissions, review with marks and feedback |
| `/my/homework/[id]` | Working for students: instructions, teacher's files, submit / update work with files, marks and feedback |
| `/portal/[studentId]/homework/[id]` | Working for parents: the child's homework, submission, marks and feedback (read only) |
| `/report-cards` | Working for school admins: report card templates with live preview |
| `/admissions`, `/admissions/[id]` | Working for admins & accountants: applications by status, review → verify → approve/reject, admission fee and receipt, create the student; Settings (admins): open classes, seats, fee, last date, the public link |
| `/enquiries`, `/enquiries/[id]` | Working for admins & accountants: admission CRM — pipeline dashboard, enquiry list (filters, search, CSV), enquiry page with updates, follow-ups, history, call / WhatsApp links, linking to online applications |
| `/fees/online` | Working for admins & accountants: online payments (status tabs, search, totals), re-check with Razorpay; refunds (admins) |
| `/settings` | Working for school admins: plan and billing (status, what the plan includes, usage against limits, invoices with online payment and PDF, cancel / keep), staff sign-ins, online fee payments (Razorpay keys, webhook set-up) |
| `/admin/plans` | Working for the super admin: plans with prices, trial and grace days, limits and features; Basic / Professional / Enterprise templates |
| `/admin/invoices` | Working for the super admin: every subscription invoice (filter by state, totals), record a payment, cancel an invoice, PDF |
| `/audit-log` | Working for school admins: the school's audit log — sign-ins and sign-outs, students, receipts (recorded, cancelled), attendance changes, people and roles, settings — with what changed (before → after), who, when and from which IP and browser; filters, search, CSV |
| `/admin/audit` | Working for the super admin: every school's audit log and the platform's own (payroll entries excluded) |
| `/admin/billing` | Working for the super admin: the platform's invoice details, tax, renewal timing, online-payment status, Razorpay notices received, issue due renewals now |
| `/notifications` | Working for everyone: their notifications (also in the bell at the top of every page), mark read |
| `/library` | Working: library dashboard, issue & return desk, catalogue, loans and fines, borrowers, rules (librarians and admins; accountants: fines; teachers: catalogue and own books) |
| `/library/books/[id]` | Working: a book's details and copies (add copies, mark damaged / lost / withdrawn) |
| `/library/borrowers/[kind]/[id]` | Working: a student's or staff member's books, history and fines; issue from there |
| `/transport` | Working: transport dashboard, students on routes (assign, move, stop; CSV), routes, vehicles, drivers & attendants, fare zones (admins; accountants: view only) |
| `/transport/routes/[id]` | Working: a route's vehicle and crew, stops (add, edit, reorder, remove), riders by stop, add a student, printable route sheet, CSV |
| `/transport/vehicles/[id]` | Working: a vehicle's details, routes and papers (upload, view, change dates, delete; missing papers flagged) |
| `/transport/staff/[id]` | Working: a driver's or attendant's details and documents (admins only) |
| `/inventory` | Working: inventory dashboard, items (filters, CSV, add), stock history across items (filters, CSV) (admins; accountants: view only) |
| `/inventory/items/[id]` | Working: an item's details, stock in / stock out, edit, archive or restore, and its full history |
| `/leave` | Working: My leave — balances, apply, my applications, cancel (any staff login linked to a staff record) |
| `/staff-leave` | Working: requests (approve / reject), all leave (filters, CSV), balances and per-person allowances, leave types, holidays and the working week (school admins) |
| `/staff-attendance` | Working: daily staff register (present / absent / half day) and a monthly summary (school admins) |
| `/payroll` | Working: monthly payroll, salaries, allowances & deductions, how pay is counted (this school's admins only) |
| `/payroll/runs/[id]` | Working: a month's payslips, adjustments, recalculate, finalize, reopen, mark paid, salary slip PDFs, salary register CSV |
| `/payroll/staff/[id]` | Working: a staff member's salary structures (with revisions from a month) and payslips |
| `/certificates` | Working: issue certificates (bonafide, character, transfer, study, custom) with preview, issued list (search, CSV, PDF, revoke), templates editor, settings (signature, principal, place, colour, ID card options) (school admins) |
| `/id-cards` | Working: student, teacher and staff ID cards — choose people, print or download (A4 sheets, optional back), reprint or issue new cards, issued cards (status, revoke) (school admins) |
| `/verify/[token]` | Working: public QR check of a certificate or ID card (no login; minimal details) |
| `/offline.html`, `/sw.js`, `/manifest.webmanifest` | The installable app: offline page, service worker (offline shell, push), web app manifest (see *The app on phones*) |
| `/communication` | Working for school admins: notification history and delivery status, templates per message and channel, email / SMS / WhatsApp set-up, test messages, fee reminders |
| `/apply/[code]`, `/apply/[code]/track` | **Public, no login:** the online application form, and status tracking with the application number + mobile |
| `/exams`, `/exams/[id]` | Working: exam types and grading scale (Setup), exams, date sheets, marks entry, results, report cards and result sheets (PDF) |
| `/timetable` | Working: class timetables (all staff; teachers only their classes), teacher timetables (admins), Setup (admins): periods, subjects |
| `/my` | Working for students: own profile, attendance, fees, receipts, notices ("My school record") |
| `/notices` | Working: admins publish/schedule/edit notices; everyone else reads those meant for them |

New modules add one entry to `NAV` in `src/components/layout/sidebar.tsx`.

## Running both at once

With `make` (macOS/Linux/WSL): `make setup`, `make env`, then `make dev`.
Other targets: `make test`, `make lint`, `make check`.
On Windows, run the backend and frontend commands above in two terminals.

## 4. Deployment

- **Database**: apply every migration in order (SQL Editor or `supabase db push`), including
  `0033_production_hardening.sql`. The API's readiness check (`/api/v1/health/ready`) answers 503 until it is.
- **Frontend → Vercel** (root directory `frontend`, the three `NEXT_PUBLIC_*` vars) **or Docker**:
  `docker build -t school-erp-web frontend --build-arg NEXT_PUBLIC_SUPABASE_URL=… --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=… --build-arg NEXT_PUBLIC_API_URL=https://api.…`
  (the values are built into the pages). A production build refuses `http://` API or Supabase URLs.
- **Backend → any container host** (Railway, Render, Fly.io, Cloud Run, ECS): `docker build -t school-erp-api backend`,
  run with the variables from `backend/.env.example` (`APP_ENV=production`, https `CORS_ORIGINS`/`FRONTEND_URL`,
  `SECRETS_KEY`, `TRUSTED_PROXY_HOPS` = proxies in front of the API). The image runs
  `uvicorn … --workers ${WEB_CONCURRENCY:-2} --no-proxy-headers` as a non-root user. Without Docker:
  `uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 2 --no-proxy-headers`.
- **Health checks**: liveness `GET /api/v1/health` (process up; doesn't touch the database), readiness
  `GET /api/v1/health/ready` (database reachable and migrated; 503 otherwise — use it for the load balancer).
- **Several API processes or servers** are safe: rate limits are counted in the database
  (`RATE_LIMIT_BACKEND=auto` → database outside development), the notification sender claims work with
  `SKIP LOCKED`, and the hourly renewal run takes a lock (one run at a time; the others skip).
- Update the Supabase Site URL / Redirect URLs to the production domain.
- **Backups**: Supabase backs up the database daily (Pro plan; turn on Point-in-Time Recovery for a school
  platform). Storage files (photos, documents, logos, signatures) are **not** in those backups — copy the
  buckets on a schedule (e.g. `supabase storage` / S3-compatible sync) and test a restore before go-live.
- **Logs**: the API logs to stdout (uvicorn access log + `api`, `billing`, `notify`, `ratelimit` loggers);
  ship them with the host's log drain. Request bodies, tokens and secrets are never logged.
- **CI**: `.github/workflows/ci.yml` runs on every push — backend lint/tests/pip-audit, frontend
  lint/typecheck/build/npm audit, and every migration + SQL test on Postgres 16
  (`supabase/tests/ci/run_sql_tests.sh`, also runnable locally against an empty database).

## Academic sessions

Each school has its own sessions (e.g. 2025-26, 2026-27). Exactly one is
**current**; new admissions, fees and attendance will be recorded against it, and
it's shown in the header for everyone in the school.

| Action | Rule |
|---|---|
| Create | Name is suggested from the start date (1 Apr → 31 Mar). Dates may not overlap another session. A school's first session becomes current automatically. |
| Make current | Any non-archived session. Switching is atomic, so there's never zero or two current sessions. |
| Archive | Hides a finished year from everyday lists; all records are kept. The current session can't be archived. Restore at any time. |
| Delete | Only for sessions that are **not current and hold no records**. The admin must type the session's name. |

**Protection against deleting sessions with student/fee records** works at three levels:
1. The UI shows what the session contains and offers *Archive instead*.
2. The API refuses with the reason, e.g. "2025-26 still has records (120 students). Archive it instead."
3. A database trigger refuses the delete however it is issued, including from the
   SQL Editor. It finds every table that references `academic_sessions`
   automatically, so student, fee and attendance tables added in later phases are
   protected without any change, even one mistakenly declared `ON DELETE CASCADE`.
   Deleting an entire school (a deliberate Super Admin action) still removes its sessions.

## Classes & sections

**Classes** (Nursery, LKG, UKG, Class 1–12, or your own names) belong to the
school and stay the same every year. **Sections** (A, B, C …) belong to a class
*and* an academic session, so each year can have its own sections, capacities and
rooms without changing last year's records.

| Feature | How |
|---|---|
| Standard classes | One click adds Nursery to Class 12 in the usual order; existing names are skipped |
| Assign sections | Pick several classes and section letters (or your own names, e.g. Rose, Science); existing ones are skipped |
| Copy from session | Copies last year's sections (names, capacities, rooms) into the new session; students are not copied |
| Session filter | The page shows one session at a time (default: current); the link keeps the session, tab and class filter |
| Search & filters | Classes by name and status; sections by section, room or class name, class, and status; sections are paginated |
| Activate / deactivate | Inactive classes and sections stay visible; no new sections can be added to an inactive class |
| Soft delete / restore | Deleted items are hidden but kept, with who deleted them and when; a deleted name can be reused |

Rules the database enforces, whatever the client does:
- Users can't permanently delete classes or sections; only soft delete is possible.
- A class can't be deleted while it has sections (in any session).
- A section can't be deleted or moved to another class while it has students.
- A section can't be moved to a different session, or to another school's class.
- Sections of an archived session are read-only.
- Names are unique per school (classes) and per class per session (sections), ignoring case.

**Student counts** come from one database function,
`private.section_student_counts`. It returns 0 until the Students module
replaces its body to count enrolments. Every screen, total and "has students"
rule above then uses real numbers with no other change.

## Students

A **student** is the person: Student ID, name, parents, date of birth, gender,
contact details, photo and status. Each school year they also get an
**enrollment**: academic session, class, section, admission number and
admission date. Promotion next year adds an enrollment, so history is never
overwritten.

| Rule | Enforced by |
|---|---|
| Admission numbers are unique within a school and session (ignoring case and spaces); the same number may be reused in another session | unique index |
| Student IDs (STU00001 …) are generated per school, never repeat, and can't be changed | trigger + per-school counter |
| The section belongs to the chosen class, session and school | composite foreign keys |
| A full section refuses new students, even when two admissions happen at once | trigger (locks the section row) |
| Archived sessions are read-only; inactive or deleted classes and sections take no new students | trigger |
| A father's or mother's name is required; mobile numbers are validated | check constraints + API |
| Students are deactivated (with an optional reason), never deleted | no delete policy |
| Only staff (school admin, accountant, teacher) can see students; only school admins can change them | RLS + API permissions |

Parents and students will see their own records when the parent and student
portals are built.

**Student counts are now real.** `private.section_student_counts` counts
enrollments, so a section or session that holds students can't be deleted.

**Photos** go through the API (school admins only) and are re-encoded as JPEG,
at most 600×600, with hidden data (camera GPS, device details) stripped. They're
stored in the **private** `student-photos` bucket: nobody can open them by URL.
The API returns links that expire after one hour.

**Search** matches name, father's and mother's names, Student ID and admission
number. Mobile search ignores spaces, dashes and the country code.

The profile already has tabs for Fees, Attendance, Homework, Exams, Results and
Documents. Each module fills its tab as it is built.

## Student documents

The **Documents** tab of a student's profile holds: birth certificate,
previous marksheet, transfer certificate, address proof, student ID document,
and other documents (with a description). Admins can upload (drag and drop),
preview images and PDFs, download, edit the type or description, and delete.
A checklist shows which standard documents are still missing.

**Who can open them:** school admins of that school, and the platform super
admin. Teachers and accountants can see the student but **not** their
documents. This is enforced twice: by API permissions, and by RLS on
`student_documents`. Tests confirm that even if the API permission were wrongly
granted, RLS still returns nothing.

**How files are protected:**
- Files live in the **private** `student-documents` bucket, with no storage
  policies for users. No browser, anon key or signed-in user can read it directly.
- The browser never receives a Storage URL, public or signed. To view or
  download, it calls the API with the user's token. The API checks the
  permission, the school, and that the document belongs to that student, then
  streams the bytes. A link can't be forwarded or leaked, because there isn't one.
- Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`
  and `Content-Security-Policy: sandbox`.
- Every view and download is written to the audit log, as are uploads, edits
  and deletions.

**What can be uploaded:** PDF, JPEG, PNG and WebP up to 10 MB, recognised by
the file's contents, not its name. Images are re-encoded (hidden metadata
removed; very large scans are reduced to 4000 px). PDFs are parsed and refused
if they are password-protected, damaged, or contain scripts, launch actions,
embedded files or data-submitting forms. File names are cleaned (no paths or
special characters); Hindi and other non-English names are kept for downloads.

**Delete** removes the record and the stored file. The audit log keeps a record
of what was deleted, by whom and when.

## Fee structures

**Fee heads** (Tuition Fee, Transport Fee, Exam Fee …) are a per-school
catalogue, used across classes and, later, on receipts and reports. Ten common
heads can be added with one click.

A **fee structure** belongs to one class in one academic session. Each **fee
item** has a fee head, an amount, and a frequency:

| Frequency | Falls due |
|---|---|
| Monthly | every month of the session; untick months with no charge (e.g. no transport in May/June) |
| Quarterly / Half-yearly | from a chosen first month, every 3 / 6 months while the session lasts |
| Yearly / One-time | once, in a chosen month (default: the first month of the session) |

Any item can be **optional** (e.g. transport). Optional fees are totalled
separately from compulsory ones.

**No amounts are hard-coded, and the application never adds up money.**
- Amounts are `numeric(12,2)` in Postgres and exact `Decimal` in Python. They
  are sent to the browser as text (`"1500.00"`) and only formatted there.
- `private.fee_structure_schedule` works out every due date from the
  session's real start and end dates. `fee_item_breakdown` (times due and
  yearly amount per item) and `fee_structure_totals` (compulsory, optional,
  monthly, one-time) are built on it. These functions run with the caller's
  RLS, so nothing leaks through them.
- `private.copy_fee_structure` copies a structure to other classes and/or
  sessions. It applies a % change (−50 to +100) and rounds to ₹1/5/10/50/100,
  in SQL. Targets that already have a structure are skipped.

Worked example (the Class 5 brief, tested in `supabase/tests/fees_test.sql` and
the browser tests): Admission ₹2,000 one-time, Annual ₹5,000 yearly, Exam
₹1,000 yearly (due September), Tuition ₹1,500 monthly, Transport ₹1,000 monthly
(optional, no May/June). The database computes ₹26,000 compulsory per year and
₹10,000 optional. April's dues are ₹8,500 and September's ₹2,500.

**Who can manage fees:** school admins and accountants. Teachers, parents and
students can't see fee structures; parents will see their own fees with fee
collection. **Rules:** one structure per class per session; a fee head appears
once per structure; archived sessions are read-only; a structure can't move to
another class or session (copy it instead); fee heads are deactivated, never
deleted; only an empty structure can be deleted. Sessions that have fee
structures can't be deleted.

## Fee collection

**Dues.** Each enrolled student gets their own dues, built from their class's
*active* fee structure: one line per fee item per due month, plus optional fees
they've opted into (e.g. transport). `private.sync_student_dues` keeps them in
step. While a due is unpaid it follows the structure (new amounts, removed
items, opt-outs). **Once anything has been paid against it, it is frozen**, so
a later structure change never alters money already collected. A fee item that
has payments can't be removed from the structure. Inactive students and
archived sessions are left untouched.

**Payments.** One payment (receipt) can cover one or several dues, each in full
or in part. Every payment is recorded by `private.record_fee_payment`, in one
transaction:

| Rule | How |
|---|---|
| No more than the outstanding balance (no advance payments) | the dues being paid are locked; any amount above a due's balance is refused with the exact figures |
| Unique receipt number | `SCHOOLCODE/2026-27/000001`, per school and session, allocated in the same transaction (no gaps from failed attempts) |
| No duplicate submissions | each payment form carries a one-time key; resending it, even simultaneously, returns the **original** receipt. The button also disables while saving, and a failed attempt keeps its key so a retry can't charge twice |
| Payment details | date (not in the future), mode (Cash / UPI / Bank transfer / Cheque / Other), reference number (required for UPI, bank transfer and cheque), remarks |
| Balance | the receipt stores the balance remaining after it, and who received it |
| History | receipts can't be edited or deleted: `authenticated` has only `SELECT`/`INSERT` on them, and there are no update/delete policies |

**Receipt PDF** (A5): school name, address, affiliation and logo; receipt number
and date; student, Student ID, class, admission number, parent and session; each
fee with its period; total; amount in words (Indian style: lakh and crore);
mode and reference; balance due; who received it. It's generated by the backend
with an embedded font (ErpSans: DejaVu Sans with Noto Sans for nine Indian scripts, shaped with
HarfBuzz), so ₹ and names in Hindi, Marathi, Bengali, Punjabi, Gujarati, Odia, Tamil, Telugu, Kannada
or Malayalam print correctly — on every PDF, not only receipts. It's served only
through the API (`Cache-Control: no-store`).

**Who:** school admins and accountants. Teachers can't see fee records;
parents will see their own children's fees in the parent portal.

**Not included yet:** cancelling or refunding a receipt, advance payments,
concessions and fines, and online payment.

## Attendance

**Marking.** A teacher chooses the academic session, class, section and date,
and sees the section's active students with any marks already saved. They can
mark everyone present or absent in one click and then change individuals:
Present / Absent / Leave, with an optional remark. **Save attendance** stores
the lot. Unsaved changes are highlighted and counted, and leaving the page with
them asks first. Saved days can be reopened and edited.

**Efficient by design:**
- Loading a section is **one request**: students plus that day's saved marks.
- Saving a section is **one request** carrying only the students that changed.
  The backend writes them with **one SQL statement**
  (`private.save_section_attendance`, an upsert), not one query per student.
  Students whose mark didn't change aren't touched, so their "last changed"
  details stay accurate. The browser tests check that saving a whole class sends
  exactly one request, and that an edit sends only the edited student.

**Rules (in the database):**
- one record per student per day (`unique (student_id, attendance_date)`);
  two saves of the same day at the same moment still leave one record per student;
- no future dates; the date must be inside the session; archived sessions are read-only;
- only active students can be marked, and only into the section they belong to;
- records can be corrected but not deleted, and every save that changes something
  writes an audit entry with each student's before and after.

Each record keeps the class and section the student was in that day, so
history stays correct after a section change.

**Reports** (all computed by SQL functions, RLS applies):

| Report | What it shows |
|---|---|
| Daily | every section on a date: students, present, absent, leave, not marked, % |
| Monthly | a section's student × day grid (P/A/L), per-student totals and %, class % per day |
| Class | a section over any date range: % per student (below 75% highlighted) and overall |
| Student | on the student's profile: overall %, by month, and every absence/leave with remarks |

**Attendance % = present ÷ days marked.** Leave counts as a marked day that
isn't present. Days the student wasn't marked (e.g. before they joined) don't count.

**Who:** teachers and school admins mark attendance and see reports.
Accountants have no access. Parents and students will see their own attendance
in their portals. Since Phase 14 a teacher can see and mark **only the sections
assigned to them** (see Teacher management).

## Dashboard

One request (`GET /api/v1/dashboard`) returns everything, each figure a SQL
aggregate over real records for the current session. There is no sample or
placeholder data.

| Card / chart | Source | Shown to |
|---|---|---|
| Total students, total classes (and sections) | active enrollments; active classes and sections | anyone who can see students |
| Today's attendance %, present / absent (and leave, not marked) | `attendance_daily` for today | teachers, admins |
| Fees collected (session), pending fees (with overdue), today's collection | receipts; `enrollment_fee_totals` after syncing dues | admins, accountants |
| Monthly fee collection (chart) | receipts per month across the session, empty months shown as ₹0 | admins, accountants |
| Attendance trend (chart) | school-wide % present per day marked, last 30 days | teachers, admins |
| Student enrollment (chart) | active students per class, split by gender | anyone who can see students |

Every card links to the page with the detail. Each chart includes a hidden
data table for screen readers.

## Analytics

**Analytics** (in the menu under School) charts the whole school over time. Every figure is
worked out by the database from the school's own records each time the page loads. There is no
stored total, no estimate and no sample data.

| Tab | Who | What it shows |
|---|---|---|
| **Students** | school admins | **Enrollment**: active, new and continuing students, who left, enrollment by session, new admissions by month. **Class strength**: students per class (girls / boys / other), sections, average per section, seats filled. **Attendance**: % present by month and by day, by class, and students grouped as 90%+ / 75–89.9% / below 75%. **Performance** for a chosen exam: average %, pass rate, by subject, by class, grade distribution, and the trend across exams. |
| **Fees** | school admins, accountants | **Monthly collection** (this session beside the same month last session), **pending fees** (outstanding, overdue, how late), **collection by class**, **by fee head**, **payment method** (online payments split by card / UPI / net banking as the gateway reported), **outstanding over time** (dues falling due vs still unpaid at each month end). |
| **Admissions** | school admins, accountants | **Enquiries**, online **applications** and **admissions** by month; the enquiry and application **funnels**; **conversion** overall and by source; by class; where enquiries and applications stand today. |

**Filters.** All filters sit in one row above the charts and are kept in the page address, so a
view can be bookmarked:

- **Session**: defaults to the current session.
- **Class**: optional.
- **Period**: the whole session, this month, the last 3 or 6 months, or custom dates. The period
  never runs past the session or today.
- **Exam**: Students tab only. Defaults to the latest exam with marks.

Admissions use the dates as asked, because the admission season runs before the session starts.
While new figures load, the previous charts stay on screen, dimmed.

**Definitions.** These are the same definitions the rest of the system uses, so the numbers agree
with the dashboard and reports:

- **Attendance %**: present ÷ (present + absent + leave) on the days marked.
- **Exam results**: a student's % counts only when every paper has marks. Absent counts as failed.
  Grades come from the school's grade bands.
- **Collected**: receipts that were not cancelled, by receipt date. A refund cancels its receipt;
  cancelled receipts are listed separately and not counted.
- **Overdue**: dues for this month or earlier that are still unpaid.
- **New student**: a student whose first enrollment at the school is in this session. A student
  admitted before the session starts counts in its first month.
- **Seats filled**: only sections with a capacity set count, so seats and the students in them
  are compared like for like.
- **Enquiry conversion**: enquiries that became students ÷ all enquiries in the period.

The API smoke test checks these figures against the dashboard, the pending-fees and
fee-collection reports, and the enquiry pipeline.

**Charts.**

- Colours are a fixed, colour-blind-checked palette. Each figure keeps its colour on every chart
  (for example, collected is always green and outstanding always orange).
- Ordered stages (funnels, attendance bands, how late a fee is) use shades of one green.
- Every chart has a tooltip and a legend when it shows two or more series.
- Every chart has a **Table** view with exactly the charted figures, which screen readers always
  get, and a **CSV** download of that table.
- There are no dual axes. Amounts are shown in Indian short form (₹3.4L) on axes and exactly
  (₹3,40,000) in tables and tooltips.

**API.** All three endpoints take `session_id`, `class_id`, `from`, `to`; the Students endpoint
also takes `exam_id`:

- `GET /api/v1/analytics/students`
- `GET /api/v1/analytics/fees` (brings dues up to date with the fee structures first, as the
  dashboard does)
- `GET /api/v1/analytics/admissions`

Each returns the database's JSON unchanged, so amounts stay exact. Permissions are
`analytics:students` (admins) and `analytics:fees` / `analytics:admissions` (admins,
accountants). The database checks the same rule itself (see SCHEMA.md), so another school's
admin, a teacher, a parent or a student is refused even when calling the database directly.

**Speed.** `supabase/tests/analytics_performance_test.sql` builds a school with 1,500
students, about 300,000 attendance marks, 18,000 dues, 4,500 receipts, exam marks, 2,000
enquiries and 800 applications. It requires every tab to answer in under 3 seconds. Measured:

- Students: 1.1 s
- Fees: 0.2 s, plus 0.85 s to bring 18,000 dues up to date
- Admissions: 0.02 s
- One class: 0.15 s

**Found and fixed while building this.** Bringing a whole school's dues up to date ran as the
signed-in user, with row-level security checking every due it read. On the large test school
that took **3 minutes**. It happened on every dashboard load and on the fee collection list and
fee reports for admins and accountants. It now runs as the database owner after a check that
the caller is that school's admin or accountant, and takes under a second. For other roles it
does nothing, as before. (See SCHEMA.md, Analytics.)

## Reports

One engine, six reports: `GET /api/v1/reports/{name}`. Each report is defined
once (columns, SQL, filters, required permission), and the same definition
serves the screen and the exports.

| Report | Filters | Who |
|---|---|---|
| Students | session, class, section, status, gender, search (name, ID, admission no., parent, phone) | students:view |
| Classes | session, class, date range (attendance), search; fee and attendance columns only for roles that may see them | students:view |
| Fee collection | date range, group by fee head / mode / class / day, mode, class | fees:collect |
| Pending fees | session, class, section, overdue only, search | fees:collect |
| Payment history | date range, mode, class, search (receipt no., student, reference) | fees:collect |
| Attendance | session, class, section, date range, below 75 / 85 / 90 %, search | attendance:mark |

- **Pagination and totals** happen in SQL (`count(*)` and `sum(...)` over the filtered set).
- **Exports** (`?format=csv|xlsx|pdf`) contain *all* matching rows, up to
  10,000; the PDF notes it if more exist.
  - **CSV:** UTF-8 with BOM, so Excel shows Hindi names correctly, and plain numbers so they can be summed.
  - **Excel:** real numbers with number formats, a frozen header row and a totals row.
  - **PDF:** landscape A4 with the school name, filters, totals and a generated time.
- Every export writes an audit entry (report, format, row count, filters),
  because data is leaving the system.
- Money and percentages are exact decimal strings in JSON; the browser only formats them.
- Text typed by people (names, notes; some arrive from the public admission form) is never
  run as a spreadsheet formula: in CSV a cell starting with `=`, `+`, `-` or `@` gets a
  leading apostrophe (plain numbers like `+919876543210` are left alone), and in Excel such
  cells are stored as text.

## Parent portal

**Parent–child links.** A school admin links a parent's account to a student
from the student's profile (**Parents & guardians → Link parent**: email, name,
relationship). A new email gets an invitation to sign in. An existing account
is found by `private.find_account_by_email`, which only that school's admins can
call and which returns only the account id. Linking gives the account the
school's parent role if it doesn't have it (so a teacher whose child attends
the school can be both). The database refuses a link unless the account is an
active parent in the same school and the student belongs to that school.
Unlinking, or disabling the parent role, removes access immediately.

**Parents only ever see their own children, enforced twice:**
1. **API:** every `/portal/children/{id}/…` request first checks the guardian
   link. Anything else answers *404 not found*, so another student's existence
   isn't revealed. A receipt must also belong to that child.
2. **Database:** RLS policies built on `private.is_guardian_of(student_id)` let
   parents *read* (never write) only their own children's rows in students,
   enrollments, attendance, dues, receipts and receipt lines, plus only the
   fee heads and fee items their child is billed for. Documents remain
   admin-only. Parents can't run the staff dues refresh, so
   `private.sync_dues_for_guardian` refreshes their child's dues after checking
   the link.

`supabase/tests/parent_portal_test.sql` signs in as two parents of the same
school and a parent from another school, and checks every table and function.
Deliberately weakening `is_guardian_of` makes it fail.

**What a parent sees** (menu: Dashboard, My children, Notices):

| Tab | Content |
|---|---|
| Profile | details, class, admission, photo (signed, short-lived URL) |
| Attendance | overall %, month by month, every absence/leave with remarks |
| Fees | total / paid / pending / overdue, pending items, payment history, receipt PDFs |
| Notices | notices for parents/everyone, including ones limited to the child's class |
| Homework, Timetable, Exam results | marked "not available yet": those modules aren't built, so nothing is shown rather than invented |

Staff pages and APIs (students, fee collection, attendance, reports) are
refused to parents with 403.

## Notices

School admins post notices for **everyone**, **parents** or **staff only**,
optionally limited to certain classes, and optionally scheduled (publish at)
or time-limited (expires at), with pinning. Staff see every notice, with its
state (scheduled / live / expired). Parents see only notices that are live,
addressed to parents or everyone, and either school-wide or for one of their
children's classes. This is enforced by RLS on `public.notices`.

## Student portal

**One login, one student.** On a student's profile an admin uses **Student
login → Create login** with the student's own email. A new email gets an
invitation; an existing student account is linked. The database refuses the
link unless the account is an active *student* of the same school, the account
isn't linked to another student (`students.account_id` is unique), and the
person changing it is a school admin. The API also refuses emails that already
belong to staff or parents in the school. Removing the login, or disabling the
student role, ends access immediately.

**Students only ever see their own information, enforced twice:**
1. **API:** students use `/my`, `/my/attendance`, `/my/fees` and
   `/my/payments/{id}/receipt.pdf`. **There is no student id in these URLs**:
   the answer is always for the student linked to the signed-in account. A
   receipt must belong to that student (otherwise 404). Parent-portal URLs and
   all staff APIs return 403 to students, even for their own record.
2. **Database:** `private.can_view_student_record(student)` = *a linked parent*
   **or** *this student themself* (`is_student_self`). Every portal read policy
   uses it, replacing the Phase 12 parent-only policies, so parents and
   students share exactly the same limits. Documents remain admin-only.

`supabase/tests/student_portal_test.sql` checks two students, a parent, a
teacher and a student from another school. Weakening `is_student_self`
makes it fail. The Phase 12 parent tests pass unchanged.

**What a student sees** (menu: Dashboard, **My school record**, Notices):
Profile, Attendance, Fees with receipt PDFs, and Notices. Notices have a new
**Students** audience, optionally limited to classes; parents don't see
student-only notices. Homework, Assignments, Timetable, Exams and Results are
marked "not available yet" because those modules aren't built.

## Performance: fee dues

The dashboard, Pending fees and Classes reports (for fee staff) and both
portals bring dues up to date before showing them. Postgres was recalculating
each class's fee schedule once per *student* rather than once per class, so
refreshing 600 students took ~20 s. Migration 0011 fixes this
(`MATERIALIZED`): ~0.4 s to create dues for 600 students and ~0.1 s when
nothing changed. `supabase/tests/dues_performance_test.sql` guards it: it fails
if a 600-student refresh takes over 5 s, and the old version fails at 20–30 s.

## Teacher management

**Teacher records** (school admins, **Teachers** in the menu): Employee ID,
name, phone, email, qualification, main subject, joining date, address, photo,
status, **staff type** (teaching, or non-teaching such as office or support staff — decides Teacher
or Staff ID cards) and **designation** (printed on ID cards, e.g. PGT Physics, Office Assistant).
- **Employee ID:** typed by the school (stored upper-case), or left empty to
  number automatically (`EMP0001`, `EMP0002` …). Unique per school, ignoring
  case, as is the email.
- **Checks:** phones are validated like students'; the joining date can't be in
  the future.
- **Photos:** re-encoded as JPEG with EXIF stripped, in the private
  `staff-photos` bucket, shown through short-lived signed links.
- **No deletion:** teachers are deactivated (with a reason), never deleted.

**Login.** **Teacher login → Create login** uses the email on the record: a new
email gets an invitation; an existing account is linked. The database only
links accounts that are active teachers of the same school, one login per
teacher, and only admins can change the link. Deactivating a teacher, or
removing their login, also disables their teacher role, so they lose access to
the school straight away. Reactivating restores it.

**Assigned classes.** Each assignment is teacher → section (which fixes the
class and session), with an optional subject and a **class teacher** flag. The
same subject can't be given twice in a section, a section has at most one
class teacher, inactive teachers can't be assigned, and archived sessions are
read-only.

**Teachers reach only their assigned classes, enforced by the database.**
Migration 0012 replaces the policies that gave the teacher role the whole
school. A teacher now sees students, enrollments, attendance, classes and
sections **only for sections assigned to them**, and can mark attendance only
there. This holds only while their teacher record is active, linked to their
login, their teacher role is active and the school is active
(`private.teacher_assigned_section`, `teacher_sees_student`,
`teacher_sees_class`). Every screen built earlier narrows automatically:
Students, Classes, Attendance, Attendance reports, Reports and the Dashboard.
Another class's page or student answers "not found". Accountants still see all
students (fees need them); staff records are admin-only.
`supabase/tests/teachers_test.sql` checks two teachers with one class each, a
teacher from another school, and losing access by unassigning, deactivating or
disabling the role. Weakening the rule makes it fail.

**Teacher portal** (**My classes**, also at the top of the teacher's
dashboard): one card per assigned section with subjects, class-teacher badge,
student count, attendance %, whether today's attendance is marked, and a
**Mark attendance** link. The class page lists its students (attendance % and
today's status) with tabs for Attendance, Homework, Assignments, Timetable,
Exams (the class's date sheets), Marks (links to marks entry) and Notices.

## Exams & results

**Setup** (school admins, **Exams → Setup**):
- **Exam types:** *Add standard types* adds **Unit Test, Half Yearly and Annual**.
  Add any other type (Pre-Board, Periodic Test …). Types are deactivated, not deleted.
- **Grading scale:** *Use standard scale* sets a common 8-point scale (A1 ≥ 91%,
  A2 ≥ 81, B1 ≥ 71, B2 ≥ 61, C1 ≥ 51, C2 ≥ 41, D ≥ 33, E below 33). Any grade can be
  edited, added or removed; one grade must start at 0% so that every result gets a
  grade.
- **Subjects** are the school's subject list, managed under **Timetable → Setup**.

**Exams:** **New exam** → type and name (unique within the session, e.g.
"Unit Test 1"). An exam moves through three states:
1. **Draft:** only staff see it. Build the **date sheet**: **Add paper** → one or
   more classes, subject, date (within the session), start and end time,
   **maximum marks** and **passing marks** (not more than the maximum). A class can
   have one paper per subject per exam, and never two papers at the same time
   (checked across all exams of the session).
2. **Scheduled** (*Publish date sheet*): students and parents see the date sheet.
   Marks are entered.
3. **Results published** (*Publish results*): students and parents see marks,
   grades and results; marks and the date sheet are locked. *Unpublish results*
   reopens them for corrections and hides results again.

**Marks entry** (exam page → *Marks entry*, or a teacher's class page → *Marks*):
choose class and paper, type each student's marks or tick **Absent**, and save the
whole section at once. Teachers see and enter marks only for sections assigned to
them; admins for every section. **Invalid marks are refused**, on screen and again
by the database: negative marks, more than the paper's maximum, more than two
decimals, marks and "absent" together, marks for a student of another class or
section, changes after results are published, and lowering a paper's maximum below
a mark already given.

**Result calculation** (in the database, `private.exam_results`):
- **Subject:** percentage = marks ÷ maximum; grade from the scale; **passed** when
  marks ≥ passing marks. **Absent** counts as 0 and as not passed (shown as AB).
- **Total** = sum of marks; out of = sum of the class's maximum marks.
- **Percentage** = total ÷ out of × 100, rounded to 2 decimals. **Grade** from the scale.
- **Result:** **Pass** when every subject is passed, **Fail** otherwise, and
  **Incomplete** while any mark is missing.
- **Rank** by percentage within the section (equal percentages share a rank).
- Results can't be published while any active student is missing a mark; the
  message names the first one (e.g. "2 mark(s) are missing (for example Dev in
  Class 5 – B, English)").

**Result generation:**
- *Results* tab: per section, every student with subject marks, total, %, grade,
  result and rank, plus the number passed / failed / incomplete and the class average.
- **Result sheet** (PDF, landscape): the whole section on one sheet.
- **Report cards** (PDF): one page per student (or all of a section at once), with
  subject marks and grades, total, percentage, grade, result, rank "N of M" and
  signature lines.
- **Students** (*My school record → Exams / Results*) and **parents**
  (*child page → Exam results*) see date sheets once scheduled, and their own result
  and report card once published, never anyone else's. Rank is still computed over
  the whole section.

## Online fee payments (Razorpay)

Parents pay school fees from the parent portal (child → **Fees** → **Pay online**) by
**UPI, debit/credit card or net banking**, through [Razorpay](https://razorpay.com),
a payment gateway widely used in India. Each school uses **its own Razorpay account**, so the
money goes straight to the school.

**Setting it up (school admin, Settings → Online payments):**
1. In the Razorpay Dashboard, generate API keys (start with **test** keys). Enter the key id
   and key secret; they are checked with Razorpay when you save.
2. In Razorpay → Webhooks, add the webhook URL shown on the page (it ends in
   `/api/v1/payments/webhooks/razorpay/<school id>`), choose a secret, enter the same secret
   here, and select the events `payment.captured`, `payment.failed`, `order.paid`,
   `refund.processed`, `refund.failed`.
3. Tick **Let parents pay online** and save. Make a test payment, then switch to live keys.

The server needs `SECRETS_KEY` (see the environment table). The secrets are stored
encrypted and are never shown again; leave the fields empty to keep them.

**How a payment works:**
1. The parent ticks the fees to pay (overdue ones are pre-selected). The browser sends only
   *which* fees; the **database works out the amount** from what is still owed and creates
   the payment order (the same fees within 30 minutes reuse the same order).
2. The API creates a Razorpay order and the browser opens Razorpay Checkout with the
   **key id and order id only** (UPI, cards and net banking are shown).
3. When Checkout reports success, the API checks the **signature** with the key secret and
   then **fetches the payment from Razorpay** and checks the order, amount, currency and status
   (an authorized-only payment is captured for exactly the order amount). Only then is the
   **fee receipt** recorded (mode "Online payment", reference = Razorpay payment id), in the
   same numbering as office receipts. The parent sees the receipt at once and can download it.
4. **Webhooks** record the same result if the parent closes the window, loses connection
   or the browser never returns. Checkout, webhook and re-checks can all arrive: one order
   gives **one receipt**, never two.
5. A failed attempt can be retried in the same window. If the window is closed, the page
   asks the server (which asks Razorpay) before saying anything; parents also get a
   **Check status** button for unfinished payments.

**If something doesn't add up**, nothing is counted silently: a payment for fees that were
paid at the office in the meantime, or an amount that doesn't match the order, is marked
**Needs review** (money received, no receipt) for staff to refund.

**Staff (Fees → Online payments):** every online payment with its status (Paid, Not
completed, Failed, Needs review, Refund in progress, Refunded, Refund failed, Cancelled),
Razorpay ids, how it was confirmed (payment window, webhook, re-check), the receipt and
refunds; totals received and refunded; **Check with Razorpay** for unfinished ones
(accountants and admins).

**Refunds (school admins):** full refunds through Razorpay, with a reason. The receipt is
**cancelled** (marked on the PDF, kept on record with what it had paid), the fees it paid
become due again, and it no longer counts in collections, reports or the dashboard. Refunds
that Razorpay processes later are completed by webhook; a failed refund can be retried.
Partial refunds are not offered: to give part of a fee back, refund in full and the parent
pays the right amount again.

**Payment history:** parents see their child's online payments (status, method, receipt,
refunds) and all receipts; office receipts and online ones appear together in the
Payments register, with cancelled ones marked and not counted.

**Not included:** paying the admission fee online from the public application pages
(it is still recorded by staff), partial refunds, and settlement reports (use the Razorpay
Dashboard).

**Database role:** gateway results are recorded through functions that only the Postgres
role `erp_payments` may run; the API switches to it after verifying with Razorpay. The
migration grants this role to the user that runs it (normally `postgres`, the user in
`DATABASE_URL`). If your API connects as a different user, run
`grant erp_payments to <that user>;`.

## Library

The school library: the catalogue, every physical copy, issues and returns, renewals, fines,
and each borrower's history.

**Who does what**

| | Runs the library (catalogue, issue, return, renew) | Fines: see and collect | Waive fines, set the rules | Library dashboard | Catalogue and own books |
|---|:-:|:-:|:-:|:-:|:-:|
| School admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| Librarian | ✓ | ✓ | | ✓ | ✓ |
| Accountant | | ✓ | | ✓ | ✓ (catalogue) |
| Teacher | | | | | ✓ |
| Parent / student | | | | | their child's / their own books, in the portal |

A **librarian** is a staff member with **Library duty**: on the Teachers page, open the staff
member (they need a login) and tick *Library duty*. It gives the `librarian` role, which reaches
the library and nothing else — no student records, fees or marks. A staff member who only runs
the library can be added the same way.

**Catalogue (Library → Catalogue).** A book has a title, authors, category, ISBN, publisher,
edition, year, language, shelf and description. The ISBN is checked (ISBN-10 or ISBN-13, with
the check digit) and stored as ISBN-13, so searching by either form finds it; one ISBN per
school. Each **copy** has an **accession number** — typed in (when the books already carry
numbers) or given automatically (ACC-000001, ACC-000002…) — an optional price (charged if it
is lost) and the date acquired. Copies are *Available*, *Issued*, *Damaged*, *Lost* or
*Withdrawn*; a title can be withdrawn from the catalogue. A copy or book that has ever been
issued is never deleted, so the history stays complete.

**Issue & return (the desk).** Scan or type an accession number:
- on the shelf → choose the borrower (search by name, Student ID, admission number or employee
  ID) and issue; the due date comes from the rules and can be changed;
- on loan → **Return** (condition good / damaged / lost; any fine is worked out by the system)
  or **Renew**.

Before issuing, the database checks: the copy is available; the borrower is an active student
of the current session or active staff; the borrowing limit; not two copies of the same book;
and (if switched on) no overdue book and no unpaid fine.

**Rules and fines (Library → Settings, set by the school admin).** Loan period and books at a
time (students and staff separately), renewals allowed, fine per day late, grace days, an
optional maximum fine per book, and whether overdue books / unpaid fines stop new loans. There
are **no fines until the school sets a rate** (default ₹0). The fine is
*days late beyond the grace days × the rate*, capped at the maximum, using the rate in force
**when the book was issued** — changing the rate never changes existing loans. A lost book is
charged the copy's recorded price (or the amount entered); a damaged one optionally a charge.

**Collecting fines** (librarian, accountant or admin): Library → Loans → *Fines to collect* →
**Collect**, with how it was paid (cash, UPI, card, bank transfer, cheque; a reference for
anything but cash). Each payment gets a receipt number (LIB-000001…). Only school admins can
**waive** a fine, with a reason that stays on the loan.

**Loans (Library → Loans).** On loan, overdue, returned, fines to collect, fines settled, or all;
search by borrower, book, accession or receipt number; download as CSV.

**Student history.** Library → Borrowers → a student or staff member: what they have now, every
past loan with dates, condition and fines, what they owe, and why they can't borrow (if they
can't); issue a book from there. Parents see each child's books, due dates, history and fines in
the parent portal (child → **Library**); students see their own under **My school record →
Library**; staff see their own books under Library → My books.

**Dashboard (Library → Dashboard; the librarian's home page).** Total books (copies, titles,
lost, damaged), issued (borrowers, issued today), available (returned today), overdue, and
fines (to collect, building up on overdue books, collected this month); books by category and
the most borrowed in the last 90 days. Every figure is counted in the database.

**Overdue reminders.** When a student's book becomes overdue, the family and the student get one
**Library book overdue** message (Phase 22 notifications: in the app and by email by default;
SMS and WhatsApp if the school switches them on). Not sent if the book is returned first.

**Not included:** barcode label printing, reservations/holds, a public OPAC, inter-library
loans, and looking up book details from the ISBN online.

## Transport

School buses and vans: vehicles and their papers, drivers and attendants, routes and stops,
which students ride where, and the transport fee. **No live GPS tracking** — that is not part of
this module.

**Who does what**

| | Set up vehicles, staff, routes, stops, fares; assign students | See routes, vehicles, riders, dashboard | Vehicle and driver documents | Their child's / own transport |
|---|:-:|:-:|:-:|:-:|
| School admin | ✓ | ✓ | ✓ | |
| Accountant | | ✓ (drivers: names, phones, routes only) | | |
| Parent / student | | | | ✓ (portal) |
| Teacher, librarian | | | | |

**Fare zones (Transport → Fare zones).** Stops that cost the same are grouped into a zone, e.g.
*Zone A ₹1,200 a month*. A zone is charged every month (untick months with no transport, such as
the summer vacation), every quarter, every half-year or once a year (choose the first month due).
Each zone becomes a fee head named **Transport – *zone name***, so transport fees appear on the
fee desk, receipts, online payment, reports and fee reminders exactly like other fees. Zones are
never deleted (old receipts keep their names); one that is no longer used is marked *not in use*.

**Vehicles.** Registration number (typed any way — `dl 1p c-1234` is stored as `DL1PC1234`, one
per school), type, student seats, make and model, year, owned by the school or a contractor, and
status (*in service*, *in maintenance*, *retired*). A retired vehicle can't be on a running route.

**Drivers and attendants.** Name, mobile (families see it), other phone, date of birth (18 or
older), address, joining date, status. A driver needs a **licence number** and the date it is
**valid until**; a driver with an expired licence, or an inactive one, can't be put on a route.
Someone on a running route can't be made inactive until the route has someone else.

**Documents.** Upload scans or photos (PDF, JPEG, PNG or WebP, up to 10 MB) with the number,
issue date and expiry date:
- vehicles: registration certificate (RC), insurance, pollution certificate (PUC), fitness
  certificate, permit, road tax, other — the first five are expected for every vehicle and
  missing ones are listed;
- drivers and attendants: driving licence, police verification, medical certificate, ID proof,
  address proof, other.

Files are private (only school admins can open them; every view and download is recorded). The
dashboard's **Papers and licences** list shows expired papers, papers and licences expiring in
the next 30 days, and missing vehicle papers.

**Routes and stops.** A route has a name, an optional code (R1), a vehicle, a driver and an
attendant, and is *running* or not. Stops are added in the order the vehicle reaches them in the
morning (reorder with the arrows), each with a landmark, pickup and drop times and its fare zone.
A route or stop that students have used can't be deleted (it stays for their records) — mark the
route as not running instead. **Print route sheet** gives the driver and attendant today's riders
stop by stop, with a tick box and the family's phone number.

**Assigning students.** From the route page (*Add student*, or *Add a student here* on a stop),
Transport → Students → *Assign student*, or the student's page → **Transport**: choose the route,
stop, pickup and/or drop, the start date, and whether to **charge the fee** (untick for free
transport). The database refuses:
- a student who isn't active and enrolled in an open session that includes the start date;
- a stop that isn't on the route, or a route that isn't running;
- a **full vehicle** — riders on that route on the start date (or today, if later) already fill
  its seats. Reducing a vehicle's seats below its riders, or giving a route a smaller vehicle, is
  refused the same way.

**Changing a stop or route.** *Move to another stop or route* starts a new assignment from a date;
the current one ends the day before, so earlier months keep the old fare. *Edit stop, trip or fee*
corrects the current assignment for its whole period. *Stop transport* sets the last day;
transport that hasn't started yet can be removed.

**How the transport fee is charged.** Dues are created in the database from the assignments:
- one due per billing month that the student rides in (a month with a later move belongs to the
  new stop's zone), at that zone's fare; nothing for months before the start or after the end;
- changing a zone's fare, moving a stop to another zone or ending transport updates the
  **unpaid** dues; **paid dues never change**.

Everything is counted from the school's own zones — no amounts are built in.

**Dashboard.** Students using transport, seats in service and full routes; routes and stops;
vehicles (in maintenance); drivers and attendants; this session's transport fees (billed, due
till now, collected, overdue); and the papers list.

**Families.** Parents see each child's route, stop, pickup and drop times, vehicle, the driver's
and attendant's names and phone numbers, and the fee, in the parent portal (child →
**Transport**); students see theirs under **My school record → Transport**. They never see other
children, licence numbers or documents.

**Not included:** live GPS tracking, route optimisation and maps, attendance on the bus, fuel
and maintenance logs.

## Inventory

What the school owns or keeps in stock — computers, furniture, laboratory equipment, sports
gear, stationery, electronics and anything else — with where it is, its condition, who is
responsible for it, what it cost, and every stock movement.

**Who does what**

| | Add and edit items, stock in / out | See items, history, dashboard | Items assigned to them |
|---|:-:|:-:|:-:|
| School admin | ✓ | ✓ | ✓ |
| Accountant | | ✓ | |
| Teacher, librarian (any login linked to a staff record) | | | ✓ (on My profile; teachers also on My classes) |
| Parent, student | | | |

**Items (Inventory → Items → Add item).** Each item has:
- a **code** given by the system (INV-00001, INV-00002… per school);
- name, **category** (Computer, Furniture, Laboratory, Sports, Stationery, Electronics, Other);
- what it's **counted in** — pieces, sets, pairs, boxes, packs, reams, dozen, rolls or bottles
  (whole numbers only), or kg, litres and metres (decimals allowed);
- **location**, typed freely, with the school's existing locations offered as suggestions;
- **condition** (new, good, fair, needs repair, damaged, unusable);
- the **staff member it is assigned to** (optional; active staff only);
- brand / model, serial number, description and notes;
- a **reorder level** (optional; at or below it the item shows as *low stock*);
- **purchase date, cost per unit and vendor**.

An item can be added with the stock it arrives with — purchased, already in stock (opening) or
donated — with the date, cost, vendor and bill number.

**Quantity is never typed in.** It changes only through **Stock in** and **Stock out** on the item
page, so every change is in the history:
- **Stock in** — purchase, donation, returned, found, opening stock, or an adjustment after a
  recount — with the date, cost per unit, vendor and bill / voucher number. A purchase updates the
  item's purchase date, cost and vendor (unless it is dated before the latest one).
- **Stock out** — issued (to a staff member, or to a class, room or event — one is required), used
  up, damaged, lost, disposed of, returned to the vendor, or an adjustment — with the date and an
  issue slip number.

The database refuses taking out more than is in stock ("Only 5 reams of A4 paper in stock"), a
future date, a fraction of a counted unit, and any stock movement on an archived item. Each entry
records the balance after it and who recorded it.

**History.** The item page lists every stock in and out, and every change of location, condition,
assignee or name, and archiving ("Location: Computer Lab → Staff room"). History can't be edited or
deleted — a mistake is put right with an adjustment. **Inventory → Stock history** shows movements
across all items, filtered by in / out, reason, category, dates and a search (item, bill number,
vendor, person), and downloads as CSV.

**Archiving and deleting.** An item that is no longer stocked or has been written off is
**archived**: hidden from the lists (see *Archived*), its history kept, restorable at any time. Only
an item entered by mistake — nothing recorded beyond its first stock — can be deleted.

**Dashboard.** Items in use (assigned to staff, archived); **stock value** (quantity × the latest
cost per unit, with a count of items that have no cost yet); low stock; out of stock; items needing
attention (needs repair, damaged, unusable); value by category; purchases this month and this
financial year (April–March, from stock-in entries marked as purchases); stock in / out this month;
the low-stock and needs-attention lists; and the latest movements. Every figure comes from the
school's own entries — nothing is built in.

**Lists and CSV.** Items: in use, low stock, needs attention, assigned, archived or all; filtered
by category and condition; searched by name, code, brand or serial number; downloadable as CSV with
code, quantity, unit cost, value, purchase date, vendor, location, condition and assignee.

**Staff.** A staff member sees the items assigned to them — with code, serial number, location and
condition — under **School items in your care** on My profile (and on My classes for teachers).
They see nothing else in the inventory.

**Not included:** barcode / QR labels, purchase orders and approvals, supplier records,
depreciation, maintenance schedules, and moving stock between several stores as separate stock
counts (an item has one location; record a move by changing it).

## Staff leave and attendance

**Who does what**

| | Apply for own leave, see own balance and history | Decide leave, balances, leave types, holidays, staff attendance |
|---|:-:|:-:|
| School admin | ✓ (if linked to a staff record) | ✓ |
| Teacher, accountant, librarian | ✓ (if linked to a staff record) | |
| Parent, student | | |

Leave belongs to a **staff record** (the Teachers page). A login linked to one sees **My leave**;
anyone else sees a note asking the office to link it. Admins can also record leave for anyone,
including staff without a login.

**Leave types (Staff leave → Leave types).** Name, code (CL, SL, LWP…), days allowed per
**session** (the leave year is the academic session) or *no limit*, paid or unpaid, half days
allowed or not. One person can get a different allowance for a session (Balances → click the
number) — for someone who joined mid-year, carried leave forward, or has a different entitlement.

**Working days.** Leave counts working days only: the **weekly offs** (Sunday by default; up to
three days) and the school's **holidays** (Staff leave → Holidays & week) aren't counted. A leave
that falls only on offs and holidays is refused.

**Applying (My leave → Apply).** Type, dates (or a half day), reason; the form shows how many working
days it takes. The database refuses: more than the balance (pending leave counts against it),
overlapping leave, a half day for a type that doesn't allow it or over more than one day, dates
across two sessions, and leave in a month whose payroll is finalized. Staff can cancel their own
pending leave, or approved leave that hasn't started; the office can cancel approved leave.

**Deciding (Staff leave → Requests).** Approve, or reject with a reason the staff member sees.
Nobody can approve or reject **their own** leave — another administrator must. Approved leave is
taken from the balance; paid leave costs nothing in payroll, unpaid leave is loss of pay.

**History and balances.** All leave with filters (status, session, staff) and CSV; a balance table
(available / allowed for every person and type); click a name for their balances and every
application with who decided it and when.

**Staff attendance (Staff attendance).** A daily register: present, absent or half day for each
active staff member, with approved leave shown alongside; *Mark the rest present*; not for future
dates; weekly offs and holidays are shown as such. A monthly summary lists present / absent / half
days per person.

## Payroll

**Only this school's administrators** can see or do anything in payroll — not accountants, not
teachers, and not platform super admins (who run the service but have no business reading a
school's salaries). The database enforces this with row-level security, and the API checks it
too. Every payroll action and every salary slip download is recorded in the audit log.

**Allowances and deductions (Payroll → Allowances & deductions).** The school's own components,
each a fixed amount or a percentage of basic, e.g. House rent allowance 40% of basic, Transport
allowance ₹1,600, Provident fund 12% of basic, Professional tax ₹200. Nothing is built in;
statutory rates are entered by the school as they apply.

**Salary structures (Payroll → Salaries → a person).** Basic salary plus the components that apply
(each with its own value), from a month. A revision (an increment) is a new structure from a later
month, so earlier months keep the old pay. A structure used by a finalized payroll can't be edited.

**The monthly payroll (Payroll → Monthly payroll → Calculate).** For every active staff member with
a salary structure, using the structure in force on the month's last day:
- **Days:** working days (not weekly offs or holidays); present, absent and half days from staff
  attendance; paid and unpaid leave from approved leave; days before joining.
- **Loss of pay (LOP)** = absent days + ½ for each half day + unpaid leave days + working days
  before joining (+ days with no attendance marked, if the school counts them as absent — Payroll →
  Settings; by default they count as present). Paid leave and holidays cost nothing.
- **Earnings** are paid for (basis days − LOP) / basis days, where the basis is the month's working
  days or its calendar days (Payroll → Settings). The difference from the full month shows on the
  slip as the **leave / absence deduction**.
- **Deductions:** percentage deductions (e.g. PF) on the basic actually earned; fixed ones as set.
- **Adjustments:** one-off additions (exam duty, arrears) or recoveries (an advance) on a draft
  payslip, each with a description.
- **Net pay** = earnings − deductions ± adjustments.

A draft can be recalculated any time (after attendance or leave changes); adjustments are kept. A
month can be **finalized** from its last day, once no leave for it is pending and no payslip is
negative. Finalizing locks the month: its staff attendance, holidays, leave decisions and payslips
can't change. A finalized payroll can be **reopened** with a reason (kept with it), or **marked
paid** (date, mode — bank transfer, cheque, cash, UPI — and reference), after which it is closed for
good. A draft can be discarded.

**Salary slips and register.** Each payslip downloads as a PDF salary slip (school name and logo,
staff details, days, earnings full and earned, deductions, adjustments, net pay in figures and
words). The **salary register** for the month downloads as CSV (one row per person, for the bank).

**Not included:** staff seeing their own payslips (payroll is admins-only, as asked), bank file
formats for specific banks, statutory returns (PF / ESI / TDS filings), loans with instalment
schedules, and leave carry-forward or encashment as automatic rules (set a person's allowance
instead).

## Certificates and ID cards

**Who:** school admins only (and the platform's super admin). Accountants, teachers, parents and
students can't see or issue certificates or cards; the database enforces this with row-level
security as well as the API. Everything is recorded in the audit log.

**Settings (Certificates → Settings, shared with ID cards).** The principal's name and title printed
under the signature, a **signature image** (PNG/JPEG/WebP up to 2 MB, cleaned and stored privately),
the place printed on certificates (empty = the school's city), the colour, how long ID cards are
valid (empty = the end of the current session) and a note for the back of the card. The **school
logo**, name, address and affiliation come from School settings.

**Certificates (Certificates → Issue).** A school starts with four templates it can reword:
**Bonafide** (BC-2026-0001 …), **Character** (CC-), **Transfer** (TC-) and **Study** (SC-). Add any
number of **custom certificates** (merit, sports, participation …) with their own title, letter prefix
and wording. Wording uses `{{placeholders}}` — the student's name, father's / mother's name,
son/daughter and he/she, date of birth in figures and words, student ID, admission number and date,
first admission and class, class and section, session, address, school, place, date, number,
purpose, principal — inserted from a list in the editor. A template can also ask for **extra fields**
when issuing (text or date, required or optional), e.g. the TC's date of leaving, reason and conduct;
an optional field left empty drops its whole line ("Remarks: …" simply isn't printed). Unknown or
unclosed placeholders are refused when saving.

To issue: choose the certificate, the session and the student (search, or **Certificate** on a
student's page), the date and purpose and any extra fields, **Preview**, then **Issue**. The wording is
filled in **by the database from the student's records** — the browser only says which student —
and if something the wording needs isn't recorded (no address, not enrolled in that session) issuing
stops and says what's missing. On issue the certificate is **numbered** per prefix and year, and its
wording, values and signatory are **fixed for good**: an issued certificate can't be edited or deleted,
only **revoked** with a reason, and a used template can only be switched off. Rules:
- a **transfer certificate** can mark the student as having left (inactive, with the TC number as the
  reason); a student holds **one valid TC** at a time (revoke it to issue another);
- a **bonafide** certificate is only for current (active) students; character, study and custom
  certificates can also be given to former students;
- the date can't be in the future (or more than a year back).

The **Issued** tab lists every certificate (type, status and text search, CSV), shows it, prints or
downloads it as a **PDF** and revokes it. The PDF is A4: letterhead with the logo, number and date,
the title, the wording, the student's photo (if the template shows it), place, the signature, name and
title of the signatory, and a **QR code**. A revoked certificate's PDF carries a REVOKED watermark.

**ID cards (ID cards).** Standard card size (CR80, 85.6 × 54 mm, portrait), nine to an A4 sheet with
cut marks, optionally with the **back** on a second sheet mirrored for double-sided printing.
- **Student ID:** photo, name, class and section, student ID, father's (or mother's) name, date of
  birth, phone; the back has the school's address, the emergency contact and the note.
- **Teacher ID** (teaching staff) and **Staff ID** (non-teaching staff — set "Staff type" on the
  Teachers page — plus transport drivers and attendants): photo, name, designation (also on the
  Teachers page), employee ID, phone; drivers' and attendants' first card gives them a number
  (T-0001) that later cards keep.
- Every card has the logo, the signature and a **QR code**, and a "valid until" date.

Pick a class, search, or tick people, then **Print cards**. Printing again **reuses** each person's valid
card (same number and QR code); **Issue new cards** replaces them (lost card, new photo), and the old
card then shows as *replaced* when scanned. A card can be **revoked** (e.g. lost). Only active
students and staff get cards; one valid card per person. **Issued cards** lists all cards with their
status (valid, expired, replaced, revoked).

**QR verification (`/verify/<code>`, no login).** The QR code on every certificate and card opens a
public page showing whether it is genuine and still valid (or revoked / replaced / expired), with the
document type, number, name, class or post, dates and school — **never** the wording, date of birth,
parents, address or phone. Codes are 32 random characters (they can't be guessed or listed), and the
page is rate-limited.

**Not included:** bulk issue of certificates for a whole class, editing the wording of one certificate
at issue time (edit the template, or add an extra field), digital signatures (the PDF carries a
scanned signature and the QR check instead), card printer formats other than A4 sheets, and RFID /
barcode attendance with the cards.

## The app on phones (installable web app)

The school ERP is a **Progressive Web App**: the same site, installable on Android, iPhone/iPad and
desktop computers from the browser — no app store, no separate native apps, nothing extra to keep up
to date (every visit gets the latest version).

**Installing.**
- **Android (Chrome, Edge, Samsung Internet) and desktop Chrome/Edge:** the dashboard shows *Get the
  app* with an **Install app** button (the browser's own install dialog); also in My profile → This
  device, or the browser's menu → *Install app*.
- **iPhone / iPad (Safari):** the dashboard explains the two taps: Share → **Add to Home Screen**.
- The installed app opens full-screen at the dashboard with its own icon, name, colours and **launch
  screen** (Android builds it from the icon; iPhones and iPads get prepared launch images for current
  models). Long-press the icon for shortcuts: Notifications, Notices, Home.
- The install card speaks to each person: parents hear about their child's attendance, fees and notices,
  teachers about classes and homework, admins about fees and attendance. "Not now" hides it for 30 days.

**Made for each kind of user on a phone.** A bottom tab bar under the thumb, different for each person
(the full menu is always under **More**):

| Who | Tabs |
|---|---|
| Parents | Home · Children · Notices · Alerts |
| Students | Home · Homework · Timetable · Results (straight to that part of their record) |
| Teachers | Home · My classes · Timetable · Homework |
| School admins | Home · Students · Collect (fees) · Attendance |
| Accountants | Home · Collect · Payments · Students |
| Librarians | Home · Library · Notices · Alerts |

Plus: room for the notch and the home indicator, 44-pixel tap targets, dialogs that open as bottom
sheets, messages that appear above the tab bar, the unread count on the app icon (where the phone
supports it), and the UI font served from the site itself (no third-party font service; faster on slow
networks, and it works offline).

**Offline.** The app's code, fonts and icons are kept on the device, and the pages you opened recently
open again without a connection; a banner says you're offline, and anything that needs the server says
so plainly. A page never opened shows a friendly offline page that reloads by itself when the
connection returns. **Personal data — fees, marks, attendance, names — is never stored on the device**:
it is always loaded live, after sign-in. That keeps shared and family phones safe and never shows an
out-of-date balance. Signing out clears the stored pages. When a new version is deployed, the app shows
*A new version is ready — Reload* rather than changing under someone in the middle of a form.

**Push notifications** (where the device supports them: Android, desktop browsers, and iPhone/iPad
in the installed app on iOS 16.4 or later):
- Turned on per device, only after a tap: the dashboard card or **My profile → This device**. Nothing
  asks for permission on its own.
- Every in-app notification (the bell) is also pushed to that person's devices — so pushes follow the
  school's own notification settings and wording (Communication), with nothing extra to set up. Tapping
  one opens the right page.
- **Hide details on the lock screen** (per device): shows only "new notification from <school>" —
  for shared or family phones.
- **Send a test**, see your other devices, and turn any of them off. Signing out turns notifications
  off for that device, so the next person to use it never sees yours.
- Messages are encrypted for the device (standard Web Push); the push service (Google, Apple, Mozilla,
  Microsoft) only relays them and can't read them. The server only sends to those known services.
  A device that is gone (uninstalled, permission withdrawn) is removed automatically; one unreachable for
  20 attempts in a row is dropped and re-registers itself when the app is next opened.
- A notification already read in the app isn't pushed; pushes are kept for a day if the phone is off.

**Set-up:** HTTPS (any normal hosting; `localhost` works for development), and push keys in the backend:
```bash
cd backend && python -m scripts.generate_vapid_keys   # paste the three lines into .env
```
Without keys the app still installs and works offline; the push option says it isn't set up.
Icons and launch screens are generated from the brand colours by
`python frontend/scripts/generate-pwa-assets.py` (set `APP_NAME=...` to use another name; uses Pillow,
e.g. the backend's virtualenv) and are committed in `frontend/public/`.

**Not included (no native apps yet, as asked):** app-store listings, background sync of changes made
offline (changes need a connection; nothing is queued), per-school icons on a shared domain (one icon for
the platform), and push for people who never open the site on that device.

## Notifications (in-app, email, SMS, WhatsApp)

The school's messages reach people in four ways:

| Channel | How | Cost | Default |
|---|---|---|---|
| **In the app** | The bell at the top of every page and the **Notifications** page | free | on |
| **Email** | The platform's mail server (SMTP), sent in the school's name, replies to the school | free | on (homework: off) |
| **SMS** | The school's own **Twilio** account | per message part | off |
| **WhatsApp** | The school's own **WhatsApp Business** account (Meta Cloud API), approved templates only | per conversation | off |

No phone calls or voice messages are made by anything in the system.

**What is sent, and to whom**

| Message | When | Goes to |
|---|---|---|
| Fee reminder | Staff click **Send fee reminders** (Collect fees page, or Communication → History), or automatically on the days of the month the school chooses (after 9 am) | Parents of students with overdue fees; at most once a day per student |
| Payment confirmation | Any fee receipt, at the office or online | Parents |
| Attendance alert | A student is marked absent (today or yesterday) | Parents; not sent if the absence is corrected before the message goes out |
| Homework | Homework or an assignment is set | Parents and the student |
| Exam date sheet | An exam is scheduled | Parents and students of the classes in it |
| Exam results | Results are published (once a day at most) | Parents and students |
| Admission updates | An online application changes status (submitted, verified, approved, rejected, fee paid, enrolled) | The applicant's contact email / mobile, with a tracking link — no account needed |
| School notices | A notice is published (or its scheduled time comes) | Whoever the notice is for: everyone, parents, students or staff, all classes or some |
| Library book overdue | A student's library book passes its due date (once per book, from 9 am) | Parents and the student |

"Parents" are the student's linked guardian accounts. When none of them has a mobile number,
SMS and WhatsApp go to the mobile number on the student's record. A parent with two children
gets one message naming both. Students never get SMS.

**How it works.** Each of the changes above is recorded as an *event* by a database trigger
in the same transaction (a payment that is rolled back sends nothing; nothing is ever sent
twice for the same thing). A background sender, running inside the API (or separately with
`python -m scripts.notify_worker`), turns events into messages using the school's templates
and each person's choices, then sends them:
- temporary failures (network, provider busy) are retried after 1, 5 and 30 minutes, then the
  message stays **Failed** and an admin can **Send again**;
- **quiet hours** (default 9 pm–8 am India time) hold SMS and WhatsApp until morning;
- a **daily limit** per channel stops runaway costs (default 500 each);
- Twilio and Meta report **Delivered / Read / Failed** back to the API (signed reports only).

**Communication page (school admins)**
- **History:** every event with the number of people, in-app notifications sent and read, and
  each email / SMS / WhatsApp message with its status and error; send failed ones again.
- **Templates:** for each message and channel, switch it on or off and change the wording.
  Placeholders such as `{{student_name}}` or `{{amount}}` are listed for each message and are
  the only thing filled in (unknown ones are refused when saving). **Preview** shows the
  result with sample data and, for SMS, the number of parts. Amounts are written "Rs" in SMS
  (₹ would make every SMS a more expensive Unicode one). For WhatsApp, enter the name of the
  template approved in WhatsApp Manager and which values fill its `{{1}}, {{2}}…`; a suggested
  wording to submit is shown.
- **Channels:** email on/off and reply-to address; quiet hours, daily limits and automatic
  fee-reminder days; Twilio (Account SID, auth token, sender number or messaging service);
  WhatsApp (phone number ID, access token, app secret) with the webhook URL and verify token
  to paste into Meta; **Send a test message** to check a channel end to end.

**Setting up a channel**
- *Email:* set the `SMTP_*` and `EMAIL_FROM` variables on the server (any SMTP provider).
  Until then, emails are recorded as "Not sent".
- *SMS:* create a Twilio account, buy or register a sender, copy the Account SID and auth
  token into Channels → SMS, tick **Send SMS**, then switch SMS on for the messages you want
  under Templates. In India, bulk SMS needs a DLT-registered sender and templates; use a
  Twilio Messaging Service set up for that.
- *WhatsApp:* in Meta Business, add a WhatsApp number, create a system-user access token,
  submit templates for the messages you want, and enter the details in Channels → WhatsApp.
  In the Meta app's WhatsApp → Configuration, add the callback URL and verify token shown on
  the page and subscribe to `messages`. Then choose the approved template for each message.

**Everyone:** the bell shows unread notifications; clicking one opens the right page (the
child's Fees tab, the homework, the notice…). **My profile → Notifications** turns email, SMS
or WhatsApp off for that person (in-app notifications stay on).

**Secrets:** Twilio tokens, WhatsApp access tokens and app secrets are encrypted with
`SECRETS_KEY`, never shown again and never returned by the API. The sender reads them through
database functions that only the Postgres role `erp_notify` may run; the migration grants
this role to the user that runs it. If the API connects as a different user, run
`grant erp_notify to <that user>;`.

**Not included:** voice calls (deliberately), push notifications to phones, two-way chat,
per-school email servers, and message scheduling beyond notices and fee reminders.

## Admission CRM (enquiries)

A simple CRM for the school office, under **Enquiries** in the menu (school admins and
accountants). Each enquiry records:

| Field | Notes |
|---|---|
| Enquiry no. | `ENQ-00001`, numbered per school by the database |
| Parent name, student name | required |
| Phone | required, 10–15 digits (`+91 98765-43210` is stored as `+919876543210`); email optional |
| Interested class | one of the school's classes, or "not decided" |
| Source | walk-in, phone call, website, social media, newspaper, hoarding/banner, referral, school event, other — plus a free "source detail" (who referred them, which paper…) |
| Follow-up date | when to contact them next |
| Status | New → Contacted → Follow-up → Interested → Application → Approved / Rejected → Admitted |
| Notes | general notes about the family's needs |
| Session, enquiry date | the session defaults to the current one; the date to today |

**Working an enquiry** (the enquiry page): one *Update* box — what happened, the new
status, the next follow-up (Tomorrow / In 3 days / Next week buttons). Each update goes
into the enquiry's **history** with who did it and when; the history can't be edited.
Buttons to **call** (`tel:` link) or **WhatsApp** the parent, and to send the online
application link over WhatsApp. These open the phone's own apps; there is no automated
or AI calling.

**Rules (enforced by the database):**
- "Follow-up" needs a follow-up date; a new follow-up date can't be in the past.
- Rejected and Admitted close an enquiry and clear its follow-up date; it can be reopened.
- When an **online application** (Phase 19) arrives with the same mobile number as exactly
  one open enquiry of that session, they are **linked automatically**. Otherwise (e.g. two
  siblings' enquiries share a number) staff link it on the enquiry page. A linked
  enquiry's status follows the application: submitted/under review/verified →
  Application, approved/fee paid → Approved, rejected → Rejected, student created →
  Admitted. Its status can't be set by hand while linked (unlink first).
- An application can be linked to one enquiry only.
- Enquiries of an archived session can't be added or changed.
- Accountants can do everything except delete; only admins delete (with the history).
  "Rejected" is the usual way to close an enquiry.
- A new enquiry whose mobile matches earlier ones shows them, so duplicates are noticed.

**Pipeline dashboard** (Enquiries → *Pipeline*), for a session and optional date range:
- totals: enquiries (and new in the last 7 days), open, follow-ups due today, overdue,
  admitted with the conversion rate (of all enquiries and of closed ones);
- **admission funnel**: how many enquiries reached each stage (Contacted, Interested,
  Applied, Approved, Admitted) or went further, from the history — with the share of all
  enquiries and of the previous stage;
- **where enquiries are now**: count per current status; select one to open the list;
- follow-ups due (overdue first), enquiries by month (received and admitted),
  by source (with conversion) and by class.

The **home dashboard** shows admins and accountants the follow-ups due today and overdue.
**All enquiries** lists them with status tabs (with counts), follow-up filter (overdue,
due today, next 7 days, open without a date), source, class, search by name, enquiry
number or mobile, and **CSV export**.

## Online admission

**For parents (no account needed):** the school shares one link,
`https://<your-site>/apply/<school code>` (shown with a *Copy* button under
**Admissions → Settings**). The form has six parts:

1. **Class preference** — only the classes the school has opened, with the admission
   fee, seats left and last date; the school's instructions for that class
2. **Student information** — name, date of birth (age 2–20), gender, blood group
3. **Parent information** — father's and mother's name, mobile and occupation (at least
   one parent), a contact mobile (required) and email (optional)
4. **Address** — house/street/area, city, state, 6-digit PIN
5. **Previous school** — name, class, board (optional)
6. **Photo and documents** — the child's photo (required; JPEG/PNG/WebP) and up to 8
   documents (birth certificate, transfer certificate, previous report card, address
   proof, parent's ID proof, other; PDF/JPEG/PNG/WebP, 10 MB each)

and a declaration that the information is correct. On submit the parent gets an
**application number** like `ADM2026-00001` (prefix + session start year + a
per-session counter). With that number **and the contact mobile** they can check
the status at `/apply/<code>/track`: a progress bar, the dates of each step, the
rejection reason if rejected, and the fee to pay once approved.

**Workflow** (enforced by the database, not just the screens):

```
Application → Review → Verification → Approved / Rejected → Fee payment → Student created
 submitted    under_review  verified      approved   rejected    fee_paid       enrolled
```

- Steps can't be skipped or reversed. A **rejection needs a reason** (the parent sees
  it); a rejected application can be **reopened** to review.
- **Approving** takes a seat: when the class's seats are all taken, approval is refused.
  The admission fee is fixed at approval from the class's settings.
- **Fee payment:** an accountant or admin records exactly the approved amount, the mode
  (cash, UPI, bank transfer, cheque, other), reference and date (not in the future).
  A receipt number `ADR-00001` is generated and a **PDF receipt** can be downloaded.
  There is no online payment gateway; the parent pays at the school office.
- **Create student** (admins): choose the section; the admission number defaults to the
  application number. The student record, enrollment, photo and documents are created
  from the application, and the parent can be invited to the parent portal by email.
  The application is then complete and locked.
- Before completion, admins can **correct details**; the class can't change once approved.
- Every step is recorded with who did it and when (history on the application page) and
  in the audit log.

**For the school (Admissions in the menu):** status tabs with counts (New, Under review,
Documents verified, Approved, Fee paid, Student created, Rejected), search by name,
application number or mobile, class and session filters; the application page shows the
photo, documents (view/download), all details, the fee and the history, with the next
allowed actions.

**Settings:** per class and session — open/closed, admission fee (0 = none), seats
(empty = no limit), last date, instructions for parents. Applications are accepted only
for open classes, before the last date, in a session that isn't archived.

**Abuse protection on the public form:** requests run as the database's `anon` role,
which can't read or write any table — only three functions in the `intake` schema;
every file is checked and re-encoded before it is stored; a hidden field catches
simple bots; the same child (name + date of birth + mobile) can't be submitted twice
while an application is open; and submissions and status look-ups are rate-limited
per client IP (`ADMISSION_SUBMITS_PER_HOUR`, default 10; `ADMISSION_LOOKUPS_PER_10MIN`,
default 30). The client IP is the socket address; if the API runs behind a reverse
proxy or load balancer, set `TRUSTED_PROXY_HOPS` to the number of proxies so the
right `X-Forwarded-For` entry is used (the header is otherwise ignored, because
clients can forge it). The limiter is in memory, per backend process: with several
processes or servers, also rate-limit `/api/v1/public/` at your proxy or WAF.

## Report cards

**What a report card shows** (one A4 page per student; the layout tightens
automatically so long subject lists still fit):
- **School logo** (from the school profile), school name, address, contact and affiliation
- **Student photo** (an empty frame with initials when none is on file) and **student
  details**: name, class & section, admission no., Student ID, date of birth, father's
  and mother's names, class teacher
- **Subjects** with maximum marks, pass marks, **marks** obtained (AB = absent),
  **grade** and pass/fail per subject
- **Total**, **percentage**, overall **grade**, **result** and **rank in section** (if
  the template shows rank)
- **Attendance**: days present out of days recorded, from the start of the session
  to the exam's last paper (or today, if earlier)
- **Class teacher's remarks** and **principal's remarks**
- The **grading scale**, **signature** lines (class teacher's name; principal's name and
  uploaded signature image; parent) and the date of issue

Everything comes from the database: marks and results from the exam (Phase 17),
attendance from attendance records, remarks as written. Nothing is made up.

**Templates** (school admins, **Report cards** in the menu):
- Any number of named templates; one is the **default**. A school starts with
  "Standard". **Duplicate** copies the current one.
- **Customise:** layout (*Classic*: white header and double border; *Modern*:
  coloured header band), accent colour, title on the card ("Report Card", "Progress
  Report" …), and switches for logo, photo, rank, attendance, subject grades, pass
  marks, grading scale, teacher remarks and principal remarks.
- **Signatures:** three labels (empty = hidden). The second is the principal's: their
  name and an uploaded signature image (re-encoded PNG, kept in a private bucket and
  only read by the server).
- **Footer note**, e.g. "This is a computer-generated report card."
- **Preview:** the template with clearly fictional sample data, watermarked SAMPLE.
- Each exam uses the default template unless another is chosen on the exam's
  **Report cards** tab. Deleting a template makes its exams fall back to the default;
  the default itself can't be deleted.

**Remarks** (exam page → **Report cards** tab): every student of a section with their
result, a box for the **class teacher's remarks** (teachers of that section, and
admins) and one for the **principal's remarks** (school admins only). Saved for the
whole section at once, up to 500 characters each. The database enforces who may write
which remark, and remarks lock when results are published (unpublish to change).

**Printing:** *PDF* per student, or *All report cards* for the section (one page each),
any time for staff. Students (*My school record → Results*) and parents (*child page →
Exam results*) see the remarks and download their own report card once results are
published.

## Homework & assignments

**Setting work** (teachers and school admins, **Homework** in the menu, or the
Homework / Assignments tabs of a class under **My classes**):
- **Class / section** (teachers see only classes assigned to them), **type**
  (homework or assignment), **title**, **subject** (picked automatically when the
  teacher teaches one subject in that class), **description**, **deadline** (date
  and time, must be in the future), **maximum marks** (optional: leave empty for
  unmarked work) and **accept late submissions** (off by default).
- **Files for students:** PDF, photos (JPEG, PNG, WebP), Word (.docx), Excel
  (.xlsx), PowerPoint (.pptx) and text files, up to 10 MB each, 10 per homework.
- The teacher who set it can edit it, add or remove files, and delete it while no
  one has submitted. Admins can do this for any homework.

**Students** (**My school record → Homework / Assignments**): a list with status
(*To do, Submitted, Submitted late, Reviewed, Missed*) and deadline. Opening one
shows the instructions and lets them **download** the teacher's files and
**submit**: a written answer and/or up to 5 files (photos of handwritten work are
fine). They can change their work until the deadline (or later, if late work is
accepted, in which case it is flagged **late**) and until it is reviewed. After
that it is locked.

**Review** (the homework page): every student of the class with their status,
time submitted and marks. **Review** opens the answer and files; the teacher
enters **marks** (never above the maximum) and **feedback**. The student and their
parents see them straight away.

**Parents** (child page → **Homework**): each homework and assignment with its
status, marks and feedback, the teacher's files and what their child submitted.
Read only.

**Rules enforced by the database** (migration 0014, `supabase/tests/homework_test.sql`):
- Teachers see homework only for classes assigned to them, and can create
  homework only there. They can change, delete and review **only homework they
  set**. Who set it is recorded by the database and can't be changed.
- Students see only their own class's homework and **only their own
  submission**. They can't submit for anyone else or for another class, can't
  submit after the deadline unless late work is accepted, and can never set marks
  or feedback. Classmates never see each other's work.
- Parents see their own children's homework, submissions, marks and feedback,
  and can't submit or change anything.
- Teachers can't change a student's answer. Marks must be within the maximum,
  and the maximum can't later be lowered below a mark already given.
- Homework that has submissions can't be deleted or moved to another class.
  Submissions are never deleted. A teacher can't be unassigned from a class
  while their work there is waiting to be reviewed.
- Accountants and other schools see nothing.

**Files** are stored in the private `homework-files` bucket and are only ever
streamed through the API after these checks, with headers that stop browsers
running them. Each file's type is decided by its contents, not its name. Photos
are re-encoded (removing hidden metadata such as GPS), PDFs with scripts are
refused, and Office files are accepted only in the ordinary formats: no macros,
ActiveX controls or embedded objects, and no "zip bombs".

## Timetable

**Setup** (school admins, **Timetable → Setup**):
- **School day (periods)**, per academic session: order, name, start and end
  time, and whether it's a break. **Set up standard day** creates, for example,
  8 × 40-minute periods from 08:00 with a 30-minute lunch after period 4; any
  period can then be edited. Periods can't overlap ("This overlaps period 1
  (08:00 – 08:40)."), must end after they start, and a period that has lessons
  can't be deleted or turned into a break until they're cleared.
- **Subjects**, per school: name (unique, ignoring case) and an optional code.
  **Add common subjects** adds the usual twelve; existing names are skipped.
  Subjects are deactivated, not deleted, so old timetables keep their names.

**Class timetable** (**Timetable → Class timetable**): choose session, class
and section. Days run across (Monday–Saturday; Sunday appears only if used),
periods down the side, breaks as a full-width band. Admins click a slot to set
the **subject**, **teacher** and **room**, change it, or clear it. Only teachers
assigned to that class (under Teachers) are offered, and the teacher who
teaches the chosen subject there is listed first.

**Teacher timetable** (**Timetable → Teacher timetable**, admins): one
teacher's week across all their classes, with the number of lessons.

**Conflict detection.** While you choose, the slot editor checks the slot and
names any clash, and Save stays disabled until it's resolved:
- the **same teacher in two classes at the same time**
  ("E2E Teacher A is already teaching Class 9 – A in Period 1 on Monday."),
- the **same class with two subjects at the same time**
  ("Class 9 – A already has Mathematics in Period 1 on Monday."),
- the **same room twice at the same time** ("Room R-101 is already used by
  Class 9 – A in Period 1 on Monday."). Rooms are compared ignoring case and
  extra spaces, and stored upper-case.

The screen is only a convenience: the **database** enforces all three with
unique indexes (one lesson per class per slot, per teacher per slot, per room
per slot in the session), so two people saving at the same moment, or anyone
calling the API directly, still can't create a clash. It also refuses lessons
in a break, inactive subjects or teachers, teachers not assigned to the class,
and any change to an archived session. A teacher can't be unassigned from a
class while they still have lessons in it.

**Printable timetable.** Every timetable has **Print** (the menu, controls and
hints are hidden on paper) and **Download PDF** (landscape A4 made on the
server, the same on every printer, with the school name, session and print
date).

**Who sees what** (enforced by RLS, `private.can_view_section_timetable`):

| | Class timetables | Teacher timetables | Change |
|---|---|---|---|
| School admin | all | all | ✓ |
| Accountant | all | – | – |
| Teacher | only assigned classes; **My timetable** for their own week | own only | – |
| Parent | their children's classes (child page → Timetable) | – | – |
| Student | own class (My school record → Timetable) | – | – |

Another class or school answers "not found".

## School logos

Logos are uploaded through the API (Super Admin only), never directly from the
browser. Every file is decoded and re-encoded as a PNG of at most 512×512. That
strips hidden metadata such as camera GPS and rejects files disguised as images.
Accepted types: PNG, JPEG, WebP up to 2 MB. SVG is not accepted because SVGs can
carry scripts. Files go to the public `school-logos` bucket, because logos appear
on receipts and ID cards. Nobody but the server can write to it.

## The platform: schools, plans and isolation

```
Super Admin (platform)
  └─ Schools ── each one a separate tenant; every school record carries its school_id
       └─ School Admin ── added only by the super admin
            ├─ Teachers ── sign-in given on the teacher's record
            ├─ Accountants ── added in Settings → Staff sign-ins
            └─ Parents / Students ── sign-ins given on the student's record
```

**Super admin** (menu: Platform):

- **Schools:**
  - Add a school, edit it, and activate or deactivate it.
  - See each school's plan, where its subscription stands, its active students and its last activity.
- **School page tabs:**
  - **Overview:** contact, registration and sessions.
  - **Subscription:** start or change the school's subscription, its status, invoices, payments,
    cancellation, and every change with who made it (see below).
  - **Usage:** students and staff against the plan's limits, sign-ins by role, classes and
    sections, the last 30 days' activity (attendance days, receipts, fees, notifications,
    actions), files stored, and the last activity.
  - **Administrators:** invite one, or turn one off or on. A turned-off admin is locked out at
    once.
- **Plans, Invoices and Billing setup:** see [Subscriptions and billing](#subscriptions-and-billing).
- **Platform analytics:**
  - Schools, schools in use, students and sign-ins.
  - Recurring revenue (monthly and yearly, by plan; trials and ended periods count nothing).
  - Where subscriptions stand, renewals and trials due within 30 days, and subscriptions that
    need attention.
  - Monthly growth, schools in use per month, fees processed per month, the largest schools,
    and schools over their plan's limits.

**School admin:** Settings → **Plan and billing** shows the school's own subscription, invoices and
usage (no platform notes, no history, nothing about other schools). **Staff sign-ins** lists every staff sign-in. Accountants are added
and turned off there; administrators are shown as managed by the platform, and teachers as
managed on the teacher's record.

## Subscriptions and billing

**Nothing about money or limits is built in.** Prices, limits, trial and grace lengths, the tax
rate and the seller's details are all entered by the super admin. **A subscription's status is
never stored either:** the database works it out each time (`private.subscription_status`) from
the subscription's dates, its invoices and the payments against them.

**Plans** (Platform → Plans) have a monthly and a yearly price (before tax), a free-trial length,
a grace period, and what they allow:

| Feature | Kind | Enforced by |
|---|---|---|
| Students | limit (number, or no limit) | the database: adding or re-activating a student beyond it is refused |
| Teachers | limit | the database: adding or re-activating a teacher beyond it is refused |
| Storage (MB) | limit | the database: a new student document, homework file or transport paper that would go over it is refused (files from the public admission form count but are never refused: an applicant can't fix a school's plan) |
| WhatsApp notifications | on / off | the database: WhatsApp messages are not queued (marked skipped, with the reason); the API refuses to switch the channel on |
| Reports and exports | on / off | the API (and the menu hides them) |
| Analytics | on / off | the API and the database |
| AI assistant, Website builder | on / off | **settings only:** those modules aren't built yet; the setting is kept for when they are |

The **Basic / Professional / Enterprise** buttons are templates: they fill in the name and switch
features on (Basic: none; Professional: WhatsApp, reports, analytics; Enterprise: everything). You
still enter every number. A school with **no subscription recorded has no limits** (as before this
phase). Changing a plan's limits or features applies at once to every school on it; a new price
applies from each school's next invoice, unless the school has an agreed price.

**A school's subscription** (Schools → a school → Subscription): plan, monthly or yearly, an
optional agreed price, the school's GSTIN, and how it starts — with the plan's trial, no trial, or
a trial until a chosen date. Without a trial the first invoice is issued at once. Later: change the
plan or billing period (applies at once to what the school may use, and to the price from the next
invoice; nothing is prorated), extend or shorten a running trial, issue the next invoice early,
record payments (bank transfer, UPI, cheque, cash) and refunds, cancel an unpaid invoice (it keeps
its number), end at period end, cancel now, or reactivate.

**Statuses** (worked out, never set):

| Status | When | Access |
|---|---|---|
| Trial | the trial covers today | full |
| Active | a fully paid invoice covers today | full |
| Ends at period end | set to end; the paid period or trial still covers today | full |
| Payment due (grace) | nothing covers today, but it is within the plan's grace days after the last covered day — and never before the waiting invoice falls due | full |
| Expired | past that | **read-only** |
| Cancelled | cancelled now by the platform, or the period ended after "end at period end" | **read-only** |

A part-paid invoice doesn't cover its period; a refund can un-cover it. **Read-only** means every
change through the API is refused with *402* and a plain message, while reading and downloading
still work, and a banner on every page says so. The school's own billing (to pay) stays open, and
the platform super admin is never read-only. A school isn't deactivated automatically:
deactivating stays the super admin's decision.

**Invoices** are numbered `PREFIX/2026-27/00001` (one sequence per financial year), carry the
seller's and the school's details as they were on the day, and are taxed at the platform's rate:
CGST + SGST when the school is in the platform's state, IGST otherwise. The PDF is a tax invoice
(an "invoice" when the tax rate is 0). A first invoice is due after the platform's payment days; a
renewal on the day its period starts.

**Renewal:** every hour the API issues the next invoice for each continuing subscription once its
next period is within the platform's lead days (Billing setup), unless an unpaid invoice is already
waiting; expired, cancelled and "end at period end" subscriptions get none. It is safe to run any
number of times; the super admin can also run it from Billing setup.

**Paying online:** a school admin presses **Pay** on an invoice. The API opens an order in the
**platform's** Razorpay account for exactly what is still due, Checkout takes the payment, and the
payment counts only after the API has checked Checkout's signature *and* fetched the payment from
Razorpay (right order, amount, currency, captured — an authorized payment is captured for exactly
the order amount). Razorpay's **webhooks** (signed with the platform's webhook secret) record the
same payment if the browser never comes back, record failures, and record refunds made in the
Razorpay dashboard. Each webhook event is stored once by its id: a repeat is answered "duplicate"
and changes nothing; a payment is recorded once however it arrives. Billing setup lists every notice
received and what was done with it. Online payments are refunded in the Razorpay dashboard; refunds
of payments recorded by hand are recorded by hand.

**School admins** see their plan, status, what's included, usage against the limits, invoices (PDF,
Pay) and payments, and can **cancel at period end** or **keep** the subscription. Only the platform
can cancel at once or reactivate. Other roles see none of it.

**Moving from Phase 31:** an active or payment-due subscription's current period becomes an imported
invoice (paid for "active", unpaid for "payment due"); trials stay trials with their end date, and
cancelled stays cancelled. The old `max_students` becomes the Students limit with every other
feature included; old plans get 0 trial and 0 grace days — so a school whose period had already ended
(paid or not) shows as **expired**, read-only, until you set grace days, issue and record its renewal. Check Platform analytics →
Need attention after upgrading.

### How schools are kept apart

The same separation is enforced in three places:

1. **API: every route is scoped.**
   - A school route resolves the school from `X-School-Id` and requires an active membership with
     the right role in an **active** school.
   - Platform routes require the super admin.
   - The few personal routes (your profile and devices) and public routes (admission form,
     certificate check, signed webhooks) are listed by name in `backend/tests/test_tenancy.py`.
     A new route that forgets its scoping fails that test.
   - The test also calls **all 382 school routes** as each role of School A naming School B,
     with a deactivated school, and with no school named. Each is refused before any query runs.
2. **Database: row-level security, so even a bug in the API can't cross schools.**
   - Every table has RLS. Policies check the caller's role in the row's school, and only for
     an active school.
   - A row can't be moved to another school (a trigger blocks it).
   - Supabase's REST interface talks to the database directly, so this is the real boundary.
3. **Audits you can run at any time:**
   - **`supabase/tests/tenant_isolation_audit.sql`** runs on any database, including
     production, and rolls back. It checks the structure: RLS everywhere, no table open to
     anonymous users, views that respect RLS, definer functions with a fixed search path, and
     every `school_id` tied to a school. It then acts as one person of every role in every school,
     on every table that has a `school_id` (found from the catalog, so new tables are included):
     - nothing of another school is visible;
     - nothing of another school can be updated or deleted, even by a "blind" write that reads
       no column (where only the write rules apply);
     - none of their own rows can be moved into another school;
     - after deactivation, a school's own people see nothing of it.
   - **`backend/tests/e2e_support/tenant_api_audit.py`** (test stack) takes real School A
     records for every route with IDs in its path. It confirms School A's admin can open each
     page, then that School B's admin, accountant, teacher, parent and student can't, and that
     no answer contains the School A ID. It also sends every changing method on those addresses
     as School B's admin. Every answer must be a refusal (401/403), "not found" (404) or a refused
     body (422); anything else, even a 409, means the record was looked at for the other school.

**Found and fixed while auditing:**

- (Phase 32) Another school's staff could cancel a **pending leave application** by its id: the
  "is it your own leave?" check was NULL, not false, for someone with no staff record in that school
  (migration 0031). The audit caught it as a 409 on an approved leave; it now fails on any such answer.

- After a school was deactivated, its people could still read through the database:
  - their notifications, which can carry fee amounts and results;
  - a parent their guardian links;
  - a teacher their teacher record and class assignments.

  These rules now require an active school too. A person's own membership row stays readable,
  which is how the app explains the school is inactive.
- A school admin could create, change or remove **other school admins** directly through the
  database. Only the super admin can now; school admins still manage every other role in their
  own school.

## Authentication & permissions

**Sign-in flow:** the browser signs in with Supabase Auth (anon/publishable key
only). The session lives in HTTP cookies managed by `@supabase/ssr`; the
middleware re-validates it with Supabase on every page request and redirects
signed-out visitors to `/login?next=<page>`. API calls send the access token as
a Bearer header; the backend verifies it and applies RLS with the same identity.

**Session handling:** tokens refresh automatically. If the API rejects a token,
the client refreshes once and retries; if that fails, the session is cleared and
the user lands on `/login?reason=expired`. Sign-out, and sign-out of all devices
from the profile page, does a full page load so no previous user's data stays in
memory. Back/forward-cache restores are reloaded so the session is checked again.

**Permissions:** one matrix in `backend/app/core/permissions.py` (plus the **librarian** role, given
as *Library duty* on a staff record: library only — see Library):

| Permission | Super admin | School admin | Accountant | Teacher | Parent | Student |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Manage schools (platform) | ✓ | | | | | |
| Dashboard | in a school | ✓ | ✓ | ✓ | ✓ | ✓ |
| Students: view / manage | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ / – | | |
| Classes: view / manage | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ / – | | |
| Fees: view / collect | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | | ✓ / – | |
| Attendance: view / mark | ✓ / ✓ | ✓ / ✓ | | ✓ / ✓ | ✓ / – | ✓ / – |
| Reports | ✓ | ✓ | ✓ | ✓ | | |
| Homework: set / review | ✓ / ✓ | ✓ / ✓ | | own classes, own homework | view own child | own: view and submit |
| Online payments: pay / view all / re-check / refund | – / ✓ / ✓ / ✓ | – / ✓ / ✓ / ✓ | – / ✓ / ✓ / – | | own children | |
| Enquiries (CRM): view & work / delete | ✓ / ✓ | ✓ / ✓ | ✓ / – | | | |
| Admissions: view / review & create student / record fee | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | ✓ / – / ✓ | | | |
| Report cards: templates / remarks | ✓ / both | ✓ / both | | – / class teacher's remarks (own sections) | own child's card, once published | own card, once published |
| Exams: set up / enter marks / view results | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | | – / own sections / own sections | own child, once published | own, once published |
| Timetable: view / manage | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ (own classes) / – | own child (portal) | own (portal) |
| Notifications: own inbox and choices | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Communication: templates, channels, history | ✓ | ✓ | | | | |
| Send fee reminders | ✓ | ✓ | ✓ | | | |
| Library: run it (catalogue, issue, return) / fines / waive & rules | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | – / ✓ / – | catalogue and own books | child's books (portal) | own books (portal) |
| Transport: view / manage / documents | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | ✓ / – / – | | child's transport (portal) | own transport (portal) |
| Inventory: view / manage | ✓ / ✓ | ✓ / ✓ | ✓ / – | items assigned to them | | |
| Staff leave: own / manage (and staff attendance) | ✓ / ✓ | ✓ / ✓ | own / – | own / – | | |
| Payroll | – (never for super admins) | ✓ | | | | |
| School settings | ✓ | ✓ | | | | |
| Own profile | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Parent and student access will be narrowed to their own children / themselves
as those modules are built.

- **API:** protect an endpoint with
  `ctx = Depends(require_permission(Permission.FEES_COLLECT))`. It checks the
  caller's permission *in the school named by `X-School-Id`*, so a role in
  School A grants nothing in School B.
- **UI:** `/me` returns each membership's permissions. The sidebar and
  `<RequirePermission permission="...">` page guard only reflect what the server
  allows; typing a URL directly shows a "no access" page, and the API refuses the
  data anyway.
- **Database:** RLS keeps schools apart even if application code is wrong
  (see `supabase/SCHEMA.md`).

## Testing

| What | Command | Needs |
|---|---|---|
| Backend unit + permission tests | `cd backend && pytest -q` (includes `tests/test_security.py`: size limits, settings, headers, trusted IPs, ended sessions, who reads the log, CSV injection, storage paths, no SSRF) | nothing |
| Database rules | run each file in `supabase/tests/` in the SQL Editor (each rolls back and ends with "ALL … TESTS PASSED"), or all of them on an empty Postgres: `DATABASE_URL=… supabase/tests/ci/run_sql_tests.sh` | Supabase project, or any Postgres 16 |
| End-to-end (browser) | see below | running app + Supabase |

**End-to-end tests** cover login, logout, invalid login, protected routes, every
role's access to every page (via the menu *and* by typing the URL), school
isolation through the API, session expiry, forged cookies, profile editing and
mobile navigation. Each module has its own suite too — for example `transport.spec.ts`: fare zones,
vehicles and their papers, drivers, routes and stops; assigning, moving and stopping a student;
transport dues at the fee desk; a full vehicle and an expired licence refused; the parent's view;
accountants read-only; teachers and other schools refused; and no sideways scrolling on a phone.
`inventory.spec.ts` covers adding an item with its purchase, whole-number units, stock out to a
staff member and back in, overdrawing refused (in the page and by the API), the change log, the
staff member's own list, the dashboard, history filters and CSV, archiving and deleting rules,
accountants read-only, other roles and schools refused, and the phone layout.
`hr-payroll.spec.ts` covers leave types, holidays, applying (day count, balance, overlap), approving
and rejecting, staff attendance, components and a salary structure, a month's payroll checked
against an independent calculation of loss of pay, earnings and deductions, an adjustment, the
salary slip PDF and register, finalizing (attendance locked), marking paid, and that nobody but the
school's own admins — not accountants, teachers, other schools or a platform super admin — reaches payroll.
`pwa.spec.ts` checks the app with Chrome's own installability audit, the manifest, icons and iPhone launch
screens; the offline shell (opened pages, the offline page, recovery, no API data cached, cached pages
cleared on sign-out); and push end to end — turning it on in My profile, a test, a school notice
encrypted and signed by the server, decrypted by a stand-in phone, delivered to the service worker and
shown, the lock-screen privacy option, and sign-out removing the device (it runs in full Chromium:
`channel: "chromium"`, because the lightweight headless shell has no notifications).
`pwa-mobile.spec.ts` checks each person's bottom tabs, the menu, the Android install dialog and the
iPhone steps, and phone layouts.
`school-documents.spec.ts` covers the signature and principal settings, a bonafide certificate from a
student's page (purpose required, wording checked against the record, numbered, PDF), a transfer
certificate (required fields, optional lines left out, the student marked as left, a second TC and a
later bonafide refused), a custom certificate with an extra field (unknown placeholder refused),
revoking, the public QR page (valid, revoked, unknown; no private details), printing ID cards for a
class, reprinting versus issuing new cards, staff versus teacher cards, and that only the school's
admins reach any of it.
`billing.spec.ts` (School C only) covers the platform's billing details, a plan from the Basic template,
starting a subscription without a trial (first invoice at once, with tax), the school admin seeing what
the plan leaves out (menu and page), paying the invoice through Checkout, the invoice PDF, Razorpay's
webhook notices, a payment recorded by hand and a refund, cancelling at period end and keeping it,
the platform cancelling at once (read-only banner, API refusing changes with 402) and reactivating,
and the phone layout. `platform.spec.ts` covers plans from a template, starting School A on a trial,
usage against the limits, the schools list and platform analytics, and who sees what.
`zz-audit-log.spec.ts` (run last: it adds records to School A that earlier specs count) covers the school's audit log (a sign-in, a student change shown as before → after,
CSV export), a receipt cancelled by the admin but not the accountant (and both in the log), the
platform's log without payroll, and the sign-in page refusing every way of redirecting to another
site (`//`, `/\`, a full URL, a tab). `supabase/tests/security_test.sql` checks migration 0032 in the
database (each of 37 deliberate changes to it makes the test fail).
`zzz-quality.spec.ts` (run last, on everything the other suites created) opens every page each role can reach
from its menu, plus the main detail pages, on a desktop and on a 390 px phone, and fails on any serious or
critical accessibility problem (axe, WCAG 2.1 A/AA), a page that scrolls sideways on the phone, a script
error, a server error from the API, or a page without its own title. `supabase/tests/production_test.sql`
checks migration 0033 (35 of 35 deliberate changes caught).

**Billing tests** use the same Razorpay stand-in as online payments, with the test backend given
`PLATFORM_RAZORPAY_KEY_ID=rzp_test_PLATFORM1`, `PLATFORM_RAZORPAY_KEY_SECRET=mock_secret_PLATFORM1`
and a `PLATFORM_RAZORPAY_WEBHOOK_SECRET`, and the stand-in told where to send that account's
webhooks: `POST http://localhost:9998/mock/webhook` with
`{"key_id": "rzp_test_PLATFORM1", "url": "http://localhost:8000/api/v1/billing/webhooks/razorpay", "secret": "<that secret>"}`.
Before going live, pay one invoice with the platform's Razorpay **test keys** and refund it in the dashboard.

1. Use a **separate Supabase project for testing**, never production.
2. Start the backend and frontend against it.
3. Create the test accounts — platform admin; admin, accountant, teacher, parent, student and
   librarian of School A; admin of School B; admin of School C, which only the billing tests use
   (writes `frontend/.env.e2e`, git-ignored; re-running it clears the test schools' subscriptions
   and billing records):
   ```bash
   cd backend && python -m scripts.create_test_accounts
   ```
4. Run the tests:
   ```bash
   cd frontend
   npx playwright install chromium   # first time only
   npm run test:e2e                  # or: npm run test:e2e:ui
   ```

**Online payment tests** need a Razorpay stand-in instead of real Razorpay (the suite makes
payments, fails them and refunds them). It ships with the backend for test environments only:
```bash
cd backend && uvicorn tests.e2e_support.mock_razorpay:app --port 9998
```
and the **test** environment points at it: backend `RAZORPAY_API_BASE=http://localhost:9998/v1`
(plus any `SECRETS_KEY`), frontend `NEXT_PUBLIC_RAZORPAY_CHECKOUT_URL=http://localhost:9998/checkout.js`.
It follows Razorpay's documented API, Checkout and webhook signatures. Before going live, also
make one real payment and refund with Razorpay **test keys**.

**Notification tests** need a messaging stand-in (an SMTP server plus Twilio and WhatsApp
look-alikes that send signed delivery reports), also for test environments only:
```bash
cd backend && uvicorn tests.e2e_support.mock_messaging:app --port 9997   # SMTP on port 2525
```
with the test backend set to `SMTP_HOST=localhost SMTP_PORT=2525 SMTP_SECURITY=none
EMAIL_FROM=school@erp.test TWILIO_API_BASE=http://localhost:9997
WHATSAPP_API_BASE=http://localhost:9997 PUBLIC_API_URL=http://localhost:8000`
(and `NOTIFY_INTERVAL_SECONDS=1` for speed). Before going live, send one real test message
per channel from Communication → Channels.

**Push tests** need a stand-in push service (it plays the phone: real keys, checks the server's VAPID
signature and decrypts the message), for test environments only:
```bash
cd backend && uvicorn tests.e2e_support.mock_push:app --port 9996
```
with the test backend given VAPID keys (`python -m scripts.generate_vapid_keys`) and
`PUSH_ALLOWED_HOSTS=http://localhost:9996`. Before going live, turn notifications on with a real phone
(Android Chrome, and an iPhone with the app on its Home Screen) and use **Send a test**.

The suite signs in about 20 times. If you see "Too many attempts", raise the
sign-in rate limit for the test project (Authentication → Rate Limits) or wait
a few minutes.

## Audit log and security

### What is recorded

Every entry has **who** (the person and their email at the time), **which school**, **what** (action),
**which record** (type and id, plus a readable label: the student's name, the receipt number, the
person's email), **when**, **from where** (IP and browser, where there is a request) and **details**.

| You asked for | Recorded as | Where it comes from | Details |
|---|---|---|---|
| Login | `auth.login` | Supabase Auth's sessions table (a trigger), or the app if that trigger isn't allowed | IP and browser Supabase saw, session id; one entry per school the person belongs to |
| Logout | `auth.logout` | the same | when the session started |
| Student creation | `student.created` | the database (trigger on `students`) | the whole record |
| Student modification | `student.updated`, `enrollment.updated` | the database | only the fields that changed, before → after |
| Fee payment | `fee_payment.recorded` | the database (trigger on `fee_payments`) | receipt number, amount, mode, student |
| Fee deletion / reversal | `fee_payment.cancelled` (and `.deleted`, which nothing allows) | the database | the reason, who cancelled it |
| Attendance modification | `attendance.changed`, `attendance.deleted` | the database, per student | before → after (present → absent…); the first marking of a day is one entry per class (`attendance.saved`, from the API) |
| User creation | `user.created`, `membership.created` | the database (`profiles`, `school_memberships`) | email; role and school |
| Role changes | `membership.role_changed`, `membership.disabled` / `enabled`, `user.super_admin_granted` / `removed` | the database | before → after |
| School changes | `school.created`, `school.updated`, `school.activated` / `deactivated` | the database | before → after |

Also recorded: password and email changes (`auth.*`), and everything the API already logged
(documents, certificates, payroll, billing, settings, exports — about 200 kinds of action),
including **exporting the audit log itself**.

Because the database records the sensitive changes, they are logged however they are made: through
the app, a script, the SQL editor or Supabase's REST API. Updates that change nothing aren't logged.

### Who sees it

| Person | Sees |
|---|---|
| A school's administrators (**Audit log** in the menu) | their own school's log; payroll entries too (only they run payroll) |
| The platform super admin (**Platform audit log**) | every school's log and platform-level entries (no school), **except payroll** — salaries stay with the school |
| Accountants, teachers, parents, students | nothing |

Nobody can change or delete an entry — not even the database owner (a trigger refuses it; TRUNCATE
is not granted to anyone but the owner). Deleting a school or account only blanks the link; the
entry stays. Entries can be filtered (category, dates, school), searched (person, student, receipt,
IP) and exported as CSV (cells that would start a spreadsheet formula are made inert).

### Reversing a receipt

Receipts are never deleted. A **school admin** can cancel one recorded at the desk (Fees → a
student, or Payments → the undo button), giving a reason: it stays on record, marked cancelled with
what it had paid, and those fees become due again. Accountants can't (whoever takes the money
can't also make the receipt disappear), and nor can the platform. A receipt paid online is
reversed by refunding it under Online payments.

### Security review (Phase 33)

The whole application was reviewed: authentication, authorization, row-level security, data leakage,
API security, input validation, file uploads, secrets, cross-tenant access and payments. Found and fixed:

| Severity | Finding | Fix |
|---|---|---|
| High | Another school's staff (or a parent) could **cancel a pending leave application** by its id: the "is it your own?" check was NULL, not false | migration 0031; test; the API audit now fails on any answer to another school but 401/403/404/422 |
| High | A school admin could point a stored **file path** (student document, photo, homework file, signature) at another school's file by writing the row directly through Supabase's REST API; the API would then fetch it with the storage key | database rule: every path starts with its own school's id, no `..`; storage only takes plain relative paths |
| High | **Payroll** details in the audit log (pay, adjustments) were readable by the platform super admin | payroll entries readable only by the school's payroll admins |
| High | Signed-in users held **TRUNCATE** (which ignores RLS), REFERENCES and TRIGGER on 13 core tables (students, schools, memberships…) | revoked on every table; default privileges changed; the isolation audit checks it |
| High | Login, logout, attendance changes, sign-ins turned off and **direct database writes** weren't in the audit log | database-level audit trail (above) |
| Medium | **Open redirect**: `/login?next=/\evil.com` (and email links) sent people to another site after a real sign-in | one check that resolves the path like a browser and keeps it on the site |
| Medium | The **receipt PDF fetched the logo from a stored URL** — writable through the REST API, so the server could be made to request internal addresses (SSRF) | only the platform's own logo storage, exact file name |
| Medium | The **IP in the audit log could be forged** with `X-Forwarded-For` (both the audit helper and uvicorn's own proxy-headers default) | one trusted-proxy rule (`TRUSTED_PROXY_HOPS`), uvicorn run with `--no-proxy-headers` |
| Medium | A **signed-out token kept working** until it expired (up to an hour) | each request checks the Supabase session is still live |
| Medium | **No limit on request size**: an upload was spooled to disk in full before any check | requests over 12 MB refused up front (more for the admission form and homework) |
| Medium | A missing or misspelt `APP_ENV` **exposed the API docs** and skipped HSTS; nothing stopped unsafe production settings | docs only in development; the API refuses to start with unsafe settings |
| Medium | The web app had **no Content-Security-Policy** (Supabase keeps the session token where page scripts can read it) | CSP, HSTS, Permissions-Policy |
| Medium | Accountants could **insert receipt rows directly** (no numbering, allocation or audit) through the REST API | direct inserts revoked; receipts only through the recording function, which now checks the role itself |
| Low | Audit entries could be written into another school's log by anyone able to call the private function | refused unless the caller belongs to that school |

Checked and found sound: token verification (signature, issuer, audience, expiry, algorithm list);
every route's permission and school check (`test_tenancy.py`); RLS on every table, no anonymous
access, no functions or views exposed through the REST API; no SQL built from user input (sort
orders and columns come from fixed lists); uploads (type from the bytes, images re-encoded, PDFs with
scripts refused, per-file limits, served with a sandbox policy); no secrets in the code or the
frontend, gateway and messaging secrets encrypted and never returned or logged; payments (signature,
fetched back from Razorpay, amount and currency checked, each school's own webhook secret, events
handled once); public pages rate-limited; emails and PDFs escape what people type.

### Before going live (checklist)

1. **Supabase → Project Settings → Data API**: remove `public` from the exposed schemas (or turn the
   Data API off). The app never uses it — every read and write goes through the API — so this removes
   a whole way in. (RLS and the rules above still hold if you leave it on.)
2. `APP_ENV=production`, https-only `CORS_ORIGINS`, `FRONTEND_URL`, `SUPABASE_URL`; the API won't start otherwise.
3. Run uvicorn with `--no-proxy-headers` and set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the API.
4. **Supabase → Authentication**: minimum password length (at least 10) and leaked-password protection,
   email confirmation, sign-in rate limits, Site URL and redirect URLs set to your domain only.
   Consider requiring multi-factor sign-in for the platform super admin's account.
5. Check that migration 0032 added its two Auth triggers (`erp_audit_sessions`, `erp_audit_users`); if
   it printed a notice instead, sign-ins are still recorded through the app.
6. Keep `SECRETS_KEY`, the service-role key and the Razorpay secrets in the host's secret store only.
7. Apply migration 0033 and check `GET /api/v1/health/ready` answers `{"status": "ok", "database": "ok"}`.
8. Turn on Point-in-Time Recovery (or at least daily backups) and schedule a copy of the Storage buckets;
   restore both once into a test project before the first school goes live.
9. Point the load balancer's health check at `/api/v1/health/ready` and the container's at `/api/v1/health`.

## Production audit (Phase 34)

A full review of the system as a CTO, QA, security, database and DevOps engineer would do before real
schools use it. Everything below was checked by running it, not only by reading code.

### How it was checked

| Area | How | Result |
|---|---|---|
| Every page, every role | axe (WCAG 2.1 A/AA) on 250 page views: 7 roles × every page in their menu + detail pages, desktop and 390 px phone; also sideways scrolling, script errors, API errors, loading that never finishes | 5 kinds of problems fixed (below); now a permanent test (`zzz-quality.spec.ts`) |
| Every API route | 11,123 malformed and hostile requests (random/invalid ids, wrong types, huge numbers, impossible dates, 5,000-character strings, SQL/HTML/path tricks) to all routes | 23 routes answered 500 → fixed; re-run: **0** server errors |
| Speed | every GET route timed for 7 roles (657 routes) | 3 slow endpoints (up to 6 s) fixed; now none over 300 ms on the test data |
| Database integrity | foreign keys without indexes, duplicate indexes, cascades onto financial history, who may delete what | 16 indexes added, 1 duplicate dropped, school deletion through the Data API closed |
| Multiple API processes | two API processes at once: rate limits, the renewal run | both raced; fixed (shared counts, a lock) |
| PDFs | receipts, certificates, ID cards, report cards… with names in Hindi and 8 other Indian scripts, and long text | Indian scripts printed as empty boxes → fixed |
| Dependencies | `pip-audit`, `npm audit` | vulnerable Starlette, PyJWT, Pillow, pypdf, python-multipart, PostCSS → upgraded; 0 known vulnerabilities in what ships |
| Tenant isolation | the SQL audit (every table, every role) and the API audit (every route, every person of School A against School B) | still sealed |
| Deployment | settings checks, health/readiness, containers, CI | added (below) |

### Module status

| Module | Status | Notes from the audit |
|---|---|---|
| Authentication, sessions | Ready | ended sessions refused at once (Phase 33); open-redirect safe |
| Schools, multi-school SaaS | Ready | schools can only be **deactivated** by the app now (deletion would erase financial history) |
| Academic sessions, classes, sections | Ready | |
| Students, documents | Ready | names in Indian scripts now print correctly on every PDF |
| Fees, payments, receipts | Ready | fee pages were slow (RLS) → fixed; receipt reversal (Phase 33) |
| Online payments (Razorpay) | Ready | signatures checked; amounts from the server |
| Attendance, reports | Ready | |
| Parents, students (portals) | Ready | portal rules rewritten for speed, same visibility; "no record linked" is now a friendly message |
| Teachers, timetable, homework/assignments | Ready | long homework text wraps on phones |
| Exams, results, report cards | Ready | marks visible to families only after publishing (re-tested) |
| Admissions, enquiries | Ready | phone layout fixed |
| Notifications (in-app, email, SMS, WhatsApp, push) | Ready | sender safe with several processes (SKIP LOCKED) |
| Library, transport, inventory | Ready | |
| Staff leave, payroll | Ready | payroll for authorised school admins only (re-tested); absurd months refused |
| Certificates, ID cards | Ready | Indian scripts, shaped; a Hindi name crashed card printing during the fix and is now covered by tests |
| PWA (installable app, offline, push) | Ready | |
| Analytics (school and platform) | Ready | phone layout fixed |
| Subscriptions and billing | Ready | renewal run can no longer race itself |
| Audit logs | Ready | |
| AI assistant | **Not built** | only a plan setting exists (shown as "coming later") |
| Website builder | **Not built** | only a plan setting exists (shown as "coming later") |
| AI voice calling | Not part of the product | not added |

### What was found and fixed

| # | Issue | Risk | Fix |
|---|---|---|---|
| 1 | Starlette 0.46, PyJWT 2.10, Pillow 11.2, pypdf 5.5, python-multipart 0.0.20 had published vulnerabilities (request parsing DoS, JWT `crit`/algorithm checks, image/PDF parser memory bugs) | crafted uploads or requests could crash or hang the API; JWT parsing is the sign-in boundary | FastAPI 0.136.3 / Starlette 1.8.0, PyJWT 2.15.1, Pillow 12.3.0, pypdf 6.21.1, python-multipart 0.0.32, uvicorn 0.54.0 |
| 2 | Next.js bundled a vulnerable PostCSS | audit gate fails; future CSS processing exposed | Next 15.5.28 + `overrides` → PostCSS 8.5.29 |
| 3 | Parent/student read rules ran a sub-query **per row** (fee heads × every due) | fee screens took 6 s with 733 dues; a full school would time out | rules compare against `my_student_ids()`, worked out once per query; same visibility |
| 4 | Postgres JIT compiled small queries (~35 ms each call) | every fee/analytics call slowed | JIT off for the API's transactions |
| 5 | The super admin could delete a school through Supabase's Data API | one request erases a school's students, receipts and payslips | delete revoked; deactivate instead |
| 6 | Rate limits were counted per process | with `--workers 2` or several servers, limits on public forms and payments multiplied | limits counted in the database (hashed keys) |
| 7 | The hourly renewal run raced itself across processes | a failed, rolled-back run in the logs; risk of confusion over invoices | a lock: one run at a time |
| 8 | Missing foreign-key indexes, one duplicate index | slow deletes/look-ups as data grows; wasted writes | 16 indexes, duplicate dropped |
| 9 | PDFs printed Hindi, Bengali, Tamil… as empty boxes | unusable receipts, certificates and ID cards for many Indian schools | merged Indian-script font + HarfBuzz shaping |
| 10 | Malformed input gave 500s (huge page numbers on 22 lists, impossible payroll month) | noisy errors, possible probing signal | limits on input; database errors become clear 4xx answers |
| 11 | Accessibility: low-contrast menu labels (every page), unlabelled file pickers, invalid lists, colour-only links, tables not reachable by keyboard, every tab titled "School ERP" | harder or impossible for screen-reader and keyboard users | fixed; page titles from each page's heading |
| 12 | Four pages scrolled sideways on phones | broken phone layout | grid cells may shrink; long text wraps |
| 13 | A student account without a linked record saw "This couldn't be loaded" | looks like a failure | a clear "contact the office" message |
| 14 | No readiness check, no containers, no CI; settings check missed a bad `SECRETS_KEY`, plain-text DB connections, a missing service-role key; a production web build accepted `http://` API URLs | silent misconfiguration in production | `/health/ready`, Dockerfiles, CI workflow, stricter settings checks, build guard |

### Verification (after the fixes)

| Check | Result |
|---|---|
| Backend unit, permission and tenancy tests | 574 passed (`tests/test_pdf_fonts.py` and new cases in `tests/test_security.py`) |
| SQL suites on an empty Postgres 16 (`supabase/tests/ci/run_sql_tests.sh`) | 32 of 32 pass, every migration applied |
| Deliberate breakages (mutation checks) | 0033: 35/35 caught · 0032: 37/37 · billing: 50/50 · platform: 29/29 · analytics: 38/38 · isolation audit: 11/12 (the 12th is blocked by a trigger anyway) |
| Browser tests, twice, each from a fresh database | 232 of 232 both times (including the 8 quality sweeps) |
| API tenancy audit (School B's people against School A's real records) | 216 routes, 548 requests, all refused or not found |
| SQL tenancy audit | passed |
| API fuzz (11,123 hostile requests) | 0 server errors |
| Smoke tests against the running stack | platform, billing, security and production (two API processes) — all pass |
| `pip-audit` / `npm audit --omit=dev` | 0 known vulnerabilities |

### Known limits (honest)

- **Urdu and other right-to-left scripts** don't print in PDFs (no right-to-left layout); the nine main
  Indian scripts do.
- **Docker images** were written and their steps run (dependency install, standalone server), but the
  images themselves couldn't be built here (no access to Docker Hub from the audit environment). Build them
  once in CI or locally before relying on them.
- `npm audit` still reports `braces` through `eslint-config-next` — a **development-only** lint tool with no
  fixed release; nothing of it ships to browsers or the server.
- Browser tests use stand-ins for Supabase Auth, Razorpay, SMS/WhatsApp/email and push services. Before
  going live, run each real integration once with test keys (see Testing).
- The accessibility sweep checks every page as it opens; dialogs and forms opened inside pages were fixed
  where found but are not swept automatically.


| Layer | Control |
|---|---|
| Browser | Only the anon/publishable key. Service-role key exists only in the backend env. |
| API | Every request needs a valid Supabase JWT (signature, `aud`, `iss`, `exp`, `role`). Role and tenant checks via FastAPI dependencies. |
| Tenant | School-scoped endpoints require `X-School-Id`; the user must hold an active membership in an active school. Checked for every route by `tests/test_tenancy.py`; the database enforces the same with RLS (`tenant_isolation_audit.sql`). Only the platform's super admin adds or removes school administrators. |
| Database | Backend queries run as Postgres role `authenticated` with the caller's claims, so **RLS applies to the API too**. |
| Privilege | `is_super_admin` is not writable by any client (column grants); it can only be set in the SQL editor. |
| Payments | Razorpay key secret and webhook secret are encrypted with `SECRETS_KEY` (API env only) and never returned by any endpoint. A payment counts only after the API verifies the signature **and** fetches the payment from Razorpay (order, amount, currency, status), or receives a signed webhook. Recording runs as the `erp_payments` database role, which only the API can switch to. |
| Messaging | Twilio and WhatsApp tokens are encrypted with `SECRETS_KEY` and never returned. Messages are built only from the event's own data with `{{placeholder}}` substitution (no template code). Delivery reports are accepted only with a valid Twilio / Meta signature. Admins see delivery logs, not other people's inboxes. Sending runs as the `erp_notify` database role. |
| Library | Circulation and fines go only through database functions that check the role, availability, limits and blocks; fines are calculated in SQL from the rate in force at issue; loans can't be edited or deleted; only admins waive fines or change the rules. Librarians find borrowers through limited functions and can't read student or staff records. |
| Transport | Assignments, moves and endings go only through database functions that check the admin role, enrolment, the session's dates, the route and stop, overlaps and seats (under a lock). Transport dues are generated in the database; the transport fee structure can only be changed by those functions. Vehicle and driver documents are in a private bucket, opened only by admins through the API (audited). Families read transport through a function that returns only their own child's trip. |
| Inventory | Quantity has no client write grant: it changes only through a database function that locks the item and refuses overdrawing, future dates, fractions of counted units and archived items. Item codes are assigned in the database. Stock history is append-only (even for the database owner); changes of location, condition and assignee are logged by a trigger. Staff see only items assigned to them (RLS). |
| Payroll | Readable and writable only by the school's own administrators — RLS on every payroll table; platform super admins are deliberately excluded. Pay is calculated in the database from the salary structure, attendance and approved leave. A finalized month locks its attendance, holidays, leave decisions and payslips (for everyone, including the database owner); a paid month is closed for good. Every action and slip download is audited. |
| Staff leave | Applications go only through database functions (balance, overlap, working days, session, payroll lock). Nobody decides their own leave. Staff see only their own leave and attendance. Leave history is never deleted. |
| Audit | Written in the same transaction as the change. Sensitive changes are recorded **by the database** (triggers), however they are made; sign-ins, sign-outs and password changes come from Supabase Auth. The actor is taken from the JWT, the IP and browser from the request. The log is **append-only, even for the database owner**; nobody can write an entry into another school's log. Payroll entries are readable only by the school's own administrators. See [Audit log and security](#audit-log-and-security). |
| Sessions | A token is refused as soon as its Supabase session ends (sign-out, or ended by an admin) — not only when it expires. |
| Requests | Bodies over the limit are refused before anything reads them; API answers are never cached and can't be framed or run as pages; `X-Forwarded-For` is trusted only through the configured number of proxies. |
| Files | Stored file paths must sit inside their own school's folder (database rule), and storage is only ever addressed with plain relative paths; logos for PDFs are only fetched from the platform's own logo storage (no SSRF). |
| Web app | Content-Security-Policy (no outside scripts or connections, no framing, no plugins), HSTS in production, no camera/microphone/location, and sign-in only ever redirects within the site. |
