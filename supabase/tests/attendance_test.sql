-- =====================================================================
-- Attendance test (migrations 0001-0009). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL ATTENDANCE TESTS PASSED".
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
create function private._t_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- e1/e2/e3 = enrollments of three students in section A
create function private._t_entries(s1 text, s2 text, s3 text) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('enrollment_id', 'e8000000-0000-4000-8000-000000000001', 'status', s1),
    jsonb_build_object('enrollment_id', 'e8000000-0000-4000-8000-000000000002', 'status', s2),
    jsonb_build_object('enrollment_id', 'e8000000-0000-4000-8000-000000000003', 'status', s3));
$$;
grant execute on function private._t_assert(boolean, text), private._t_eq(numeric, numeric, text), private._t_raises(text, text, text, text),
  private._t_as(uuid), private._t_entries(text, text, text) to authenticated;

insert into auth.users (id, email) values
  ('a8000000-0000-4000-8000-000000000001', 'att-test-teacher@example.invalid'),
  ('a8000000-0000-4000-8000-000000000002', 'att-test-accountant@example.invalid'),
  ('a8000000-0000-4000-8000-000000000003', 'att-test-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b8000000-0000-4000-8000-00000000000a', 'Attendance Test A', 'ZZATT-A'),
  ('b8000000-0000-4000-8000-00000000000b', 'Attendance Test B', 'ZZATT-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b8000000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000001', 'teacher'),
  ('b8000000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000002', 'accountant'),
  ('b8000000-0000-4000-8000-00000000000b', 'a8000000-0000-4000-8000-000000000003', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c8000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values ('d8000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-00000000000a', 'Class 3');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d8000000-0000-4000-8000-0000000000a1', 'b8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'A'),
  ('d8000000-0000-4000-8000-0000000000b1', 'b8000000-0000-4000-8000-00000000000a', 'd8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'B');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f8000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-00000000000a', 'Aarav', 'P', '2018-01-01', 'male', '9800000001'),
  ('f8000000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-00000000000a', 'Diya', 'P', '2018-01-01', 'female', '9800000002'),
  ('f8000000-0000-4000-8000-000000000003', 'b8000000-0000-4000-8000-00000000000a', 'Kabir', 'P', '2018-01-01', 'male', '9800000003'),
  ('f8000000-0000-4000-8000-000000000004', 'b8000000-0000-4000-8000-00000000000a', 'Meera', 'P', '2018-01-01', 'female', '9800000004');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('e8000000-0000-4000-8000-000000000001', 'b8000000-0000-4000-8000-00000000000a', 'f8000000-0000-4000-8000-000000000001', 'c8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-0000000000a1', '1', '2026-04-01'),
  ('e8000000-0000-4000-8000-000000000002', 'b8000000-0000-4000-8000-00000000000a', 'f8000000-0000-4000-8000-000000000002', 'c8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-0000000000a1', '2', '2026-04-01'),
  ('e8000000-0000-4000-8000-000000000003', 'b8000000-0000-4000-8000-00000000000a', 'f8000000-0000-4000-8000-000000000003', 'c8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-0000000000a1', '3', '2026-04-01'),
  ('e8000000-0000-4000-8000-000000000004', 'b8000000-0000-4000-8000-00000000000a', 'f8000000-0000-4000-8000-000000000004', 'c8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-0000000000b1', '4', '2026-04-01');

-- (Phase 14) teachers only see sections assigned to them: give this fixture teacher a
-- teacher record assigned to every open section of the school
reset role;
select set_config('request.jwt.claims', '{}', true);
insert into public.teachers (school_id, full_name, phone, email, joining_date, account_id)
values ('b8000000-0000-4000-8000-00000000000a', 'Fixture Teacher', '9800000999', 'fixture-teacher-a8000000@example.invalid', '2020-01-01', 'a8000000-0000-4000-8000-000000000001');
insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id)
select s.school_id, (select id from public.teachers where account_id = 'a8000000-0000-4000-8000-000000000001'), s.academic_session_id, s.class_id, s.id
from public.sections s join public.academic_sessions a on a.id = s.academic_session_id
where s.school_id = 'b8000000-0000-4000-8000-00000000000a' and s.deleted_at is null and s.is_active and a.archived_at is null;
-- ================= teacher =================
select private._t_as('a8000000-0000-4000-8000-000000000001');

-- one call saves the whole section
select private._t_assert((select inserted = 3 and updated = 0 and unchanged = 0 from private.save_section_attendance(
  'd8000000-0000-4000-8000-0000000000a1', '2026-07-01', private._t_entries('present', 'present', 'present'))), 'first save inserts 3 records');
-- saving again with one change: only that row is touched
select private._t_assert((select inserted = 0 and updated = 1 and unchanged = 2 and changes -> 0 ->> 'to' = 'absent'
  from private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-01', private._t_entries('present', 'absent', 'present'))),
  'editing changes only the changed student, and reports from/to');
select private._t_eq((select count(*) from public.attendance_records where attendance_date = '2026-07-01'), 3, 'still one record per student for the day');
-- the database itself refuses a duplicate student/date
select private._t_raises($q$insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status)
  values ('b8000000-0000-4000-8000-00000000000a', 'f8000000-0000-4000-8000-000000000001', 'e8000000-0000-4000-8000-000000000001',
          'c8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-000000000001', 'd8000000-0000-4000-8000-0000000000a1', '2026-07-01', 'absent')$q$,
  '23505', 'duplicate student/date is impossible');

-- more days for the reports
select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-02', private._t_entries('present', 'leave', 'absent'));
select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-03', private._t_entries('present', 'present', 'present'));
select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-08-03', private._t_entries('absent', 'present', 'present'));

-- ---------- refusals ----------
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', current_date + 1, private._t_entries('present','present','present'))$q$,
  '23514', 'no future dates', 'future');
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-03-31', private._t_entries('present','present','present'))$q$,
  '23514', 'dates must be inside the session', 'outside session');
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000b1', '2026-07-01', private._t_entries('present','present','present'))$q$,
  '23514', 'students must belong to the section being marked', 'aren''t in this section');
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-04',
  jsonb_build_array(jsonb_build_object('enrollment_id', 'e8000000-0000-4000-8000-000000000001', 'status', 'present'),
                    jsonb_build_object('enrollment_id', 'e8000000-0000-4000-8000-000000000001', 'status', 'absent')))$q$,
  '23514', 'a student can''t appear twice in one save', 'twice');
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-04', private._t_entries('present','sick','present'))$q$,
  '22P02', 'only present / absent / leave');
select private._t_raises($q$delete from public.attendance_records$q$, '42501', 'attendance can''t be deleted (correct it instead)');

-- ---------- reports (all computed in SQL) ----------
-- Aarav: P P P A -> 75%; Diya: A L P P -> 50%; Kabir: P A P P -> 75%
select private._t_eq((select percentage from private.attendance_student_totals('d8000000-0000-4000-8000-0000000000a1', '2026-04-01', '2027-03-31')
  where student_id = 'f8000000-0000-4000-8000-000000000002'), 50.0, 'Diya: 2 present of 4 marked = 50%');
select private._t_eq((select leave from private.attendance_student_totals('d8000000-0000-4000-8000-0000000000a1', '2026-04-01', '2027-03-31')
  where student_id = 'f8000000-0000-4000-8000-000000000002'), 1, 'leave is counted separately');
select private._t_eq((select percentage from private.attendance_student_totals('d8000000-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-31')
  where student_id = 'f8000000-0000-4000-8000-000000000001'), 100.0, 'date range limits the report (July only)');
select private._t_eq((select percentage from private.attendance_section_days('d8000000-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-31')
  where attendance_date = '2026-07-02'), 33.3, 'class on 2 July: 1 of 3 present');
select private._t_assert((select string_agg(to_char(month, 'Mon') || ':' || percentage, ',' order by month)
  from private.attendance_student_months('e8000000-0000-4000-8000-000000000001')) = 'Jul:100.0,Aug:0.0', 'student by month');
select private._t_assert((select enrolled = 3 and present = 2 and absent = 1 and unmarked = 0 and percentage = 66.7
  from private.attendance_daily('b8000000-0000-4000-8000-00000000000a', '2026-07-01') where section_name = 'A'), 'daily: section A on 1 July');
select private._t_assert((select enrolled = 1 and unmarked = 1 and percentage is null
  from private.attendance_daily('b8000000-0000-4000-8000-00000000000a', '2026-07-01') where section_name = 'B'), 'daily: section B not marked');
reset role;

-- ================= accountant & admin B: no access =================
select private._t_as('a8000000-0000-4000-8000-000000000002');
select private._t_eq((select count(*) from public.attendance_records), 0, 'accountants can''t see attendance');
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-05', private._t_entries('present','present','present'))$q$,
  '42501', 'accountants can''t mark attendance');
reset role;
select private._t_as('a8000000-0000-4000-8000-000000000003');
select private._t_eq((select count(*) from public.attendance_records), 0, 'admin B sees no School A attendance');
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-05', private._t_entries('present','present','present'))$q$,
  'P0002', 'admin B cannot mark School A''s section');
reset role;

-- ---------- inactive students and archived sessions ----------
update public.students set status = 'inactive' where id = 'f8000000-0000-4000-8000-000000000003';
select private._t_as('a8000000-0000-4000-8000-000000000001');
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-06', private._t_entries('present','present','present'))$q$,
  '23514', 'inactive students can''t be marked', 'Inactive');
reset role;
update public.academic_sessions set archived_at = now(), is_current = false where id = 'c8000000-0000-4000-8000-000000000001';
select private._t_as('a8000000-0000-4000-8000-000000000001');
select private._t_raises($q$select private.save_section_attendance('d8000000-0000-4000-8000-0000000000a1', '2026-07-01', private._t_entries('absent','absent','absent'))$q$,
  '23514', 'archived sessions are read-only', 'archived');
reset role;

select 'ALL ATTENDANCE TESTS PASSED' as result;
rollback;
