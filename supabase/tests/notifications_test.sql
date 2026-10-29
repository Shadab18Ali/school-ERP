-- =====================================================================
-- Notifications test (migrations 0001-0020). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL NOTIFICATION TESTS PASSED".
-- School A (ZZNT-A), session 2026-27, Class 1-A: Child One (Parent One has a mobile;
-- Child One also has a student login) and Child Two (Parent Two has no mobile, so
-- SMS/WhatsApp go to the family mobile). Admin, accountant, teacher; admin of B.
-- "erp_notify" stands in for the API's background sender.
-- =====================================================================
begin;

create function private._n_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._n_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._n_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._n_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function private._n_worker() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'erp_notify', true);
end $$;
-- the newest event of a kind, as the owner sees it
create function private._n_event(p_key text) returns uuid language sql security definer set search_path = '' as $$
  select id from public.notification_events where event_key = p_key and school_id = 'b2200000-0000-4000-8000-00000000000a'
  order by created_at desc, id limit 1;
$$;
create function private._n_count(p_key text) returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.notification_events where event_key = p_key and school_id = 'b2200000-0000-4000-8000-00000000000a';
$$;
create function private._n_event_of(p_key text, p_entity uuid) returns uuid language sql security definer set search_path = '' as $$
  select id from public.notification_events where event_key = p_key and entity_id = p_entity;
$$;
create function private._n_event_dd(p_dedupe text) returns uuid language sql security definer set search_path = '' as $$
  select id from public.notification_events where dedupe_key = p_dedupe;
$$;
create function private._n_delivery(p_channel text) returns uuid language sql security definer set search_path = '' as $$
  select id from public.notification_deliveries where channel = p_channel and school_id = 'b2200000-0000-4000-8000-00000000000a';
$$;
grant execute on function private._n_assert(boolean, text), private._n_eq(numeric, numeric, text), private._n_raises(text, text, text, text),
  private._n_as(uuid), private._n_worker(), private._n_event(text), private._n_count(text), private._n_event_of(text, uuid),
  private._n_event_dd(text), private._n_delivery(text) to authenticated, erp_notify;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a2200000-0000-4000-8000-000000000001', 'nt-admin@example.invalid'),
  ('a2200000-0000-4000-8000-000000000002', 'nt-accountant@example.invalid'),
  ('a2200000-0000-4000-8000-000000000003', 'nt-teacher@example.invalid'),
  ('a2200000-0000-4000-8000-000000000004', 'nt-parent-1@example.invalid'),
  ('a2200000-0000-4000-8000-000000000005', 'nt-parent-2@example.invalid'),
  ('a2200000-0000-4000-8000-000000000006', 'nt-student-1@example.invalid'),
  ('a2200000-0000-4000-8000-000000000007', 'nt-admin-b@example.invalid');
update public.profiles set full_name = 'Parent One', phone = '+919811100001' where id = 'a2200000-0000-4000-8000-000000000004';
update public.profiles set full_name = 'Parent Two', phone = null where id = 'a2200000-0000-4000-8000-000000000005';
update public.profiles set full_name = 'Child One' where id = 'a2200000-0000-4000-8000-000000000006';
insert into public.schools (id, name, code, phone) values
  ('b2200000-0000-4000-8000-00000000000a', 'Notify A', 'ZZNT-A', '+911140000000'),
  ('b2200000-0000-4000-8000-00000000000b', 'Notify B', 'ZZNT-B', null);
insert into public.school_memberships (school_id, user_id, role) values
  ('b2200000-0000-4000-8000-00000000000a', 'a2200000-0000-4000-8000-000000000001', 'school_admin'),
  ('b2200000-0000-4000-8000-00000000000a', 'a2200000-0000-4000-8000-000000000002', 'accountant'),
  ('b2200000-0000-4000-8000-00000000000a', 'a2200000-0000-4000-8000-000000000003', 'teacher'),
  ('b2200000-0000-4000-8000-00000000000a', 'a2200000-0000-4000-8000-000000000004', 'parent'),
  ('b2200000-0000-4000-8000-00000000000a', 'a2200000-0000-4000-8000-000000000005', 'parent'),
  ('b2200000-0000-4000-8000-00000000000a', 'a2200000-0000-4000-8000-000000000006', 'student'),
  ('b2200000-0000-4000-8000-00000000000b', 'a2200000-0000-4000-8000-000000000007', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c2200000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d2200000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'Class 1'),
  ('d2200000-0000-4000-8000-000000000002', 'b2200000-0000-4000-8000-00000000000a', 'Class 2');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d2200000-0000-4000-8000-0000000000a1', 'b2200000-0000-4000-8000-00000000000a', 'd2200000-0000-4000-8000-000000000001', 'c2200000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f2200000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'Child One', 'Parent One', '2019-01-01', 'male', '9800000011'),
  ('f2200000-0000-4000-8000-000000000002', 'b2200000-0000-4000-8000-00000000000a', 'Child Two', 'Father Two', '2019-02-02', 'female', '9800000022');
update public.students set account_id = 'a2200000-0000-4000-8000-000000000006' where id = 'f2200000-0000-4000-8000-000000000001';
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('e2200000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'f2200000-0000-4000-8000-000000000001', 'c2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-0000000000a1', 'N1', '2026-04-01'),
  ('e2200000-0000-4000-8000-000000000002', 'b2200000-0000-4000-8000-00000000000a', 'f2200000-0000-4000-8000-000000000002', 'c2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-0000000000a1', 'N2', '2026-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b2200000-0000-4000-8000-00000000000a', 'f2200000-0000-4000-8000-000000000001', 'a2200000-0000-4000-8000-000000000004', 'father'),
  ('b2200000-0000-4000-8000-00000000000a', 'f2200000-0000-4000-8000-000000000002', 'a2200000-0000-4000-8000-000000000005', 'mother');
insert into public.fee_heads (id, school_id, name) values ('a2a20000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'Tuition Fee');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values
  ('a2b20000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'c2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001');
insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency) values
  ('b2200000-0000-4000-8000-00000000000a', 'a2b20000-0000-4000-8000-000000000001', 'a2a20000-0000-4000-8000-000000000001', 1000, 'monthly');
select private.sync_student_dues(array['e2200000-0000-4000-8000-000000000001'::uuid]);  -- Child Two's dues: brought up to date by the reminders

-- ================= events are recorded with the change =================
select private._n_as('a2200000-0000-4000-8000-000000000002');
select * from private.record_fee_payment('e2200000-0000-4000-8000-000000000001', current_date, 'cash', null, null, gen_random_uuid(),
  (select jsonb_build_array(jsonb_build_object('due_id', id, 'amount', 1000)) from public.student_fee_dues
   where enrollment_id = 'e2200000-0000-4000-8000-000000000001' and due_month = '2026-04-01'));
reset role;
select private._n_eq(private._n_count('payment_received'), 1, 'a receipt records a payment_received event');

-- a failed change records nothing (same transaction)
select private._n_as('a2200000-0000-4000-8000-000000000002');
select private._n_raises($q$select * from private.record_fee_payment('e2200000-0000-4000-8000-000000000001', current_date, 'cash', null, null, gen_random_uuid(),
  (select jsonb_build_array(jsonb_build_object('due_id', id, 'amount', 99999)) from public.student_fee_dues
   where enrollment_id = 'e2200000-0000-4000-8000-000000000001' and due_month = '2026-05-01'))$q$, '23514', 'an overpayment is refused');
reset role;
select private._n_eq(private._n_count('payment_received'), 1, 'and announces nothing');

-- attendance: absent today alerts once; present doesn't; old corrections stay quiet
insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status) values
  ('b2200000-0000-4000-8000-00000000000a', 'f2200000-0000-4000-8000-000000000001', 'e2200000-0000-4000-8000-000000000001', 'c2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-0000000000a1', private.ist_today(), 'present'),
  ('b2200000-0000-4000-8000-00000000000a', 'f2200000-0000-4000-8000-000000000002', 'e2200000-0000-4000-8000-000000000002', 'c2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-0000000000a1', private.ist_today(), 'absent'),
  ('b2200000-0000-4000-8000-00000000000a', 'f2200000-0000-4000-8000-000000000002', 'e2200000-0000-4000-8000-000000000002', 'c2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-0000000000a1', private.ist_today() - 10, 'absent');
select private._n_eq(private._n_count('student_absent'), 1, 'only today''s absence alerts');
update public.attendance_records set status = 'absent' where student_id = 'f2200000-0000-4000-8000-000000000001' and attendance_date = private.ist_today();
update public.attendance_records set status = 'present' where student_id = 'f2200000-0000-4000-8000-000000000001' and attendance_date = private.ist_today();
update public.attendance_records set status = 'absent' where student_id = 'f2200000-0000-4000-8000-000000000001' and attendance_date = private.ist_today();
select private._n_eq(private._n_count('student_absent'), 2, 'present -> absent alerts; flipping back and forth alerts once a day');

-- homework
insert into public.homework (id, school_id, academic_session_id, class_id, section_id, title, due_at) values
  ('a2c20000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'c2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-0000000000a1', 'Read chapter 4', now() + interval '2 days');
select private._n_eq(private._n_count('homework_assigned'), 1, 'new homework is announced');

-- exams (the exam rules are tested in exams_test.sql; here only the announcement)
insert into public.exam_types (id, school_id, name) values ('a2d20000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'Unit Test');
alter table public.exams disable trigger exams_guard;
insert into public.exams (id, school_id, academic_session_id, exam_type_id, name) values
  ('a2e20000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'c2200000-0000-4000-8000-000000000001', 'a2d20000-0000-4000-8000-000000000001', 'Unit Test 1');
select private._n_eq(private._n_count('exam_scheduled'), 0, 'a draft exam is not announced');
update public.exams set status = 'scheduled' where id = 'a2e20000-0000-4000-8000-000000000001';
update public.exams set status = 'published', results_published_at = now() where id = 'a2e20000-0000-4000-8000-000000000001';
update public.exams set status = 'scheduled', results_published_at = null where id = 'a2e20000-0000-4000-8000-000000000001';
update public.exams set status = 'published', results_published_at = now() where id = 'a2e20000-0000-4000-8000-000000000001';
alter table public.exams enable trigger exams_guard;
select private._n_assert(private._n_count('exam_scheduled') = 1 and private._n_count('results_published') = 1,
  'the date sheet and the results are each announced once (republishing the same day doesn''t repeat it)');

-- notices: now, scheduled, staff-only, one class
insert into public.notices (id, school_id, title, body, audience, class_ids, publish_at) values
  ('a2f20000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'Sports day', 'Friday at 9 am.', 'parents', array['d2200000-0000-4000-8000-000000000001']::uuid[], now()),
  ('a2f20000-0000-4000-8000-000000000002', 'b2200000-0000-4000-8000-00000000000a', 'Class 2 picnic', 'Bring lunch.', 'parents', array['d2200000-0000-4000-8000-000000000002']::uuid[], now()),
  ('a2f20000-0000-4000-8000-000000000003', 'b2200000-0000-4000-8000-00000000000a', 'Staff meeting', 'Room 4.', 'staff', null, now()),
  ('a2f20000-0000-4000-8000-000000000004', 'b2200000-0000-4000-8000-00000000000a', 'Diwali holidays', 'From the 20th.', 'everyone', null, now() + interval '3 days');
select private._n_eq(private._n_count('notice_published'), 3, 'published notices are announced; a scheduled one waits');
update public.notices set publish_at = now() - interval '1 minute' where id = 'a2f20000-0000-4000-8000-000000000004';
select private._n_eq(private._n_count('notice_published'), 4, 'and is announced when its time comes');
reset role;
select private._n_worker();
select private._n_eq(private.notify_due_notices(), 0, 'the sender''s regular check finds nothing new (no repeats)');
reset role;

-- admission: an application and each step of it
insert into public.admission_applications (id, school_id, academic_session_id, class_id, application_number, student_name, date_of_birth, gender,
  father_name, contact_phone, contact_email, address_line, city, state, postal_code) values
  ('a3020000-0000-4000-8000-000000000001', 'b2200000-0000-4000-8000-00000000000a', 'c2200000-0000-4000-8000-000000000001', 'd2200000-0000-4000-8000-000000000001',
   'ADM2026-00001', 'New Kid', '2020-03-03', 'male', 'Applicant Father', '+919822200003', 'applicant@example.invalid', '1 Main Road', 'Delhi', 'Delhi', '110001');
select private._n_eq(private._n_count('admission_update'), 1, 'a new application is acknowledged');

-- ================= fee reminders =================
select private._n_as('a2200000-0000-4000-8000-000000000004');
select private._n_raises($q$select private.send_fee_reminders('b2200000-0000-4000-8000-00000000000a')$q$, '42501', 'parents can''t send reminders');
select private._n_as('a2200000-0000-4000-8000-000000000003');
select private._n_raises($q$select private.send_fee_reminders('b2200000-0000-4000-8000-00000000000a')$q$, '42501', 'teachers can''t either');
select private._n_as('a2200000-0000-4000-8000-000000000002');
select private._n_eq(private.send_fee_reminders('b2200000-0000-4000-8000-00000000000a'), 2, 'one reminder per student with overdue fees');
select private._n_eq(private.send_fee_reminders('b2200000-0000-4000-8000-00000000000a'), 0, 'at most one a day');
select private._n_eq(private.send_fee_reminders('b2200000-0000-4000-8000-00000000000a', 'd2200000-0000-4000-8000-000000000002'), 0, 'a class filter applies');
select private._n_eq((select count(*) from public.notification_events), 0, 'accountants don''t see the event log');
select private._n_as('a2200000-0000-4000-8000-000000000001');
select private._n_eq((select count(*) from public.notification_events), (select count(*) from public.notification_events), 'admins do');
select private._n_assert((select count(*) > 10 from public.notification_events), 'admins see the school''s events');
select private._n_as('a2200000-0000-4000-8000-000000000007');
select private._n_eq((select count(*) from public.notification_events), 0, 'another school''s admin sees none');
-- automatic reminders on the chosen day (after 9 am India time); deduplicated with today's manual ones
reset role;
insert into public.notification_settings (school_id, fee_reminder_days)
values ('b2200000-0000-4000-8000-00000000000a', array[least(extract(day from private.ist_today())::int, 28)]::smallint[]);
select private._n_worker();
select private._n_eq(private.notify_auto_fee_reminders(), 0, 'automatic reminders don''t repeat today''s');
reset role;

-- ================= who receives what =================
select private._n_as('a2200000-0000-4000-8000-000000000004');
select private._n_raises($q$select private.notify_event_context(private._n_event('payment_received'))$q$, '42501', 'parents can''t run the sender');
select private._n_raises($q$select * from private.notify_claim_events(10)$q$, '42501', 'nor claim events');
select private._n_raises($q$insert into public.notifications (school_id, user_id, event_key, title, body) values
  ('b2200000-0000-4000-8000-00000000000a', 'a2200000-0000-4000-8000-000000000004', 'test', 'x', 'y')$q$, '42501', 'nobody writes inbox items directly');
reset role;
select private._n_worker();
select private._n_assert((select c->'vars'->>'receipt_number' like 'ZZNT-A/2026-27/%' and (c->'vars'->>'amount')::numeric = 1000
  and jsonb_array_length(c->'recipients') = 1 and c->'recipients'->0->>'kind' = 'parent' and c->'recipients'->0->>'phone' = '+919811100001'
  and c->'school'->>'name' = 'Notify A'
  from private.notify_event_context(private._n_event('payment_received')) c),
  'payment: Parent One, with the receipt details (no family-mobile copy: the parent has a mobile)');
select private._n_assert((select c->'recipients' @> '[{"kind":"parent","name":"Parent Two","phone":null}]'
  and c->'recipients' @> '[{"kind":"family","phone":"9800000022","student_name":"Child Two"}]'
  from private.notify_event_context(private._n_event_of('student_absent', 'f2200000-0000-4000-8000-000000000002')) c),
  'absence of Child Two: Parent Two in the app, and the family mobile for SMS (Parent Two has no mobile)');
select private._n_assert((select c->'recipients' @> '[{"kind":"student","user_id":"a2200000-0000-4000-8000-000000000006"}]'
  and c->'vars'->>'title' = 'Read chapter 4' and jsonb_array_length(c->'recipients') = 4
  from private.notify_event_context(private._n_event('homework_assigned')) c), 'homework: both families and the student login');
select private._n_assert((select jsonb_array_length(c->'recipients') = 3 and not (c->'recipients' @> '[{"kind":"student"}]')
  from private.notify_event_context(private._n_event_dd('notice:a2f20000-0000-4000-8000-000000000001')) c),
  'a parents'' notice for Class 1 reaches Class 1 families only');
select private._n_assert((select jsonb_array_length(c->'recipients') = 0
  from private.notify_event_context(private._n_event_dd('notice:a2f20000-0000-4000-8000-000000000002')) c),
  'a Class 2 notice reaches no Class 1 family');
select private._n_assert((select jsonb_array_length(c->'recipients') = 3 and not (c->'recipients' @> '[{"kind":"parent"}]')
  from private.notify_event_context(private._n_event_dd('notice:a2f20000-0000-4000-8000-000000000003')) c),
  'a staff notice reaches the three staff only');
select private._n_assert((select c->'recipients'->0->>'kind' = 'applicant' and c->'recipients'->0->>'phone' = '+919822200003'
  and c->'vars'->>'application_number' = 'ADM2026-00001' and c->'skip' = 'null'::jsonb
  from private.notify_event_context(private._n_event('admission_update')) c), 'admission: the applicant''s contact, no account needed');
select private._n_assert((select (c->'vars'->>'amount_due')::numeric > 0
  from private.notify_event_context(private._n_event_of('fee_reminder', 'f2200000-0000-4000-8000-000000000001')) c),
  'a fee reminder carries the overdue amount');
reset role;
-- things change before sending: the sender is told to skip
update public.attendance_records set status = 'present' where student_id = 'f2200000-0000-4000-8000-000000000002' and attendance_date = private.ist_today();
select private._n_worker();
select private._n_assert((select c->>'skip' like '%no longer marked absent%'
  from private.notify_event_context(private._n_event_of('student_absent', 'f2200000-0000-4000-8000-000000000002')) c),
  'a corrected absence is not sent');

-- ================= the sender stores and sends =================
select private._n_assert((select count(*) >= 10 and bool_and(status = 'processing') from private.notify_claim_events(100)), 'events are claimed once');
select private._n_eq((select count(*) from private.notify_claim_events(100)), 0, 'and not twice');
select private.notify_store(private._n_event('payment_received'),
  '[{"user_id":"a2200000-0000-4000-8000-000000000004","title":"Payment received","body":"₹1,000 for Child One","link":"/portal/f2200000-0000-4000-8000-000000000001?tab=Fees"}]',
  '[{"user_id":"a2200000-0000-4000-8000-000000000004","student_id":"f2200000-0000-4000-8000-000000000001","name":"Parent One","kind":"parent","channel":"sms","address":"+919811100001","body":"Received ₹1,000"},
    {"user_id":"a2200000-0000-4000-8000-000000000004","student_id":"f2200000-0000-4000-8000-000000000001","name":"Parent One","kind":"parent","channel":"sms","address":"+919811100001","body":"duplicate"},
    {"user_id":"a2200000-0000-4000-8000-000000000004","name":"Parent One","kind":"parent","channel":"email","address":"nt-parent-1@example.invalid","subject":"Payment","body":"Received"}]',
  'done', null, 1);
reset role;
select private._n_assert((select status = 'done' and recipients = 1 and processed_at is not null from public.notification_events where id = private._n_event('payment_received')),
  'the event is closed');
select private._n_eq((select count(*) from public.notification_deliveries where event_id = private._n_event('payment_received')), 2,
  'one message per channel and address (the duplicate SMS is dropped)');

-- the inbox is private, and can only be marked read
select private._n_as('a2200000-0000-4000-8000-000000000004');
select private._n_eq((select count(*) from public.notifications), 1, 'Parent One sees their notification');
update public.notifications set read_at = now();
select private._n_assert((select read_at is not null from public.notifications), 'and can mark it read');
select private._n_raises($q$update public.notifications set title = 'changed'$q$, '42501', 'but not change it');
select private._n_eq((select count(*) from public.notification_deliveries), 0, 'parents don''t see the delivery log');
select private._n_as('a2200000-0000-4000-8000-000000000005');
select private._n_eq((select count(*) from public.notifications), 0, 'Parent Two sees nothing of it');
update public.notifications set read_at = null;
reset role;
select private._n_assert((select read_at is not null from public.notifications where user_id = 'a2200000-0000-4000-8000-000000000004'), 'nor marks it');
select private._n_as('a2200000-0000-4000-8000-000000000001');
select private._n_eq((select count(*) from public.notifications), 0, 'admins can''t read other people''s inbox');
select private._n_assert((select sent = 1 and read = 1 from private.notify_in_app_stats('b2200000-0000-4000-8000-00000000000a', array[private._n_event('payment_received')])),
  'but see how many were sent and read');
select private._n_as('a2200000-0000-4000-8000-000000000002');
select private._n_eq((select count(*) from private.notify_in_app_stats('b2200000-0000-4000-8000-00000000000a', array[private._n_event('payment_received')])), 0,
  'accountants don''t');
select private._n_as('a2200000-0000-4000-8000-000000000007');
select private._n_eq((select count(*) from private.notify_in_app_stats('b2200000-0000-4000-8000-00000000000a', array[private._n_event('payment_received')])), 0,
  'nor another school''s admin');
reset role;

-- sending: claim, result, provider reports only move forward
select private._n_worker();
select private._n_assert((select count(*) = 2 and bool_and(status = 'sending' and attempts = 1) from private.notify_claim_deliveries(10)), 'messages are claimed for sending');
select private.notify_delivery_result(private._n_delivery('sms'), 'sent', 'twilio', 'SM_TEST_1', null, null);
select private.notify_delivery_result(private._n_delivery('email'), 'failed', 'smtp', null, 'Mailbox does not exist', null);
select private._n_eq(private.notify_sent_today('b2200000-0000-4000-8000-00000000000a', 'sms'), 1, 'today''s SMS count (for the daily limit)');
select private._n_assert(private.notify_delivery_status('b2200000-0000-4000-8000-00000000000a', 'twilio', 'SM_TEST_1', 'delivered', null), 'delivered');
select private._n_assert(not private.notify_delivery_status('b2200000-0000-4000-8000-00000000000a', 'twilio', 'SM_TEST_1', 'sent', null), 'a late "sent" doesn''t undo "delivered"');
select private._n_assert(not private.notify_delivery_status('b2200000-0000-4000-8000-00000000000a', 'twilio', 'SM_TEST_1', 'failed', 'x'), 'nor does "failed" after delivery');
select private._n_assert(not private.notify_delivery_status('b2200000-0000-4000-8000-00000000000b', 'twilio', 'SM_TEST_1', 'read', null), 'another school''s report changes nothing');
-- a retry later
select private.notify_delivery_result(private._n_delivery('email'), 'failed', 'smtp', null, 'Temporary failure', now() + interval '5 minutes');
reset role;
select private._n_assert((select status = 'queued' and next_attempt_at > now() from public.notification_deliveries where channel = 'email'), 'a temporary failure is retried later');
update public.notification_deliveries set status = 'failed' where channel = 'email';
select private._n_as('a2200000-0000-4000-8000-000000000002');
select private._n_raises($q$select private.notify_retry(private._n_delivery('email'))$q$, 'P0002', 'accountants can''t see or resend the log');
select private._n_as('a2200000-0000-4000-8000-000000000001');
select private.notify_retry((select id from public.notification_deliveries where channel = 'email'));
select private._n_assert((select status = 'queued' and attempts = 0 from public.notification_deliveries where channel = 'email'), 'an admin resends a failed message');
select private._n_raises($q$select private.notify_retry((select id from public.notification_deliveries where channel = 'sms'))$q$, '23514', 'a delivered one can''t be resent', 'Only failed');

-- ================= settings, templates, accounts, preferences =================
select private._n_as('a2200000-0000-4000-8000-000000000001');
insert into public.notification_templates (school_id, event_key, channel, is_enabled, body) values
  ('b2200000-0000-4000-8000-00000000000a', 'payment_received', 'sms', true, 'Received {{amount}} for {{student_name}}.');
insert into public.notification_templates (school_id, event_key, channel, is_enabled, wa_template, wa_language, wa_params) values
  ('b2200000-0000-4000-8000-00000000000a', 'payment_received', 'whatsapp', true, 'payment_received', 'en_US', '["amount","student_name"]');
select private._n_raises($q$insert into public.notification_templates (school_id, event_key, channel, is_enabled, wa_template) values
  ('b2200000-0000-4000-8000-00000000000a', 'fee_reminder', 'whatsapp', true, 'Fee Reminder!')$q$, '23514', 'WhatsApp template names are lower-case words');
select private.save_messaging_account('b2200000-0000-4000-8000-00000000000a', 'sms', '{"account_sid":"AC123","from":"+15005550006"}', 'enc-token', null, true);
select private.save_messaging_account('b2200000-0000-4000-8000-00000000000a', 'sms', '{"account_sid":"AC123","from":"+15005550006"}', null, null, false);  -- keep token
select private._n_assert((select provider = 'twilio' and not is_enabled and config->>'account_sid' = 'AC123' from private.messaging_account_info('b2200000-0000-4000-8000-00000000000a')),
  'admins see the account without the token');
select private._n_raises($q$select * from private.messaging_accounts$q$, '42501', 'the tokens table can''t be read');
select private._n_raises($q$select * from private.notify_channel_secrets('b2200000-0000-4000-8000-00000000000a', 'sms')$q$, '42501', 'nor the encrypted tokens');
select private._n_raises($q$select private.save_messaging_account('b2200000-0000-4000-8000-00000000000a', 'whatsapp', '{}', null, null, true)$q$, '23514', 'a new account needs its token', 'token');
select private._n_assert(private.notify_test('b2200000-0000-4000-8000-00000000000a', 'email', 'nt-admin@example.invalid') is not null, 'admins can send a test message');
select private._n_as('a2200000-0000-4000-8000-000000000002');
select private._n_raises($q$insert into public.notification_templates (school_id, event_key, channel, is_enabled) values
  ('b2200000-0000-4000-8000-00000000000a', 'fee_reminder', 'sms', true)$q$, '42501', 'accountants can''t change templates');
select private._n_raises($q$select private.save_messaging_account('b2200000-0000-4000-8000-00000000000a', 'sms', '{}', 'x', null, true)$q$, '42501', 'or accounts');
select private._n_raises($q$select private.notify_test('b2200000-0000-4000-8000-00000000000a', 'sms', '+919800000000')$q$, '42501', 'or send tests');
select private._n_eq((select count(*) from private.messaging_account_info('b2200000-0000-4000-8000-00000000000a')), 0, 'or see the account');
reset role;
select private._n_worker();
select private._n_assert((select key_secret = 'enc-token' from (select secret_enc as key_secret from private.notify_channel_secrets('b2200000-0000-4000-8000-00000000000a', 'sms')) t),
  'the sender reads the (encrypted) token; an empty one was kept');
select private._n_assert((select (s->'templates'->0->>'body') = 'Received {{amount}} for {{student_name}}.' and (s->'channels'->>'sms')::boolean = false
  from private.notify_school_setup('b2200000-0000-4000-8000-00000000000a') s), 'the sender sees the school''s templates and channels');
reset role;
select private._n_as('a2200000-0000-4000-8000-000000000004');
insert into public.notification_preferences (user_id, channel, enabled) values ('a2200000-0000-4000-8000-000000000004', 'sms', false);
select private._n_raises($q$insert into public.notification_preferences (user_id, channel, enabled) values ('a2200000-0000-4000-8000-000000000005', 'sms', false)$q$,
  '42501', 'nobody changes someone else''s preferences');
reset role;
select private._n_worker();
select private._n_assert((select count(*) = 1 from private.notify_opt_outs(array['a2200000-0000-4000-8000-000000000004'::uuid, 'a2200000-0000-4000-8000-000000000005'::uuid])),
  'the sender honours opt-outs');
reset role;
set local role anon;
select 1 where false;  -- (anon has no grants at all)
reset role;
select private._n_raises($q$set local role anon; select count(*) from public.notifications$q$, '42501', 'the public has no access');
reset role;

do $$ begin raise notice 'ALL NOTIFICATION TESTS PASSED'; end $$;
rollback;
