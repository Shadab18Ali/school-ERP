-- =====================================================================
-- Push notifications test (migrations 0001-0027). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL PUSH TESTS PASSED".
-- Two people (Parent P and Teacher T) of one school register phones; notifications for
-- them are queued per device; "erp_notify" stands in for the API's background sender.
-- =====================================================================
begin;

create function private._p_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
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
  perform set_config('role', 'erp_notify', true);
end $$;
-- what the owner sees (bypassing RLS), for checking
create function private._p_outbox(p_user uuid) returns bigint language sql security definer set search_path = '' as $$
  select count(*) from private.push_outbox o join public.push_subscriptions s on s.id = o.subscription_id where s.user_id = p_user;
$$;
create function private._p_subs(p_user uuid) returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.push_subscriptions where user_id = p_user;
$$;
create function private._p_sub(p_endpoint text) returns public.push_subscriptions language sql security definer set search_path = '' as $$
  select * from public.push_subscriptions where endpoint = p_endpoint;
$$;
create function private._p_box(p_id uuid) returns private.push_outbox language sql security definer set search_path = '' as $$
  select * from private.push_outbox where id = p_id;
$$;
create function private._p_notify(p_user uuid, p_title text) returns uuid language sql security definer set search_path = '' as $$
  insert into public.notifications (school_id, user_id, event_key, title, body, link)
  values ('b2900000-0000-4000-8000-00000000000a', p_user, 'notice_published', p_title, 'Body of ' || p_title, '/notices')
  returning id;
$$;
grant execute on function private._p_assert(boolean, text), private._p_raises(text, text, text, text), private._p_as(uuid),
  private._p_worker(), private._p_outbox(uuid), private._p_subs(uuid), private._p_sub(text), private._p_box(uuid),
  private._p_notify(uuid, text) to authenticated, erp_notify;

-- keys as browsers produce them (base64url: 65-byte P-256 point, 16-byte secret)
create function private._p_key() returns text language sql as $$ select 'B' || repeat('Kx3_-q', 14) || 'Ab' $$;   -- 87 chars
create function private._p_auth() returns text language sql as $$ select 'Tq9_aZ-k3LmN0pQrStUvWx' $$;                  -- 22 chars
grant execute on function private._p_key(), private._p_auth() to authenticated, erp_notify;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a2900000-0000-4000-8000-000000000001', 'push-parent@example.invalid'),
  ('a2900000-0000-4000-8000-000000000002', 'push-teacher@example.invalid');
insert into public.schools (id, name, code) values ('b2900000-0000-4000-8000-00000000000a', 'Push Test School', 'ZZPU-A');

-- ================= registering a device =================
select private._p_as('a2900000-0000-4000-8000-000000000001');
select private.push_subscribe('https://fcm.googleapis.com/fcm/send/parent-phone', private._p_key(), private._p_auth(), 'Android · Chrome', true);
select private._p_assert((select count(*) = 1 and bool_and(user_id = 'a2900000-0000-4000-8000-000000000001' and device_label = 'Android · Chrome' and show_preview)
  from public.push_subscriptions), 'the parent sees their own device');
select private._p_raises($q$select private.push_subscribe('http://fcm.googleapis.com/x', private._p_key(), private._p_auth(), null, true)$q$,
  '23514', 'only https push addresses');
select private._p_raises($q$select private.push_subscribe('https://fcm.googleapis.com/fcm/send/x', 'not a key', private._p_auth(), null, true)$q$,
  '23514', 'the browser key must look like one');
select private._p_raises($q$select private.push_subscribe('https://fcm.googleapis.com/fcm/send/x', private._p_key(), 'short', null, true)$q$,
  '23514', 'the auth secret must look like one');
select private._p_raises($q$insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('a2900000-0000-4000-8000-000000000002', 'https://evil.example/x', private._p_key(), private._p_auth())$q$,
  '42501', 'no direct inserts (always through push_subscribe, as yourself)');
select private._p_raises($q$update public.push_subscriptions set user_id = 'a2900000-0000-4000-8000-000000000002'$q$, '42501', 'a device can''t be handed to someone else');
select private._p_raises($q$update public.push_subscriptions set endpoint = 'https://evil.example/x'$q$, '42501', 'nor pointed elsewhere');
update public.push_subscriptions set show_preview = false;
select private._p_assert(not (private._p_sub('https://fcm.googleapis.com/fcm/send/parent-phone')).show_preview, 'the lock-screen preview can be turned off');

-- refreshing the same device keeps one row
reset role;
update public.push_subscriptions set failures = 5, last_seen_at = now() - interval '3 days';
select private._p_as('a2900000-0000-4000-8000-000000000001');
select private._p_assert(
  private.push_subscribe('https://fcm.googleapis.com/fcm/send/parent-phone', private._p_key(), private._p_auth(), null, null)
  = (private._p_sub('https://fcm.googleapis.com/fcm/send/parent-phone')).id, 'subscribing again returns the same device');
select private._p_assert((select failures = 0 and not show_preview and device_label = 'Android · Chrome' and last_seen_at > now() - interval '1 minute'
  from private._p_sub('https://fcm.googleapis.com/fcm/send/parent-phone')), 'refreshed: failures reset, choices kept');

-- the teacher's devices
select private._p_as('a2900000-0000-4000-8000-000000000002');
select private.push_subscribe('https://updates.push.services.mozilla.com/wpush/v2/teacher-laptop', private._p_key(), private._p_auth(), 'Windows · Firefox', true);
select private._p_assert((select count(*) from public.push_subscriptions) = 1, 'the teacher sees only their own device');
delete from public.push_subscriptions where endpoint = 'https://fcm.googleapis.com/fcm/send/parent-phone';
select private._p_assert(private._p_subs('a2900000-0000-4000-8000-000000000001') = 1, 'and can''t remove the parent''s');
do $$ declare n int; begin   -- even a blanket delete reaches only their own (then undone)
  begin
    delete from public.push_subscriptions; get diagnostics n = row_count;
    raise exception using errcode = 'ZT999', message = n::text;
  exception when sqlstate 'ZT999' then perform private._p_assert(sqlerrm = '1', 'a blanket delete removes only your own devices');
  end;
end $$;
select set_config('request.jwt.claims', '{"role": "authenticated"}', true);   -- a token with no person in it
select private._p_raises($q$select private.push_subscribe('https://fcm.googleapis.com/fcm/send/z', private._p_key(), private._p_auth(), null, true)$q$,
  '42501', 'not without signing in', 'Not signed in');
reset role;

-- ================= notifications are queued per device =================
select private._p_notify('a2900000-0000-4000-8000-000000000001', 'Fee receipt');
select private._p_assert(private._p_outbox('a2900000-0000-4000-8000-000000000001') = 1, 'a notification for the parent is queued for their phone');
select private._p_assert(private._p_outbox('a2900000-0000-4000-8000-000000000002') = 0, 'and nothing for the teacher');
insert into auth.users (id, email) values ('a2900000-0000-4000-8000-000000000003', 'push-nodevice@example.invalid');
select private._p_notify('a2900000-0000-4000-8000-000000000003', 'Nobody listening');
select private._p_assert((select count(*) from private.push_outbox) = 1, 'someone with no device gets nothing queued');

-- a shared phone: the teacher signs in on the parent's phone and subscribes — it is the teacher's now
select private._p_as('a2900000-0000-4000-8000-000000000002');
select private.push_subscribe('https://fcm.googleapis.com/fcm/send/parent-phone', private._p_key(), private._p_auth(), 'Android · Chrome', true);
select private._p_assert((private._p_sub('https://fcm.googleapis.com/fcm/send/parent-phone')).user_id = 'a2900000-0000-4000-8000-000000000002'
  and (private._p_sub('https://fcm.googleapis.com/fcm/send/parent-phone')).show_preview, 'the device moved to the teacher (with the teacher''s choices)');
select private._p_assert(private._p_outbox('a2900000-0000-4000-8000-000000000001') = 0
  and private._p_outbox('a2900000-0000-4000-8000-000000000002') = 0, 'the parent''s queued notification will never reach the teacher');
reset role;
select private._p_notify('a2900000-0000-4000-8000-000000000001', 'After the move');
select private._p_assert(private._p_outbox('a2900000-0000-4000-8000-000000000001') = 0, 'nor do new ones');
select private._p_notify('a2900000-0000-4000-8000-000000000002', 'Homework due');
select private._p_assert(private._p_outbox('a2900000-0000-4000-8000-000000000002') = 2, 'the teacher''s notification goes to both of their devices');

-- at most 10 devices per person: the least recently used makes room
select private._p_as('a2900000-0000-4000-8000-000000000001');
do $$ begin
  for i in 1..11 loop
    perform private.push_subscribe('https://fcm.googleapis.com/fcm/send/many-' || i, private._p_key(), private._p_auth(), null, true);
    perform pg_sleep(0.002);
  end loop;
end $$;
select private._p_assert(private._p_subs('a2900000-0000-4000-8000-000000000001') = 10
  and (private._p_sub('https://fcm.googleapis.com/fcm/send/many-1')).id is null
  and (private._p_sub('https://fcm.googleapis.com/fcm/send/many-11')).id is not null, 'ten devices kept, the oldest dropped');
reset role;
delete from public.push_subscriptions where user_id = 'a2900000-0000-4000-8000-000000000001';

-- ================= the sender =================
select private._p_as('a2900000-0000-4000-8000-000000000002');
select private._p_raises($q$select * from private.push_claim(10)$q$, '42501', 'people can''t claim pushes');
select private._p_raises($q$select count(*) from private.push_outbox$q$, '42501', 'nor read the queue');
select private._p_worker();
select private._p_raises($q$select count(*) from public.push_subscriptions$q$, '42501', 'the sender reads devices only through push_claim');
create temp table claimed on commit drop as select * from private.push_claim(10);
grant select on claimed to authenticated, erp_notify;
select private._p_assert((select count(*) = 2 and bool_and(title = 'Homework due' and body = 'Body of Homework due' and link = '/notices'
  and school_name = 'Push Test School' and not read and attempts = 1) from claimed), 'claimed: the notification, the device keys and the school');
select private._p_assert((select count(*) from private.push_claim(10)) = 0, 'claimed rows aren''t handed out twice');

do $$ declare a uuid; b uuid; begin
  select id into a from claimed where endpoint like '%parent-phone';
  select id into b from claimed where endpoint like '%teacher-laptop';
  perform private.push_result(a, 'sent', null);
  perform private.push_result(b, 'retry', 'HTTP 503');
end $$;
reset role;
select private._p_assert((select last_success_at is not null and failures = 0 from private._p_sub('https://fcm.googleapis.com/fcm/send/parent-phone'))
  and private._p_outbox('a2900000-0000-4000-8000-000000000002') = 1, 'sent: removed from the queue, the device marked healthy');
select private._p_assert((select status = 'queued' and next_attempt_at > now() and last_error = 'HTTP 503'
  from private.push_outbox), 'a temporary failure is retried later');
select private._p_worker();
select private._p_assert((select count(*) from private.push_claim(10)) = 0, 'not before its time');
reset role;
update private.push_outbox set next_attempt_at = now() - interval '1 second';
select private._p_worker();
do $$ declare r record; begin
  for i in 2..4 loop
    select * into r from private.push_claim(10);
    perform private._p_assert(r.attempts = i, 'attempt ' || i);
    perform private.push_result(r.id, 'retry', 'HTTP 503');
    reset role;
    update private.push_outbox set next_attempt_at = now() - interval '1 second';
    perform private._p_worker();
  end loop;
end $$;
reset role;
select private._p_assert(private._p_outbox('a2900000-0000-4000-8000-000000000002') = 0
  and (private._p_sub('https://updates.push.services.mozilla.com/wpush/v2/teacher-laptop')).failures = 1,
  'after four tries it gives up, and the device''s failure is counted');

-- a device the push service no longer knows is removed
select private._p_notify('a2900000-0000-4000-8000-000000000002', 'Timetable changed');
select private._p_worker();
do $$ declare r record; begin
  for r in select * from private.push_claim(10) loop
    perform private.push_result(r.id, case when r.endpoint like '%teacher-laptop' then 'gone' else 'skipped' end, null);
  end loop;
end $$;
reset role;
select private._p_assert((private._p_sub('https://updates.push.services.mozilla.com/wpush/v2/teacher-laptop')).id is null
  and (private._p_sub('https://fcm.googleapis.com/fcm/send/parent-phone')).id is not null
  and private._p_outbox('a2900000-0000-4000-8000-000000000002') = 0, 'gone: the device is forgotten; skipped: just dequeued');

-- a sender that died mid-way: its rows come back after 10 minutes
select private._p_notify('a2900000-0000-4000-8000-000000000002', 'Results published');
select private._p_worker();
select count(*) from private.push_claim(10);
reset role;
update private.push_outbox set updated_at = now() - interval '11 minutes';
select private._p_worker();
select private._p_assert((select count(*) from private.push_claim(10)) = 1, 'a stuck row is claimed again');
reset role;

-- a device that keeps failing is dropped
update public.push_subscriptions set failures = 19 where endpoint like '%parent-phone';
select private._p_worker();
do $$ declare r record; begin
  reset role;
  update private.push_outbox set status = 'queued', next_attempt_at = now() - interval '1 second', attempts = 3;
  perform private._p_worker();
  select * into r from private.push_claim(10);
  perform private.push_result(r.id, 'failed', 'HTTP 400');
end $$;
reset role;
select private._p_assert((private._p_sub('https://fcm.googleapis.com/fcm/send/parent-phone')).id is null, 'twenty failures in a row: the device is dropped');

-- deleting a notification or a person cleans up
select private._p_as('a2900000-0000-4000-8000-000000000002');
select private.push_subscribe('https://fcm.googleapis.com/fcm/send/teacher-again', private._p_key(), private._p_auth(), null, true);
reset role;
select private._p_notify('a2900000-0000-4000-8000-000000000002', 'To be deleted');
delete from public.notifications where title = 'To be deleted';
select private._p_assert(private._p_outbox('a2900000-0000-4000-8000-000000000002') = 0, 'a deleted notification is no longer pushed');
delete from auth.users where id = 'a2900000-0000-4000-8000-000000000002';
select private._p_assert(private._p_subs('a2900000-0000-4000-8000-000000000002') = 0, 'a deleted account takes its devices with it');

-- the public has no way in
set local role anon;
do $$ begin
  begin perform count(*) from public.push_subscriptions; raise exception 'FAIL: anonymous users read devices';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$ begin raise notice 'ALL PUSH TESTS PASSED'; end $$;
select 'ALL PUSH TESTS PASSED' as result;
rollback;
