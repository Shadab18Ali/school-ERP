-- =====================================================================
-- Platform test (migrations 0001-0029). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL PLATFORM TESTS PASSED".
--
-- School P (admin, accountant, teacher, parent; 3 active students and 1 who left) and
-- School Q (admin; 1 student), the platform's super admin, and two plans.
-- =====================================================================
begin;

create function private._p_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._p_eq(got anyelement, want anyelement, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._p_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- the statement must be refused (any error), or change no row
create function private._p_refused(q text, msg text) returns void language plpgsql as $$
declare n bigint;
begin
  begin execute q; get diagnostics n = row_count;
  exception when others then return; end;
  if n > 0 then raise exception 'FAIL: % (was allowed: % row(s))', msg, n using errcode = 'ZT001'; end if;
end $$;
create function private._p_count(q text) returns bigint language plpgsql as $$
declare n bigint; begin execute 'select count(*) from (' || q || ') x' into n; return n; end $$;
grant execute on function private._p_assert(boolean, text), private._p_eq(anyelement, anyelement, text), private._p_as(uuid),
  private._p_refused(text, text), private._p_count(text) to authenticated;

-- ---------- fixtures
insert into auth.users (id, email) values
  ('a5000000-0000-4000-8000-000000000001', 'pl-super@example.invalid'),
  ('a5000000-0000-4000-8000-000000000002', 'pl-admin-p@example.invalid'),
  ('a5000000-0000-4000-8000-000000000003', 'pl-acct-p@example.invalid'),
  ('a5000000-0000-4000-8000-000000000004', 'pl-teacher-p@example.invalid'),
  ('a5000000-0000-4000-8000-000000000005', 'pl-parent-p@example.invalid'),
  ('a5000000-0000-4000-8000-000000000006', 'pl-admin-q@example.invalid'),
  ('a5000000-0000-4000-8000-000000000007', 'pl-new-person@example.invalid');
update public.profiles set is_super_admin = true where id = 'a5000000-0000-4000-8000-000000000001';
insert into public.schools (id, name, code) values
  ('b5000000-0000-4000-8000-00000000000a', 'Platform School P', 'ZZPL-P'),
  ('b5000000-0000-4000-8000-00000000000b', 'Platform School Q', 'ZZPL-Q');
insert into public.school_memberships (school_id, user_id, role) values
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000002', 'school_admin'),
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000003', 'accountant'),
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000004', 'teacher'),
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000005', 'parent'),
  ('b5000000-0000-4000-8000-00000000000b', 'a5000000-0000-4000-8000-000000000006', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name, display_order) values
  ('d5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-00000000000a', 'Class 1', 1);
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d5000000-0000-4000-8000-0000000000a1', 'b5000000-0000-4000-8000-00000000000a', 'd5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, student_code, full_name, father_name, date_of_birth, gender, mobile, status) values
  ('f5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-00000000000a', 'PL1', 'Pupil One', 'Parent', '2016-01-01', 'male', '9100000001', 'active'),
  ('f5000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-00000000000a', 'PL2', 'Pupil Two', 'Parent', '2016-01-01', 'female', '9100000002', 'active'),
  ('f5000000-0000-4000-8000-000000000003', 'b5000000-0000-4000-8000-00000000000a', 'PL3', 'Pupil Three', 'Parent', '2016-01-01', 'female', '9100000003', 'active'),
  ('f5000000-0000-4000-8000-000000000004', 'b5000000-0000-4000-8000-00000000000a', 'PL4', 'Pupil Four', 'Parent', '2016-01-01', 'male', '9100000004', 'inactive'),
  ('f5000000-0000-4000-8000-000000000009', 'b5000000-0000-4000-8000-00000000000b', 'QL1', 'Pupil of Q', 'Parent', '2016-01-01', 'male', '9100000009', 'active');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000005', 'father');
insert into public.teachers (id, school_id, employee_id, full_name, phone, email, joining_date, account_id) values
  ('e5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-00000000000a', 'PT1', 'Teacher P', '9100000010', 'pl-teacher-p@example.invalid', '2026-04-01', 'a5000000-0000-4000-8000-000000000004');
insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id) values
  ('b5000000-0000-4000-8000-00000000000a', 'e5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-0000000000a1');
insert into public.notifications (school_id, user_id, event_key, title, body) values
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000005', 'payment_received', 'Fee received', 'Rs 1,500 received for Pupil One'),
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000004', 'notice_published', 'Notice', 'Staff meeting');

-- ================= deactivated school: closed to its own people everywhere
select private._p_as('a5000000-0000-4000-8000-000000000005');
select private._p_eq(private._p_count('select 1 from public.notifications'), 1::bigint, 'parent sees their notification while the school is active');
select private._p_eq(private._p_count('select 1 from public.student_guardians'), 1::bigint, 'and their guardian link');
reset role;
update public.schools set status = 'suspended' where id = 'b5000000-0000-4000-8000-00000000000a';
select private._p_as('a5000000-0000-4000-8000-000000000005');
select private._p_eq(private._p_count('select 1 from public.notifications'), 0::bigint, 'deactivated: parent''s notifications hidden');
select private._p_eq(private._p_count('select 1 from public.student_guardians'), 0::bigint, 'deactivated: guardian links hidden');
select private._p_refused($q$update public.notifications set read_at = now()$q$, 'deactivated: notifications can''t be changed');
select private._p_refused($q$delete from public.notifications$q$, 'deactivated: notifications can''t be deleted');
select private._p_eq(private._p_count('select 1 from public.school_memberships'), 1::bigint, 'their own membership stays visible (how the app explains the school is inactive)');
select private._p_as('a5000000-0000-4000-8000-000000000004');
select private._p_eq(private._p_count('select 1 from public.teachers'), 0::bigint, 'deactivated: teacher''s own record hidden');
select private._p_eq(private._p_count('select 1 from public.teacher_assignments'), 0::bigint, 'deactivated: teacher''s classes hidden');
select private._p_eq(private._p_count('select 1 from public.notifications'), 0::bigint, 'deactivated: teacher''s notifications hidden');
select private._p_as('a5000000-0000-4000-8000-000000000001');
select private._p_eq(private._p_count('select 1 from public.teachers where school_id = ''b5000000-0000-4000-8000-00000000000a'''), 1::bigint, 'the super admin still sees a deactivated school''s data');
reset role;
update public.schools set status = 'active' where id = 'b5000000-0000-4000-8000-00000000000a';
select private._p_as('a5000000-0000-4000-8000-000000000004');
select private._p_eq(private._p_count('select 1 from public.teacher_assignments'), 1::bigint, 'reactivated: everything is back');

-- ================= administrators are managed by the super admin only
select private._p_as('a5000000-0000-4000-8000-000000000002');   -- school P's admin
select private._p_refused($q$insert into public.school_memberships (school_id, user_id, role) values
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000007', 'school_admin')$q$, 'a school admin can''t make another school admin');
select private._p_refused($q$update public.school_memberships set role = 'school_admin' where user_id = 'a5000000-0000-4000-8000-000000000003'$q$,
  'nor promote their accountant to admin');
select private._p_refused($q$update public.school_memberships set status = 'disabled' where role = 'school_admin'$q$, 'nor disable an admin');
select private._p_refused($q$delete from public.school_memberships where role = 'school_admin'$q$, 'nor remove one');
insert into public.school_memberships (school_id, user_id, role) values
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000007', 'accountant');
select private._p_eq(private._p_count($q$select 1 from public.school_memberships where user_id = 'a5000000-0000-4000-8000-000000000007'$q$), 1::bigint,
  'a school admin still adds accountants (and other non-admin roles)');
update public.school_memberships set status = 'disabled' where user_id = 'a5000000-0000-4000-8000-000000000007';
select private._p_refused($q$insert into public.school_memberships (school_id, user_id, role) values
  ('b5000000-0000-4000-8000-00000000000b', 'a5000000-0000-4000-8000-000000000007', 'accountant')$q$, 'but never in another school');
select private._p_as('a5000000-0000-4000-8000-000000000001');   -- super admin
insert into public.school_memberships (school_id, user_id, role) values
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000007', 'school_admin');
update public.school_memberships set status = 'disabled' where user_id = 'a5000000-0000-4000-8000-000000000007' and role = 'school_admin';
select private._p_eq((select status::text from public.school_memberships where user_id = 'a5000000-0000-4000-8000-000000000007' and role = 'school_admin'),
  'disabled', 'the super admin adds and disables school admins');

-- ================= plans
select private._p_as('a5000000-0000-4000-8000-000000000002');
select private._p_refused($q$insert into public.subscription_plans (code, name, price_monthly, price_yearly) values ('HACK', 'Hack', 0, 0)$q$,
  'a school admin can''t create plans');
select private._p_as('a5000000-0000-4000-8000-000000000001');
insert into public.subscription_plans (id, code, name, price_monthly, price_yearly, features, display_order) values
  ('99500000-0000-4000-8000-000000000001', 'STARTER', 'Starter', 1500.00, 15000.00, array['Students', 'Fees'], 1),
  ('99500000-0000-4000-8000-000000000002', 'GROWTH', 'Growth', 4000.00, 42000.00, array['Everything'], 2),
  ('99500000-0000-4000-8000-000000000003', 'OLD', 'Old plan', 999.00, 9990.00, '{}', 3);
insert into public.plan_entitlements (plan_id, feature_key, included, limit_value) values
  ('99500000-0000-4000-8000-000000000001', 'students', true, 2), ('99500000-0000-4000-8000-000000000001', 'teachers', true, 10);
select private._p_refused($q$insert into public.subscription_plans (code, name, price_monthly, price_yearly) values ('NEG', 'Negative', -1, 0)$q$, 'no negative price');
select private._p_refused($q$insert into public.subscription_plans (code, name, price_monthly, price_yearly) values ('STARTER2', 'starter ', 1, 1)$q$, 'plan names are unique');
insert into public.billing_settings (legal_name, address, state, invoice_prefix, tax_label, tax_rate, renewal_lead_days, payment_due_days)
values ('Platform Co', 'Delhi', 'Delhi', 'PT', 'GST', 0, 7, 7);

-- ================= subscriptions (P: Starter yearly, paid; Q: Growth on trial)
insert into public.school_subscriptions (school_id, plan_id, billing_cycle, started_on, notes, updated_by)
values ('b5000000-0000-4000-8000-00000000000a', '99500000-0000-4000-8000-000000000001', 'yearly', private.ist_today() - 30, 'Signed by the principal',
        'a5000000-0000-4000-8000-000000000001');
select private.billing_record_payment(private.billing_issue_invoice('b5000000-0000-4000-8000-00000000000a', private.ist_today() - 30, 'subscription'),
  15000.00, 'bank_transfer', null, 'UTR-1', private.ist_today() - 30, 'manual', null, null);
insert into public.school_subscriptions (school_id, plan_id, billing_cycle, started_on, trial_ends_at)
values ('b5000000-0000-4000-8000-00000000000b', '99500000-0000-4000-8000-000000000002', 'monthly', private.ist_today(), private.ist_today() + 14);
select private._p_refused($q$update public.school_subscriptions set school_id = 'b5000000-0000-4000-8000-00000000000b' where school_id = 'b5000000-0000-4000-8000-00000000000a'$q$,
  'a subscription can''t move to another school');
update public.subscription_plans set is_active = false where code = 'OLD';
select private._p_refused($q$update public.school_subscriptions set plan_id = '99500000-0000-4000-8000-000000000003' where school_id = 'b5000000-0000-4000-8000-00000000000a'$q$,
  'a retired plan can''t be given to a school');
update public.subscription_plans set is_active = false where code = 'STARTER';
update public.school_subscriptions set notes = 'Renewal discussed' where school_id = 'b5000000-0000-4000-8000-00000000000a';
select private._p_eq((select notes from public.school_subscriptions where school_id = 'b5000000-0000-4000-8000-00000000000a'), 'Renewal discussed',
  'a school can stay on a plan after it is retired');
update public.subscription_plans set is_active = true where code = 'STARTER';
update public.school_subscriptions set notes = notes where school_id = 'b5000000-0000-4000-8000-00000000000a';   -- no change
select private._p_eq((select string_agg(action, ',' order by id) from public.school_subscription_events where school_id = 'b5000000-0000-4000-8000-00000000000a'),
  'started,changed', 'every change is in the history (start, note), and a no-op is not');
select private._p_eq((select changed_by from public.school_subscription_events where school_id = 'b5000000-0000-4000-8000-00000000000a' order by id limit 1),
  'a5000000-0000-4000-8000-000000000001'::uuid, 'with who made it');

select private._p_as('a5000000-0000-4000-8000-000000000002');   -- school P's admin
select private._p_eq(private._p_count('select 1 from public.school_subscriptions'), 1::bigint, 'a school admin reads their own subscription only');
select private._p_eq((select string_agg(name, ',') from public.subscription_plans), 'Starter', 'and only their own plan');
select private._p_eq(private._p_count('select 1 from public.school_subscription_events'), 2::bigint, 'and its history');
select private._p_eq(private._p_count('select 1 from public.plan_entitlements'), 2::bigint, 'and its plan''s entitlements');
select private._p_refused($q$update public.school_subscriptions set price = 1$q$, 'but can''t change it');
select private._p_refused($q$update public.subscription_plans set price_yearly = 1$q$, 'nor the plan''s price');
select private._p_as('a5000000-0000-4000-8000-000000000003');   -- accountant
select private._p_eq(private._p_count('select 1 from public.school_subscriptions'), 0::bigint, 'an accountant sees no subscription');
select private._p_eq(private._p_count('select 1 from public.subscription_plans'), 0::bigint, 'nor plans');
select private._p_as('a5000000-0000-4000-8000-000000000006');   -- school Q's admin
select private._p_eq((select string_agg(school_id::text, ',') from public.school_subscriptions), 'b5000000-0000-4000-8000-00000000000b',
  'school Q''s admin sees only school Q''s subscription');
select private._p_eq((select string_agg(name, ',') from public.subscription_plans), 'Growth', 'and only Q''s plan');

-- ================= where a subscription stands (worked out from the records)
reset role;
select private._p_eq(private.subscription_status('b5000000-0000-4000-8000-00000000000a') ->> 'status', 'active', 'P: paid → active');
select private._p_eq(private.subscription_status('b5000000-0000-4000-8000-00000000000b') ->> 'status', 'trialing', 'Q: on trial');
select private._p_eq(private.monthly_value('yearly', 15000.00), 1250.00, 'a yearly price per month');
select private._p_eq(private.monthly_value('monthly', 4000.00), 4000.00, 'a monthly price');

-- ================= usage
select private._p_as('a5000000-0000-4000-8000-000000000002');   -- school P's admin: own school
create temp table u on commit drop as select private.school_usage('b5000000-0000-4000-8000-00000000000a') as v;
grant select on u to authenticated;
select private._p_eq((select v #> '{students}' from u), '{"active": 3, "total": 4, "enrolled_this_session": 0}'::jsonb, 'students');
select private._p_eq((select v -> 'people' from u), '{"school_admins": 1, "accountants": 1, "teachers": 1, "librarians": 0, "parents": 1, "students": 0, "staff": 3}'::jsonb,
  'people by role (disabled memberships not counted)');
select private._p_eq((select jsonb_build_array(v #> '{entitlements,students,limit}', v #> '{entitlements,teachers,limit}', v #> '{entitlements,whatsapp,included}') from u),
  '[2, 10, false]'::jsonb, 'the plan''s limits and features (a feature without a row is not included)');
select private._p_eq((select v -> 'over_limits' from u), '{"students": true, "teachers": false, "storage_mb": false}'::jsonb,
  'over the student limit (3 of 2: limits stop new students, they never remove existing ones)');
select private._p_eq((select v #>> '{session,name}' from u), '2026-27', 'current session');
select private._p_eq((select (v ->> 'teachers')::int from u), 1, 'active teachers');
select private._p_refused($q$select private.school_usage('b5000000-0000-4000-8000-00000000000b')$q$, 'school P''s admin can''t see school Q''s usage');
select private._p_refused($q$select private.platform_analytics()$q$, 'nor the platform''s analytics');
select private._p_refused($q$select * from private.platform_schools(array['b5000000-0000-4000-8000-00000000000a'::uuid])$q$, 'nor the schools overview');
select private._p_as('a5000000-0000-4000-8000-000000000003');
select private._p_refused($q$select private.school_usage('b5000000-0000-4000-8000-00000000000a')$q$, 'an accountant can''t see usage');
select private._p_as('a5000000-0000-4000-8000-000000000004');
select private._p_refused($q$select private.school_usage('b5000000-0000-4000-8000-00000000000a')$q$, 'nor a teacher');
reset role;
update public.schools set status = 'suspended' where id = 'b5000000-0000-4000-8000-00000000000a';
select private._p_as('a5000000-0000-4000-8000-000000000002');
select private._p_refused($q$select private.school_usage('b5000000-0000-4000-8000-00000000000a')$q$, 'a deactivated school''s admin sees nothing');
reset role;
update public.schools set status = 'active' where id = 'b5000000-0000-4000-8000-00000000000a';

-- ================= system analytics (super admin)
select private._p_as('a5000000-0000-4000-8000-000000000001');
select private._p_eq((select (private.school_usage('b5000000-0000-4000-8000-00000000000b') #>> '{students,active}')::int), 1, 'the super admin sees any school''s usage');
create temp table pa on commit drop as select private.platform_analytics() as v;
grant select on pa to authenticated;
-- the database may already hold other schools: check this test's schools through the lists
select private._p_assert((select (v #>> '{schools,total}')::int >= 2 from pa), 'schools counted');
select private._p_eq((select x from pa, jsonb_array_elements(v #> '{subscriptions,by_plan}') x where x ->> 'plan' = 'Starter') - 'plan_id',
  '{"plan": "Starter", "schools": 1, "paying": 1, "mrr": 1250.00, "is_active": true}'::jsonb, 'Starter: 1 school paying 15,000 a year = 1,250 a month');
select private._p_eq((select x from pa, jsonb_array_elements(v #> '{subscriptions,by_plan}') x where x ->> 'plan' = 'Growth') - 'plan_id',
  '{"plan": "Growth", "schools": 1, "paying": 0, "mrr": 0, "is_active": true}'::jsonb, 'Growth: 1 school on trial, not paying yet');
select private._p_assert((select exists (select 1 from jsonb_array_elements(v #> '{subscriptions,renewals_due}') x
  where x ->> 'school' = 'Platform School Q' and x ->> 'state' = 'trialing' and (x ->> 'date')::date = private.ist_today() + 14) from pa), 'Q''s trial ends in 14 days: listed as due');
select private._p_assert((select (v #>> '{billing,collected_this_month}')::numeric >= 0 from pa), 'billing figures present');
-- Q's trial ended yesterday and its first invoice is waiting (not due for 7 days): grace, but never paid → no revenue yet
update public.school_subscriptions set trial_ends_at = private.ist_today() - 1 where school_id = 'b5000000-0000-4000-8000-00000000000b';
select private.billing_issue_invoice('b5000000-0000-4000-8000-00000000000b', private.ist_today(), 'subscription');
select private._p_eq((select x from jsonb_array_elements(private.platform_analytics() #> '{subscriptions,by_plan}') x where x ->> 'plan' = 'Growth') - 'plan_id',
  '{"plan": "Growth", "schools": 1, "paying": 0, "mrr": 0, "is_active": true}'::jsonb, 'Growth: Q in grace before ever paying is not recurring revenue');
select private._p_eq(private.platform_analytics() #>> '{subscriptions,by_state,grace}', '1', 'Q counted as in grace');
select private._p_assert((select exists (select 1 from jsonb_array_elements(v -> 'over_limits') x
  where x ->> 'school' = 'Platform School P' and (x ->> 'students')::int = 3 and (x ->> 'max_students')::int = 2) from pa), 'P is over its student limit');
reset role;
-- P's paid year is moved a year back: it ended yesterday, no renewal paid, Starter has no grace → expired
update public.subscription_invoices set period_start = period_start - 365, period_end = private.ist_today() - 1
  where school_id = 'b5000000-0000-4000-8000-00000000000a';
update public.school_subscriptions set started_on = started_on - 365 where school_id = 'b5000000-0000-4000-8000-00000000000a';
select private._p_as('a5000000-0000-4000-8000-000000000001');
select private._p_assert((select exists (select 1 from jsonb_array_elements(private.platform_analytics() #> '{subscriptions,needs_attention}') x
  where x ->> 'school' = 'Platform School P' and x ->> 'state' = 'expired')), 'P''s expired subscription needs attention');
select private._p_eq((select x ->> 'mrr' from jsonb_array_elements(private.platform_analytics() #> '{subscriptions,by_plan}') x where x ->> 'plan' = 'Starter'),
  '0', 'and an expired school is not counted as recurring revenue');
select private._p_eq((select subscription_state || ',' || students_active || ',' || staff || ',' || plan_name || ',' || max_students
  from private.platform_schools(array['b5000000-0000-4000-8000-00000000000a'::uuid])), 'expired,3,3,Starter,2', 'schools overview row');
select private._p_as('a5000000-0000-4000-8000-000000000006');
select private._p_refused($q$select private.platform_analytics()$q$, 'school Q''s admin can''t see system analytics');
reset role;
set local role anon;
do $$ begin
  begin perform private.platform_analytics(); raise exception 'FAIL: anonymous analytics' using errcode = 'ZT001';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ begin raise notice 'ALL PLATFORM TESTS PASSED'; end $$;
select 'ALL PLATFORM TESTS PASSED' as result;
rollback;
