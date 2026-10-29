-- =====================================================================
-- Phase 2: Academic structure — roles, academic sessions, classes, sections
--
-- Design:
--   * roles             global catalogue of school roles (FK target for memberships)
--   * academic_sessions per school, e.g. "2026-27"; non-overlapping; one current
--   * classes           per school, stable across years (Nursery, LKG, Class 1 ...)
--   * sections          per class PER SESSION (A, B ...), so capacity/room/teachers
--                       can change every year without rewriting history
--
-- Tenant isolation is enforced three ways:
--   1. RLS: rows are visible only to members of an ACTIVE school (or super admin)
--   2. Composite foreign keys (id, school_id): a section can only point at a
--      class and session of the SAME school, even if application code is buggy
--   3. A trigger forbids changing school_id on any tenant row
-- =====================================================================

-- Supabase installs extensions into the "extensions" schema.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- Shared guard: tenant rows can never move to another school
-- ---------------------------------------------------------------------
create or replace function private.prevent_school_change()
returns trigger language plpgsql as $$
begin
  if new.school_id is distinct from old.school_id then
    raise exception 'school_id cannot be changed on %', tg_table_name
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end $$;

create trigger school_memberships_lock_school before update on public.school_memberships
  for each row execute function private.prevent_school_change();

-- ---------------------------------------------------------------------
-- roles
-- ---------------------------------------------------------------------
create table public.roles (
  id             uuid primary key default gen_random_uuid(),
  key            public.app_role not null unique,
  name           text not null,
  description    text not null default '',
  display_order  smallint not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger roles_updated_at before update on public.roles
  for each row execute function private.set_updated_at();

insert into public.roles (key, name, description, display_order) values
  ('school_admin', 'School admin', 'Full control of one school''s data and users', 1),
  ('accountant',   'Accountant',   'Fees, collections, receipts and financial reports', 2),
  ('teacher',      'Teacher',      'Attendance, homework, exams for assigned classes', 3),
  ('parent',       'Parent',       'Views their own children''s records and pays fees', 4),
  ('student',      'Student',      'Views their own timetable, homework and results', 5);

-- Every membership must reference a catalogued role.
alter table public.school_memberships
  add constraint school_memberships_role_fkey
  foreign key (role) references public.roles (key) on update cascade on delete restrict;

-- ---------------------------------------------------------------------
-- academic_sessions
-- ---------------------------------------------------------------------
create table public.academic_sessions (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 2 and 50),
  start_date  date not null,
  end_date    date not null,
  is_current  boolean not null default false,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint academic_sessions_dates_chk check (end_date > start_date),
  constraint academic_sessions_max_length_chk check (end_date - start_date <= 731),
  -- target for composite FKs from child tables
  constraint academic_sessions_id_school_key unique (id, school_id),
  -- sessions of one school may not overlap
  constraint academic_sessions_no_overlap exclude using gist (
    school_id with =,
    daterange(start_date, end_date, '[]') with &&
  )
);

create unique index academic_sessions_school_name_key
  on public.academic_sessions (school_id, lower(btrim(name)));
-- at most one current session per school
create unique index academic_sessions_one_current_key
  on public.academic_sessions (school_id) where is_current;
create index academic_sessions_school_start_idx
  on public.academic_sessions (school_id, start_date desc);

create trigger academic_sessions_updated_at before update on public.academic_sessions
  for each row execute function private.set_updated_at();
create trigger academic_sessions_lock_school before update on public.academic_sessions
  for each row execute function private.prevent_school_change();

-- ---------------------------------------------------------------------
-- classes
-- ---------------------------------------------------------------------
create table public.classes (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 50),
  display_order  smallint not null default 0 check (display_order between 0 and 999),
  is_active      boolean not null default true,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint classes_id_school_key unique (id, school_id)
);

create unique index classes_school_name_key on public.classes (school_id, lower(btrim(name)));
create index classes_school_order_idx on public.classes (school_id, display_order, name);

create trigger classes_updated_at before update on public.classes
  for each row execute function private.set_updated_at();
create trigger classes_lock_school before update on public.classes
  for each row execute function private.prevent_school_change();

-- ---------------------------------------------------------------------
-- sections
-- ---------------------------------------------------------------------
create table public.sections (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  class_id             uuid not null,
  academic_session_id  uuid not null,
  name                 text not null check (char_length(btrim(name)) between 1 and 20),
  capacity             smallint check (capacity is null or capacity between 1 and 500),
  room                 text check (room is null or char_length(room) <= 50),
  is_active            boolean not null default true,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint sections_id_school_key unique (id, school_id),
  -- Composite FKs: the class and session MUST belong to the same school.
  -- NO ACTION (checked at statement end) lets a school delete cascade cleanly,
  -- while deleting a class/session that still has sections is refused.
  constraint sections_class_fkey foreign key (class_id, school_id)
    references public.classes (id, school_id) on delete no action,
  constraint sections_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id) on delete no action
);

create unique index sections_session_class_name_key
  on public.sections (academic_session_id, class_id, lower(btrim(name)));
create index sections_school_idx on public.sections (school_id);
create index sections_class_idx on public.sections (class_id);
create index sections_session_idx on public.sections (academic_session_id);

create trigger sections_updated_at before update on public.sections
  for each row execute function private.set_updated_at();
create trigger sections_lock_school before update on public.sections
  for each row execute function private.prevent_school_change();

-- ---------------------------------------------------------------------
-- Switch the current session atomically.
-- SECURITY INVOKER: RLS decides whether the caller may do this.
-- ---------------------------------------------------------------------
create or replace function private.set_current_academic_session(p_session_id uuid)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_school_id uuid;
begin
  select s.school_id into v_school_id from public.academic_sessions s where s.id = p_session_id;
  if v_school_id is null then
    raise exception 'Academic session not found' using errcode = 'no_data_found';
  end if;

  update public.academic_sessions set is_current = false
   where school_id = v_school_id and is_current and id <> p_session_id;
  update public.academic_sessions set is_current = true where id = p_session_id;
  if not found then
    raise exception 'Not allowed to change the current session' using errcode = 'insufficient_privilege';
  end if;
end $$;

revoke all on function private.set_current_academic_session(uuid) from public, anon;
grant execute on function private.set_current_academic_session(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Grants (Supabase grants everything on new public tables by default)
-- ---------------------------------------------------------------------
revoke all on public.roles, public.academic_sessions, public.classes, public.sections from anon;
revoke all on public.roles from authenticated;
grant select on public.roles to authenticated;
grant select, insert, update, delete on public.academic_sessions, public.classes, public.sections to authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- Read:  any active member of the school, or super admin
-- Write: that school's admins, or super admin
-- ---------------------------------------------------------------------
alter table public.roles             enable row level security;
alter table public.academic_sessions enable row level security;
alter table public.classes           enable row level security;
alter table public.sections          enable row level security;

create policy roles_select on public.roles for select to authenticated using (true);
-- no write policies on roles: changed only by migrations

create policy academic_sessions_select on public.academic_sessions for select to authenticated
  using ((select private.is_super_admin()) or private.is_school_member(school_id));
create policy academic_sessions_insert on public.academic_sessions for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy academic_sessions_update on public.academic_sessions for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy academic_sessions_delete on public.academic_sessions for delete to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy classes_select on public.classes for select to authenticated
  using ((select private.is_super_admin()) or private.is_school_member(school_id));
create policy classes_insert on public.classes for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy classes_update on public.classes for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy classes_delete on public.classes for delete to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy sections_select on public.sections for select to authenticated
  using ((select private.is_super_admin()) or private.is_school_member(school_id));
create policy sections_insert on public.sections for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy sections_update on public.sections for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy sections_delete on public.sections for delete to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
