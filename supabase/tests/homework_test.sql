-- =====================================================================
-- Homework test (migrations 0001-0014). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL HOMEWORK TESTS PASSED".
-- School A, session 2026-27: Class 1-A and Class 2-A.
--   Meera teaches 1-A and 2-A, Ravi teaches 1-A only.
--   Asha and Kabir are students in 1-A (with logins), Zoya is in 2-A.
--   Asha's parent; an accountant; a teacher from School B.
-- =====================================================================
begin;

create function private._h_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._h_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._h_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._h_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function private._h_hw(p_id uuid, p_sec uuid, p_title text, p_max numeric, p_late boolean) returns void language sql as $$
  insert into public.homework (id, school_id, academic_session_id, class_id, section_id, title, description, due_at, max_marks, allow_late)
  select p_id, s.school_id, s.academic_session_id, s.class_id, s.id, p_title, 'Do it', now() + interval '2 days', p_max, p_late
  from public.sections s where s.id = p_sec;
$$;
create function private._h_submit(p_hw uuid, p_student uuid, p_answer text) returns void language sql as $$
  insert into public.homework_submissions (school_id, homework_id, student_id, enrollment_id, answer)
  select e.school_id, p_hw, e.student_id, e.id, p_answer from public.student_enrollments e where e.student_id = p_student;
$$;
grant execute on function private._h_assert(boolean, text), private._h_eq(numeric, numeric, text), private._h_raises(text, text, text, text),
  private._h_as(uuid), private._h_hw(uuid, uuid, text, numeric, boolean), private._h_submit(uuid, uuid, text) to authenticated;

-- ---------- fixtures (as the database owner) ----------
insert into auth.users (id, email) values
  ('a1400000-0000-4000-8000-000000000001', 'hw-admin@example.invalid'),
  ('a1400000-0000-4000-8000-000000000002', 'hw-meera@example.invalid'),
  ('a1400000-0000-4000-8000-000000000003', 'hw-ravi@example.invalid'),
  ('a1400000-0000-4000-8000-000000000004', 'hw-asha@example.invalid'),
  ('a1400000-0000-4000-8000-000000000005', 'hw-kabir@example.invalid'),
  ('a1400000-0000-4000-8000-000000000006', 'hw-parent@example.invalid'),
  ('a1400000-0000-4000-8000-000000000007', 'hw-accountant@example.invalid'),
  ('a1400000-0000-4000-8000-000000000008', 'hw-teacher-b@example.invalid'),
  ('a1400000-0000-4000-8000-000000000009', 'hw-zoya@example.invalid');
insert into public.schools (id, name, code) values
  ('b1400000-0000-4000-8000-00000000000a', 'Homework A', 'ZZHW-A'),
  ('b1400000-0000-4000-8000-00000000000b', 'Homework B', 'ZZHW-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b1400000-0000-4000-8000-00000000000a', 'a1400000-0000-4000-8000-000000000001', 'school_admin'),
  ('b1400000-0000-4000-8000-00000000000a', 'a1400000-0000-4000-8000-000000000002', 'teacher'),
  ('b1400000-0000-4000-8000-00000000000a', 'a1400000-0000-4000-8000-000000000003', 'teacher'),
  ('b1400000-0000-4000-8000-00000000000a', 'a1400000-0000-4000-8000-000000000004', 'student'),
  ('b1400000-0000-4000-8000-00000000000a', 'a1400000-0000-4000-8000-000000000005', 'student'),
  ('b1400000-0000-4000-8000-00000000000a', 'a1400000-0000-4000-8000-000000000006', 'parent'),
  ('b1400000-0000-4000-8000-00000000000a', 'a1400000-0000-4000-8000-000000000007', 'accountant'),
  ('b1400000-0000-4000-8000-00000000000a', 'a1400000-0000-4000-8000-000000000009', 'student'),
  ('b1400000-0000-4000-8000-00000000000b', 'a1400000-0000-4000-8000-000000000008', 'teacher');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c1400000-0000-4000-8000-000000000001', 'b1400000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d1400000-0000-4000-8000-000000000001', 'b1400000-0000-4000-8000-00000000000a', 'Class 1'),
  ('d1400000-0000-4000-8000-000000000002', 'b1400000-0000-4000-8000-00000000000a', 'Class 2');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d1400000-0000-4000-8000-0000000000a1', 'b1400000-0000-4000-8000-00000000000a', 'd1400000-0000-4000-8000-000000000001', 'c1400000-0000-4000-8000-000000000001', 'A'),
  ('d1400000-0000-4000-8000-0000000000a2', 'b1400000-0000-4000-8000-00000000000a', 'd1400000-0000-4000-8000-000000000002', 'c1400000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile, account_id) values
  ('f1400000-0000-4000-8000-000000000001', 'b1400000-0000-4000-8000-00000000000a', 'Asha', 'P', '2019-01-01', 'female', '9800000501', 'a1400000-0000-4000-8000-000000000004'),
  ('f1400000-0000-4000-8000-000000000002', 'b1400000-0000-4000-8000-00000000000a', 'Kabir', 'P', '2019-01-01', 'male', '9800000502', 'a1400000-0000-4000-8000-000000000005'),
  ('f1400000-0000-4000-8000-000000000003', 'b1400000-0000-4000-8000-00000000000a', 'Zoya', 'P', '2018-01-01', 'female', '9800000503', 'a1400000-0000-4000-8000-000000000009');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('81400000-0000-4000-8000-000000000001', 'b1400000-0000-4000-8000-00000000000a', 'f1400000-0000-4000-8000-000000000001', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-0000000000a1', 'H1', '2026-04-01'),
  ('81400000-0000-4000-8000-000000000002', 'b1400000-0000-4000-8000-00000000000a', 'f1400000-0000-4000-8000-000000000002', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-0000000000a1', 'H2', '2026-04-01'),
  ('81400000-0000-4000-8000-000000000003', 'b1400000-0000-4000-8000-00000000000a', 'f1400000-0000-4000-8000-000000000003', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000002', 'd1400000-0000-4000-8000-0000000000a2', 'H3', '2026-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b1400000-0000-4000-8000-00000000000a', 'f1400000-0000-4000-8000-000000000001', 'a1400000-0000-4000-8000-000000000006', 'mother');
insert into public.teachers (id, school_id, full_name, phone, email, joining_date, account_id) values
  ('71400000-0000-4000-8000-000000000001', 'b1400000-0000-4000-8000-00000000000a', 'Meera Iyer', '9811400001', 'meera@example.invalid', '2020-01-01', 'a1400000-0000-4000-8000-000000000002'),
  ('71400000-0000-4000-8000-000000000002', 'b1400000-0000-4000-8000-00000000000a', 'Ravi Kumar', '9811400002', 'ravi@example.invalid', '2020-01-01', 'a1400000-0000-4000-8000-000000000003');
insert into public.teacher_assignments (id, school_id, teacher_id, academic_session_id, class_id, section_id) values
  ('e1400000-0000-4000-8000-000000000001', 'b1400000-0000-4000-8000-00000000000a', '71400000-0000-4000-8000-000000000001', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-0000000000a1'),
  ('e1400000-0000-4000-8000-000000000002', 'b1400000-0000-4000-8000-00000000000a', '71400000-0000-4000-8000-000000000001', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000002', 'd1400000-0000-4000-8000-0000000000a2'),
  ('e1400000-0000-4000-8000-000000000003', 'b1400000-0000-4000-8000-00000000000a', '71400000-0000-4000-8000-000000000002', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-0000000000a1');

-- ================= teachers set homework =================
select private._h_as('a1400000-0000-4000-8000-000000000002');  -- Meera
select private._h_hw('91400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-0000000000a1', 'Fractions worksheet', 20, false);
select private._h_assert((select teacher_id from public.homework where id = '91400000-0000-4000-8000-000000000001') = '71400000-0000-4000-8000-000000000001',
  'the database records which teacher set it');
select private._h_hw('91400000-0000-4000-8000-000000000002', 'd1400000-0000-4000-8000-0000000000a2', 'Class 2 essay', null, true);
select private._h_raises($q$insert into public.homework (school_id, academic_session_id, class_id, section_id, title, due_at)
  values ('b1400000-0000-4000-8000-00000000000a', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000001',
          'd1400000-0000-4000-8000-0000000000a1', 'Yesterday', now() - interval '1 hour')$q$, '23514', 'the deadline must be in the future', 'future');
update public.homework set teacher_id = '71400000-0000-4000-8000-000000000002' where id = '91400000-0000-4000-8000-000000000001';
select private._h_assert((select teacher_id from public.homework where id = '91400000-0000-4000-8000-000000000001') = '71400000-0000-4000-8000-000000000001',
  'who set a homework can''t be changed');

-- Ravi teaches 1-A only: he can't set homework for 2-A, nor edit Meera's homework
select private._h_as('a1400000-0000-4000-8000-000000000003');
select private._h_raises($q$insert into public.homework (school_id, academic_session_id, class_id, section_id, title, due_at) values ('b1400000-0000-4000-8000-00000000000a', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000002', 'd1400000-0000-4000-8000-0000000000a2', 'Not mine', now() + interval '1 day')$q$,
  '42501', 'a teacher can''t set homework for a class not assigned to them');
select private._h_eq((select count(*) from public.homework), 1, 'Ravi sees homework of his class only (not 2-A)');
update public.homework set title = 'Hijacked' where id = '91400000-0000-4000-8000-000000000001';
select private._h_assert((select title from public.homework where id = '91400000-0000-4000-8000-000000000001') = 'Fractions worksheet',
  'a teacher can''t edit another teacher''s homework');
delete from public.homework where id = '91400000-0000-4000-8000-000000000001';
select private._h_eq((select count(*) from public.homework), 1, 'nor delete it');
select private._h_hw('91400000-0000-4000-8000-000000000003', 'd1400000-0000-4000-8000-0000000000a1', 'Ravi reading log', 10, false);

-- other people
select private._h_as('a1400000-0000-4000-8000-000000000007');  -- accountant
select private._h_eq((select count(*) from public.homework), 0, 'accountants see no homework');
select private._h_as('a1400000-0000-4000-8000-000000000008');  -- teacher of school B
select private._h_eq((select count(*) from public.homework), 0, 'another school''s teacher sees nothing');
select private._h_raises($q$insert into public.homework (school_id, academic_session_id, class_id, section_id, title, due_at) values ('b1400000-0000-4000-8000-00000000000a', 'c1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-000000000001', 'd1400000-0000-4000-8000-0000000000a1', 'Not mine', now() + interval '1 day')$q$,
  '42501', 'another school''s teacher can''t set homework');

-- ================= attachments =================
select private._h_as('a1400000-0000-4000-8000-000000000002');
insert into public.homework_attachments (school_id, homework_id, file_name, mime_type, size_bytes, file_path)
values ('b1400000-0000-4000-8000-00000000000a', '91400000-0000-4000-8000-000000000001', 'sheet.pdf', 'application/pdf', 1000, 'b1400000-0000-4000-8000-00000000000a/91400000-0000-4000-8000-000000000001/sheet.pdf');
select private._h_as('a1400000-0000-4000-8000-000000000003');
select private._h_raises($q$insert into public.homework_attachments (school_id, homework_id, file_name, mime_type, size_bytes, file_path)
  values ('b1400000-0000-4000-8000-00000000000a', '91400000-0000-4000-8000-000000000001', 'x.pdf', 'application/pdf', 1, 'b1400000-0000-4000-8000-00000000000a/91400000-0000-4000-8000-000000000001/x.pdf')$q$,
  '42501', 'only the homework''s teacher adds files to it');

-- ================= students =================
select private._h_as('a1400000-0000-4000-8000-000000000004');  -- Asha, 1-A
select private._h_eq((select count(*) from public.homework), 2, 'a student sees their class''s homework only');
select private._h_eq((select count(*) from public.homework_attachments), 1, 'and its files');
select private._h_submit('91400000-0000-4000-8000-000000000001', 'f1400000-0000-4000-8000-000000000001', 'My answers');
select private._h_assert((select not is_late from public.homework_submissions), 'on-time submission is not late');
select private._h_raises($q$select private._h_submit('91400000-0000-4000-8000-000000000001', 'f1400000-0000-4000-8000-000000000001', 'again')$q$,
  '23505', 'one submission per student per homework');
select private._h_raises($q$insert into public.homework_submissions (school_id, homework_id, student_id, enrollment_id, answer) values ('b1400000-0000-4000-8000-00000000000a', '91400000-0000-4000-8000-000000000001', 'f1400000-0000-4000-8000-000000000002', '81400000-0000-4000-8000-000000000002', 'as Kabir')$q$,
  '42501', 'a student can''t submit for someone else');
select private._h_raises($q$insert into public.homework_submissions (school_id, homework_id, student_id, enrollment_id, answer)
  select school_id, '91400000-0000-4000-8000-000000000002', student_id, id, 'other class' from public.student_enrollments
  where student_id = 'f1400000-0000-4000-8000-000000000001'$q$, '23514', 'a student can''t submit homework of another class', 'isn''t set for your class');
select private._h_raises($q$update public.homework_submissions set marks = 20$q$, '42501', 'a student can''t give themselves marks', 'Only a teacher');
update public.homework_submissions set answer = 'Better answers';  -- allowed until reviewed
insert into public.homework_submission_files (school_id, submission_id, file_name, mime_type, size_bytes, file_path)
select school_id, id, 'work.jpg', 'image/jpeg', 500, 'b1400000-0000-4000-8000-00000000000a/91400000-0000-4000-8000-000000000001/sub/asha/work.jpg' from public.homework_submissions;
update public.homework set title = 'Mine now';
select private._h_eq((select count(*) from public.homework where title = 'Mine now'), 0, 'students can''t edit homework');

select private._h_as('a1400000-0000-4000-8000-000000000005');  -- Kabir, same class
select private._h_eq((select count(*) from public.homework_submissions), 0, 'a classmate can''t see another student''s submission');
select private._h_eq((select count(*) from public.homework_submission_files), 0, 'or its files');
select private._h_as('a1400000-0000-4000-8000-000000000009');  -- Zoya, 2-A
select private._h_eq((select count(*) from public.homework), 1, 'a student in another class sees only their own class''s homework');

-- parent: read only
select private._h_as('a1400000-0000-4000-8000-000000000006');
select private._h_eq((select count(*) from public.homework), 2, 'a parent sees their child''s homework');
select private._h_eq((select count(*) from public.homework_submissions), 1, 'and their child''s submission');
select private._h_raises($q$insert into public.homework_submissions (school_id, homework_id, student_id, enrollment_id, answer) values ('b1400000-0000-4000-8000-00000000000a', '91400000-0000-4000-8000-000000000003', 'f1400000-0000-4000-8000-000000000001', '81400000-0000-4000-8000-000000000001', 'parent did it')$q$,
  '42501', 'a parent can''t submit for their child');
update public.homework_submissions set answer = 'changed by parent';
select private._h_assert((select answer from public.homework_submissions) = 'Better answers', 'a parent can''t change their child''s work');

-- ================= review =================
select private._h_as('a1400000-0000-4000-8000-000000000003');  -- Ravi: not his homework
select private._h_eq((select count(*) from public.homework_submissions), 0, 'another teacher can''t see the submissions');
update public.homework_submissions set marks = 1;
select private._h_as('a1400000-0000-4000-8000-000000000002');  -- Meera
select private._h_eq((select count(*) from public.homework_submissions where marks is null), 1, '... nor mark them');
select private._h_eq((select count(*) from public.homework_submission_files), 1, 'the homework''s teacher sees the submitted files');
select private._h_raises($q$update public.homework_submissions set answer = 'teacher edit'$q$, '42501', 'a teacher can''t change the student''s work');
select private._h_raises($q$update public.homework_submissions set marks = 21$q$, '23514', 'marks can''t exceed the maximum', 'maximum (20');
update public.homework_submissions set marks = 17.5, feedback = '  Good work, check Q4  ';
select private._h_assert((select reviewed_at is not null and reviewed_by = 'a1400000-0000-4000-8000-000000000002' and feedback = 'Good work, check Q4'
  from public.homework_submissions), 'review is stamped with who and when; feedback trimmed');
select private._h_raises($q$update public.homework set max_marks = 10 where id = '91400000-0000-4000-8000-000000000001'$q$,
  '23514', 'maximum can''t go below an awarded mark', 'highest mark 17.50');
select private._h_raises($q$delete from public.homework where id = '91400000-0000-4000-8000-000000000001'$q$,
  '23514', 'homework with submissions can''t be deleted');
select private._h_raises($q$update public.homework set section_id = 'd1400000-0000-4000-8000-0000000000a2', class_id = 'd1400000-0000-4000-8000-000000000002'
  where id = '91400000-0000-4000-8000-000000000001'$q$, '23514', 'can''t move homework with submissions to another class');

select private._h_as('a1400000-0000-4000-8000-000000000004');  -- Asha after review
select private._h_assert((select marks from public.homework_submissions) = 17.5, 'the student sees their marks');
select private._h_raises($q$update public.homework_submissions set answer = 'after review'$q$, '23514', 'reviewed work is locked', 'already reviewed');
select private._h_raises($q$delete from public.homework_submission_files$q$, '23514', 'its files too', 'already reviewed');
select private._h_as('a1400000-0000-4000-8000-000000000006');
select private._h_assert((select feedback from public.homework_submissions) = 'Good work, check Q4', 'the parent sees the feedback');

-- ================= deadlines =================
reset role;
alter table public.homework disable trigger homework_guard;
update public.homework set due_at = now() - interval '1 hour';   -- every deadline has now passed
alter table public.homework enable trigger homework_guard;
select private._h_as('a1400000-0000-4000-8000-000000000005');  -- Kabir, 1-A
select private._h_raises($q$select private._h_submit('91400000-0000-4000-8000-000000000003', 'f1400000-0000-4000-8000-000000000002', 'late')$q$,
  '23514', 'no submissions after the deadline', 'deadline has passed');
select private._h_as('a1400000-0000-4000-8000-000000000009');  -- Zoya, 2-A: that homework allows late work
select private._h_submit('91400000-0000-4000-8000-000000000002', 'f1400000-0000-4000-8000-000000000003', 'sorry, late');
select private._h_assert((select is_late from public.homework_submissions), 'late work is accepted when allowed, and flagged late');
-- Meera can't be unassigned from 2-A while Zoya's work there waits for review
reset role;
select private._h_raises($q$delete from public.teacher_assignments where id = 'e1400000-0000-4000-8000-000000000002'$q$,
  '23514', 'a teacher with unreviewed work in a class can''t be unassigned', 'waiting to be reviewed');
select private._h_as('a1400000-0000-4000-8000-000000000002');
select private._h_raises($q$update public.homework_submissions set marks = 5 where homework_id = '91400000-0000-4000-8000-000000000002'$q$,
  '23514', 'unmarked homework takes feedback, not marks', 'Set maximum marks');
update public.homework_submissions set feedback = 'Thanks' where homework_id = '91400000-0000-4000-8000-000000000002';
reset role;
delete from public.teacher_assignments where id = 'e1400000-0000-4000-8000-000000000002';  -- reviewed: now allowed
select private._h_as('a1400000-0000-4000-8000-000000000002');
select private._h_eq((select count(*) from public.homework where section_id = 'd1400000-0000-4000-8000-0000000000a2'), 0,
  'once unassigned, the teacher no longer sees that class''s homework');

select private._h_as('a1400000-0000-4000-8000-000000000004');
select private._h_raises($q$delete from public.homework_submissions$q$, '42501', 'nobody deletes submissions through the API');

-- admin sees and manages everything in the school
select private._h_as('a1400000-0000-4000-8000-000000000001');
select private._h_eq((select count(*) from public.homework), 3, 'admin sees all homework');
select private._h_eq((select count(*) from public.homework_submissions), 2, 'and all submissions');

reset role;
do $$ begin raise notice 'ALL HOMEWORK TESTS PASSED'; end $$;
rollback;
