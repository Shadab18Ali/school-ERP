-- =====================================================================
-- Exams & results test (migrations 0001-0015). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL EXAM TESTS PASSED".
-- School A, 2026-27: Class 5 (sections A, B) and Class 6 (A).
--   Meera teaches 5-A, Ravi teaches 5-B. Asha (login) and Kabir in 5-A, Dev in 5-B,
--   Zoya in 6-A. Asha's parent; an accountant; a teacher from School B.
-- =====================================================================
begin;

create function private._x_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._x_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._x_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._x_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- mark(paper, student, enrollment, marks, absent)
create function private._x_mark(p_paper uuid, p_student uuid, p_enr uuid, p_marks numeric, p_absent boolean) returns void language sql as $$
  insert into public.exam_marks (school_id, paper_id, student_id, enrollment_id, section_id, marks, is_absent)
  values ('b1500000-0000-4000-8000-00000000000a', p_paper, p_student, p_enr, 'd1500000-0000-4000-8000-0000000000b1', p_marks, p_absent);
$$;
grant execute on function private._x_assert(boolean, text), private._x_eq(numeric, numeric, text), private._x_raises(text, text, text, text),
  private._x_as(uuid), private._x_mark(uuid, uuid, uuid, numeric, boolean) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a1500000-0000-4000-8000-000000000001', 'ex-admin@example.invalid'),
  ('a1500000-0000-4000-8000-000000000002', 'ex-meera@example.invalid'),
  ('a1500000-0000-4000-8000-000000000003', 'ex-ravi@example.invalid'),
  ('a1500000-0000-4000-8000-000000000004', 'ex-asha@example.invalid'),
  ('a1500000-0000-4000-8000-000000000006', 'ex-parent@example.invalid'),
  ('a1500000-0000-4000-8000-000000000007', 'ex-accountant@example.invalid'),
  ('a1500000-0000-4000-8000-000000000008', 'ex-teacher-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b1500000-0000-4000-8000-00000000000a', 'Exams A', 'ZZEX-A'),
  ('b1500000-0000-4000-8000-00000000000b', 'Exams B', 'ZZEX-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b1500000-0000-4000-8000-00000000000a', 'a1500000-0000-4000-8000-000000000001', 'school_admin'),
  ('b1500000-0000-4000-8000-00000000000a', 'a1500000-0000-4000-8000-000000000002', 'teacher'),
  ('b1500000-0000-4000-8000-00000000000a', 'a1500000-0000-4000-8000-000000000003', 'teacher'),
  ('b1500000-0000-4000-8000-00000000000a', 'a1500000-0000-4000-8000-000000000004', 'student'),
  ('b1500000-0000-4000-8000-00000000000a', 'a1500000-0000-4000-8000-000000000006', 'parent'),
  ('b1500000-0000-4000-8000-00000000000a', 'a1500000-0000-4000-8000-000000000007', 'accountant'),
  ('b1500000-0000-4000-8000-00000000000b', 'a1500000-0000-4000-8000-000000000008', 'teacher');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c1500000-0000-4000-8000-000000000001', 'b1500000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d1500000-0000-4000-8000-000000000005', 'b1500000-0000-4000-8000-00000000000a', 'Class 5'),
  ('d1500000-0000-4000-8000-000000000006', 'b1500000-0000-4000-8000-00000000000a', 'Class 6');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d1500000-0000-4000-8000-0000000000a1', 'b1500000-0000-4000-8000-00000000000a', 'd1500000-0000-4000-8000-000000000005', 'c1500000-0000-4000-8000-000000000001', 'A'),
  ('d1500000-0000-4000-8000-0000000000b1', 'b1500000-0000-4000-8000-00000000000a', 'd1500000-0000-4000-8000-000000000005', 'c1500000-0000-4000-8000-000000000001', 'B'),
  ('d1500000-0000-4000-8000-0000000000c1', 'b1500000-0000-4000-8000-00000000000a', 'd1500000-0000-4000-8000-000000000006', 'c1500000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile, account_id) values
  ('f1500000-0000-4000-8000-000000000001', 'b1500000-0000-4000-8000-00000000000a', 'Asha', 'P', '2016-01-01', 'female', '9800000601', 'a1500000-0000-4000-8000-000000000004'),
  ('f1500000-0000-4000-8000-000000000002', 'b1500000-0000-4000-8000-00000000000a', 'Kabir', 'P', '2016-01-01', 'male', '9800000602', null),
  ('f1500000-0000-4000-8000-000000000003', 'b1500000-0000-4000-8000-00000000000a', 'Dev', 'P', '2016-01-01', 'male', '9800000603', null),
  ('f1500000-0000-4000-8000-000000000004', 'b1500000-0000-4000-8000-00000000000a', 'Zoya', 'P', '2015-01-01', 'female', '9800000604', null);
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('81500000-0000-4000-8000-000000000001', 'b1500000-0000-4000-8000-00000000000a', 'f1500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005', 'd1500000-0000-4000-8000-0000000000a1', 'X1', '2026-04-01'),
  ('81500000-0000-4000-8000-000000000002', 'b1500000-0000-4000-8000-00000000000a', 'f1500000-0000-4000-8000-000000000002', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005', 'd1500000-0000-4000-8000-0000000000a1', 'X2', '2026-04-01'),
  ('81500000-0000-4000-8000-000000000003', 'b1500000-0000-4000-8000-00000000000a', 'f1500000-0000-4000-8000-000000000003', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005', 'd1500000-0000-4000-8000-0000000000b1', 'X3', '2026-04-01'),
  ('81500000-0000-4000-8000-000000000004', 'b1500000-0000-4000-8000-00000000000a', 'f1500000-0000-4000-8000-000000000004', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000006', 'd1500000-0000-4000-8000-0000000000c1', 'X4', '2026-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b1500000-0000-4000-8000-00000000000a', 'f1500000-0000-4000-8000-000000000001', 'a1500000-0000-4000-8000-000000000006', 'mother');
insert into public.teachers (id, school_id, full_name, phone, email, joining_date, account_id) values
  ('71500000-0000-4000-8000-000000000001', 'b1500000-0000-4000-8000-00000000000a', 'Meera', '9811500001', 'meera@example.invalid', '2020-01-01', 'a1500000-0000-4000-8000-000000000002'),
  ('71500000-0000-4000-8000-000000000002', 'b1500000-0000-4000-8000-00000000000a', 'Ravi', '9811500002', 'ravi@example.invalid', '2020-01-01', 'a1500000-0000-4000-8000-000000000003');
insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id) values
  ('b1500000-0000-4000-8000-00000000000a', '71500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005', 'd1500000-0000-4000-8000-0000000000a1'),
  ('b1500000-0000-4000-8000-00000000000a', '71500000-0000-4000-8000-000000000002', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005', 'd1500000-0000-4000-8000-0000000000b1');

-- ================= setup (admin) =================
select private._x_as('a1500000-0000-4000-8000-000000000001');
insert into public.exam_types (id, school_id, name, display_order) values
  ('e1500000-0000-4000-8000-000000000001', 'b1500000-0000-4000-8000-00000000000a', 'Unit Test', 1),
  ('e1500000-0000-4000-8000-000000000002', 'b1500000-0000-4000-8000-00000000000a', 'Half Yearly', 2),
  ('e1500000-0000-4000-8000-000000000003', 'b1500000-0000-4000-8000-00000000000a', 'Annual', 3),
  ('e1500000-0000-4000-8000-000000000004', 'b1500000-0000-4000-8000-00000000000a', 'Olympiad Prep', 4);
select private._x_raises($q$insert into public.exam_types (school_id, name) values ('b1500000-0000-4000-8000-00000000000a', ' half yearly ')$q$,
  '23505', 'exam type names are unique per school');
insert into public.grade_bands (school_id, grade, min_percentage) values
  ('b1500000-0000-4000-8000-00000000000a', 'A1', 91), ('b1500000-0000-4000-8000-00000000000a', 'A2', 81),
  ('b1500000-0000-4000-8000-00000000000a', 'B1', 71), ('b1500000-0000-4000-8000-00000000000a', 'B2', 61),
  ('b1500000-0000-4000-8000-00000000000a', 'C1', 51), ('b1500000-0000-4000-8000-00000000000a', 'C2', 41),
  ('b1500000-0000-4000-8000-00000000000a', 'D', 33), ('b1500000-0000-4000-8000-00000000000a', 'E', 0);
select private._x_raises($q$insert into public.grade_bands (school_id, grade, min_percentage) values ('b1500000-0000-4000-8000-00000000000a', 'Z', 101)$q$,
  '23514', 'a grade''s minimum is a percentage (0-100)');
insert into public.subjects (id, school_id, name) values
  ('a2500000-0000-4000-8000-000000000001', 'b1500000-0000-4000-8000-00000000000a', 'Mathematics'),
  ('a2500000-0000-4000-8000-000000000002', 'b1500000-0000-4000-8000-00000000000a', 'English');
insert into public.exams (id, school_id, academic_session_id, exam_type_id, name, status) values
  ('91500000-0000-4000-8000-000000000001', 'b1500000-0000-4000-8000-00000000000a', 'c1500000-0000-4000-8000-000000000001', 'e1500000-0000-4000-8000-000000000002', 'Half Yearly 2026', 'published');
select private._x_assert((select status = 'draft' from public.exams), 'a new exam always starts as a draft');
select private._x_raises($q$update public.exams set status = 'scheduled'$q$, '23514', 'can''t schedule an exam without a date sheet', 'date sheet');

-- date sheet: Class 5 Maths (100, pass 33) and English (80, pass 26.5); Class 6 Maths
insert into public.exam_papers (id, school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks) values
  ('a5500000-0000-4000-8000-000000000001', 'b1500000-0000-4000-8000-00000000000a', '91500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005', 'a2500000-0000-4000-8000-000000000001', '2026-09-20', '09:00', '12:00', 100, 33);
select private._x_raises($q$insert into public.exam_papers (school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks)
  values ('b1500000-0000-4000-8000-00000000000a', '91500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005',
          'a2500000-0000-4000-8000-000000000002', '2026-09-20', '11:00', '13:00', 80, 26.5)$q$, '23514', 'a class can''t sit two papers at the same time', 'already has Mathematics');
select private._x_raises($q$insert into public.exam_papers (school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks)
  values ('b1500000-0000-4000-8000-00000000000a', '91500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005',
          'a2500000-0000-4000-8000-000000000002', '2026-09-21', '09:00', '11:00', 80, 90)$q$, '23514', 'passing marks can''t exceed maximum marks');
select private._x_raises($q$insert into public.exam_papers (school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks)
  values ('b1500000-0000-4000-8000-00000000000a', '91500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005',
          'a2500000-0000-4000-8000-000000000002', '2027-05-01', '09:00', '11:00', 80, 26.5)$q$, '23514', 'the date must be within the session', 'within session');
select private._x_raises($q$insert into public.exam_papers (school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks)
  values ('b1500000-0000-4000-8000-00000000000a', '91500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005',
          'a2500000-0000-4000-8000-000000000001', '2026-09-22', '09:00', '11:00', 50, 20)$q$, '23505', 'one paper per subject per class in an exam');
insert into public.exam_papers (id, school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks) values
  ('a5500000-0000-4000-8000-000000000002', 'b1500000-0000-4000-8000-00000000000a', '91500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000005', 'a2500000-0000-4000-8000-000000000002', '2026-09-21', '09:00', '11:00', 80, 26.5),
  ('a5500000-0000-4000-8000-000000000003', 'b1500000-0000-4000-8000-00000000000a', '91500000-0000-4000-8000-000000000001', 'c1500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-000000000006', 'a2500000-0000-4000-8000-000000000001', '2026-09-20', '09:00', '12:00', 100, 33);

select private._x_as('a1500000-0000-4000-8000-000000000006');  -- parent: a draft is invisible
select private._x_eq((select count(*) from public.exams), 0, 'parents don''t see draft exams');
select private._x_as('a1500000-0000-4000-8000-000000000002');  -- Meera
select private._x_eq((select count(*) from public.exam_papers), 3, 'teachers see the date sheet');
update public.exams set name = 'Mine';
select private._x_assert((select name from public.exams) = 'Half Yearly 2026', 'teachers can''t change exams');
select private._x_raises($q$insert into public.exams (school_id, academic_session_id, exam_type_id, name) values ('b1500000-0000-4000-8000-00000000000a',
  'c1500000-0000-4000-8000-000000000001', 'e1500000-0000-4000-8000-000000000001', 'Teacher exam')$q$, '42501', 'teachers can''t create exams');

-- ================= marks (Meera: 5-A only) =================
select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000001', '81500000-0000-4000-8000-000000000001', 95.5, false);
select private._x_assert((select section_id from public.exam_marks) = 'd1500000-0000-4000-8000-0000000000a1',
  'the section is taken from the enrollment, never from the caller');
select private._x_raises($q$select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000002', '81500000-0000-4000-8000-000000000002', 101, false)$q$,
  '23514', 'marks can''t exceed the maximum', 'can''t be more than 100');
select private._x_raises($q$select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000002', '81500000-0000-4000-8000-000000000002', -1, false)$q$,
  '23514', 'marks can''t be negative');
select private._x_raises($q$select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000002', '81500000-0000-4000-8000-000000000002', 50, true)$q$,
  '23514', 'absent means no marks');
select private._x_raises($q$select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000002', '81500000-0000-4000-8000-000000000002', null, false)$q$,
  '23514', 'a mark row needs marks or absent');
select private._x_raises($q$select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000003', '81500000-0000-4000-8000-000000000003', 50, false)$q$,
  '42501', 'a teacher can''t enter marks for another section (Dev, 5-B)');
select private._x_raises($q$select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000004', '81500000-0000-4000-8000-000000000004', 50, false)$q$,
  '23514', 'marks only for students of the paper''s class', 'wrong class');
select private._x_raises($q$select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000002', '81500000-0000-4000-8000-000000000001', 50, false)$q$,
  '23514', 'the enrollment must be the student''s own', 'wrong class');
select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000002', '81500000-0000-4000-8000-000000000002', 40, false);
select private._x_mark('a5500000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000002', '81500000-0000-4000-8000-000000000002', 70, false);
select private._x_mark('a5500000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000001', '81500000-0000-4000-8000-000000000001', null, true);  -- Asha absent in English
select private._x_eq((select count(*) from public.exam_marks), 4, 'Meera sees the marks of her section only');

select private._x_as('a1500000-0000-4000-8000-000000000003');  -- Ravi: 5-B
select private._x_eq((select count(*) from public.exam_marks), 0, 'another section''s teacher sees none of 5-A''s marks');
update public.exam_marks set marks = 0 where student_id = 'f1500000-0000-4000-8000-000000000002';
select private._x_mark('a5500000-0000-4000-8000-000000000001', 'f1500000-0000-4000-8000-000000000003', '81500000-0000-4000-8000-000000000003', 88, false);
select private._x_mark('a5500000-0000-4000-8000-000000000002', 'f1500000-0000-4000-8000-000000000003', '81500000-0000-4000-8000-000000000003', 72, false);
select private._x_eq((select count(*) from private.exam_results('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000a1')), 0,
  'a teacher gets no results for a section not assigned to them');

-- ================= results (admin) =================
select private._x_as('a1500000-0000-4000-8000-000000000001');
select private._x_eq((select marks from public.exam_marks where student_id = 'f1500000-0000-4000-8000-000000000002' and paper_id = 'a5500000-0000-4000-8000-000000000001'),
  40, 'Ravi''s attempt to change Kabir''s marks had no effect');
select private._x_raises($q$update public.exam_papers set max_marks = 90 where id = 'a5500000-0000-4000-8000-000000000001'$q$,
  '23514', 'the maximum can''t drop below an entered mark', 'already has 95.50');
select private._x_raises($q$delete from public.exam_papers where id = 'a5500000-0000-4000-8000-000000000001'$q$,
  '23514', 'a paper with marks can''t be removed');
-- Asha: 95.5 + absent = 95.5/180 = 53.06% (C1) but FAIL (absent). Kabir: 40 + 70 = 110/180 = 61.11% (B2) PASS
select private._x_assert((select result = 'fail' and percentage = 53.06 and grade = 'C1' and failed = 1 and absent = 1 and rank = 2
  from private.exam_results('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000a1') where full_name = 'Asha'),
  'absent fails the subject; percentage, grade and rank still calculated');
select private._x_assert((select result = 'pass' and percentage = 61.11 and grade = 'B2' and total = 110 and max_total = 180 and rank = 1
  from private.exam_results('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000a1') where full_name = 'Kabir'),
  'total, percentage, grade, pass and rank');
select private._x_assert((select bool_and(case subject_name when 'Mathematics' then grade = 'D' and passed and percentage = 40 when 'English' then grade = 'A2' and passed and percentage = 87.5 end)
  from private.exam_result_marks('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000a1') where student_id = 'f1500000-0000-4000-8000-000000000002'),
  'subject percentage and grade: 40/100 = 40% (D), 70/80 = 87.5% (A2)');
select private._x_assert((select grade = 'AB' and not passed from private.exam_result_marks('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000a1')
  where student_id = 'f1500000-0000-4000-8000-000000000001' and subject_name = 'English'), 'absent shows AB and fails');

-- ================= publishing =================
update public.exams set status = 'scheduled';
select private._x_as('a1500000-0000-4000-8000-000000000006');  -- parent: scheduled exam and its date sheet are visible, marks are not
select private._x_eq((select count(*) from public.exams), 1, 'parents see a scheduled exam');
select private._x_eq((select count(*) from public.exam_papers), 3, 'and its date sheet');
select private._x_eq((select count(*) from public.exam_marks), 0, 'but no marks before results are published');
select private._x_eq((select count(*) from private.exam_results('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000a1')), 0,
  'and no results before publication');
select private._x_as('a1500000-0000-4000-8000-000000000001');
select private._x_raises($q$update public.exams set status = 'published'$q$, '23514', 'can''t publish with marks missing', '1 mark(s) are missing (for example Zoya in Class 6 – A, Mathematics)');
select private._x_mark('a5500000-0000-4000-8000-000000000003', 'f1500000-0000-4000-8000-000000000004', '81500000-0000-4000-8000-000000000004', 12, false);
update public.exams set status = 'published';
select private._x_assert((select results_published_at is not null from public.exams), 'publishing is time-stamped');
select private._x_raises($q$update public.exam_marks set marks = 99 where student_id = 'f1500000-0000-4000-8000-000000000001' and not is_absent$q$,
  '23514', 'published marks are locked', 'Unpublish them');
select private._x_raises($q$update public.exam_papers set pass_marks = 10 where id = 'a5500000-0000-4000-8000-000000000001'$q$,
  '23514', 'the published date sheet is locked');
select private._x_raises($q$delete from public.exams$q$, '23514', 'an exam with marks can''t be deleted', 'Marks have been entered');

select private._x_as('a1500000-0000-4000-8000-000000000006');  -- parent of Asha
select private._x_eq((select count(*) from public.exam_marks), 2, 'the parent sees only their child''s marks');
select private._x_assert((select count(*) = 1 and min(rank) = 2 and min(result) = 'fail' and min(section_size) = 2
  from private.exam_results('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000a1')),
  'the parent gets only their child''s result, ranked against the whole section');
select private._x_eq((select count(*) from private.exam_result_marks('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000a1')), 2,
  'and only their child''s subject marks');
select private._x_eq((select count(*) from private.exam_results('91500000-0000-4000-8000-000000000001', 'd1500000-0000-4000-8000-0000000000b1')), 0,
  'nothing from another section');
select private._x_as('a1500000-0000-4000-8000-000000000004');  -- Asha herself
select private._x_eq((select count(*) from public.exam_marks), 2, 'a student sees only their own marks');
update public.exam_marks set marks = 100 where not is_absent;
select private._x_eq((select max(marks) from public.exam_marks), 95.5, 'students can''t change marks');
select private._x_as('a1500000-0000-4000-8000-000000000007');  -- accountant
select private._x_eq((select count(*) from public.exam_marks), 0, 'accountants see no marks');
select private._x_as('a1500000-0000-4000-8000-000000000008');  -- school B
select private._x_eq((select count(*) from public.exams) + (select count(*) from public.exam_marks), 0, 'another school sees nothing');

-- unpublishing hides results again and reopens marks
select private._x_as('a1500000-0000-4000-8000-000000000001');
update public.exams set status = 'scheduled';
select private._x_assert((select results_published_at is null from public.exams), 'unpublishing clears the time stamp');
update public.exam_marks set marks = 30 where paper_id = 'a5500000-0000-4000-8000-000000000003';
select private._x_as('a1500000-0000-4000-8000-000000000006');
select private._x_eq((select count(*) from public.exam_marks), 0, 'unpublished results are hidden from parents again');

reset role;
do $$ begin raise notice 'ALL EXAM TESTS PASSED'; end $$;
rollback;

