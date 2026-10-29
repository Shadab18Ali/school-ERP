-- =====================================================================
-- Analytics test (migrations 0001-0028). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL ANALYTICS TESTS PASSED".
--
-- A small school whose every figure is worked out by hand below. Dates are relative to
-- today: the current session runs from the first of the month five months ago (M0) for a
-- year, so M5 is this month. Class 1 (sections A no capacity set, B cap 3), Class 2 (A cap 2).
--   S1  boy    last session Class 1, this session 2-A          (continuing)
--   S2  girl   new, 1-A, admitted M0+9 (online application A1)
--   S3  girl   new, 1-A, admitted 20 days before the session starts
--   S4  boy    new, 1-B, admitted M2+4, has since LEFT (inactive)
--   S5  boy    last session only
-- =====================================================================
begin;

create function private._a_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._a_eq(got anyelement, want anyelement, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._a_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- month n of the current session (M0 = five months ago)
create function private._a_m(n integer) returns date language sql stable as $$
  select (date_trunc('month', private.ist_today()) - interval '5 months' + n * interval '1 month')::date;
$$;
-- a jsonb array element whose key equals a value
create function private._a_row(arr jsonb, k text, v text) returns jsonb language sql immutable as $$
  select x from jsonb_array_elements(arr) x where x ->> k = v limit 1;
$$;
-- the statement must be refused with "Not allowed." (42501)
create function private._a_refused(q text, msg text) returns void language plpgsql as $$
begin
  begin execute q; exception when insufficient_privilege then return; end;
  raise exception 'FAIL: % (was allowed)', msg using errcode = 'ZT001';
end $$;
grant execute on function private._a_refused(text, text) to authenticated;
grant execute on function private._a_assert(boolean, text), private._a_eq(anyelement, anyelement, text), private._a_as(uuid), private._a_m(integer),
  private._a_row(jsonb, text, text) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a3000000-0000-4000-8000-000000000001', 'an-admin@example.invalid'),
  ('a3000000-0000-4000-8000-000000000002', 'an-admin-b@example.invalid'),
  ('a3000000-0000-4000-8000-000000000003', 'an-teacher@example.invalid'),
  ('a3000000-0000-4000-8000-000000000004', 'an-accountant@example.invalid');
insert into public.schools (id, name, code) values
  ('b3000000-0000-4000-8000-00000000000a', 'Analytics School', 'ZZAN-A'),
  ('b3000000-0000-4000-8000-00000000000b', 'Other School', 'ZZAN-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b3000000-0000-4000-8000-00000000000a', 'a3000000-0000-4000-8000-000000000001', 'school_admin'),
  ('b3000000-0000-4000-8000-00000000000b', 'a3000000-0000-4000-8000-000000000002', 'school_admin'),
  ('b3000000-0000-4000-8000-00000000000a', 'a3000000-0000-4000-8000-000000000003', 'teacher'),
  ('b3000000-0000-4000-8000-00000000000a', 'a3000000-0000-4000-8000-000000000004', 'accountant');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'Last year', private._a_m(-12), private._a_m(0) - 1, false),
  ('c3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'This year', private._a_m(0), private._a_m(12) - 1, true);
insert into public.classes (id, school_id, name, display_order) values
  ('d3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'Class 1', 1),
  ('d3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'Class 2', 2);
insert into public.sections (id, school_id, class_id, academic_session_id, name, capacity) values
  ('d3000000-0000-4000-8000-0000000000a0', 'b3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'A', null),
  ('d3000000-0000-4000-8000-0000000000a1', 'b3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'A', null),
  ('d3000000-0000-4000-8000-0000000000b1', 'b3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'B', 3),
  ('d3000000-0000-4000-8000-0000000000a2', 'b3000000-0000-4000-8000-00000000000a', 'd3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'A', 2);
insert into public.students (id, school_id, student_code, full_name, father_name, date_of_birth, gender, mobile, status) values
  ('f3000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'AN1', 'Student One', 'Parent', '2016-01-01', 'male', '9000000001', 'active'),
  ('f3000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'AN2', 'Student Two', 'Parent', '2017-01-01', 'female', '9000000002', 'active'),
  ('f3000000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-00000000000a', 'AN3', 'Student Three', 'Parent', '2017-01-01', 'female', '9000000003', 'active'),
  ('f3000000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-00000000000a', 'AN4', 'Student Four', 'Parent', '2017-01-01', 'male', '9000000004', 'active'),
  ('f3000000-0000-4000-8000-000000000005', 'b3000000-0000-4000-8000-00000000000a', 'AN5', 'Student Five', 'Parent', '2016-01-01', 'male', '9000000005', 'active');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('e3000000-0000-4000-8000-000000000011', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a0', 'P1', private._a_m(-12) + 3),
  ('e3000000-0000-4000-8000-000000000015', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000005', 'c3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a0', 'P5', private._a_m(-12) + 3),
  ('e3000000-0000-4000-8000-000000000021', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-0000000000a2', 'N1', private._a_m(0)),
  ('e3000000-0000-4000-8000-000000000022', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', 'N2', private._a_m(0) + 9),
  ('e3000000-0000-4000-8000-000000000023', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000003', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', 'N3', private._a_m(0) - 20),
  ('e3000000-0000-4000-8000-000000000024', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000004', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000b1', 'N4', private._a_m(2) + 4);
-- attendance: M1 days 2-3, M2 days 2-3 (S4 once, before leaving)
insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status)
select 'b3000000-0000-4000-8000-00000000000a', s, e, 'c3000000-0000-4000-8000-000000000002', c, sec, d, st::public.attendance_status from (values
  ('f3000000-0000-4000-8000-000000000001'::uuid, 'e3000000-0000-4000-8000-000000000021'::uuid, 'd3000000-0000-4000-8000-000000000002'::uuid, 'd3000000-0000-4000-8000-0000000000a2'::uuid, private._a_m(1) + 1, 'present'),
  ('f3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000021', 'd3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-0000000000a2', private._a_m(1) + 2, 'present'),
  ('f3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000021', 'd3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-0000000000a2', private._a_m(2) + 1, 'absent'),
  ('f3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000021', 'd3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-0000000000a2', private._a_m(2) + 2, 'present'),
  ('f3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', private._a_m(1) + 1, 'present'),
  ('f3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', private._a_m(1) + 2, 'present'),
  ('f3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', private._a_m(2) + 1, 'present'),
  ('f3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', private._a_m(2) + 2, 'present'),
  ('f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', private._a_m(1) + 1, 'absent'),
  ('f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', private._a_m(1) + 2, 'leave'),
  ('f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', private._a_m(2) + 1, 'present'),
  ('f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000a1', private._a_m(2) + 2, 'absent'),
  ('f3000000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-000000000024', 'd3000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-0000000000b1', private._a_m(2) + 5, 'present')
) v(s, e, c, sec, d, st);
update public.students set status = 'inactive', status_reason = 'Moved away' where id = 'f3000000-0000-4000-8000-000000000004';

-- exams: Unit 1 (Class 1 Maths 50/20, English 50/20; Class 2 Maths 100/40), Half yearly (Class 1 Maths 100/33)
insert into public.grade_bands (school_id, grade, min_percentage) values
  ('b3000000-0000-4000-8000-00000000000a', 'A', 80), ('b3000000-0000-4000-8000-00000000000a', 'B', 50), ('b3000000-0000-4000-8000-00000000000a', 'C', 0);
insert into public.subjects (id, school_id, name) values
  ('a3100000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'Mathematics'),
  ('a3100000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'English');
insert into public.exam_types (id, school_id, name) values ('a3200000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'Term');
insert into public.exams (id, school_id, academic_session_id, exam_type_id, name) values
  ('a3300000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'a3200000-0000-4000-8000-000000000001', 'Unit 1'),
  ('a3300000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'a3200000-0000-4000-8000-000000000001', 'Half yearly');
insert into public.exam_papers (id, school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks) values
  ('a3400000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'a3300000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'a3100000-0000-4000-8000-000000000001', private._a_m(1) + 10, '09:00', '10:00', 50, 20),
  ('a3400000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'a3300000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'a3100000-0000-4000-8000-000000000002', private._a_m(1) + 11, '09:00', '10:00', 50, 20),
  ('a3400000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-00000000000a', 'a3300000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', 'a3100000-0000-4000-8000-000000000001', private._a_m(1) + 10, '09:00', '10:00', 100, 40),
  ('a3400000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-00000000000a', 'a3300000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'a3100000-0000-4000-8000-000000000001', private._a_m(3) + 10, '09:00', '12:00', 100, 33);
insert into public.exam_marks (school_id, paper_id, student_id, enrollment_id, section_id, marks, is_absent) values
  ('b3000000-0000-4000-8000-00000000000a', 'a3400000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-0000000000a1', 45, false),
  ('b3000000-0000-4000-8000-00000000000a', 'a3400000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-0000000000a1', 40, false),
  ('b3000000-0000-4000-8000-00000000000a', 'a3400000-0000-4000-8000-000000000001', 'f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'd3000000-0000-4000-8000-0000000000a1', 15, false),
  ('b3000000-0000-4000-8000-00000000000a', 'a3400000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'd3000000-0000-4000-8000-0000000000a1', 30, false),
  ('b3000000-0000-4000-8000-00000000000a', 'a3400000-0000-4000-8000-000000000003', 'f3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000021', 'd3000000-0000-4000-8000-0000000000a2', null, true),
  ('b3000000-0000-4000-8000-00000000000a', 'a3400000-0000-4000-8000-000000000004', 'f3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'd3000000-0000-4000-8000-0000000000a1', 70, false);

-- fees: tuition 1000/month (Class 1), 2000/month (Class 2); dues as listed, payments P1-P4, last session's receipts
insert into public.fee_heads (id, school_id, name) values ('a3500000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'Tuition');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values
  ('a3600000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001'),
  ('a3600000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002');
insert into public.fee_structure_items (id, school_id, fee_structure_id, fee_head_id, amount, frequency) values
  ('a3700000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'a3600000-0000-4000-8000-000000000001', 'a3500000-0000-4000-8000-000000000001', 1000, 'monthly'),
  ('a3700000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'a3600000-0000-4000-8000-000000000002', 'a3500000-0000-4000-8000-000000000001', 2000, 'monthly');
insert into public.student_fee_dues (id, school_id, enrollment_id, student_id, fee_item_id, fee_head_id, due_month, amount)
select v.id, 'b3000000-0000-4000-8000-00000000000a', v.e, v.s, v.item, 'a3500000-0000-4000-8000-000000000001', private._a_m(v.m), v.amt from (values
  ('a3800000-0000-4000-8000-000000000001'::uuid, 'e3000000-0000-4000-8000-000000000022'::uuid, 'f3000000-0000-4000-8000-000000000002'::uuid, 'a3700000-0000-4000-8000-000000000001'::uuid, 0, 1000),
  ('a3800000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'f3000000-0000-4000-8000-000000000002', 'a3700000-0000-4000-8000-000000000001', 1, 1000),
  ('a3800000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000022', 'f3000000-0000-4000-8000-000000000002', 'a3700000-0000-4000-8000-000000000001', 2, 1000),
  ('a3800000-0000-4000-8000-000000000004', 'e3000000-0000-4000-8000-000000000022', 'f3000000-0000-4000-8000-000000000002', 'a3700000-0000-4000-8000-000000000001', 6, 1000),
  ('a3800000-0000-4000-8000-000000000005', 'e3000000-0000-4000-8000-000000000023', 'f3000000-0000-4000-8000-000000000003', 'a3700000-0000-4000-8000-000000000001', 0, 1000),
  ('a3800000-0000-4000-8000-000000000006', 'e3000000-0000-4000-8000-000000000023', 'f3000000-0000-4000-8000-000000000003', 'a3700000-0000-4000-8000-000000000001', 1, 1000),
  ('a3800000-0000-4000-8000-000000000007', 'e3000000-0000-4000-8000-000000000021', 'f3000000-0000-4000-8000-000000000001', 'a3700000-0000-4000-8000-000000000002', 0, 2000),
  ('a3800000-0000-4000-8000-000000000008', 'e3000000-0000-4000-8000-000000000021', 'f3000000-0000-4000-8000-000000000001', 'a3700000-0000-4000-8000-000000000002', 1, 2000)
) v(id, e, s, item, m, amt);
insert into public.fee_payments (id, school_id, student_id, enrollment_id, academic_session_id, receipt_number, payment_date, amount, payment_mode, reference_number, balance_after, idempotency_key) values
  ('a3900000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000022', 'c3000000-0000-4000-8000-000000000002', 'AN-1', private._a_m(0) + 4, 2000, 'cash', null, 2000, gen_random_uuid()),
  ('a3900000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000001', 'e3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000002', 'AN-2', private._a_m(1) + 2, 2000, 'upi', 'REF-1', 2000, gen_random_uuid()),
  ('a3900000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'c3000000-0000-4000-8000-000000000002', 'AN-3', private._a_m(2), 500, 'online', 'REF-1', 1500, gen_random_uuid()),
  ('a3900000-0000-4000-8000-000000000004', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'c3000000-0000-4000-8000-000000000002', 'AN-4', private._a_m(2) + 1, 1000, 'cash', null, 500, gen_random_uuid()),
  ('a3900000-0000-4000-8000-000000000005', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000005', 'e3000000-0000-4000-8000-000000000015', 'c3000000-0000-4000-8000-000000000001', 'AN-5', private._a_m(-12) + 4, 3000, 'cash', null, 0, gen_random_uuid()),
  ('a3900000-0000-4000-8000-000000000006', 'b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000005', 'e3000000-0000-4000-8000-000000000015', 'c3000000-0000-4000-8000-000000000001', 'AN-6', private._a_m(-11) + 4, 1500, 'cash', null, 0, gen_random_uuid());
insert into public.fee_payment_allocations (school_id, payment_id, due_id, amount) values
  ('b3000000-0000-4000-8000-00000000000a', 'a3900000-0000-4000-8000-000000000001', 'a3800000-0000-4000-8000-000000000001', 1000),
  ('b3000000-0000-4000-8000-00000000000a', 'a3900000-0000-4000-8000-000000000001', 'a3800000-0000-4000-8000-000000000002', 1000),
  ('b3000000-0000-4000-8000-00000000000a', 'a3900000-0000-4000-8000-000000000002', 'a3800000-0000-4000-8000-000000000007', 2000),
  ('b3000000-0000-4000-8000-00000000000a', 'a3900000-0000-4000-8000-000000000003', 'a3800000-0000-4000-8000-000000000005', 500);
insert into public.online_payments (school_id, student_id, enrollment_id, academic_session_id, amount, allocations, description, status, method, fee_payment_id, paid_at)
values ('b3000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-000000000003', 'e3000000-0000-4000-8000-000000000023', 'c3000000-0000-4000-8000-000000000002',
        500, '[]', 'Tuition', 'paid', 'card', 'a3900000-0000-4000-8000-000000000003', now());
update public.fee_payments set cancelled_at = now(), cancel_reason = 'Refunded online: test' where id = 'a3900000-0000-4000-8000-000000000004';

-- admissions: applications A1 (enrolled -> S2), A2 (rejected), A3 (verified); enquiries E1-E4
insert into public.admission_applications (id, school_id, academic_session_id, class_id, application_number, status, student_name, date_of_birth, gender,
  contact_phone, address_line, city, state, postal_code, submitted_at, verified_at, student_id) values
  ('a3a00000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'APP-1', 'enrolled',
   'Student Two', '2017-01-01', 'female', '9000000002', '1 Road', 'Lucknow', 'UP', '226001', ((private._a_m(0) - 20) + time '10:00') at time zone 'Asia/Kolkata', now(), 'f3000000-0000-4000-8000-000000000002'),
  ('a3a00000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000002', 'APP-2', 'rejected',
   'Kid Two', '2016-01-01', 'male', '9000000012', '1 Road', 'Lucknow', 'UP', '226001', (private._a_m(0) + time '02:00') at time zone 'Asia/Kolkata', null, null),
  ('a3a00000-0000-4000-8000-000000000003', 'b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001', 'APP-3', 'verified',
   'Kid Three', '2017-01-01', 'male', '9000000013', '1 Road', 'Lucknow', 'UP', '226001', ((private._a_m(1) + 4) + time '23:30') at time zone 'Asia/Kolkata', now(), null);
-- a follow-up that has since become overdue (its date can't be set in the past, so time is simulated)
alter table public.admission_enquiries disable trigger admission_enquiries_guard;
insert into public.admission_enquiries (school_id, academic_session_id, enquiry_number, enquiry_date, parent_name, student_name, phone, class_id, source, status, follow_up_date, application_id) values
  ('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'ENQ-1', private._a_m(-1) + 3, 'Parent One', 'Student Two', '9000000002', 'd3000000-0000-4000-8000-000000000001', 'website', 'admitted', null, null),
  ('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'ENQ-2', private._a_m(0) + 2, 'Parent Two', 'Kid Four', '9000000022', 'd3000000-0000-4000-8000-000000000001', 'website', 'contacted', private.ist_today() - 1, null),
  ('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'ENQ-3', private._a_m(1) + 1, 'Parent Three', 'Kid Five', '9000000023', 'd3000000-0000-4000-8000-000000000002', 'walk_in', 'application', private.ist_today() + 5, null),
  ('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', 'ENQ-4', private._a_m(1) + 2, 'Parent Four', 'Kid Six', '9000000024', 'd3000000-0000-4000-8000-000000000002', 'walk_in', 'rejected', null, null);
alter table public.admission_enquiries enable trigger admission_enquiries_guard;
update public.admission_enquiries set application_id = 'a3a00000-0000-4000-8000-000000000001' where enquiry_number = 'ENQ-1';   -- linked afterwards, as the app does

-- the same analyses, as the school's admin
create temp table r (k text primary key, v jsonb) on commit drop;
grant all on r to authenticated;
create function private._a(k text) returns jsonb language sql stable as $$ select v from r where r.k = $1 $$;
grant execute on function private._a(text) to authenticated;
select private._a_as('a3000000-0000-4000-8000-000000000001');
insert into r values
  ('st', private.analytics_students('b3000000-0000-4000-8000-00000000000a', null, null, null, null, null)),
  ('st_c1', private.analytics_students('b3000000-0000-4000-8000-00000000000a', null, 'd3000000-0000-4000-8000-000000000001', null, null, null)),
  ('st_m2', private.analytics_students('b3000000-0000-4000-8000-00000000000a', null, null, private._a_m(2), null, 'a3300000-0000-4000-8000-000000000001')),
  ('fe', private.analytics_fees('b3000000-0000-4000-8000-00000000000a', null, null, null, null)),
  ('fe_c2', private.analytics_fees('b3000000-0000-4000-8000-00000000000a', null, 'd3000000-0000-4000-8000-000000000002', null, null)),
  ('fe_m2', private.analytics_fees('b3000000-0000-4000-8000-00000000000a', null, null, private._a_m(2), null)),
  ('ad', private.analytics_admissions('b3000000-0000-4000-8000-00000000000a', null, null, null, null)),
  ('ad_c2', private.analytics_admissions('b3000000-0000-4000-8000-00000000000a', null, 'd3000000-0000-4000-8000-000000000002', null, null));

-- ================= students: enrollment =================
select private._a_eq(private._a('st') #>> '{session,name}', 'This year', 'defaults to the current session');
select private._a_eq(private._a('st') -> 'enrollment' -> 'kpis',
  '{"students": 3, "enrolled_all": 4, "left": 1, "new_students": 3, "boys": 1, "girls": 2, "other": 0}'::jsonb,
  'active 3 (S1-S3); 4 enrolled incl. S4 who left; new: S2, S3, S4');
select private._a_eq(private._a('st') #> '{enrollment,trend}',
  jsonb_build_array(
    jsonb_build_object('session_id', 'c3000000-0000-4000-8000-000000000001', 'session', 'Last year', 'current', false, 'enrolled', 2, 'new_students', 2, 'continuing', 0),
    jsonb_build_object('session_id', 'c3000000-0000-4000-8000-000000000002', 'session', 'This year', 'current', true, 'enrolled', 4, 'new_students', 3, 'continuing', 1)),
  'enrollment trend per session: new vs continuing');
select private._a_eq((select jsonb_agg(x -> 'new_students') from jsonb_array_elements(private._a('st') #> '{enrollment,admissions_by_month}') x),
  '[2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]'::jsonb, 'new students by month: S2 and S3 (before the start) in M0, S4 in M2');
select private._a_eq(private._a('st_c1') #> '{enrollment,kpis,new_students}', '3'::jsonb, 'class filter: Class 1 got three new students');
select private._a_eq(private._a('st_c1') #> '{enrollment,trend,0,enrolled}', '2'::jsonb, 'class filter applies to earlier sessions too');

-- ================= students: class strength =================
select private._a_eq((private._a('st') -> 'strength') - 'classes',
  '{"sections": 3, "average_section": 1.0, "capacity": 5, "fill_percent": 20.0}'::jsonb,
  '3 active students in 3 sections; of the 5 seats in sections with a capacity (1-B, 2-A) only S1''s is taken');
select private._a_eq(private._a_row(private._a('st') #> '{strength,classes}', 'class', 'Class 1') - 'detail' - 'class_id',
  '{"class": "Class 1", "students": 2, "boys": 0, "girls": 2, "other": 0, "sections": 2, "capacity": 3, "fill_percent": 0.0}'::jsonb,
  'Class 1: S2, S3 in A (no capacity set, so not in the fill rate); S4 has left, so B (3 seats) is empty');
select private._a_eq((private._a_row(private._a('st') #> '{strength,classes}', 'class', 'Class 1') -> 'detail') @> '[{"section": "A", "students": 2, "capacity": null}, {"section": "B", "students": 0, "capacity": 3}]', true,
  'every section is listed, with or without a capacity or students');

-- ================= students: attendance =================
select private._a_eq((private._a('st') -> 'attendance') - 'monthly' - 'daily' - 'by_class' - 'bands' - 'from' - 'to',
  '{"days_marked": 5, "present": 9, "absent": 3, "leave": 1, "percent": 69.2, "students_counted": 3}'::jsonb,
  '9 present of 13 marked (leave counts as not present), on 5 days');
select private._a_eq((select jsonb_agg(x -> 'percent') from jsonb_array_elements(private._a('st') #> '{attendance,monthly}') x where x ->> 'percent' is not null),
  '[66.7, 71.4]'::jsonb, 'monthly: M1 4 of 6, M2 5 of 7 (S4''s one day counts while enrolled)');
select private._a_eq(private._a_row(private._a('st') #> '{attendance,by_class}', 'class', 'Class 2') -> 'percent', '75.0'::jsonb, 'Class 2 (S1): 3 of 4');
select private._a_eq(private._a_row(private._a('st') #> '{attendance,by_class}', 'class', 'Class 1') -> 'percent', '66.7'::jsonb, 'Class 1: 6 of 9');
select private._a_eq((select jsonb_agg(x -> 'students') from jsonb_array_elements(private._a('st') #> '{attendance,bands}') x), '[1, 1, 1]'::jsonb,
  'one student each: S2 100% / S1 75% / S3 25% (S4 has left and is not counted)');
select private._a_eq(private._a('st_m2') #> '{attendance,percent}', '71.4'::jsonb, 'from M2: 5 present of 7');
select private._a_eq(private._a('st_m2') #> '{attendance,days_marked}', '3'::jsonb, 'from M2: three days');

-- ================= students: performance =================
select private._a_eq(private._a('st') #>> '{performance,exam_name}', 'Half yearly', 'by default, the latest exam with marks');
select private._a_eq((private._a('st') -> 'performance') - 'exams' - 'by_class' - 'by_subject' - 'grades' - 'trend' - 'exam_id' - 'exam_name',
  '{"students": 2, "complete": 1, "incomplete": 1, "average_percent": 70.0, "passed": 1, "failed": 0, "pass_rate": 100.0}'::jsonb,
  'Half yearly: S2 70% (pass); S3 has no mark yet, so incomplete and not averaged');
select private._a_eq((private._a('st_m2') -> 'performance') - 'exams' - 'by_class' - 'by_subject' - 'grades' - 'trend' - 'exam_id' - 'exam_name',
  '{"students": 3, "complete": 3, "incomplete": 0, "average_percent": 43.3, "passed": 1, "failed": 2, "pass_rate": 33.3}'::jsonb,
  'Unit 1: S2 85% pass, S3 45% fail (Maths 15 < 20), S1 absent = 0% fail; S4 has left');
select private._a_eq(private._a_row(private._a('st_m2') #> '{performance,by_class}', 'class', 'Class 1') - 'class_id',
  '{"class": "Class 1", "students": 2, "average_percent": 65.0, "pass_rate": 50.0}'::jsonb, 'Unit 1, Class 1');
select private._a_eq(private._a_row(private._a('st_m2') #> '{performance,by_subject}', 'subject', 'Mathematics') - 'subject_id',
  '{"subject": "Mathematics", "average_percent": 60.0, "pass_rate": 33.3, "sat": 2, "absent": 1}'::jsonb,
  'Maths: 60 of 100 marks among those who sat; 1 of 3 passed (absent fails)');
select private._a_eq(private._a_row(private._a('st_m2') #> '{performance,by_subject}', 'subject', 'English') - 'subject_id',
  '{"subject": "English", "average_percent": 70.0, "pass_rate": 100.0, "sat": 2, "absent": 0}'::jsonb, 'English');
select private._a_eq((select jsonb_object_agg(x ->> 'grade', x -> 'students') from jsonb_array_elements(private._a('st_m2') #> '{performance,grades}') x),
  '{"A": 1, "B": 0, "C": 2}'::jsonb, 'grades from the school''s bands, empty ones included');
select private._a_eq((select jsonb_agg(jsonb_build_array(x -> 'exam', x -> 'average_percent', x -> 'pass_rate')) from jsonb_array_elements(private._a('st') #> '{performance,trend}') x),
  '[["Unit 1", 43.3, 33.3], ["Half yearly", 70.0, 100.0]]'::jsonb, 'exam-to-exam trend, in date order');

-- ================= fees =================
select private._a_eq(private._a('fe') -> 'kpis',
  '{"collected": 4500, "receipts": 3, "cancelled": 1000, "cancelled_receipts": 1, "billed": 10000, "due_to_date": 9000, "paid_to_date": 4500,
    "collection_rate": 50.0, "outstanding": 5500, "overdue": 4500, "students_with_dues": 3}'::jsonb,
  'collected P1+P2+P3 (P4 was refunded); 9000 due so far, half paid; 1000 not yet due');
select private._a_eq((select jsonb_agg(jsonb_build_array(x -> 'collected', x -> 'previous')) from jsonb_array_elements(private._a('fe') -> 'monthly') x
  where (x ->> 'month')::date <= private._a_m(2)), '[[2000, 3000], [2000, 1500], [500, 0]]'::jsonb, 'monthly collection, beside the same month last session');
select private._a_eq(jsonb_array_length(private._a('fe') -> 'monthly'), 12, 'every month of the session is listed');
select private._a_eq(private._a_row(private._a('fe') -> 'by_class', 'class', 'Class 1') - 'class_id',
  '{"class": "Class 1", "collected": 2500, "billed": 6000, "due_to_date": 5000, "outstanding": 3500, "overdue": 2500, "collection_rate": 50.0}'::jsonb, 'Class 1');
select private._a_eq(private._a_row(private._a('fe') -> 'by_class', 'class', 'Class 2') - 'class_id',
  '{"class": "Class 2", "collected": 2000, "billed": 4000, "due_to_date": 4000, "outstanding": 2000, "overdue": 2000, "collection_rate": 50.0}'::jsonb, 'Class 2');
select private._a_eq((select jsonb_object_agg(x ->> 'method', jsonb_build_array(x -> 'amount', x -> 'receipts')) from jsonb_array_elements(private._a('fe') -> 'by_method') x),
  '{"cash": [2000, 1], "upi": [2000, 1], "online": [500, 1]}'::jsonb, 'by payment method (the refunded cash receipt is not counted)');
select private._a_eq(private._a('fe') -> 'online_methods', '[{"method": "card", "amount": 500, "receipts": 1}]'::jsonb, 'online payments by gateway method');
select private._a_eq((select jsonb_object_agg(x ->> 'bucket', x -> 'amount') from jsonb_array_elements(private._a('fe') -> 'aging') x),
  '{"Due this month": 0, "1 month late": 0, "2 months late": 0, "3+ months late": 4500, "Not yet due": 1000}'::jsonb, 'unpaid dues by lateness');
select private._a_eq((select jsonb_agg(x -> 'outstanding') from jsonb_array_elements(private._a('fe') -> 'outstanding_trend') x),
  '[3000, 4000, 4500, 4500, 4500, 4500]'::jsonb, 'outstanding at each month end up to now (receipts counted from their date)');
select private._a_eq(private._a('fe_c2') #> '{kpis,collected}', '2000'::jsonb, 'class filter: Class 2 collected');
select private._a_eq(private._a('fe_c2') #> '{kpis,billed}', '4000'::jsonb, 'class filter: Class 2 billed');
select private._a_eq(private._a('fe_m2') #> '{kpis,collected}', '500'::jsonb, 'date window from M2: only P3');
select private._a_eq(private._a('fe_m2') #> '{kpis,cancelled}', '1000'::jsonb, 'date window from M2: the refunded P4');

-- ================= admissions =================
select private._a_eq(private._a('ad') -> 'kpis',
  '{"enquiries": 4, "enquiries_to_application": 2, "enquiries_admitted": 1, "enquiries_open": 2, "follow_ups_overdue": 1,
    "applications": 3, "applications_pending": 1, "applications_approved": 1, "applications_rejected": 1, "applications_enrolled": 1,
    "admissions": 3, "admissions_online": 1, "admissions_direct": 2, "enquiry_conversion": 25.0, "application_conversion": 33.3}'::jsonb,
  'enquiries, applications, conversion and admissions');
select private._a_eq((select jsonb_agg(x -> 'count') from jsonb_array_elements(private._a('ad') -> 'enquiry_funnel') x), '[4, 2, 1, 1]'::jsonb, 'enquiry funnel');
select private._a_eq((select jsonb_agg(x -> 'count') from jsonb_array_elements(private._a('ad') -> 'application_funnel') x), '[3, 2, 1, 1]'::jsonb, 'application funnel');
select private._a_eq((select jsonb_object_agg(x ->> 'source', jsonb_build_array(x -> 'enquiries', x -> 'admitted', x -> 'conversion')) from jsonb_array_elements(private._a('ad') -> 'by_source') x),
  '{"website": [2, 1, 50.0], "walk_in": [2, 0, 0.0]}'::jsonb, 'conversion by source');
select private._a_eq((select jsonb_agg(jsonb_build_array(x -> 'enquiries', x -> 'applications', x -> 'admissions')) from jsonb_array_elements(private._a('ad') -> 'monthly') x),
  '[[1, 1, 1], [1, 1, 1], [2, 1, 0], [0, 0, 1]]'::jsonb, 'by month, starting with the season before the session (A2, sent at 2 am on the 1st, counts in its Indian month)');
select private._a_eq(private._a_row(private._a('ad') -> 'by_class', 'class', 'Class 1') - 'class_id',
  '{"class": "Class 1", "enquiries": 2, "applications": 2, "admissions": 3}'::jsonb, 'by class');
select private._a_eq(private._a('ad_c2') -> 'kpis' -> 'enquiries', '2'::jsonb, 'class filter on enquiries');
select private._a_eq(private._a('ad_c2') -> 'kpis' -> 'admissions', '0'::jsonb, 'class filter on admissions');

-- ================= isolation =================
-- Analytics read the whole school at once, so they check the caller's role in the school
-- first: school admins see everything; accountants see fees and admissions; nobody else.
select private._a_as('a3000000-0000-4000-8000-000000000002');   -- admin of another school
select private._a_refused($q$select private.analytics_students('b3000000-0000-4000-8000-00000000000a', null, null, null, null, null)$q$,
  'another school''s admin: students');
select private._a_refused($q$select private.analytics_fees('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002', null, null, null)$q$,
  'another school''s admin: fees, even naming the session');
select private._a_refused($q$select private.analytics_admissions('b3000000-0000-4000-8000-00000000000a', null, null, null, null)$q$,
  'another school''s admin: admissions');
select private._a_assert(private.analytics_fees('b3000000-0000-4000-8000-00000000000b', null, null, null, null) is null,
  'their own school is allowed (it has no session yet, so there is nothing to show)');

select private._a_as('a3000000-0000-4000-8000-000000000003');   -- a teacher of the school
select private._a_refused($q$select private.analytics_students('b3000000-0000-4000-8000-00000000000a', null, null, null, null, null)$q$, 'teacher: students');
select private._a_refused($q$select private.analytics_fees('b3000000-0000-4000-8000-00000000000a', null, null, null, null)$q$, 'teacher: fees');
select private._a_refused($q$select private.analytics_admissions('b3000000-0000-4000-8000-00000000000a', null, null, null, null)$q$, 'teacher: admissions');

select private._a_as('a3000000-0000-4000-8000-000000000004');   -- the school's accountant
select private._a_refused($q$select private.analytics_students('b3000000-0000-4000-8000-00000000000a', null, null, null, null, null)$q$, 'accountant: students');
select private._a_eq(private.analytics_fees('b3000000-0000-4000-8000-00000000000a', null, null, null, null), private._a('fe'),
  'accountant sees the same fee figures as the admin');
select private._a_eq(private.analytics_admissions('b3000000-0000-4000-8000-00000000000a', null, null, null, null), private._a('ad'),
  'and the same admission figures');

select private._a_as('a3000000-0000-4000-8000-000000000099');   -- signed in, no membership
select private._a_refused($q$select private.analytics_fees('b3000000-0000-4000-8000-00000000000a', null, null, null, null)$q$, 'stranger: fees');

-- the helpers are not callable directly
select private._a_refused($q$select private.analytics_window('b3000000-0000-4000-8000-00000000000a', null, null, null)$q$, 'window helper');
select private._a_refused($q$select private.analytics_access('b3000000-0000-4000-8000-00000000000a', 'fees')$q$, 'access helper');
select private._a_refused($q$select * from private.analytics_first_enrollments('b3000000-0000-4000-8000-00000000000a')$q$, 'enrollments helper');
-- ---------- bringing dues up to date before the fee figures (private.analytics_sync_dues)
reset role;
create temp table gone on commit drop as
  select d.enrollment_id, d.fee_item_id, d.due_month from public.student_fee_dues d
  join public.student_enrollments e on e.id = d.enrollment_id
  where d.school_id = 'b3000000-0000-4000-8000-00000000000a' and e.academic_session_id = 'c3000000-0000-4000-8000-000000000002'
    and not exists (select 1 from public.fee_payment_allocations a where a.due_id = d.id)
  order by d.due_month desc limit 1;
grant select on gone to authenticated;
delete from public.student_fee_dues d using gone g
  where d.enrollment_id = g.enrollment_id and d.fee_item_id = g.fee_item_id and d.due_month = g.due_month;   -- a due gone stale
select private._a_as('a3000000-0000-4000-8000-000000000003');
select private._a_refused($q$select private.analytics_sync_dues('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002')$q$, 'teacher: sync dues');
select private._a_as('a3000000-0000-4000-8000-000000000002');
select private._a_refused($q$select private.analytics_sync_dues('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002')$q$, 'another school''s admin: sync dues');
select private._a_as('a3000000-0000-4000-8000-000000000004');
select private.analytics_sync_dues('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002');
reset role;
select private._a_assert(exists (select 1 from public.student_fee_dues d join gone g using (enrollment_id, fee_item_id, due_month)),
  'the accountant''s sync put the missing due back, as the fee structure says');

-- ---------- the fee office's school-wide dues sync (private.sync_school_dues: dashboard, reports, fee list)
reset role;
delete from public.student_fee_dues d using gone g
  where d.enrollment_id = g.enrollment_id and d.fee_item_id = g.fee_item_id and d.due_month = g.due_month;
create function private._a_sync_school(school uuid) returns void language sql as $$
  select private.sync_school_dues(school, (select array_agg(enrollment_id) from gone)) $$;
grant execute on function private._a_sync_school(uuid) to authenticated;
create function private._a_due_back() returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from public.student_fee_dues d join pg_temp.gone g using (enrollment_id, fee_item_id, due_month)) $$;
grant execute on function private._a_due_back() to authenticated;
select private._a_as('a3000000-0000-4000-8000-000000000003');   -- teacher: allowed to call, changes nothing
select private._a_sync_school('b3000000-0000-4000-8000-00000000000a');
select private._a_assert(not private._a_due_back(), 'a teacher''s sync changes no dues');
select private._a_as('a3000000-0000-4000-8000-000000000002');   -- school B's admin
select private._a_sync_school('b3000000-0000-4000-8000-00000000000a');
select private._a_sync_school('b3000000-0000-4000-8000-00000000000b');   -- school A's enrollments under their own school
select private._a_assert(not private._a_due_back(), 'another school''s admin can''t touch this school''s dues, under either school');
select private._a_as('a3000000-0000-4000-8000-000000000004');   -- the accountant
select private._a_sync_school('b3000000-0000-4000-8000-00000000000a');
select private._a_assert(private._a_due_back(), 'the accountant''s school-wide sync puts the due back');

reset role;
set local role anon;
do $$ begin
  begin perform private.analytics_students('b3000000-0000-4000-8000-00000000000a', null, null, null, null, null); raise exception 'FAIL: anonymous analytics';
  exception when insufficient_privilege then null; end;
  begin perform private.analytics_fees('b3000000-0000-4000-8000-00000000000a', null, null, null, null); raise exception 'FAIL: anonymous fee analytics';
  exception when insufficient_privilege then null; end;
  begin perform private.analytics_sync_dues('b3000000-0000-4000-8000-00000000000a', 'c3000000-0000-4000-8000-000000000002'); raise exception 'FAIL: anonymous dues sync';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ begin raise notice 'ALL ANALYTICS TESTS PASSED'; end $$;
select 'ALL ANALYTICS TESTS PASSED' as result;
rollback;
