-- =====================================================================
-- Phase 29: the app on phones (PWA) — Web Push notifications
--
--   push_subscriptions   one row per browser / installed app that agreed to notifications:
--                        the push service address and its encryption keys (standard Web Push),
--                        whether the lock screen may show the details, and delivery health
--   private.push_outbox  what still has to be pushed: one row per new in-app notification
--                        per device of that person (filled by a trigger on notifications)
--
-- Every in-app notification (public.notifications, migration 0020) is also pushed to the
-- person's devices, so push follows the school's notification settings and templates with
-- no separate rules. The background sender (role erp_notify) claims rows, encrypts and
-- sends them, and reports back: a device the push service says is gone is removed.
-- People see and remove only their own devices; nobody else can read them.
-- =====================================================================

create table public.push_subscriptions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles (id) on delete cascade,
  -- https only (plain http just for a local stand-in in test set-ups); the API also checks it is a known push service
  endpoint         text not null check (endpoint ~ '^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(localhost|127\.0\.0\.1)(:[0-9]+)?)/'
                                        and char_length(endpoint) <= 1000),
  p256dh           text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}={0,2}$'),   -- the browser's public key (base64url)
  auth             text not null check (auth ~ '^[A-Za-z0-9_-]{16,30}={0,2}$'),      -- its auth secret (base64url)
  device_label     text check (device_label is null or char_length(btrim(device_label)) between 1 and 100),
  show_preview     boolean not null default true,   -- false: the lock screen shows only "new notification from <school>"
  failures         smallint not null default 0,
  created_at       timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  last_success_at  timestamptz
);
-- a device belongs to whoever subscribed last on it
create unique index push_subscriptions_endpoint_key on public.push_subscriptions (endpoint);
create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create table private.push_outbox (
  id               uuid primary key default gen_random_uuid(),
  notification_id  uuid not null references public.notifications (id) on delete cascade,
  subscription_id  uuid not null references public.push_subscriptions (id) on delete cascade,
  status           text not null default 'queued' check (status in ('queued', 'sending')),
  attempts         smallint not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint push_outbox_once unique (notification_id, subscription_id)
);
create index push_outbox_due_idx on private.push_outbox (next_attempt_at) where status = 'queued';

-- A new in-app notification is queued for each of that person's devices.
create or replace function private.push_enqueue() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into private.push_outbox (notification_id, subscription_id)
  select new.id, s.id from public.push_subscriptions s where s.user_id = new.user_id
  on conflict do nothing;
  return null;
end $$;
create trigger notifications_push after insert on public.notifications for each row execute function private.push_enqueue();

-- ---------------------------------------------------------------------
-- The signed-in person registers this device (or refreshes it). An address already
-- registered — the same phone, possibly by someone who used it before — moves to them.
-- ---------------------------------------------------------------------
create or replace function private.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_label text, p_show_preview boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_id uuid; v_old uuid;
begin
  if v_user is null or not exists (select 1 from public.profiles where id = v_user) then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;
  select id, user_id into v_id, v_old from public.push_subscriptions where endpoint = p_endpoint for update;
  if v_id is not null and v_old <> v_user then
    delete from public.push_subscriptions where id = v_id;   -- someone else's notifications must not reach the new person
    v_id := null;
  end if;
  if v_id is null then
    -- a new device: keep the 10 most recently used, the oldest makes room
    delete from public.push_subscriptions
    where id in (select id from public.push_subscriptions where user_id = v_user order by last_seen_at desc offset 9);
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, device_label, show_preview, last_seen_at)
    values (v_user, p_endpoint, p_p256dh, p_auth, nullif(btrim(p_label), ''), coalesce(p_show_preview, true), clock_timestamp())
    returning id into v_id;
  else
    update public.push_subscriptions
    set p256dh = p_p256dh, auth = p_auth, device_label = coalesce(nullif(btrim(p_label), ''), device_label),
        show_preview = coalesce(p_show_preview, show_preview), failures = 0, last_seen_at = clock_timestamp()
    where id = v_id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Sender side (role erp_notify)
-- ---------------------------------------------------------------------
create or replace function private.push_claim(p_limit integer)
returns table (id uuid, attempts smallint, subscription_id uuid, endpoint text, p256dh text, auth text, show_preview boolean,
               notification_id uuid, title text, body text, link text, read boolean, school_name text)
language sql security definer set search_path = '' as $$
  with c as (
    update private.push_outbox o set status = 'sending', attempts = o.attempts + 1, updated_at = now()
    where o.id in (select x.id from private.push_outbox x
                   where (x.status = 'queued' and x.next_attempt_at <= now())
                      or (x.status = 'sending' and x.updated_at < now() - interval '10 minutes')   -- a sender that died
                   order by x.next_attempt_at limit p_limit for update skip locked)
    returning o.*
  )
  select c.id, c.attempts, s.id, s.endpoint, s.p256dh, s.auth, s.show_preview,
         n.id, n.title, n.body, n.link, n.read_at is not null, sch.name
  from c join public.push_subscriptions s on s.id = c.subscription_id
         join public.notifications n on n.id = c.notification_id
         join public.schools sch on sch.id = n.school_id;
$$;

-- outcome: sent | skipped (already read) | gone (the push service forgot the device) | retry | failed
create or replace function private.push_result(p_id uuid, p_outcome text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare o private.push_outbox;
begin
  select * into o from private.push_outbox where id = p_id for update;
  if not found then return; end if;
  if p_outcome in ('sent', 'skipped') then
    delete from private.push_outbox where id = p_id;
    if p_outcome = 'sent' then
      update public.push_subscriptions set last_success_at = now(), failures = 0 where id = o.subscription_id;
    end if;
  elsif p_outcome = 'gone' then
    delete from public.push_subscriptions where id = o.subscription_id;           -- its queued pushes go with it
  elsif p_outcome = 'retry' and o.attempts < 4 then
    update private.push_outbox
    set status = 'queued', last_error = left(p_error, 300), updated_at = now(),
        next_attempt_at = now() + (array[1, 5, 30])[least(o.attempts, 3)] * interval '1 minute'
    where id = p_id;
  else   -- failed, or out of retries
    delete from private.push_outbox where id = p_id;
    update public.push_subscriptions set failures = least(failures + 1, 1000) where id = o.subscription_id;
    -- a device that keeps failing is dropped (it re-registers by itself the next time the app is opened)
    delete from public.push_subscriptions where id = o.subscription_id and failures >= 20;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------
revoke all on public.push_subscriptions from anon, authenticated;
revoke all on private.push_outbox from public, anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;
grant update (show_preview, device_label) on public.push_subscriptions to authenticated;
alter table public.push_subscriptions enable row level security;
create policy push_subscriptions_own_select on public.push_subscriptions for select to authenticated using (user_id = (select auth.uid()));
create policy push_subscriptions_own_update on public.push_subscriptions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy push_subscriptions_own_delete on public.push_subscriptions for delete to authenticated using (user_id = (select auth.uid()));

revoke all on function private.push_enqueue(), private.push_subscribe(text, text, text, text, boolean),
  private.push_claim(integer), private.push_result(uuid, text, text) from public, anon, authenticated;
grant execute on function private.push_subscribe(text, text, text, text, boolean) to authenticated;
grant execute on function private.push_claim(integer), private.push_result(uuid, text, text) to erp_notify;
