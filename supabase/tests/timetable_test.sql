-- =====================================================================
-- Timetable test (migrations 0001-0013). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL TIMETABLE TESTS PASSED".
-- School A: Class 1-A and Class 2-A; Meera (assigned to both) and Ravi (assigned
-- to 1-A). A parent of a Class 1-A student, a teacher from School B.
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
-- entry(section, day, period, subject, teacher, room)
create function private._t_entry(p_sec uuid, p_day int, p_period uuid, p_subject uuid, p_teacher uuid, p_room text) returns void language sql as $$
  insert into public.timetable_entries (school_id, academic_session_id, class_id, section_id, day_of_week, period_id, subject_id, teacher_id, room)
  select s.school_id, s.academic_session_id, s.class_id, s.id, p_day, p_period, p_subject, p_teacher, p_room
  from public.sections s where s.id = p_sec;
$$;
grant execute on function private._t_assert(boolean, text), private._t_eq(numeric, numeric, text), private._t_raises(text, text, text, text),
  private._t_as(uuid), private._t_entry(uuid, int, uuid, uuid, uuid, text) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a1200000-0000-4000-8000-000000000001', 'tt2-admin@example.invalid'),
  ('a1200000-0000-4000-8000-000000000002', 'tt2-meera@example.invalid'),
  ('a1200000-0000-4000-8000-000000000003', 'tt2-ravi@example.invalid'),
  ('a1200000-0000-4000-8000-000000000004', 'tt2-parent@example.invalid'),
  ('a1200000-0000-4000-8000-000000000005', 'tt2-teacher-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b1200000-0000-4000-8000-00000000000a', 'Timetable A', 'ZZTTB-A'),
  ('b1200000-0000-4000-8000-00000000000b', 'Timetable B', 'ZZTTB-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b1200000-0000-4000-8000-00000000000a', 'a1200000-0000-4000-8000-000000000001', 'school_admin'),
  ('b1200000-0000-4000-8000-00000000000a', 'a1200000-0000-4000-8000-000000000002', 'teacher'),
  ('b1200000-0000-4000-8000-00000000000a', 'a1200000-0000-4000-8000-000000000003', 'teacher'),
  ('b1200000-0000-4000-8000-00000000000a', 'a1200000-0000-4000-8000-000000000004', 'parent'),
  ('b1200000-0000-4000-8000-00000000000b', 'a1200000-0000-4000-8000-000000000005', 'teacher');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c1200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d1200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-00000000000a', 'Class 1'),
  ('d1200000-0000-4000-8000-000000000002', 'b1200000-0000-4000-8000-00000000000a', 'Class 2');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d1200000-0000-4000-8000-0000000000a1', 'b1200000-0000-4000-8000-00000000000a', 'd1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-000000000001', 'A'),
  ('d1200000-0000-4000-8000-0000000000a2', 'b1200000-0000-4000-8000-00000000000a', 'd1200000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f1200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-00000000000a', 'Kid', 'P', '2019-01-01', 'male', '9800000401');
insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('b1200000-0000-4000-8000-00000000000a', 'f1200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-0000000000a1', 'K1', '2026-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b1200000-0000-4000-8000-00000000000a', 'f1200000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000004', 'father');
insert into public.teachers (id, school_id, full_name, phone, email, joining_date, account_id) values
  ('71200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-00000000000a', 'Meera Iyer', '9811200001', 'meera@example.invalid', '2020-01-01', 'a1200000-0000-4000-8000-000000000002'),
  ('71200000-0000-4000-8000-000000000002', 'b1200000-0000-4000-8000-00000000000a', 'Ravi Kumar', '9811200002', 'ravi@example.invalid', '2020-01-01', 'a1200000-0000-4000-8000-000000000003'),
  ('71200000-0000-4000-8000-000000000003', 'b1200000-0000-4000-8000-00000000000a', 'Unassigned', '9811200003', 'un@example.invalid', '2020-01-01', null);
insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id) values
  ('b1200000-0000-4000-8000-00000000000a', '71200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-0000000000a1'),
  ('b1200000-0000-4000-8000-00000000000a', '71200000-0000-4000-8000-000000000001', 'c1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-000000000002', 'd1200000-0000-4000-8000-0000000000a2'),
  ('b1200000-0000-4000-8000-00000000000a', '71200000-0000-4000-8000-000000000002', 'c1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-000000000001', 'd1200000-0000-4000-8000-0000000000a1');

-- ================= admin builds the timetable =================
select private._t_as('a1200000-0000-4000-8000-000000000001');
insert into public.subjects (id, school_id, name, code) values
  ('a2200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-00000000000a', 'Mathematics', 'MATH'),
  ('a2200000-0000-4000-8000-000000000002', 'b1200000-0000-4000-8000-00000000000a', 'English', 'ENG'),
  ('a2200000-0000-4000-8000-000000000003', 'b1200000-0000-4000-8000-00000000000a', 'Art', null);
select private._t_raises($q$insert into public.subjects (school_id, name) values ('b1200000-0000-4000-8000-00000000000a', ' mathematics ')$q$,
  '23505', 'subject names are unique per school (ignoring case and spaces)');
select private._t_raises($q$delete from public.subjects$q$, '42501', 'subjects are deactivated, never deleted');
insert into public.timetable_periods (id, school_id, academic_session_id, period_number, label, start_time, end_time, is_break) values
  ('a3200000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-00000000000a', 'c1200000-0000-4000-8000-000000000001', 1, null, '08:00', '08:40', false),
  ('a3200000-0000-4000-8000-000000000002', 'b1200000-0000-4000-8000-00000000000a', 'c1200000-0000-4000-8000-000000000001', 2, null, '08:40', '09:20', false),
  ('a3200000-0000-4000-8000-000000000003', 'b1200000-0000-4000-8000-00000000000a', 'c1200000-0000-4000-8000-000000000001', 3, 'Lunch', '09:20', '09:50', true);
select private._t_raises($q$insert into public.timetable_periods (school_id, academic_session_id, period_number, start_time, end_time)
  values ('b1200000-0000-4000-8000-00000000000a', 'c1200000-0000-4000-8000-000000000001', 4, '09:00', '10:00')$q$,
  '23514', 'periods can''t overlap', 'overlaps period 2');
select private._t_raises($q$insert into public.timetable_periods (school_id, academic_session_id, period_number, start_time, end_time)
  values ('b1200000-0000-4000-8000-00000000000a', 'c1200000-0000-4000-8000-000000000001', 5, '11:00', '10:00')$q$,
  '23514', 'a period must end after it starts');
select private._t_raises($q$insert into public.timetable_periods (school_id, academic_session_id, period_number, start_time, end_time)
  values ('b1200000-0000-4000-8000-00000000000a', 'c1200000-0000-4000-8000-000000000001', 1, '12:00', '12:30')$q$,
  '23505', 'period numbers are unique per session');

-- Monday period 1: Meera teaches Maths to 1-A in room 101; Ravi teaches English to ... nobody yet
select private._t_entry('d1200000-0000-4000-8000-0000000000a1', 1, 'a3200000-0000-4000-8000-000000000001', 'a2200000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000001', ' r-101 ');
select private._t_assert((select room from public.timetable_entries limit 1) = 'R-101', 'rooms are trimmed and upper-cased');

-- the three conflicts
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a1', 1, 'a3200000-0000-4000-8000-000000000001',
  'a2200000-0000-4000-8000-000000000002', '71200000-0000-4000-8000-000000000002', null)$q$,
  '23505', 'a class can''t have two subjects at the same time');
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a2', 1, 'a3200000-0000-4000-8000-000000000001',
  'a2200000-0000-4000-8000-000000000002', '71200000-0000-4000-8000-000000000001', null)$q$,
  '23505', 'a teacher can''t be in two classes at the same time');
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a2', 1, 'a3200000-0000-4000-8000-000000000001',
  'a2200000-0000-4000-8000-000000000003', null, 'R-101')$q$,
  '23505', 'a room can''t be used twice at the same time');
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a2', 1, 'a3200000-0000-4000-8000-000000000001',
  'a2200000-0000-4000-8000-000000000003', null, 'r-101')$q$,
  '23505', 'room clashes ignore case');
-- same things at a DIFFERENT time are fine
select private._t_entry('d1200000-0000-4000-8000-0000000000a2', 1, 'a3200000-0000-4000-8000-000000000002', 'a2200000-0000-4000-8000-000000000002', '71200000-0000-4000-8000-000000000001', 'R-101');
select private._t_entry('d1200000-0000-4000-8000-0000000000a2', 2, 'a3200000-0000-4000-8000-000000000001', 'a2200000-0000-4000-8000-000000000003', null, null);
select private._t_entry('d1200000-0000-4000-8000-0000000000a1', 1, 'a3200000-0000-4000-8000-000000000002', 'a2200000-0000-4000-8000-000000000002', '71200000-0000-4000-8000-000000000002', 'R-102');
select private._t_eq((select count(*) from public.timetable_entries), 4, 'non-clashing slots are saved');
-- moving an entry into a clash is caught too (updates, not only inserts)
select private._t_raises($q$update public.timetable_entries set teacher_id = '71200000-0000-4000-8000-000000000001'
  where section_id = 'd1200000-0000-4000-8000-0000000000a1' and period_id = 'a3200000-0000-4000-8000-000000000002' and day_of_week = 1$q$,
  '23505', 'editing a slot into a teacher clash is refused');

-- other rules
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a1', 1, 'a3200000-0000-4000-8000-000000000003',
  'a2200000-0000-4000-8000-000000000003', null, null)$q$, '23514', 'nothing in a break', 'break');
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a2', 3, 'a3200000-0000-4000-8000-000000000001',
  'a2200000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000002', null)$q$,
  '23514', 'a teacher must be assigned to the class', 'isn''t assigned');
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a1', 8, 'a3200000-0000-4000-8000-000000000001',
  'a2200000-0000-4000-8000-000000000001', null, null)$q$, '23514', 'days are 1-7');
update public.subjects set is_active = false where id = 'a2200000-0000-4000-8000-000000000003';
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a1', 4, 'a3200000-0000-4000-8000-000000000001',
  'a2200000-0000-4000-8000-000000000003', null, null)$q$, '23514', 'inactive subjects can''t be timetabled', 'inactive');
update public.subjects set is_active = true where id = 'a2200000-0000-4000-8000-000000000003';
select private._t_raises($q$delete from public.timetable_periods where id = 'a3200000-0000-4000-8000-000000000001'$q$,
  '23514', 'a period in use can''t be deleted', 'Clear them');
select private._t_raises($q$update public.timetable_periods set end_time = '08:50' where id = 'a3200000-0000-4000-8000-000000000001'$q$,
  '23514', 'changing times can''t create an overlap', 'overlaps');
select private._t_raises($q$delete from public.teacher_assignments where teacher_id = '71200000-0000-4000-8000-000000000002'$q$,
  '23514', 'an assignment in use on the timetable can''t be removed', 'on the timetable');
reset role;

-- ================= who sees what =================
select private._t_as('a1200000-0000-4000-8000-000000000003');  -- Ravi: assigned to 1-A only
select private._t_eq((select count(*) from public.timetable_entries), 2, 'Ravi sees only Class 1-A''s timetable');
select private._t_assert(private.teacher_display_name('71200000-0000-4000-8000-000000000001') = 'Meera Iyer',
  'colleagues'' names appear on timetables');
select private._t_raises($q$select private._t_entry('d1200000-0000-4000-8000-0000000000a1', 3, 'a3200000-0000-4000-8000-000000000001',
  'a2200000-0000-4000-8000-000000000001', null, null)$q$, '42501', 'teachers can''t edit the timetable');
reset role;
select private._t_as('a1200000-0000-4000-8000-000000000002');  -- Meera: both classes
select private._t_eq((select count(*) from public.timetable_entries), 4, 'Meera sees both her classes');
reset role;
select private._t_as('a1200000-0000-4000-8000-000000000004');  -- parent of a Class 1-A student
select private._t_assert((select bool_and(section_id = 'd1200000-0000-4000-8000-0000000000a1') and count(*) = 2 from public.timetable_entries),
  'a parent sees only their child''s class timetable');
select private._t_assert(not private.can_view_section_timetable('d1200000-0000-4000-8000-0000000000a2'), 'not another class');
select private._t_eq((select count(*) from public.subjects), 3, 'the subject list is school-wide');
reset role;
select private._t_as('a1200000-0000-4000-8000-000000000005');  -- teacher of School B
select private._t_eq((select count(*) from public.timetable_entries) + (select count(*) from public.subjects)
  + (select count(*) from public.timetable_periods), 0, 'another school sees nothing');
select private._t_assert(private.teacher_display_name('71200000-0000-4000-8000-000000000001') is null, 'nor School A''s staff names');
reset role;

-- archived sessions are read-only
update public.academic_sessions set archived_at = now(), is_current = false where id = 'c1200000-0000-4000-8000-000000000001';
select private._t_as('a1200000-0000-4000-8000-000000000001');
select private._t_raises($q$delete from public.timetable_entries$q$, '23514', 'archived timetables are read-only', 'archived');
reset role;

select 'ALL TIMETABLE TESTS PASSED' as result;
rollback;
