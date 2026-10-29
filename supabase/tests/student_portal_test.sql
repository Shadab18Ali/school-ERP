-- =====================================================================
-- Student portal test (migrations 0001-0011). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL STUDENT PORTAL TESTS PASSED".
-- Two student accounts in School A (each linked to their own record), a parent,
-- a teacher, and a student account in School B.
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
  ('ad000000-0000-4000-8000-000000000001', 'sp-student-1@example.invalid'),
  ('ad000000-0000-4000-8000-000000000002', 'sp-student-2@example.invalid'),
  ('ad000000-0000-4000-8000-000000000003', 'sp-parent@example.invalid'),
  ('ad000000-0000-4000-8000-000000000004', 'sp-teacher@example.invalid'),
  ('ad000000-0000-4000-8000-000000000005', 'sp-student-b@example.invalid'),
  ('ad000000-0000-4000-8000-000000000006', 'sp-admin@example.invalid');
insert into public.schools (id, name, code) values
  ('be000000-0000-4000-8000-00000000000a', 'Student Portal A', 'ZZSP-A'),
  ('be000000-0000-4000-8000-00000000000b', 'Student Portal B', 'ZZSP-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('be000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000001', 'student'),
  ('be000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000002', 'student'),
  ('be000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000003', 'parent'),
  ('be000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000004', 'teacher'),
  ('be000000-0000-4000-8000-00000000000b', 'ad000000-0000-4000-8000-000000000005', 'student'),
  ('be000000-0000-4000-8000-00000000000a', 'ad000000-0000-4000-8000-000000000006', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('ce000000-0000-4000-8000-000000000001', 'be000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('de000000-0000-4000-8000-000000000001', 'be000000-0000-4000-8000-00000000000a', 'Class 9'),
  ('de000000-0000-4000-8000-000000000002', 'be000000-0000-4000-8000-00000000000a', 'Class 10');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('de000000-0000-4000-8000-0000000000a1', 'be000000-0000-4000-8000-00000000000a', 'de000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'A'),
  ('de000000-0000-4000-8000-0000000000a2', 'be000000-0000-4000-8000-00000000000a', 'de000000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('fe000000-0000-4000-8000-000000000001', 'be000000-0000-4000-8000-00000000000a', 'Student One', 'F', '2011-01-01', 'male', '9800000101'),
  ('fe000000-0000-4000-8000-000000000002', 'be000000-0000-4000-8000-00000000000a', 'Student Two', 'F', '2010-01-01', 'female', '9800000202');
-- the owner sets links here (no signed-in user, so the admin-only check doesn't apply)
update public.students set account_id = 'ad000000-0000-4000-8000-000000000001' where id = 'fe000000-0000-4000-8000-000000000001';
update public.students set account_id = 'ad000000-0000-4000-8000-000000000002' where id = 'fe000000-0000-4000-8000-000000000002';
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('ee000000-0000-4000-8000-000000000001', 'be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-0000000000a1', 'S1', '2026-04-01'),
  ('ee000000-0000-4000-8000-000000000002', 'be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-0000000000a2', 'S2', '2026-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000002', 'ad000000-0000-4000-8000-000000000003', 'mother');
insert into public.fee_heads (id, school_id, name) values
  ('af000000-0000-4000-8000-000000000001', 'be000000-0000-4000-8000-00000000000a', 'Tuition Fee'),
  ('af000000-0000-4000-8000-000000000002', 'be000000-0000-4000-8000-00000000000a', 'Science Lab Fee');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values
  ('a0f00000-0000-4000-8000-000000000001', 'be000000-0000-4000-8000-00000000000a', 'ce000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001'),
  ('a0f00000-0000-4000-8000-000000000002', 'be000000-0000-4000-8000-00000000000a', 'ce000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000002');
insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency) values
  ('be000000-0000-4000-8000-00000000000a', 'a0f00000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-000000000001', 1500, 'monthly'),
  ('be000000-0000-4000-8000-00000000000a', 'a0f00000-0000-4000-8000-000000000002', 'af000000-0000-4000-8000-000000000002', 2500, 'monthly');
select private.sync_student_dues(array['ee000000-0000-4000-8000-000000000001'::uuid, 'ee000000-0000-4000-8000-000000000002'::uuid]);
insert into public.fee_payments (school_id, student_id, enrollment_id, academic_session_id, receipt_number, payment_date, amount, payment_mode, balance_after, idempotency_key) values
  ('be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000001', 'ee000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'SR1', '2026-04-05', 1500, 'cash', 16500, gen_random_uuid()),
  ('be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000002', 'ee000000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000001', 'SR2', '2026-04-05', 2500, 'cash', 27500, gen_random_uuid());
insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status) values
  ('be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000001', 'ee000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-0000000000a1', '2026-07-01', 'present'),
  ('be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000002', 'ee000000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-0000000000a2', '2026-07-01', 'absent');
insert into public.student_documents (school_id, student_id, document_type, file_path, file_name, mime_type, size_bytes) values
  ('be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000001', 'birth_certificate',
   'be000000-0000-4000-8000-00000000000a/fe000000-0000-4000-8000-000000000001/x.pdf', 'x.pdf', 'application/pdf', 10);
insert into public.notices (school_id, title, body, audience, class_ids, publish_at) values
  ('be000000-0000-4000-8000-00000000000a', 'For everyone', 'x', 'everyone', null, now() - interval '1 hour'),
  ('be000000-0000-4000-8000-00000000000a', 'For students', 'x', 'students', null, now() - interval '1 hour'),
  ('be000000-0000-4000-8000-00000000000a', 'Class 9 lab', 'x', 'students', array['de000000-0000-4000-8000-000000000001'::uuid], now() - interval '1 hour'),
  ('be000000-0000-4000-8000-00000000000a', 'Class 10 lab', 'x', 'students', array['de000000-0000-4000-8000-000000000002'::uuid], now() - interval '1 hour'),
  ('be000000-0000-4000-8000-00000000000a', 'For parents', 'x', 'parents', null, now() - interval '1 hour'),
  ('be000000-0000-4000-8000-00000000000a', 'For staff', 'x', 'staff', null, now() - interval '1 hour'),
  ('be000000-0000-4000-8000-00000000000a', 'Students later', 'x', 'students', null, now() + interval '1 day');

-- ================= student 1: only their own record =================
select private._t_as('ad000000-0000-4000-8000-000000000001');
select private._t_assert((select string_agg(full_name, ',') from public.students) = 'Student One', 'a student sees only themself');
select private._t_eq((select count(*) from public.student_enrollments), 1, 'only their own enrollment');
select private._t_eq((select count(*) from public.attendance_records), 1, 'only their own attendance');
select private._t_eq((select count(*) from public.student_fee_dues where student_id <> 'fe000000-0000-4000-8000-000000000001'), 0, 'only their own dues');
select private._t_assert((select string_agg(receipt_number, ',') from public.fee_payments) = 'SR1', 'only their own receipts');
select private._t_assert((select string_agg(name, ',') from public.fee_heads) = 'Tuition Fee', 'only the fee names they are billed for');
select private._t_eq((select count(*) from public.student_documents) + (select count(*) from public.student_guardians), 0,
  'no documents, no guardian links');
select private._t_assert(private.is_student_self('fe000000-0000-4000-8000-000000000001') and not private.is_student_self('fe000000-0000-4000-8000-000000000002'),
  'is_student_self is true only for their own record');
select private._t_assert(not private.can_view_student_record('fe000000-0000-4000-8000-000000000002'), 'cannot view another student');
select private._t_eq((select count(*) from private.student_fee_status('ee000000-0000-4000-8000-000000000002')), 0,
  'fee functions reveal nothing about another student');
select private._t_raises($q$select private.sync_dues_for_portal('fe000000-0000-4000-8000-000000000002')$q$, 'P0002',
  'cannot refresh another student''s dues');
select private.sync_dues_for_portal('fe000000-0000-4000-8000-000000000001');
select private._t_rows($q$update public.students set full_name = 'Changed' where id = 'fe000000-0000-4000-8000-000000000001'$q$, 0,
  'students cannot edit their own record');
select private._t_raises($q$insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status)
  values ('be000000-0000-4000-8000-00000000000a', 'fe000000-0000-4000-8000-000000000001', 'ee000000-0000-4000-8000-000000000001',
          'ce000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-0000000000a1', '2026-07-02', 'present')$q$,
  '42501', 'students cannot mark attendance');
select private._t_assert((select string_agg(title, ',' order by title) from public.notices) = 'Class 9 lab,For everyone,For students',
  'student 1 sees everyone/student notices and their own class''s (not Class 10, parents, staff or scheduled)');
reset role;

-- ================= student 2 sees their own class notice; their parent still works =================
select private._t_as('ad000000-0000-4000-8000-000000000002');
select private._t_assert((select string_agg(full_name, ',') from public.students) = 'Student Two', 'student 2 sees only themself');
select private._t_assert((select string_agg(title, ',' order by title) from public.notices) = 'Class 10 lab,For everyone,For students',
  'student 2 sees their own class''s notice');
reset role;
select private._t_as('ad000000-0000-4000-8000-000000000003');
select private._t_assert((select string_agg(full_name, ',') from public.students) = 'Student Two', 'the parent still sees exactly their child');
select private._t_assert((select string_agg(receipt_number, ',') from public.fee_payments) = 'SR2', 'the parent still sees their child''s receipts');
select private._t_assert((select string_agg(title, ',' order by title) from public.notices) = 'For everyone,For parents',
  'parents don''t get student-only notices');
reset role;

-- ================= a student account from School B sees nothing of School A =================
select private._t_as('ad000000-0000-4000-8000-000000000005');
select private._t_eq((select count(*) from public.students) + (select count(*) from public.notices), 0, 'other school''s student sees nothing');
reset role;

-- ---------- link rules ----------
select set_config('request.jwt.claims', '{}', true);  -- run these as the owner, with no signed-in user
select private._t_raises($q$update public.students set account_id = 'ad000000-0000-4000-8000-000000000003' where id = 'fe000000-0000-4000-8000-000000000001'$q$,
  '23514', 'only student accounts can be linked', 'isn''t a student');
select private._t_raises($q$update public.students set account_id = 'ad000000-0000-4000-8000-000000000002' where id = 'fe000000-0000-4000-8000-000000000001'$q$,
  '23505', 'one account cannot be two students');
select private._t_raises($q$update public.students set account_id = 'ad000000-0000-4000-8000-000000000005' where id = 'fe000000-0000-4000-8000-000000000001'$q$,
  '23514', 'a student account from another school cannot be linked');
-- the guard itself (claims set, RLS bypassed as owner): a teacher may not relink; an admin may unlink
select set_config('request.jwt.claims', json_build_object('sub', 'ad000000-0000-4000-8000-000000000004')::text, true);
select private._t_raises($q$update public.students set account_id = null where id = 'fe000000-0000-4000-8000-000000000001'$q$,
  '42501', 'only school admins change student logins', 'Only school administrators');
select set_config('request.jwt.claims', json_build_object('sub', 'ad000000-0000-4000-8000-000000000006')::text, true);
select private._t_rows($q$update public.students set account_id = null where id = 'fe000000-0000-4000-8000-000000000001'$q$, 1, 'an admin can unlink a login');
select set_config('request.jwt.claims', '{}', true);
select private._t_as('ad000000-0000-4000-8000-000000000001');
select private._t_eq((select count(*) from public.students), 0, 'an unlinked login sees nothing at once');
reset role;

-- ---------- disabling the student role removes access ----------
update public.school_memberships set status = 'disabled' where user_id = 'ad000000-0000-4000-8000-000000000002';
select private._t_as('ad000000-0000-4000-8000-000000000002');
select private._t_eq((select count(*) from public.students) + (select count(*) from public.notices), 0, 'a disabled student sees nothing');
reset role;

select 'ALL STUDENT PORTAL TESTS PASSED' as result;
rollback;
