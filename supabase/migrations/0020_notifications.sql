-- =====================================================================
-- Phase 22: notifications (in-app, email, SMS, WhatsApp). No voice calls.
--
--   notification_events      one row per thing that happened (a payment, an absence,
--                            a notice...). Written by triggers in the SAME transaction as
--                            the change, so nothing is announced that didn't happen and
--                            nothing that happened is missed ("transactional outbox").
--   notifications            the in-app inbox (per user)
--   notification_deliveries  every email / SMS / WhatsApp message, with its status
--   notification_templates   a school's wording per event and channel (defaults live in
--                            the API; a row here overrides them)
--   notification_settings    per school: email on/off, quiet hours, automatic fee
--                            reminder days, daily SMS / WhatsApp limits
--   notification_preferences per user: email / SMS / WhatsApp on or off
--   private.messaging_accounts  the school's own Twilio (SMS) and WhatsApp Cloud API
--                            accounts; tokens ENCRYPTED by the API
--
-- The API's background sender works as the role erp_notify, which can run only the
-- private.notify_* worker functions below.
-- =====================================================================

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'erp_notify') then
    create role erp_notify nologin noinherit;
  end if;
end $$;
grant erp_notify to current_user;   -- the API connects as this user (see README if yours differs)
grant usage on schema private to erp_notify;

-- ---------- events (the outbox) ----------
create table public.notification_events (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references public.schools (id) on delete cascade,
  event_key     text not null check (event_key in ('fee_reminder', 'payment_received', 'student_absent', 'homework_assigned',
                                                   'exam_scheduled', 'results_published', 'admission_update', 'notice_published', 'test')),
  dedupe_key    text not null,
  entity_id     uuid,
  payload       jsonb not null default '{}',
  status        text not null default 'pending' check (status in ('pending', 'processing', 'done', 'skipped', 'failed')),
  error         text,
  recipients    integer not null default 0,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  processed_at  timestamptz,
  constraint notification_events_once unique (school_id, dedupe_key)
);
create index notification_events_pending_idx on public.notification_events (created_at) where status in ('pending', 'processing');
create index notification_events_school_idx on public.notification_events (school_id, created_at desc);

-- ---------- in-app inbox ----------
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  event_id    uuid references public.notification_events (id) on delete cascade,
  event_key   text not null,
  title       text not null check (char_length(title) between 1 and 200),
  body        text not null check (char_length(body) <= 2000),
  link        text check (link is null or link ~ '^/[A-Za-z0-9/_?=&%.-]*$'),   -- in-app paths only
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint notifications_one_per_event unique (event_id, user_id, link)
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- ---------- outbound messages ----------
create table public.notification_deliveries (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  event_id             uuid not null references public.notification_events (id) on delete cascade,
  user_id              uuid references public.profiles (id) on delete set null,
  student_id           uuid,
  recipient_name       text,
  recipient_kind       text not null check (recipient_kind in ('parent', 'student', 'staff', 'family', 'applicant', 'test')),
  channel              text not null check (channel in ('email', 'sms', 'whatsapp')),
  address              text not null,                 -- email address or phone (E.164)
  subject              text,
  body                 text not null,
  wa_template          text,
  wa_language          text,
  wa_params            jsonb,
  status               text not null default 'queued'
                       check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  provider             text,
  provider_message_id  text,
  error                text,
  attempts             smallint not null default 0,
  next_attempt_at      timestamptz not null default now(),
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint notification_deliveries_once unique (event_id, channel, address)
);
create index notification_deliveries_due_idx on public.notification_deliveries (next_attempt_at) where status = 'queued';
create index notification_deliveries_event_idx on public.notification_deliveries (event_id);
create index notification_deliveries_provider_idx on public.notification_deliveries (provider, provider_message_id);
create index notification_deliveries_school_day_idx on public.notification_deliveries (school_id, channel, sent_at);
create trigger notification_deliveries_updated_at before update on public.notification_deliveries for each row execute function private.set_updated_at();

-- ---------- wording ----------
create table public.notification_templates (
  school_id    uuid not null references public.schools (id) on delete cascade,
  event_key    text not null,
  channel      text not null check (channel in ('in_app', 'email', 'sms', 'whatsapp')),
  is_enabled   boolean not null,
  subject      text check (subject is null or char_length(subject) <= 200),
  body         text check (body is null or char_length(body) <= 2000),
  wa_template  text check (wa_template is null or wa_template ~ '^[a-z0-9_]+$' and length(wa_template) <= 512),   -- name approved by Meta
  wa_language  text check (wa_language is null or wa_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  wa_params    jsonb check (wa_params is null or jsonb_typeof(wa_params) = 'array'),
  updated_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (school_id, event_key, channel)
);

create table public.notification_settings (
  school_id             uuid primary key references public.schools (id) on delete cascade,
  email_enabled         boolean not null default true,
  reply_to              text check (reply_to is null or reply_to ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  quiet_start           smallint not null default 21 check (quiet_start between 0 and 23),   -- no SMS/WhatsApp from 9 pm...
  quiet_end             smallint not null default 8 check (quiet_end between 0 and 23),      -- ...until 8 am (India time)
  fee_reminder_days     smallint[] not null default '{}' check (fee_reminder_days <@ array[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28]::smallint[]),
  sms_daily_limit       integer not null default 500 check (sms_daily_limit between 0 and 100000),
  whatsapp_daily_limit  integer not null default 500 check (whatsapp_daily_limit between 0 and 100000),
  updated_by            uuid references auth.users (id) on delete set null,
  updated_at            timestamptz not null default now()
);

create table public.notification_preferences (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  channel     text not null check (channel in ('email', 'sms', 'whatsapp')),
  enabled     boolean not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, channel)
);

create table private.messaging_accounts (
  school_id           uuid not null references public.schools (id) on delete cascade,
  channel             text not null check (channel in ('sms', 'whatsapp')),
  provider            text not null check ((channel = 'sms' and provider = 'twilio') or (channel = 'whatsapp' and provider = 'meta')),
  config              jsonb not null default '{}',     -- non-secret: account SID and sender / phone number id
  secret_enc          text not null,                   -- auth token / access token, encrypted by the API
  webhook_secret_enc  text,                            -- WhatsApp app secret (webhook signatures), encrypted
  verify_token       text not null default encode(extensions.gen_random_bytes(18), 'hex'),  -- WhatsApp webhook set-up check
  is_enabled          boolean not null default false,
  updated_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now(),
  primary key (school_id, channel)
);
revoke all on private.messaging_accounts from public, anon, authenticated;

-- India time: "today", quiet hours and reminder days are the school's local time
create or replace function private.ist_today() returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

-- =====================================================================
-- Recording events (called by triggers and by staff actions)
-- =====================================================================
create or replace function private.notify_enqueue(
  p_school uuid, p_event text, p_dedupe text, p_entity uuid, p_payload jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notification_events (school_id, event_key, dedupe_key, entity_id, payload, created_by)
  values (p_school, p_event, p_dedupe, p_entity, coalesce(p_payload, '{}'), (select auth.uid()))
  on conflict (school_id, dedupe_key) do nothing;
  return found;
end $$;

create or replace function private.notify_on_payment() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.notify_enqueue(new.school_id, 'payment_received', 'payment:' || new.id, new.id, jsonb_build_object('payment_id', new.id));
  return null;
end $$;
create trigger fee_payments_notify after insert on public.fee_payments for each row execute function private.notify_on_payment();

-- absent today (or yesterday, if marked late); corrections of older days stay quiet
create or replace function private.notify_on_absence() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'absent' and (tg_op = 'INSERT' or old.status is distinct from 'absent')
     and new.attendance_date >= private.ist_today() - 1 then
    perform private.notify_enqueue(new.school_id, 'student_absent', 'absent:' || new.student_id || ':' || new.attendance_date, new.student_id,
      jsonb_build_object('student_id', new.student_id, 'date', new.attendance_date, 'section_id', new.section_id));
  end if;
  return null;
end $$;
create trigger attendance_records_notify after insert or update of status on public.attendance_records
  for each row execute function private.notify_on_absence();

create or replace function private.notify_on_homework() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.notify_enqueue(new.school_id, 'homework_assigned', 'homework:' || new.id, new.id, jsonb_build_object('homework_id', new.id));
  return null;
end $$;
create trigger homework_notify after insert on public.homework for each row execute function private.notify_on_homework();

create or replace function private.notify_on_exam() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'scheduled' and old.status = 'draft' then
    perform private.notify_enqueue(new.school_id, 'exam_scheduled', 'exam:' || new.id || ':scheduled', new.id, jsonb_build_object('exam_id', new.id));
  elsif new.status = 'published' and old.status is distinct from 'published' then
    -- at most once a day, even if results are unpublished and published again
    perform private.notify_enqueue(new.school_id, 'results_published', 'exam:' || new.id || ':results:' || private.ist_today(), new.id,
      jsonb_build_object('exam_id', new.id));
  end if;
  return null;
end $$;
create trigger exams_notify after update of status on public.exams for each row execute function private.notify_on_exam();

create or replace function private.notify_on_admission_event() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.notify_enqueue(new.school_id, 'admission_update', 'admission_event:' || new.id, new.application_id,
    jsonb_build_object('application_id', new.application_id, 'status', new.to_status));
  return null;
end $$;
create trigger admission_events_notify after insert on public.admission_events for each row execute function private.notify_on_admission_event();

-- Notices can be scheduled, so the sender asks for due ones regularly (and on publish).
create or replace function private.notify_due_notices() returns integer language plpgsql security definer set search_path = '' as $$
declare n integer := 0; r record;
begin
  for r in select id, school_id from public.notices
           where publish_at <= now() and publish_at > now() - interval '2 days' and (expires_at is null or expires_at > now())
  loop
    if private.notify_enqueue(r.school_id, 'notice_published', 'notice:' || r.id, r.id, jsonb_build_object('notice_id', r.id)) then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
create or replace function private.notify_on_notice() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.publish_at <= now() and (new.expires_at is null or new.expires_at > now()) then
    perform private.notify_enqueue(new.school_id, 'notice_published', 'notice:' || new.id, new.id, jsonb_build_object('notice_id', new.id));
  end if;
  return null;
end $$;
create trigger notices_notify after insert or update of publish_at on public.notices for each row execute function private.notify_on_notice();

-- Fee reminders: students of the current session with an overdue balance. At most one a day each.
create or replace function private.notify_enqueue_fee_reminders(p_school uuid, p_class uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer := 0; r record; v_ids uuid[];
begin
  -- dues are kept up to date lazily (when fees are looked at); bring them up to date first
  select coalesce(array_agg(e.id), '{}') into v_ids
  from public.student_enrollments e
  join public.academic_sessions a on a.id = e.academic_session_id and a.is_current and a.archived_at is null
  where e.school_id = p_school and (p_class is null or e.class_id = p_class);
  perform private.sync_student_dues(v_ids);
  for r in
    select e.student_id, t.overdue
    from public.student_enrollments e
    join public.academic_sessions a on a.id = e.academic_session_id and a.is_current and a.archived_at is null
    join public.students s on s.id = e.student_id and s.status = 'active'
    cross join lateral private.enrollment_fee_totals(array[e.id]) t
    where e.school_id = p_school and (p_class is null or e.class_id = p_class) and t.overdue > 0
  loop
    if private.notify_enqueue(p_school, 'fee_reminder', 'fee_reminder:' || r.student_id || ':' || private.ist_today(), r.student_id,
         jsonb_build_object('student_id', r.student_id)) then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Staff: "send fee reminders now"
create or replace function private.send_fee_reminders(p_school uuid, p_class uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin', 'accountant']::public.app_role[])) then
    raise exception 'Only admins and accountants can send fee reminders.' using errcode = 'insufficient_privilege';
  end if;
  return private.notify_enqueue_fee_reminders(p_school, p_class);
end $$;

-- The sender: automatic reminders on the school's chosen days of the month.
create or replace function private.notify_auto_fee_reminders() returns integer language plpgsql security definer set search_path = '' as $$
declare n integer := 0; r record;
begin
  for r in select school_id from public.notification_settings
           where extract(day from private.ist_today())::smallint = any (fee_reminder_days)
             and extract(hour from now() at time zone 'Asia/Kolkata') >= 9
  loop
    n := n + private.notify_enqueue_fee_reminders(r.school_id, null);
  end loop;
  return n;
end $$;

-- =====================================================================
-- Who receives an event, and what they need to know. Run by the sender.
-- Parents are the student's linked guardian accounts. When none of them has a
-- mobile number, SMS / WhatsApp go to the family mobile on the student record.
-- =====================================================================
create or replace function private.notify_family(p_student uuid, p_with_student boolean)
returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
declare s record; v_phone_found boolean := false; g record;
begin
  select st.id, st.full_name, st.mobile, st.account_id, st.school_id, coalesce(nullif(st.father_name, ''), st.mother_name) as family_name
    into s from public.students st where st.id = p_student and st.status = 'active';
  if not found then return; end if;
  for g in
    select p.id, p.full_name, p.email, p.phone from public.student_guardians sg
    join public.profiles p on p.id = sg.user_id
    join public.school_memberships m on m.user_id = p.id and m.school_id = s.school_id and m.role = 'parent' and m.status = 'active'
    where sg.student_id = p_student
  loop
    v_phone_found := v_phone_found or g.phone is not null;
    return next jsonb_build_object('kind', 'parent', 'user_id', g.id, 'name', g.full_name, 'email', g.email, 'phone', g.phone,
                                   'student_id', s.id, 'student_name', s.full_name);
  end loop;
  if not v_phone_found then
    return next jsonb_build_object('kind', 'family', 'user_id', null, 'name', s.family_name, 'email', null, 'phone', s.mobile,
                                   'student_id', s.id, 'student_name', s.full_name);
  end if;
  if p_with_student and s.account_id is not null then
    for g in
      select p.id, p.full_name, p.email from public.profiles p
      join public.school_memberships m on m.user_id = p.id and m.school_id = s.school_id and m.role = 'student' and m.status = 'active'
      where p.id = s.account_id
    loop
      return next jsonb_build_object('kind', 'student', 'user_id', g.id, 'name', g.full_name, 'email', g.email, 'phone', null,
                                     'student_id', s.id, 'student_name', s.full_name);
    end loop;
  end if;
end $$;

create or replace function private.notify_event_context(p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.notification_events; sch record; v_vars jsonb := '{}'; v_rec jsonb := '[]'; x record; v_skip text;
begin
  select * into e from public.notification_events where id = p_event;
  select s.name, s.code, s.phone, s.email into sch from public.schools s where s.id = e.school_id;

  if e.event_key = 'payment_received' then
    select p.amount, p.receipt_number, p.payment_mode::text as mode, p.payment_date, p.balance_after, p.student_id, p.cancelled_at,
           c.name || ' – ' || sec.name as class_section
      into x from public.fee_payments p join public.student_enrollments en on en.id = p.enrollment_id
      join public.classes c on c.id = en.class_id join public.sections sec on sec.id = en.section_id
      where p.id = (e.payload->>'payment_id')::uuid;
    if x.cancelled_at is not null then v_skip := 'The receipt was cancelled.'; end if;
    v_vars := jsonb_build_object('amount', x.amount, 'receipt_number', x.receipt_number, 'payment_mode', x.mode,
      'payment_date', x.payment_date, 'balance', x.balance_after, 'class_section', x.class_section, 'student_id', x.student_id);
    select coalesce(jsonb_agg(f), '[]') into v_rec from private.notify_family(x.student_id, false) f;

  elsif e.event_key = 'student_absent' then
    select c.name || ' – ' || sec.name as class_section, ar.status::text as status, ar.remarks into x
      from public.attendance_records ar join public.classes c on c.id = ar.class_id join public.sections sec on sec.id = ar.section_id
      where ar.student_id = (e.payload->>'student_id')::uuid and ar.attendance_date = (e.payload->>'date')::date;
    if x.status is distinct from 'absent' then v_skip := 'The student is no longer marked absent.'; end if;
    v_vars := jsonb_build_object('date', e.payload->>'date', 'class_section', x.class_section);
    select coalesce(jsonb_agg(f), '[]') into v_rec from private.notify_family((e.payload->>'student_id')::uuid, false) f;

  elsif e.event_key = 'homework_assigned' then
    select h.title, h.kind::text as kind, h.due_at, h.section_id, sub.name as subject, c.name || ' – ' || sec.name as class_section into x
      from public.homework h join public.classes c on c.id = h.class_id join public.sections sec on sec.id = h.section_id
      left join public.subjects sub on sub.id = h.subject_id
      where h.id = (e.payload->>'homework_id')::uuid;
    if x.title is null then v_skip := 'The homework was deleted.'; end if;
    v_vars := jsonb_build_object('title', x.title, 'kind', initcap(x.kind), 'subject', coalesce(x.subject, 'General'),
      'due_date', (x.due_at at time zone 'Asia/Kolkata')::date, 'class_section', x.class_section, 'homework_id', e.payload->>'homework_id');
    select coalesce(jsonb_agg(f), '[]') into v_rec
      from public.student_enrollments en cross join lateral private.notify_family(en.student_id, true) f
      where en.section_id = x.section_id;

  elsif e.event_key in ('exam_scheduled', 'results_published') then
    select ex.name, ex.academic_session_id, (select min(pp.exam_date) from public.exam_papers pp where pp.exam_id = ex.id) as first_date,
           (select max(pp.exam_date) from public.exam_papers pp where pp.exam_id = ex.id) as last_date into x
      from public.exams ex where ex.id = (e.payload->>'exam_id')::uuid;
    v_vars := jsonb_build_object('exam_name', x.name, 'first_date', x.first_date, 'last_date', x.last_date);
    select coalesce(jsonb_agg(f), '[]') into v_rec
      from public.student_enrollments en cross join lateral private.notify_family(en.student_id, true) f
      where en.academic_session_id = x.academic_session_id
        and en.class_id in (select pp.class_id from public.exam_papers pp where pp.exam_id = (e.payload->>'exam_id')::uuid);

  elsif e.event_key = 'admission_update' then
    select ap.student_name, ap.application_number, ap.status::text as status, ap.rejection_reason, ap.fee_amount, ap.contact_email,
           ap.contact_phone, coalesce(nullif(ap.father_name, ''), ap.mother_name) as parent_name, c.name as class_name into x
      from public.admission_applications ap join public.classes c on c.id = ap.class_id
      where ap.id = (e.payload->>'application_id')::uuid;
    if x.status is distinct from e.payload->>'status' then v_skip := 'The application has moved on since.'; end if;
    v_vars := jsonb_build_object('student_name', x.student_name, 'application_number', x.application_number, 'status', x.status,
      'reason', x.rejection_reason, 'admission_fee', x.fee_amount, 'class_name', x.class_name);
    v_rec := jsonb_build_array(jsonb_build_object('kind', 'applicant', 'user_id', null, 'name', x.parent_name, 'email', x.contact_email,
                                                  'phone', x.contact_phone, 'student_id', null, 'student_name', x.student_name));

  elsif e.event_key = 'notice_published' then
    select n.title, n.body, n.audience::text as audience, n.class_ids, n.publish_at, n.expires_at into x
      from public.notices n where n.id = (e.payload->>'notice_id')::uuid;
    if x.title is null then v_skip := 'The notice was deleted.';
    elsif x.publish_at > now() then v_skip := 'The notice is scheduled for later.';
    end if;
    v_vars := jsonb_build_object('title', x.title, 'excerpt', left(regexp_replace(x.body, '\s+', ' ', 'g'), 300));
    with fam as (
      select f from public.student_enrollments en
      join public.academic_sessions a on a.id = en.academic_session_id and a.is_current
      cross join lateral private.notify_family(en.student_id, x.audience in ('everyone', 'students')) f
      where en.school_id = e.school_id and x.audience in ('everyone', 'parents', 'students')
        and (x.class_ids is null or en.class_id = any (x.class_ids))
    ), staff as (
      select distinct on (p.id) jsonb_build_object('kind', 'staff', 'user_id', p.id, 'name', p.full_name, 'email', p.email, 'phone', p.phone,
                                                   'student_id', null, 'student_name', null) as f
      from public.school_memberships m join public.profiles p on p.id = m.user_id
      where m.school_id = e.school_id and m.status = 'active' and m.role in ('school_admin', 'accountant', 'teacher')
        and x.audience in ('everyone', 'staff')
    )
    select coalesce(jsonb_agg(f), '[]') into v_rec from (
      select f from fam where x.audience <> 'students' or f->>'kind' = 'student'
      union all select f from staff) u;

  elsif e.event_key = 'fee_reminder' then
    select t.overdue, t.outstanding, c.name || ' – ' || sec.name as class_section into x
      from public.student_enrollments en
      join public.academic_sessions a on a.id = en.academic_session_id and a.is_current
      join public.classes c on c.id = en.class_id join public.sections sec on sec.id = en.section_id
      cross join lateral private.enrollment_fee_totals(array[en.id]) t
      where en.student_id = (e.payload->>'student_id')::uuid;
    if coalesce(x.overdue, 0) <= 0 then v_skip := 'Nothing is overdue any more.'; end if;
    v_vars := jsonb_build_object('amount_due', x.overdue, 'total_outstanding', x.outstanding, 'class_section', x.class_section);
    select coalesce(jsonb_agg(f), '[]') into v_rec from private.notify_family((e.payload->>'student_id')::uuid, false) f;

  elsif e.event_key = 'test' then
    v_vars := '{}';
    v_rec := jsonb_build_array(e.payload->'recipient');
  end if;

  return jsonb_build_object('event_key', e.event_key, 'skip', v_skip,
    'school', jsonb_build_object('name', sch.name, 'code', sch.code, 'phone', sch.phone, 'email', sch.email),
    'vars', v_vars, 'recipients', v_rec);
end $$;

-- =====================================================================
-- Worker functions (only erp_notify)
-- =====================================================================
create or replace function private.notify_claim_events(p_limit integer)
returns setof public.notification_events language sql security definer set search_path = '' as $$
  update public.notification_events e set status = 'processing', claimed_at = now()
  where e.id in (select id from public.notification_events
                 where status = 'pending' or (status = 'processing' and claimed_at < now() - interval '10 minutes')
                 order by created_at limit p_limit for update skip locked)
  returning e.*;
$$;

-- What the sender needs to render: templates, settings, accounts in use, and who opted out.
create or replace function private.notify_school_setup(p_school uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'school', (select jsonb_build_object('name', s.name, 'email', s.email, 'code', s.code) from public.schools s where s.id = p_school),
    'templates', coalesce((select jsonb_agg(to_jsonb(t) - 'school_id' - 'updated_by') from public.notification_templates t where t.school_id = p_school), '[]'),
    'settings', coalesce((select to_jsonb(s) - 'school_id' - 'updated_by' from public.notification_settings s where s.school_id = p_school), '{}'),
    'channels', coalesce((select jsonb_object_agg(a.channel, a.is_enabled) from private.messaging_accounts a where a.school_id = p_school), '{}'));
$$;

create or replace function private.notify_opt_outs(p_users uuid[])
returns table (user_id uuid, channel text) language sql stable security definer set search_path = '' as $$
  select user_id, channel from public.notification_preferences where user_id = any (p_users) and not enabled;
$$;

-- Store what the sender rendered, and close the event.
create or replace function private.notify_store(p_event uuid, p_in_app jsonb, p_deliveries jsonb, p_status text, p_error text, p_recipients integer)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.notification_events;
begin
  select * into e from public.notification_events where id = p_event for update;
  insert into public.notifications (school_id, user_id, event_id, event_key, title, body, link)
  select e.school_id, (x->>'user_id')::uuid, e.id, e.event_key, left(x->>'title', 200), left(x->>'body', 2000), x->>'link'
  from jsonb_array_elements(coalesce(p_in_app, '[]')) x
  on conflict (event_id, user_id, link) do nothing;
  insert into public.notification_deliveries (school_id, event_id, user_id, student_id, recipient_name, recipient_kind, channel, address,
                                              subject, body, wa_template, wa_language, wa_params, status, error, next_attempt_at)
  select e.school_id, e.id, (x->>'user_id')::uuid, (x->>'student_id')::uuid, x->>'name', x->>'kind', x->>'channel', x->>'address',
         x->>'subject', x->>'body', x->>'wa_template', x->>'wa_language', x->'wa_params', coalesce(x->>'status', 'queued'), x->>'error',
         coalesce((x->>'not_before')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_deliveries, '[]')) x
  on conflict (event_id, channel, address) do nothing;
  update public.notification_events set status = p_status, error = left(p_error, 500), recipients = p_recipients, processed_at = now()
  where id = p_event;
end $$;

create or replace function private.notify_claim_deliveries(p_limit integer)
returns setof public.notification_deliveries language sql security definer set search_path = '' as $$
  update public.notification_deliveries d set status = 'sending', attempts = d.attempts + 1
  where d.id in (select id from public.notification_deliveries
                 where (status = 'queued' and next_attempt_at <= now())
                    or (status = 'sending' and updated_at < now() - interval '10 minutes')   -- a sender that died
                 order by next_attempt_at limit p_limit for update skip locked)
  returning d.*;
$$;

create or replace function private.notify_channel_secrets(p_school uuid, p_channel text)
returns table (provider text, config jsonb, secret_enc text, webhook_secret_enc text, verify_token text, is_enabled boolean)
language sql stable security definer set search_path = '' as $$
  select provider, config, secret_enc, webhook_secret_enc, verify_token, is_enabled
  from private.messaging_accounts where school_id = p_school and channel = p_channel;
$$;

create or replace function private.notify_sent_today(p_school uuid, p_channel text)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.notification_deliveries
  where school_id = p_school and channel = p_channel and status in ('sent', 'delivered', 'read')
    and sent_at >= (private.ist_today()::timestamp at time zone 'Asia/Kolkata');
$$;

create or replace function private.notify_delivery_result(
  p_id uuid, p_status text, p_provider text, p_provider_id text, p_error text, p_retry_at timestamptz
) returns void language sql security definer set search_path = '' as $$
  update public.notification_deliveries set
    status = case when p_retry_at is not null then 'queued' else p_status end,
    provider = coalesce(p_provider, provider), provider_message_id = coalesce(p_provider_id, provider_message_id),
    error = left(p_error, 500), next_attempt_at = coalesce(p_retry_at, next_attempt_at),
    sent_at = case when p_status = 'sent' and p_retry_at is null then now() else sent_at end
  where id = p_id;
$$;

-- Delivery reports from the provider: only move forward (sent -> delivered -> read), or to failed.
create or replace function private.notify_delivery_status(p_school uuid, p_provider text, p_provider_id text, p_status text, p_error text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_rank jsonb := '{"sending":0,"sent":1,"delivered":2,"read":3}';
begin
  update public.notification_deliveries d set status = p_status, error = coalesce(left(p_error, 500), d.error)
  where d.school_id = p_school and d.provider = p_provider and d.provider_message_id = p_provider_id
    and d.status <> p_status
    and (p_status = 'failed' and d.status in ('sending', 'sent')
         or (v_rank ? p_status and v_rank ? d.status and (v_rank->>p_status)::int > (v_rank->>d.status)::int));
  return found;
end $$;

-- =====================================================================
-- Staff and users
-- =====================================================================
create or replace function private.save_messaging_account(
  p_school uuid, p_channel text, p_config jsonb, p_secret_enc text, p_webhook_secret_enc text, p_enabled boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[])) then
    raise exception 'Only school admins can change messaging accounts.' using errcode = 'insufficient_privilege';
  end if;
  update private.messaging_accounts a set config = p_config, secret_enc = coalesce(p_secret_enc, a.secret_enc),
         webhook_secret_enc = coalesce(p_webhook_secret_enc, a.webhook_secret_enc), is_enabled = p_enabled,
         updated_by = (select auth.uid()), updated_at = now()
  where a.school_id = p_school and a.channel = p_channel;
  if not found then
    if p_secret_enc is null then
      raise exception 'Enter the token.' using errcode = 'check_violation';
    end if;
    insert into private.messaging_accounts (school_id, channel, provider, config, secret_enc, webhook_secret_enc, is_enabled, updated_by)
    values (p_school, p_channel, case p_channel when 'sms' then 'twilio' else 'meta' end, p_config, p_secret_enc, p_webhook_secret_enc,
            p_enabled, (select auth.uid()));
  end if;
end $$;

create or replace function private.messaging_account_info(p_school uuid)
returns table (channel text, provider text, config jsonb, has_webhook_secret boolean, verify_token text, is_enabled boolean, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.channel, a.provider, a.config, a.webhook_secret_enc is not null, a.verify_token, a.is_enabled, a.updated_at
  from private.messaging_accounts a
  where a.school_id = p_school and (private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[]));
$$;

-- In-app items sent / read per event, for the history. Admins can't read other people's
-- notifications themselves, only these counts.
create or replace function private.notify_in_app_stats(p_school uuid, p_events uuid[])
returns table (event_id uuid, sent integer, read integer)
language sql stable security definer set search_path = '' as $$
  select n.event_id, count(*)::integer, count(n.read_at)::integer
  from public.notifications n
  where n.school_id = p_school and n.event_id = any (p_events)
    and (private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[]))
  group by n.event_id;
$$;

-- An admin sends one failed or skipped message again.
create or replace function private.notify_retry(p_delivery uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.notification_deliveries;
begin
  select * into d from public.notification_deliveries where id = p_delivery for update;
  if not found or not (private.is_super_admin() or private.has_school_role(d.school_id, array['school_admin']::public.app_role[])) then
    raise exception 'Message not found.' using errcode = 'no_data_found';
  end if;
  if d.status not in ('failed', 'skipped') then
    raise exception 'Only failed or skipped messages can be sent again.' using errcode = 'check_violation';
  end if;
  update public.notification_deliveries set status = 'queued', error = null, attempts = 0, next_attempt_at = now() where id = p_delivery;
end $$;

-- An admin checks a channel by sending one message to themselves.
create or replace function private.notify_test(p_school uuid, p_channel text, p_address text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid();
begin
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[])) then
    raise exception 'Only school admins can send test messages.' using errcode = 'insufficient_privilege';
  end if;
  insert into public.notification_events (id, school_id, event_key, dedupe_key, payload, created_by)
  values (v_id, p_school, 'test', 'test:' || v_id, jsonb_build_object('channel', p_channel,
          'recipient', jsonb_build_object('kind', 'test', 'user_id', null, 'name', 'Test', 'email', case when p_channel = 'email' then p_address end,
                                          'phone', case when p_channel <> 'email' then p_address end, 'student_id', null, 'student_name', null)),
          (select auth.uid()));
  return v_id;
end $$;

revoke all on function private.notify_enqueue(uuid, text, text, uuid, jsonb), private.notify_due_notices(),
  private.notify_enqueue_fee_reminders(uuid, uuid), private.send_fee_reminders(uuid, uuid), private.notify_auto_fee_reminders(),
  private.notify_family(uuid, boolean), private.notify_event_context(uuid), private.notify_claim_events(integer),
  private.notify_school_setup(uuid), private.notify_opt_outs(uuid[]), private.notify_store(uuid, jsonb, jsonb, text, text, integer),
  private.notify_claim_deliveries(integer), private.notify_channel_secrets(uuid, text), private.notify_sent_today(uuid, text),
  private.notify_delivery_result(uuid, text, text, text, text, timestamptz), private.notify_delivery_status(uuid, text, text, text, text),
  private.save_messaging_account(uuid, text, jsonb, text, text, boolean), private.messaging_account_info(uuid),
  private.notify_retry(uuid), private.notify_test(uuid, text, text), private.ist_today(), private.notify_in_app_stats(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function private.send_fee_reminders(uuid, uuid), private.save_messaging_account(uuid, text, jsonb, text, text, boolean),
  private.messaging_account_info(uuid), private.notify_retry(uuid), private.notify_test(uuid, text, text), private.ist_today(),
  private.notify_in_app_stats(uuid, uuid[])
  to authenticated;
grant execute on function private.notify_due_notices(), private.notify_auto_fee_reminders(), private.notify_event_context(uuid),
  private.notify_claim_events(integer), private.notify_school_setup(uuid), private.notify_opt_outs(uuid[]),
  private.notify_store(uuid, jsonb, jsonb, text, text, integer), private.notify_claim_deliveries(integer),
  private.notify_channel_secrets(uuid, text), private.notify_sent_today(uuid, text),
  private.notify_delivery_result(uuid, text, text, text, text, timestamptz), private.notify_delivery_status(uuid, text, text, text, text),
  private.ist_today()
  to erp_notify;

-- =====================================================================
-- RLS
-- =====================================================================
revoke all on public.notification_events, public.notifications, public.notification_deliveries, public.notification_templates,
  public.notification_settings, public.notification_preferences from anon, authenticated;
grant select on public.notification_events, public.notification_deliveries to authenticated;
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;                   -- users only mark as read
grant select, insert, update, delete on public.notification_templates, public.notification_settings to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
alter table public.notification_events enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_templates enable row level security;
alter table public.notification_settings enable row level security;
alter table public.notification_preferences enable row level security;

create policy notification_events_admin on public.notification_events for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy notification_deliveries_admin on public.notification_deliveries for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy notifications_own_select on public.notifications for select to authenticated using (user_id = (select auth.uid()));
create policy notifications_own_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy notifications_own_delete on public.notifications for delete to authenticated using (user_id = (select auth.uid()));
create policy notification_templates_admin on public.notification_templates for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy notification_settings_admin on public.notification_settings for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy notification_preferences_own on public.notification_preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
