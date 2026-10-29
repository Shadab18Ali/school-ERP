-- =====================================================================
-- Parent portal test (migrations 0001-0010). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL PARENT PORTAL TESTS PASSED".
-- Two parents in School A each have ONE child; a third parent is in School B.
-- =====================================================================
begin;

create function private._t_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._t_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._t_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._t_rows(stmt text, n int, msg text) returns void language plpgsql as $$
declare got int;
begin
  begin execute stmt; get diagnostics got = row_count;
  exception when others then raise exception 'FAIL: % (error: %)', msg, sqlerrm using errcode = 'ZT001'; end;
  if got <> n then raise exception 'FAIL: % (affected % rows, expected %)', msg, got, n using errcode = 'ZT001'; end if;
end $$;
create function private._t_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function private._t_assert(boolean, text), private._t_eq(numeric, numeric, text), private._t_raises(text, text, text, text),
  private._t_rows(text, int, text), private._t_as(uuid) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a9000000-0000-4000-8000-000000000001', 'pp-parent-1@example.invalid'),
  ('a9000000-0000-4000-8000-000000000002', 'pp-parent-2@example.invalid'),
  ('a9000000-0000-4000-8000-000000000003', 'pp-parent-b@example.invalid'),
  ('a9000000-0000-4000-8000-000000000004', 'pp-teacher@example.invalid');
insert into public.schools (id, name, code) values
  ('b9000000-0000-4000-8000-00000000000a', 'Portal Test A', 'ZZPP-A'),
  ('b9000000-0000-4000-8000-00000000000b', 'Portal Test B', 'ZZPP-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b9000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-000000000001', 'parent'),
  ('b9000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-000000000002', 'parent'),
  ('b9000000-0000-4000-8000-00000000000b', 'a9000000-0000-4000-8000-000000000003', 'parent'),
  ('b9000000-0000-4000-8000-00000000000a', 'a9000000-0000-4000-8000-000000000004', 'teacher');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-00000000000a', 'Class 1'),
  ('d9000000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-00000000000a', 'Class 2');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d9000000-0000-4000-8000-0000000000a1', 'b9000000-0000-4000-8000-00000000000a', 'd9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'A'),
  ('d9000000-0000-4000-8000-0000000000a2', 'b9000000-0000-4000-8000-00000000000a', 'd9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-00000000000a', 'Child One', 'Parent One', '2019-01-01', 'male', '9800000011'),
  ('f9000000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-00000000000a', 'Child Two', 'Parent Two', '2018-01-01', 'female', '9800000022');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('e9000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-0000000000a1', 'P1', '2026-04-01'),
  ('e9000000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000002', 'd9000000-0000-4000-8000-0000000000a2', 'P2', '2026-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'father'),
  ('b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-000000000002', 'mother');
-- fees for both children (one head each so head visibility can be checked)
insert into public.fee_heads (id, school_id, name) values
  ('aa000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-00000000000a', 'Tuition Fee'),
  ('aa000000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-00000000000a', 'Lab Fee');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values
  ('ab000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001'),
  ('ab000000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-00000000000a', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000002');
insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency) values
  ('b9000000-0000-4000-8000-00000000000a', 'ab000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 1000, 'monthly'),
  ('b9000000-0000-4000-8000-00000000000a', 'ab000000-0000-4000-8000-000000000002', 'aa000000-0000-4000-8000-000000000002', 2000, 'monthly');
select private.sync_student_dues(array['e9000000-0000-4000-8000-000000000001'::uuid, 'e9000000-0000-4000-8000-000000000002'::uuid]);
insert into public.fee_payments (id, school_id, student_id, enrollment_id, academic_session_id, receipt_number, payment_date, amount, payment_mode, balance_after, idempotency_key) values
  ('ac000000-0000-4000-8000-000000000001', 'b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'R1', '2026-04-05', 1000, 'cash', 11000, gen_random_uuid()),
  ('ac000000-0000-4000-8000-000000000002', 'b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001', 'R2', '2026-04-05', 2000, 'cash', 22000, gen_random_uuid());
insert into public.fee_payment_allocations (school_id, payment_id, due_id, amount)
  select 'b9000000-0000-4000-8000-00000000000a', 'ac000000-0000-4000-8000-000000000001', id, 1000 from public.student_fee_dues where enrollment_id = 'e9000000-0000-4000-8000-000000000001' and due_month = '2026-04-01';
insert into public.fee_payment_allocations (school_id, payment_id, due_id, amount)
  select 'b9000000-0000-4000-8000-00000000000a', 'ac000000-0000-4000-8000-000000000002', id, 2000 from public.student_fee_dues where enrollment_id = 'e9000000-0000-4000-8000-000000000002' and due_month = '2026-04-01';
insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status) values
  ('b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-0000000000a1', '2026-07-01', 'present'),
  ('b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000002', 'd9000000-0000-4000-8000-0000000000a2', '2026-07-01', 'absent');
insert into public.student_documents (school_id, student_id, document_type, file_path, file_name, mime_type, size_bytes) values
  ('b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000001', 'birth_certificate',
   'b9000000-0000-4000-8000-00000000000a/f9000000-0000-4000-8000-000000000001/x.pdf', 'x.pdf', 'application/pdf', 10);
insert into public.notices (school_id, title, body, audience, class_ids, publish_at, expires_at) values
  ('b9000000-0000-4000-8000-00000000000a', 'Holiday on Friday', 'School closed.', 'everyone', null, now() - interval '1 day', null),
  ('b9000000-0000-4000-8000-00000000000a', 'Class 2 picnic', 'Bring lunch.', 'parents', array['d9000000-0000-4000-8000-000000000002'::uuid], now() - interval '1 hour', null),
  ('b9000000-0000-4000-8000-00000000000a', 'Staff meeting', 'Room 4.', 'staff', null, now() - interval '1 hour', null),
  ('b9000000-0000-4000-8000-00000000000a', 'Future notice', 'Later.', 'everyone', null, now() + interval '2 days', null),
  ('b9000000-0000-4000-8000-00000000000a', 'Old notice', 'Over.', 'everyone', null, now() - interval '10 days', now() - interval '1 day');

-- ================= parent 1: only Child One =================
select private._t_as('a9000000-0000-4000-8000-000000000001');
select private._t_assert((select string_agg(full_name, ',') from public.students) = 'Child One', 'parent sees only their own child');
select private._t_eq((select count(*) from public.student_enrollments), 1, 'only their child''s enrollment');
select private._t_eq((select count(*) from public.attendance_records), 1, 'only their child''s attendance');
select private._t_eq((select count(*) from public.student_fee_dues where enrollment_id = 'e9000000-0000-4000-8000-000000000002'), 0, 'no dues of the other child');
select private._t_assert((select string_agg(receipt_number, ',') from public.fee_payments) = 'R1', 'only their child''s receipts');
select private._t_eq((select count(*) from public.fee_payment_allocations), 1, 'only their child''s receipt lines');
select private._t_assert((select string_agg(name, ',') from public.fee_heads) = 'Tuition Fee', 'only the fee names their child is billed for');
select private._t_eq((select count(*) from public.student_documents), 0, 'documents stay admin-only');
select private._t_assert(private.is_guardian_of('f9000000-0000-4000-8000-000000000001'), 'is guardian of own child');
select private._t_assert(not private.is_guardian_of('f9000000-0000-4000-8000-000000000002'), 'is not guardian of another child');
select private._t_eq((select count(*) from private.student_fee_status('e9000000-0000-4000-8000-000000000002')), 0,
  'fee functions return nothing for another child');
select private._t_eq((select total from private.enrollment_fee_totals(array['e9000000-0000-4000-8000-000000000002'::uuid])), 0,
  'fee totals reveal nothing about another child');
select private._t_eq((select total from private.enrollment_fee_totals(array['e9000000-0000-4000-8000-000000000001'::uuid])), 12000,
  'fee totals work for own child');
select private._t_raises($q$select private.sync_dues_for_guardian('f9000000-0000-4000-8000-000000000002')$q$, 'P0002',
  'cannot refresh another child''s dues');
select private.sync_dues_for_guardian('f9000000-0000-4000-8000-000000000001');
select private._t_raises($q$insert into public.student_guardians (school_id, student_id, user_id, relationship)
  values ('b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-000000000001', 'father')$q$,
  '42501', 'a parent cannot link themselves to another child');
select private._t_rows($q$update public.students set full_name = 'Hacked' where id = 'f9000000-0000-4000-8000-000000000001'$q$, 0,
  'parents cannot edit even their own child');
select private._t_raises($q$insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status)
  values ('b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001',
          'c9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-0000000000a1', '2026-07-02', 'present')$q$,
  '42501', 'parents cannot mark attendance');
select private._t_assert((select string_agg(title, ',' order by title) from public.notices) = 'Holiday on Friday',
  'parent 1 sees only current notices for everyone (not Class 2, staff, future or expired)');
select private._t_eq((select count(*) from public.student_guardians), 1, 'parent sees only their own links');
reset role;

-- ================= parent 2: only Child Two, and the Class 2 notice =================
select private._t_as('a9000000-0000-4000-8000-000000000002');
select private._t_assert((select string_agg(full_name, ',') from public.students) = 'Child Two', 'parent 2 sees only their child');
select private._t_assert((select string_agg(title, ',' order by title) from public.notices) = 'Class 2 picnic,Holiday on Friday',
  'parent 2 also sees the notice for their child''s class');
reset role;

-- ================= parent in School B: nothing from School A =================
select private._t_as('a9000000-0000-4000-8000-000000000003');
select private._t_eq((select count(*) from public.students) + (select count(*) from public.fee_payments)
  + (select count(*) from public.notices), 0, 'a parent from another school sees nothing');
reset role;

-- ================= teacher: staff notices, no link powers =================
select private._t_as('a9000000-0000-4000-8000-000000000004');
select private._t_eq((select count(*) from public.notices), 5, 'staff see every notice of their school');
select private._t_raises($q$insert into public.notices (school_id, title, body) values ('b9000000-0000-4000-8000-00000000000a', 'Teacher notice', 'x')$q$,
  '42501', 'only admins post notices');
reset role;

-- ---------- link rules ----------
select private._t_raises($q$insert into public.student_guardians (school_id, student_id, user_id, relationship)
  values ('b9000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-000000000004', 'guardian')$q$,
  '23514', 'only parent accounts can be linked', 'isn''t a parent');
select private._t_raises($q$insert into public.student_guardians (school_id, student_id, user_id, relationship)
  values ('b9000000-0000-4000-8000-00000000000b', 'f9000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000003', 'father')$q$,
  '23503', 'a link can''t cross schools');

-- ---------- removing the parent role or the link removes access at once ----------
update public.school_memberships set status = 'disabled' where user_id = 'a9000000-0000-4000-8000-000000000001';
select private._t_as('a9000000-0000-4000-8000-000000000001');
select private._t_eq((select count(*) from public.students) + (select count(*) from public.fee_payments), 0, 'disabled parent sees nothing');
reset role;
update public.school_memberships set status = 'active' where user_id = 'a9000000-0000-4000-8000-000000000001';
delete from public.student_guardians where user_id = 'a9000000-0000-4000-8000-000000000001';
select private._t_as('a9000000-0000-4000-8000-000000000001');
select private._t_eq((select count(*) from public.students), 0, 'unlinked parent sees nothing');
reset role;

select 'ALL PARENT PORTAL TESTS PASSED' as result;
rollback;
