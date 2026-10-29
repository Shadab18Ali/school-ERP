-- =====================================================================
-- Leave and payroll test (migrations 0001-0025). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL HR AND PAYROLL TESTS PASSED".
-- Dates are relative to today: the payroll month M is last month; the session runs from
-- six months ago for a year. Sunday is the weekly off.
-- School A: admin, accountant, Teacher One (login), Teacher Two (login, joins mid-M),
-- a librarian with a staff record but no salary, a parent. School B: admin.
-- =====================================================================
begin;

create function private._h_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._h_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._h_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._h_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- the payroll month and its working days (Sunday off), numbered from 1
create function private._h_m() returns date language sql stable as $$ select (date_trunc('month', private.ist_today()) - interval '1 month')::date $$;
create function private._h_wd(n int) returns date language sql stable as $$
  select d::date from generate_series(private._h_m(), (private._h_m() + interval '1 month - 1 day')::date, interval '1 day') d
  where extract(isodow from d) <> 7 order by d offset n - 1 limit 1;
$$;
-- an id by name (owner's view)
create function private._h_leave(p_reason text) returns uuid language sql security definer set search_path = '' as $$
  select id from public.leave_applications where reason = p_reason;
$$;
create function private._h_slip(p_name text) returns public.payslips language sql security definer set search_path = '' as $$
  select * from public.payslips where staff_name = p_name order by month desc limit 1;
$$;
create function private._h_run() returns uuid language sql security definer set search_path = '' as $$
  select id from public.payroll_runs where school_id = 'b2600000-0000-4000-8000-00000000000a' and month = private._h_m();
$$;
grant execute on function private._h_assert(boolean, text), private._h_eq(numeric, numeric, text), private._h_raises(text, text, text, text),
  private._h_as(uuid), private._h_m(), private._h_wd(int), private._h_leave(text), private._h_slip(text), private._h_run() to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a2600000-0000-4000-8000-000000000001', 'hr-admin@example.invalid'),
  ('a2600000-0000-4000-8000-000000000002', 'hr-accountant@example.invalid'),
  ('a2600000-0000-4000-8000-000000000003', 'hr-teacher1@example.invalid'),
  ('a2600000-0000-4000-8000-000000000004', 'hr-teacher2@example.invalid'),
  ('a2600000-0000-4000-8000-000000000005', 'hr-librarian@example.invalid'),
  ('a2600000-0000-4000-8000-000000000006', 'hr-parent@example.invalid'),
  ('a2600000-0000-4000-8000-000000000007', 'hr-admin-b@example.invalid'),
  ('a2600000-0000-4000-8000-000000000008', 'hr-principal@example.invalid'),
  ('a2600000-0000-4000-8000-000000000009', 'hr-platform@example.invalid');
update public.profiles set is_super_admin = true where id = 'a2600000-0000-4000-8000-000000000009';
insert into public.schools (id, name, code) values
  ('b2600000-0000-4000-8000-00000000000a', 'HR A', 'ZZHR-A'),
  ('b2600000-0000-4000-8000-00000000000b', 'HR B', 'ZZHR-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b2600000-0000-4000-8000-00000000000a', 'a2600000-0000-4000-8000-000000000001', 'school_admin'),
  ('b2600000-0000-4000-8000-00000000000a', 'a2600000-0000-4000-8000-000000000002', 'accountant'),
  ('b2600000-0000-4000-8000-00000000000a', 'a2600000-0000-4000-8000-000000000003', 'teacher'),
  ('b2600000-0000-4000-8000-00000000000a', 'a2600000-0000-4000-8000-000000000004', 'teacher'),
  ('b2600000-0000-4000-8000-00000000000a', 'a2600000-0000-4000-8000-000000000005', 'librarian'),
  ('b2600000-0000-4000-8000-00000000000a', 'a2600000-0000-4000-8000-000000000006', 'parent'),
  ('b2600000-0000-4000-8000-00000000000b', 'a2600000-0000-4000-8000-000000000007', 'school_admin'),
  ('b2600000-0000-4000-8000-00000000000a', 'a2600000-0000-4000-8000-000000000008', 'school_admin'),   -- a principal who also teaches
  ('b2600000-0000-4000-8000-00000000000a', 'a2600000-0000-4000-8000-000000000008', 'teacher');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c2600000-0000-4000-8000-000000000001', 'b2600000-0000-4000-8000-00000000000a', 'This year',
   (date_trunc('month', private.ist_today()) - interval '6 months')::date, (date_trunc('month', private.ist_today()) + interval '6 months - 1 day')::date, true);
insert into public.teachers (id, school_id, employee_id, full_name, phone, email, joining_date, account_id) values
  ('d2600000-0000-4000-8000-000000000001', 'b2600000-0000-4000-8000-00000000000a', 'T-1', 'Teacher One', '9811111111', 'hr-teacher1@example.invalid', '2020-06-01', 'a2600000-0000-4000-8000-000000000003'),
  ('d2600000-0000-4000-8000-000000000002', 'b2600000-0000-4000-8000-00000000000a', 'T-2', 'Teacher Two', '9811111112', 'hr-teacher2@example.invalid', private._h_wd(4), 'a2600000-0000-4000-8000-000000000004'),
  ('d2600000-0000-4000-8000-000000000003', 'b2600000-0000-4000-8000-00000000000a', 'L-1', 'Librarian One', '9811111113', 'hr-librarian@example.invalid', '2020-06-01', null),
  ('d2600000-0000-4000-8000-000000000004', 'b2600000-0000-4000-8000-00000000000a', 'P-1', 'Principal One', '9811111114', 'hr-principal@example.invalid', '2015-06-01', 'a2600000-0000-4000-8000-000000000008');

-- ================= setup by the admin =================
select private._h_as('a2600000-0000-4000-8000-000000000001');
insert into public.hr_settings (school_id) values ('b2600000-0000-4000-8000-00000000000a');
insert into public.leave_types (id, school_id, name, code, annual_days, is_paid, allow_half_day) values
  ('e2600000-0000-4000-8000-000000000001', 'b2600000-0000-4000-8000-00000000000a', 'Casual leave', 'CL', 12, true, true),
  ('e2600000-0000-4000-8000-000000000002', 'b2600000-0000-4000-8000-00000000000a', 'Leave without pay', 'LWP', null, false, false),
  ('e2600000-0000-4000-8000-000000000003', 'b2600000-0000-4000-8000-00000000000a', 'Earned leave', 'EL', 2, true, false);
select private._h_raises($q$insert into public.leave_types (school_id, name, code, annual_days) values ('b2600000-0000-4000-8000-00000000000a', 'Odd', 'OD', 1.3)$q$,
  '23514', 'allowances are in half days');
insert into public.staff_holidays (school_id, holiday_on, name) values ('b2600000-0000-4000-8000-00000000000a', private._h_wd(1), 'Founders day');
-- after the holiday, the first working day of M is wd(2)

-- ================= leave: staff apply =================
select private._h_as('a2600000-0000-4000-8000-000000000003');  -- Teacher One
select private._h_assert(private.current_staff_id('b2600000-0000-4000-8000-00000000000a') = 'd2600000-0000-4000-8000-000000000001', 'a teacher''s own staff record');
select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000001', private._h_wd(5), private._h_wd(5), false, 'cl in M');
select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000002', private._h_wd(6), private._h_wd(6), false, 'lwp in M');
select private._h_assert((select days = 1 and status = 'pending' and teacher_id = 'd2600000-0000-4000-8000-000000000001'
  from public.leave_applications where reason = 'cl in M'), 'a teacher applies for themself; the application is pending');
select private._h_raises($q$select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000001', private._h_wd(5), private._h_wd(7), false, 'overlap')$q$,
  '23514', 'no overlapping leave', 'already a leave');
select private._h_raises($q$select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000003', private.ist_today() + 1, private.ist_today() + 20, false, 'too much EL')$q$,
  '23514', 'not beyond the balance', 'left this session');
select private._h_raises($q$select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000002', private.ist_today() + 1, private.ist_today() + 1, true, 'half lwp')$q$,
  '23514', 'no half days for a type that doesn''t allow them', 'half day');
select private._h_raises($q$select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000001', private.ist_today() + 1, private.ist_today() + 2, true, 'half two days')$q$,
  '23514', 'a half day is a single day');
select private._h_raises($q$select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000001', private.ist_today() + 150, private.ist_today() + 200, false, 'past session')$q$,
  '23514', 'within one session', 'academic session');
select private._h_raises($q$select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000001', private._h_wd(1), private._h_wd(1), false, 'holiday')$q$,
  '23514', 'not on holidays only', 'holidays');
select private._h_raises($q$select private.leave_apply('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000002', 'e2600000-0000-4000-8000-000000000001', private.ist_today() + 1, private.ist_today() + 1, false, 'for a colleague')$q$,
  '42501', 'staff apply only for themselves');
-- a future week of CL: working days only (Sundays don't count)
select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000001',
  private.ist_today() + 7, private.ist_today() + 13, false, 'future week');
select private._h_eq((select days from public.leave_applications where reason = 'future week'), 6, 'seven days with one Sunday = 6 leave days');
select private._h_assert((select allowance = 12 and used = 0 and pending = 7 and available = 5
  from private.leave_balances('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', 'c2600000-0000-4000-8000-000000000001')
  where code = 'CL'), 'balance: 12 allowed, 7 pending, 5 available');
select private._h_assert((select allowance is null and available is null
  from private.leave_balances('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', 'c2600000-0000-4000-8000-000000000001')
  where code = 'LWP'), 'unpaid leave has no limit');
select private._h_raises($q$select * from private.leave_balances('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000002', 'c2600000-0000-4000-8000-000000000001')$q$,
  '42501', 'not a colleague''s balance');
select private._h_raises($q$select private.leave_decide(private._h_leave('cl in M'), true, null)$q$, 'P0002', 'staff can''t approve');
select private._h_raises($q$update public.leave_applications set status = 'approved' where reason = 'cl in M'$q$, '42501', 'nor approve by editing');
select private._h_eq((select count(*) from public.leave_applications), 3, 'a teacher sees their own leave');
select private.leave_cancel(private._h_leave('future week'), 'plans changed');
select private._h_assert((select status = 'cancelled' from public.leave_applications where reason = 'future week'), 'staff cancel their own pending leave');

select private._h_as('a2600000-0000-4000-8000-000000000004');  -- Teacher Two
select private._h_eq((select count(*) from public.leave_applications), 0, 'another teacher sees none of it');
select private._h_raises($q$select private.leave_cancel(private._h_leave('cl in M'), null)$q$, 'P0002', 'nor cancels it');
-- people with no staff record in school A (another school's admin, a parent): "own leave" must not
-- count as true for them (a NULL comparison once let these through)
select private._h_as('a2600000-0000-4000-8000-000000000007');  -- school B's admin
select private._h_raises($q$select private.leave_cancel(private._h_leave('cl in M'), null)$q$, 'P0002', 'another school''s admin can''t cancel school A''s leave');
select private._h_raises($q$select * from private.leave_balances('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', 'c2600000-0000-4000-8000-000000000001')$q$,
  '42501', 'nor see a school A teacher''s balance');
select private._h_as('a2600000-0000-4000-8000-000000000006');  -- a parent in school A
select private._h_raises($q$select private.leave_cancel(private._h_leave('cl in M'), null)$q$, 'P0002', 'a parent can''t cancel staff leave');
select private._h_raises($q$select * from private.leave_balances('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', 'c2600000-0000-4000-8000-000000000001')$q$,
  '42501', 'nor see staff balances');

-- ================= leave: the admin decides =================
select private._h_as('a2600000-0000-4000-8000-000000000001');
select private._h_raises($q$select private.leave_decide(private._h_leave('lwp in M'), false, '  ')$q$, '23514', 'a rejection needs a reason', 'reason');
select private.leave_decide(private._h_leave('cl in M'), true, null);
select private.leave_decide(private._h_leave('lwp in M'), true, 'ok');
select private._h_raises($q$select private.leave_decide(private._h_leave('cl in M'), false, 'no')$q$, '23514', 'decided once', 'already approved');
select private._h_assert((select used = 1 and pending = 0 and available = 11
  from private.leave_balances('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', 'c2600000-0000-4000-8000-000000000001')
  where code = 'CL'), 'approved leave is used from the balance');
-- a different allowance for one person
insert into public.leave_allocations (school_id, teacher_id, leave_type_id, academic_session_id, days)
values ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', 'e2600000-0000-4000-8000-000000000003', 'c2600000-0000-4000-8000-000000000001', 10);
select private._h_eq((select allowance from private.leave_balances('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001',
  'c2600000-0000-4000-8000-000000000001') where code = 'EL'), 10, 'an allocation overrides the yearly allowance');
-- the admin applies for someone, then rejects it
select private.leave_apply('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000002', 'e2600000-0000-4000-8000-000000000001',
  private.ist_today() + 1, private.ist_today() + 1, true, 'admin entered');
select private.leave_decide(private._h_leave('admin entered'), false, 'exam duty');
select private._h_raises($q$select private.leave_cancel(private._h_leave('admin entered'), null)$q$, '23514', 'a rejected leave stays rejected', 'already rejected');
select private._h_raises($q$delete from public.leave_applications where reason = 'admin entered'$q$, '42501', 'leave history isn''t deleted');
-- an administrator can't approve their own leave; another one decides it
select private._h_as('a2600000-0000-4000-8000-000000000008');  -- the principal, also on the staff list
select private.leave_apply('b2600000-0000-4000-8000-00000000000a', null, 'e2600000-0000-4000-8000-000000000001',
  private.ist_today() + 2, private.ist_today() + 2, false, 'principal own');
select private._h_raises($q$select private.leave_decide(private._h_leave('principal own'), true, null)$q$, '42501', 'nobody approves their own leave', 'own leave');
select private._h_as('a2600000-0000-4000-8000-000000000001');
select private.leave_decide(private._h_leave('principal own'), false, 'board meeting');
select private._h_assert((select status = 'rejected' from public.leave_applications where reason = 'principal own'), 'another admin decides it');

-- ================= staff attendance =================
insert into public.staff_attendance (school_id, teacher_id, attended_on, status) values
  ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', private._h_wd(3), 'absent'),
  ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', private._h_wd(4), 'half_day'),
  ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', private._h_wd(2), 'present');
select private._h_raises($q$insert into public.staff_attendance (school_id, teacher_id, attended_on, status)
  values ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', private.ist_today() + 1, 'present')$q$,
  '23514', 'not for future dates', 'future');
select private._h_as('a2600000-0000-4000-8000-000000000003');
select private._h_raises($q$insert into public.staff_attendance (school_id, teacher_id, attended_on, status)
  values ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', private.ist_today(), 'present')$q$,
  '42501', 'staff don''t mark their own attendance');
select private._h_eq((select count(*) from public.staff_attendance), 3, 'but see it');

-- ================= payroll is for payroll admins only =================
select private._h_as('a2600000-0000-4000-8000-000000000001');
insert into public.salary_components (id, school_id, name, kind, calc, default_value, display_order) values
  ('f2600000-0000-4000-8000-000000000001', 'b2600000-0000-4000-8000-00000000000a', 'House rent allowance', 'earning', 'percent_basic', 40, 1),
  ('f2600000-0000-4000-8000-000000000002', 'b2600000-0000-4000-8000-00000000000a', 'Transport allowance', 'earning', 'fixed', 1600, 2),
  ('f2600000-0000-4000-8000-000000000003', 'b2600000-0000-4000-8000-00000000000a', 'Provident fund', 'deduction', 'percent_basic', 12, 1),
  ('f2600000-0000-4000-8000-000000000004', 'b2600000-0000-4000-8000-00000000000a', 'Professional tax', 'deduction', 'fixed', 200, 2);
select private._h_raises($q$insert into public.salary_components (school_id, name, kind, calc, default_value) values ('b2600000-0000-4000-8000-00000000000a', 'Too much', 'earning', 'percent_basic', 150)$q$,
  '23514', 'a percentage is at most 100');
insert into public.salary_structures (id, school_id, teacher_id, effective_from, basic) values
  ('92600000-0000-4000-8000-000000000001', 'b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', (private._h_m() - interval '2 months')::date, 30000),
  ('92600000-0000-4000-8000-000000000002', 'b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000002', private._h_m(), 20000),
  ('92600000-0000-4000-8000-000000000003', 'b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', date_trunc('month', private.ist_today())::date, 99999);
insert into public.salary_structure_items (school_id, structure_id, component_id, calc, value)
select 'b2600000-0000-4000-8000-00000000000a', '92600000-0000-4000-8000-000000000001', id, calc, default_value from public.salary_components;
select private._h_raises($q$insert into public.salary_structures (school_id, teacher_id, effective_from, basic) values ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000002', private._h_m() + 3, 1)$q$,
  '23514', 'a structure starts on the 1st of a month');

select private._h_as('a2600000-0000-4000-8000-000000000002');  -- accountant
select private._h_eq((select count(*) from public.salary_components) + (select count(*) from public.salary_structures), 0, 'the accountant sees no payroll');
select private._h_raises($q$select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m())$q$, '42501', 'nor runs it');
select private._h_raises($q$insert into public.salary_components (school_id, name, kind) values ('b2600000-0000-4000-8000-00000000000a', 'Sneaky', 'earning')$q$, '42501', 'nor sets it up');
select private._h_as('a2600000-0000-4000-8000-000000000003');  -- teacher
select private._h_eq((select count(*) from public.salary_structures), 0, 'a teacher can''t see salaries, even their own');
select private._h_as('a2600000-0000-4000-8000-000000000007');  -- admin of school B
select private._h_raises($q$select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m())$q$, '42501', 'another school''s admin can''t run it');
select private._h_eq((select count(*) from public.salary_components), 0, 'or see its components');
select private._h_as('a2600000-0000-4000-8000-000000000009');  -- platform super admin
select private._h_eq((select count(*) from public.salary_components) + (select count(*) from public.salary_structures), 0,
  'a platform super admin can''t see a school''s payroll');
select private._h_raises($q$select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m())$q$, '42501', 'or run it');
select private._h_assert((select count(*) from public.leave_applications) > 0, 'though leave stays visible to them (support)');

-- ================= the month's payroll =================
select private._h_as('a2600000-0000-4000-8000-000000000001');
select private._h_raises($q$select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', (date_trunc('month', private.ist_today()) + interval '1 month')::date)$q$,
  '23514', 'not for a future month', 'future');
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m());
select private._h_eq((select count(*) from public.payslips where run_id = private._h_run()), 2, 'staff with a salary structure get a payslip (not the librarian)');
do $$
declare p public.payslips; w int; f numeric; b numeric; h numeric; t numeric;
begin
  p := private._h_slip('Teacher One');
  select count(*) into w from generate_series(private._h_m(), (private._h_m() + interval '1 month - 1 day')::date, interval '1 day') d
    where extract(isodow from d) <> 7 and d::date <> private._h_wd(1);
  perform private._h_eq(p.working_days, w, 'working days: weekdays and Saturdays, less the holiday');
  perform private._h_eq(p.basic, 30000, 'the structure in force that month (not the newer one)');
  perform private._h_eq(p.absent_days, 1, 'absent');
  perform private._h_eq(p.half_days, 1, 'half day');
  perform private._h_eq(p.paid_leave_days, 1, 'paid leave');
  perform private._h_eq(p.unpaid_leave_days, 1, 'unpaid leave');
  perform private._h_eq(p.present_days, 1, 'marked present');
  perform private._h_eq(p.unmarked_days, w - 5, 'the rest unmarked (counted as present)');
  perform private._h_eq(p.lop_days, 2.5, 'loss of pay = absent + ½ half day + unpaid leave');
  perform private._h_eq(p.gross_full, 43600, 'full gross = 30000 + 40% HRA + 1600');
  f := (w - 2.5) / w;
  b := round(30000 * f, 2); h := round(12000 * f, 2); t := round(1600 * f, 2);
  perform private._h_eq(p.gross_earned, b + h + t, 'earnings are paid for the days not lost');
  perform private._h_eq(p.lop_amount, 43600 - (b + h + t), 'the leave / absence deduction is the difference');
  perform private._h_eq(p.total_deductions, round(b * 0.12, 2) + 200, 'PF on the basic earned + professional tax');
  perform private._h_eq(p.net_pay, b + h + t - round(b * 0.12, 2) - 200, 'net pay');
  p := private._h_slip('Teacher Two');
  select count(*) into w from generate_series(private._h_m(), private._h_wd(4) - 1, interval '1 day') d
    where extract(isodow from d) <> 7 and d::date <> private._h_wd(1);
  perform private._h_eq(p.not_joined_days, w, 'days before joining are unpaid');
  perform private._h_eq(p.lop_days, w, 'and are loss of pay');
end $$;
-- unmarked days can count as absent instead (a school setting)
update public.hr_settings set unmarked_as = 'absent' where school_id = 'b2600000-0000-4000-8000-00000000000a';
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m());
select private._h_eq((private._h_slip('Teacher One')).lop_days, 2.5 + (private._h_slip('Teacher One')).unmarked_days, 'unmarked days as absent');
update public.hr_settings set unmarked_as = 'present' where school_id = 'b2600000-0000-4000-8000-00000000000a';
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m());

-- adjustments
select private.payroll_adjust((private._h_slip('Teacher One')).id, 'Exam duty', 500);
select private.payroll_adjust((private._h_slip('Teacher One')).id, 'Advance recovery', -1000);
select private._h_assert((select adjustments_total = -500 and net_pay = gross_earned - total_deductions - 500 from private._h_slip('Teacher One')),
  'adjustments add to or recover from net pay');
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m());
select private._h_eq((private._h_slip('Teacher One')).adjustments_total, -500, 'recalculating keeps the adjustments');
insert into public.staff_attendance (school_id, teacher_id, attended_on, status) values
  ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000001', private._h_wd(7), 'absent');
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m());
select private._h_assert((select lop_days = 3.5 and net_pay = gross_earned - total_deductions - 500 from private._h_slip('Teacher One')),
  'after recalculating, net pay = new earnings − deductions + the adjustments');
delete from public.staff_attendance where teacher_id = 'd2600000-0000-4000-8000-000000000001' and attended_on = private._h_wd(7);
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m());
select private._h_raises($q$update public.payslips set net_pay = 1$q$, '42501', 'payslips aren''t edited directly');

-- pending leave in the month blocks finalizing
select private.leave_apply('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000002', 'e2600000-0000-4000-8000-000000000002',
  private._h_wd(10), private._h_wd(10), false, 'pending in M');
select private._h_raises($q$select private.payroll_set_status(private._h_run(), 'finalize', null, null, null, null)$q$, '23514', 'pending leave first', 'pending');
select private.leave_decide(private._h_leave('pending in M'), true, null);
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m());
select private._h_eq((private._h_slip('Teacher Two')).unpaid_leave_days, 1, 'newly approved unpaid leave counts after recalculating');
select private.payroll_set_status(private._h_run(), 'finalize', null, null, null, null);

-- ================= a finalized month is locked =================
select private._h_raises($q$update public.staff_attendance set status = 'present' where attended_on = private._h_wd(3)$q$, '23514', 'attendance locked', 'finalized');
select private._h_raises($q$insert into public.staff_attendance (school_id, teacher_id, attended_on, status) values ('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000002', private._h_wd(8), 'absent')$q$,
  '23514', 'no new attendance either', 'finalized');
select private._h_raises($q$insert into public.staff_holidays (school_id, holiday_on, name) values ('b2600000-0000-4000-8000-00000000000a', private._h_wd(9), 'Late holiday')$q$,
  '23514', 'holidays locked', 'finalized');
select private._h_raises($q$select private.leave_cancel(private._h_leave('cl in M'), 'oops')$q$, '23514', 'approved leave locked', 'finalized');
select private._h_raises($q$select private.leave_apply('b2600000-0000-4000-8000-00000000000a', 'd2600000-0000-4000-8000-000000000002', 'e2600000-0000-4000-8000-000000000001', private._h_wd(12), private._h_wd(12), false, 'late')$q$,
  '23514', 'no new leave in a finalized month', 'finalized');
select private._h_raises($q$select private.payroll_adjust((private._h_slip('Teacher One')).id, 'Late bonus', 100)$q$, '23514', 'no adjustments', 'finalized');
select private._h_raises($q$select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m())$q$, '23514', 'no recalculating', 'already finalized');
select private._h_raises($q$update public.salary_structures set basic = 1 where id = '92600000-0000-4000-8000-000000000001'$q$, '23514', 'a structure used in it is fixed', 'later month');
delete from public.payroll_runs where id = private._h_run();
select private._h_assert(private._h_run() is not null, 'a finalized payroll isn''t deleted (RLS: drafts only)');
select private._h_raises($q$select private.payroll_set_status(private._h_run(), 'reopen', null, null, null, ' ')$q$, '23514', 'reopening needs a reason', 'reason');
select private.payroll_set_status(private._h_run(), 'reopen', null, null, null, 'wrong attendance');
update public.staff_attendance set status = 'present' where teacher_id = 'd2600000-0000-4000-8000-000000000001' and attended_on = private._h_wd(3);
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private._h_m());
select private._h_eq((private._h_slip('Teacher One')).lop_days, 1.5, 'after reopening, the corrected attendance counts');
select private.payroll_set_status(private._h_run(), 'finalize', null, null, null, null);
select private._h_raises($q$select private.payroll_set_status(private._h_run(), 'paid', private.ist_today() + 1, 'bank_transfer', null, null)$q$, '23514', 'not paid in the future', 'payment date');
select private.payroll_set_status(private._h_run(), 'paid', private.ist_today(), 'bank_transfer', 'NEFT-1', null);
select private._h_raises($q$select private.payroll_set_status(private._h_run(), 'reopen', null, null, null, 'again')$q$, '23514', 'a paid payroll stays closed', 'unpaid');

-- the current month can be drafted but not finalized before its last day
select private.payroll_generate('b2600000-0000-4000-8000-00000000000a', private.ist_today());
select private._h_eq((private._h_slip('Teacher One')).basic, 99999, 'this month uses the newer structure');
do $$ begin
  if private.ist_today() < (date_trunc('month', private.ist_today()) + interval '1 month - 1 day')::date then
    perform private._h_raises($q$select private.payroll_set_status((select id from public.payroll_runs where month = date_trunc('month', private.ist_today())::date), 'finalize', null, null, null, null)$q$,
      '23514', 'not finalized before the month ends', 'last day');
  end if;
end $$;
delete from public.payroll_runs where month = date_trunc('month', private.ist_today())::date;
select private._h_eq((select count(*) from public.payroll_runs), 1, 'a draft payroll can be discarded');

-- ================= even the owner can't rewrite a closed month =================
reset role;
select private._h_raises($q$update public.payslips set net_pay = 0 where staff_name = 'Teacher One'$q$, '23514', 'payslips of a paid run are fixed for everyone', 'finalized');
select private._h_raises($q$delete from public.payroll_runs where status <> 'draft'$q$, '23514', 'nor deleted, by anyone', 'deleted');
select private._h_raises($q$update public.leave_applications set start_date = start_date - 1 where reason = 'cl in M'$q$, '23514', 'leave dates never change', 'dates');

do $$ begin raise notice 'ALL HR AND PAYROLL TESTS PASSED'; end $$;
select 'ALL HR AND PAYROLL TESTS PASSED' as result;
rollback;
