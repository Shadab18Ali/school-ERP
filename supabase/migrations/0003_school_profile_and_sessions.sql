-- =====================================================================
-- Phase 4: school profile (registration details, logo) and academic
-- session lifecycle (current / archived / safe deletion).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. School profile fields
-- ---------------------------------------------------------------------
alter table public.schools
  add column postal_code          text check (postal_code is null or postal_code ~ '^[A-Za-z0-9 -]{3,10}$'),
  add column registration_number  text check (registration_number is null or char_length(registration_number) <= 50),
  add column affiliation_board    text check (affiliation_board is null or char_length(affiliation_board) <= 50),
  add column affiliation_number   text check (affiliation_number is null or char_length(affiliation_number) <= 50),
  add column udise_code           text check (udise_code is null or udise_code ~ '^[0-9]{11}$'),
  add column established_year     smallint check (established_year is null or established_year between 1800 and 2100),
  add column logo_path            text;  -- object path in the school-logos bucket

-- Board affiliation numbers are unique per board when present.
create unique index schools_affiliation_key
  on public.schools (lower(affiliation_board), lower(affiliation_number))
  where affiliation_board is not null and affiliation_number is not null;
create unique index schools_udise_key on public.schools (udise_code) where udise_code is not null;

-- ---------------------------------------------------------------------
-- 2. Logo storage bucket (public read: logos appear on receipts, ID cards,
--    the school website). Uploads go only through the backend, which uses the
--    service role, so there are deliberately NO insert/update policies for
--    users on storage.objects.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('school-logos', 'school-logos', true, 1048576, array['image/png'])
    on conflict (id) do update
      set public = excluded.public,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Session archiving
-- ---------------------------------------------------------------------
alter table public.academic_sessions
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users (id) on delete set null,
  add constraint academic_sessions_current_not_archived check (not (is_current and archived_at is not null));

create index academic_sessions_school_open_idx
  on public.academic_sessions (school_id) where archived_at is null;

-- ---------------------------------------------------------------------
-- 4. What data hangs off a session?
-- Discovers EVERY table with a foreign key to academic_sessions, so tables
-- added later (students, fees, attendance ...) are covered automatically.
-- ---------------------------------------------------------------------
create or replace function private.session_usage_unchecked(p_session_id uuid)
returns table (table_name text, row_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  ref record;
  n bigint;
begin
  for ref in
    select n.nspname as nsp, cl.relname as tbl, a.attname as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    join lateral unnest(c.conkey, c.confkey) as k(src, dst) on true
    join pg_attribute a  on a.attrelid  = c.conrelid  and a.attnum  = k.src
    join pg_attribute af on af.attrelid = c.confrelid and af.attnum = k.dst
    where c.contype = 'f'
      and c.confrelid = 'public.academic_sessions'::regclass
      and af.attname = 'id'
  loop
    execute format('select count(*) from %I.%I where %I = $1', ref.nsp, ref.tbl, ref.col) into n using p_session_id;
    if n > 0 then
      table_name := ref.tbl;
      row_count := n;
      return next;
    end if;
  end loop;
end $$;

revoke all on function private.session_usage_unchecked(uuid) from public, anon, authenticated;

-- Callable by users: only for sessions they are allowed to see.
create or replace function private.academic_session_usage(p_session_id uuid)
returns table (table_name text, row_count bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_school uuid;
begin
  select s.school_id into v_school from public.academic_sessions s where s.id = p_session_id;
  if v_school is null
     or not (private.is_super_admin() or private.is_school_member(v_school)) then
    raise exception 'Academic session not found' using errcode = 'no_data_found';
  end if;
  return query select * from private.session_usage_unchecked(p_session_id);
end $$;

revoke all on function private.academic_session_usage(uuid) from public, anon;
grant execute on function private.academic_session_usage(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Deletion guard — the last line of defence.
-- Even a buggy endpoint, a SQL-editor slip, or a future table declared with
-- ON DELETE CASCADE cannot remove a session that is current or holds data.
-- Deleting a whole school (a deliberate super-admin action) still cascades.
-- ---------------------------------------------------------------------
create or replace function private.guard_session_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  detail text;
begin
  -- Cascade from deleting the school itself: allowed.
  if not exists (select 1 from public.schools where id = old.school_id) then
    return old;
  end if;

  if old.is_current then
    raise exception 'Cannot delete the current academic session (%). Make another session current first.', old.name
      using errcode = 'restrict_violation';
  end if;

  select string_agg(format('%s %s', u.row_count, u.table_name), ', ')
    into detail
    from private.session_usage_unchecked(old.id) u;
  if detail is not null then
    raise exception 'Cannot delete academic session % because it still has records (%). Archive it instead.', old.name, detail
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;

create trigger academic_sessions_guard_delete
  before delete on public.academic_sessions
  for each row execute function private.guard_session_delete();

-- ---------------------------------------------------------------------
-- 6. Current-session switch now refuses archived sessions with a clear message
-- ---------------------------------------------------------------------
create or replace function private.set_current_academic_session(p_session_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_school_id uuid;
  v_archived timestamptz;
begin
  select s.school_id, s.archived_at into v_school_id, v_archived
    from public.academic_sessions s where s.id = p_session_id;
  if v_school_id is null then
    raise exception 'Academic session not found' using errcode = 'no_data_found';
  end if;
  if v_archived is not null then
    raise exception 'An archived session cannot be made current. Restore it first.' using errcode = 'check_violation';
  end if;

  update public.academic_sessions set is_current = false
   where school_id = v_school_id and is_current and id <> p_session_id;
  update public.academic_sessions set is_current = true where id = p_session_id;
  if not found then
    raise exception 'Not allowed to change the current session' using errcode = 'insufficient_privilege';
  end if;
end $$;
