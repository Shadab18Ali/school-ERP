-- =====================================================================
-- Phase 1: Foundation — tenants (schools), profiles, memberships, audit
-- Multi-tenant model: every school-scoped table carries school_id and is
-- protected by RLS. Platform super admin is a flag on profiles, NOT a
-- school role, so it can never be granted through membership tables.
-- =====================================================================

create extension if not exists pgcrypto;

-- Helper functions live in a schema that PostgREST does NOT expose.
create schema if not exists private;

-- ---------- Types ----------
create type public.app_role as enum ('school_admin', 'accountant', 'teacher', 'parent', 'student');
create type public.school_status as enum ('active', 'suspended');
create type public.membership_status as enum ('active', 'disabled');

-- ---------- Tables ----------
create table public.schools (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 200),
  code        text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  email       text,
  phone       text,
  address     text,
  city        text,
  state       text,
  country     text not null default 'India',
  timezone    text not null default 'Asia/Kolkata',
  logo_url    text,
  status      public.school_status not null default 'active',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null,
  full_name       text not null default '',
  phone           text,
  avatar_url      text,
  is_super_admin  boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index profiles_email_lower_idx on public.profiles (lower(email));

create table public.school_memberships (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        public.app_role not null,
  status      public.membership_status not null default 'active',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (school_id, user_id, role)
);
create index school_memberships_user_idx on public.school_memberships (user_id);
create index school_memberships_school_idx on public.school_memberships (school_id);

create table public.audit_logs (
  id           bigint generated always as identity primary key,
  school_id    uuid references public.schools(id) on delete set null,
  actor_id     uuid references auth.users(id) on delete set null,
  action       text not null,
  entity_type  text not null,
  entity_id    text,
  metadata     jsonb not null default '{}'::jsonb,
  ip_address   text,
  user_agent   text,
  created_at   timestamptz not null default now()
);
create index audit_logs_school_created_idx on public.audit_logs (school_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id);

-- ---------- updated_at triggers ----------
create or replace function private.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger schools_updated_at before update on public.schools
  for each row execute function private.set_updated_at();
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger school_memberships_updated_at before update on public.school_memberships
  for each row execute function private.set_updated_at();

-- ---------- Auto-create profile for every new auth user ----------
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------- Authorization helpers (security definer => no RLS recursion) ----------
create or replace function private.is_super_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.is_super_admin from public.profiles p where p.id = (select auth.uid())),
    false
  );
$$;

create or replace function private.is_school_member(p_school_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.school_memberships m
    join public.schools s on s.id = m.school_id
    where m.school_id = p_school_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and s.status = 'active'
  );
$$;

create or replace function private.has_school_role(p_school_id uuid, p_roles public.app_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.school_memberships m
    join public.schools s on s.id = m.school_id
    where m.school_id = p_school_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and s.status = 'active'
      and m.role = any (p_roles)
  );
$$;

-- Can the current user (as a school admin) see this other user's profile?
create or replace function private.is_admin_of_user(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.school_memberships target
    join public.school_memberships me on me.school_id = target.school_id
    where target.user_id = p_user_id
      and me.user_id = (select auth.uid())
      and me.role = 'school_admin'
      and me.status = 'active'
  );
$$;

-- Audit writer: actor is ALWAYS taken from the JWT, never from the caller.
-- Not reachable via the REST API (private schema); only the backend's
-- direct DB connection can call it, inside the same transaction as the change.
create or replace function private.write_audit_log(
  p_school_id uuid, p_action text, p_entity_type text, p_entity_id text,
  p_metadata jsonb, p_ip text, p_user_agent text
) returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (school_id, actor_id, action, entity_type, entity_id, metadata, ip_address, user_agent)
  values (p_school_id, (select auth.uid()), p_action, p_entity_type, p_entity_id,
          coalesce(p_metadata, '{}'::jsonb), p_ip, left(p_user_agent, 500));
$$;

revoke all on all functions in schema private from public, anon;
grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;

-- ---------- Grants ----------
revoke all on public.schools, public.profiles, public.school_memberships, public.audit_logs from anon;
revoke all on public.profiles, public.audit_logs from authenticated;

grant select, insert, update, delete on public.schools to authenticated;
grant select, insert, update, delete on public.school_memberships to authenticated;
grant select on public.profiles to authenticated;
-- Users may only edit harmless columns; is_super_admin is never client-writable.
grant update (full_name, phone, avatar_url) on public.profiles to authenticated;
grant select on public.audit_logs to authenticated;

-- ---------- Row Level Security ----------
alter table public.schools            enable row level security;
alter table public.profiles           enable row level security;
alter table public.school_memberships enable row level security;
alter table public.audit_logs         enable row level security;

-- schools
create policy schools_select on public.schools for select to authenticated
  using (private.is_super_admin() or private.is_school_member(id));
create policy schools_insert on public.schools for insert to authenticated
  with check (private.is_super_admin());
create policy schools_update on public.schools for update to authenticated
  using (private.is_super_admin()) with check (private.is_super_admin());
create policy schools_delete on public.schools for delete to authenticated
  using (private.is_super_admin());

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_super_admin() or private.is_admin_of_user(id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- school_memberships
create policy memberships_select on public.school_memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_super_admin()
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
  );
create policy memberships_write on public.school_memberships for all to authenticated
  using (private.is_super_admin() or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (private.is_super_admin() or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- audit_logs: read-only to super admins / that school's admins; no write policies at all
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    private.is_super_admin()
    or (school_id is not null and private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  );
