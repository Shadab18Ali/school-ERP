-- =====================================================================
-- Phase 32: SaaS subscription management — plan features and limits, billing records
-- (invoices, payments, gateway orders, webhook events), renewal, cancellation, trial,
-- grace period and expiry.
--
-- A subscription's STATUS IS NEVER STORED. It is worked out each time from the records:
-- the plan (its trial and grace lengths), the trial end date, the invoices and the payments
-- against them (an invoice is paid when its payments, net of refunds, cover its total), and
-- any cancellation request. See private.subscription_status().
--
--   trialing    on a trial, nothing paid yet
--   active      a paid invoice covers today
--   cancelling  covered (paid or trial) but set to end at the end of the period
--   grace       the paid period (or trial) ended, renewal unpaid, within the plan's grace days
--               (also: a new subscription awaiting its first payment)
--   expired     past the grace period → the school is read-only (it can still view and pay)
--   cancelled   cancelled (immediately, or at the end of a period that has now ended) → read-only
--   none        no subscription recorded → no limits (a school the platform hasn't set up yet)
--
-- No amount, limit or period is built in: plans, prices, limits, trial and grace days, the tax
-- rate and the seller's details are all entered by the super admin. The feature catalogue below
-- is not data about any school — it is the list of features this code knows how to enforce.
-- =====================================================================

-- ---------------------------------------------------------------- the gateway role
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'erp_billing') then
    create role erp_billing nologin noinherit;
  end if;
end $$;
grant erp_billing to current_user;   -- the API connects as this user and switches to it for gateway work
grant usage on schema private to erp_billing;

-- ---------------------------------------------------------------- 1. features and entitlements
create table public.plan_features (
  key            text primary key check (key ~ '^[a-z_]{2,40}$'),
  label          text not null,
  kind           text not null check (kind in ('limit', 'feature')),
  unit           text,
  description    text not null,
  enforced_by    text not null,        -- where the system enforces it
  available      boolean not null,     -- false: the module itself isn't built yet; the setting is ready for it
  display_order  integer not null
);
insert into public.plan_features (key, label, kind, unit, description, enforced_by, available, display_order) values
  ('students', 'Students', 'limit', 'students', 'Active students the school can have at once.',
   'Database: adding or reactivating a student beyond the limit is refused.', true, 1),
  ('teachers', 'Teachers', 'limit', 'teachers', 'Active teacher records the school can have at once.',
   'Database: adding or reactivating a teacher beyond the limit is refused.', true, 2),
  ('storage_mb', 'Storage', 'limit', 'MB', 'Files the school stores: documents, homework files, transport papers (and, on Supabase, photos and logos).',
   'Database: a new file that would go over the limit is refused.', true, 3),
  ('whatsapp', 'WhatsApp notifications', 'feature', null, 'Sending notifications by WhatsApp.',
   'Database: WhatsApp messages are not queued (marked skipped); the API refuses to switch the channel on.', true, 4),
  ('reports', 'Reports and exports', 'feature', null, 'The Reports page and its CSV, Excel and PDF exports.',
   'API: the reports are refused.', true, 5),
  ('analytics', 'Analytics', 'feature', null, 'Student, fee and admission analytics.',
   'API and database: the analytics are refused.', true, 6),
  ('ai_assistant', 'AI assistant', 'feature', null, 'An AI assistant for authorised school users.',
   'Ready for the module: it must check this feature. The assistant itself is not built yet.', false, 7),
  ('website_builder', 'Website builder', 'feature', null, 'A public website for the school.',
   'Ready for the module: it must check this feature. The website builder itself is not built yet.', false, 8);
alter table public.plan_features enable row level security;
revoke all on public.plan_features from anon, authenticated;
grant select on public.plan_features to authenticated;
create policy plan_features_read on public.plan_features for select to authenticated using (true);   -- a catalogue, no school data

create table public.plan_entitlements (
  plan_id      uuid not null references public.subscription_plans(id) on delete cascade,
  feature_key  text not null references public.plan_features(key) on delete cascade,
  included     boolean not null,
  limit_value  bigint check (limit_value >= 0),     -- limits only; empty = no limit
  primary key (plan_id, feature_key),
  constraint plan_entitlements_limit_needs_inclusion check (limit_value is null or included)
);
create or replace function private.check_entitlement() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.limit_value is not null and (select kind from public.plan_features where key = new.feature_key) <> 'limit' then
    raise exception 'Only limits take a number.' using errcode = '23514';
  end if;
  if not new.included and (select kind from public.plan_features where key = new.feature_key) = 'limit' then
    raise exception 'A limit is always included: set the number (or no limit).' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger plan_entitlements_check before insert or update on public.plan_entitlements
  for each row execute function private.check_entitlement();
alter table public.plan_entitlements enable row level security;
revoke all on public.plan_entitlements from anon, authenticated;
grant select, insert, update, delete on public.plan_entitlements to authenticated;
create policy entitlements_super on public.plan_entitlements for all to authenticated
  using ((select private.is_super_admin())) with check ((select private.is_super_admin()));
create policy entitlements_own_school on public.plan_entitlements for select to authenticated
  using (exists (select 1 from public.school_subscriptions s where s.plan_id = plan_entitlements.plan_id
                 and private.has_school_role(s.school_id, array['school_admin']::public.app_role[])));

-- plans: trial and grace lengths (entered with the plan); limits move into entitlements
alter table public.subscription_plans
  add column trial_days integer not null default 0 check (trial_days between 0 and 365),
  add column grace_period_days integer not null default 0 check (grace_period_days between 0 and 90);
-- Phase 31 plans had every feature; carry their student limit over
insert into public.plan_entitlements (plan_id, feature_key, included, limit_value)
select p.id, f.key, true, case when f.key = 'students' then p.max_students end
from public.subscription_plans p cross join public.plan_features f;
alter table public.subscription_plans drop column max_students, drop column max_staff;
comment on column public.subscription_plans.features is 'Highlights shown to schools (free text). What a plan allows is in plan_entitlements.';

-- ---------------------------------------------------------------- 2. billing settings (the platform as seller)
create table public.billing_settings (
  id                  boolean primary key default true check (id),
  legal_name          text not null check (char_length(btrim(legal_name)) between 2 and 200),
  gstin               text check (gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$'),
  address             text not null check (char_length(address) <= 500),
  state               text not null check (char_length(btrim(state)) between 2 and 100),
  email               text,
  phone               text,
  invoice_prefix      text not null check (invoice_prefix ~ '^[A-Z0-9-]{1,10}$'),
  tax_label           text not null check (char_length(tax_label) between 2 and 20),
  tax_rate            numeric(5, 2) not null check (tax_rate between 0 and 100),
  renewal_lead_days   integer not null check (renewal_lead_days between 0 and 60),    -- issue the renewal invoice this many days ahead
  payment_due_days    integer not null check (payment_due_days between 0 and 90),     -- a first invoice is due this many days after issue
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);
create trigger billing_settings_updated_at before update on public.billing_settings for each row execute function private.set_updated_at();
alter table public.billing_settings enable row level security;
revoke all on public.billing_settings from anon, authenticated;
grant select, insert, update on public.billing_settings to authenticated;
create policy billing_settings_super on public.billing_settings for all to authenticated
  using ((select private.is_super_admin())) with check ((select private.is_super_admin()));

create table private.invoice_counters (fy text primary key, last_number integer not null);

-- ---------------------------------------------------------------- 3. subscriptions: facts only
alter table public.school_subscriptions
  add column started_on date,
  add column cancel_at_period_end boolean not null default false,
  add column cancelled_at timestamptz,
  add column cancel_reason text check (char_length(cancel_reason) <= 500),
  add column billing_gstin text check (billing_gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$');
alter table public.school_subscriptions alter column price drop not null;   -- empty: the plan's price for the cycle
comment on column public.school_subscriptions.price is 'Agreed price per billing cycle; empty = the plan''s price at each invoice.';

-- ---------------------------------------------------------------- 4. billing records
create table public.subscription_invoices (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools(id) on delete restrict,
  invoice_number  text not null unique,
  kind            text not null check (kind in ('subscription', 'renewal', 'imported')),
  plan_id         uuid references public.subscription_plans(id) on delete set null,
  plan_name       text not null,
  billing_cycle   public.billing_cycle not null,
  period_start    date not null,
  period_end      date not null,
  description     text not null,
  subtotal        numeric(12, 2) not null check (subtotal >= 0),
  tax_label       text,
  tax_rate        numeric(5, 2) not null default 0,
  cgst            numeric(12, 2) not null default 0,
  sgst            numeric(12, 2) not null default 0,
  igst            numeric(12, 2) not null default 0,
  tax_amount      numeric(12, 2) not null check (tax_amount >= 0),
  total           numeric(12, 2) not null,
  seller          jsonb not null,
  buyer           jsonb not null,
  issued_on       date not null,
  due_on          date not null,
  voided_at       timestamptz,
  void_reason     text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  constraint subscription_invoices_period check (period_end >= period_start),
  constraint subscription_invoices_sum check (total = subtotal + tax_amount and tax_amount = cgst + sgst + igst),
  constraint subscription_invoices_void check ((voided_at is null) = (void_reason is null))
);
-- one live invoice per school and period
create unique index subscription_invoices_period_key on public.subscription_invoices (school_id, period_start) where voided_at is null;
create index subscription_invoices_school_idx on public.subscription_invoices (school_id, period_start desc);

create table public.subscription_payments (
  id                  uuid primary key default gen_random_uuid(),
  invoice_id          uuid not null references public.subscription_invoices(id) on delete restrict,
  school_id           uuid not null references public.schools(id) on delete restrict,
  amount              numeric(12, 2) not null check (amount > 0),
  refunded_amount     numeric(12, 2) not null default 0 check (refunded_amount >= 0),
  method              text not null check (method in ('razorpay', 'bank_transfer', 'upi', 'cheque', 'cash', 'imported', 'other')),
  method_detail       text,
  reference           text check (char_length(reference) <= 100),
  gateway_order_id    text,
  gateway_payment_id  text unique,
  source              text not null check (source in ('manual', 'checkout', 'webhook', 'imported')),
  paid_on             date not null,
  recorded_by         uuid references auth.users(id) on delete set null,
  refunded_at         timestamptz,
  created_at          timestamptz not null default now(),
  constraint subscription_payments_refund check (refunded_amount <= amount),
  constraint subscription_payments_ref check (method in ('cash', 'imported') or reference is not null or gateway_payment_id is not null)
);
create index subscription_payments_invoice_idx on public.subscription_payments (invoice_id);
create index subscription_payments_school_idx on public.subscription_payments (school_id, paid_on desc);

create table public.billing_orders (
  id                uuid primary key default gen_random_uuid(),
  invoice_id        uuid not null references public.subscription_invoices(id) on delete restrict,
  school_id         uuid not null references public.schools(id) on delete restrict,
  gateway_order_id  text not null unique,
  amount            numeric(12, 2) not null check (amount > 0),
  outcome           text,                   -- what the gateway last said (for people reading it)
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger billing_orders_updated_at before update on public.billing_orders for each row execute function private.set_updated_at();

create table public.billing_webhook_events (
  id           bigint generated always as identity primary key,
  event_id     text not null unique,
  kind         text not null,
  order_id     text,
  payment_id   text,
  outcome      text not null,
  received_at  timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- billing records are written only through the functions below; people read
alter table public.subscription_invoices enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.billing_orders enable row level security;
alter table public.billing_webhook_events enable row level security;
revoke all on public.subscription_invoices, public.subscription_payments, public.billing_orders, public.billing_webhook_events from anon, authenticated;
grant select on public.subscription_invoices, public.subscription_payments, public.billing_orders, public.billing_webhook_events to authenticated;
create policy invoices_read on public.subscription_invoices for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy billing_payments_read on public.subscription_payments for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy billing_orders_read on public.billing_orders for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy billing_events_read on public.billing_webhook_events for select to authenticated using ((select private.is_super_admin()));

-- an invoice's figures, from its payments
-- invoker: a reader only ever sums payments they may see (inside the definer functions below, all of them)
create or replace function private.invoice_paid_amount(p_invoice uuid) returns numeric language sql stable security invoker set search_path = '' as $$
  select coalesce(sum(amount - refunded_amount), 0) from public.subscription_payments where invoice_id = p_invoice;
$$;
create or replace function private.invoice_state(p_invoice uuid) returns text language sql stable security invoker set search_path = '' as $$
  select case
    when i.voided_at is not null then 'void'
    when private.invoice_paid_amount(i.id) >= i.total then 'paid'
    when private.invoice_paid_amount(i.id) > 0 then case when i.due_on < private.ist_today() then 'overdue' else 'partly_paid' end
    when i.due_on < private.ist_today() then 'overdue'
    else 'open' end
  from public.subscription_invoices i where i.id = p_invoice;
$$;

-- ---------------------------------------------------------------- 5. convert Phase 31 subscriptions
do $$
declare s record; v_inv uuid; n integer := 0;
begin
  for s in select ss.*, p.name as plan_name, sc.name as school_name from public.school_subscriptions ss
           join public.subscription_plans p on p.id = ss.plan_id join public.schools sc on sc.id = ss.school_id loop
    update public.school_subscriptions set started_on = s.current_period_start,
      cancelled_at = case when s.status = 'cancelled' then s.updated_at end,
      trial_ends_at = case when s.status = 'trial' then s.trial_ends_at end
    where school_id = s.school_id;
    if s.status in ('active', 'past_due') then
      n := n + 1;
      insert into public.subscription_invoices (school_id, invoice_number, kind, plan_id, plan_name, billing_cycle, period_start, period_end,
        description, subtotal, tax_amount, total, seller, buyer, issued_on, due_on, created_by)
      values (s.school_id, 'IMPORTED-' || lpad(n::text, 5, '0'), 'imported', s.plan_id, s.plan_name, s.billing_cycle,
        s.current_period_start, s.current_period_end,
        s.plan_name || ' plan (recorded before billing records existed)', s.price, 0, s.price,
        jsonb_build_object('note', 'Recorded before billing records existed'), jsonb_build_object('name', s.school_name),
        s.current_period_start, s.current_period_start, s.updated_by)
      returning id into v_inv;
      if s.status = 'active' and s.price > 0 then
        insert into public.subscription_payments (invoice_id, school_id, amount, method, source, paid_on, reference, recorded_by)
        values (v_inv, s.school_id, s.price, 'imported', 'imported', s.current_period_start, 'Recorded as active before billing records existed', s.updated_by);
      end if;
    end if;
  end loop;
end $$;
update public.school_subscriptions set started_on = created_at::date where started_on is null;
alter table public.school_subscriptions alter column started_on set not null;

-- the stored status and period go: status is worked out (below), periods come from invoices
drop function private.platform_analytics();
drop function private.platform_schools(uuid[]);
drop function private.school_usage(uuid);
drop trigger school_subscriptions_history on public.school_subscriptions;
alter table public.school_subscriptions drop constraint school_subscriptions_trial, drop constraint school_subscriptions_period;
alter table public.school_subscriptions drop column status, drop column current_period_start, drop column current_period_end;
drop function private.subscription_state(public.subscription_status, date, date);

-- the history now records what changed, in words and values
alter table public.school_subscription_events add column action text, add column details jsonb;
update public.school_subscription_events set action = 'changed', details = jsonb_build_object('status', status::text,
  'period', current_period_start || ' to ' || current_period_end, 'price', price);
alter table public.school_subscription_events alter column action set not null, alter column details set not null,
  drop column status, drop column current_period_start, drop column current_period_end, alter column price drop not null;
drop type public.subscription_status;

create or replace function private.record_subscription_event() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_action text; v_changes jsonb := '{}';
begin
  if tg_op = 'INSERT' then
    v_action := 'started';
  else
    if new.plan_id is distinct from old.plan_id then v_changes := v_changes || jsonb_build_object('plan', (select name from public.subscription_plans where id = old.plan_id)); end if;
    if new.billing_cycle is distinct from old.billing_cycle then v_changes := v_changes || jsonb_build_object('billing_cycle', old.billing_cycle); end if;
    if new.price is distinct from old.price then v_changes := v_changes || jsonb_build_object('price', old.price); end if;
    if new.trial_ends_at is distinct from old.trial_ends_at then v_changes := v_changes || jsonb_build_object('trial_ends_at', old.trial_ends_at); end if;
    if new.notes is distinct from old.notes then v_changes := v_changes || jsonb_build_object('notes', 'changed'); end if;
    if new.billing_gstin is distinct from old.billing_gstin then v_changes := v_changes || jsonb_build_object('billing_gstin', old.billing_gstin); end if;
    v_action := case
      when new.cancelled_at is not null and old.cancelled_at is null then 'cancelled'
      when new.cancelled_at is null and old.cancelled_at is not null then 'reactivated'
      when new.cancel_at_period_end and not old.cancel_at_period_end then 'set to end at period end'
      when not new.cancel_at_period_end and old.cancel_at_period_end then 'resumed'
      when v_changes <> '{}' then 'changed'
      else null end;
    if v_action is null then return new; end if;
  end if;
  insert into public.school_subscription_events (school_id, plan_id, plan_name, billing_cycle, price, trial_ends_at, notes, changed_by, action, details)
  select new.school_id, new.plan_id, p.name, new.billing_cycle, new.price, new.trial_ends_at, new.notes, (select auth.uid()), v_action,
         jsonb_build_object('previous', v_changes, 'reason', new.cancel_reason)
  from public.subscription_plans p where p.id = new.plan_id;
  return new;
end $$;
create trigger school_subscriptions_history after insert or update on public.school_subscriptions
  for each row execute function private.record_subscription_event();

-- ---------------------------------------------------------------- 6. the status, worked out
create or replace function private.add_cycle(p_start date, p_cycle public.billing_cycle) returns date language sql immutable set search_path = '' as $$
  select (p_start + case when p_cycle = 'yearly' then interval '1 year' else interval '1 month' end - interval '1 day')::date;
$$;

create or replace function private.subscription_status(p_school uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s record; p record; v_today date := private.ist_today(); v_paid_through date; v_cover record; v_base date;
  v_status text; v_access text := 'full'; v_grace_until date; v_ever_paid boolean; v_open integer; v_balance numeric;
begin
  select * into s from public.school_subscriptions where school_id = p_school;
  if not found then return jsonb_build_object('status', 'none', 'access', 'full'); end if;
  select * into p from public.subscription_plans where id = s.plan_id;

  -- coverage comes only from paid invoices (net of refunds)
  select max(i.period_end) into v_paid_through from public.subscription_invoices i
  where i.school_id = p_school and i.voided_at is null and private.invoice_paid_amount(i.id) >= i.total;
  v_ever_paid := v_paid_through is not null;
  select i.period_start, i.period_end, i.id into v_cover from public.subscription_invoices i
  where i.school_id = p_school and i.voided_at is null and i.period_start <= v_today and i.period_end >= v_today
    and private.invoice_paid_amount(i.id) >= i.total
  order by i.period_end desc limit 1;
  select count(*), coalesce(sum(i.total - private.invoice_paid_amount(i.id)), 0) into v_open, v_balance
  from public.subscription_invoices i where i.school_id = p_school and i.voided_at is null and private.invoice_paid_amount(i.id) < i.total;

  if s.cancelled_at is not null then
    v_status := 'cancelled'; v_access := 'read_only';
  elsif v_cover.id is not null then
    v_status := case when s.cancel_at_period_end then 'cancelling' else 'active' end;
  elsif s.trial_ends_at is not null and s.trial_ends_at >= v_today then   -- the trial covers today (even if a later period is already paid)
    v_status := case when s.cancel_at_period_end then 'cancelling' else 'trialing' end;
  else
    -- the last day the school was covered (paid period or trial), or the day before it started
    v_base := greatest(v_paid_through, s.trial_ends_at, s.started_on - 1);
    -- the plan's grace days after that, but never before the invoice for the next period falls due
    -- (a first invoice gets the platform's payment days; a school isn't cut off before its bill is due)
    v_grace_until := greatest(v_base + p.grace_period_days,
      (select min(i.due_on) from public.subscription_invoices i where i.school_id = p_school and i.voided_at is null
         and i.period_start <= v_base + 1 and private.invoice_paid_amount(i.id) < i.total));
    if s.cancel_at_period_end then
      v_status := 'cancelled'; v_access := 'read_only'; v_grace_until := null;
    elsif v_today <= v_grace_until then
      v_status := 'grace';
    else
      v_status := 'expired'; v_access := 'read_only';
    end if;
  end if;

  return jsonb_build_object(
    'status', v_status, 'access', v_access,
    'plan_id', s.plan_id, 'plan_name', p.name, 'billing_cycle', s.billing_cycle,
    'price', coalesce(s.price, case when s.billing_cycle = 'yearly' then p.price_yearly else p.price_monthly end),
    'started_on', s.started_on, 'trial_ends_at', s.trial_ends_at, 'on_trial', v_cover.id is null and s.trial_ends_at is not null and s.trial_ends_at >= v_today,
    'paid_through', v_paid_through, 'ever_paid', v_ever_paid,
    'current_period', case when v_cover.id is null then null else jsonb_build_object('start', v_cover.period_start, 'end', v_cover.period_end) end,
    'grace_until', v_grace_until, 'grace_period_days', p.grace_period_days,
    'cancel_at_period_end', s.cancel_at_period_end, 'cancelled_at', s.cancelled_at,
    'open_invoices', v_open, 'balance_due', v_balance);
end $$;

-- the full picture, for people: the super admin, or that school's own admins
create or replace function private.subscription_overview(p_school uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[])) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  return private.subscription_status(p_school);
end $$;

-- what a member's app needs: one word (full / read_only), and the plan's features
-- (only for a school the caller belongs to, in any state, or the super admin; anyone else gets NULL)
-- no signed-in person (the gateway or sender roles, triggers run by them) counts as allowed: those
-- roles can't be taken by people, and they see only what their own functions return
create or replace function private.is_member_any(p_school uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is null or private.is_super_admin()
      or exists (select 1 from public.school_memberships m where m.school_id = p_school and m.user_id = (select auth.uid()));
$$;
create or replace function private.school_access(p_school uuid) returns text language sql stable security definer set search_path = '' as $$
  select case when private.is_member_any(p_school) then private.subscription_status(p_school) ->> 'access' end;
$$;
-- NULL = no subscription recorded (no limits); else the features the plan includes
create or replace function private.school_features(p_school uuid) returns text[] language sql stable security definer set search_path = '' as $$
  select case when not private.is_member_any(p_school) then '{}'::text[]
    when not exists (select 1 from public.school_subscriptions where school_id = p_school) then null
    else coalesce((select array_agg(e.feature_key order by e.feature_key) from public.school_subscriptions s
                   join public.plan_entitlements e on e.plan_id = s.plan_id and e.included
                   join public.plan_features f on f.key = e.feature_key and f.kind = 'feature'
                   where s.school_id = p_school), '{}') end;
$$;
create or replace function private.school_has_feature(p_school uuid, p_key text) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(p_key = any (private.school_features(p_school)), true);
$$;
-- NULL = no limit (or no subscription); a limit missing from a plan means no limit
create or replace function private.school_limit(p_school uuid, p_key text) returns bigint language sql stable security definer set search_path = '' as $$
  select e.limit_value from public.school_subscriptions s join public.plan_entitlements e on e.plan_id = s.plan_id and e.feature_key = p_key
  where s.school_id = p_school;
$$;

-- files the school stores: Supabase Storage when it reports sizes, else the sizes our file records keep
create or replace function private.school_storage_bytes(p_school uuid) returns bigint language plpgsql stable security definer set search_path = '' as $$
declare v bigint;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'objects' and column_name = 'metadata') then
    execute $q$select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects where split_part(name, '/', 1) = $1::text$q$ into v using p_school;
    return v;
  end if;
  return (select coalesce(sum(size_bytes), 0) from public.student_documents where school_id = p_school)
       + (select coalesce(sum(size_bytes), 0) from public.homework_attachments where school_id = p_school)
       + (select coalesce(sum(size_bytes), 0) from public.homework_submission_files where school_id = p_school)
       + (select coalesce(sum(size_bytes), 0) from public.admission_documents where school_id = p_school)
       + (select coalesce(sum(size_bytes), 0) from public.transport_documents where school_id = p_school);
end $$;
create or replace function private.storage_from_objects() returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'objects' and column_name = 'metadata');
$$;

revoke all on function private.invoice_paid_amount(uuid), private.invoice_state(uuid), private.subscription_status(uuid),
  private.subscription_overview(uuid), private.is_member_any(uuid),
  private.school_access(uuid), private.school_features(uuid), private.school_has_feature(uuid, text), private.school_limit(uuid, text),
  private.school_storage_bytes(uuid), private.storage_from_objects(), private.add_cycle(date, public.billing_cycle) from public, anon;
-- every member may learn their own school's access and features (the app needs them); the rest is checked below
grant execute on function private.school_access(uuid), private.school_features(uuid), private.school_has_feature(uuid, text),
  private.invoice_state(uuid), private.invoice_paid_amount(uuid), private.add_cycle(date, public.billing_cycle),
  private.subscription_overview(uuid), private.is_member_any(uuid) to authenticated;

-- ---------------------------------------------------------------- 7. limits, enforced where they can't be bypassed
create or replace function private.limit_reached(p_school uuid, p_key text, p_label text) returns void language plpgsql security definer set search_path = '' as $$
declare v_limit bigint; v_count bigint;
begin
  v_limit := private.school_limit(p_school, p_key);
  if v_limit is null then return; end if;
  perform pg_advisory_xact_lock(hashtext('limit:' || p_key || ':' || p_school));
  if p_key = 'students' then
    select count(*) into v_count from public.students where school_id = p_school and status = 'active';
  else
    select count(*) into v_count from public.teachers where school_id = p_school and status = 'active';
  end if;
  if v_count > v_limit then
    raise exception 'Your plan allows % active %. Make one inactive first, or ask for a larger plan.', v_limit, p_label using errcode = '23514';
  end if;
end $$;

create or replace function private.enforce_student_limit() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    perform private.limit_reached(new.school_id, 'students', 'students');
  end if;
  return new;
end $$;
create constraint trigger students_plan_limit after insert or update of status on public.students
  deferrable initially immediate for each row execute function private.enforce_student_limit();

create or replace function private.enforce_teacher_limit() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    perform private.limit_reached(new.school_id, 'teachers', 'teachers');
  end if;
  return new;
end $$;
create constraint trigger teachers_plan_limit after insert or update of status on public.teachers
  deferrable initially immediate for each row execute function private.enforce_teacher_limit();

create or replace function private.enforce_storage_limit() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_limit bigint; v_used bigint;
begin
  v_limit := private.school_limit(new.school_id, 'storage_mb');
  if v_limit is null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('limit:storage:' || new.school_id));
  -- after insert: in the fallback count this file is included; in Storage it was uploaded just before
  v_used := private.school_storage_bytes(new.school_id);
  if v_used > v_limit * 1048576 then
    raise exception 'This file would take the school past its plan''s % MB of storage. Remove old files, or ask for a larger plan.', v_limit
      using errcode = '23514';
  end if;
  return new;
end $$;
create constraint trigger student_documents_storage after insert on public.student_documents
  deferrable initially immediate for each row execute function private.enforce_storage_limit();
create constraint trigger homework_attachments_storage after insert on public.homework_attachments
  deferrable initially immediate for each row execute function private.enforce_storage_limit();
create constraint trigger homework_submission_files_storage after insert on public.homework_submission_files
  deferrable initially immediate for each row execute function private.enforce_storage_limit();
create constraint trigger transport_documents_storage after insert on public.transport_documents
  deferrable initially immediate for each row execute function private.enforce_storage_limit();
-- (files from the public admission form count towards storage but are never refused: an applicant can't fix a school's plan)

-- WhatsApp: not queued for a school whose plan doesn't include it
create or replace function private.enforce_whatsapp_feature() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.channel = 'whatsapp' and new.status = 'queued' and not private.school_has_feature(new.school_id, 'whatsapp') then
    new.status := 'skipped';
    new.error := 'WhatsApp notifications aren''t included in the school''s plan.';
  end if;
  return new;
end $$;
create trigger notification_deliveries_plan before insert on public.notification_deliveries
  for each row execute function private.enforce_whatsapp_feature();

-- analytics: also refused in the database when the plan doesn't include it
create or replace function private.analytics_access(p_school uuid, p_area text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_school is null or not (private.is_super_admin() or private.has_school_role(p_school,
       case p_area when 'students' then array['school_admin']::public.app_role[]
                   else array['school_admin', 'accountant']::public.app_role[] end)) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  if not private.is_super_admin() and not private.school_has_feature(p_school, 'analytics') then
    raise exception 'Analytics aren''t included in your school''s plan.' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- ---------------------------------------------------------------- 8. invoices, payments, renewals (functions only)
create or replace function private.billing_actor_ok(p_gateway_allowed boolean) returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_super_admin() or (p_gateway_allowed and current_setting('role', true) = 'erp_billing');
$$;

-- Issues the invoice for one period of a school's subscription. Amounts from the subscription's
-- agreed price (or the plan's price for the cycle), tax from the platform's billing settings:
-- CGST + SGST when the school is in the seller's state, IGST otherwise.
create or replace function private.billing_issue_invoice(p_school uuid, p_period_start date, p_kind text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  s record; p record; b record; sc record; v_sub numeric; v_cgst numeric := 0; v_sgst numeric := 0; v_igst numeric := 0;
  v_today date := private.ist_today(); v_fy text; v_n integer; v_id uuid; v_end date;
begin
  if not private.billing_actor_ok(true) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  select * into b from public.billing_settings;
  if not found then raise exception 'Enter the platform''s billing details first (Platform → Billing).' using errcode = '23514'; end if;
  select * into s from public.school_subscriptions where school_id = p_school;
  if not found then raise exception 'This school has no subscription.' using errcode = 'P0002'; end if;
  select * into p from public.subscription_plans where id = s.plan_id;
  select * into sc from public.schools where id = p_school;
  v_end := private.add_cycle(p_period_start, s.billing_cycle);
  v_sub := coalesce(s.price, case when s.billing_cycle = 'yearly' then p.price_yearly else p.price_monthly end);
  if lower(btrim(coalesce(sc.state, ''))) = lower(btrim(b.state)) then
    v_cgst := round(v_sub * b.tax_rate / 200, 2); v_sgst := v_cgst;
  else
    v_igst := round(v_sub * b.tax_rate / 100, 2);
  end if;
  v_fy := case when extract(month from v_today) >= 4
    then extract(year from v_today)::int || '-' || lpad(((extract(year from v_today)::int + 1) % 100)::text, 2, '0')
    else (extract(year from v_today)::int - 1) || '-' || lpad((extract(year from v_today)::int % 100)::text, 2, '0') end;
  insert into private.invoice_counters as c (fy, last_number) values (v_fy, 1)
    on conflict (fy) do update set last_number = c.last_number + 1 returning last_number into v_n;
  insert into public.subscription_invoices (school_id, invoice_number, kind, plan_id, plan_name, billing_cycle, period_start, period_end,
    description, subtotal, tax_label, tax_rate, cgst, sgst, igst, tax_amount, total, seller, buyer, issued_on, due_on, created_by)
  values (p_school, b.invoice_prefix || '/' || v_fy || '/' || lpad(v_n::text, 5, '0'), p_kind, p.id, p.name, s.billing_cycle,
    p_period_start, v_end,
    p.name || ' plan, ' || case when s.billing_cycle = 'yearly' then 'yearly' else 'monthly' end || ' subscription, '
      || to_char(p_period_start, 'DD Mon YYYY') || ' to ' || to_char(v_end, 'DD Mon YYYY'),
    v_sub, b.tax_label, b.tax_rate, v_cgst, v_sgst, v_igst, v_cgst + v_sgst + v_igst, v_sub + v_cgst + v_sgst + v_igst,
    jsonb_build_object('name', b.legal_name, 'gstin', b.gstin, 'address', b.address, 'state', b.state, 'email', b.email, 'phone', b.phone),
    jsonb_build_object('name', sc.name, 'code', sc.code, 'address', concat_ws(', ', nullif(sc.address, ''), nullif(sc.city, ''), nullif(sc.postal_code, '')),
                       'state', sc.state, 'email', sc.email, 'phone', sc.phone, 'gstin', s.billing_gstin),
    v_today, greatest(p_period_start, v_today + case when p_kind = 'subscription' then b.payment_due_days else 0 end),
    (select auth.uid()))
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'There is already an invoice for this period.' using errcode = '23505';
end $$;

-- The next period to bill: the day after the last invoiced period, else after the trial, else the start.
create or replace function private.billing_next_period(p_school uuid) returns date language sql stable security definer set search_path = '' as $$
  select coalesce((select max(i.period_end) + 1 from public.subscription_invoices i where i.school_id = p_school and i.voided_at is null),
                  (select case when s.trial_ends_at is not null then s.trial_ends_at + 1 else s.started_on end
                   from public.school_subscriptions s where s.school_id = p_school));
$$;

-- Renewals: issues the next invoice for every subscription that continues, once its next period is within
-- the platform's lead days, unless an unpaid invoice is already waiting. Safe to run any number of times.
create or replace function private.billing_run() returns integer language plpgsql security definer set search_path = '' as $$
declare s record; b record; v_next date; n integer := 0; v_status text;
begin
  if not private.billing_actor_ok(true) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  select * into b from public.billing_settings;
  if not found then return 0; end if;
  for s in select * from public.school_subscriptions ss join public.schools sc on sc.id = ss.school_id
           where ss.cancelled_at is null and not ss.cancel_at_period_end and sc.status = 'active' loop
    v_status := private.subscription_status(s.school_id) ->> 'status';
    continue when v_status in ('expired', 'cancelled');
    continue when exists (select 1 from public.subscription_invoices i where i.school_id = s.school_id and i.voided_at is null
                          and private.invoice_paid_amount(i.id) < i.total);
    v_next := private.billing_next_period(s.school_id);
    continue when v_next - b.renewal_lead_days > private.ist_today();
    perform private.billing_issue_invoice(s.school_id, v_next,
      case when exists (select 1 from public.subscription_invoices i where i.school_id = s.school_id and i.voided_at is null) then 'renewal' else 'subscription' end);
    n := n + 1;
  end loop;
  return n;
end $$;

-- A payment against an invoice. By hand (super admin: bank transfer, UPI, cheque...) or from the
-- gateway (erp_billing, after the API verified it with Razorpay). Idempotent per gateway payment.
create or replace function private.billing_record_payment(p_invoice uuid, p_amount numeric, p_method text, p_detail text, p_reference text,
  p_paid_on date, p_source text, p_order text, p_payment text) returns uuid language plpgsql security definer set search_path = '' as $$
declare i record; v_id uuid; v_balance numeric;
begin
  if not private.billing_actor_ok(p_source in ('checkout', 'webhook')) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  if p_source = 'manual' and not private.is_super_admin() then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  if p_payment is not null then
    select id into v_id from public.subscription_payments where gateway_payment_id = p_payment;
    if found then return v_id; end if;
  end if;
  select * into i from public.subscription_invoices where id = p_invoice for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if i.voided_at is not null then raise exception 'This invoice was cancelled.' using errcode = '23514'; end if;
  v_balance := i.total - private.invoice_paid_amount(i.id);
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount received.' using errcode = '23514'; end if;
  -- by hand, never more than is owed; money the gateway actually took is always recorded (and shows as overpaid)
  if p_source = 'manual' and p_amount > v_balance then
    raise exception 'That is more than the % still due on this invoice.', v_balance using errcode = '23514';
  end if;
  if p_paid_on > private.ist_today() then raise exception 'The payment date can''t be in the future.' using errcode = '23514'; end if;
  insert into public.subscription_payments (invoice_id, school_id, amount, method, method_detail, reference, gateway_order_id, gateway_payment_id,
    source, paid_on, recorded_by)
  values (i.id, i.school_id, p_amount, p_method, p_detail, nullif(btrim(p_reference), ''), p_order, p_payment, p_source, p_paid_on, (select auth.uid()))
  returning id into v_id;
  if p_order is not null then
    update public.billing_orders set outcome = 'paid' where gateway_order_id = p_order;
  end if;
  return v_id;
end $$;

-- A refund (from the gateway's webhook, or recorded by hand by the super admin). Coverage follows:
-- an invoice that is no longer fully paid no longer counts.
create or replace function private.billing_record_refund(p_payment uuid, p_gateway_payment text, p_amount numeric)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not private.billing_actor_ok(true) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  select * into r from public.subscription_payments
  where (p_payment is not null and id = p_payment) or (p_gateway_payment is not null and gateway_payment_id = p_gateway_payment) for update;
  if not found then return false; end if;
  if p_amount is null or p_amount <= 0 or r.refunded_amount + p_amount > r.amount then
    raise exception 'A refund can''t be more than what was paid.' using errcode = '23514';
  end if;
  update public.subscription_payments set refunded_amount = refunded_amount + p_amount, refunded_at = now() where id = r.id;
  return true;
end $$;

create or replace function private.billing_void_invoice(p_invoice uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_super_admin() then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Say why the invoice is cancelled.' using errcode = '23514'; end if;
  if private.invoice_paid_amount(p_invoice) > 0 then
    raise exception 'Money was received on this invoice: refund it first.' using errcode = '23514';
  end if;
  update public.subscription_invoices set voided_at = now(), void_reason = btrim(p_reason) where id = p_invoice and voided_at is null;
  if not found then raise exception 'Invoice not found, or already cancelled.' using errcode = 'P0002'; end if;
end $$;

-- gateway orders and webhook events (erp_billing)
create or replace function private.billing_open_order(p_invoice uuid, p_order text, p_amount numeric) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; i record;
begin
  -- the school's own admin asks to pay (checked here too); the API then created the order at Razorpay
  select * into i from public.subscription_invoices where id = p_invoice;
  if not found or not (private.is_super_admin() or private.has_school_role(i.school_id, array['school_admin']::public.app_role[])) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  insert into public.billing_orders (invoice_id, school_id, gateway_order_id, amount, outcome, created_by)
  values (i.id, i.school_id, p_order, p_amount, 'created', (select auth.uid())) returning id into v_id;
  return v_id;
end $$;
create or replace function private.billing_find_order(p_order text) returns table (id uuid, invoice_id uuid, school_id uuid, amount numeric)
language sql stable security definer set search_path = '' as $$
  select o.id, o.invoice_id, o.school_id, o.amount from public.billing_orders o
  where o.gateway_order_id = p_order and (current_setting('role', true) = 'erp_billing' or private.is_super_admin());
$$;
create or replace function private.billing_order_outcome(p_order text, p_outcome text) returns void language sql security definer set search_path = '' as $$
  update public.billing_orders set outcome = left(p_outcome, 200) where gateway_order_id = p_order and current_setting('role', true) = 'erp_billing';
$$;
create or replace function private.billing_log_event(p_event text, p_kind text, p_order text, p_payment text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('role', true) is distinct from 'erp_billing' then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  insert into public.billing_webhook_events (event_id, kind, order_id, payment_id, outcome) values (p_event, p_kind, p_order, p_payment, 'received')
  on conflict (event_id) do nothing;
  return found;
end $$;
create or replace function private.billing_event_outcome(p_event text, p_outcome text) returns void language sql security definer set search_path = '' as $$
  update public.billing_webhook_events set outcome = left(p_outcome, 200), updated_at = now() where event_id = p_event and current_setting('role', true) = 'erp_billing';
$$;

-- cancelling and resuming: a school's admin may end the subscription at the period's end (and undo it);
-- only the platform cancels at once or brings a cancelled subscription back
create or replace function private.subscription_cancel(p_school uuid, p_mode text, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare s record;
begin
  select * into s from public.school_subscriptions where school_id = p_school for update;
  if not found then raise exception 'This school has no subscription.' using errcode = 'P0002'; end if;
  if p_mode in ('at_period_end', 'resume') then
    if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[])) then
      raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
    end if;
  elsif not private.is_super_admin() then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  if p_mode = 'at_period_end' then
    if s.cancelled_at is not null then raise exception 'This subscription is already cancelled.' using errcode = '23514'; end if;
    if private.subscription_status(p_school) ->> 'status' in ('expired', 'cancelled') then
      raise exception 'This subscription has already ended.' using errcode = '23514';
    end if;
    update public.school_subscriptions set cancel_at_period_end = true, cancel_reason = nullif(btrim(p_reason), '') where school_id = p_school;
  elsif p_mode = 'resume' then
    if s.cancelled_at is not null then raise exception 'A cancelled subscription is brought back by the platform.' using errcode = '23514'; end if;
    if private.subscription_status(p_school) ->> 'status' <> 'cancelling' then
      raise exception 'Only a subscription that is set to end can be resumed.' using errcode = '23514';
    end if;
    update public.school_subscriptions set cancel_at_period_end = false, cancel_reason = null where school_id = p_school;
  elsif p_mode = 'now' then
    if s.cancelled_at is not null then raise exception 'This subscription is already cancelled.' using errcode = '23514'; end if;
    update public.school_subscriptions set cancelled_at = now(), cancel_reason = nullif(btrim(p_reason), '') where school_id = p_school;
  elsif p_mode = 'reactivate' then
    update public.school_subscriptions set cancelled_at = null, cancel_at_period_end = false, cancel_reason = null where school_id = p_school;
  else
    raise exception 'Unknown action.' using errcode = '22023';
  end if;
end $$;

revoke all on function private.billing_issue_invoice(uuid, date, text), private.billing_next_period(uuid), private.billing_run(),
  private.billing_record_payment(uuid, numeric, text, text, text, date, text, text, text), private.billing_record_refund(uuid, text, numeric),
  private.billing_void_invoice(uuid, text), private.billing_open_order(uuid, text, numeric), private.billing_find_order(text),
  private.billing_order_outcome(text, text), private.billing_log_event(text, text, text, text), private.billing_event_outcome(text, text),
  private.subscription_cancel(uuid, text, text), private.billing_actor_ok(boolean), private.limit_reached(uuid, text, text) from public, anon;
grant execute on function private.billing_issue_invoice(uuid, date, text), private.billing_next_period(uuid), private.billing_run(),
  private.billing_record_payment(uuid, numeric, text, text, text, date, text, text, text), private.billing_record_refund(uuid, text, numeric),
  private.billing_void_invoice(uuid, text), private.billing_open_order(uuid, text, numeric), private.subscription_cancel(uuid, text, text),
  private.billing_find_order(text) to authenticated;
grant execute on function private.billing_run(), private.billing_issue_invoice(uuid, date, text), private.billing_next_period(uuid),
  private.billing_record_payment(uuid, numeric, text, text, text, date, text, text, text), private.billing_record_refund(uuid, text, numeric),
  private.billing_find_order(text), private.billing_order_outcome(text, text), private.billing_log_event(text, text, text, text),
  private.billing_event_outcome(text, text), private.billing_actor_ok(boolean), private.subscription_status(uuid),
  private.invoice_paid_amount(uuid), private.is_super_admin(), private.ist_today(), private.add_cycle(date, public.billing_cycle) to erp_billing;
-- subscription_status reads plans and invoices as the owner (security definer); who may SEE it is checked by its callers:
-- the API asks only for schools the caller belongs to, or as the super admin.

-- ---------------------------------------------------------------- 9. usage and analytics on the new records
create or replace function private.school_usage(p_school uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.ist_today(); v_since date := private.ist_today() - 29;
  v_session uuid; v_session_name text; v_storage bigint; out jsonb; v_limits jsonb;
begin
  perform private.platform_access(p_school);
  if not exists (select 1 from public.schools where id = p_school) then return null; end if;
  select id, name into v_session, v_session_name from public.academic_sessions where school_id = p_school and is_current;
  v_storage := private.school_storage_bytes(p_school);
  select jsonb_object_agg(f.key, jsonb_build_object('label', f.label, 'kind', f.kind, 'unit', f.unit, 'available', f.available,
           'included', coalesce(e.included, f.kind = 'limit'), 'limit', e.limit_value) order by f.display_order)
    into v_limits
  from public.plan_features f
  left join public.school_subscriptions s on s.school_id = p_school
  left join public.plan_entitlements e on e.plan_id = s.plan_id and e.feature_key = f.key
  where exists (select 1 from public.school_subscriptions where school_id = p_school);

  select jsonb_build_object(
    'school_id', p_school,
    'session', case when v_session is null then null else jsonb_build_object('id', v_session, 'name', v_session_name) end,
    'students', jsonb_build_object(
      'active', (select count(*) from public.students where school_id = p_school and status = 'active'),
      'total', (select count(*) from public.students where school_id = p_school),
      'enrolled_this_session', (select count(*) from public.student_enrollments where school_id = p_school and academic_session_id = v_session)),
    'teachers', (select count(*) from public.teachers where school_id = p_school and status = 'active'),
    'people', jsonb_build_object(
      'school_admins', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'school_admin'),
      'accountants', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'accountant'),
      'teachers', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'teacher'),
      'librarians', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'librarian'),
      'parents', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'parent'),
      'students', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'student'),
      'staff', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active'
                and role in ('school_admin', 'accountant', 'teacher', 'librarian'))),
    'classes', (select count(*) from public.classes where school_id = p_school and deleted_at is null and is_active),
    'sections', (select count(*) from public.sections where school_id = p_school and academic_session_id = v_session and deleted_at is null),
    'last_30_days', jsonb_build_object(
      'from', v_since, 'to', v_today,
      'attendance_days', (select count(distinct attendance_date) from public.attendance_records where school_id = p_school and attendance_date between v_since and v_today),
      'receipts', (select count(*) from public.fee_payments where school_id = p_school and cancelled_at is null and payment_date between v_since and v_today),
      'collected', (select coalesce(sum(amount), 0) from public.fee_payments where school_id = p_school and cancelled_at is null and payment_date between v_since and v_today),
      'notifications', (select count(*) from public.notifications where school_id = p_school and created_at >= v_since),
      'whatsapp_sent', (select count(*) from public.notification_deliveries where school_id = p_school and channel = 'whatsapp'
                        and status in ('sent', 'delivered', 'read') and created_at >= v_since),
      'actions', (select count(*) from public.audit_logs where school_id = p_school and created_at >= v_since)),
    'last_activity_at', (select max(created_at) from public.audit_logs where school_id = p_school),
    'storage_bytes', v_storage,
    'storage_source', case when private.storage_from_objects() then 'storage' else 'file_records' end,
    'entitlements', v_limits
  ) into out;

  out := out || jsonb_build_object('over_limits', jsonb_build_object(
    'students', coalesce((v_limits #>> '{students,limit}')::bigint < (out #>> '{students,active}')::bigint, false),
    'teachers', coalesce((v_limits #>> '{teachers,limit}')::bigint < (out ->> 'teachers')::bigint, false),
    'storage_mb', coalesce((v_limits #>> '{storage_mb,limit}')::bigint * 1048576 < v_storage, false)));
  return out;
end $$;

create or replace function private.platform_schools(p_ids uuid[])
returns table (school_id uuid, plan_name text, subscription_state text, current_period_end date, trial_ends_at date,
               students_active bigint, staff bigint, max_students bigint, last_activity_at timestamptz)
language plpgsql stable security definer set search_path = '' set jit = off as $$
begin
  perform private.platform_access(null);
  return query
  select s.id, p.name, case when sub.school_id is null then null else private.subscription_status(s.id) ->> 'status' end,
         (private.subscription_status(s.id) ->> 'paid_through')::date, sub.trial_ends_at,
         (select count(*) from public.students st where st.school_id = s.id and st.status = 'active'),
         (select count(distinct m.user_id) from public.school_memberships m where m.school_id = s.id and m.status = 'active'
            and m.role in ('school_admin', 'accountant', 'teacher', 'librarian')),
         private.school_limit(s.id, 'students'),
         (select max(a.created_at) from public.audit_logs a where a.school_id = s.id)
  from public.schools s
  left join public.school_subscriptions sub on sub.school_id = s.id
  left join public.subscription_plans p on p.id = sub.plan_id
  where s.id = any (p_ids);
end $$;

create or replace function private.platform_analytics()
returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.ist_today(); v_month date := date_trunc('month', private.ist_today())::date; out jsonb;
begin
  perform private.platform_access(null);
  with subs as materialized (
    select s.school_id, sc.name as school_name, sc.status::text as school_status, s.plan_id, p.name as plan_name, x.st, x.st ->> 'status' as state,
           private.monthly_value((x.st ->> 'billing_cycle')::public.billing_cycle, (x.st ->> 'price')::numeric) as mrr
    from public.school_subscriptions s join public.schools sc on sc.id = s.school_id join public.subscription_plans p on p.id = s.plan_id
    cross join lateral (select private.subscription_status(s.school_id) as st) x
  ),
  paying as (select * from subs where state in ('active', 'cancelling', 'grace') and (st ->> 'ever_paid')::boolean and school_status = 'active'),
  months as (select (v_month - make_interval(months => g))::date as month from generate_series(11, 0, -1) g),
  activity as (select school_id, max(created_at) as at from public.audit_logs where school_id is not null group by school_id),
  sizes as (
    select sc.id, sc.name, sc.status,
           (select count(*) from public.students st where st.school_id = sc.id and st.status = 'active') as students,
           (select count(*) from public.teachers t where t.school_id = sc.id and t.status = 'active') as teachers,
           (select count(distinct m.user_id) from public.school_memberships m where m.school_id = sc.id and m.status = 'active'
              and m.role in ('school_admin', 'accountant', 'teacher', 'librarian')) as staff
    from public.schools sc
  ),
  inv as (
    select i.*, private.invoice_paid_amount(i.id) as paid from public.subscription_invoices i where i.voided_at is null
  )
  select jsonb_build_object(
    'as_of', v_today,
    'schools', jsonb_build_object(
      'total', (select count(*) from public.schools),
      'active', (select count(*) from public.schools where status = 'active'),
      'inactive', (select count(*) from public.schools where status <> 'active'),
      'added_this_month', (select count(*) from public.schools where created_at >= v_month),
      'active_last_7_days', (select count(*) from activity where at >= v_today - 6),
      'active_last_30_days', (select count(*) from activity where at >= v_today - 29),
      'without_subscription', (select count(*) from public.schools sc where not exists (select 1 from public.school_subscriptions s where s.school_id = sc.id)),
      'without_admin', (select count(*) from public.schools sc where not exists (select 1 from public.school_memberships m
                          where m.school_id = sc.id and m.role = 'school_admin' and m.status = 'active'))),
    'people', jsonb_build_object(
      'students_active', (select count(*) from public.students where status = 'active'),
      'staff', (select count(distinct (school_id, user_id)) from public.school_memberships where status = 'active' and role in ('school_admin', 'accountant', 'teacher', 'librarian')),
      'parents', (select count(distinct user_id) from public.school_memberships where status = 'active' and role = 'parent'),
      'student_logins', (select count(distinct user_id) from public.school_memberships where status = 'active' and role = 'student'),
      'accounts', (select count(*) from public.profiles where not is_super_admin)),
    'subscriptions', jsonb_build_object(
      'by_state', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from subs group by state) t), '{}'),
      'mrr', coalesce((select sum(mrr) from paying), 0),
      'arr', coalesce((select sum(mrr) * 12 from paying), 0),
      'by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan', p.name, 'plan_id', p.id, 'is_active', p.is_active,
            'schools', (select count(*) from subs where plan_id = p.id),
            'paying', (select count(*) from paying where plan_id = p.id),
            'mrr', coalesce((select sum(mrr) from paying where plan_id = p.id), 0))
          order by p.display_order, p.name) from public.subscription_plans p), '[]'),
      'renewals_due', coalesce((select jsonb_agg(jsonb_build_object('school_id', school_id, 'school', school_name, 'plan', plan_name, 'state', state,
            'date', coalesce((st ->> 'paid_through')::date, (st ->> 'trial_ends_at')::date)) order by coalesce((st ->> 'paid_through')::date, (st ->> 'trial_ends_at')::date))
          from subs where state in ('active', 'trialing', 'cancelling')
            and coalesce((st ->> 'paid_through')::date, (st ->> 'trial_ends_at')::date) between v_today and v_today + 30), '[]'),
      'needs_attention', coalesce((select jsonb_agg(jsonb_build_object('school_id', school_id, 'school', school_name, 'plan', plan_name, 'state', state,
            'date', coalesce((st ->> 'grace_until')::date, (st ->> 'paid_through')::date)) order by school_name)
          from subs where state in ('grace', 'expired') and school_status = 'active'), '[]')),
    'billing', jsonb_build_object(
      'invoiced_this_month', (select coalesce(sum(total), 0) from inv where issued_on >= v_month),
      'collected_this_month', (select coalesce(sum(p.amount - p.refunded_amount), 0) from public.subscription_payments p where p.paid_on >= v_month),
      'outstanding', (select coalesce(sum(total - paid), 0) from inv where paid < total),
      'overdue', (select coalesce(sum(total - paid), 0) from inv where paid < total and due_on < v_today),
      'open_invoices', (select count(*) from inv where paid < total)),
    'growth', (select jsonb_agg(jsonb_build_object('month', mo.month,
        'new_schools', (select count(*) from public.schools sc where date_trunc('month', sc.created_at at time zone 'Asia/Kolkata') = mo.month),
        'schools', (select count(*) from public.schools sc where (sc.created_at at time zone 'Asia/Kolkata')::date < (mo.month + interval '1 month')::date),
        'new_students', (select count(*) from public.students st where date_trunc('month', st.created_at at time zone 'Asia/Kolkata') = mo.month),
        'fees_collected', (select coalesce(sum(fp.amount), 0) from public.fee_payments fp where fp.cancelled_at is null and date_trunc('month', fp.payment_date) = mo.month),
        'receipts', (select count(*) from public.fee_payments fp where fp.cancelled_at is null and date_trunc('month', fp.payment_date) = mo.month),
        'subscription_revenue', (select coalesce(sum(p.amount - p.refunded_amount), 0) from public.subscription_payments p where date_trunc('month', p.paid_on) = mo.month),
        'active_schools', (select count(distinct a.school_id) from public.audit_logs a where a.school_id is not null
                             and date_trunc('month', a.created_at at time zone 'Asia/Kolkata') = mo.month))
        order by mo.month) from months mo),
    'largest_schools', coalesce((select jsonb_agg(jsonb_build_object('school_id', id, 'school', name, 'status', status, 'students', students, 'staff', staff)
        order by students desc, name) from (select * from sizes order by students desc, name limit 10) t), '[]'),
    'over_limits', coalesce((select jsonb_agg(jsonb_build_object('school_id', z.id, 'school', z.name, 'plan', p.name,
          'students', z.students, 'max_students', private.school_limit(z.id, 'students'),
          'teachers', z.teachers, 'max_teachers', private.school_limit(z.id, 'teachers')) order by z.name)
        from sizes z join public.school_subscriptions s on s.school_id = z.id join public.subscription_plans p on p.id = s.plan_id
        where z.students > coalesce(private.school_limit(z.id, 'students'), z.students)
           or z.teachers > coalesce(private.school_limit(z.id, 'teachers'), z.teachers)), '[]')
  ) into out;
  return out;
end $$;

revoke all on function private.school_usage(uuid), private.platform_schools(uuid[]), private.platform_analytics() from public, anon;
grant execute on function private.school_usage(uuid), private.platform_schools(uuid[]), private.platform_analytics() to authenticated;
