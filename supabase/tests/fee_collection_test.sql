-- =====================================================================
-- Fee collection test (migrations 0001-0008). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL FEE COLLECTION TESTS PASSED".
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
-- pay(enrollment, key, [[due_id, amount]...], mode, reference, date)
create function private._t_pay(p_key uuid, p_allocs jsonb, p_mode text default 'cash', p_ref text default null,
                               p_date date default current_date) returns record language plpgsql as $$
declare r record;
begin
  select * into r from private.record_fee_payment('e6000000-0000-4000-8000-000000000001', p_date, p_mode::public.payment_mode,
                                                  p_ref, null, p_key, p_allocs);
  return r;
end $$;
create function private._t_due(p_head text, p_month date) returns uuid language sql as $$
  select d.id from public.student_fee_dues d join public.fee_heads h on h.id = d.fee_head_id
  where d.enrollment_id = 'e6000000-0000-4000-8000-000000000001' and h.name = p_head and d.due_month = p_month;
$$;
create function private._t_balance(p_head text, p_month date) returns numeric language sql as $$
  select balance from private.student_fee_status('e6000000-0000-4000-8000-000000000001') where fee_head_name = p_head and due_month = p_month;
$$;
grant execute on function private._t_assert(boolean, text), private._t_eq(numeric, numeric, text), private._t_raises(text, text, text, text),
  private._t_as(uuid), private._t_pay(uuid, jsonb, text, text, date), private._t_due(text, date), private._t_balance(text, date) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a6000000-0000-4000-8000-000000000001', 'col-test-accountant@example.invalid'),
  ('a6000000-0000-4000-8000-000000000002', 'col-test-teacher@example.invalid'),
  ('a6000000-0000-4000-8000-000000000003', 'col-test-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b6000000-0000-4000-8000-00000000000a', 'Collection Test A', 'ZZCOL-A'),
  ('b6000000-0000-4000-8000-00000000000b', 'Collection Test B', 'ZZCOL-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-000000000001', 'accountant'),
  ('b6000000-0000-4000-8000-00000000000a', 'a6000000-0000-4000-8000-000000000002', 'teacher'),
  ('b6000000-0000-4000-8000-00000000000b', 'a6000000-0000-4000-8000-000000000003', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c6000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values ('d6000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-00000000000a', 'Class 5');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d6000000-0000-4000-8000-0000000000a1', 'b6000000-0000-4000-8000-00000000000a', 'd6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f6000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-00000000000a', 'Aarav Sharma', 'Rakesh', '2016-05-10', 'male', '9876543210'),
  ('f6000000-0000-4000-8000-000000000002', 'b6000000-0000-4000-8000-00000000000a', 'Diya Patel', 'Mehul', '2016-05-10', 'female', '9876543211');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('e6000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-00000000000a', 'f6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-0000000000a1', 'A1', '2026-04-01'),
  ('e6000000-0000-4000-8000-000000000002', 'b6000000-0000-4000-8000-00000000000a', 'f6000000-0000-4000-8000-000000000002', 'c6000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-0000000000a1', 'A2', '2026-04-01');
insert into public.fee_heads (id, school_id, name) values
  ('a7000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-00000000000a', 'Tuition Fee'),
  ('a7000000-0000-4000-8000-000000000002', 'b6000000-0000-4000-8000-00000000000a', 'Annual Fee'),
  ('a7000000-0000-4000-8000-000000000003', 'b6000000-0000-4000-8000-00000000000a', 'Transport Fee');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values
  ('a8000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-00000000000a', 'c6000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001');
insert into public.fee_structure_items (id, school_id, fee_structure_id, fee_head_id, amount, frequency, is_optional, billing_months) values
  ('a9000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 1500, 'monthly', false, null),
  ('a9000000-0000-4000-8000-000000000002', 'b6000000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002', 5000, 'yearly', false, null),
  ('a9000000-0000-4000-8000-000000000003', 'b6000000-0000-4000-8000-00000000000a', 'a8000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000003', 1000, 'monthly', true, '{1,2,3,4,7,8,9,10,11,12}');

-- ================= accountant =================
select private._t_as('a6000000-0000-4000-8000-000000000001');

-- ---------- dues come from the structure ----------
select private.sync_student_dues(array['e6000000-0000-4000-8000-000000000001'::uuid, 'e6000000-0000-4000-8000-000000000002'::uuid]);
select private._t_eq((select count(*) from public.student_fee_dues where enrollment_id = 'e6000000-0000-4000-8000-000000000001'), 13,
  '12 tuition dues + 1 annual; optional transport not included');
select private._t_eq((select total from private.enrollment_fee_totals(array['e6000000-0000-4000-8000-000000000001'::uuid])), 23000,
  'total due = 1500 x 12 + 5000');
insert into public.student_fee_optins (school_id, enrollment_id, fee_item_id)
  values ('b6000000-0000-4000-8000-00000000000a', 'e6000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000003');
select private.sync_student_dues(array['e6000000-0000-4000-8000-000000000001'::uuid]);
select private._t_eq((select total from private.enrollment_fee_totals(array['e6000000-0000-4000-8000-000000000001'::uuid])), 33000,
  'opting into transport adds 10 x 1000');
select private.sync_student_dues(array['e6000000-0000-4000-8000-000000000001'::uuid]);
select private._t_eq((select count(*) from public.student_fee_dues where enrollment_id = 'e6000000-0000-4000-8000-000000000001'), 23,
  'sync is idempotent');

-- ---------- full + partial payment in one receipt ----------
select private._t_assert((select r.receipt_number = 'ZZCOL-A/2026-27/000001' and not r.duplicate from private._t_pay(
  '11111111-1111-4111-8111-111111111111',
  jsonb_build_array(jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-04-01'), 'amount', '1500'),
                    jsonb_build_object('due_id', private._t_due('Annual Fee', '2026-04-01'), 'amount', '2000'))) as r(payment_id uuid, receipt_number text, duplicate boolean)),
  'first receipt is ZZCOL-A/2026-27/000001');
select private._t_eq((select amount from public.fee_payments where receipt_number = 'ZZCOL-A/2026-27/000001'), 3500, 'receipt total = 1500 + 2000');
select private._t_eq((select balance_after from public.fee_payments where receipt_number = 'ZZCOL-A/2026-27/000001'), 29500, 'balance after = 33000 - 3500');
select private._t_eq(private._t_balance('Tuition Fee', '2026-04-01'), 0, 'April tuition fully paid');
select private._t_eq(private._t_balance('Annual Fee', '2026-04-01'), 3000, 'annual fee partly paid: 3000 left');

-- ---------- duplicate submission returns the same receipt ----------
select private._t_assert((select r.receipt_number = 'ZZCOL-A/2026-27/000001' and r.duplicate from private._t_pay(
  '11111111-1111-4111-8111-111111111111',
  jsonb_build_array(jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '1500'))) as r(payment_id uuid, receipt_number text, duplicate boolean)),
  'a repeated submission returns the original receipt');
select private._t_eq((select count(*) from public.fee_payments where school_id = 'b6000000-0000-4000-8000-00000000000a'), 1, 'no second payment was created');
select private._t_eq(private._t_balance('Tuition Fee', '2026-05-01'), 1500, 'May tuition untouched by the duplicate');

-- ---------- multiple payments: settle the annual fee ----------
select private._t_assert((select r.receipt_number = 'ZZCOL-A/2026-27/000002' from private._t_pay(
  '22222222-2222-4222-8222-222222222222',
  jsonb_build_array(jsonb_build_object('due_id', private._t_due('Annual Fee', '2026-04-01'), 'amount', '3000')), 'upi', 'UTR123456') as r(payment_id uuid, receipt_number text, duplicate boolean)),
  'second receipt is numbered 000002');
select private._t_eq(private._t_balance('Annual Fee', '2026-04-01'), 0, 'annual fee settled over two payments');

-- ---------- refusals ----------
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '1600')))$q$,
  '23514', 'no payment above the outstanding balance', '₹1500.00 outstanding');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(jsonb_build_object('due_id', private._t_due('Annual Fee', '2026-04-01'), 'amount', '1')))$q$,
  '23514', 'nothing can be paid on a settled fee', '₹0.00 outstanding');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '100')), 'cheque', null)$q$,
  '23514', 'cheque payments need a reference number');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '100')), 'cash', null, current_date + 1)$q$,
  '23514', 'no future-dated payments', 'future');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '0')))$q$,
  '23514', 'zero amounts are refused');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '10.555')))$q$,
  '23514', 'at most 2 decimals');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(
    jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '100'),
    jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '100')))$q$,
  '23514', 'the same fee can''t appear twice', 'twice');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(jsonb_build_object('due_id',
    (select id from public.student_fee_dues where enrollment_id = 'e6000000-0000-4000-8000-000000000002' limit 1), 'amount', '100')))$q$,
  '23514', 'cannot pay another student''s fee on this receipt', 'doesn''t belong');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), '[]'::jsonb)$q$, '23514', 'a payment needs at least one fee');

-- ---------- paid dues are frozen; unpaid dues follow the structure ----------
select private._t_raises($q$update public.student_fee_dues set amount = 1 where id = private._t_due('Tuition Fee', '2026-04-01')$q$,
  '23514', 'a paid due cannot change', 'already has payments');
update public.fee_structure_items set amount = 1600 where id = 'a9000000-0000-4000-8000-000000000001';
select private.sync_student_dues(array['e6000000-0000-4000-8000-000000000001'::uuid]);
select private._t_eq((select amount from public.student_fee_dues where id = private._t_due('Tuition Fee', '2026-04-01')), 1500, 'paid April tuition keeps its original amount');
select private._t_eq((select amount from public.student_fee_dues where id = private._t_due('Tuition Fee', '2026-05-01')), 1600, 'unpaid May tuition follows the new amount');
select private._t_raises($q$delete from public.fee_structure_items where id = 'a9000000-0000-4000-8000-000000000001'$q$,
  '23001', 'a fee with payments can''t be removed from the structure', 'Payments have been recorded');
delete from public.student_fee_optins where enrollment_id = 'e6000000-0000-4000-8000-000000000001';
select private.sync_student_dues(array['e6000000-0000-4000-8000-000000000001'::uuid]);
select private._t_eq((select count(*) from public.student_fee_dues d where d.enrollment_id = 'e6000000-0000-4000-8000-000000000001'
  and d.fee_item_id = 'a9000000-0000-4000-8000-000000000003'), 0, 'opting out removes unpaid transport dues');

-- ---------- receipts are permanent ----------
select private._t_raises($q$update public.fee_payments set amount = 1$q$, '42501', 'payments cannot be edited');
select private._t_raises($q$delete from public.fee_payments$q$, '42501', 'payments cannot be deleted');
select private._t_raises($q$delete from public.fee_payment_allocations$q$, '42501', 'allocations cannot be deleted');
select private._t_raises($q$update public.fee_payment_allocations set amount = 1$q$, '42501', 'allocations cannot be edited');
select private._t_raises($q$delete from public.fee_heads$q$, '42501', 'fee heads cannot be deleted');
reset role;

-- ================= teacher: no access =================
select private._t_as('a6000000-0000-4000-8000-000000000002');
select private._t_eq((select count(*) from public.fee_payments) + (select count(*) from public.student_fee_dues), 0, 'teachers see no fee records');
select private._t_raises($q$select * from private.record_fee_payment('e6000000-0000-4000-8000-000000000001', current_date, 'cash', null, null, gen_random_uuid(),
  jsonb_build_array(jsonb_build_object('due_id', 'a6000000-0000-4000-8000-000000000099', 'amount', '1')))$q$,
  'P0002', 'teachers cannot record payments (since Phase 14 they can''t even see the student)');
reset role;

-- ================= admin B: isolation =================
select private._t_as('a6000000-0000-4000-8000-000000000003');
select private._t_raises($q$select private.next_counter('b6000000-0000-4000-8000-00000000000a', 'receipt:x')$q$,
  '42501', 'admin B cannot advance School A''s receipt counter');
select private._t_eq((select count(*) from public.fee_payments where school_id = 'b6000000-0000-4000-8000-00000000000a'), 0, 'admin B sees no School A receipts');
select private._t_raises($q$select * from private.record_fee_payment('e6000000-0000-4000-8000-000000000001', current_date, 'cash', null, null, gen_random_uuid(), '[]')$q$,
  'P0002', 'admin B cannot pay into School A');
reset role;

-- ---------- archived session ----------
update public.academic_sessions set archived_at = now(), is_current = false where id = 'c6000000-0000-4000-8000-000000000001';
select private._t_as('a6000000-0000-4000-8000-000000000001');
select private._t_raises($q$select private._t_pay(gen_random_uuid(), jsonb_build_array(jsonb_build_object('due_id', private._t_due('Tuition Fee', '2026-05-01'), 'amount', '100')))$q$,
  '23514', 'no payments into an archived session', 'archived');
reset role;

select 'ALL FEE COLLECTION TESTS PASSED' as result;
rollback;
