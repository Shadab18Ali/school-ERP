-- =====================================================================
-- Subscription billing test (migrations 0001-0030). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL BILLING TESTS PASSED".
--
-- The platform sells from Delhi at 18% GST. Plans (all figures entered here, none built in):
--   Basic   ₹1,000/month or ₹10,000/year, 14-day trial, 7 days' grace; 3 students, 1 teacher,
--           1 MB storage; reports only
--   Pro     ₹2,500/month, no trial, 5 days' grace; no limits; every feature
-- Schools: P (Delhi), Q (Karnataka), R (Delhi), S (Delhi), each with an admin; P also an accountant.
-- Every status is worked out from dates, invoices and payments — the test never sets one.
-- =====================================================================
begin;

create function private._b_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._b_eq(got anyelement, want anyelement, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._b_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function private._b_refused(q text, msg text) returns void language plpgsql as $$
declare n bigint;
begin
  begin execute q; get diagnostics n = row_count;
  exception when others then return; end;
  -- an update or delete that reaches no row is refused too (row-level security hides the rows)
  if n > 0 then raise exception 'FAIL: % (was allowed: % row(s))', msg, n using errcode = 'ZT001'; end if;
end $$;
create function private._b_refused_with(q text, needle text, msg text) returns void language plpgsql as $$
begin
  begin execute q;
  exception when others then
    if sqlerrm not ilike '%' || needle || '%' then raise exception 'FAIL: % (refused, but with "%")', msg, sqlerrm using errcode = 'ZT001'; end if;
    return;
  end;
  raise exception 'FAIL: % (was allowed)', msg using errcode = 'ZT001';
end $$;
create function private._b_ss(s uuid) returns jsonb language sql security definer set search_path = '' as $$ select private.subscription_status(s) $$;
create function private._b_st(s uuid) returns text language sql security definer set search_path = '' as $$ select private.subscription_status(s) ->> 'status' $$;
create function private._b_t(n int) returns date language sql stable as $$ select private.ist_today() + n $$;
grant execute on function private._b_assert(boolean, text), private._b_eq(anyelement, anyelement, text), private._b_as(uuid),
  private._b_refused(text, text), private._b_refused_with(text, text, text), private._b_st(uuid), private._b_ss(uuid), private._b_t(int) to authenticated, erp_billing;

-- ---------- fixtures
insert into auth.users (id, email) values
  ('a7000000-0000-4000-8000-000000000001', 'bl-super@example.invalid'),
  ('a7000000-0000-4000-8000-000000000002', 'bl-admin-p@example.invalid'),
  ('a7000000-0000-4000-8000-000000000003', 'bl-acct-p@example.invalid'),
  ('a7000000-0000-4000-8000-000000000004', 'bl-admin-q@example.invalid'),
  ('a7000000-0000-4000-8000-000000000005', 'bl-admin-r@example.invalid');
update public.profiles set is_super_admin = true where id = 'a7000000-0000-4000-8000-000000000001';
insert into public.schools (id, name, code, state, address, city) values
  ('b7000000-0000-4000-8000-00000000000a', 'Billing School P', 'ZZBL-P', 'Delhi', '1 Ring Road', 'New Delhi'),
  ('b7000000-0000-4000-8000-00000000000b', 'Billing School Q', 'ZZBL-Q', 'Karnataka', '2 MG Road', 'Bengaluru'),
  ('b7000000-0000-4000-8000-00000000000c', 'Billing School R', 'ZZBL-R', 'Delhi', null, null),
  ('b7000000-0000-4000-8000-00000000000d', 'Billing School S', 'ZZBL-S', 'delhi ', null, null);
insert into public.school_memberships (school_id, user_id, role) values
  ('b7000000-0000-4000-8000-00000000000a', 'a7000000-0000-4000-8000-000000000002', 'school_admin'),
  ('b7000000-0000-4000-8000-00000000000a', 'a7000000-0000-4000-8000-000000000003', 'accountant'),
  ('b7000000-0000-4000-8000-00000000000b', 'a7000000-0000-4000-8000-000000000004', 'school_admin'),
  ('b7000000-0000-4000-8000-00000000000c', 'a7000000-0000-4000-8000-000000000005', 'school_admin');

select private._b_as('a7000000-0000-4000-8000-000000000001');   -- super admin sets up
insert into public.billing_settings (legal_name, gstin, address, state, invoice_prefix, tax_label, tax_rate, renewal_lead_days, payment_due_days)
values ('SchoolSoft Pvt Ltd', '07ABCDE1234F1Z5', 'Okhla, New Delhi', 'Delhi', 'TB', 'GST', 18.00, 7, 10);
insert into public.subscription_plans (id, code, name, price_monthly, price_yearly, trial_days, grace_period_days) values
  ('99700000-0000-4000-8000-000000000001', 'BL-BASIC', 'Basic', 1000.00, 10000.00, 14, 7),
  ('99700000-0000-4000-8000-000000000002', 'BL-PRO', 'Pro', 2500.00, 25000.00, 0, 5);
insert into public.plan_entitlements (plan_id, feature_key, included, limit_value) values
  ('99700000-0000-4000-8000-000000000001', 'students', true, 3),
  ('99700000-0000-4000-8000-000000000001', 'teachers', true, 1),
  ('99700000-0000-4000-8000-000000000001', 'storage_mb', true, 1),
  ('99700000-0000-4000-8000-000000000001', 'reports', true, null),
  ('99700000-0000-4000-8000-000000000001', 'analytics', false, null),
  ('99700000-0000-4000-8000-000000000001', 'whatsapp', false, null);
insert into public.plan_entitlements (plan_id, feature_key, included)
select '99700000-0000-4000-8000-000000000002', key, true from public.plan_features;

-- ================= entitlements are well-formed
select private._b_refused_with($q$insert into public.plan_entitlements (plan_id, feature_key, included, limit_value)
  values ('99700000-0000-4000-8000-000000000001', 'ai_assistant', true, 5)$q$, 'Only limits', 'a feature takes no number');
select private._b_refused_with($q$update public.plan_entitlements set included = false where plan_id = '99700000-0000-4000-8000-000000000001' and feature_key = 'students'$q$,
  'always included', 'a limit can''t be switched off');
select private._b_as('a7000000-0000-4000-8000-000000000002');
select private._b_refused($q$update public.plan_entitlements set limit_value = 999$q$, 'a school admin can''t change entitlements');
select private._b_refused($q$insert into public.billing_settings (legal_name, address, state, invoice_prefix, tax_label, tax_rate, renewal_lead_days, payment_due_days) values ('x','y','z','A','GST',0,1,1)$q$,
  'nor billing settings');

-- ================= no subscription: no limits
select private._b_eq(private.school_features('b7000000-0000-4000-8000-00000000000a'), null::text[], 'no subscription: every feature');
select private._b_eq(private.school_access('b7000000-0000-4000-8000-00000000000a'), 'full', 'and full access');
reset role;
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000a'), 'none', 'status: none');

-- ================= P: Basic, monthly, on a 14-day trial
select private._b_as('a7000000-0000-4000-8000-000000000001');
insert into public.school_subscriptions (school_id, plan_id, billing_cycle, started_on, trial_ends_at)
values ('b7000000-0000-4000-8000-00000000000a', '99700000-0000-4000-8000-000000000001', 'monthly', private._b_t(0), private._b_t(14));
reset role;
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000a'), 'trialing', 'P: on trial');
select private._b_eq(private.school_features('b7000000-0000-4000-8000-00000000000a'), array['reports'], 'P: features from the plan');
select private._b_eq(private.school_has_feature('b7000000-0000-4000-8000-00000000000a', 'analytics'), false, 'P: no analytics');
select private._b_eq(private.school_limit('b7000000-0000-4000-8000-00000000000a', 'students'), 3::bigint, 'P: 3 students');
select private._b_eq(private.school_limit('b7000000-0000-4000-8000-00000000000a', 'ai_assistant'), null::bigint, 'a feature has no number');
select private._b_eq(private.billing_run(), 0, 'billing run: the first period is 15 days away, beyond the 7-day lead');
update public.school_subscriptions set trial_ends_at = private._b_t(0) where school_id = 'b7000000-0000-4000-8000-00000000000a';
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000a'), 'trialing', 'the trial''s last day is still the trial');

-- trial ends in 3 days: the first invoice is issued for the period after it
update public.school_subscriptions set trial_ends_at = private._b_t(3) where school_id = 'b7000000-0000-4000-8000-00000000000a';
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private._b_eq(private.billing_run(), 1, 'billing run: P''s first invoice');
select private._b_eq(private.billing_run(), 0, 'run again: nothing more while it is unpaid');
reset role;
create temp table ip on commit drop as select * from public.subscription_invoices where school_id = 'b7000000-0000-4000-8000-00000000000a';
grant select on ip to authenticated, erp_billing;
select private._b_eq((select jsonb_build_array(kind, period_start, period_end, subtotal, cgst, sgst, igst, tax_amount, total, due_on) from ip),
  jsonb_build_array('subscription', private._b_t(4), (private._b_t(4) + interval '1 month' - interval '1 day')::date, 1000.00, 90.00, 90.00, 0.00, 180.00, 1180.00, private._b_t(10)),
  'P invoice: after the trial, one month, CGST + SGST 9% each (same state), due 10 days after issue');
select private._b_assert((select invoice_number ~ '^TB/20[0-9]{2}-[0-9]{2}/00001$' from ip), 'numbered TB/<financial year>/00001');
select private._b_eq((select seller ->> 'gstin' || ' | ' || (buyer ->> 'name') from ip), '07ABCDE1234F1Z5 | Billing School P', 'seller and buyer recorded on the invoice');
select private._b_eq(private.invoice_state((select id from ip)), 'open', 'invoice open');
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000a'), 'trialing', 'still on trial');

-- ================= Q: Basic yearly, no trial, from another state
select private._b_as('a7000000-0000-4000-8000-000000000001');
insert into public.school_subscriptions (school_id, plan_id, billing_cycle, started_on, billing_gstin)
values ('b7000000-0000-4000-8000-00000000000b', '99700000-0000-4000-8000-000000000001', 'yearly', private._b_t(0), '29ABCDE1234F1Z5');
create temp table iq on commit drop as select private.billing_issue_invoice('b7000000-0000-4000-8000-00000000000b', private._b_t(0), 'subscription') as id;
grant select on iq to authenticated, erp_billing;
select private._b_eq((select jsonb_build_array(subtotal, cgst, sgst, igst, total, period_end, buyer ->> 'gstin') from public.subscription_invoices where id = (select id from iq)),
  jsonb_build_array(10000.00, 0.00, 0.00, 1800.00, 11800.00, (private._b_t(0) + interval '1 year' - interval '1 day')::date, '29ABCDE1234F1Z5'),
  'Q invoice: a year, IGST 18% (another state), with the school''s GSTIN');
select private._b_assert((select invoice_number like '%/00002' from public.subscription_invoices where id = (select id from iq)), 'numbers continue: 00002');
select private._b_refused_with($q$select private.billing_issue_invoice('b7000000-0000-4000-8000-00000000000b', private._b_t(0), 'subscription')$q$,
  'already an invoice', 'one invoice per period');
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000b'), 'grace', 'Q: unpaid first invoice → grace (awaiting payment)');
select private._b_eq(private.school_access('b7000000-0000-4000-8000-00000000000b'), 'full', 'with full access');

-- payments by hand
select private._b_refused_with($q$select private.billing_record_payment((select id from iq), 20000, 'bank_transfer', null, 'UTR1', private._b_t(0), 'manual', null, null)$q$,
  'more than', 'can''t record more than is due');
select private._b_refused_with($q$select private.billing_record_payment((select id from iq), 100, 'bank_transfer', null, 'UTR1', private._b_t(1), 'manual', null, null)$q$,
  'future', 'nor a future date');
select private._b_refused($q$select private.billing_record_payment((select id from iq), 100, 'bank_transfer', null, null, private._b_t(0), 'manual', null, null)$q$,
  'a bank transfer needs its reference');
select private.billing_record_payment((select id from iq), 5000, 'bank_transfer', null, 'UTR-111', private._b_t(0), 'manual', null, null);
select private._b_eq(private.invoice_state((select id from iq)), 'partly_paid', 'part paid');
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000b'), 'grace', 'part paid is not paid: still grace');
select private._b_eq(private._b_ss('b7000000-0000-4000-8000-00000000000b') ->> 'paid_through', null, 'and not paid through anything');
select private._b_eq(private._b_ss('b7000000-0000-4000-8000-00000000000b') ->> 'grace_until', private._b_t(10)::text,
  'grace: not before the first invoice falls due (10 payment days, later than 7 grace days from the start)');
select private.billing_record_payment((select id from iq), 6800, 'upi', null, 'UPI-222', private._b_t(0), 'manual', null, null);
select private._b_eq(private.invoice_state((select id from iq)), 'paid', 'paid in full');
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000b'), 'active', 'Q: active once paid');
select private._b_eq(private._b_ss('b7000000-0000-4000-8000-00000000000b') ->> 'paid_through',
  ((private._b_t(0) + interval '1 year' - interval '1 day')::date)::text, 'paid through the end of the year');

-- ================= the gateway (erp_billing): orders, idempotent payments, refunds
select private._b_as('a7000000-0000-4000-8000-000000000002');   -- P's admin asks to pay P's invoice
select private.billing_open_order((select id from ip), 'order_P1', 1180.00);
select private._b_refused($q$select private.billing_open_order((select id from iq), 'order_Q_by_P', 11800.00)$q$, 'P''s admin can''t open an order on Q''s invoice');
select private._b_refused($q$select private.billing_record_payment((select id from ip), 1180, 'razorpay', null, null, private._b_t(0), 'checkout', 'order_P1', 'pay_P1')$q$,
  'a person can''t record a gateway payment');
select private._b_refused($q$select private.billing_log_event('evt_x', 'payment.captured', null, null)$q$, 'nor log a webhook event');
reset role;
set local role erp_billing;
select private._b_eq(private.billing_log_event('evt_1', 'payment.captured', 'order_P1', 'pay_P1'), true, 'first delivery of a webhook event');
select private._b_eq(private.billing_log_event('evt_1', 'payment.captured', 'order_P1', 'pay_P1'), false, 'the same event again: a duplicate');
select private._b_eq((select count(*)::int from private.billing_find_order('order_P1')), 1, 'the gateway finds the order');
select private.billing_record_payment((select id from ip), 1180, 'razorpay', 'upi', null, private._b_t(0), 'webhook', 'order_P1', 'pay_P1');
select private.billing_record_payment((select id from ip), 1180, 'razorpay', 'upi', null, private._b_t(0), 'checkout', 'order_P1', 'pay_P1');
select private._b_refused($q$select private.billing_void_invoice((select id from ip), 'nope')$q$, 'the gateway role can''t cancel invoices');
reset role;
select private._b_eq((select count(*)::int from public.subscription_payments where gateway_payment_id = 'pay_P1'), 1, 'checkout and webhook for one payment: recorded once');
select private._b_eq((select outcome from public.billing_orders where gateway_order_id = 'order_P1'), 'paid', 'the order is marked paid');
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000a'), 'trialing', 'P paid ahead: still on its trial until the paid period begins');

-- a refund takes coverage away
set local role erp_billing;
select private._b_eq(private.billing_record_refund(null, 'pay_P1', 500), true, 'part refund');
select private._b_refused_with($q$select private.billing_record_refund(null, 'pay_P1', 1000)$q$, 'more than', 'can''t refund more than was paid');
reset role;
select private._b_eq(private.invoice_state((select id from ip)), 'partly_paid', 'P invoice: no longer fully paid');
select private._b_eq(private._b_ss('b7000000-0000-4000-8000-00000000000a') ->> 'balance_due', '500.00', 'balance due');

-- ================= expiry, grace and access, from dates alone
-- R: Basic, trial ended 20 days ago, nothing paid: 7 days' grace long gone → expired, read-only
insert into public.school_subscriptions (school_id, plan_id, billing_cycle, started_on, trial_ends_at)
values ('b7000000-0000-4000-8000-00000000000c', '99700000-0000-4000-8000-000000000001', 'monthly', private._b_t(-34), private._b_t(-20));
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000c'), 'expired', 'R: trial over, grace over → expired');
select private._b_eq(private._b_ss('b7000000-0000-4000-8000-00000000000c') ->> 'grace_until', private._b_t(-13)::text, 'grace ended 13 days ago');
select private._b_as('a7000000-0000-4000-8000-000000000005');
select private._b_eq(private.school_access('b7000000-0000-4000-8000-00000000000c'), 'read_only', 'R''s admin: read-only');
reset role;
update public.school_subscriptions set trial_ends_at = private._b_t(-7) where school_id = 'b7000000-0000-4000-8000-00000000000c';
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000c'), 'grace', 'trial ended 7 days ago: last day of grace');
update public.school_subscriptions set trial_ends_at = private._b_t(-8) where school_id = 'b7000000-0000-4000-8000-00000000000c';
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000c'), 'expired', '8 days ago: expired');
-- the billing run doesn't keep invoicing an expired school
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private.billing_run();
reset role;
select private._b_eq((select count(*)::int from public.subscription_invoices where school_id = 'b7000000-0000-4000-8000-00000000000c'), 0, 'no invoices for an expired school');
-- a paid renewal brings it back
select private._b_as('a7000000-0000-4000-8000-000000000001');
update public.school_subscriptions set price = 800.00 where school_id = 'b7000000-0000-4000-8000-00000000000c';   -- an agreed price
create temp table ir on commit drop as select private.billing_issue_invoice('b7000000-0000-4000-8000-00000000000c', private._b_t(-7), 'renewal') as id;
grant select on ir to authenticated, erp_billing;
select private._b_eq((select subtotal || '/' || total from public.subscription_invoices where id = (select id from ir)), '800.00/944.00',
  'the agreed price is billed (plus 18%)');
select private.billing_record_payment((select id from ir), 944, 'cash', null, null, private._b_t(0), 'manual', null, null);
reset role;
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000c'), 'active', 'R: paid → active again');
select private._b_eq(private.school_access('b7000000-0000-4000-8000-00000000000c'), 'full', 'full access back');

-- S: paid for a month that ended yesterday, Pro (5 days' grace)
insert into public.school_subscriptions (school_id, plan_id, billing_cycle, started_on)
values ('b7000000-0000-4000-8000-00000000000d', '99700000-0000-4000-8000-000000000002', 'monthly', private._b_t(-31));
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private.billing_record_payment(private.billing_issue_invoice('b7000000-0000-4000-8000-00000000000d', private._b_t(-31), 'subscription'),
  2950, 'cheque', null, 'CHQ 0001', private._b_t(-30), 'manual', null, null);
reset role;
select private._b_eq((select cgst || '/' || igst from public.subscription_invoices where school_id = 'b7000000-0000-4000-8000-00000000000d'), '225.00/0.00',
  'S is in "delhi " — same state as the seller, whatever the spacing or case');
select private._b_eq(private._b_ss('b7000000-0000-4000-8000-00000000000d') ->> 'paid_through', private.add_cycle(private._b_t(-31), 'monthly')::text,
  'S paid through the end of its month (a day or two ago, depending on the month)');
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000d'), 'grace', 'S: renewal unpaid, in grace');
select private._b_eq(private._b_ss('b7000000-0000-4000-8000-00000000000d') ->> 'grace_until', (private.add_cycle(private._b_t(-31), 'monthly') + 5)::text,
  'S: 5 days'' grace after the paid month (its paid first invoice''s later due date doesn''t extend it)');
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private._b_eq(private.billing_run(), 1, 'billing run issues S''s renewal (P and Q have unpaid or future invoices)');
reset role;
select private._b_eq((select kind || ' ' || period_start from public.subscription_invoices where school_id = 'b7000000-0000-4000-8000-00000000000d' order by period_start desc limit 1),
  'renewal ' || (private.add_cycle(private._b_t(-31), 'monthly') + 1), 'the renewal starts the day after the paid period');

-- ================= cancelling and resuming
select private._b_as('a7000000-0000-4000-8000-000000000003');   -- P's accountant
select private._b_refused($q$select private.subscription_cancel('b7000000-0000-4000-8000-00000000000a', 'at_period_end', null)$q$, 'an accountant can''t cancel their school''s plan');
select private._b_as('a7000000-0000-4000-8000-000000000002');   -- P's admin
select private._b_refused($q$select private.subscription_cancel('b7000000-0000-4000-8000-00000000000b', 'at_period_end', null)$q$, 'P''s admin can''t cancel Q');
select private._b_as('a7000000-0000-4000-8000-000000000004');   -- Q's admin
select private.subscription_cancel('b7000000-0000-4000-8000-00000000000b', 'at_period_end', 'Moving to another system');
reset role;
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000b'), 'cancelling', 'Q: ends at the period end');
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private._b_eq(private.billing_run(), 0, 'no renewal for a subscription that is ending');
select private._b_as('a7000000-0000-4000-8000-000000000004');
select private._b_refused($q$select private.subscription_cancel('b7000000-0000-4000-8000-00000000000b', 'now', null)$q$, 'a school can''t cancel at once');
select private.subscription_cancel('b7000000-0000-4000-8000-00000000000b', 'resume', null);
reset role;
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000b'), 'active', 'Q: resumed');
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private.subscription_cancel('b7000000-0000-4000-8000-00000000000b', 'now', 'Requested by the school');
reset role;
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000b'), 'cancelled', 'Q: cancelled at once, though paid');
select private._b_eq(private._b_ss('b7000000-0000-4000-8000-00000000000b') ->> 'access', 'read_only', 'read-only');
select private._b_as('a7000000-0000-4000-8000-000000000004');
select private._b_refused($q$select private.subscription_cancel('b7000000-0000-4000-8000-00000000000b', 'resume', null)$q$, 'only the platform brings it back');
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private.subscription_cancel('b7000000-0000-4000-8000-00000000000b', 'reactivate', null);
reset role;
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000b'), 'active', 'Q: reactivated, still paid');
-- ending at the period end, once the period is over: cancelled (no grace)
update public.school_subscriptions set cancel_at_period_end = true where school_id = 'b7000000-0000-4000-8000-00000000000d';
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000d'), 'cancelled', 'S: set to end, period over → cancelled, not grace');
update public.school_subscriptions set cancel_at_period_end = false where school_id = 'b7000000-0000-4000-8000-00000000000d';
select private._b_eq((select string_agg(action, ', ' order by id) from public.school_subscription_events where school_id = 'b7000000-0000-4000-8000-00000000000b'),
  'started, set to end at period end, resumed, cancelled, reactivated', 'Q''s history');
select private._b_eq((select changed_by from public.school_subscription_events where school_id = 'b7000000-0000-4000-8000-00000000000b' and action = 'set to end at period end'),
  'a7000000-0000-4000-8000-000000000004'::uuid, 'with who did it');

-- ================= what the billing run skips
-- R (paid through about three weeks from now): with a 30-day lead its renewal is due…
update public.billing_settings set renewal_lead_days = 30;
update public.school_subscriptions set cancel_at_period_end = true where school_id = 'b7000000-0000-4000-8000-00000000000c';
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private._b_eq(private.billing_run(), 0, '…but not while R is set to end');
reset role;
update public.school_subscriptions set cancel_at_period_end = false where school_id = 'b7000000-0000-4000-8000-00000000000c';
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private._b_eq(private.billing_run(), 1, 'resumed: R''s renewal is issued');
reset role;
update public.billing_settings set renewal_lead_days = 7;
-- T: Pro with a long grace, an unpaid month that has ended: still in grace, but no second invoice while one is unpaid
insert into public.schools (id, name, code, state) values ('b7000000-0000-4000-8000-00000000000e', 'Billing School T', 'ZZBL-T', 'Delhi');
update public.subscription_plans set grace_period_days = 45 where code = 'BL-PRO';
insert into public.school_subscriptions (school_id, plan_id, billing_cycle, started_on)
values ('b7000000-0000-4000-8000-00000000000e', '99700000-0000-4000-8000-000000000002', 'monthly', private._b_t(-33));
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private.billing_issue_invoice('b7000000-0000-4000-8000-00000000000e', private._b_t(-33), 'subscription');
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000e'), 'grace', 'T: unpaid, within its 45 days');
select private._b_eq(private.billing_run(), 0, 'no next invoice while the last one is unpaid');
reset role;
update public.subscription_plans set grace_period_days = 5 where code = 'BL-PRO';
-- a free plan: a ₹0 invoice is paid by nature; void it and the coverage goes
insert into public.subscription_plans (id, code, name, price_monthly, price_yearly) values ('99700000-0000-4000-8000-000000000003', 'BL-FREE', 'Free', 0, 0);
insert into public.schools (id, name, code, state) values ('b7000000-0000-4000-8000-00000000000f', 'Billing School U', 'ZZBL-U', 'Delhi');
insert into public.school_subscriptions (school_id, plan_id, billing_cycle, started_on)
values ('b7000000-0000-4000-8000-00000000000f', '99700000-0000-4000-8000-000000000003', 'monthly', private._b_t(-40));
select private._b_as('a7000000-0000-4000-8000-000000000001');
create temp table iu on commit drop as select private.billing_issue_invoice('b7000000-0000-4000-8000-00000000000f', private._b_t(-10), 'subscription') as id;
grant select on iu to authenticated;
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000f'), 'active', 'U: a ₹0 invoice covers its period');
select private.billing_void_invoice((select id from iu), 'Issued by mistake');
select private._b_eq(private._b_st('b7000000-0000-4000-8000-00000000000f'), 'expired', 'void: it no longer counts');
reset role;

-- ================= voiding
select private._b_as('a7000000-0000-4000-8000-000000000001');
select private._b_refused_with($q$select private.billing_void_invoice((select id from iq), 'mistake')$q$, 'refund it first', 'a paid invoice can''t be voided');
create temp table iv on commit drop as select id from public.subscription_invoices
  where school_id = 'b7000000-0000-4000-8000-00000000000d' and kind = 'renewal';
grant select on iv to authenticated;
select private._b_refused_with($q$select private.billing_void_invoice((select id from iv), '')$q$, 'Say why', 'voiding needs a reason');
select private.billing_void_invoice((select id from iv), 'Raised in error');
select private._b_eq(private.invoice_state((select id from iv)), 'void', 'void');
select private._b_assert(private.billing_issue_invoice('b7000000-0000-4000-8000-00000000000d', private.add_cycle(private._b_t(-31), 'monthly') + 1, 'renewal') is not null,
  'the period can be invoiced again once the wrong invoice is void');
select private._b_refused($q$select private.billing_record_payment((select id from iv), 100, 'cash', null, null, private._b_t(0), 'manual', null, null)$q$,
  'no payment on a void invoice');

-- ================= limits, enforced in the database (P: 3 students, 1 teacher, 1 MB)
reset role;
insert into public.students (id, school_id, student_code, full_name, father_name, date_of_birth, gender, mobile, status)
select ('f7000000-0000-4000-8000-00000000000' || g)::uuid, 'b7000000-0000-4000-8000-00000000000a', 'BL' || g, 'Pupil ' || g, 'Parent', '2016-01-01', 'male', '91000000' || lpad(g::text, 2, '0'), 'active'
from generate_series(1, 3) g;
select private._b_refused_with($q$insert into public.students (school_id, student_code, full_name, father_name, date_of_birth, gender, mobile, status)
  values ('b7000000-0000-4000-8000-00000000000a', 'BL4', 'Pupil 4', 'Parent', '2016-01-01', 'male', '9100000004', 'active')$q$,
  'allows 3 active students', 'a 4th active student is refused');
insert into public.students (id, school_id, student_code, full_name, father_name, date_of_birth, gender, mobile, status)
values ('f7000000-0000-4000-8000-000000000005', 'b7000000-0000-4000-8000-00000000000a', 'BL5', 'Pupil 5', 'Parent', '2016-01-01', 'male', '9100000005', 'inactive');
select private._b_refused_with($q$update public.students set status = 'active' where id = 'f7000000-0000-4000-8000-000000000005'$q$, 'allows 3',
  'nor reactivating one beyond the limit');
update public.students set status = 'inactive' where id = 'f7000000-0000-4000-8000-000000000001';
update public.students set status = 'active' where id = 'f7000000-0000-4000-8000-000000000005';
select private._b_eq((select count(*)::int from public.students where school_id = 'b7000000-0000-4000-8000-00000000000a' and status = 'active'), 3,
  'after one left, another can be activated');
update public.students set full_name = 'Pupil Two' where id = 'f7000000-0000-4000-8000-000000000002';
select private._b_eq((select full_name from public.students where id = 'f7000000-0000-4000-8000-000000000002'), 'Pupil Two', 'editing an active student is fine at the limit');
insert into public.teachers (school_id, employee_id, full_name, phone, email, joining_date) values
  ('b7000000-0000-4000-8000-00000000000a', 'BLT1', 'Teacher One', '9100000101', 'bl-t1@example.invalid', '2026-04-01');
select private._b_refused_with($q$insert into public.teachers (school_id, employee_id, full_name, phone, email, joining_date) values
  ('b7000000-0000-4000-8000-00000000000a', 'BLT2', 'Teacher Two', '9100000102', 'bl-t2@example.invalid', '2026-04-01')$q$, 'allows 1 active teachers', 'a 2nd teacher is refused');
insert into public.student_documents (school_id, student_id, document_type, file_path, file_name, mime_type, size_bytes)
values ('b7000000-0000-4000-8000-00000000000a', 'f7000000-0000-4000-8000-000000000002', 'birth_certificate', 'b7000000-0000-4000-8000-00000000000a/f7000000-0000-4000-8000-000000000002/a.pdf', 'a.pdf', 'application/pdf', 600000);
select private._b_refused_with($q$insert into public.student_documents (school_id, student_id, document_type, file_path, file_name, mime_type, size_bytes)
  values ('b7000000-0000-4000-8000-00000000000a', 'f7000000-0000-4000-8000-000000000002', 'address_proof', 'b7000000-0000-4000-8000-00000000000a/f7000000-0000-4000-8000-000000000002/b.pdf', 'b.pdf', 'application/pdf', 600000)$q$,
  '1 MB of storage', 'a file past 1 MB is refused');
-- Pro (no limits): Q takes a 4th student freely
insert into public.students (school_id, student_code, full_name, father_name, date_of_birth, gender, mobile, status)
select 'b7000000-0000-4000-8000-00000000000d', 'SL' || g, 'S Pupil ' || g, 'Parent', '2016-01-01', 'male', '92000000' || lpad(g::text, 2, '0'), 'active' from generate_series(1, 5) g;
select private._b_eq((select count(*)::int from public.students where school_id = 'b7000000-0000-4000-8000-00000000000d'), 5, 'S (Pro, no limit): 5 students');

-- WhatsApp: not queued for P (not in Basic), queued for S (Pro)
insert into public.notification_events (id, school_id, event_key, dedupe_key, payload) values
  ('e7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-00000000000a', 'test', 'bl-test-1', '{}'),
  ('e7000000-0000-4000-8000-000000000002', 'b7000000-0000-4000-8000-00000000000d', 'test', 'bl-test-2', '{}');
insert into public.notification_deliveries (school_id, event_id, recipient_kind, channel, address, body) values
  ('b7000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001', 'test', 'whatsapp', '+919100000001', 'hi'),
  ('b7000000-0000-4000-8000-00000000000a', 'e7000000-0000-4000-8000-000000000001', 'test', 'sms', '+919100000001', 'hi'),
  ('b7000000-0000-4000-8000-00000000000d', 'e7000000-0000-4000-8000-000000000002', 'test', 'whatsapp', '+919200000001', 'hi');
select private._b_eq((select string_agg(channel || ':' || status, ',' order by school_id, channel) from public.notification_deliveries
  where event_id in ('e7000000-0000-4000-8000-000000000001', 'e7000000-0000-4000-8000-000000000002')),
  'sms:queued,whatsapp:skipped,whatsapp:queued', 'WhatsApp skipped for Basic, SMS untouched, WhatsApp queued for Pro');

-- analytics refused in the database for P's admin (plan), allowed for S... (no analytics data needed: the check comes first)
select private._b_as('a7000000-0000-4000-8000-000000000002');
select private._b_refused_with($q$select private.analytics_fees('b7000000-0000-4000-8000-00000000000a', null, null, null, null)$q$,
  'included in your school''s plan', 'P: analytics not in the plan');

-- ================= who sees billing
select private._b_eq((select count(*)::int from public.subscription_invoices), 1, 'P''s admin sees P''s invoice only');
select private._b_eq((select count(*)::int from public.subscription_payments), 1, 'and its payment');
select private._b_eq((select count(*)::int from public.billing_settings), 0, 'no billing settings');
select private._b_eq((select count(*)::int from public.billing_webhook_events), 0, 'no webhook events');
select private._b_eq((select private.subscription_overview('b7000000-0000-4000-8000-00000000000a') ->> 'status'), 'trialing', 'their own status');
select private._b_refused($q$select private.subscription_overview('b7000000-0000-4000-8000-00000000000b')$q$, 'not another school''s');
select private._b_refused($q$select private.subscription_status('b7000000-0000-4000-8000-00000000000b')$q$, 'nor the inner function');
select private._b_eq(private.school_access('b7000000-0000-4000-8000-00000000000c'), null::text, 'nor another school''s access');
select private._b_eq(private.school_features('b7000000-0000-4000-8000-00000000000d'), '{}'::text[], 'nor its features');
select private._b_eq(private.invoice_paid_amount((select id from iq)), 0::numeric, 'nor what Q paid');
select private._b_refused($q$insert into public.subscription_invoices (school_id, invoice_number, kind, plan_name, billing_cycle, period_start, period_end,
  description, subtotal, tax_amount, total, seller, buyer, issued_on, due_on) values ('b7000000-0000-4000-8000-00000000000a', 'X', 'renewal', 'x', 'monthly',
  current_date, current_date, 'x', 0, 0, 0, '{}', '{}', current_date, current_date)$q$, 'nobody writes invoices directly');
select private._b_refused($q$update public.subscription_payments set amount = 1$q$, 'nor payments');
select private._b_refused($q$select private.billing_run()$q$, 'a school admin can''t run billing');
select private._b_refused($q$select private.billing_issue_invoice('b7000000-0000-4000-8000-00000000000a', current_date + 60, 'renewal')$q$, 'nor issue invoices');
select private._b_refused($q$select private.billing_record_payment((select id from ip), 500, 'cash', null, null, current_date, 'manual', null, null)$q$, 'nor record payments');
select private._b_refused($q$update public.school_subscriptions set price = 1$q$, 'nor change the subscription');
select private._b_as('a7000000-0000-4000-8000-000000000003');
select private._b_eq((select count(*)::int from public.subscription_invoices), 0, 'an accountant sees no invoices');
reset role;
set local role anon;
do $$ begin
  begin perform private.school_access('b7000000-0000-4000-8000-00000000000a'); raise exception 'FAIL: anonymous access lookup' using errcode = 'ZT001';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ begin raise notice 'ALL BILLING TESTS PASSED'; end $$;
select 'ALL BILLING TESTS PASSED' as result;
rollback;
