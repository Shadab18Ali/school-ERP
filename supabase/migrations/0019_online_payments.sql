-- =====================================================================
-- Phase 21: online fee payments (Razorpay: UPI, cards, net banking)
--   private.payment_gateway_accounts  each school's own Razorpay account; the key
--                                     secret and webhook secret are stored ENCRYPTED
--                                     by the API (the database never sees them in clear)
--   online_payments                   one row per payment order a parent starts
--   online_payment_refunds            refunds made through the gateway
--   payment_webhook_events            webhooks received (deduplicated by event id)
--   fee_payments.cancelled_*          a refunded receipt is cancelled: its amounts are
--                                     moved off the dues, which become payable again
--
-- Trust: a payment counts only after the API has verified it with the gateway
-- (signature + fetching the payment from Razorpay, or a signed webhook). The
-- functions that record gateway results can be run only by the role
-- erp_payments, which the API switches to for that work; parents and staff
-- can't call them. Amounts are always taken from the database, never the browser.
-- =====================================================================

alter type public.payment_mode add value if not exists 'online';

create type public.online_payment_status as enum
  ('created', 'paid', 'failed', 'cancelled', 'needs_review', 'refund_pending', 'refunded', 'refund_failed');

-- The role the API uses for gateway work (verification, webhooks, refunds).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'erp_payments') then
    create role erp_payments nologin noinherit;
  end if;
end $$;
grant erp_payments to current_user;   -- the API connects as this user (see README if yours differs)
grant usage on schema private to erp_payments;

-- ---------- each school's gateway account ----------
create table private.payment_gateway_accounts (
  school_id           uuid primary key references public.schools (id) on delete cascade,
  provider            text not null default 'razorpay' check (provider = 'razorpay'),
  key_id              text not null check (key_id ~ '^rzp_(test|live)_[A-Za-z0-9]{6,40}$'),
  key_secret_enc      text not null,      -- encrypted by the API (Fernet), never stored in clear
  webhook_secret_enc  text,
  is_enabled          boolean not null default false,
  updated_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now()
);
revoke all on private.payment_gateway_accounts from public, anon, authenticated;

-- ---------- receipts can be cancelled by a refund ----------
alter table public.fee_payments
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references auth.users (id) on delete set null,
  add column cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 300),
  add column cancelled_allocations jsonb;   -- what the receipt had paid, kept for the record

-- ---------- online payments ----------
create table public.online_payments (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  student_id           uuid not null,
  enrollment_id        uuid not null,
  academic_session_id  uuid not null,
  amount               numeric(12, 2) not null check (amount > 0),
  currency             text not null default 'INR' check (currency = 'INR'),
  allocations          jsonb not null,           -- [{due_id, amount}] fixed when the order is made
  description          text not null,
  gateway              text not null default 'razorpay',
  gateway_order_id     text unique,
  gateway_payment_id   text unique,
  status               public.online_payment_status not null default 'created',
  method               text,                      -- upi, card, netbanking, ...
  method_detail        text,                      -- bank, card network and last 4, masked UPI id
  failure_reason       text,
  fee_payment_id       uuid unique,
  verified_via         text check (verified_via is null or verified_via in ('checkout', 'webhook', 'reconcile')),
  initiated_by         uuid references auth.users (id) on delete set null,
  paid_at              timestamptz,
  refunded_amount      numeric(12, 2) not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint online_payments_id_school_key unique (id, school_id),
  constraint online_payments_student_fkey foreign key (student_id, school_id) references public.students (id, school_id),
  constraint online_payments_enrollment_fkey foreign key (enrollment_id, school_id)
    references public.student_enrollments (id, school_id),
  constraint online_payments_fee_payment_fkey foreign key (fee_payment_id, school_id)
    references public.fee_payments (id, school_id)
);
create index online_payments_student_idx on public.online_payments (student_id, created_at desc);
create index online_payments_school_idx on public.online_payments (school_id, status, created_at desc);
create trigger online_payments_updated_at before update on public.online_payments for each row execute function private.set_updated_at();

create table public.online_payment_refunds (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references public.schools (id) on delete cascade,
  online_payment_id  uuid not null,
  gateway_refund_id  text not null unique,
  amount             numeric(12, 2) not null check (amount > 0),
  status             text not null check (status in ('pending', 'processed', 'failed')),
  reason             text not null check (char_length(btrim(reason)) between 3 and 300),
  failure_reason     text,
  requested_by       uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  processed_at       timestamptz,
  constraint online_payment_refunds_payment_fkey foreign key (online_payment_id, school_id)
    references public.online_payments (id, school_id) on delete cascade
);
create index online_payment_refunds_payment_idx on public.online_payment_refunds (online_payment_id);

-- Only what is needed to audit and deduplicate; no payer details are kept.
create table public.payment_webhook_events (
  id                  bigint generated always as identity primary key,
  school_id           uuid not null references public.schools (id) on delete cascade,
  event_id            text not null,
  event_type          text not null,
  gateway_order_id    text,
  gateway_payment_id  text,
  outcome             text,
  received_at         timestamptz not null default now(),
  constraint payment_webhook_events_once unique (school_id, event_id)
);

-- =====================================================================
-- Settings (school admins) and status (members)
-- =====================================================================
create or replace function private.save_gateway_account(
  p_school uuid, p_key_id text, p_key_secret_enc text, p_webhook_secret_enc text, p_enabled boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[])) then
    raise exception 'Only school admins can change the payment gateway.' using errcode = 'insufficient_privilege';
  end if;
  if p_key_secret_enc is null and not exists (select 1 from private.payment_gateway_accounts where school_id = p_school) then
    raise exception 'Enter the key secret.' using errcode = 'check_violation';
  end if;
  if p_enabled and p_webhook_secret_enc is null
     and not exists (select 1 from private.payment_gateway_accounts where school_id = p_school and webhook_secret_enc is not null) then
    raise exception 'Enter the webhook secret before turning online payments on.' using errcode = 'check_violation';
  end if;
  update private.payment_gateway_accounts g set
    key_id = btrim(p_key_id),
    key_secret_enc = coalesce(p_key_secret_enc, g.key_secret_enc),          -- empty = keep the stored secret
    webhook_secret_enc = coalesce(p_webhook_secret_enc, g.webhook_secret_enc),
    is_enabled = p_enabled, updated_by = (select auth.uid()), updated_at = now()
  where g.school_id = p_school;
  if not found then
    insert into private.payment_gateway_accounts (school_id, key_id, key_secret_enc, webhook_secret_enc, is_enabled, updated_by)
    values (p_school, btrim(p_key_id), p_key_secret_enc, p_webhook_secret_enc, p_enabled, (select auth.uid()));
  end if;
end $$;

-- What staff may see: never the secrets themselves.
create or replace function private.gateway_account_info(p_school uuid)
returns table (key_id text, is_enabled boolean, mode text, has_webhook_secret boolean, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select g.key_id, g.is_enabled, case when g.key_id like 'rzp_live_%' then 'live' else 'test' end,
         g.webhook_secret_enc is not null, g.updated_at
  from private.payment_gateway_accounts g
  where g.school_id = p_school
    and (private.is_super_admin() or private.has_school_role(p_school, array['school_admin', 'accountant']::public.app_role[]));
$$;

create or replace function private.online_payments_enabled(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select g.is_enabled from private.payment_gateway_accounts g where g.school_id = p_school), false)
    and private.is_school_member(p_school);
$$;

-- =====================================================================
-- A parent starts a payment: the amount comes from the dues, not the browser.
-- =====================================================================
create or replace function private.prepare_online_payment(p_student uuid, p_due_ids uuid[])
returns table (online_payment_id uuid, amount numeric, gateway_order_id text, reused boolean)
language plpgsql security definer set search_path = '' as $$
declare v_school uuid; v_enr record; v_alloc jsonb; v_total numeric(12, 2); v_n int; v_existing record; v_desc text;
begin
  select s.school_id into v_school from public.students s where s.id = p_student;
  if v_school is null or not private.is_guardian_of(p_student) then
    raise exception 'Student not found.' using errcode = 'no_data_found';
  end if;
  if not coalesce((select g.is_enabled from private.payment_gateway_accounts g where g.school_id = v_school), false) then
    raise exception 'Online payment isn''t available for this school yet. Please pay at the school office.' using errcode = 'check_violation';
  end if;
  if p_due_ids is null or cardinality(p_due_ids) = 0 then
    raise exception 'Choose at least one fee to pay.' using errcode = 'check_violation';
  end if;
  if cardinality(p_due_ids) > 60 then
    raise exception 'Choose at most 60 fees in one payment.' using errcode = 'check_violation';
  end if;

  -- all chosen dues: this student's, one enrollment, an open session
  select count(distinct d.enrollment_id), count(*) into v_n, v_total
  from public.student_fee_dues d where d.id = any (p_due_ids) and d.student_id = p_student;
  if v_n <> 1 or v_total <> (select count(distinct x) from unnest(p_due_ids) x) then
    raise exception 'One of the fees doesn''t belong to this student.' using errcode = 'check_violation';
  end if;
  select d.enrollment_id, e.academic_session_id, a.archived_at, a.name as session_name into v_enr
  from public.student_fee_dues d
  join public.student_enrollments e on e.id = d.enrollment_id
  join public.academic_sessions a on a.id = e.academic_session_id
  where d.id = p_due_ids[1];
  if v_enr.archived_at is not null then
    raise exception 'Session % is closed. Please contact the school office.', v_enr.session_name using errcode = 'check_violation';
  end if;

  select jsonb_agg(jsonb_build_object('due_id', x.id, 'amount', x.outstanding) order by x.due_month, x.id),
         sum(x.outstanding)::numeric(12, 2), count(*) filter (where x.outstanding <= 0)
    into v_alloc, v_total, v_n
  from (
    select d.id, d.due_month, (d.amount - coalesce((select sum(al.amount) from public.fee_payment_allocations al where al.due_id = d.id), 0))::numeric(12, 2) as outstanding
    from public.student_fee_dues d where d.id = any (p_due_ids)
  ) x;
  if v_n > 0 then
    raise exception 'One of the chosen fees is already paid. Refresh the page.' using errcode = 'check_violation';
  end if;

  -- the same fees started in the last 30 minutes: continue that order
  select o.id, o.amount, o.gateway_order_id into v_existing
  from public.online_payments o
  where o.student_id = p_student and o.status = 'created' and o.gateway_order_id is not null
    and o.allocations = v_alloc and o.created_at > now() - interval '30 minutes'
  order by o.created_at desc limit 1;
  if found then
    return query select v_existing.id, v_existing.amount, v_existing.gateway_order_id, true;
    return;
  end if;

  if (select count(*) from public.online_payments o where o.student_id = p_student and o.created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many payment attempts. Please try again in an hour.' using errcode = 'check_violation';
  end if;

  select 'School fees · ' || s.full_name || ' · ' || v_enr.session_name into v_desc from public.students s where s.id = p_student;
  insert into public.online_payments (school_id, student_id, enrollment_id, academic_session_id, amount, allocations, description, initiated_by)
  values (v_school, p_student, v_enr.enrollment_id, v_enr.academic_session_id, v_total, v_alloc, left(v_desc, 250), (select auth.uid()))
  returning id into v_existing;
  return query select v_existing.id, v_total, null::text, false;
end $$;

-- =====================================================================
-- Gateway results: run only as erp_payments, after the API has verified them.
-- =====================================================================
create or replace function private.pay_gateway_secrets(p_school uuid)
returns table (key_id text, key_secret_enc text, webhook_secret_enc text, is_enabled boolean)
language sql stable security definer set search_path = '' as $$
  select key_id, key_secret_enc, webhook_secret_enc, is_enabled from private.payment_gateway_accounts where school_id = p_school;
$$;

create or replace function private.pay_attach_order(p_id uuid, p_order_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.online_payments set gateway_order_id = p_order_id
  where id = p_id and gateway_order_id is null and status = 'created';
  if not found then raise exception 'Payment order not found.' using errcode = 'no_data_found'; end if;
end $$;

create or replace function private.pay_cancel(p_id uuid, p_reason text)
returns void language sql security definer set search_path = '' as $$
  update public.online_payments set status = 'cancelled', failure_reason = left(p_reason, 300)
  where id = p_id and status = 'created';
$$;

create or replace function private.pay_find(p_school uuid, p_order_id text)
returns setof public.online_payments language sql stable security definer set search_path = '' as $$
  select * from public.online_payments where school_id = p_school and gateway_order_id = p_order_id;
$$;

-- Receipt numbers come from private.next_counter, which only admins and accountants
-- may advance. Gateway work has no signed-in user, so pay_apply grants itself the
-- right for its own transaction only: a row keyed by the transaction id, in a table
-- nobody else can write.
create table private.counter_grants (xact text primary key);
revoke all on private.counter_grants from public, anon, authenticated;

create or replace function private.next_counter(p_school uuid, p_kind text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare n bigint;
begin
  -- only that school's admins/accountants (or the platform admin), or a verified online payment
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin', 'accountant']::public.app_role[])
          or exists (select 1 from private.counter_grants g where g.xact = pg_current_xact_id()::text)) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  insert into private.school_counters as c (school_id, kind, last_value) values (p_school, p_kind, 1)
  on conflict (school_id, kind) do update set last_value = c.last_value + 1
  returning last_value into n;
  return n;
end $$;

-- A captured payment: record the fee receipt (once), or park it for review.
create or replace function private.pay_apply(
  p_id uuid, p_gateway_payment_id text, p_amount numeric, p_method text, p_method_detail text, p_via text
) returns table (status public.online_payment_status, receipt_number text, fee_payment_id uuid)
language plpgsql security definer set search_path = '' as $$
declare o public.online_payments; r record; v_err text;
begin
  select * into o from public.online_payments where id = p_id for update;
  if not found then raise exception 'Payment order not found.' using errcode = 'no_data_found'; end if;

  if o.gateway_payment_id is not null then
    if o.gateway_payment_id <> p_gateway_payment_id then
      raise exception 'This order already has another payment (%).', o.gateway_payment_id using errcode = 'check_violation';
    end if;
    -- already handled (checkout and webhook both arrive): same answer again
    return query select o.status, (select fp.receipt_number from public.fee_payments fp where fp.id = o.fee_payment_id), o.fee_payment_id;
    return;
  end if;

  update public.online_payments set gateway_payment_id = p_gateway_payment_id, method = p_method, method_detail = p_method_detail,
         paid_at = now(), verified_via = p_via, failure_reason = null
  where id = p_id;

  if p_amount is distinct from o.amount then
    update public.online_payments set status = 'needs_review',
           failure_reason = format('The gateway reported ₹%s but the order was for ₹%s.', p_amount, o.amount)
    where id = p_id;
    return query select 'needs_review'::public.online_payment_status, null::text, null::uuid;
    return;
  end if;

  insert into private.counter_grants (xact) values (pg_current_xact_id()::text) on conflict do nothing;
  begin
    select * into r from private.record_fee_payment(o.enrollment_id, current_date, 'online'::public.payment_mode,
      p_gateway_payment_id, left('Paid online' || coalesce(' (' || nullif(p_method_detail, '') || ')', ''), 300), o.id, o.allocations);
  exception when others then
    get stacked diagnostics v_err = message_text;
    delete from private.counter_grants where xact = pg_current_xact_id()::text;
    update public.online_payments set status = 'needs_review',
           failure_reason = left('Paid, but the receipt could not be recorded: ' || v_err, 300)
    where id = p_id;
    return query select 'needs_review'::public.online_payment_status, null::text, null::uuid;
    return;
  end;
  delete from private.counter_grants where xact = pg_current_xact_id()::text;
  update public.fee_payments set received_by_name = 'Online payment' where id = r.payment_id;
  update public.online_payments set status = 'paid', fee_payment_id = r.payment_id where id = p_id;
  return query select 'paid'::public.online_payment_status, r.receipt_number, r.payment_id;
end $$;

create or replace function private.pay_mark_failed(p_id uuid, p_gateway_payment_id text, p_reason text)
returns void language sql security definer set search_path = '' as $$
  update public.online_payments set status = 'failed', failure_reason = left(coalesce(nullif(p_reason, ''), 'Payment failed'), 300)
  where id = p_id and status in ('created', 'failed') and gateway_payment_id is null;
$$;

-- Lock a payment for a refund (the API calls the gateway while holding it).
create or replace function private.pay_lock_for_refund(p_id uuid, p_school uuid)
returns setof public.online_payments language plpgsql security definer set search_path = '' as $$
begin
  return query select * from public.online_payments where id = p_id and school_id = p_school for update;
end $$;

-- A refund accepted by the gateway: record it and cancel the receipt (its dues become payable again).
create or replace function private.pay_record_refund(
  p_id uuid, p_refund_id text, p_amount numeric, p_status text, p_reason text, p_actor uuid
) returns public.online_payment_status language plpgsql security definer set search_path = '' as $$
declare o public.online_payments; v_new public.online_payment_status;
begin
  select * into o from public.online_payments where id = p_id for update;
  if o.status not in ('paid', 'needs_review', 'refund_failed') then
    raise exception 'Only a completed payment can be refunded.' using errcode = 'check_violation';
  end if;
  if p_amount <> o.amount then
    raise exception 'Only full refunds are supported.' using errcode = 'check_violation';
  end if;
  insert into public.online_payment_refunds (school_id, online_payment_id, gateway_refund_id, amount, status, reason, requested_by, processed_at)
  values (o.school_id, o.id, p_refund_id, p_amount, p_status, btrim(p_reason), p_actor, case when p_status = 'processed' then now() end);
  if o.fee_payment_id is not null then
    update public.fee_payments fp set cancelled_at = now(), cancelled_by = p_actor,
           cancel_reason = left('Refunded online: ' || btrim(p_reason), 300),
           cancelled_allocations = (select jsonb_agg(jsonb_build_object('due_id', a.due_id, 'amount', a.amount))
                                    from public.fee_payment_allocations a where a.payment_id = fp.id)
    where fp.id = o.fee_payment_id and fp.cancelled_at is null;
    delete from public.fee_payment_allocations where payment_id = o.fee_payment_id;
  end if;
  v_new := case p_status when 'processed' then 'refunded' when 'failed' then 'refund_failed' else 'refund_pending' end;
  update public.online_payments set status = v_new, refunded_amount = case when p_status = 'failed' then refunded_amount else amount end
  where id = p_id;
  return v_new;
end $$;

-- The gateway tells us later how a refund ended.
create or replace function private.pay_refund_update(p_school uuid, p_refund_id text, p_status text, p_failure text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_payment uuid;
begin
  update public.online_payment_refunds set status = p_status, failure_reason = left(p_failure, 300),
         processed_at = case when p_status = 'processed' then now() else processed_at end
  where school_id = p_school and gateway_refund_id = p_refund_id and status <> p_status
  returning online_payment_id into v_payment;
  if v_payment is null then return false; end if;
  update public.online_payments set
    status = case p_status when 'processed' then 'refunded'::public.online_payment_status
                           when 'failed' then 'refund_failed'::public.online_payment_status else status end,
    refunded_amount = case when p_status = 'failed' then 0 else refunded_amount end
  where id = v_payment and status in ('refund_pending', 'refunded', 'refund_failed');
  return true;
end $$;

-- Webhook deduplication: true the first time an event id is seen.
create or replace function private.pay_log_event(
  p_school uuid, p_event_id text, p_type text, p_order text, p_payment text, p_outcome text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.payment_webhook_events (school_id, event_id, event_type, gateway_order_id, gateway_payment_id, outcome)
  values (p_school, p_event_id, p_type, p_order, p_payment, p_outcome)
  on conflict (school_id, event_id) do nothing;
  return found;
end $$;

create or replace function private.pay_event_outcome(p_school uuid, p_event_id text, p_outcome text)
returns void language sql security definer set search_path = '' as $$
  update public.payment_webhook_events set outcome = left(p_outcome, 300) where school_id = p_school and event_id = p_event_id;
$$;

revoke all on function private.save_gateway_account(uuid, text, text, text, boolean), private.gateway_account_info(uuid),
  private.online_payments_enabled(uuid), private.prepare_online_payment(uuid, uuid[]),
  private.pay_gateway_secrets(uuid), private.pay_attach_order(uuid, text), private.pay_cancel(uuid, text), private.pay_find(uuid, text),
  private.pay_apply(uuid, text, numeric, text, text, text), private.pay_mark_failed(uuid, text, text),
  private.pay_lock_for_refund(uuid, uuid), private.pay_record_refund(uuid, text, numeric, text, text, uuid),
  private.pay_refund_update(uuid, text, text, text), private.pay_log_event(uuid, text, text, text, text, text),
  private.pay_event_outcome(uuid, text, text)
  from public, anon, authenticated;
grant execute on function private.save_gateway_account(uuid, text, text, text, boolean), private.gateway_account_info(uuid),
  private.online_payments_enabled(uuid), private.prepare_online_payment(uuid, uuid[]) to authenticated;
grant execute on function
  private.pay_gateway_secrets(uuid), private.pay_attach_order(uuid, text), private.pay_cancel(uuid, text), private.pay_find(uuid, text),
  private.pay_apply(uuid, text, numeric, text, text, text), private.pay_mark_failed(uuid, text, text),
  private.pay_lock_for_refund(uuid, uuid), private.pay_record_refund(uuid, text, numeric, text, text, uuid),
  private.pay_refund_update(uuid, text, text, text), private.pay_log_event(uuid, text, text, text, text, text),
  private.pay_event_outcome(uuid, text, text)
  to erp_payments;

-- =====================================================================
-- RLS: staff see their school's online payments; parents their children's.
-- Nobody writes these tables directly.
-- =====================================================================
revoke all on public.online_payments, public.online_payment_refunds, public.payment_webhook_events from anon, authenticated;
grant select on public.online_payments, public.online_payment_refunds, public.payment_webhook_events to authenticated;
alter table public.online_payments enable row level security;
alter table public.online_payment_refunds enable row level security;
alter table public.payment_webhook_events enable row level security;

create policy online_payments_select on public.online_payments for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[])
         or private.is_guardian_of(student_id));
create policy online_payment_refunds_select on public.online_payment_refunds for select to authenticated
  using (exists (select 1 from public.online_payments o where o.id = online_payment_id));
create policy payment_webhook_events_select on public.payment_webhook_events for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
