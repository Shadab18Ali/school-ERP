-- =====================================================================
-- Students test (migrations 0001-0005). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL STUDENT TESTS PASSED".
-- =====================================================================
begin;

create function private._t_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
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
grant execute on function private._t_assert(boolean, text), private._t_raises(text, text, text, text),
  private._t_rows(text, int, text), private._t_as(uuid) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a3000000-0000-4000-8000-000000000001', 'stu-test-admin-a@example.invalid'),
  ('a3000000-0000-4000-8000-000000000002', 'stu-test-teacher-a@example.invalid'),
  ('a3000000-0000-4000-8000-000000000003', 'stu-test-parent-a@example.invalid'),
  ('a3000000-0000-4000-8000-000000000004', 'stu-test-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b3000000-0000-4000-8000-00000000000a', 'Student Test A', 'ZZSTU-A'),
  ('b3000000-0000-4000-8000-00000000000b', 'Student Test B', 'ZZSTU-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b3000000-0000-4000-8000-00000000000a', 'a3000000-0000-4000-8000-000000000001', 'school_admin'),
  ('b3000000-0000-4000-8000-00000000000a', 'a3000000-0000-4000-8000-000000000002', 'teacher'),
  ('b3000000-0000-4000-8000-00000000000a', 'a3000000-0000-4000-8000-000000000003', 'parent'),
  ('b3000000-0000-4000-8000-00000000000b', 'a3000000-0000-4000-8000-000000000004', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', '2025-26', '2025-04-01', '2026-03-31', false),
  ('c3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true),
  ('c3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-00000000000b', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'Class 1'),
  ('d3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'Class 2'),
  ('d3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-00000000000b', 'Class 1');
insert into public.sections (id, school_id, class_id, academic_session_id, name, capacity) values
  -- A: Class 1-A (cap 2) and Class 2-A in 2026-27; Class 1-A in 2025-26
  ('e3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'A', 2),
  ('e3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'A', null),
  ('e3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'A', null),
  ('e3000000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-00000000000b', 'd3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000003', 'A', null);

-- ================= school admin A =================
select private._t_as('a3000000-0000-4000-8000-000000000001');

select private._t_rows($q$insert into public.students (id, school_id, full_name, father_name, mother_name, date_of_birth, gender, mobile) values
  ('f3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'Aarav Sharma', 'Rakesh Sharma', null, '2019-05-10', 'male', '9876543210'),
  ('f3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'Diya Patel', null, 'Meera Patel', '2019-08-21', 'female', '+919812345678'),
  ('f3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-00000000000a', 'Kabir Khan', 'Imran Khan', null, '2018-01-02', 'male', '9811111111')$q$,
  3, 'admin can add students');
select private._t_assert(
  (select string_agg(student_code, ',' order by student_code) from public.students where school_id = 'b3000000-0000-4000-8000-00000000000a') = 'STU00001,STU00002,STU00003',
  'Student IDs are generated in sequence per school');
select private._t_raises($q$insert into public.students (school_id, full_name, date_of_birth, gender, mobile)
  values ('b3000000-0000-4000-8000-00000000000a', 'No Parents', '2019-01-01', 'male', '9800000000')$q$,
  '23514', 'a father''s or mother''s name is required');
select private._t_raises($q$insert into public.students (school_id, full_name, father_name, date_of_birth, gender, mobile)
  values ('b3000000-0000-4000-8000-00000000000a', 'Bad Phone', 'X', '2019-01-01', 'male', '12345')$q$,
  '23514', 'mobile numbers are validated');
select private._t_raises($q$update public.students set student_code = 'STU99999' where id = 'f3000000-0000-4000-8000-000000000001'$q$,
  '23514', 'Student ID cannot be changed', 'cannot be changed');

-- enrol: Aarav + Diya in Class 1-A 2026-27 (capacity 2), Kabir in Class 2-A
select private._t_rows($q$insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'ADM-001', '2026-04-01'),
  ('b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'ADM-002', '2026-04-01'),
  ('b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', 'ADM-003', '2026-04-01')$q$,
  3, 'admin can enrol students');

-- duplicate admission number in the same school + session (case/space-insensitive)
select private._t_raises($q$update public.student_enrollments set admission_number = ' adm-001 '
  where student_id = 'f3000000-0000-4000-8000-000000000003'$q$, '23505', 'admission numbers are unique within a school and session');
-- the same number is fine in another session
select private._t_rows($q$insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date)
  values ('b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000001',
          'd3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000003', 'ADM-001', '2025-04-01')$q$,
  1, 'the same admission number is allowed in a different session');
-- one enrollment per student per session
select private._t_raises($q$insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date)
  values ('b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002',
          'd3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000002', 'ADM-999', '2026-04-01')$q$,
  '23505', 'a student is enrolled at most once per session');

-- section must belong to the chosen class and session
select private._t_raises($q$update public.student_enrollments set class_id = 'd3000000-0000-4000-8000-000000000002'
  where student_id = 'f3000000-0000-4000-8000-000000000001' and academic_session_id = 'c3000000-0000-4000-8000-000000000002'$q$,
  '23503', 'section must belong to the enrollment''s class');
select private._t_raises($q$update public.student_enrollments set section_id = 'e3000000-0000-4000-8000-000000000003'
  where student_id = 'f3000000-0000-4000-8000-000000000001' and academic_session_id = 'c3000000-0000-4000-8000-000000000002'$q$,
  '23503', 'section must belong to the enrollment''s session');

-- capacity: Class 1-A holds 2 and is full
select private._t_raises($q$update public.student_enrollments set class_id = 'd3000000-0000-4000-8000-000000000001', section_id = 'e3000000-0000-4000-8000-000000000001'
  where student_id = 'f3000000-0000-4000-8000-000000000003' and academic_session_id = 'c3000000-0000-4000-8000-000000000002'$q$,
  '23514', 'a full section refuses more students', 'is full (2 of 2)');

-- real counts now feed the Phase 5 guards
select private._t_assert(
  (select student_count from private.section_student_counts(array['e3000000-0000-4000-8000-000000000001'::uuid])) = 2,
  'section student counts are real');
select private._t_raises($q$update public.sections set deleted_at = now() where id = 'e3000000-0000-4000-8000-000000000001'$q$,
  '23001', 'a section with students cannot be deleted', '2 student(s)');
select private._t_raises($q$update public.sections set class_id = 'd3000000-0000-4000-8000-000000000002' where id = 'e3000000-0000-4000-8000-000000000001'$q$,
  '23001', 'a section with students cannot move to another class');

-- moving a student between sections: allowed, and must name the matching class
select private._t_raises($q$update public.student_enrollments set section_id = 'e3000000-0000-4000-8000-000000000002'
  where student_id = 'f3000000-0000-4000-8000-000000000001' and academic_session_id = 'c3000000-0000-4000-8000-000000000002'$q$,
  '23503', 'moving to another class''s section needs the matching class (composite key)');
select private._t_rows($q$update public.student_enrollments set class_id = 'd3000000-0000-4000-8000-000000000002', section_id = 'e3000000-0000-4000-8000-000000000002'
  where student_id = 'f3000000-0000-4000-8000-000000000001' and academic_session_id = 'c3000000-0000-4000-8000-000000000002'$q$,
  1, 'a student can be moved to another class and section');

-- an inactive section refuses new students
select private._t_rows($q$update public.sections set is_active = false where id = 'e3000000-0000-4000-8000-000000000002'$q$, 1, 'admin can deactivate a section');
select private._t_raises($q$update public.student_enrollments set class_id = 'd3000000-0000-4000-8000-000000000002', section_id = 'e3000000-0000-4000-8000-000000000002'
  where student_id = 'f3000000-0000-4000-8000-000000000002' and academic_session_id = 'c3000000-0000-4000-8000-000000000002'$q$,
  '23514', 'an inactive section refuses new students', 'Section A of Class 2 is inactive');
select private._t_rows($q$update public.sections set is_active = true where id = 'e3000000-0000-4000-8000-000000000002'$q$, 1, 'admin can reactivate a section');

-- deactivate / reactivate a student
select private._t_rows($q$update public.students set status = 'inactive', status_reason = 'Transferred' where id = 'f3000000-0000-4000-8000-000000000003'$q$,
  1, 'admin can deactivate a student');
-- no hard delete for users
select private._t_rows($q$delete from public.students where id = 'f3000000-0000-4000-8000-000000000003'$q$, 0, 'users cannot delete students');
select private._t_rows($q$delete from public.student_enrollments where student_id = 'f3000000-0000-4000-8000-000000000003'$q$, 0, 'users cannot delete enrollments');
reset role;

-- sessions with students can't be deleted (Phase 4 guard finds enrollments automatically)
select private._t_raises($q$delete from public.academic_sessions where id = 'c3000000-0000-4000-8000-000000000001'$q$,
  '23001', 'a session with enrolled students cannot be deleted', 'student_enrollments');

-- archived session: enrollments are read-only
update public.academic_sessions set archived_at = now() where id = 'c3000000-0000-4000-8000-000000000001';
select private._t_raises($q$update public.student_enrollments set admission_date = '2025-04-02'
  where academic_session_id = 'c3000000-0000-4000-8000-000000000001'$q$, '23514', 'archived session enrollments are read-only', 'archived');
update public.academic_sessions set archived_at = null where id = 'c3000000-0000-4000-8000-000000000001';

-- (Phase 14) teachers only see sections assigned to them: give this fixture teacher a
-- teacher record assigned to every open section of the school
reset role;
select set_config('request.jwt.claims', '{}', true);
insert into public.teachers (school_id, full_name, phone, email, joining_date, account_id)
values ('b3000000-0000-4000-8000-00000000000a', 'Fixture Teacher', '9800000999', 'fixture-teacher-a3000000@example.invalid', '2020-01-01', 'a3000000-0000-4000-8000-000000000002');
insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id)
select s.school_id, (select id from public.teachers where account_id = 'a3000000-0000-4000-8000-000000000002'), s.academic_session_id, s.class_id, s.id
from public.sections s join public.academic_sessions a on a.id = s.academic_session_id
where s.school_id = 'b3000000-0000-4000-8000-00000000000a' and s.deleted_at is null and s.is_active and a.archived_at is null;
-- ================= teacher A: read only =================
select private._t_as('a3000000-0000-4000-8000-000000000002');
select private._t_assert((select count(*) from public.students) = 3, 'teacher can see the school''s students');
select private._t_raises($q$insert into public.students (school_id, full_name, father_name, date_of_birth, gender, mobile)
  values ('b3000000-0000-4000-8000-00000000000a', 'T', 'T', '2019-01-01', 'male', '9800000000')$q$, '42501', 'teacher cannot add students');
select private._t_rows($q$update public.students set full_name = 'Changed' where id = 'f3000000-0000-4000-8000-000000000001'$q$, 0,
  'teacher cannot edit students');
reset role;

-- ================= parent of School A: no roster access =================
select private._t_as('a3000000-0000-4000-8000-000000000003');
select private._t_assert((select count(*) from public.students) + (select count(*) from public.student_enrollments) = 0,
  'parents cannot browse the student list (own-child access comes with the parent portal)');
reset role;

-- ================= admin B: isolation =================
select private._t_as('a3000000-0000-4000-8000-000000000004');
select private._t_assert((select count(*) from public.students where school_id = 'b3000000-0000-4000-8000-00000000000a') = 0,
  'admin B sees no School A students');
select private._t_rows($q$update public.students set status = 'inactive' where school_id = 'b3000000-0000-4000-8000-00000000000a'$q$, 0,
  'admin B cannot change School A students');
-- School B's numbering starts at 1, independent of School A
select private._t_rows($q$insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile)
  values ('f3000000-0000-4000-8000-0000000000b1', 'b3000000-0000-4000-8000-00000000000b', 'Zoya Ali', 'Arif Ali', '2019-02-02', 'female', '9822222222')$q$,
  1, 'admin B can add a student');
select private._t_assert((select student_code from public.students where id = 'f3000000-0000-4000-8000-0000000000b1') = 'STU00001',
  'Student IDs are numbered per school');
-- B can't enrol its student into School A's section, or A's student into B
select private._t_raises($q$insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date)
  values ('b3000000-0000-4000-8000-00000000000b', 'f3000000-0000-4000-8000-0000000000b1', 'c3000000-0000-4000-8000-000000000002',
          'd3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000001', 'X1', '2026-04-01')$q$,
  '23503', 'cannot enrol into another school''s session/class/section');
select private._t_raises($q$insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date)
  values ('b3000000-0000-4000-8000-00000000000b', 'f3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003',
          'd3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000004', 'X1', '2026-04-01')$q$,
  '23503', 'cannot enrol another school''s student');
reset role;

-- deleting a whole school still removes everything
delete from public.schools where id = 'b3000000-0000-4000-8000-00000000000a';
select private._t_assert(not exists (select 1 from public.students where school_id = 'b3000000-0000-4000-8000-00000000000a'),
  'deleting a school removes its students');

select 'ALL STUDENT TESTS PASSED' as result;
rollback;
