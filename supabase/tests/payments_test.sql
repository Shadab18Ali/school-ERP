-- =====================================================================
-- Online payments test (migrations 0001-0019). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL PAYMENT TESTS PASSED".
-- School A (ZZPY-A): one child with ₹1,000 monthly dues (April paid in cash),
-- linked to Parent 1; another child linked to Parent 2. Admin, accountant and
-- teacher of A; admin of B. "erp_payments" stands in for the API's gateway work.
-- =====================================================================
begin;

create function private._p_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._p_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._p_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._p_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function private._p_worker() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('role', 'erp_payments', true);
end $$;
-- balance still owed on a due month of child 1
create function private._p_owed(p_month date) returns numeric language sql security definer set search_path = '' as $$
  select d.amount - coalesce((select sum(a.amount) from public.fee_payment_allocations a where a.due_id = d.id), 0)
  from public.student_fee_dues d where d.enrollment_id = 'e2100000-0000-4000-8000-000000000001' and d.due_month = p_month;
$$;
create function private._p_due(p_month date) returns uuid language sql security definer set search_path = '' as $$
  select id from public.student_fee_dues where enrollment_id = 'e2100000-0000-4000-8000-000000000001' and due_month = p_month;
$$;
grant execute on function private._p_assert(boolean, text), private._p_eq(numeric, numeric, text), private._p_raises(text, text, text, text),
  private._p_as(uuid), private._p_worker(), private._p_owed(date), private._p_due(date) to authenticated, erp_payments;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a2100000-0000-4000-8000-000000000001', 'py-admin@example.invalid'),
  ('a2100000-0000-4000-8000-000000000002', 'py-accountant@example.invalid'),
  ('a2100000-0000-4000-8000-000000000003', 'py-teacher@example.invalid'),
  ('a2100000-0000-4000-8000-000000000004', 'py-parent-1@example.invalid'),
  ('a2100000-0000-4000-8000-000000000005', 'py-parent-2@example.invalid'),
  ('a2100000-0000-4000-8000-000000000006', 'py-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b2100000-0000-4000-8000-00000000000a', 'Payments A', 'ZZPY-A'),
  ('b2100000-0000-4000-8000-00000000000b', 'Payments B', 'ZZPY-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b2100000-0000-4000-8000-00000000000a', 'a2100000-0000-4000-8000-000000000001', 'school_admin'),
  ('b2100000-0000-4000-8000-00000000000a', 'a2100000-0000-4000-8000-000000000002', 'accountant'),
  ('b2100000-0000-4000-8000-00000000000a', 'a2100000-0000-4000-8000-000000000003', 'teacher'),
  ('b2100000-0000-4000-8000-00000000000a', 'a2100000-0000-4000-8000-000000000004', 'parent'),
  ('b2100000-0000-4000-8000-00000000000a', 'a2100000-0000-4000-8000-000000000005', 'parent'),
  ('b2100000-0000-4000-8000-00000000000b', 'a2100000-0000-4000-8000-000000000006', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c2100000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d2100000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-00000000000a', 'Class 1');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d2100000-0000-4000-8000-0000000000a1', 'b2100000-0000-4000-8000-00000000000a', 'd2100000-0000-4000-8000-000000000001', 'c2100000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f2100000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-00000000000a', 'Child One', 'Parent One', '2019-01-01', 'male', '9800000011'),
  ('f2100000-0000-4000-8000-000000000002', 'b2100000-0000-4000-8000-00000000000a', 'Child Two', 'Parent Two', '2019-02-02', 'female', '9800000022');
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('e2100000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-00000000000a', 'f2100000-0000-4000-8000-000000000001', 'c2100000-0000-4000-8000-000000000001', 'd2100000-0000-4000-8000-000000000001', 'd2100000-0000-4000-8000-0000000000a1', 'P1', '2026-04-01'),
  ('e2100000-0000-4000-8000-000000000002', 'b2100000-0000-4000-8000-00000000000a', 'f2100000-0000-4000-8000-000000000002', 'c2100000-0000-4000-8000-000000000001', 'd2100000-0000-4000-8000-000000000001', 'd2100000-0000-4000-8000-0000000000a1', 'P2', '2026-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b2100000-0000-4000-8000-00000000000a', 'f2100000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000004', 'father'),
  ('b2100000-0000-4000-8000-00000000000a', 'f2100000-0000-4000-8000-000000000002', 'a2100000-0000-4000-8000-000000000005', 'mother');
insert into public.fee_heads (id, school_id, name) values
  ('a2a00000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-00000000000a', 'Tuition Fee');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values
  ('a2b00000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-00000000000a', 'c2100000-0000-4000-8000-000000000001', 'd2100000-0000-4000-8000-000000000001');
insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency) values
  ('b2100000-0000-4000-8000-00000000000a', 'a2b00000-0000-4000-8000-000000000001', 'a2a00000-0000-4000-8000-000000000001', 1000, 'monthly');
select private.sync_student_dues(array['e2100000-0000-4000-8000-000000000001'::uuid, 'e2100000-0000-4000-8000-000000000002'::uuid]);
-- April paid at the office
select private._p_as('a2100000-0000-4000-8000-000000000002');
select * from private.record_fee_payment('e2100000-0000-4000-8000-000000000001', current_date, 'cash', null, null, gen_random_uuid(),
  jsonb_build_array(jsonb_build_object('due_id', private._p_due('2026-04-01'), 'amount', 1000)));

-- ================= the gateway account =================
select private._p_as('a2100000-0000-4000-8000-000000000004');
select private._p_raises($q$select * from private.prepare_online_payment('f2100000-0000-4000-8000-000000000001', array[private._p_due('2026-05-01')])$q$,
  '23514', 'no online payment before the school sets up its gateway', 'isn''t available');
select private._p_raises($q$select private.save_gateway_account('b2100000-0000-4000-8000-00000000000a', 'rzp_test_AbCdEf123456', 'enc-secret', 'enc-hook', true)$q$,
  '42501', 'parents can''t set the gateway');
select private._p_as('a2100000-0000-4000-8000-000000000002');
select private._p_raises($q$select private.save_gateway_account('b2100000-0000-4000-8000-00000000000a', 'rzp_test_AbCdEf123456', 'enc-secret', 'enc-hook', true)$q$,
  '42501', 'accountants can''t set the gateway');
select private._p_as('a2100000-0000-4000-8000-000000000001');
select private._p_raises($q$select private.save_gateway_account('b2100000-0000-4000-8000-00000000000a', 'rzp_test_AbCdEf123456', null, null, false)$q$,
  '23514', 'the key secret is required the first time', 'key secret');
select private._p_raises($q$select private.save_gateway_account('b2100000-0000-4000-8000-00000000000a', 'rzp_test_AbCdEf123456', 'enc-secret', null, true)$q$,
  '23514', 'no switching on without a webhook secret', 'webhook secret');
select private._p_raises($q$select private.save_gateway_account('b2100000-0000-4000-8000-00000000000a', 'sk_live_whatever', 'enc-secret', 'enc-hook', true)$q$,
  '23514', 'the key id must look like a Razorpay key');
select private.save_gateway_account('b2100000-0000-4000-8000-00000000000a', 'rzp_test_AbCdEf123456', 'enc-secret', 'enc-hook', true);
select private.save_gateway_account('b2100000-0000-4000-8000-00000000000a', 'rzp_test_AbCdEf123456', null, null, true);  -- empty = keep
select private._p_assert((select key_id = 'rzp_test_AbCdEf123456' and is_enabled and mode = 'test' and has_webhook_secret
  from private.gateway_account_info('b2100000-0000-4000-8000-00000000000a')), 'admins see the key id and mode, not the secrets');
select private._p_raises($q$select * from private.payment_gateway_accounts$q$, '42501', 'the secrets table can''t be read, even by admins');
select private._p_raises($q$select * from private.pay_gateway_secrets('b2100000-0000-4000-8000-00000000000a')$q$, '42501', 'admins can''t read the encrypted secrets');
select private._p_as('a2100000-0000-4000-8000-000000000004');
select private._p_eq((select count(*) from private.gateway_account_info('b2100000-0000-4000-8000-00000000000a')), 0, 'parents see nothing of the account');
select private._p_assert(private.online_payments_enabled('b2100000-0000-4000-8000-00000000000a'), 'but they know online payment is on');
select private._p_as('a2100000-0000-4000-8000-000000000006');
select private._p_assert(not private.online_payments_enabled('b2100000-0000-4000-8000-00000000000a'), 'another school''s admin learns nothing');
reset role;
select private._p_worker();
select private._p_assert((select key_secret_enc = 'enc-secret' and webhook_secret_enc = 'enc-hook'
  from private.pay_gateway_secrets('b2100000-0000-4000-8000-00000000000a')), 'the API''s gateway role reads the (encrypted) secrets; empty input kept them');

-- ================= a parent starts a payment =================
reset role;
select private._p_as('a2100000-0000-4000-8000-000000000004');
select private._p_raises($q$select * from private.prepare_online_payment('f2100000-0000-4000-8000-000000000002', array[(select id from public.student_fee_dues where enrollment_id = 'e2100000-0000-4000-8000-000000000002' limit 1)])$q$,
  'P0002', 'a parent can''t pay for someone else''s child');
select private._p_raises($q$select * from private.prepare_online_payment('f2100000-0000-4000-8000-000000000001', array[private._p_due('2026-04-01')])$q$,
  '23514', 'a paid fee can''t be paid again', 'already paid');
select private._p_raises($q$select * from private.prepare_online_payment('f2100000-0000-4000-8000-000000000001', array[]::uuid[])$q$,
  '23514', 'something must be chosen', 'at least one');
select set_config('t.o1', (select online_payment_id from private.prepare_online_payment('f2100000-0000-4000-8000-000000000001', array[private._p_due('2026-05-01'), private._p_due('2026-06-01')]))::text, false);
select private._p_assert((select amount = 2000 and gateway_order_id is null from public.online_payments where id = current_setting('t.o1')::uuid), 'the amount comes from the dues: ₹2,000');
select private._p_assert((select o.allocations = jsonb_build_array(jsonb_build_object('due_id', private._p_due('2026-05-01'), 'amount', 1000.00),
  jsonb_build_object('due_id', private._p_due('2026-06-01'), 'amount', 1000.00)) and o.status = 'created' and o.initiated_by = 'a2100000-0000-4000-8000-000000000004'
  from public.online_payments o where o.id = current_setting('t.o1')::uuid), 'the fees paid are fixed on the order');
select private._p_raises($q$select private.pay_attach_order(current_setting('t.o1')::uuid, 'order_FAKE')$q$, '42501', 'parents can''t run gateway functions');
select private._p_raises($q$select * from private.pay_apply(current_setting('t.o1')::uuid, 'pay_FAKE', 2000, 'upi', null, 'checkout')$q$, '42501', 'parents can''t mark a payment paid');
select private._p_raises($q$update public.online_payments set status = 'paid'$q$, '42501', 'parents can''t change payments');
select private._p_raises($q$insert into public.online_payments (school_id, student_id, enrollment_id, academic_session_id, amount, allocations, description)
  values ('b2100000-0000-4000-8000-00000000000a', 'f2100000-0000-4000-8000-000000000001', 'e2100000-0000-4000-8000-000000000001', 'c2100000-0000-4000-8000-000000000001', 1, '[]', 'x')$q$,
  '42501', 'nor create them directly');
reset role;
select private._p_as('a2100000-0000-4000-8000-000000000001');
select private._p_raises($q$select * from private.pay_apply(current_setting('t.o1')::uuid, 'pay_FAKE', 2000, 'upi', null, 'checkout')$q$, '42501', 'not even admins');
reset role;
select private._p_worker();
select private.pay_attach_order(current_setting('t.o1')::uuid, 'order_T1');
reset role;
select private._p_as('a2100000-0000-4000-8000-000000000004');
select private._p_assert((select reused and gateway_order_id = 'order_T1' and online_payment_id = current_setting('t.o1')::uuid
  from private.prepare_online_payment('f2100000-0000-4000-8000-000000000001', array[private._p_due('2026-06-01'), private._p_due('2026-05-01')])),
  'starting the same payment again continues the same order');
select set_config('t.o2', (select online_payment_id from private.prepare_online_payment('f2100000-0000-4000-8000-000000000001', array[private._p_due('2026-07-01')]))::text, false);
select set_config('t.o3', (select online_payment_id from private.prepare_online_payment('f2100000-0000-4000-8000-000000000001', array[private._p_due('2026-08-01')]))::text, false);
select private._p_eq((select count(*) from public.online_payments), 3, 'the parent sees their child''s orders');
select private._p_as('a2100000-0000-4000-8000-000000000005');
select private._p_eq((select count(*) from public.online_payments), 0, 'another parent sees none');
select private._p_as('a2100000-0000-4000-8000-000000000003');
select private._p_eq((select count(*) from public.online_payments), 0, 'teachers see none');
select private._p_as('a2100000-0000-4000-8000-000000000006');
select private._p_eq((select count(*) from public.online_payments), 0, 'another school sees none');
select private._p_as('a2100000-0000-4000-8000-000000000002');
select private._p_eq((select count(*) from public.online_payments), 3, 'the accountant sees all of the school''s');

-- ================= the gateway confirms =================
reset role;
select private._p_worker();
select private._p_assert((select status = 'paid' and receipt_number like 'ZZPY-A/2026-27/%' from private.pay_apply(current_setting('t.o1')::uuid, 'pay_T1', 2000, 'upi', 'UPI · ra***@okaxis', 'checkout')),
  'a verified payment records a receipt');
reset role;
select private._p_assert((select fp.payment_mode = 'online' and fp.reference_number = 'pay_T1' and fp.amount = 2000 and fp.received_by_name = 'Online payment'
  and fp.remarks = 'Paid online (UPI · ra***@okaxis)'
  from public.fee_payments fp join public.online_payments o on o.fee_payment_id = fp.id where o.id = current_setting('t.o1')::uuid),
  'the receipt says it was paid online, with the gateway payment id');
select private._p_assert(private._p_owed('2026-05-01') = 0 and private._p_owed('2026-06-01') = 0, 'May and June are paid');
select private._p_eq((select count(*) from private.counter_grants), 0, 'the receipt-number permission ends with the payment');
select private._p_as('a2100000-0000-4000-8000-000000000004');
select private._p_raises($q$select private.next_counter('b2100000-0000-4000-8000-00000000000a', 'receipt:x')$q$, '42501', 'parents still can''t take receipt numbers');
reset role;
select private._p_worker();
select private._p_assert((select status = 'paid' and receipt_number is not null from private.pay_apply(current_setting('t.o1')::uuid, 'pay_T1', 2000, 'upi', null, 'webhook')),
  'the webhook arriving too gets the same answer');
reset role;
select private._p_eq((select count(*) from public.fee_payments where payment_mode = 'online'), 1, 'and no second receipt');
select private._p_assert((select verified_via = 'checkout' from public.online_payments where id = current_setting('t.o1')::uuid), 'the first verification is kept');
select private._p_worker();
select private._p_raises($q$select * from private.pay_apply(current_setting('t.o1')::uuid, 'pay_OTHER', 2000, 'upi', null, 'webhook')$q$,
  '23514', 'a second, different payment for one order is refused', 'another payment');

-- a failed attempt, then a successful retry on the same order
select private.pay_attach_order(current_setting('t.o2')::uuid, 'order_T2');
select private.pay_mark_failed(current_setting('t.o2')::uuid, 'pay_F2', 'Payment declined by bank');
reset role;
select private._p_assert((select status = 'failed' and failure_reason = 'Payment declined by bank' from public.online_payments where id = current_setting('t.o2')::uuid),
  'a failed attempt is recorded');
select private._p_worker();
select private._p_assert((select status = 'paid' from private.pay_apply(current_setting('t.o2')::uuid, 'pay_T2', 1000, 'card', 'Visa •••• 1111', 'webhook')),
  'a later successful attempt on the same order is accepted');
select private.pay_mark_failed(current_setting('t.o2')::uuid, 'pay_LATE', 'late failure');
reset role;
select private._p_assert((select status = 'paid' from public.online_payments where id = current_setting('t.o2')::uuid), 'a late failure can''t undo a payment');

-- August: paid at the office meanwhile, then online too -> parked for review, no receipt
select private._p_as('a2100000-0000-4000-8000-000000000002');
select * from private.record_fee_payment('e2100000-0000-4000-8000-000000000001', current_date, 'cash', null, null, gen_random_uuid(),
  jsonb_build_array(jsonb_build_object('due_id', private._p_due('2026-08-01'), 'amount', 1000)));
reset role;
select private._p_worker();
select private.pay_attach_order(current_setting('t.o3')::uuid, 'order_T3');
select private._p_assert((select status = 'needs_review' and fee_payment_id is null from private.pay_apply(current_setting('t.o3')::uuid, 'pay_T3', 1000, 'netbanking', 'HDFC', 'webhook')),
  'money for a fee already paid is parked for review');
reset role;
select private._p_assert((select failure_reason like 'Paid, but the receipt could not be recorded:%outstanding%' from public.online_payments where id = current_setting('t.o3')::uuid),
  'with the reason');
select private._p_eq(private._p_owed('2026-08-01'), 0, 'August was paid once, not twice');

-- the gateway reporting a different amount is never accepted as paid
select private._p_as('a2100000-0000-4000-8000-000000000004');
select set_config('t.o4', (select online_payment_id from private.prepare_online_payment('f2100000-0000-4000-8000-000000000001', array[private._p_due('2026-09-01')]))::text, false);
reset role;
select private._p_worker();
select private.pay_attach_order(current_setting('t.o4')::uuid, 'order_T4');
select private._p_assert((select status = 'needs_review' from private.pay_apply(current_setting('t.o4')::uuid, 'pay_T4', 1.00, 'upi', null, 'webhook')),
  'a wrong amount is parked, not counted');
reset role;
select private._p_eq(private._p_owed('2026-09-01'), 1000, 'September is still owed');

-- ================= refunds =================
select private._p_worker();
select private._p_raises($q$select private.pay_record_refund(current_setting('t.o1')::uuid, 'rfnd_X', 500, 'processed', 'Paid twice', null)$q$,
  '23514', 'only full refunds', 'full refunds');
select private._p_eq((select count(*) from private.pay_lock_for_refund(current_setting('t.o1')::uuid, 'b2100000-0000-4000-8000-00000000000b')), 0,
  'a payment can''t be reached through another school');
select private._p_assert(private.pay_record_refund(current_setting('t.o1')::uuid, 'rfnd_T1', 2000, 'processed', 'Paid twice by mistake', 'a2100000-0000-4000-8000-000000000001') = 'refunded',
  'a full refund');
reset role;
select private._p_assert((select fp.cancelled_at is not null and fp.cancel_reason = 'Refunded online: Paid twice by mistake'
  and jsonb_array_length(fp.cancelled_allocations) = 2 and fp.cancelled_by = 'a2100000-0000-4000-8000-000000000001'
  and not exists (select 1 from public.fee_payment_allocations a where a.payment_id = fp.id)
  from public.fee_payments fp join public.online_payments o on o.fee_payment_id = fp.id where o.id = current_setting('t.o1')::uuid),
  'the receipt is cancelled and what it paid is kept on record');
select private._p_assert(private._p_owed('2026-05-01') = 1000 and private._p_owed('2026-06-01') = 1000, 'May and June are payable again');
select private._p_worker();
select private._p_raises($q$select private.pay_record_refund(current_setting('t.o1')::uuid, 'rfnd_T1b', 2000, 'processed', 'Again', null)$q$,
  '23514', 'no second refund', 'completed payment');
-- the parked August payment: refund pending, then processed (reported twice)
select private._p_assert(private.pay_record_refund(current_setting('t.o3')::uuid, 'rfnd_T3', 1000, 'pending', 'Already paid at the office', null) = 'refund_pending',
  'refunding a parked payment');
select private._p_assert(private.pay_refund_update('b2100000-0000-4000-8000-00000000000a', 'rfnd_T3', 'processed', null), 'the gateway confirms the refund');
select private._p_assert(not private.pay_refund_update('b2100000-0000-4000-8000-00000000000a', 'rfnd_T3', 'processed', null), 'a repeated confirmation changes nothing');
reset role;
select private._p_assert((select o.status = 'refunded' and o.refunded_amount = 1000 and r.status = 'processed' and r.processed_at is not null
  from public.online_payments o join public.online_payment_refunds r on r.online_payment_id = o.id where o.id = current_setting('t.o3')::uuid),
  'refund processed');
select private._p_eq(private._p_owed('2026-08-01'), 0, 'August stays paid (the office receipt is untouched)');
-- a refund that fails can be tried again
select private._p_worker();
select private.pay_record_refund(current_setting('t.o2')::uuid, 'rfnd_T2', 1000, 'pending', 'Wrong child', null);
select private.pay_refund_update('b2100000-0000-4000-8000-00000000000a', 'rfnd_T2', 'failed', 'Bank rejected the refund');
reset role;
select private._p_assert((select status = 'refund_failed' and refunded_amount = 0 from public.online_payments where id = current_setting('t.o2')::uuid), 'a failed refund is shown');
select private._p_worker();
select private._p_assert(private.pay_record_refund(current_setting('t.o2')::uuid, 'rfnd_T2b', 1000, 'processed', 'Wrong child (retry)', null) = 'refunded', 'and retried');
reset role;

-- staff and parents see refunds; history can't be edited
select private._p_as('a2100000-0000-4000-8000-000000000004');
select private._p_eq((select count(*) from public.online_payment_refunds), 4, 'the parent sees the refunds of their payments');
select private._p_raises($q$update public.online_payment_refunds set status = 'processed'$q$, '42501', 'refunds can''t be edited');
select private._p_as('a2100000-0000-4000-8000-000000000005');
select private._p_eq((select count(*) from public.online_payment_refunds), 0, 'another parent sees none');
select private._p_as('a2100000-0000-4000-8000-000000000002');
select private._p_raises($q$update public.fee_payments set cancelled_at = null$q$, '42501', 'a cancelled receipt can''t be restored by hand');

-- ================= webhooks are deduplicated =================
reset role;
select private._p_worker();
select private._p_assert(private.pay_log_event('b2100000-0000-4000-8000-00000000000a', 'evt_1', 'payment.captured', 'order_T1', 'pay_T1', 'received'), 'a new event is processed');
select private._p_assert(not private.pay_log_event('b2100000-0000-4000-8000-00000000000a', 'evt_1', 'payment.captured', 'order_T1', 'pay_T1', 'received'), 'the same event again is skipped');
reset role;
select private._p_as('a2100000-0000-4000-8000-000000000002');
select private._p_eq((select count(*) from public.payment_webhook_events), 1, 'staff can see webhook events');
select private._p_as('a2100000-0000-4000-8000-000000000004');
select private._p_eq((select count(*) from public.payment_webhook_events), 0, 'parents can''t');
reset role;
grant usage on schema private to anon;  -- test helpers only (rolled back)
grant execute on function private._p_raises(text, text, text, text) to anon;
set local role anon;
select private._p_raises($q$select count(*) from public.online_payments$q$, '42501', 'the public has no access');
reset role;

do $$ begin raise notice 'ALL PAYMENT TESTS PASSED'; end $$;
rollback;
