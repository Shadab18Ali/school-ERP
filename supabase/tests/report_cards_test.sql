-- =====================================================================
-- Report cards test (migrations 0001-0016). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL REPORT CARD TESTS PASSED".
-- School A, 2026-27: Class 5 (A, B). Meera teaches 5-A, Ravi 5-B.
-- Asha (login) in 5-A with a parent; an accountant; a teacher from School B.
-- =====================================================================
begin;

create function private._r_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._r_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._r_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._r_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function private._r_assert(boolean, text), private._r_eq(numeric, numeric, text),
  private._r_raises(text, text, text, text), private._r_as(uuid) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a1600000-0000-4000-8000-000000000001', 'rc-admin@example.invalid'),
  ('a1600000-0000-4000-8000-000000000002', 'rc-meera@example.invalid'),
  ('a1600000-0000-4000-8000-000000000003', 'rc-ravi@example.invalid'),
  ('a1600000-0000-4000-8000-000000000004', 'rc-asha@example.invalid'),
  ('a1600000-0000-4000-8000-000000000006', 'rc-parent@example.invalid'),
  ('a1600000-0000-4000-8000-000000000007', 'rc-accountant@example.invalid'),
  ('a1600000-0000-4000-8000-000000000008', 'rc-teacher-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b1600000-0000-4000-8000-00000000000a', 'Report A', 'ZZRC-A'),
  ('b1600000-0000-4000-8000-00000000000b', 'Report B', 'ZZRC-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-000000000001', 'school_admin'),
  ('b1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-000000000002', 'teacher'),
  ('b1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-000000000003', 'teacher'),
  ('b1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-000000000004', 'student'),
  ('b1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-000000000006', 'parent'),
  ('b1600000-0000-4000-8000-00000000000a', 'a1600000-0000-4000-8000-000000000007', 'accountant'),
  ('b1600000-0000-4000-8000-00000000000b', 'a1600000-0000-4000-8000-000000000008', 'teacher');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d1600000-0000-4000-8000-000000000005', 'b1600000-0000-4000-8000-00000000000a', 'Class 5');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d1600000-0000-4000-8000-0000000000a1', 'b1600000-0000-4000-8000-00000000000a', 'd1600000-0000-4000-8000-000000000005', 'c1600000-0000-4000-8000-000000000001', 'A'),
  ('d1600000-0000-4000-8000-0000000000b1', 'b1600000-0000-4000-8000-00000000000a', 'd1600000-0000-4000-8000-000000000005', 'c1600000-0000-4000-8000-000000000001', 'B');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile, account_id) values
  ('f1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', 'Asha', 'P', '2016-01-01', 'female', '9800000701', 'a1600000-0000-4000-8000-000000000004');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('81600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', 'f1600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-000000000001', 'd1600000-0000-4000-8000-000000000005', 'd1600000-0000-4000-8000-0000000000a1', 'R1', '2026-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b1600000-0000-4000-8000-00000000000a', 'f1600000-0000-4000-8000-000000000001', 'a1600000-0000-4000-8000-000000000006', 'mother');
insert into public.teachers (id, school_id, full_name, phone, email, joining_date, account_id) values
  ('71600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', 'Meera', '9811600001', 'meera@example.invalid', '2020-01-01', 'a1600000-0000-4000-8000-000000000002'),
  ('71600000-0000-4000-8000-000000000002', 'b1600000-0000-4000-8000-00000000000a', 'Ravi', '9811600002', 'ravi@example.invalid', '2020-01-01', 'a1600000-0000-4000-8000-000000000003');
insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id, is_class_teacher) values
  ('b1600000-0000-4000-8000-00000000000a', '71600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-000000000001', 'd1600000-0000-4000-8000-000000000005', 'd1600000-0000-4000-8000-0000000000a1', true),
  ('b1600000-0000-4000-8000-00000000000a', '71600000-0000-4000-8000-000000000002', 'c1600000-0000-4000-8000-000000000001', 'd1600000-0000-4000-8000-000000000005', 'd1600000-0000-4000-8000-0000000000b1', false);
insert into public.subjects (id, school_id, name) values ('a2600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', 'Mathematics');
insert into public.exam_types (id, school_id, name) values ('e1600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', 'Annual');
insert into public.exams (id, school_id, academic_session_id, exam_type_id, name) values
  ('91600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', 'c1600000-0000-4000-8000-000000000001', 'e1600000-0000-4000-8000-000000000001', 'Annual 2027');
insert into public.exam_papers (id, school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks) values
  ('a5600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', '91600000-0000-4000-8000-000000000001', 'c1600000-0000-4000-8000-000000000001', 'd1600000-0000-4000-8000-000000000005', 'a2600000-0000-4000-8000-000000000001', '2027-03-01', '09:00', '12:00', 100, 33);
update public.exams set status = 'scheduled';

-- ================= templates =================
select private._r_as('a1600000-0000-4000-8000-000000000001');  -- admin
insert into public.report_card_templates (id, school_id, name, is_default, accent_color, title) values
  ('c2600000-0000-4000-8000-000000000001', 'b1600000-0000-4000-8000-00000000000a', ' Standard ', true, '#2F6B57', ' Progress Report '),
  ('c2600000-0000-4000-8000-000000000002', 'b1600000-0000-4000-8000-00000000000a', 'Annual blue', false, '#1d4ed8', 'Annual Report Card');
select private._r_assert((select name = 'Standard' and title = 'Progress Report' and accent_color = '#2f6b57' from public.report_card_templates
  where id = 'c2600000-0000-4000-8000-000000000001'), 'names and titles are trimmed, colours stored lower-case');
select private._r_raises($q$update public.report_card_templates set is_default = true where id = 'c2600000-0000-4000-8000-000000000002'$q$,
  '23505', 'only one default template per school');
select private._r_raises($q$insert into public.report_card_templates (school_id, name, accent_color) values ('b1600000-0000-4000-8000-00000000000a', 'Bad', 'red')$q$,
  '23514', 'colours must be #rrggbb');
select private._r_raises($q$insert into public.report_card_templates (school_id, name) values ('b1600000-0000-4000-8000-00000000000a', 'standard')$q$,
  '23505', 'template names are unique per school');
select private._r_raises($q$delete from public.report_card_templates where id = 'c2600000-0000-4000-8000-000000000001'$q$,
  '23514', 'the default template can''t be deleted', 'default template');
update public.exams set report_card_template_id = 'c2600000-0000-4000-8000-000000000002';
delete from public.report_card_templates where id = 'c2600000-0000-4000-8000-000000000002';
select private._r_assert((select report_card_template_id is null and school_id = 'b1600000-0000-4000-8000-00000000000a' from public.exams),
  'deleting an exam''s template falls back to the default (and keeps the exam''s school)');

select private._r_as('a1600000-0000-4000-8000-000000000002');  -- teacher
select private._r_eq((select count(*) from public.report_card_templates), 1, 'staff can read templates');
select private._r_raises($q$insert into public.report_card_templates (school_id, name) values ('b1600000-0000-4000-8000-00000000000a', 'Mine')$q$,
  '42501', 'teachers can''t create templates');
update public.report_card_templates set title = 'Hacked';
select private._r_assert((select title from public.report_card_templates) = 'Progress Report', 'teachers can''t change templates');
select private._r_as('a1600000-0000-4000-8000-000000000008');  -- school B
select private._r_eq((select count(*) from public.report_card_templates), 0, 'another school can''t see templates');
select private._r_assert(private.class_teacher_name('d1600000-0000-4000-8000-0000000000a1') is null, 'another school can''t read class teacher names');

-- ================= remarks =================
select private._r_as('a1600000-0000-4000-8000-000000000002');  -- Meera, 5-A
insert into public.report_card_remarks (school_id, exam_id, student_id, enrollment_id, section_id, teacher_remarks)
values ('b1600000-0000-4000-8000-00000000000a', '91600000-0000-4000-8000-000000000001', 'f1600000-0000-4000-8000-000000000001',
        '81600000-0000-4000-8000-000000000001', 'd1600000-0000-4000-8000-0000000000b1', '  Works hard; must practise geometry.  ');
select private._r_assert((select section_id = 'd1600000-0000-4000-8000-0000000000a1' and teacher_remarks = 'Works hard; must practise geometry.'
  from public.report_card_remarks), 'section comes from the enrollment; remarks are trimmed');
select private._r_raises($q$update public.report_card_remarks set principal_remarks = 'Promoted'$q$,
  '42501', 'teachers can''t write the principal''s remarks', 'principal''s office');

select private._r_as('a1600000-0000-4000-8000-000000000003');  -- Ravi, 5-B
select private._r_eq((select count(*) from public.report_card_remarks), 0, 'another section''s teacher can''t see the remarks');
update public.report_card_remarks set teacher_remarks = 'Changed by Ravi';
select private._r_raises($q$insert into public.report_card_remarks (school_id, exam_id, student_id, enrollment_id, section_id, teacher_remarks)
  values ('b1600000-0000-4000-8000-00000000000a', '91600000-0000-4000-8000-000000000001', 'f1600000-0000-4000-8000-000000000002',
          '81600000-0000-4000-8000-000000000001', 'd1600000-0000-4000-8000-0000000000b1', 'x')$q$, '23514', 'remarks must match the student''s own enrollment', 'enrolled');

select private._r_as('a1600000-0000-4000-8000-000000000001');  -- admin = principal's office
select private._r_assert((select teacher_remarks from public.report_card_remarks) = 'Works hard; must practise geometry.', 'Ravi''s change had no effect');
update public.report_card_remarks set principal_remarks = 'Promoted to Class 6. Well done.';
select private._r_as('a1600000-0000-4000-8000-000000000002');  -- Meera edits her remark; principal's stays
update public.report_card_remarks set teacher_remarks = 'Works hard and helps others.';
select private._r_assert((select principal_remarks = 'Promoted to Class 6. Well done.' and teacher_remarks = 'Works hard and helps others.'
  from public.report_card_remarks), 'a teacher can change their remarks without touching the principal''s');

select private._r_as('a1600000-0000-4000-8000-000000000006');  -- parent before publication
select private._r_eq((select count(*) from public.report_card_remarks), 0, 'parents don''t see remarks before results are published');
select private._r_as('a1600000-0000-4000-8000-000000000007');
select private._r_eq((select count(*) from public.report_card_remarks), 0, 'accountants don''t see remarks');

-- publish (Asha needs a mark), then remarks are visible to the family and locked
select private._r_as('a1600000-0000-4000-8000-000000000001');
insert into public.exam_marks (school_id, paper_id, student_id, enrollment_id, section_id, marks) values
  ('b1600000-0000-4000-8000-00000000000a', 'a5600000-0000-4000-8000-000000000001', 'f1600000-0000-4000-8000-000000000001', '81600000-0000-4000-8000-000000000001',
   'd1600000-0000-4000-8000-0000000000a1', 88);
update public.exams set status = 'published';
select private._r_as('a1600000-0000-4000-8000-000000000002');
select private._r_raises($q$update public.report_card_remarks set teacher_remarks = 'late change'$q$, '23514', 'remarks lock on publication', 'Unpublish');
select private._r_as('a1600000-0000-4000-8000-000000000006');
select private._r_eq((select count(*) from public.report_card_remarks), 1, 'the parent sees their child''s remarks once published');
select private._r_as('a1600000-0000-4000-8000-000000000004');
select private._r_eq((select count(*) from public.report_card_remarks), 1, 'and so does the student');
select private._r_assert(private.class_teacher_name('d1600000-0000-4000-8000-0000000000a1') = 'Meera', 'the class teacher''s name is available for the report card');
update public.report_card_remarks set teacher_remarks = 'self-praise';
select private._r_as('a1600000-0000-4000-8000-000000000001');
select private._r_assert((select teacher_remarks from public.report_card_remarks) = 'Works hard and helps others.', 'students can''t change remarks');

reset role;
do $$ begin raise notice 'ALL REPORT CARD TESTS PASSED'; end $$;
rollback;
