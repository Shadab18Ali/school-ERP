-- =====================================================================
-- Phase 20: admission CRM (enquiries)
--   admission_enquiries            one row per enquiry: parent, student, phone,
--                                  class of interest, source, follow-up date,
--                                  status, notes
--   admission_enquiry_activities   the enquiry's history (written by trigger only)
--
-- Statuses: new, contacted, follow_up, interested, application, approved,
-- rejected, admitted. Staff move an enquiry freely between them, except:
--   * "follow_up" needs a follow-up date;
--   * a new follow-up date can't be in the past;
--   * rejected / admitted close the enquiry: the follow-up date is cleared;
--   * an enquiry linked to an online application (Phase 19) follows that
--     application: application -> application/approved/rejected/admitted.
-- An online application is linked automatically when exactly one open
-- enquiry of the same session has the same mobile number.
--
-- Access: school admins and accountants (the school office) see and manage
-- enquiries; only admins delete them. Teachers, parents, students: nothing.
-- =====================================================================

create type public.enquiry_status as enum
  ('new', 'contacted', 'follow_up', 'interested', 'application', 'approved', 'rejected', 'admitted');
create type public.enquiry_source as enum
  ('walk_in', 'phone_call', 'website', 'social_media', 'newspaper', 'hoarding', 'referral', 'school_event', 'other');
create type public.enquiry_activity_kind as enum
  ('created', 'status', 'follow_up', 'note', 'linked', 'unlinked');

create table public.admission_enquiries (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  academic_session_id  uuid not null,
  enquiry_number       text not null,
  enquiry_date         date not null default current_date check (enquiry_date <= current_date + 1),
  parent_name          text not null check (char_length(btrim(parent_name)) between 2 and 150),
  student_name         text not null check (char_length(btrim(student_name)) between 2 and 150),
  phone                text not null check (phone ~ '^\+?[0-9]{10,15}$'),
  email                text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  class_id             uuid,                                  -- interested class (may be unknown at first)
  source               public.enquiry_source not null default 'walk_in',
  source_detail        text check (source_detail is null or char_length(source_detail) <= 100),  -- e.g. who referred
  status               public.enquiry_status not null default 'new',
  follow_up_date       date,
  notes                text check (notes is null or char_length(notes) <= 2000),
  application_id       uuid,                                  -- the online application, once there is one
  activity_note        text check (activity_note is null or char_length(activity_note) <= 1000),  -- transient: logged, then cleared
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint admission_enquiries_number_key unique (school_id, enquiry_number),
  constraint admission_enquiries_id_school_key unique (id, school_id),
  constraint admission_enquiries_one_per_application unique (application_id),
  constraint admission_enquiries_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id),
  constraint admission_enquiries_class_fkey foreign key (class_id, school_id) references public.classes (id, school_id),
  constraint admission_enquiries_application_fkey foreign key (application_id, school_id)
    references public.admission_applications (id, school_id) on delete set null (application_id)
);
create index admission_enquiries_school_status_idx on public.admission_enquiries (school_id, academic_session_id, status);
create index admission_enquiries_follow_up_idx on public.admission_enquiries (school_id, follow_up_date)
  where follow_up_date is not null and status not in ('rejected', 'admitted');
create index admission_enquiries_phone_idx on public.admission_enquiries (school_id, right(phone, 10));
create trigger admission_enquiries_updated_at before update on public.admission_enquiries for each row execute function private.set_updated_at();
create trigger admission_enquiries_lock_school before update on public.admission_enquiries for each row execute function private.prevent_school_change();

create table public.admission_enquiry_activities (
  id              bigint generated always as identity primary key,
  school_id       uuid not null references public.schools (id) on delete cascade,
  enquiry_id      uuid not null,
  kind            public.enquiry_activity_kind not null,
  from_status     public.enquiry_status,
  to_status       public.enquiry_status,
  follow_up_date  date,
  note            text,
  actor           uuid references auth.users (id) on delete set null,   -- null = the parent (online application)
  created_at      timestamptz not null default now(),
  constraint admission_enquiry_activities_enquiry_fkey foreign key (enquiry_id, school_id)
    references public.admission_enquiries (id, school_id) on delete cascade
);
create index admission_enquiry_activities_enquiry_idx on public.admission_enquiry_activities (enquiry_id, id);

-- the enquiry status an online application stands for
create or replace function private.enquiry_status_for(p public.admission_status)
returns public.enquiry_status language sql immutable set search_path = '' as $$
  select case p
    when 'approved' then 'approved' when 'fee_paid' then 'approved'
    when 'rejected' then 'rejected' when 'enrolled' then 'admitted'
    else 'application' end::public.enquiry_status;
$$;

-- =====================================================================
-- Rules
-- =====================================================================
create or replace function private.guard_enquiry()
returns trigger language plpgsql security definer set search_path = '' as $$
declare n bigint; v_app record; v_note text;
begin
  new.parent_name := btrim(new.parent_name);
  new.student_name := btrim(new.student_name);
  new.notes := nullif(btrim(new.notes), '');
  new.source_detail := nullif(btrim(new.source_detail), '');
  v_note := nullif(btrim(new.activity_note), '');
  new.activity_note := null;

  if tg_op = 'INSERT' or new.academic_session_id is distinct from old.academic_session_id then
    if exists (select 1 from public.academic_sessions a where a.id = new.academic_session_id and a.archived_at is not null) then
      raise exception 'This academic session is archived; its enquiries can''t be added or changed.' using errcode = 'check_violation';
    end if;
  elsif exists (select 1 from public.academic_sessions a where a.id = old.academic_session_id and a.archived_at is not null) then
    raise exception 'This academic session is archived; its enquiries can''t be added or changed.' using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' then
    insert into private.school_counters as c (school_id, kind, last_value) values (new.school_id, 'enquiry', 1)
    on conflict (school_id, kind) do update set last_value = c.last_value + 1 returning last_value into n;
    new.enquiry_number := 'ENQ-' || lpad(n::text, 5, '0');
    new.created_by := (select auth.uid());
    new.created_at := now();
    if new.application_id is not null then
      raise exception 'Create the enquiry first, then link the application.' using errcode = 'check_violation';
    end if;
  else
    if new.enquiry_number is distinct from old.enquiry_number or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by then
      raise exception 'The enquiry number and creation details can''t be changed.' using errcode = 'check_violation';
    end if;
  end if;

  -- linked to an online application: the status follows the application
  if new.application_id is not null then
    select x.status, x.academic_session_id, x.application_number into v_app
    from public.admission_applications x where x.id = new.application_id and x.school_id = new.school_id;
    if not found then
      raise exception 'Application not found in this school.' using errcode = 'check_violation';
    end if;
    if tg_op = 'UPDATE' and old.application_id is not distinct from new.application_id
       and new.status is distinct from old.status and new.status is distinct from private.enquiry_status_for(v_app.status) then
      raise exception 'This enquiry follows application %; its status changes with the application.', v_app.application_number
        using errcode = 'check_violation';
    end if;
    new.status := private.enquiry_status_for(v_app.status);
  end if;

  if new.status in ('rejected', 'admitted') then
    new.follow_up_date := null;            -- closed: nothing to follow up
  elsif new.status = 'follow_up' and new.follow_up_date is null then
    raise exception 'Choose the follow-up date.' using errcode = 'check_violation';
  end if;
  if new.follow_up_date is not null and new.follow_up_date < current_date
     and (tg_op = 'INSERT' or new.follow_up_date is distinct from old.follow_up_date) then
    raise exception 'The follow-up date can''t be in the past.' using errcode = 'check_violation';
  end if;

  -- history
  if tg_op = 'UPDATE' then
    if new.application_id is distinct from old.application_id then
      insert into public.admission_enquiry_activities (school_id, enquiry_id, kind, from_status, to_status, note, actor)
      values (new.school_id, new.id, case when new.application_id is null then 'unlinked' else 'linked' end::public.enquiry_activity_kind,
              old.status, new.status,
              coalesce(v_note, case when new.application_id is null then 'Unlinked from the online application'
                                    else 'Linked to online application ' || v_app.application_number end),
              (select auth.uid()));
    elsif new.status is distinct from old.status then
      insert into public.admission_enquiry_activities (school_id, enquiry_id, kind, from_status, to_status, follow_up_date, note, actor)
      values (new.school_id, new.id, 'status', old.status, new.status, new.follow_up_date, v_note, (select auth.uid()));
    elsif new.follow_up_date is distinct from old.follow_up_date then
      insert into public.admission_enquiry_activities (school_id, enquiry_id, kind, to_status, follow_up_date, note, actor)
      values (new.school_id, new.id, 'follow_up', new.status, new.follow_up_date, v_note, (select auth.uid()));
    elsif v_note is not null then
      insert into public.admission_enquiry_activities (school_id, enquiry_id, kind, to_status, note, actor)
      values (new.school_id, new.id, 'note', new.status, v_note, (select auth.uid()));
    end if;
  end if;
  return new;
end $$;
create trigger admission_enquiries_guard before insert or update on public.admission_enquiries
  for each row execute function private.guard_enquiry();

-- the "created" entry needs the row to exist (activities reference it)
create or replace function private.log_enquiry_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.admission_enquiry_activities (school_id, enquiry_id, kind, to_status, follow_up_date, note, actor)
  values (new.school_id, new.id, 'created', new.status, new.follow_up_date, null, new.created_by);
  return null;
end $$;
create trigger admission_enquiries_created after insert on public.admission_enquiries
  for each row execute function private.log_enquiry_created();

-- An online application links itself to the enquiry it came from (same session, same
-- mobile, exactly one open unlinked enquiry), and every linked enquiry follows the
-- application's status.
create or replace function private.sync_enquiry_from_application()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if tg_op = 'INSERT' then
    select array_agg(e.id) into v_ids from public.admission_enquiries e
    where e.school_id = new.school_id and e.academic_session_id = new.academic_session_id
      and e.application_id is null and e.status not in ('rejected', 'admitted')
      and right(regexp_replace(e.phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace(new.contact_phone, '[^0-9]', '', 'g'), 10);
    if coalesce(array_length(v_ids, 1), 0) = 1 then
      update public.admission_enquiries set application_id = new.id,
        activity_note = 'Online application ' || new.application_number || ' received (matched by mobile number)'
      where id = v_ids[1];
    end if;
  elsif new.status is distinct from old.status then
    update public.admission_enquiries e set status = private.enquiry_status_for(new.status),
      activity_note = 'Application ' || new.application_number || ': ' || replace(new.status::text, '_', ' ')
    where e.application_id = new.id and e.status is distinct from private.enquiry_status_for(new.status)
      and not exists (select 1 from public.academic_sessions a where a.id = e.academic_session_id and a.archived_at is not null);
  end if;
  return null;
end $$;
create trigger admission_applications_sync_enquiry after insert or update of status on public.admission_applications
  for each row execute function private.sync_enquiry_from_application();

-- =====================================================================
-- RLS
-- =====================================================================
revoke all on public.admission_enquiries, public.admission_enquiry_activities from anon, authenticated;
grant select, insert, update, delete on public.admission_enquiries to authenticated;
grant select on public.admission_enquiry_activities to authenticated;     -- written by trigger only
alter table public.admission_enquiries enable row level security;
alter table public.admission_enquiry_activities enable row level security;

create policy admission_enquiries_select on public.admission_enquiries for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy admission_enquiries_insert on public.admission_enquiries for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy admission_enquiries_update on public.admission_enquiries for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy admission_enquiries_delete on public.admission_enquiries for delete to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy admission_enquiry_activities_select on public.admission_enquiry_activities for select to authenticated
  using (exists (select 1 from public.admission_enquiries e where e.id = enquiry_id));
