-- =====================================================================
-- Admission CRM test (migrations 0001-0018). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL ENQUIRY TESTS PASSED".
-- School A (code ZZEQ-A): sessions 2026-27 (current) and 2025-26 (archived),
-- Class 1 open for online admission. Admin, accountant, teacher and parent of A;
-- an admin of school B.
-- =====================================================================
begin;

create function private._q_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._q_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._q_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._q_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function private._q_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;
grant usage on schema private to anon;  -- test helpers only (rolled back)
grant execute on function private._q_assert(boolean, text), private._q_eq(numeric, numeric, text), private._q_raises(text, text, text, text),
  private._q_as(uuid), private._q_anon() to authenticated, anon;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a1800000-0000-4000-8000-000000000001', 'eq-admin@example.invalid'),
  ('a1800000-0000-4000-8000-000000000002', 'eq-accountant@example.invalid'),
  ('a1800000-0000-4000-8000-000000000003', 'eq-teacher@example.invalid'),
  ('a1800000-0000-4000-8000-000000000004', 'eq-parent@example.invalid'),
  ('a1800000-0000-4000-8000-000000000005', 'eq-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b1800000-0000-4000-8000-00000000000a', 'Enquiries A', 'ZZEQ-A'),
  ('b1800000-0000-4000-8000-00000000000b', 'Enquiries B', 'ZZEQ-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b1800000-0000-4000-8000-00000000000a', 'a1800000-0000-4000-8000-000000000001', 'school_admin'),
  ('b1800000-0000-4000-8000-00000000000a', 'a1800000-0000-4000-8000-000000000002', 'accountant'),
  ('b1800000-0000-4000-8000-00000000000a', 'a1800000-0000-4000-8000-000000000003', 'teacher'),
  ('b1800000-0000-4000-8000-00000000000a', 'a1800000-0000-4000-8000-000000000004', 'parent'),
  ('b1800000-0000-4000-8000-00000000000b', 'a1800000-0000-4000-8000-000000000005', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c1800000-0000-4000-8000-000000000001', 'b1800000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true),
  ('c1800000-0000-4000-8000-000000000002', 'b1800000-0000-4000-8000-00000000000a', '2025-26', '2025-04-01', '2026-03-31', false),
  ('c1800000-0000-4000-8000-000000000003', 'b1800000-0000-4000-8000-00000000000b', '2026-27', '2026-04-01', '2027-03-31', true);
update public.academic_sessions set archived_at = now() where id = 'c1800000-0000-4000-8000-000000000002';
insert into public.classes (id, school_id, name) values
  ('d1800000-0000-4000-8000-000000000001', 'b1800000-0000-4000-8000-00000000000a', 'Class 1'),
  ('d1800000-0000-4000-8000-000000000002', 'b1800000-0000-4000-8000-00000000000a', 'Class 2'),
  ('d1800000-0000-4000-8000-000000000009', 'b1800000-0000-4000-8000-00000000000b', 'B Class 1');
insert into public.admission_windows (id, school_id, academic_session_id, class_id, is_open, admission_fee) values
  ('e1800000-0000-4000-8000-000000000001', 'b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001',
   'd1800000-0000-4000-8000-000000000001', true, 2000);

create function private._q_form(p_name text, p_phone text) returns jsonb language sql as $$
  select jsonb_build_object('window_id', 'e1800000-0000-4000-8000-000000000001', 'student_name', p_name, 'date_of_birth', '2020-02-02',
    'gender', 'male', 'mother_name', 'Meera Rao', 'contact_phone', p_phone, 'address_line', '7 Lake Road', 'city', 'Pune',
    'state', 'Maharashtra', 'postal_code', '411001', 'documents', '[]'::jsonb);
$$;
grant execute on function private._q_form(text, text) to anon, authenticated;

-- ================= the office (accountant) records enquiries =================
select private._q_as('a1800000-0000-4000-8000-000000000002');
insert into public.admission_enquiries (id, school_id, academic_session_id, parent_name, student_name, phone, class_id, source, notes)
values ('f1800000-0000-4000-8000-000000000001', 'b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001',
        '  Rohan Verma ', 'Aarav Verma', '+919811122233', 'd1800000-0000-4000-8000-000000000001', 'walk_in', 'Wants transport.');
select private._q_assert((select enquiry_number = 'ENQ-00001' and status = 'new' and parent_name = 'Rohan Verma'
  and created_by = 'a1800000-0000-4000-8000-000000000002' from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000001'),
  'numbered ENQ-00001, status new, names trimmed, creator recorded');
select private._q_assert((select kind = 'created' and to_status = 'new' and actor = 'a1800000-0000-4000-8000-000000000002'
  from public.admission_enquiry_activities where enquiry_id = 'f1800000-0000-4000-8000-000000000001'), 'creation is in the history');
insert into public.admission_enquiries (id, school_id, academic_session_id, parent_name, student_name, phone, source, status, follow_up_date)
values ('f1800000-0000-4000-8000-000000000002', 'b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001',
        'Sana Khan', 'Zoya Khan', '9822200011', 'referral', 'follow_up', current_date + 2);
select private._q_assert((select enquiry_number from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000002') = 'ENQ-00002',
  'numbers go up per school');

select private._q_raises($q$insert into public.admission_enquiries (school_id, academic_session_id, parent_name, student_name, phone)
  values ('b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001', 'Some Parent', 'Some Kid', '12345')$q$,
  '23514', 'a phone number needs 10-15 digits');
select private._q_raises($q$insert into public.admission_enquiries (school_id, academic_session_id, parent_name, student_name, phone, status)
  values ('b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001', 'Some Parent', 'Some Kid', '9800000001', 'follow_up')$q$,
  '23514', 'follow-up needs a date', 'follow-up date');
select private._q_raises($q$insert into public.admission_enquiries (school_id, academic_session_id, parent_name, student_name, phone, follow_up_date)
  values ('b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001', 'Some Parent', 'Some Kid', '9800000001', current_date - 1)$q$,
  '23514', 'a follow-up date can''t be in the past', 'past');
select private._q_raises($q$insert into public.admission_enquiries (school_id, academic_session_id, parent_name, student_name, phone)
  values ('b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000002', 'Some Parent', 'Some Kid', '9800000001')$q$,
  '23514', 'no enquiries in an archived session', 'archived');
select private._q_raises($q$insert into public.admission_enquiries (school_id, academic_session_id, parent_name, student_name, phone, class_id)
  values ('b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001', 'Some Parent', 'Some Kid', '9800000001', 'd1800000-0000-4000-8000-000000000009')$q$,
  '23503', 'the class must belong to the school');
select private._q_raises($q$insert into public.admission_enquiries (school_id, academic_session_id, parent_name, student_name, phone)
  values ('b1800000-0000-4000-8000-00000000000b', 'c1800000-0000-4000-8000-000000000003', 'Some Parent', 'Some Kid', '9800000001')$q$,
  '42501', 'the accountant can''t add enquiries to another school');

-- ---------- working an enquiry: every change is in the history ----------
update public.admission_enquiries set status = 'contacted', activity_note = 'Called; will visit on Saturday.'
where id = 'f1800000-0000-4000-8000-000000000001';
select private._q_assert((select kind = 'status' and from_status = 'new' and to_status = 'contacted' and note = 'Called; will visit on Saturday.'
  from public.admission_enquiry_activities where enquiry_id = 'f1800000-0000-4000-8000-000000000001' order by id desc limit 1),
  'a status change is logged with its note');
select private._q_assert((select activity_note is null from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000001'),
  'the note is moved into the history, not kept on the enquiry');
update public.admission_enquiries set follow_up_date = current_date + 3 where id = 'f1800000-0000-4000-8000-000000000001';
select private._q_assert((select kind = 'follow_up' and follow_up_date = current_date + 3
  from public.admission_enquiry_activities where enquiry_id = 'f1800000-0000-4000-8000-000000000001' order by id desc limit 1),
  'a new follow-up date is logged');
update public.admission_enquiries set activity_note = 'Sent fee details on WhatsApp.' where id = 'f1800000-0000-4000-8000-000000000001';
select private._q_assert((select kind = 'note' and note = 'Sent fee details on WhatsApp.'
  from public.admission_enquiry_activities where enquiry_id = 'f1800000-0000-4000-8000-000000000001' order by id desc limit 1),
  'a plain note is logged');
update public.admission_enquiries set notes = 'Wants transport from Sector 9.' where id = 'f1800000-0000-4000-8000-000000000001';
select private._q_eq((select count(*) from public.admission_enquiry_activities where enquiry_id = 'f1800000-0000-4000-8000-000000000001'), 4,
  'editing details without a note adds nothing to the history');
select private._q_raises($q$update public.admission_enquiries set enquiry_number = 'ENQ-99999' where id = 'f1800000-0000-4000-8000-000000000001'$q$,
  '23514', 'the enquiry number is fixed', 'can''t be changed');
select private._q_raises($q$update public.admission_enquiries set follow_up_date = current_date - 2 where id = 'f1800000-0000-4000-8000-000000000001'$q$,
  '23514', 'a new follow-up date can''t be in the past', 'past');
select private._q_raises($q$insert into public.admission_enquiry_activities (school_id, enquiry_id, kind, note)
  values ('b1800000-0000-4000-8000-00000000000a', 'f1800000-0000-4000-8000-000000000001', 'note', 'forged')$q$,
  '42501', 'history is written by the database only');
select private._q_raises($q$update public.admission_enquiry_activities set note = 'changed'$q$, '42501', 'history can''t be edited');

-- an overdue follow-up doesn't block other edits
reset role;
alter table public.admission_enquiries disable trigger admission_enquiries_guard;
update public.admission_enquiries set follow_up_date = current_date - 5 where id = 'f1800000-0000-4000-8000-000000000002';
alter table public.admission_enquiries enable trigger admission_enquiries_guard;
select private._q_as('a1800000-0000-4000-8000-000000000002');
update public.admission_enquiries set notes = 'Prefers morning calls.' where id = 'f1800000-0000-4000-8000-000000000002';
select private._q_assert((select follow_up_date = current_date - 5 and notes = 'Prefers morning calls.' from public.admission_enquiries
  where id = 'f1800000-0000-4000-8000-000000000002'), 'an overdue enquiry can still be edited');

-- closing clears the follow-up date
update public.admission_enquiries set status = 'rejected', activity_note = 'Chose another school.' where id = 'f1800000-0000-4000-8000-000000000002';
select private._q_assert((select follow_up_date is null from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000002'),
  'a rejected enquiry has no follow-up date');
update public.admission_enquiries set status = 'follow_up', follow_up_date = current_date + 7 where id = 'f1800000-0000-4000-8000-000000000002';
select private._q_assert((select status = 'follow_up' from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000002'),
  'a closed enquiry can be reopened');

-- the accountant can't delete
delete from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000002';
select private._q_eq((select count(*) from public.admission_enquiries where school_id = 'b1800000-0000-4000-8000-00000000000a'), 2,
  'accountants can''t delete enquiries');

-- ================= nobody else sees them =================
select private._q_as('a1800000-0000-4000-8000-000000000003');
select private._q_eq((select count(*) from public.admission_enquiries), 0, 'teachers see no enquiries');
select private._q_eq((select count(*) from public.admission_enquiry_activities), 0, 'teachers see no history');
select private._q_raises($q$insert into public.admission_enquiries (school_id, academic_session_id, parent_name, student_name, phone)
  values ('b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001', 'Some Parent', 'Some Kid', '9800000001')$q$,
  '42501', 'teachers can''t add enquiries');
select private._q_as('a1800000-0000-4000-8000-000000000004');
select private._q_eq((select count(*) from public.admission_enquiries), 0, 'parents see no enquiries');
select private._q_as('a1800000-0000-4000-8000-000000000005');
select private._q_eq((select count(*) from public.admission_enquiries), 0, 'another school''s admin sees none');
update public.admission_enquiries set status = 'admitted';
reset role;
select private._q_eq((select count(*) from public.admission_enquiries where status = 'admitted'), 0, 'and can''t change them');
select private._q_anon();
select private._q_raises($q$select count(*) from public.admission_enquiries$q$, '42501', 'the public has no access');

-- ================= an online application links itself =================
-- a sibling pair with the same mobile is ambiguous: not linked automatically
reset role;
select private._q_as('a1800000-0000-4000-8000-000000000002');
insert into public.admission_enquiries (id, school_id, academic_session_id, parent_name, student_name, phone)
values ('f1800000-0000-4000-8000-000000000003', 'b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001', 'Meera Rao', 'Kabir Rao', '9833300044'),
       ('f1800000-0000-4000-8000-000000000004', 'b1800000-0000-4000-8000-00000000000a', 'c1800000-0000-4000-8000-000000000001', 'Meera Rao', 'Kiara Rao', '+919833300044');
reset role;
grant usage on schema private to anon;  -- test helpers only (rolled back)
select private._q_anon();
select application_number from intake.submit_admission('ZZEQ-A', private._q_form('Kabir Rao', '9833300044'));
select application_number from intake.submit_admission('ZZEQ-A', private._q_form('Aarav Verma', '9811122233'));
reset role;
select private._q_as('a1800000-0000-4000-8000-000000000002');
select private._q_eq((select count(*) from public.admission_enquiries where application_id is not null and phone like '%9833300044'), 0,
  'two open enquiries with the same mobile: neither is linked automatically');
select private._q_assert((select e.status = 'application' and x.application_number = 'ADM2026-00002'
  from public.admission_enquiries e join public.admission_applications x on x.id = e.application_id
  where e.id = 'f1800000-0000-4000-8000-000000000001'), 'the matching enquiry is linked and moves to "application"');
select private._q_assert((select kind = 'linked' and actor is null and note like 'Online application ADM2026-00002 received%'
  from public.admission_enquiry_activities where enquiry_id = 'f1800000-0000-4000-8000-000000000001' order by id desc limit 1),
  'the link is in the history, made by the parent''s application');

-- while linked, the status follows the application
select private._q_raises($q$update public.admission_enquiries set status = 'admitted' where id = 'f1800000-0000-4000-8000-000000000001'$q$,
  '23514', 'a linked enquiry''s status can''t be set by hand', 'follows application ADM2026-00002');
update public.admission_enquiries set notes = 'Linked; details still editable.' where id = 'f1800000-0000-4000-8000-000000000001';
select private._q_as('a1800000-0000-4000-8000-000000000001');
update public.admission_applications set status = 'under_review' where application_number = 'ADM2026-00002';
select private._q_assert((select status = 'application' from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000001'),
  'review keeps the enquiry at "application"');
update public.admission_applications set status = 'verified' where application_number = 'ADM2026-00002';
update public.admission_applications set status = 'approved' where application_number = 'ADM2026-00002';
select private._q_assert((select e.status = 'approved' and a.note = 'Application ADM2026-00002: approved' and a.actor = 'a1800000-0000-4000-8000-000000000001'
  from public.admission_enquiries e, public.admission_enquiry_activities a
  where e.id = 'f1800000-0000-4000-8000-000000000001' and a.id = (select max(id) from public.admission_enquiry_activities
    where enquiry_id = 'f1800000-0000-4000-8000-000000000001')), 'approval reaches the enquiry, logged with who approved');
update public.admission_applications set status = 'rejected', rejection_reason = 'Age criteria not met.' where application_number = 'ADM2026-00002';
select private._q_assert((select status = 'rejected' and follow_up_date is null from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000001'),
  'rejection reaches the enquiry and closes its follow-up');
select private._q_assert(private.enquiry_status_for('enrolled') = 'admitted' and private.enquiry_status_for('fee_paid') = 'approved'
  and private.enquiry_status_for('submitted') = 'application', 'application statuses map to enquiry statuses');

-- linking by hand (one of the siblings), and only once per application
update public.admission_enquiries set application_id = (select id from public.admission_applications where application_number = 'ADM2026-00001')
where id = 'f1800000-0000-4000-8000-000000000003';
select private._q_assert((select status = 'application' from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000003'),
  'a hand-linked enquiry takes the application''s status');
select private._q_raises($q$update public.admission_enquiries set application_id = (select id from public.admission_applications where application_number = 'ADM2026-00001')
  where id = 'f1800000-0000-4000-8000-000000000004'$q$, '23505', 'an application belongs to one enquiry');
update public.admission_enquiries set application_id = null, status = 'interested' where id = 'f1800000-0000-4000-8000-000000000003';
select private._q_assert((select e.status = 'interested' and a.kind = 'unlinked' from public.admission_enquiries e, public.admission_enquiry_activities a
  where e.id = 'f1800000-0000-4000-8000-000000000003' and a.id = (select max(id) from public.admission_enquiry_activities
    where enquiry_id = 'f1800000-0000-4000-8000-000000000003')), 'unlinking frees the status again');

-- admins delete; the history goes with the enquiry
delete from public.admission_enquiries where id = 'f1800000-0000-4000-8000-000000000004';
select private._q_eq((select count(*) from public.admission_enquiry_activities where enquiry_id = 'f1800000-0000-4000-8000-000000000004'), 0,
  'deleting an enquiry removes its history');
select private._q_eq((select count(*) from public.admission_applications where application_number = 'ADM2026-00001'), 1,
  'applications are untouched');

reset role;
do $$ begin raise notice 'ALL ENQUIRY TESTS PASSED'; end $$;
rollback;
