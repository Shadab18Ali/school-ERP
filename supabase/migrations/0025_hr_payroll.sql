-- =====================================================================
-- Phase 26: staff leave and payroll
--
-- Leave (staff apply; school admins decide)
--   hr_settings          per school: weekly off days, how unmarked days and loss of pay count
--   staff_holidays       school holidays (not working days for leave or pay)
--   leave_types          the school's leave types: yearly allowance (or none = no limit), paid or unpaid
--   leave_allocations    a different allowance for one staff member in one session (optional)
--   leave_applications   apply → pending → approved / rejected / cancelled; the leave year is the
--                        academic session; days count working days only
--   staff_attendance     present / absent / half day, marked by admins
--
-- Payroll (the school's own admins only — not even platform super admins; enforced here by RLS)
--   salary_components        allowances and deductions: a fixed amount or a % of basic
--   salary_structures        a staff member's basic pay from a date, with their components
--   payroll_runs             one per month: draft → finalized → paid
--   payslips                 a snapshot per staff member per run: days, earnings, loss of pay,
--                            deductions, adjustments, net pay
--   payslip_adjustments      one-off additions or recoveries on a draft payslip
--
-- Loss of pay = absent days + ½ × half days + unpaid leave days (+ unmarked days, if the
-- school counts them as absent) + working days before joining. Earnings are paid for
-- (basis days − loss-of-pay days) / basis days, where the basis is the month's working days
-- or its calendar days (school setting). Percentage deductions apply to the basic actually earned.
-- Once a month's payroll is finalized, that month's attendance, holidays and leave decisions
-- are locked, and its payslips can't change (reopen the run first, with a reason).
-- Every amount comes from what the school enters; nothing is built in.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Who may do what
-- ---------------------------------------------------------------------
create or replace function private.is_hr_admin(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[]);
$$;
-- payroll: the school's own administrators only — deliberately NOT platform super admins, who run
-- the service but have no business reading a school's salaries
create or replace function private.is_payroll_admin(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_school_role(p_school, array['school_admin']::public.app_role[]);
$$;
-- the signed-in person's own staff record (any staff role), for applying for leave
create or replace function private.current_staff_id(p_school uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select t.id from public.teachers t
  join public.school_memberships m on m.user_id = t.account_id and m.school_id = t.school_id and m.status = 'active'
       and m.role in ('school_admin', 'accountant', 'teacher', 'librarian')
  join public.schools s on s.id = t.school_id and s.status = 'active'
  where t.school_id = p_school and t.account_id = (select auth.uid()) and t.status = 'active'
  limit 1;
$$;

-- ---------------------------------------------------------------------
-- Settings, holidays
-- ---------------------------------------------------------------------
create table public.hr_settings (
  school_id     uuid primary key references public.schools (id) on delete cascade,
  weekly_offs   smallint[] not null default '{7}' check (weekly_offs <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and cardinality(weekly_offs) <= 3),  -- ISO: 1 = Monday … 7 = Sunday
  lop_basis     text not null default 'working_days' check (lop_basis in ('working_days', 'calendar_days')),
  unmarked_as   text not null default 'present' check (unmarked_as in ('present', 'absent')),
  updated_at    timestamptz not null default now()
);

create table public.staff_holidays (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  holiday_on  date not null,
  name        text not null check (char_length(btrim(name)) between 2 and 80),
  created_at  timestamptz not null default now(),
  constraint staff_holidays_one_per_day unique (school_id, holiday_on)
);

create or replace function private.hr_working_day(p_school uuid, p_day date)
returns boolean language sql stable security definer set search_path = '' as $$
  select not (extract(isodow from p_day)::smallint = any (coalesce((select weekly_offs from public.hr_settings where school_id = p_school), '{7}')))
     and not exists (select 1 from public.staff_holidays h where h.school_id = p_school and h.holiday_on = p_day);
$$;

-- ---------------------------------------------------------------------
-- Leave
-- ---------------------------------------------------------------------
create table public.leave_types (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 2 and 60),
  code            text not null check (code ~ '^[A-Z]{1,6}$'),
  annual_days     numeric(5, 1) check (annual_days is null or (annual_days >= 0 and annual_days <= 366 and annual_days * 2 = trunc(annual_days * 2))),
  is_paid         boolean not null default true,
  allow_half_day  boolean not null default true,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint leave_types_id_school_key unique (id, school_id)
);
create unique index leave_types_name_key on public.leave_types (school_id, lower(name));
create unique index leave_types_code_key on public.leave_types (school_id, code);

create table public.leave_allocations (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  teacher_id           uuid not null,
  leave_type_id        uuid not null,
  academic_session_id  uuid not null,
  days                 numeric(5, 1) not null check (days >= 0 and days <= 366 and days * 2 = trunc(days * 2)),
  note                 text check (note is null or char_length(note) <= 200),
  updated_at           timestamptz not null default now(),
  constraint leave_allocations_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id) on delete cascade,
  constraint leave_allocations_type_fkey foreign key (leave_type_id, school_id) references public.leave_types (id, school_id) on delete cascade,
  constraint leave_allocations_session_fkey foreign key (academic_session_id, school_id) references public.academic_sessions (id, school_id) on delete cascade,
  constraint leave_allocations_one unique (teacher_id, leave_type_id, academic_session_id)
);

create table public.leave_applications (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  teacher_id           uuid not null,
  leave_type_id        uuid not null,
  academic_session_id  uuid not null,
  start_date           date not null,
  end_date             date not null,
  half_day             boolean not null default false,
  days                 numeric(5, 1) not null check (days > 0),
  reason               text not null check (char_length(btrim(reason)) between 3 and 500),
  status               text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  applied_by           uuid references auth.users (id) on delete set null,
  applied_at           timestamptz not null default now(),
  decided_by           uuid references auth.users (id) on delete set null,
  decided_at           timestamptz,
  decision_note        text check (decision_note is null or char_length(decision_note) <= 300),
  cancelled_by         uuid references auth.users (id) on delete set null,
  cancelled_at         timestamptz,
  constraint leave_applications_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id) on delete cascade,
  constraint leave_applications_type_fkey foreign key (leave_type_id, school_id) references public.leave_types (id, school_id),
  constraint leave_applications_session_fkey foreign key (academic_session_id, school_id) references public.academic_sessions (id, school_id),
  constraint leave_applications_dates check (end_date >= start_date),
  constraint leave_applications_half_day check (not half_day or start_date = end_date)
);
create index leave_applications_school_idx on public.leave_applications (school_id, status, start_date desc);
create index leave_applications_teacher_idx on public.leave_applications (teacher_id, start_date desc);

create table public.staff_attendance (
  school_id    uuid not null references public.schools (id) on delete cascade,
  teacher_id   uuid not null,
  attended_on  date not null,
  status       text not null check (status in ('present', 'absent', 'half_day')),
  note         text check (note is null or char_length(note) <= 200),
  marked_by    uuid references auth.users (id) on delete set null,
  marked_at    timestamptz not null default now(),
  primary key (teacher_id, attended_on),
  constraint staff_attendance_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id) on delete cascade
);
create index staff_attendance_school_idx on public.staff_attendance (school_id, attended_on);

-- working days in a leave (half a day for a half-day leave)
create or replace function private.leave_days(p_school uuid, p_start date, p_end date, p_half boolean)
returns numeric language sql stable security definer set search_path = '' as $$
  select case when p_half then (case when private.hr_working_day(p_school, p_start) then 0.5 else 0 end)
              else (select count(*) from generate_series(p_start, p_end, interval '1 day') d where private.hr_working_day(p_school, d::date)) end;
$$;

-- allowance (null = no limit), used (approved), pending, available (null = no limit)
create or replace function private.leave_balance(p_teacher uuid, p_type uuid, p_session uuid, p_except uuid default null)
returns table (allowance numeric, used numeric, pending numeric, available numeric)
language sql stable security definer set search_path = '' as $$
  with t as (select annual_days from public.leave_types where id = p_type),
  al as (select coalesce((select days from public.leave_allocations a where a.teacher_id = p_teacher and a.leave_type_id = p_type
                            and a.academic_session_id = p_session), (select annual_days from t)) as allowance),
  u as (select coalesce(sum(days) filter (where status = 'approved'), 0) as used,
               coalesce(sum(days) filter (where status = 'pending'), 0) as pending
        from public.leave_applications where teacher_id = p_teacher and leave_type_id = p_type and academic_session_id = p_session
          and id is distinct from p_except)
  select al.allowance, u.used, u.pending, al.allowance - u.used - u.pending from al, u;
$$;

create or replace function private.leave_apply(
  p_school uuid, p_teacher uuid, p_type uuid, p_start date, p_end date, p_half boolean, p_reason text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_self uuid := private.current_staff_id(p_school); v_staff uuid := coalesce(p_teacher, v_self);
  t public.leave_types; v_session uuid; v_days numeric; b record; v_id uuid;
begin
  if v_staff is null then raise exception 'Your login isn''t linked to a staff record, so you can''t apply for leave here.' using errcode = 'P0002'; end if;
  if v_staff is distinct from v_self and not private.is_hr_admin(p_school) then
    raise exception 'Only school admins can apply for someone else.' using errcode = 'insufficient_privilege';
  end if;
  perform 1 from public.teachers where id = v_staff and school_id = p_school and status = 'active';
  if not found then raise exception 'Staff member not found.' using errcode = 'P0002'; end if;
  select * into t from public.leave_types where id = p_type and school_id = p_school;
  if not found or not t.is_active then raise exception 'Choose a leave type.' using errcode = 'check_violation'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'The leave ends before it starts.' using errcode = 'check_violation'; end if;
  if p_end - p_start > 180 then raise exception 'A single leave can be at most 6 months.' using errcode = 'check_violation'; end if;
  if p_half and (p_start <> p_end or not t.allow_half_day) then
    raise exception 'A half day is for a single day of % only.', t.name using errcode = 'check_violation';
  end if;
  select id into v_session from public.academic_sessions where school_id = p_school and p_start between start_date and end_date
    and p_end between start_date and end_date order by start_date desc limit 1;
  if v_session is null then
    raise exception 'The leave must fall within one academic session. Split it at the session''s end.' using errcode = 'check_violation';
  end if;
  if private.payroll_locked(p_school, p_start, p_end) then
    raise exception 'Payroll for that month is finalized, so its leave can''t change.' using errcode = 'check_violation';
  end if;
  v_days := private.leave_days(p_school, p_start, p_end, coalesce(p_half, false));
  if v_days = 0 then raise exception 'Those dates are all holidays or weekly offs.' using errcode = 'check_violation'; end if;
  perform pg_advisory_xact_lock(hashtext('leave:' || v_staff::text));
  if exists (select 1 from public.leave_applications a where a.teacher_id = v_staff and a.status in ('pending', 'approved')
             and daterange(a.start_date, a.end_date, '[]') && daterange(p_start, p_end, '[]')) then
    raise exception 'There is already a leave for some of these days.' using errcode = 'check_violation';
  end if;
  select * into b from private.leave_balance(v_staff, p_type, v_session);
  if b.available is not null and v_days > b.available then
    raise exception 'Only % day(s) of % left this session (% requested).', trim_scale(greatest(b.available, 0)), t.name, trim_scale(v_days)
      using errcode = 'check_violation';
  end if;
  insert into public.leave_applications (school_id, teacher_id, leave_type_id, academic_session_id, start_date, end_date, half_day, days, reason, applied_by)
  values (p_school, v_staff, p_type, v_session, p_start, p_end, coalesce(p_half, false), v_days, btrim(p_reason), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

create or replace function private.leave_decide(p_app uuid, p_approve boolean, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.leave_applications; b record; t public.leave_types;
begin
  select * into a from public.leave_applications where id = p_app for update;
  if not found or not private.is_hr_admin(a.school_id) then raise exception 'Leave application not found.' using errcode = 'P0002'; end if;
  if a.status <> 'pending' then raise exception 'This application is already %.', a.status using errcode = 'check_violation'; end if;
  if a.teacher_id = private.current_staff_id(a.school_id) then
    raise exception 'You can''t decide your own leave. Another administrator must.' using errcode = 'insufficient_privilege';
  end if;
  if not p_approve and nullif(btrim(p_note), '') is null then raise exception 'Give the reason for rejecting.' using errcode = 'check_violation'; end if;
  if private.payroll_locked(a.school_id, a.start_date, a.end_date) then
    raise exception 'Payroll for that month is finalized, so its leave can''t change.' using errcode = 'check_violation';
  end if;
  if p_approve then
    select * into t from public.leave_types where id = a.leave_type_id;
    select * into b from private.leave_balance(a.teacher_id, a.leave_type_id, a.academic_session_id, a.id);
    if b.available is not null and a.days > b.available then
      raise exception 'Only % day(s) of % left this session.', trim_scale(greatest(b.available, 0)), t.name using errcode = 'check_violation';
    end if;
  end if;
  update public.leave_applications set status = case when p_approve then 'approved' else 'rejected' end, decided_by = auth.uid(),
    decided_at = now(), decision_note = nullif(btrim(p_note), '') where id = a.id;
end $$;

create or replace function private.leave_cancel(p_app uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.leave_applications; v_admin boolean; v_own boolean;
begin
  select * into a from public.leave_applications where id = p_app for update;
  if not found then raise exception 'Leave application not found.' using errcode = 'P0002'; end if;
  v_admin := private.is_hr_admin(a.school_id);
  v_own := a.teacher_id = private.current_staff_id(a.school_id);
  if not (v_admin or v_own) then raise exception 'Leave application not found.' using errcode = 'P0002'; end if;
  if a.status not in ('pending', 'approved') then raise exception 'This application is already %.', a.status using errcode = 'check_violation'; end if;
  if a.status = 'approved' and not v_admin and a.start_date <= private.ist_today() then
    raise exception 'Leave that has started can only be cancelled by the school office.' using errcode = 'check_violation';
  end if;
  if a.status = 'approved' and private.payroll_locked(a.school_id, a.start_date, a.end_date) then
    raise exception 'Payroll for that month is finalized, so its leave can''t change.' using errcode = 'check_violation';
  end if;
  update public.leave_applications set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
    decision_note = coalesce(nullif(btrim(p_note), ''), decision_note) where id = a.id;
end $$;

-- leave applications change only through the functions above; their key facts never change
create or replace function private.leave_application_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- maintenance only (clearing a test school), like library.allow_delete; the API never sets it
    if exists (select 1 from public.teachers t where t.id = old.teacher_id) and current_setting('hr.allow_delete', true) is distinct from 'on' then
      raise exception 'Leave history can''t be deleted. Cancel the leave instead.' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if (new.teacher_id, new.leave_type_id, new.academic_session_id, new.start_date, new.end_date, new.half_day, new.days)
     is distinct from (old.teacher_id, old.leave_type_id, old.academic_session_id, old.start_date, old.end_date, old.half_day, old.days) then
    raise exception 'A leave''s dates and type can''t be changed. Cancel it and apply again.' using errcode = 'check_violation';
  end if;
  if old.status in ('rejected', 'cancelled') then
    raise exception 'This application is already %.', old.status using errcode = 'check_violation';
  end if;
  if (old.status = 'approved' or new.status = 'approved') and old.status <> new.status
     and private.payroll_locked(new.school_id, new.start_date, new.end_date) then
    raise exception 'Payroll for that month is finalized, so its leave can''t change.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger leave_applications_guard before update or delete on public.leave_applications
  for each row execute function private.leave_application_guard();

-- attendance and holidays of a finalized month are locked
create or replace function private.hr_month_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_school uuid; v_day date;
begin
  if tg_table_name = 'staff_attendance' then
    v_school := coalesce(new.school_id, old.school_id);
    if tg_op <> 'INSERT' and private.payroll_locked(old.school_id, old.attended_on, old.attended_on) then
      raise exception 'Payroll for that month is finalized, so its attendance can''t change.' using errcode = 'check_violation';
    end if;
    if tg_op <> 'DELETE' then
      if private.payroll_locked(new.school_id, new.attended_on, new.attended_on) then
        raise exception 'Payroll for that month is finalized, so its attendance can''t change.' using errcode = 'check_violation';
      end if;
      if new.attended_on > private.ist_today() then
        raise exception 'Attendance can''t be marked for a future date.' using errcode = 'check_violation';
      end if;
    end if;
  else  -- staff_holidays
    if tg_op <> 'INSERT' and private.payroll_locked(old.school_id, old.holiday_on, old.holiday_on) then
      raise exception 'Payroll for that month is finalized, so its holidays can''t change.' using errcode = 'check_violation';
    end if;
    if tg_op <> 'DELETE' and private.payroll_locked(new.school_id, new.holiday_on, new.holiday_on) then
      raise exception 'Payroll for that month is finalized, so its holidays can''t change.' using errcode = 'check_violation';
    end if;
  end if;
  return coalesce(new, old);
end $$;
create trigger staff_attendance_month_guard before insert or update or delete on public.staff_attendance
  for each row execute function private.hr_month_guard();
create trigger staff_holidays_month_guard before insert or update or delete on public.staff_holidays
  for each row execute function private.hr_month_guard();

-- ---------------------------------------------------------------------
-- Salary
-- ---------------------------------------------------------------------
create table public.salary_components (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 2 and 60),
  kind           text not null check (kind in ('earning', 'deduction')),
  calc           text not null default 'fixed' check (calc in ('fixed', 'percent_basic')),
  default_value  numeric(12, 2) not null default 0 check (default_value >= 0),
  is_active      boolean not null default true,
  display_order  smallint not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint salary_components_id_school_key unique (id, school_id),
  constraint salary_components_percent check (calc <> 'percent_basic' or default_value <= 100)
);
create unique index salary_components_name_key on public.salary_components (school_id, lower(name));

create table public.salary_structures (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools (id) on delete cascade,
  teacher_id      uuid not null,
  effective_from  date not null check (effective_from = date_trunc('month', effective_from)::date),   -- always the 1st of a month
  basic           numeric(12, 2) not null check (basic >= 0 and basic <= 10000000),
  note            text check (note is null or char_length(note) <= 200),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint salary_structures_id_school_key unique (id, school_id),
  constraint salary_structures_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id) on delete cascade,
  constraint salary_structures_one_per_month unique (teacher_id, effective_from)
);

create table public.salary_structure_items (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  structure_id   uuid not null,
  component_id   uuid not null,
  calc           text not null check (calc in ('fixed', 'percent_basic')),
  value          numeric(12, 2) not null check (value >= 0),
  constraint salary_structure_items_structure_fkey foreign key (structure_id, school_id) references public.salary_structures (id, school_id) on delete cascade,
  constraint salary_structure_items_component_fkey foreign key (component_id, school_id) references public.salary_components (id, school_id),
  constraint salary_structure_items_one unique (structure_id, component_id),
  constraint salary_structure_items_percent check (calc <> 'percent_basic' or value <= 100)
);

create table public.payroll_runs (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references public.schools (id) on delete cascade,
  month              date not null check (month = date_trunc('month', month)::date),
  status             text not null default 'draft' check (status in ('draft', 'finalized', 'paid')),
  generated_at       timestamptz not null default now(),
  generated_by       uuid references auth.users (id) on delete set null,
  finalized_at       timestamptz,
  finalized_by       uuid references auth.users (id) on delete set null,
  paid_on            date,
  payment_mode       text check (payment_mode is null or payment_mode in ('bank_transfer', 'cheque', 'cash', 'upi')),
  payment_reference  text check (payment_reference is null or char_length(payment_reference) <= 80),
  reopen_note        text check (reopen_note is null or char_length(reopen_note) <= 300),
  constraint payroll_runs_id_school_key unique (id, school_id),
  constraint payroll_runs_one_per_month unique (school_id, month),
  constraint payroll_runs_paid check ((status = 'paid') = (paid_on is not null and payment_mode is not null))
);

-- a month whose payroll is finalized (or paid) is closed
create or replace function private.payroll_locked(p_school uuid, p_from date, p_to date)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.payroll_runs r where r.school_id = p_school and r.status <> 'draft'
                 and r.month between date_trunc('month', p_from)::date and date_trunc('month', p_to)::date);
$$;

create table public.payslips (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references public.schools (id) on delete cascade,
  run_id             uuid not null,
  teacher_id         uuid not null,
  structure_id       uuid,
  employee_id        text not null,
  staff_name         text not null,
  month              date not null,
  basic              numeric(12, 2) not null,
  earnings           jsonb not null,     -- [{name, full, earned}] — basic first
  deductions         jsonb not null,     -- [{name, amount}]
  gross_full         numeric(12, 2) not null,
  lop_days           numeric(5, 1) not null,
  lop_amount         numeric(12, 2) not null,
  gross_earned       numeric(12, 2) not null,
  total_deductions   numeric(12, 2) not null,
  adjustments_total  numeric(12, 2) not null default 0,
  net_pay            numeric(12, 2) not null,
  calendar_days      smallint not null,
  working_days       smallint not null,
  basis_days         smallint not null,
  present_days       numeric(5, 1) not null,
  absent_days        numeric(5, 1) not null,
  half_days          numeric(5, 1) not null,
  paid_leave_days    numeric(5, 1) not null,
  unpaid_leave_days  numeric(5, 1) not null,
  unmarked_days      numeric(5, 1) not null,
  not_joined_days    numeric(5, 1) not null,
  generated_at       timestamptz not null default now(),
  constraint payslips_id_school_key unique (id, school_id),
  constraint payslips_run_fkey foreign key (run_id, school_id) references public.payroll_runs (id, school_id) on delete cascade,
  constraint payslips_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id),
  constraint payslips_one unique (run_id, teacher_id)
);

create table public.payslip_adjustments (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  payslip_id  uuid not null,
  label       text not null check (char_length(btrim(label)) between 2 and 80),
  amount      numeric(12, 2) not null check (amount <> 0 and abs(amount) <= 10000000),   -- + addition, − recovery
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint payslip_adjustments_payslip_fkey foreign key (payslip_id, school_id) references public.payslips (id, school_id) on delete cascade
);

create trigger hr_settings_updated_at before update on public.hr_settings for each row execute function private.set_updated_at();
do $$ declare t text; begin
  foreach t in array array['leave_types', 'leave_allocations', 'salary_components'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_updated_at', t);
  end loop;
  foreach t in array array['staff_holidays', 'leave_types', 'leave_allocations', 'leave_applications', 'staff_attendance', 'salary_components',
                           'salary_structures', 'salary_structure_items', 'payroll_runs', 'payslips', 'payslip_adjustments'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.prevent_school_change()', t || '_school_guard', t);
  end loop;
end $$;

-- a structure that a payslip used can't be edited or removed (add a new one from a later month)
create or replace function private.salary_structure_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_structure uuid;
begin
  if tg_table_name = 'salary_structures' then
    v_structure := old.id;
  elsif tg_op = 'INSERT' then
    v_structure := new.structure_id;
  else
    v_structure := old.structure_id;
    if tg_op = 'DELETE' and not exists (select 1 from public.salary_structures s where s.id = old.structure_id) then
      return old;   -- going with its structure
    end if;
  end if;
  if exists (select 1 from public.payslips p join public.payroll_runs r on r.id = p.run_id
             where p.structure_id = v_structure and r.status <> 'draft') then
    raise exception 'This salary structure was used in a finalized payroll. Add a new one from a later month instead.' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger salary_structures_guard before update or delete on public.salary_structures
  for each row execute function private.salary_structure_guard();
create trigger salary_structure_items_guard before insert or update or delete on public.salary_structure_items
  for each row execute function private.salary_structure_guard();

-- payslips and adjustments change only in a draft run
create or replace function private.payslip_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_run uuid;
begin
  if tg_table_name = 'payslips' then
    if tg_op = 'DELETE' then
      if not exists (select 1 from public.payroll_runs r where r.id = old.run_id) then return old; end if;
      v_run := old.run_id;
    else
      v_run := new.run_id;
    end if;
  elsif tg_op = 'DELETE' then
    if not exists (select 1 from public.payslips p where p.id = old.payslip_id) then return old; end if;
    select run_id into v_run from public.payslips where id = old.payslip_id;
  else
    select run_id into v_run from public.payslips where id = new.payslip_id;
  end if;
  if exists (select 1 from public.payroll_runs r where r.id = v_run and r.status <> 'draft') then
    raise exception 'This payroll is finalized. Reopen it to make changes.' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end $$;
create trigger payslips_guard before insert or update or delete on public.payslips for each row execute function private.payslip_guard();
create trigger payslip_adjustments_guard before insert or update or delete on public.payslip_adjustments
  for each row execute function private.payslip_guard();

-- ---------------------------------------------------------------------
-- Payroll
-- ---------------------------------------------------------------------
create or replace function private.payroll_recalc_net(p_payslip uuid) returns void language sql security definer set search_path = '' as $$
  update public.payslips p set
    adjustments_total = coalesce((select sum(amount) from public.payslip_adjustments a where a.payslip_id = p.id), 0),
    net_pay = p.gross_earned - p.total_deductions + coalesce((select sum(amount) from public.payslip_adjustments a where a.payslip_id = p.id), 0)
  where p.id = p_payslip;
$$;

-- Calculate (or recalculate) the month's draft payroll for every active staff member with a salary structure.
create or replace function private.payroll_generate(p_school uuid, p_month date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_run public.payroll_runs; st record; s public.hr_settings; d date; v_id uuid;
  v_cal int; v_work int; v_basis int;
  v_present numeric; v_absent numeric; v_half numeric; v_pleave numeric; v_uleave numeric; v_unmarked numeric; v_notjoined numeric; v_lop numeric;
  v_factor numeric; v_earn jsonb; v_ded jsonb; v_gross_full numeric; v_gross numeric; v_total_ded numeric; v_basic_earned numeric;
  lv record; att text; comp record; amt numeric; v_seen uuid[] := '{}';
begin
  if not private.is_payroll_admin(p_school) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  if v_month > date_trunc('month', private.ist_today())::date then
    raise exception 'Payroll can''t be run for a future month.' using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtext('payroll:' || p_school::text || v_month::text));
  select * into v_run from public.payroll_runs where school_id = p_school and month = v_month for update;
  if found and v_run.status <> 'draft' then
    raise exception 'Payroll for this month is already %. Reopen it to recalculate.', v_run.status using errcode = 'check_violation';
  end if;
  if not found then
    insert into public.payroll_runs (school_id, month, generated_by) values (p_school, v_month, auth.uid()) returning * into v_run;
  else
    update public.payroll_runs set generated_at = now(), generated_by = auth.uid() where id = v_run.id;
  end if;
  select * into s from public.hr_settings where school_id = p_school;
  if not found then s.weekly_offs := '{7}'; s.lop_basis := 'working_days'; s.unmarked_as := 'present'; end if;

  v_cal := v_end - v_month + 1;
  select count(*) into v_work from generate_series(v_month, v_end, interval '1 day') g where private.hr_working_day(p_school, g::date);

  for st in
    select t.id as teacher_id, t.employee_id, t.full_name, t.joining_date, ss.id as structure_id, ss.basic
    from public.teachers t
    join lateral (select * from public.salary_structures x where x.teacher_id = t.id and x.effective_from <= v_end
                  order by x.effective_from desc limit 1) ss on true
    where t.school_id = p_school and t.status = 'active' and t.joining_date <= v_end
  loop
    v_present := 0; v_absent := 0; v_half := 0; v_pleave := 0; v_uleave := 0; v_unmarked := 0; v_notjoined := 0;
    for d in select g::date from generate_series(v_month, v_end, interval '1 day') g loop
      continue when not private.hr_working_day(p_school, d);
      if d < st.joining_date then v_notjoined := v_notjoined + 1; continue; end if;
      select a.half_day, lt.is_paid into lv from public.leave_applications a join public.leave_types lt on lt.id = a.leave_type_id
        where a.teacher_id = st.teacher_id and a.status = 'approved' and d between a.start_date and a.end_date limit 1;
      if found then
        if lv.is_paid then v_pleave := v_pleave + case when lv.half_day then 0.5 else 1 end;
        else v_uleave := v_uleave + case when lv.half_day then 0.5 else 1 end; end if;
        if lv.half_day then v_present := v_present + 0.5; end if;   -- the other half of the day is worked
        continue;
      end if;
      select status into att from public.staff_attendance where teacher_id = st.teacher_id and attended_on = d;
      if att is null then v_unmarked := v_unmarked + 1;
      elsif att = 'present' then v_present := v_present + 1;
      elsif att = 'absent' then v_absent := v_absent + 1;
      else v_half := v_half + 1; end if;
    end loop;

    v_lop := v_absent + 0.5 * v_half + v_uleave + v_notjoined + case when s.unmarked_as = 'absent' then v_unmarked else 0 end;
    v_basis := case when s.lop_basis = 'calendar_days' then v_cal else v_work end;
    v_lop := least(v_lop, v_basis);
    v_factor := case when v_basis = 0 then 1 else (v_basis - v_lop) / v_basis end;

    -- earnings: basic, then the structure's earning components (fixed or % of basic)
    v_earn := jsonb_build_array(jsonb_build_object('name', 'Basic', 'full', st.basic, 'earned', round(st.basic * v_factor, 2)));
    v_gross_full := st.basic;
    v_basic_earned := round(st.basic * v_factor, 2);
    v_ded := '[]';
    v_total_ded := 0;
    for comp in
      select c.name, c.kind, i.calc, i.value from public.salary_structure_items i join public.salary_components c on c.id = i.component_id
      where i.structure_id = st.structure_id order by c.kind, c.display_order, c.name
    loop
      if comp.kind = 'earning' then
        amt := case when comp.calc = 'fixed' then comp.value else round(st.basic * comp.value / 100, 2) end;
        v_earn := v_earn || jsonb_build_object('name', comp.name, 'full', amt, 'earned', round(amt * v_factor, 2));
        v_gross_full := v_gross_full + amt;
      else
        -- percentage deductions follow the basic actually earned; fixed ones are as set
        amt := case when comp.calc = 'fixed' then comp.value else round(v_basic_earned * comp.value / 100, 2) end;
        v_ded := v_ded || jsonb_build_object('name', comp.name, 'amount', amt);
        v_total_ded := v_total_ded + amt;
      end if;
    end loop;
    select coalesce(sum((e ->> 'earned')::numeric), 0) into v_gross from jsonb_array_elements(v_earn) e;

    insert into public.payslips (school_id, run_id, teacher_id, structure_id, employee_id, staff_name, month, basic, earnings, deductions,
      gross_full, lop_days, lop_amount, gross_earned, total_deductions, net_pay, calendar_days, working_days, basis_days,
      present_days, absent_days, half_days, paid_leave_days, unpaid_leave_days, unmarked_days, not_joined_days, generated_at)
    values (p_school, v_run.id, st.teacher_id, st.structure_id, st.employee_id, st.full_name, v_month, st.basic, v_earn, v_ded,
      v_gross_full, v_lop, v_gross_full - v_gross, v_gross, v_total_ded, v_gross - v_total_ded, v_cal, v_work, v_basis,
      v_present, v_absent, v_half, v_pleave, v_uleave, v_unmarked, v_notjoined, now())
    on conflict (run_id, teacher_id) do update set structure_id = excluded.structure_id, employee_id = excluded.employee_id,
      staff_name = excluded.staff_name, basic = excluded.basic, earnings = excluded.earnings, deductions = excluded.deductions,
      gross_full = excluded.gross_full, lop_days = excluded.lop_days, lop_amount = excluded.lop_amount, gross_earned = excluded.gross_earned,
      total_deductions = excluded.total_deductions, calendar_days = excluded.calendar_days, working_days = excluded.working_days,
      basis_days = excluded.basis_days, present_days = excluded.present_days, absent_days = excluded.absent_days, half_days = excluded.half_days,
      paid_leave_days = excluded.paid_leave_days, unpaid_leave_days = excluded.unpaid_leave_days, unmarked_days = excluded.unmarked_days,
      not_joined_days = excluded.not_joined_days, generated_at = now()
    returning id into v_id;
    perform private.payroll_recalc_net(v_id);   -- keeps any adjustments already made
    v_seen := v_seen || st.teacher_id;
  end loop;
  -- staff no longer eligible (no structure, inactive) drop out of the draft
  delete from public.payslips where run_id = v_run.id and not (teacher_id = any (v_seen));
  return v_run.id;
end $$;

create or replace function private.payroll_adjust(p_payslip uuid, p_label text, p_amount numeric)
returns uuid language plpgsql security definer set search_path = '' as $$
declare p public.payslips; v_id uuid;
begin
  select * into p from public.payslips where id = p_payslip;
  if not found or not private.is_payroll_admin(p.school_id) then raise exception 'Payslip not found.' using errcode = 'P0002'; end if;
  insert into public.payslip_adjustments (school_id, payslip_id, label, amount, created_by)
  values (p.school_id, p.id, btrim(p_label), p_amount, auth.uid()) returning id into v_id;
  perform private.payroll_recalc_net(p.id);
  return v_id;
end $$;

create or replace function private.payroll_remove_adjustment(p_adjustment uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.payslip_adjustments;
begin
  select * into a from public.payslip_adjustments where id = p_adjustment;
  if not found or not private.is_payroll_admin(a.school_id) then raise exception 'Adjustment not found.' using errcode = 'P0002'; end if;
  delete from public.payslip_adjustments where id = a.id;
  perform private.payroll_recalc_net(a.payslip_id);
end $$;

create or replace function private.payroll_set_status(p_run uuid, p_action text, p_paid_on date, p_mode text, p_reference text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.payroll_runs; v_end date;
begin
  select * into r from public.payroll_runs where id = p_run for update;
  if not found or not private.is_payroll_admin(r.school_id) then raise exception 'Payroll not found.' using errcode = 'P0002'; end if;
  v_end := (r.month + interval '1 month - 1 day')::date;
  if p_action = 'finalize' then
    if r.status <> 'draft' then raise exception 'This payroll is already %.', r.status using errcode = 'check_violation'; end if;
    if private.ist_today() < v_end then
      raise exception 'A month''s payroll can be finalized from its last day (%).', to_char(v_end, 'DD Mon YYYY') using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.payslips where run_id = r.id) then
      raise exception 'There are no payslips. Add salary structures and recalculate.' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.payslips where run_id = r.id and net_pay < 0) then
      raise exception 'A payslip has a negative net pay. Correct its deductions or adjustments first.' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.leave_applications a where a.school_id = r.school_id and a.status = 'pending'
               and a.start_date <= v_end and a.end_date >= r.month) then
      raise exception 'Some leave for this month is still pending. Approve or reject it first.' using errcode = 'check_violation';
    end if;
    update public.payroll_runs set status = 'finalized', finalized_at = now(), finalized_by = auth.uid() where id = r.id;
  elsif p_action = 'reopen' then
    if r.status <> 'finalized' then raise exception 'Only a finalized, unpaid payroll can be reopened.' using errcode = 'check_violation'; end if;
    if nullif(btrim(p_note), '') is null then raise exception 'Give the reason for reopening.' using errcode = 'check_violation'; end if;
    update public.payroll_runs set status = 'draft', finalized_at = null, finalized_by = null, reopen_note = btrim(p_note) where id = r.id;
  elsif p_action = 'paid' then
    if r.status <> 'finalized' then raise exception 'Finalize the payroll before marking it paid.' using errcode = 'check_violation'; end if;
    if p_paid_on is null or p_paid_on > private.ist_today() or p_paid_on < r.month then
      raise exception 'Enter the payment date (not before the month, not in the future).' using errcode = 'check_violation';
    end if;
    if p_mode not in ('bank_transfer', 'cheque', 'cash', 'upi') then raise exception 'Choose how salaries were paid.' using errcode = 'check_violation'; end if;
    update public.payroll_runs set status = 'paid', paid_on = p_paid_on, payment_mode = p_mode,
      payment_reference = nullif(btrim(p_reference), '') where id = r.id;
  else
    raise exception 'Unknown action.' using errcode = 'check_violation';
  end if;
end $$;

-- runs: a paid run is final; a run with payslips is never deleted unless it's a draft
create or replace function private.payroll_run_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and exists (select 1 from public.schools s where s.id = old.school_id)
       and current_setting('hr.allow_delete', true) is distinct from 'on' then
      raise exception 'A finalized payroll can''t be deleted.' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'paid' then raise exception 'This payroll is paid and closed.' using errcode = 'check_violation'; end if;
  if new.month <> old.month then raise exception 'A payroll''s month can''t change.' using errcode = 'check_violation'; end if;
  return new;
end $$;
create trigger payroll_runs_guard before update or delete on public.payroll_runs for each row execute function private.payroll_run_guard();

-- ---------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------
revoke all on public.hr_settings, public.staff_holidays, public.leave_types, public.leave_allocations, public.leave_applications,
  public.staff_attendance, public.salary_components, public.salary_structures, public.salary_structure_items, public.payroll_runs,
  public.payslips, public.payslip_adjustments from anon, authenticated;

grant select on public.hr_settings, public.staff_holidays, public.leave_types, public.leave_allocations, public.leave_applications,
  public.staff_attendance to authenticated;
grant insert, update on public.hr_settings to authenticated;
grant insert, update, delete on public.staff_holidays, public.leave_types, public.leave_allocations, public.staff_attendance to authenticated;
-- leave applications: only through leave_apply / leave_decide / leave_cancel

grant select on public.salary_components, public.salary_structures, public.salary_structure_items, public.payroll_runs,
  public.payslips, public.payslip_adjustments to authenticated;
grant insert, update, delete on public.salary_components, public.salary_structures, public.salary_structure_items to authenticated;
grant delete on public.payroll_runs to authenticated;
-- runs, payslips and adjustments: only through the payroll functions

do $$ declare t text; begin
  foreach t in array array['hr_settings', 'staff_holidays', 'leave_types', 'leave_allocations', 'leave_applications', 'staff_attendance',
                           'salary_components', 'salary_structures', 'salary_structure_items', 'payroll_runs', 'payslips', 'payslip_adjustments'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- payroll: payroll admins only, for reading and writing
  foreach t in array array['salary_components', 'salary_structures', 'salary_structure_items', 'payroll_runs', 'payslips', 'payslip_adjustments'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_payroll_admin(school_id))', t || '_select', t);
  end loop;
  foreach t in array array['salary_components', 'salary_structures', 'salary_structure_items'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_payroll_admin(school_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_payroll_admin(school_id)) with check (private.is_payroll_admin(school_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_payroll_admin(school_id))', t || '_delete', t);
  end loop;
  -- HR setup: readable by the school's members (staff need leave types, holidays and the week to apply); written by HR admins
  foreach t in array array['hr_settings', 'staff_holidays', 'leave_types'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_super_admin() or private.is_school_member(school_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_hr_admin(school_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_hr_admin(school_id)) with check (private.is_hr_admin(school_id))', t || '_update', t);
  end loop;
  foreach t in array array['staff_holidays', 'leave_types', 'leave_allocations', 'staff_attendance'] loop
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_hr_admin(school_id))', t || '_delete', t);
  end loop;
  -- a staff member's own leave and attendance; everyone's for HR admins
  foreach t in array array['leave_allocations', 'leave_applications', 'staff_attendance'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_hr_admin(school_id) or teacher_id = private.current_staff_id(school_id))', t || '_select', t);
  end loop;
  foreach t in array array['leave_allocations', 'staff_attendance'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_hr_admin(school_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.is_hr_admin(school_id)) with check (private.is_hr_admin(school_id))', t || '_update', t);
  end loop;
end $$;
create policy payroll_runs_delete on public.payroll_runs for delete to authenticated using (private.is_payroll_admin(school_id) and status = 'draft');

revoke all on function private.is_hr_admin(uuid), private.is_payroll_admin(uuid), private.current_staff_id(uuid), private.hr_working_day(uuid, date),
  private.payroll_locked(uuid, date, date), private.leave_days(uuid, date, date, boolean), private.leave_balance(uuid, uuid, uuid, uuid),
  private.leave_apply(uuid, uuid, uuid, date, date, boolean, text), private.leave_decide(uuid, boolean, text), private.leave_cancel(uuid, text),
  private.payroll_recalc_net(uuid), private.payroll_generate(uuid, date), private.payroll_adjust(uuid, text, numeric),
  private.payroll_remove_adjustment(uuid), private.payroll_set_status(uuid, text, date, text, text, text)
  from public, anon, authenticated;
grant execute on function private.is_hr_admin(uuid), private.is_payroll_admin(uuid), private.current_staff_id(uuid), private.hr_working_day(uuid, date),
  private.payroll_locked(uuid, date, date), private.leave_days(uuid, date, date, boolean),
  private.leave_apply(uuid, uuid, uuid, date, date, boolean, text), private.leave_decide(uuid, boolean, text), private.leave_cancel(uuid, text),
  private.payroll_generate(uuid, date), private.payroll_adjust(uuid, text, numeric),
  private.payroll_remove_adjustment(uuid), private.payroll_set_status(uuid, text, date, text, text, text)
  to authenticated;

-- a balance is visible to HR admins and to the staff member themself
create or replace function private.leave_balances(p_school uuid, p_teacher uuid, p_session uuid)
returns table (leave_type_id uuid, name text, code text, is_paid boolean, allowance numeric, used numeric, pending numeric, available numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.is_hr_admin(p_school) or p_teacher = private.current_staff_id(p_school)) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  return query
    select t.id, t.name, t.code, t.is_paid, b.allowance, b.used, b.pending, b.available
    from public.leave_types t, lateral private.leave_balance(p_teacher, t.id, p_session) b
    where t.school_id = p_school and (t.is_active or b.used > 0 or b.pending > 0)
    order by t.is_paid desc, t.name;
end $$;
revoke all on function private.leave_balances(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function private.leave_balances(uuid, uuid, uuid) to authenticated;
