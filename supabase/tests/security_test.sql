-- =====================================================================
-- Security test (migration 0032). Run in Supabase SQL Editor after all migrations.
-- Rolls back; leaves nothing behind. Pass = "ALL SECURITY TESTS PASSED".
--
-- Schools A and B. A: admin, accountant, teacher; B: admin. A platform super admin.
-- Checks: the database records sensitive changes itself (who, school, what, record, when, IP,
-- details), the audit log can't be changed, who reads which entries (payroll stays with the
-- school), sign-in/out and password changes from Supabase Auth (deduplicated with the app's
-- report), ended sessions, privileges (no TRUNCATE, no direct receipts), file paths stay in their
-- school, receipt reversal.
-- =====================================================================
begin;

create function private._s_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._s_eq(got anyelement, want anyelement, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._s_as(uid uuid, sid uuid default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'session_id', sid)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function private._s_refused_with(q text, needle text, msg text) returns void language plpgsql as $$
begin
  begin execute q;
  exception when others then
    if sqlerrm not ilike '%' || needle || '%' then raise exception 'FAIL: % (refused, but with "%")', msg, sqlerrm using errcode = 'ZT001'; end if;
    return;
  end;
  raise exception 'FAIL: % (was allowed)', msg using errcode = 'ZT001';
end $$;
-- what the log holds, read as the owner (the tests of who-sees-what read as each person)
create function private._s_log(p_action text) returns setof public.audit_logs language sql security definer set search_path = '' as $$
  select * from public.audit_logs where action = p_action order by id;
$$;
create function private._s_n(p_action text) returns integer language sql security definer set search_path = '' as $$
  select count(*)::int from public.audit_logs where action = p_action;
$$;
grant execute on function private._s_assert(boolean, text), private._s_eq(anyelement, anyelement, text), private._s_as(uuid, uuid),
  private._s_refused_with(text, text, text), private._s_log(text), private._s_n(text) to authenticated;

-- ---------- fixtures (as the owner: the database records them too)
insert into auth.users (id, email) values
  ('a3300000-0000-4000-8000-000000000001', 'sec-super@example.invalid'),
  ('a3300000-0000-4000-8000-000000000002', 'sec-admin-a@example.invalid'),
  ('a3300000-0000-4000-8000-000000000003', 'sec-acct-a@example.invalid'),
  ('a3300000-0000-4000-8000-000000000004', 'sec-admin-b@example.invalid'),
  ('a3300000-0000-4000-8000-000000000005', 'sec-teacher-a@example.invalid');
select private._s_eq((select count(*)::int from public.audit_logs where action = 'user.created'
  and metadata ->> 'label' like 'sec-%@example.invalid'), 5, 'a new account is recorded (user.created)');
update public.profiles set is_super_admin = true where id = 'a3300000-0000-4000-8000-000000000001';
select private._s_eq((select metadata #>> '{changes,is_super_admin,to}' from private._s_log('user.super_admin_granted')
  where entity_id = 'a3300000-0000-4000-8000-000000000001'), 'true', 'platform-admin rights granted are recorded');
update public.profiles set full_name = 'Renamed' where id = 'a3300000-0000-4000-8000-000000000002';
select private._s_eq(private._s_n('user.updated'), 0, 'an ordinary name change isn''t an audit event');

insert into public.schools (id, name, code, state) values
  ('b3300000-0000-4000-8000-00000000000a', 'Security School A', 'ZZSEC-A', 'Delhi'),
  ('b3300000-0000-4000-8000-00000000000b', 'Security School B', 'ZZSEC-B', 'Delhi');
select private._s_eq(private._s_n('school.created'), 2, 'schools created are recorded');
insert into public.school_memberships (school_id, user_id, role) values
  ('b3300000-0000-4000-8000-00000000000a', 'a3300000-0000-4000-8000-000000000002', 'school_admin'),
  ('b3300000-0000-4000-8000-00000000000a', 'a3300000-0000-4000-8000-000000000003', 'accountant'),
  ('b3300000-0000-4000-8000-00000000000a', 'a3300000-0000-4000-8000-000000000005', 'teacher'),
  ('b3300000-0000-4000-8000-00000000000b', 'a3300000-0000-4000-8000-000000000004', 'school_admin');
select private._s_eq((select metadata ->> 'label' from private._s_log('membership.created') where metadata #>> '{record,role}' = 'accountant'),
  'sec-acct-a@example.invalid (accountant)', 'a person given access is recorded, named by email and role');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c3300000-0000-4000-8000-000000000001', 'b3300000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values ('d3300000-0000-4000-8000-000000000001', 'b3300000-0000-4000-8000-00000000000a', 'Class 6');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d3300000-0000-4000-8000-0000000000a1', 'b3300000-0000-4000-8000-00000000000a', 'd3300000-0000-4000-8000-000000000001', 'c3300000-0000-4000-8000-000000000001', 'A');
insert into public.fee_heads (id, school_id, name) values ('a3400000-0000-4000-8000-000000000001', 'b3300000-0000-4000-8000-00000000000a', 'Tuition Fee');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values
  ('a3500000-0000-4000-8000-000000000001', 'b3300000-0000-4000-8000-00000000000a', 'c3300000-0000-4000-8000-000000000001', 'd3300000-0000-4000-8000-000000000001');
insert into public.fee_structure_items (id, school_id, fee_structure_id, fee_head_id, amount, frequency, is_optional, billing_months) values
  ('a3600000-0000-4000-8000-000000000001', 'b3300000-0000-4000-8000-00000000000a', 'a3500000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000001', 1500, 'monthly', false, null);

-- ================= students: created and changed, by the admin (with the request's IP)
select private._s_as('a3300000-0000-4000-8000-000000000002');
select set_config('app.client_ip', '203.0.113.7', true), set_config('app.user_agent', 'Mozilla/5.0 (test) Chrome/130', true);
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f3300000-0000-4000-8000-000000000001', 'b3300000-0000-4000-8000-00000000000a', 'Kabir Rao', 'Anil', '2015-02-03', 'male', '9876500001');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('e3300000-0000-4000-8000-000000000001', 'b3300000-0000-4000-8000-00000000000a', 'f3300000-0000-4000-8000-000000000001',
   'c3300000-0000-4000-8000-000000000001', 'd3300000-0000-4000-8000-000000000001', 'd3300000-0000-4000-8000-0000000000a1', 'S1', '2026-04-01');
select private._s_assert((select actor_id = 'a3300000-0000-4000-8000-000000000002' and school_id = 'b3300000-0000-4000-8000-00000000000a'
  and entity_type = 'students' and entity_id = 'f3300000-0000-4000-8000-000000000001' and ip_address = '203.0.113.7'
  and user_agent like 'Mozilla/5.0%' and source = 'database' and actor_label = 'sec-admin-a@example.invalid'
  and metadata ->> 'label' = 'Kabir Rao' and metadata #>> '{record,mobile}' = '9876500001'
  from private._s_log('student.created')), 'student.created: who, school, record, IP, browser, source, details');
update public.students set mobile = '9876500002', full_name = 'Kabir Rao' where id = 'f3300000-0000-4000-8000-000000000001';
select private._s_eq((select metadata -> 'changes' from private._s_log('student.updated')),
  '{"mobile": {"to": "9876500002", "from": "9876500001"}}'::jsonb, 'student.updated records only what changed, from → to');
update public.students set full_name = 'Kabir Rao' where id = 'f3300000-0000-4000-8000-000000000001';
select private._s_eq(private._s_n('student.updated'), 1, 'an update that changes nothing records nothing');
update public.student_enrollments set admission_number = 'S1-A' where id = 'e3300000-0000-4000-8000-000000000001';
select private._s_eq((select metadata ->> 'student' from private._s_log('enrollment.updated')), 'Kabir Rao', 'enrollment changes name the student');

-- ================= attendance: changing a mark is recorded per student
reset role;
insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status, marked_by)
values ('b3300000-0000-4000-8000-00000000000a', 'f3300000-0000-4000-8000-000000000001', 'e3300000-0000-4000-8000-000000000001',
        'c3300000-0000-4000-8000-000000000001', 'd3300000-0000-4000-8000-000000000001', 'd3300000-0000-4000-8000-0000000000a1',
        private.ist_today(), 'present', 'a3300000-0000-4000-8000-000000000005');
select private._s_eq(private._s_n('attendance.created'), 0, 'first marking isn''t logged per student (the API logs the class)');
select private._s_as('a3300000-0000-4000-8000-000000000002');
update public.attendance_records set status = 'absent', updated_by = 'a3300000-0000-4000-8000-000000000002'
  where student_id = 'f3300000-0000-4000-8000-000000000001';
select private._s_assert((select metadata #>> '{changes,status,from}' = 'present' and metadata #>> '{changes,status,to}' = 'absent'
  and metadata ->> 'student' = 'Kabir Rao' and not (metadata -> 'changes' ? 'updated_by')
  from private._s_log('attendance.changed')), 'attendance.changed: present → absent, for whom');

-- ================= receipts: recorded and reversed
reset role;
select private.sync_student_dues(array['e3300000-0000-4000-8000-000000000001'::uuid]);
select private._s_as('a3300000-0000-4000-8000-000000000005');   -- a teacher can't record a receipt
select private._s_refused_with($q$select * from private.record_fee_payment('e3300000-0000-4000-8000-000000000001', private.ist_today(), 'cash', null, null, gen_random_uuid(),
  (select jsonb_build_array(jsonb_build_object('due_id', id, 'amount', 1500)) from public.student_fee_dues where enrollment_id = 'e3300000-0000-4000-8000-000000000001' and due_month = '2026-04-01'))$q$,
  'not found', 'a teacher can''t record a receipt (the function checks, not table grants)');
select private._s_as('a3300000-0000-4000-8000-000000000004');   -- nor school B's admin
select private._s_refused_with($q$select * from private.record_fee_payment('e3300000-0000-4000-8000-000000000001', private.ist_today(), 'cash', null, null, gen_random_uuid(), '[]')$q$,
  'not found', 'another school''s admin can''t record one either');
select private._s_as('a3300000-0000-4000-8000-000000000003');   -- school A's accountant
select private._s_refused_with($q$insert into public.fee_payments (school_id, student_id, enrollment_id, academic_session_id, receipt_number, payment_date, amount, payment_mode, balance_after, idempotency_key)
  values ('b3300000-0000-4000-8000-00000000000a', 'f3300000-0000-4000-8000-000000000001', 'e3300000-0000-4000-8000-000000000001', 'c3300000-0000-4000-8000-000000000001', 'FAKE-1', current_date, 1, 'cash', 0, gen_random_uuid())$q$,
  'permission denied', 'nobody writes a receipt row directly (no numbering, no allocation, no audit)');
create temp table rec on commit drop as
  select * from private.record_fee_payment('e3300000-0000-4000-8000-000000000001', private.ist_today(), 'cash', null, null, gen_random_uuid(),
    (select jsonb_build_array(jsonb_build_object('due_id', id, 'amount', 1500)) from public.student_fee_dues
     where enrollment_id = 'e3300000-0000-4000-8000-000000000001' and due_month = '2026-04-01'));
reset role;
grant select on rec to authenticated;
select private._s_assert((select actor_id = 'a3300000-0000-4000-8000-000000000003' and metadata ->> 'label' = (select receipt_number from rec)
  and metadata #>> '{record,amount}' = '1500.00' and metadata ->> 'student' = 'Kabir Rao'
  from private._s_log('fee_payment.recorded')), 'fee_payment.recorded: the accountant, the receipt number, the amount');

select private._s_as('a3300000-0000-4000-8000-000000000003');   -- the accountant can't reverse what they recorded
select private._s_refused_with($q$select private.fee_payment_cancel((select payment_id from rec), 'typed the wrong amount')$q$,
  'not found', 'an accountant can''t cancel a receipt');
select private._s_as('a3300000-0000-4000-8000-000000000004');
select private._s_refused_with($q$select private.fee_payment_cancel((select payment_id from rec), 'not my school at all')$q$,
  'not found', 'nor another school''s admin');
select private._s_as('a3300000-0000-4000-8000-000000000001');
select private._s_refused_with($q$select private.fee_payment_cancel((select payment_id from rec), 'platform tidying up')$q$,
  'not found', 'nor the platform super admin (a school''s money decision)');
select private._s_as('a3300000-0000-4000-8000-000000000002');
select private._s_refused_with($q$select private.fee_payment_cancel((select payment_id from rec), 'no')$q$, 'reason', 'a reason is required');
select private.fee_payment_cancel((select payment_id from rec), 'Entered against the wrong student');
reset role;
select private._s_assert((select cancelled_at is not null and cancel_reason = 'Entered against the wrong student'
  and jsonb_array_length(cancelled_allocations) = 1 from public.fee_payments where id = (select payment_id from rec)), 'the receipt is cancelled, keeping what it paid');
select private._s_eq((select count(*)::int from public.fee_payment_allocations where payment_id = (select payment_id from rec)), 0, 'its dues are payable again');
select private._s_assert((select actor_id = 'a3300000-0000-4000-8000-000000000002'
  and metadata #>> '{changes,cancel_reason,to}' = 'Entered against the wrong student'
  from private._s_log('fee_payment.cancelled')), 'fee_payment.cancelled: by whom and why');
select private._s_as('a3300000-0000-4000-8000-000000000002');
select private._s_refused_with($q$select private.fee_payment_cancel((select payment_id from rec), 'twice is not allowed')$q$, 'already', 'a receipt is cancelled once');
reset role;

-- ================= people and schools: roles, sign-ins turned off, deactivation
update public.school_memberships set status = 'disabled' where user_id = 'a3300000-0000-4000-8000-000000000003';
select private._s_eq(private._s_n('membership.disabled'), 1, 'turning a sign-in off is recorded');
update public.school_memberships set role = 'librarian' where user_id = 'a3300000-0000-4000-8000-000000000005';
select private._s_eq((select metadata #>> '{changes,role,to}' from private._s_log('membership.role_changed')), 'librarian', 'a role change is recorded');
update public.school_memberships set role = 'teacher' where user_id = 'a3300000-0000-4000-8000-000000000005';
update public.schools set status = 'suspended' where id = 'b3300000-0000-4000-8000-00000000000b';
update public.schools set status = 'active' where id = 'b3300000-0000-4000-8000-00000000000b';
select private._s_eq(private._s_n('school.deactivated') + private._s_n('school.activated'), 2, 'deactivating and reactivating a school are recorded');
update public.school_memberships set status = 'active' where user_id = 'a3300000-0000-4000-8000-000000000003';

-- ================= sign-in and sign-out, from Supabase Auth
insert into auth.sessions (id, user_id, user_agent, ip) values
  ('a5500000-0000-4000-8000-000000000001', 'a3300000-0000-4000-8000-000000000002', 'Mozilla/5.0 Android Chrome/130', '198.51.100.4'),
  ('a5500000-0000-4000-8000-000000000002', 'a3300000-0000-4000-8000-000000000001', 'Mozilla/5.0 Windows Firefox/131', '198.51.100.5');
select private._s_assert((select school_id = 'b3300000-0000-4000-8000-00000000000a' and actor_id = 'a3300000-0000-4000-8000-000000000002'
  and ip_address = '198.51.100.4' and source = 'auth' and metadata ->> 'session_id' = 'a5500000-0000-4000-8000-000000000001'
  from private._s_log('auth.login') where actor_id = 'a3300000-0000-4000-8000-000000000002'), 'a sign-in: in the person''s school, with the IP Auth saw');
select private._s_assert((select school_id is null from private._s_log('auth.login') where actor_id = 'a3300000-0000-4000-8000-000000000001'),
  'someone in no school (the platform admin): one platform-level entry');
-- the app's own report of the same sign-in is not a second entry
select private._s_as('a3300000-0000-4000-8000-000000000002', 'a5500000-0000-4000-8000-000000000001');
select private._s_eq(private.audit_my_session_event('login', '10.0.0.1', 'x'), false, 'the app reporting the same sign-in adds nothing');
select private._s_eq(private.session_active('a5500000-0000-4000-8000-000000000001'), true, 'the session is live');
select private._s_eq(private.session_active('a5500000-0000-4000-8000-000000000002'), false, 'someone else''s session isn''t "yours"');
select private._s_eq(private.session_active('not-a-uuid'), false, 'nonsense is not a session');
reset role;
delete from auth.sessions where id = 'a5500000-0000-4000-8000-000000000001';
select private._s_eq((select ip_address from private._s_log('auth.logout') where actor_id = 'a3300000-0000-4000-8000-000000000002'), '198.51.100.4', 'sign-out recorded');
select private._s_as('a3300000-0000-4000-8000-000000000002', 'a5500000-0000-4000-8000-000000000001');
select private._s_eq(private.session_active('a5500000-0000-4000-8000-000000000001'), false, 'after sign-out the token''s session has ended');
select private._s_eq(private.audit_my_session_event('logout', '10.0.0.1', 'x'), false, 'and the app''s report of it is not a second entry');
-- where Auth's trigger isn't available, the app's report is the record (a new session the trigger never saw)
select private._s_as('a3300000-0000-4000-8000-000000000005', 'a5500000-0000-4000-8000-000000000009');
select private._s_eq(private.audit_my_session_event('login', '192.0.2.1', 'Safari'), true, 'the app''s report records a sign-in');
select private._s_eq((select source || ' ' || ip_address from private._s_log('auth.login') where actor_id = 'a3300000-0000-4000-8000-000000000005'),
  'app 192.0.2.1', 'with the IP the API saw');
select private._s_refused_with($q$select private.audit_my_session_event('anything', null, null)$q$, 'unknown', 'only sign-in and sign-out');
reset role;
update auth.users set encrypted_password = 'changed' where id = 'a3300000-0000-4000-8000-000000000003';
select private._s_eq(private._s_n('auth.password_changed'), 1, 'a password change is recorded');

-- ================= the log can't be changed
select private._s_refused_with($q$update public.audit_logs set action = 'nothing' where action = 'fee_payment.cancelled'$q$,
  'can''t be changed', 'not even the owner edits an entry');
select private._s_refused_with($q$delete from public.audit_logs where action = 'fee_payment.cancelled'$q$, 'can''t be changed', 'or deletes one');
select private._s_as('a3300000-0000-4000-8000-000000000002');
select private._s_refused_with($q$delete from public.audit_logs$q$, 'permission denied', 'people can''t delete entries');
select private._s_refused_with($q$truncate public.audit_logs$q$, 'permission denied', 'or empty the log');
select private._s_refused_with($q$select private.write_audit_log('b3300000-0000-4000-8000-00000000000b', 'forged', 'x', null, '{}', null, null)$q$,
  'not allowed', 'nobody writes an entry into another school''s log');
reset role;

-- ================= who reads what
select private._s_as('a3300000-0000-4000-8000-000000000002');
select private.write_audit_log('b3300000-0000-4000-8000-00000000000a', 'payroll.calculated', 'payroll_run', null, '{"net": "45000.00"}', null, null);
select private._s_assert((select count(*) > 0 from public.audit_logs where action = 'student.created'), 'school A''s admin reads A''s log');
select private._s_eq((select count(*)::int from public.audit_logs where school_id is distinct from 'b3300000-0000-4000-8000-00000000000a'), 0,
  'and nothing of school B or the platform');
select private._s_eq((select count(*)::int from public.audit_logs where action = 'payroll.calculated'), 1, 'school A''s admin reads its payroll entries');
select private._s_as('a3300000-0000-4000-8000-000000000001');
select private._s_eq((select count(*)::int from public.audit_logs where action = 'payroll.calculated'), 0,
  'the platform super admin does not see a school''s payroll entries (salaries)');
select private._s_assert((select count(*) > 0 from public.audit_logs where school_id = 'b3300000-0000-4000-8000-00000000000a'), 'but does see the rest of school A''s log');
select private._s_assert((select count(*) > 0 from public.audit_logs where school_id is null), 'and platform-level entries');
select private._s_as('a3300000-0000-4000-8000-000000000003');
select private._s_eq((select count(*)::int from public.audit_logs), 0, 'an accountant reads no log');
select private._s_as('a3300000-0000-4000-8000-000000000004');
select private._s_eq((select count(*)::int from public.audit_logs where school_id = 'b3300000-0000-4000-8000-00000000000a'), 0, 'school B''s admin reads none of A''s');
reset role;

-- ================= privileges and stored file paths
select private._s_eq((select count(*)::int from information_schema.role_table_grants where grantee in ('authenticated', 'anon')
  and table_schema = 'public' and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')), 0, 'no user role may TRUNCATE (bypasses RLS), REFERENCE or TRIGGER any table');
select private._s_eq((select count(*)::int from information_schema.role_table_grants where grantee = 'authenticated'
  and table_schema = 'public' and table_name in ('fee_payments', 'fee_payment_allocations') and privilege_type <> 'SELECT'), 0,
  'receipts and their allocations are only written by functions');
select private._s_as('a3300000-0000-4000-8000-000000000002');
select private._s_refused_with($q$update public.students set photo_path = 'b3300000-0000-4000-8000-00000000000b/x/photo.jpg' where id = 'f3300000-0000-4000-8000-000000000001'$q$,
  'in_school', 'a row can''t point at another school''s file');
select private._s_refused_with($q$update public.students set photo_path = 'b3300000-0000-4000-8000-00000000000a/../b3300000-0000-4000-8000-00000000000b/x.jpg' where id = 'f3300000-0000-4000-8000-000000000001'$q$,
  'in_school', 'nor climb out of its folder');
update public.students set photo_path = 'b3300000-0000-4000-8000-00000000000a/f3300000-0000-4000-8000-000000000001/abc.jpg' where id = 'f3300000-0000-4000-8000-000000000001';
select private._s_refused_with($q$insert into public.student_documents (school_id, student_id, document_type, title, file_path, file_name, mime_type, size_bytes)
  values ('b3300000-0000-4000-8000-00000000000a', 'f3300000-0000-4000-8000-000000000001', 'other', 'x', 'b3300000-0000-4000-8000-00000000000b/y/z.pdf', 'z.pdf', 'application/pdf', 10)$q$,
  'in_school', 'a document row can''t point at another school''s file');
reset role;
select private._s_refused_with($q$update public.schools set logo_path = 'b3300000-0000-4000-8000-00000000000b/logo-x.png' where id = 'b3300000-0000-4000-8000-00000000000a'$q$,
  'in_school', 'a school''s logo path is inside its own folder');

do $$ begin raise notice 'ALL SECURITY TESTS PASSED'; end $$;
select 'ALL SECURITY TESTS PASSED' as result;
rollback;
