-- =====================================================================
-- Teacher management test (migrations 0001-0012). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL TEACHER TESTS PASSED".
-- School A: Class 1-A (Asha, Bilal) and Class 2-A (Chetan). Teacher One teaches
-- Class 1-A, Teacher Two teaches Class 2-A. A teacher in School B, an accountant.
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
  ('a1100000-0000-4000-8000-000000000001', 'tt-admin@example.invalid'),
  ('a1100000-0000-4000-8000-000000000002', 'tt-teacher-one@example.invalid'),
  ('a1100000-0000-4000-8000-000000000003', 'tt-teacher-two@example.invalid'),
  ('a1100000-0000-4000-8000-000000000004', 'tt-accountant@example.invalid'),
  ('a1100000-0000-4000-8000-000000000005', 'tt-teacher-b@example.invalid'),
  ('a1100000-0000-4000-8000-000000000006', 'tt-parent@example.invalid');
insert into public.schools (id, name, code) values
  ('b1100000-0000-4000-8000-00000000000a', 'Teacher Test A', 'ZZTT-A'),
  ('b1100000-0000-4000-8000-00000000000b', 'Teacher Test B', 'ZZTT-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b1100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000001', 'school_admin'),
  ('b1100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000002', 'teacher'),
  ('b1100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000003', 'teacher'),
  ('b1100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000004', 'accountant'),
  ('b1100000-0000-4000-8000-00000000000b', 'a1100000-0000-4000-8000-000000000005', 'teacher'),
  ('b1100000-0000-4000-8000-00000000000a', 'a1100000-0000-4000-8000-000000000006', 'parent');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c1100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true),
  ('c1100000-0000-4000-8000-000000000002', 'b1100000-0000-4000-8000-00000000000a', '2025-26', '2025-04-01', '2026-03-31', false);
insert into public.classes (id, school_id, name) values
  ('d1100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-00000000000a', 'Class 1'),
  ('d1100000-0000-4000-8000-000000000002', 'b1100000-0000-4000-8000-00000000000a', 'Class 2');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d1100000-0000-4000-8000-0000000000a1', 'b1100000-0000-4000-8000-00000000000a', 'd1100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'A'),
  ('d1100000-0000-4000-8000-0000000000a2', 'b1100000-0000-4000-8000-00000000000a', 'd1100000-0000-4000-8000-000000000002', 'c1100000-0000-4000-8000-000000000001', 'A'),
  ('d1100000-0000-4000-8000-0000000000b1', 'b1100000-0000-4000-8000-00000000000a', 'd1100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000002', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f1100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-00000000000a', 'Asha', 'P', '2019-01-01', 'female', '9800000301'),
  ('f1100000-0000-4000-8000-000000000002', 'b1100000-0000-4000-8000-00000000000a', 'Bilal', 'P', '2019-01-01', 'male', '9800000302'),
  ('f1100000-0000-4000-8000-000000000003', 'b1100000-0000-4000-8000-00000000000a', 'Chetan', 'P', '2018-01-01', 'male', '9800000303');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('e1100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-00000000000a', 'f1100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-0000000000a1', 'T1', '2026-04-01'),
  ('e1100000-0000-4000-8000-000000000002', 'b1100000-0000-4000-8000-00000000000a', 'f1100000-0000-4000-8000-000000000002', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-0000000000a1', 'T2', '2026-04-01'),
  ('e1100000-0000-4000-8000-000000000003', 'b1100000-0000-4000-8000-00000000000a', 'f1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-0000000000a2', 'T3', '2026-04-01');
insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status) values
  ('b1100000-0000-4000-8000-00000000000a', 'f1100000-0000-4000-8000-000000000003', 'e1100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-0000000000a2', '2026-07-01', 'absent');

-- ================= admin creates teachers =================
select private._t_as('a1100000-0000-4000-8000-000000000001');
insert into public.teachers (id, school_id, employee_id, full_name, phone, email, joining_date, subject) values
  ('71100000-0000-4000-8000-000000000001', 'b1100000-0000-4000-8000-00000000000a', null, 'Teacher One', '9811100001', 'one@example.invalid', '2020-06-01', 'Maths'),
  ('71100000-0000-4000-8000-000000000002', 'b1100000-0000-4000-8000-00000000000a', '', 'Teacher Two', '9811100002', 'two@example.invalid', '2021-06-01', 'English');
select private._t_assert((select string_agg(employee_id, ',' order by full_name) from public.teachers) = 'EMP0001,EMP0002',
  'empty Employee IDs are allocated as EMP0001, EMP0002');
insert into public.teachers (id, school_id, employee_id, full_name, phone, email, joining_date) values
  ('71100000-0000-4000-8000-000000000003', 'b1100000-0000-4000-8000-00000000000a', ' t-77 ', 'Teacher Three', '9811100003', 'three@example.invalid', '2022-06-01');
select private._t_assert((select employee_id from public.teachers where id = '71100000-0000-4000-8000-000000000003') = 'T-77',
  'a given Employee ID is trimmed and upper-cased');
select private._t_raises($q$insert into public.teachers (school_id, employee_id, full_name, phone, email, joining_date)
  values ('b1100000-0000-4000-8000-00000000000a', 'emp0001', 'Dup', '9811100009', 'dup@example.invalid', '2020-01-01')$q$,
  '23505', 'Employee IDs are unique per school (ignoring case)');
select private._t_raises($q$insert into public.teachers (school_id, full_name, phone, email, joining_date)
  values ('b1100000-0000-4000-8000-00000000000a', 'Dup', '9811100009', 'ONE@example.invalid', '2020-01-01')$q$,
  '23505', 'emails are unique per school (ignoring case)');
select private._t_raises($q$insert into public.teachers (school_id, full_name, phone, email, joining_date)
  values ('b1100000-0000-4000-8000-00000000000a', 'Future', '9811100009', 'f@example.invalid', current_date + 1)$q$,
  '23514', 'the joining date can''t be in the future', 'future');
select private._t_raises($q$insert into public.teachers (school_id, full_name, phone, email, joining_date)
  values ('b1100000-0000-4000-8000-00000000000a', 'Bad', '12-34', 'b@example.invalid', '2020-01-01')$q$,
  '23514', 'phone numbers are validated');
select private._t_raises($q$insert into public.teachers (school_id, full_name, phone, email, joining_date)
  values ('b1100000-0000-4000-8000-00000000000a', 'Bad', '9811100009', 'not-an-email', '2020-01-01')$q$,
  '23514', 'emails are validated');
select private._t_raises($q$update public.teachers set photo_path = 'b1100000-0000-4000-8000-00000000000a/teachers/71100000-0000-4000-8000-000000000002/x.jpg'
  where id = '71100000-0000-4000-8000-000000000001'$q$, '23514', 'a photo must sit in the teacher''s own folder');
select private._t_raises($q$delete from public.teachers$q$, '42501', 'teachers are deactivated, never deleted');

-- logins
update public.teachers set account_id = 'a1100000-0000-4000-8000-000000000002' where id = '71100000-0000-4000-8000-000000000001';
update public.teachers set account_id = 'a1100000-0000-4000-8000-000000000003' where id = '71100000-0000-4000-8000-000000000002';
select private._t_raises($q$update public.teachers set account_id = 'a1100000-0000-4000-8000-000000000004' where id = '71100000-0000-4000-8000-000000000003'$q$,
  '23514', 'only teacher accounts can be linked', 'isn''t a teacher');
select private._t_raises($q$update public.teachers set account_id = 'a1100000-0000-4000-8000-000000000005' where id = '71100000-0000-4000-8000-000000000003'$q$,
  '23514', 'a teacher account from another school can''t be linked');
select private._t_raises($q$update public.teachers set account_id = 'a1100000-0000-4000-8000-000000000002' where id = '71100000-0000-4000-8000-000000000003'$q$,
  '23505', 'one login can''t be two teachers');

-- assignments
insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id, subject, is_class_teacher) values
  ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-0000000000a1', 'Maths', true),
  ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-0000000000a1', 'Science', false),
  ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000002', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-0000000000a2', 'English', true);
select private._t_raises($q$insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id, subject)
  values ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-0000000000a1', 'maths')$q$,
  '23505', 'the same subject can''t be assigned twice in a section');
select private._t_raises($q$insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id, subject, is_class_teacher)
  values ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-0000000000a1', 'Art', true)$q$,
  '23505', 'only one class teacher per section');
select private._t_raises($q$insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id)
  values ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000003', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-0000000000a1')$q$,
  '23503', 'the class must match the section');
reset role;

-- ================= Teacher One: ONLY Class 1-A =================
select private._t_as('a1100000-0000-4000-8000-000000000002');
select private._t_assert((select string_agg(full_name, ',' order by full_name) from public.students) = 'Asha,Bilal',
  'Teacher One sees only the students of Class 1-A');
select private._t_eq((select count(*) from public.student_enrollments), 2, 'only Class 1-A enrollments');
select private._t_assert((select string_agg(name, ',') from public.classes) = 'Class 1', 'only their class');
select private._t_assert((select string_agg(id::text, ',') from public.sections) = 'd1100000-0000-4000-8000-0000000000a1', 'only their section');
select private._t_eq((select count(*) from public.attendance_records), 0, 'no attendance from Class 2-A');
select private._t_assert(private.teacher_assigned_section('d1100000-0000-4000-8000-0000000000a1')
  and not private.teacher_assigned_section('d1100000-0000-4000-8000-0000000000a2'), 'assigned-section check');
select private._t_assert((select string_agg(full_name, ',') from public.teachers) = 'Teacher One', 'a teacher sees only their own teacher record');
select private._t_eq((select count(*) from public.teacher_assignments), 2, 'and only their own assignments');
-- marking: their section yes, another section no
select private._t_assert((select inserted = 2 from private.save_section_attendance('d1100000-0000-4000-8000-0000000000a1', '2026-07-02',
  jsonb_build_array(jsonb_build_object('enrollment_id', 'e1100000-0000-4000-8000-000000000001', 'status', 'present'),
                    jsonb_build_object('enrollment_id', 'e1100000-0000-4000-8000-000000000002', 'status', 'absent')))),
  'Teacher One can mark Class 1-A');
select private._t_raises($q$select private.save_section_attendance('d1100000-0000-4000-8000-0000000000a2', '2026-07-02',
  jsonb_build_array(jsonb_build_object('enrollment_id', 'e1100000-0000-4000-8000-000000000003', 'status', 'present')))$q$,
  'P0002', 'Teacher One cannot mark Class 2-A (it doesn''t exist for them)');
select private._t_raises($q$insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status)
  values ('b1100000-0000-4000-8000-00000000000a', 'f1100000-0000-4000-8000-000000000003', 'e1100000-0000-4000-8000-000000000003',
          'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-0000000000a2', '2026-07-03', 'present')$q$,
  '42501', 'writing attendance into another section directly is refused');
select private._t_eq((select count(*) from private.attendance_daily('b1100000-0000-4000-8000-00000000000a', '2026-07-01')), 1,
  'the daily report shows only their section');
select private._t_rows($q$update public.teachers set full_name = 'Changed' where id = '71100000-0000-4000-8000-000000000001'$q$, 0,
  'teachers cannot edit their own staff record');
select private._t_raises($q$insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id)
  values ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-0000000000a2')$q$,
  '42501', 'teachers cannot assign themselves classes');
reset role;

-- ================= Teacher Two: ONLY Class 2-A =================
select private._t_as('a1100000-0000-4000-8000-000000000003');
select private._t_assert((select string_agg(full_name, ',') from public.students) = 'Chetan', 'Teacher Two sees only Class 2-A');
select private._t_eq((select count(*) from public.attendance_records), 1, 'and only Class 2-A attendance');
reset role;

-- ================= others =================
select private._t_as('a1100000-0000-4000-8000-000000000004');
select private._t_eq((select count(*) from public.students), 3, 'accountants still see every student (fees need it)');
select private._t_eq((select count(*) from public.teachers), 0, 'accountants don''t see staff records');
reset role;
select private._t_as('a1100000-0000-4000-8000-000000000005');
select private._t_eq((select count(*) from public.students) + (select count(*) from public.teachers)
  + (select count(*) from public.teacher_assignments), 0, 'a teacher from another school sees nothing');
reset role;
select private._t_as('a1100000-0000-4000-8000-000000000006');
select private._t_eq((select count(*) from public.teachers) + (select count(*) from public.teacher_assignments), 0, 'parents see no staff data');
reset role;

-- ================= losing access =================
select set_config('request.jwt.claims', '{}', true);
-- removing the assignment
delete from public.teacher_assignments where teacher_id = '71100000-0000-4000-8000-000000000002';
select private._t_as('a1100000-0000-4000-8000-000000000003');
select private._t_eq((select count(*) from public.students), 0, 'an unassigned teacher sees no students');
reset role;
-- deactivating the teacher
select set_config('request.jwt.claims', '{}', true);
update public.teachers set status = 'inactive' where id = '71100000-0000-4000-8000-000000000001';
select private._t_as('a1100000-0000-4000-8000-000000000002');
select private._t_eq((select count(*) from public.students) + (select count(*) from public.classes), 0, 'an inactive teacher sees nothing');
reset role;
select set_config('request.jwt.claims', '{}', true);
select private._t_raises($q$insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id)
  values ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-0000000000a2')$q$,
  '23514', 'inactive teachers can''t be given classes', 'Inactive');
update public.teachers set status = 'active' where id = '71100000-0000-4000-8000-000000000001';
-- disabling the teacher role
update public.school_memberships set status = 'disabled' where user_id = 'a1100000-0000-4000-8000-000000000002';
select private._t_as('a1100000-0000-4000-8000-000000000002');
select private._t_eq((select count(*) from public.students), 0, 'a disabled teacher role sees nothing');
reset role;
update public.school_memberships set status = 'active' where user_id = 'a1100000-0000-4000-8000-000000000002';
-- archived sessions are read-only
update public.academic_sessions set archived_at = now() where id = 'c1100000-0000-4000-8000-000000000002';
select private._t_raises($q$insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id)
  values ('b1100000-0000-4000-8000-00000000000a', '71100000-0000-4000-8000-000000000001', 'c1100000-0000-4000-8000-000000000002', 'd1100000-0000-4000-8000-000000000001', 'd1100000-0000-4000-8000-0000000000b1')$q$,
  '23514', 'no assignments in an archived session', 'archived');
-- only admins may link logins (guard checked with an identity set)
select set_config('request.jwt.claims', json_build_object('sub', 'a1100000-0000-4000-8000-000000000004')::text, true);
select private._t_raises($q$update public.teachers set account_id = null where id = '71100000-0000-4000-8000-000000000001'$q$,
  '42501', 'only school admins change teacher logins', 'Only school administrators');
select set_config('request.jwt.claims', '{}', true);

-- deleting a school removes its teachers and assignments
delete from public.schools where id = 'b1100000-0000-4000-8000-00000000000a';
select private._t_eq((select count(*) from public.teachers where school_id = 'b1100000-0000-4000-8000-00000000000a'), 0, 'school deletion cascades');

select 'ALL TEACHER TESTS PASSED' as result;
rollback;
