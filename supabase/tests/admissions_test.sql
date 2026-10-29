-- =====================================================================
-- Online admission test (migrations 0001-0017). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL ADMISSION TESTS PASSED".
-- School A (code ZZAD-A), session 2026-27: Class 1 open (1 seat, fee 5000),
-- Class 2 closed. An admin, an accountant and a teacher; an admin of school B.
-- =====================================================================
begin;

create function private._a_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._a_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._a_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._a_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function private._a_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;
grant usage on schema private to anon;  -- test helpers only (rolled back)
grant execute on function private._a_assert(boolean, text), private._a_eq(numeric, numeric, text), private._a_raises(text, text, text, text),
  private._a_as(uuid), private._a_anon() to authenticated, anon;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a1700000-0000-4000-8000-000000000001', 'ad-admin@example.invalid'),
  ('a1700000-0000-4000-8000-000000000002', 'ad-accountant@example.invalid'),
  ('a1700000-0000-4000-8000-000000000003', 'ad-teacher@example.invalid'),
  ('a1700000-0000-4000-8000-000000000004', 'ad-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b1700000-0000-4000-8000-00000000000a', 'Admissions A', 'ZZAD-A'),
  ('b1700000-0000-4000-8000-00000000000b', 'Admissions B', 'ZZAD-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b1700000-0000-4000-8000-00000000000a', 'a1700000-0000-4000-8000-000000000001', 'school_admin'),
  ('b1700000-0000-4000-8000-00000000000a', 'a1700000-0000-4000-8000-000000000002', 'accountant'),
  ('b1700000-0000-4000-8000-00000000000a', 'a1700000-0000-4000-8000-000000000003', 'teacher'),
  ('b1700000-0000-4000-8000-00000000000b', 'a1700000-0000-4000-8000-000000000004', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c1700000-0000-4000-8000-000000000001', 'b1700000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d1700000-0000-4000-8000-000000000001', 'b1700000-0000-4000-8000-00000000000a', 'Class 1'),
  ('d1700000-0000-4000-8000-000000000002', 'b1700000-0000-4000-8000-00000000000a', 'Class 2');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d1700000-0000-4000-8000-0000000000a1', 'b1700000-0000-4000-8000-00000000000a', 'd1700000-0000-4000-8000-000000000001', 'c1700000-0000-4000-8000-000000000001', 'A');
insert into public.admission_windows (id, school_id, academic_session_id, class_id, is_open, seats, admission_fee, last_date, instructions) values
  ('e1700000-0000-4000-8000-000000000001', 'b1700000-0000-4000-8000-00000000000a', 'c1700000-0000-4000-8000-000000000001', 'd1700000-0000-4000-8000-000000000001',
   true, 1, 5000, current_date + 30, 'Bring originals for verification.'),
  ('e1700000-0000-4000-8000-000000000002', 'b1700000-0000-4000-8000-00000000000a', 'c1700000-0000-4000-8000-000000000001', 'd1700000-0000-4000-8000-000000000002',
   false, null, 3000, null, null);

create function private._a_form(p_window uuid, p_name text, p_dob text, p_phone text) returns jsonb language sql as $$
  select jsonb_build_object('window_id', p_window, 'student_name', p_name, 'date_of_birth', p_dob, 'gender', 'female',
    'father_name', 'Ravi Kumar', 'father_phone', '9876500001', 'mother_name', 'Sunita Kumar', 'contact_phone', p_phone,
    'contact_email', 'Parent@Example.com', 'address_line', '12 Ring Road', 'city', 'Delhi', 'state', 'Delhi', 'postal_code', '110001',
    'previous_school', 'Little Stars', 'documents', jsonb_build_array(
      jsonb_build_object('type', 'birth_certificate', 'file_name', 'bc.pdf', 'mime_type', 'application/pdf', 'size_bytes', 1000,
                         'file_path', 'test/' || p_name || '/bc.pdf')));
$$;
grant execute on function private._a_form(uuid, text, text, text) to anon, authenticated;

-- ================= the public (anonymous) =================
select private._a_anon();
select private._a_eq((select jsonb_array_length(intake.admission_form('zzad-a')->'windows')), 1, 'only open classes are offered (code is case-insensitive)');
select private._a_assert((select (intake.admission_form('ZZAD-A')->'windows'->0->>'seats_left')::int = 1
  and (intake.admission_form('ZZAD-A')->'windows'->0->>'admission_fee')::numeric = 5000), 'seats left and the fee are shown');
select private._a_raises($q$select * from intake.submit_admission('ZZAD-A', private._a_form('e1700000-0000-4000-8000-000000000002', 'Closed Kid', '2020-01-01', '9811100001'))$q$,
  '23514', 'a closed class takes no applications', 'closed');
select private._a_raises($q$select * from intake.submit_admission('NOPE', private._a_form('e1700000-0000-4000-8000-000000000001', 'Kid', '2020-01-01', '9811100001'))$q$,
  'P0002', 'unknown schools take no applications');
select private._a_raises($q$select * from intake.submit_admission('ZZAD-B', private._a_form('e1700000-0000-4000-8000-000000000001', 'Kid', '2020-01-01', '9811100001'))$q$,
  '23514', 'a window of another school can''t be used', 'closed');
select private._a_assert((select application_number = 'ADM2026-00001'
  from intake.submit_admission('ZZAD-A', private._a_form('e1700000-0000-4000-8000-000000000001', 'Asha Kumar', '2020-05-05', '+919811100001'))),
  'an application number is generated');
select private._a_assert((select application_number = 'ADM2026-00002'
  from intake.submit_admission('ZZAD-A', private._a_form('e1700000-0000-4000-8000-000000000001', 'Bina Shah', '2020-06-06', '9811100002'))),
  'numbers run in sequence');
select private._a_raises($q$select * from intake.submit_admission('ZZAD-A', private._a_form('e1700000-0000-4000-8000-000000000001', ' asha kumar ', '2020-05-05', '9811100001'))$q$,
  '23505', 'the same child can''t apply twice', 'ADM2026-00001');
select private._a_raises($q$select * from intake.submit_admission('ZZAD-A', private._a_form('e1700000-0000-4000-8000-000000000001', 'Future Kid', '2099-01-01', '9811100009'))$q$,
  '23514', 'a date of birth in the future is refused');
select private._a_raises($q$select count(*) from public.admission_applications$q$, '42501', 'the public can''t read applications');
select private._a_raises($q$select private.is_super_admin()$q$, '42501', 'the public can''t call internal functions', null);
select private._a_assert(intake.admission_status('ZZAD-A', 'ADM2026-00001', '9811100099') is null, 'status needs the right mobile number');
select private._a_assert((select s->>'status' = 'submitted' and jsonb_array_length(s->'timeline') = 1 and s->>'class_name' = 'Class 1'
  from intake.admission_status('zzad-a', 'adm2026-00001', '+91-98111-00001') s), 'the applicant can see their status');

-- ================= staff =================
reset role;
revoke usage on schema private from anon;
select private._a_as('a1700000-0000-4000-8000-000000000003');  -- teacher
select private._a_eq((select count(*) from public.admission_applications), 0, 'teachers don''t see applications');
select private._a_as('a1700000-0000-4000-8000-000000000004');  -- school B admin
select private._a_eq((select count(*) from public.admission_applications), 0, 'another school doesn''t see them');
select private._a_as('a1700000-0000-4000-8000-000000000002');  -- accountant
select private._a_eq((select count(*) from public.admission_applications), 2, 'accountants see applications');
select private._a_raises($q$update public.admission_applications set status = 'under_review' where application_number = 'ADM2026-00001'$q$,
  '42501', 'accountants can''t run the review', 'accountants can record');

select private._a_as('a1700000-0000-4000-8000-000000000001');  -- admin
select private._a_assert((select contact_email = 'parent@example.com' from public.admission_applications
  where application_number = 'ADM2026-00001'), 'email stored lower-case');
select private._a_eq((select count(*) from public.admission_documents), 2, 'documents are stored with the application');
select private._a_raises($q$update public.admission_applications set status = 'approved' where application_number = 'ADM2026-00001'$q$,
  '23514', 'steps can''t be skipped', 'can''t go from "submitted" to "approved"');
update public.admission_applications set status = 'under_review' where application_number = 'ADM2026-00001';
update public.admission_applications set status = 'verified', status_note = 'Birth certificate checked' where application_number = 'ADM2026-00001';
update public.admission_applications set status = 'approved' where application_number = 'ADM2026-00001';
select private._a_assert((select fee_amount = 5000 and decided_at is not null and verified_at is not null from public.admission_applications
  where application_number = 'ADM2026-00001'), 'approval fixes the fee from the class''s admission window');
update public.admission_applications set status = 'under_review' where application_number = 'ADM2026-00002';
update public.admission_applications set status = 'verified' where application_number = 'ADM2026-00002';
select private._a_raises($q$update public.admission_applications set status = 'approved' where application_number = 'ADM2026-00002'$q$,
  '23514', 'no approvals beyond the seats', 'All 1 seats');
select private._a_raises($q$update public.admission_applications set status = 'rejected' where application_number = 'ADM2026-00002'$q$,
  '23514', 'a rejection needs a reason', 'reason');
update public.admission_applications set status = 'rejected', rejection_reason = 'No seats left in Class 1.' where application_number = 'ADM2026-00002';
select private._a_assert((select rejection_reason = 'No seats left in Class 1.' and decided_at is not null from public.admission_applications
  where application_number = 'ADM2026-00002'), 'the rejection is recorded');

-- ================= fee payment (accountant) =================
select private._a_as('a1700000-0000-4000-8000-000000000002');
select private._a_raises($q$update public.admission_applications set status = 'fee_paid', fee_paid_amount = 4000, fee_payment_mode = 'cash',
  fee_paid_on = current_date where application_number = 'ADM2026-00001'$q$, '23514', 'the exact fee must be recorded', 'is 5000.00');
select private._a_raises($q$update public.admission_applications set status = 'fee_paid', fee_paid_amount = 5000, fee_payment_mode = 'cash',
  fee_paid_on = current_date, student_name = 'Changed' where application_number = 'ADM2026-00001'$q$, '42501', 'accountants can''t change anything else');
select private._a_raises($q$update public.admission_applications set status = 'fee_paid', fee_paid_amount = 5000, fee_payment_mode = 'upi',
  fee_paid_on = current_date + 1 where application_number = 'ADM2026-00001'$q$, '23514', 'no future payment dates', 'future');
update public.admission_applications set status = 'fee_paid', fee_paid_amount = 5000, fee_payment_mode = 'upi', fee_reference = 'UTR123',
  fee_paid_on = current_date where application_number = 'ADM2026-00001';
select private._a_assert((select fee_receipt_number = 'ADR-00001' from public.admission_applications where application_number = 'ADM2026-00001'),
  'a receipt number is generated');

-- ================= student created (admin) =================
select private._a_as('a1700000-0000-4000-8000-000000000001');
select private._a_raises($q$update public.admission_applications set fee_paid_amount = 1 where application_number = 'ADM2026-00001'$q$,
  '23514', 'a recorded payment can''t be changed', 'can''t be changed');
select private._a_raises($q$update public.admission_applications set class_id = 'd1700000-0000-4000-8000-000000000002' where application_number = 'ADM2026-00001'$q$,
  '23514', 'the class is fixed after approval', 'after approval');
select private._a_raises($q$update public.admission_applications set status = 'enrolled' where application_number = 'ADM2026-00001'$q$,
  '23514', 'enrolment needs the student', 'Create the student first');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile)
values ('f1700000-0000-4000-8000-000000000001', 'b1700000-0000-4000-8000-00000000000a', 'Asha Kumar', 'Ravi Kumar', '2020-05-05', 'female', '+919811100001');
update public.admission_applications set status = 'enrolled', student_id = 'f1700000-0000-4000-8000-000000000001' where application_number = 'ADM2026-00001';
select private._a_raises($q$update public.admission_applications set student_name = 'Late edit' where application_number = 'ADM2026-00001'$q$,
  '23514', 'a completed application is final', 'completed');
select private._a_assert((select array_agg(e.to_status::text order by e.id) = array['submitted', 'under_review', 'verified', 'approved', 'fee_paid', 'enrolled']
  from public.admission_events e join public.admission_applications x on x.id = e.application_id where x.application_number = 'ADM2026-00001'),
  'every step is on the timeline');
select private._a_assert((select note = 'Birth certificate checked' and actor = 'a1700000-0000-4000-8000-000000000001' from public.admission_events
  where to_status = 'verified' and note is not null), 'with who did it and their note');

-- reopening a rejected application clears the reason
update public.admission_applications set status = 'under_review' where application_number = 'ADM2026-00002';
select private._a_assert((select rejection_reason is null from public.admission_applications where application_number = 'ADM2026-00002'),
  'reopening clears the rejection');
select private._a_raises($q$delete from public.admission_applications$q$, '42501', 'applications are never deleted');

-- the applicant sees the outcome, never internal notes
reset role;
grant usage on schema private to anon;  -- test helpers only (rolled back)
select private._a_anon();
select private._a_assert((select s->>'status' = 'enrolled' and s->>'fee_receipt_number' = 'ADR-00001' and jsonb_array_length(s->'timeline') = 6
  and not (s::text like '%Birth certificate checked%')
  from intake.admission_status('ZZAD-A', 'ADM2026-00001', '9811100001') s), 'status, receipt and timeline without staff notes');
select private._a_eq((select (intake.admission_form('ZZAD-A')->'windows'->0->>'seats_left')::int), 0, 'seats left goes down as places are filled');

reset role;
do $$ begin raise notice 'ALL ADMISSION TESTS PASSED'; end $$;
rollback;
