-- =====================================================================
-- Production hardening test (migration 0033). Run in Supabase SQL Editor after all migrations.
-- Rolls back; leaves nothing behind. Pass = "ALL PRODUCTION TESTS PASSED".
--
-- Checks: a school (and with it every receipt, mark and payslip) can't be deleted through the
-- Data API, not even by the platform super admin; the shared rate limiter counts per key, refuses
-- over the limit with the seconds to wait, starts again after the window, keeps no readable key and
-- is only usable by its own role; the renewal run can't race itself; foreign keys checked on deletes
-- are indexed and the duplicate index is gone.
-- =====================================================================
begin;

create function private._p_eq(got anyelement, want anyelement, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._p_refused(q text, msg text) returns void language plpgsql as $$
begin
  begin execute q; exception when insufficient_privilege then return; end;
  raise exception 'FAIL: % (was allowed)', msg using errcode = 'ZT001';
end $$;
create function private._p_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function private._p_eq(anyelement, anyelement, text), private._p_refused(text, text), private._p_as(uuid) to authenticated, anon, erp_ratelimit;

-- ---------- 1. schools are deactivated, never deleted, through the app
insert into auth.users (id, email) values
  ('a3400000-0000-4000-8000-000000000001', 'prod-super@example.invalid'),
  ('a3400000-0000-4000-8000-000000000002', 'prod-admin@example.invalid');
update public.profiles set is_super_admin = true where id = 'a3400000-0000-4000-8000-000000000001';
insert into public.schools (id, name, code, state) values ('b3400000-0000-4000-8000-00000000000a', 'Production School', 'ZZPROD-A', 'Delhi');
insert into public.school_memberships (school_id, user_id, role)
  values ('b3400000-0000-4000-8000-00000000000a', 'a3400000-0000-4000-8000-000000000002', 'school_admin');

select private._p_as('a3400000-0000-4000-8000-000000000001');
select private._p_refused($q$delete from public.schools where id = 'b3400000-0000-4000-8000-00000000000a'$q$,
  'the platform super admin can''t delete a school (and its whole history) through the Data API');
select private._p_as('a3400000-0000-4000-8000-000000000002');
select private._p_refused($q$delete from public.schools where id = 'b3400000-0000-4000-8000-00000000000a'$q$,
  'nor can the school''s own admin');
-- deactivating is still how a school is closed
select private._p_as('a3400000-0000-4000-8000-000000000001');
update public.schools set status = 'suspended' where id = 'b3400000-0000-4000-8000-00000000000a';
reset role;
select private._p_eq((select status::text from public.schools where id = 'b3400000-0000-4000-8000-00000000000a'), 'suspended',
  'the super admin can still deactivate it');
select private._p_eq((select count(*)::int from pg_policy where polrelid = 'public.schools'::regclass and polcmd = 'd'), 0, 'no delete policy on schools');
select private._p_eq(has_table_privilege('service_role', 'public.schools', 'DELETE'), false, 'the service-role key can''t delete a school either');

-- ---------- 2. the shared rate limiter
set local role erp_ratelimit;
select private._p_eq(private.rate_hit('test-bucket:203.0.113.1', 3, 600), 0, '1st request allowed');
select private._p_eq(private.rate_hit('test-bucket:203.0.113.1', 3, 600), 0, '2nd allowed');
select private._p_eq(private.rate_hit('test-bucket:203.0.113.1', 3, 600), 0, '3rd allowed');
select private._p_eq((select r between 590 and 600 from (select private.rate_hit('test-bucket:203.0.113.1', 3, 600) r offset 0) t), true,
  '4th refused, with the seconds to wait');
select private._p_eq(private.rate_hit('test-bucket:203.0.113.2', 3, 600), 0, 'another client has its own count');
select private._p_eq(private.rate_hit('other-bucket:203.0.113.1', 3, 600), 0, 'and so does another limit for the same client');
select private._p_eq(private.rate_hit('short:203.0.113.1', 1, 1), 0, 'a 1-second window: allowed');
select private._p_eq(private.rate_hit('short:203.0.113.1', 1, 1) > 0, true, 'then refused');
select pg_sleep(1.1);
select private._p_eq(private.rate_hit('short:203.0.113.1', 1, 1), 0, 'allowed again once the window has passed');
reset role;
select private._p_eq((select count(*)::int from private.rate_limits where key_hash = sha256(convert_to('test-bucket:203.0.113.1', 'UTF8'))
  and hits = 4), 1, 'the count is kept under a hash of the key');
select private._p_eq((select count(*)::int from private.rate_limits where octet_length(key_hash) <> 32), 0, 'keys are 32-byte hashes: no IP is stored');
set local role erp_ratelimit;
do $$ begin
  begin perform private.rate_hit('x', 0, 60); raise exception 'FAIL: a zero limit was accepted' using errcode = 'ZT001';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
select private._p_refused($q$select private.rate_hit('x', 1, 60)$q$, 'only the erp_ratelimit role counts (not even the owner without it)');
select private._p_eq(has_function_privilege('authenticated', 'private.rate_hit(text,integer,integer)', 'EXECUTE'), false,
  'signed-in users have no access to the counter');
select private._p_as('a3400000-0000-4000-8000-000000000002');
select private._p_refused($q$select private.rate_hit('test-bucket:203.0.113.1', 1000, 60)$q$, 'a signed-in user can''t touch anyone''s count');
select private._p_refused($q$select * from private.rate_limits$q$, 'or read the counts');
reset role;
select private._p_eq(has_function_privilege('anon', 'private.rate_hit(text,integer,integer)', 'EXECUTE'), false, 'nor can the public');
select private._p_eq(has_function_privilege('service_role', 'private.rate_hit(text,integer,integer)', 'EXECUTE'), false, 'nor the service-role key');
select private._p_eq(has_table_privilege('service_role', 'private.rate_limits', 'SELECT'), false, 'which can''t read the counts either');

-- ---------- the portal rules' list of "my students" (same rule as can_view_student_record)
select set_config('request.jwt.claims', '', true);  -- the owner sets up (no signed-in user)
insert into auth.users (id, email) values
  ('a3400000-0000-4000-8000-000000000003', 'prod-parent@example.invalid'),
  ('a3400000-0000-4000-8000-000000000004', 'prod-student@example.invalid'),
  ('a3400000-0000-4000-8000-000000000005', 'prod-teacher@example.invalid');
insert into public.schools (id, name, code, state) values ('b3400000-0000-4000-8000-00000000000b', 'Portal School', 'ZZPROD-B', 'Delhi');
insert into public.school_memberships (school_id, user_id, role) values
  ('b3400000-0000-4000-8000-00000000000b', 'a3400000-0000-4000-8000-000000000003', 'parent'),
  ('b3400000-0000-4000-8000-00000000000b', 'a3400000-0000-4000-8000-000000000004', 'student'),
  ('b3400000-0000-4000-8000-00000000000b', 'a3400000-0000-4000-8000-000000000005', 'parent');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f3400000-0000-4000-8000-000000000001', 'b3400000-0000-4000-8000-00000000000b', 'Portal Child', 'Portal Parent', '2016-01-01', 'male', '9800003401'),
  ('f3400000-0000-4000-8000-000000000002', 'b3400000-0000-4000-8000-00000000000b', 'Other Child', 'Other Parent', '2016-01-01', 'female', '9800003402');
update public.students set account_id = 'a3400000-0000-4000-8000-000000000004' where id = 'f3400000-0000-4000-8000-000000000001';
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b3400000-0000-4000-8000-00000000000b', 'f3400000-0000-4000-8000-000000000001', 'a3400000-0000-4000-8000-000000000003', 'father'),
  ('b3400000-0000-4000-8000-00000000000b', 'f3400000-0000-4000-8000-000000000002', 'a3400000-0000-4000-8000-000000000005', 'guardian');
-- …and that second account is then made a teacher instead: being linked is not enough, the parent role is needed
update public.school_memberships set role = 'teacher' where user_id = 'a3400000-0000-4000-8000-000000000005';
select private._p_as('a3400000-0000-4000-8000-000000000003');
select private._p_eq(private.my_student_ids(), array['f3400000-0000-4000-8000-000000000001']::uuid[], 'a parent: their own child only');
select private._p_as('a3400000-0000-4000-8000-000000000004');
select private._p_eq(private.my_student_ids(), array['f3400000-0000-4000-8000-000000000001']::uuid[], 'a student: their own record only');
select private._p_as('a3400000-0000-4000-8000-000000000005');
select private._p_eq(private.my_student_ids(), '{}'::uuid[], 'a teacher with a guardian row but no parent role: nothing');
select private._p_as('a3400000-0000-4000-8000-000000000002');
select private._p_eq(private.my_student_ids(), '{}'::uuid[], 'a school admin: nothing (they read through their own rules)');
reset role;
select set_config('request.jwt.claims', '', true);
update public.school_memberships set status = 'disabled' where user_id = 'a3400000-0000-4000-8000-000000000003';
select private._p_as('a3400000-0000-4000-8000-000000000003');
select private._p_eq(private.my_student_ids(), '{}'::uuid[], 'a parent whose sign-in is turned off: nothing');
reset role;
select set_config('request.jwt.claims', '', true);
update public.school_memberships set status = 'active' where user_id = 'a3400000-0000-4000-8000-000000000003';
update public.schools set status = 'suspended' where id = 'b3400000-0000-4000-8000-00000000000b';
select private._p_as('a3400000-0000-4000-8000-000000000003');
select private._p_eq(private.my_student_ids(), '{}'::uuid[], 'a parent of a deactivated school: nothing');
select private._p_as('a3400000-0000-4000-8000-000000000004');
select private._p_eq(private.my_student_ids(), '{}'::uuid[], 'a student of a deactivated school: nothing');
reset role;

-- ---------- 3. the renewal run can't race itself
select private._p_eq(position('pg_try_advisory_xact_lock' in pg_get_functiondef('private.billing_run()'::regprocedure)) > 0, true,
  'the renewal run takes a lock shared by every API process');
select private._p_eq(position('i.period_start = v_next' in pg_get_functiondef('private.billing_run()'::regprocedure)) > 0, true,
  'and skips a period that is already invoiced instead of failing');

-- ---------- 4. indexes
select private._p_eq((select count(*)::int from pg_indexes where schemaname = 'public' and indexname = 'fee_payment_allocations_due_idx'), 0,
  'the duplicate allocation index is gone');
select private._p_eq((select count(*)::int from pg_indexes where schemaname = 'public' and indexname = 'allocations_due_idx'), 1,
  'the original stays');
select private._p_eq((
  select array_agg(x order by x) from unnest(array[
    'fee_payments.enrollment_id', 'online_payments.enrollment_id', 'student_fee_dues.fee_item_id', 'student_fee_optins.fee_item_id',
    'exam_marks.enrollment_id', 'report_card_remarks.enrollment_id', 'report_card_remarks.student_id', 'homework_submissions.enrollment_id',
    'payslips.teacher_id', 'payslip_adjustments.payslip_id', 'id_cards.student_id', 'id_cards.teacher_id', 'timetable_entries.subject_id',
    'library_loans.book_id', 'library_books.category_id']) x
  where not exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
                    where i.indrelid = ('public.' || split_part(x, '.', 1))::regclass and a.attname = split_part(x, '.', 2))),
  null::text[], 'foreign keys checked on deletes and used for look-ups lead an index');

do $$ begin raise notice 'ALL PRODUCTION TESTS PASSED'; end $$;
select 'ALL PRODUCTION TESTS PASSED' as result;
rollback;
