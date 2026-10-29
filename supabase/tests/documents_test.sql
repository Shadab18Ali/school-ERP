-- =====================================================================
-- Documents test (migrations 0001-0026). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL DOCUMENT TESTS PASSED".
-- School A: admin, accountant, teacher (login); students Child One (male, enrolled, address),
-- Child Two (female, mother only, no address, enrolled), Child Three (not enrolled this session);
-- staff: a teacher, an office assistant (non-teaching), a driver. School B: admin.
-- =====================================================================
begin;

create function private._d_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._d_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._d_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function private._d_cert(p_purpose text) returns public.certificates language sql security definer set search_path = '' as $$
  select * from public.certificates where purpose = p_purpose order by created_at desc limit 1;
$$;
create function private._d_card(p_id uuid) returns public.id_cards language sql security definer set search_path = '' as $$
  select * from public.id_cards where id = p_id;
$$;
grant execute on function private._d_assert(boolean, text), private._d_raises(text, text, text, text), private._d_as(uuid),
  private._d_cert(text), private._d_card(uuid) to authenticated, anon;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a2700000-0000-4000-8000-000000000001', 'dc-admin@example.invalid'),
  ('a2700000-0000-4000-8000-000000000002', 'dc-accountant@example.invalid'),
  ('a2700000-0000-4000-8000-000000000003', 'dc-teacher@example.invalid'),
  ('a2700000-0000-4000-8000-000000000004', 'dc-admin-b@example.invalid');
insert into public.schools (id, name, code, address, city, state, postal_code, affiliation_board, affiliation_number) values
  ('b2700000-0000-4000-8000-00000000000a', 'Green Valley School', 'ZZDC-A', '12 Ring Road', 'Lucknow', 'Uttar Pradesh', '226001', 'CBSE', '2130456'),
  ('b2700000-0000-4000-8000-00000000000b', 'Other School', 'ZZDC-B', null, null, null, null, null, null);
insert into public.school_memberships (school_id, user_id, role) values
  ('b2700000-0000-4000-8000-00000000000a', 'a2700000-0000-4000-8000-000000000001', 'school_admin'),
  ('b2700000-0000-4000-8000-00000000000a', 'a2700000-0000-4000-8000-000000000002', 'accountant'),
  ('b2700000-0000-4000-8000-00000000000a', 'a2700000-0000-4000-8000-000000000003', 'teacher'),
  ('b2700000-0000-4000-8000-00000000000b', 'a2700000-0000-4000-8000-000000000004', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c2700000-0000-4000-8000-000000000001', 'b2700000-0000-4000-8000-00000000000a', 'This year',
   (date_trunc('month', private.ist_today()) - interval '6 months')::date, (date_trunc('month', private.ist_today()) + interval '6 months - 1 day')::date, true),
  ('c2700000-0000-4000-8000-000000000002', 'b2700000-0000-4000-8000-00000000000a', 'Last year',
   (date_trunc('month', private.ist_today()) - interval '18 months')::date, (date_trunc('month', private.ist_today()) - interval '6 months 1 day')::date, false);
insert into public.classes (id, school_id, name) values ('d2700000-0000-4000-8000-000000000001', 'b2700000-0000-4000-8000-00000000000a', 'Class 5'),
  ('d2700000-0000-4000-8000-000000000002', 'b2700000-0000-4000-8000-00000000000a', 'Class 4');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d2700000-0000-4000-8000-0000000000a1', 'b2700000-0000-4000-8000-00000000000a', 'd2700000-0000-4000-8000-000000000001', 'c2700000-0000-4000-8000-000000000001', 'A'),
  ('d2700000-0000-4000-8000-0000000000b1', 'b2700000-0000-4000-8000-00000000000a', 'd2700000-0000-4000-8000-000000000002', 'c2700000-0000-4000-8000-000000000002', 'B');
insert into public.students (id, school_id, full_name, father_name, mother_name, date_of_birth, gender, mobile, address) values
  ('e2700000-0000-4000-8000-000000000001', 'b2700000-0000-4000-8000-00000000000a', 'Aarav Sharma', 'Rakesh Sharma', 'Neha Sharma', '2015-05-05', 'male', '9800000011', '4 Park Lane, Lucknow'),
  ('e2700000-0000-4000-8000-000000000002', 'b2700000-0000-4000-8000-00000000000a', 'Diya Verma', null, 'Sunita Verma', '2014-12-31', 'female', '9800000022', null),
  ('e2700000-0000-4000-8000-000000000003', 'b2700000-0000-4000-8000-00000000000a', 'Kabir Khan', 'Imran Khan', null, '2013-01-21', 'male', '9800000033', 'Old Town');
insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('b2700000-0000-4000-8000-00000000000a', 'e2700000-0000-4000-8000-000000000001', 'c2700000-0000-4000-8000-000000000002', 'd2700000-0000-4000-8000-000000000002', 'd2700000-0000-4000-8000-0000000000b1', 'A-101', (date_trunc('month', private.ist_today()) - interval '17 months')::date),
  ('b2700000-0000-4000-8000-00000000000a', 'e2700000-0000-4000-8000-000000000001', 'c2700000-0000-4000-8000-000000000001', 'd2700000-0000-4000-8000-000000000001', 'd2700000-0000-4000-8000-0000000000a1', 'A-101', (date_trunc('month', private.ist_today()) - interval '6 months')::date),
  ('b2700000-0000-4000-8000-00000000000a', 'e2700000-0000-4000-8000-000000000002', 'c2700000-0000-4000-8000-000000000001', 'd2700000-0000-4000-8000-000000000001', 'd2700000-0000-4000-8000-0000000000a1', 'A-102', (date_trunc('month', private.ist_today()) - interval '6 months')::date),
  ('b2700000-0000-4000-8000-00000000000a', 'e2700000-0000-4000-8000-000000000003', 'c2700000-0000-4000-8000-000000000002', 'd2700000-0000-4000-8000-000000000002', 'd2700000-0000-4000-8000-0000000000b1', 'A-103', (date_trunc('month', private.ist_today()) - interval '17 months')::date);
insert into public.teachers (id, school_id, employee_id, full_name, phone, email, joining_date, account_id, staff_type, designation) values
  ('f2700000-0000-4000-8000-000000000001', 'b2700000-0000-4000-8000-00000000000a', 'EMP1', 'Teacher One', '9811111111', 'dc-teacher@example.invalid', '2020-06-01', 'a2700000-0000-4000-8000-000000000003', 'teaching', 'PGT Physics'),
  ('f2700000-0000-4000-8000-000000000002', 'b2700000-0000-4000-8000-00000000000a', 'EMP2', 'Office Assistant', '9811111112', 'oa@example.invalid', '2021-06-01', null, 'non_teaching', 'Office assistant');
insert into public.transport_staff (id, school_id, role, full_name, phone, license_number, license_valid_until) values
  ('f2700000-0000-4000-8000-000000000003', 'b2700000-0000-4000-8000-00000000000a', 'driver', 'Ramesh Driver', '9811111113', 'DL-0420110012345', private.ist_today() + 300);

-- ================= words =================
select private._d_assert(private.date_words('2015-05-05') = 'Fifth May Two Thousand Fifteen', 'a date in words');
select private._d_assert(private.date_words('1999-12-31') = 'Thirty-First December One Thousand Nine Hundred Ninety-Nine', 'and another');
select private._d_assert(private.number_words(0) = 'Zero' and private.number_words(2010) = 'Two Thousand Ten' and private.number_words(41) = 'Forty-One', 'numbers in words');
select private._d_raises($q$insert into public.teachers (school_id, employee_id, full_name, phone, email, joining_date, staff_type) values ('b2700000-0000-4000-8000-00000000000a', 'X1', 'Bad Type', '9811111119', 'x@example.invalid', '2020-01-01', 'robot')$q$,
  '23514', 'staff type is teaching or non-teaching');

-- ================= templates =================
select private._d_as('a2700000-0000-4000-8000-000000000001');  -- admin A
insert into public.document_settings (school_id, principal_name, signatory_title) values ('b2700000-0000-4000-8000-00000000000a', 'Dr. Meera Iyer', 'Principal');
insert into public.certificate_templates (id, school_id, kind, name, title, prefix, body) values
  ('92700000-0000-4000-8000-000000000001', 'b2700000-0000-4000-8000-00000000000a', 'bonafide', 'Bonafide', 'Bonafide Certificate', 'BC',
   'This is to certify that {{ student_name }} , {{son_daughter}} of {{parent_name}}, is a bonafide student of {{school_name}}, studying in {{class_section}} in the session {{session_name}}. {{his_her_cap}} date of birth is {{date_of_birth}} ({{date_of_birth_words}}). Issued for {{purpose}}.'),
  ('92700000-0000-4000-8000-000000000002', 'b2700000-0000-4000-8000-00000000000a', 'character', 'Character', 'Character Certificate', 'CC',
   '{{student_name}} of {{address}} bears a good moral character.');
insert into public.certificate_templates (id, school_id, kind, name, title, prefix, body, fields) values
  ('92700000-0000-4000-8000-000000000003', 'b2700000-0000-4000-8000-00000000000a', 'transfer', 'Transfer', 'Transfer Certificate', 'TC',
   'Name: {{student_name}}' || chr(10) || 'Admission no.: {{admission_number}}' || chr(10) || 'Date of leaving: {{leaving_date}}' || chr(10) || 'Reason: {{reason}}' || chr(10) || 'Conduct: {{conduct}}',
   '[{"key": "leaving_date", "label": "Date of leaving", "type": "date", "required": true}, {"key": "reason", "label": "Reason for leaving", "required": true}, {"key": "conduct", "label": "Conduct"}]');
select private._d_assert((select body like 'This is to certify that {{student_name}} ,%' from public.certificate_templates where prefix = 'BC'),
  'placeholders are tidied ({{ x }} → {{x}})');
select private._d_raises($q$insert into public.certificate_templates (school_id, kind, name, title, prefix, body) values ('b2700000-0000-4000-8000-00000000000a', 'custom', 'Bad', 'Bad', 'BD', 'Hello {{blood_group}} here')$q$,
  '23514', 'unknown placeholders are refused', 'blood_group');
select private._d_raises($q$insert into public.certificate_templates (school_id, kind, name, title, prefix, body) values ('b2700000-0000-4000-8000-00000000000a', 'custom', 'Bad2', 'Bad', 'BD', 'Hello {{student_name here')$q$,
  '23514', 'an unclosed placeholder is refused', 'closed');
select private._d_raises($q$insert into public.certificate_templates (school_id, kind, name, title, prefix, body, fields) values ('b2700000-0000-4000-8000-00000000000a', 'custom', 'Bad3', 'Bad', 'BD', 'Some body text {{student_name}}', '[{"key": "student_name", "label": "Name"}]')$q$,
  '23514', 'an extra field can''t reuse a built-in key', 'already used');
select private._d_raises($q$insert into public.certificate_templates (school_id, kind, name, title, prefix, body) values ('b2700000-0000-4000-8000-00000000000a', 'custom', 'Bad4', 'Bad', 'bd', 'Some body text here')$q$,
  '23514', 'a prefix is capital letters');

-- ================= preview and issue =================
select private._d_assert((select r ->> 'body' like '%Aarav Sharma , son of Rakesh Sharma, is a bonafide student of Green Valley School, studying in Class 5 – A in the session This year. His date of birth is 5 May 2015 (Fifth May Two Thousand Fifteen). Issued for passport.'
  from private.certificate_preview('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(), 'passport', '{}') r),
  'the wording is filled from the student''s record and the current enrollment');
select private._d_assert((select r ->> 'body' like '%Diya Verma , daughter of Sunita Verma%Her date of birth%'
  from private.certificate_preview('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000002', null, private.ist_today(), 'bank', '{}') r),
  'pronouns follow the student; the parent is the mother when no father is recorded');
select private._d_raises($q$select private.certificate_preview('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000003', null, private.ist_today(), 'x', '{}')$q$,
  '23514', 'not enrolled in the session → refused', 'isn''t enrolled');
select private._d_assert((select r ->> 'body' like '%Class 4 – B in the session Last year%'
  from private.certificate_preview('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000003', 'c2700000-0000-4000-8000-000000000002', private.ist_today(), 'x', '{}') r),
  'an earlier session can be chosen');
select private._d_raises($q$select private.certificate_preview('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(), null, '{}')$q$,
  '23514', 'a value the wording uses must exist (purpose)', 'purpose');
select private._d_raises($q$select private.certificate_issue('92700000-0000-4000-8000-000000000002', 'e2700000-0000-4000-8000-000000000002', null, private.ist_today(), 'char-diya', '{}', false)$q$,
  '23514', 'missing address → refused, and nothing is numbered', 'address');

select private.certificate_issue('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(), 'passport', '{}', false);
select private.certificate_issue('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000002', null, private.ist_today(), 'bank account', '{}', false);
select private._d_assert((select certificate_number = 'BC-' || extract(year from private.ist_today())::int || '-0001' and verify_token ~ '^[0-9a-f]{32}$'
  and signatory_name = 'Dr. Meera Iyer' and field_values ->> 'class_section' = 'Class 5 – A' and status = 'issued' and place = 'Lucknow'
  from private._d_cert('passport')), 'numbered BC-<year>-0001, with a token, the signatory and the values used');
select private._d_assert((private._d_cert('bank account')).certificate_number like 'BC-%-0002', 'numbers count up per prefix and year');
select private._d_raises($q$select private.certificate_issue('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today() + 1, 'future', '{}', false)$q$,
  '23514', 'not dated in the future', 'future');

-- transfer certificate: required fields, marks the student as left, one valid TC per student
select private._d_raises($q$select private.certificate_issue('92700000-0000-4000-8000-000000000003', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(), 'tc', '{"reason": "Relocation"}', true)$q$,
  '23514', 'required extra fields', 'Fill in “Date of leaving”');
select private._d_raises($q$select private.certificate_issue('92700000-0000-4000-8000-000000000003', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(), 'tc', '{"leaving_date": "soon", "reason": "x"}', true)$q$,
  '23514', 'a date field must be a date', 'must be a date');
select private.certificate_issue('92700000-0000-4000-8000-000000000003', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(),
  'tc', jsonb_build_object('leaving_date', private.ist_today()::text, 'reason', 'Family relocating', 'conduct', 'Good'), true);
select private._d_assert((select body like '%Date of leaving: ' || to_char(private.ist_today(), 'FMDD FMMonth YYYY') || '%Reason: Family relocating%' and certificate_number like 'TC-%-0001'
  from private._d_cert('tc')), 'the TC carries the extra fields, dates written out');
select private._d_assert((select status = 'inactive' and status_reason like '%TC-%' from public.students where id = 'e2700000-0000-4000-8000-000000000001'),
  'issuing the TC marked the student as left');
select private._d_raises($q$select private.certificate_issue('92700000-0000-4000-8000-000000000003', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(), 'tc2', '{"leaving_date": "2026-01-01", "reason": "x"}', false)$q$,
  '23514', 'one valid TC per student', 'already been issued');
select private._d_raises($q$select private.certificate_issue('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(), 'after tc', '{}', false)$q$,
  '23514', 'no bonafide certificate for a student who has left', 'isn''t active');
select private.certificate_issue('92700000-0000-4000-8000-000000000002', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(), 'char-aarav', '{}', false);
select private._d_assert((private._d_cert('char-aarav')).certificate_number like 'CC-%-0001', 'a character certificate can still be given to a student who has left');
select private._d_raises($q$select private.certificate_revoke((private._d_cert('tc')).id, ' ')$q$, '23514', 'revoking needs a reason', 'Give the reason');
select private.certificate_revoke((private._d_cert('tc')).id, 'Wrong date of leaving');
select private.certificate_issue('92700000-0000-4000-8000-000000000003', 'e2700000-0000-4000-8000-000000000001', null, private.ist_today(),
  'tc again', jsonb_build_object('leaving_date', private.ist_today()::text, 'reason', 'Family relocating'), false);
select private._d_assert((private._d_cert('tc again')).certificate_number like 'TC-%-0002', 'after revoking, a new TC (new number)');
select private._d_assert((select body not like '%Conduct%' and body like '%Reason: Family relocating' from private._d_cert('tc again')),
  'an optional field left blank drops its line');
select private._d_raises($q$select private.certificate_revoke((private._d_cert('tc')).id, 'again')$q$, '23514', 'revoked once', 'already revoked');

-- issued certificates are final
select private._d_raises($q$update public.certificates set body = 'changed'$q$, '42501', 'no edits by the app');
select private._d_raises($q$insert into public.certificates (school_id, template_id, kind, student_id, certificate_number, title, body, field_values, issued_on, signatory_title, show_logo, show_photo, show_qr, verify_token) values ('b2700000-0000-4000-8000-00000000000a', '92700000-0000-4000-8000-000000000001', 'bonafide', 'e2700000-0000-4000-8000-000000000002', 'BC-X', 't', 'b', '{}', current_date, 'P', true, true, true, '0123456789abcdef0123456789abcdef')$q$,
  '42501', 'no certificates without the issuing function');
select private._d_raises($q$delete from public.certificate_templates where id = '92700000-0000-4000-8000-000000000001'$q$, '23503', 'a used template is kept', 'not in use');

-- ================= ID cards =================
do $$ declare a uuid; b uuid; c uuid; t uuid; s uuid; d uuid; d2 uuid; begin
  select x into a from private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'student', array['e2700000-0000-4000-8000-000000000002']::uuid[], private.ist_today() + 100, false) x;
  perform private._d_assert((private._d_card(a)).card_number = (select student_code from public.students where id = 'e2700000-0000-4000-8000-000000000002'),
    'a student card carries the student ID');
  select x into b from private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'student', array['e2700000-0000-4000-8000-000000000002']::uuid[], private.ist_today() + 100, false) x;
  perform private._d_assert(a = b, 'printing again reuses the valid card');
  select x into c from private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'student', array['e2700000-0000-4000-8000-000000000002']::uuid[], private.ist_today() + 200, true) x;
  perform private._d_assert(c <> a and (private._d_card(a)).status = 'replaced' and (private._d_card(c)).status = 'active', 'a new card replaces the old one');
  select x into t from private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'teacher', array['f2700000-0000-4000-8000-000000000001']::uuid[], private.ist_today() + 100, false) x;
  perform private._d_assert((private._d_card(t)).card_number = 'EMP1', 'a teacher card carries the employee ID');
  select x into s from private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'staff', array['f2700000-0000-4000-8000-000000000002']::uuid[], private.ist_today() + 100, false) x;
  perform private._d_assert((private._d_card(s)).holder_kind = 'staff', 'non-teaching staff get staff cards');
  select x into d from private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'staff', array['f2700000-0000-4000-8000-000000000003']::uuid[], private.ist_today() + 100, false) x;
  perform private._d_assert((private._d_card(d)).card_number = 'T-0001', 'drivers get a card number');
  select x into d2 from private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'staff', array['f2700000-0000-4000-8000-000000000003']::uuid[], private.ist_today() + 100, true) x;
  perform private._d_assert((private._d_card(d2)).card_number = 'T-0001', 'and keep it on a new card');
end $$;
select private._d_raises($q$select private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'teacher', array['f2700000-0000-4000-8000-000000000002']::uuid[], private.ist_today() + 10, false)$q$,
  '23514', 'teacher cards only for teaching staff', 'teaching staff');
select private._d_raises($q$select private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'student', array['e2700000-0000-4000-8000-000000000001']::uuid[], private.ist_today() + 10, false)$q$,
  '23514', 'no card for a student who has left', 'active students');
select private._d_raises($q$select private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'student', array['e2700000-0000-4000-8000-000000000002']::uuid[], private.ist_today() - 1, false)$q$,
  '23514', 'not valid until a past date', 'Valid until');
select private._d_raises($q$update public.id_cards set valid_until = valid_until + 1000$q$, '42501', 'cards aren''t edited');
select private._d_raises($q$select private.id_card_revoke((select id from public.id_cards where teacher_id = 'f2700000-0000-4000-8000-000000000001'), '')$q$, '23514', 'revoking needs a reason', 'reason');
select private.id_card_revoke((select id from public.id_cards where teacher_id = 'f2700000-0000-4000-8000-000000000001'), 'Lost');

-- ================= nobody else =================
select private._d_as('a2700000-0000-4000-8000-000000000002');  -- accountant
select private._d_assert((select count(*) from public.certificates) + (select count(*) from public.certificate_templates) + (select count(*) from public.id_cards) = 0,
  'the accountant sees no certificates, templates or cards');
select private._d_raises($q$select private.certificate_issue('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000002', null, private.ist_today(), 'acct', '{}', false)$q$,
  'P0002', 'and can''t issue');
select private._d_raises($q$select private.id_card_issue('b2700000-0000-4000-8000-00000000000a', 'student', array['e2700000-0000-4000-8000-000000000002']::uuid[], private.ist_today() + 10, false)$q$,
  '42501', 'or print cards');
select private._d_as('a2700000-0000-4000-8000-000000000003');  -- teacher
select private._d_assert((select count(*) from public.certificates) + (select count(*) from public.id_cards) = 0, 'a teacher sees none');
select private._d_as('a2700000-0000-4000-8000-000000000004');  -- admin of school B
select private._d_assert((select count(*) from public.certificates) + (select count(*) from public.certificate_templates) = 0, 'another school sees none');
select private._d_raises($q$select private.certificate_preview('92700000-0000-4000-8000-000000000001', 'e2700000-0000-4000-8000-000000000002', null, private.ist_today(), 'x', '{}')$q$,
  'P0002', 'and can''t use another school''s template');

-- ================= public verification (QR) =================
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
do $$ begin
  begin perform count(*) from public.certificates; raise exception 'FAIL: the public read certificates';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
create function private._d_verify(tok text) returns jsonb language plpgsql as $f$
declare r jsonb; begin
  set local role anon;
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  r := intake.verify_document(tok);
  reset role;
  return r;
end $f$;
do $$ declare r jsonb; begin
  r := private._d_verify((select verify_token from public.certificates where purpose = 'passport'));
  perform private._d_assert(r ->> 'type' = 'certificate' and r ->> 'status' = 'valid' and r ->> 'name' = 'Aarav Sharma' and r ->> 'school' = 'Green Valley School'
    and r ->> 'number' like 'BC-%' and r ->> 'detail' = 'Class 5 – A' and not (r ? 'body') and not (r ? 'field_values'), 'a valid certificate verifies, without its contents');
  perform private._d_assert(private._d_verify((select verify_token from public.certificates where purpose = 'tc')) ->> 'status' = 'revoked',
    'a revoked certificate shows as revoked');
  perform private._d_assert(private._d_verify((select verify_token from public.id_cards where student_id = 'e2700000-0000-4000-8000-000000000002' and status = 'replaced')) ->> 'status' = 'replaced',
    'a replaced card shows as replaced');
  r := private._d_verify((select verify_token from public.id_cards where student_id = 'e2700000-0000-4000-8000-000000000002' and status = 'active'));
  perform private._d_assert(r ->> 'status' = 'valid' and r ->> 'kind' = 'student' and r ->> 'name' = 'Diya Verma' and not (r ? 'date_of_birth'), 'the current card is valid');
  perform private._d_assert(private._d_verify((select verify_token from public.id_cards where transport_staff_id is not null and status = 'active')) ->> 'detail' = 'Driver',
    'a driver''s card');
  perform private._d_assert(private._d_verify('0123456789abcdef0123456789abcdef') is null and private._d_verify('nope') is null, 'unknown tokens find nothing');
end $$;

-- ================= even the owner can't rewrite =================
reset role;
select private._d_raises($q$update public.certificates set body = 'forged' where purpose = 'passport'$q$, '23514', 'certificates are fixed for everyone', 'can''t be changed');
select private._d_raises($q$delete from public.certificates where purpose = 'passport'$q$, '23514', 'and kept', 'kept');
select private._d_raises($q$delete from public.id_cards where student_id = 'e2700000-0000-4000-8000-000000000002'$q$, '23514', 'cards are kept', 'kept');
select private._d_raises($q$update public.id_cards set status = 'active' where status = 'replaced'$q$, '23514', 'a replaced card stays replaced', 'no longer valid');

do $$ begin raise notice 'ALL DOCUMENT TESTS PASSED'; end $$;
select 'ALL DOCUMENT TESTS PASSED' as result;
rollback;
