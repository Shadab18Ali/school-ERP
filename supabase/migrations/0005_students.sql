-- =====================================================================
-- Phase 6: students
--   students            the person (school-scoped, never hard-deleted by users)
--   student_enrollments one row per academic session: class, section,
--                       admission number (unique per school + session), date
--   Student ID          generated per school: STU00001, STU00002 ...
--   Photos              PRIVATE bucket; the API hands out short-lived signed URLs
-- Visibility: staff only (school admin, accountant, teacher). Parents/students
-- get access to their own records with the parent/student portals.
-- =====================================================================

create extension if not exists pg_trgm with schema extensions;

create type public.gender as enum ('male', 'female', 'other');
create type public.student_status as enum ('active', 'inactive');

-- ---------- per-school counters for human-friendly IDs ----------
create table private.school_counters (
  school_id  uuid not null references public.schools (id) on delete cascade,
  kind       text not null,
  last_value bigint not null default 0,
  primary key (school_id, kind)
);

-- ---------- students ----------
create table public.students (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references public.schools (id) on delete cascade,
  student_code      text not null,
  full_name         text not null check (char_length(btrim(full_name)) between 2 and 150),
  father_name       text check (father_name is null or char_length(father_name) <= 150),
  mother_name       text check (mother_name is null or char_length(mother_name) <= 150),
  date_of_birth     date not null check (date_of_birth > date '1950-01-01'),
  gender            public.gender not null,
  mobile            text not null check (mobile ~ '^\+?[0-9]{10,15}$'),
  alternate_mobile  text check (alternate_mobile is null or alternate_mobile ~ '^\+?[0-9]{10,15}$'),
  address           text check (address is null or char_length(address) <= 500),
  photo_path        text,
  status            public.student_status not null default 'active',
  status_reason     text check (status_reason is null or char_length(status_reason) <= 200),
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint students_parent_required
    check (coalesce(btrim(father_name), '') <> '' or coalesce(btrim(mother_name), '') <> ''),
  constraint students_id_school_key unique (id, school_id),
  constraint students_school_code_key unique (school_id, student_code)
);

create index students_school_status_idx on public.students (school_id, status);
create index students_name_trgm_idx on public.students using gin (full_name extensions.gin_trgm_ops);
create index students_mobile_idx on public.students (school_id, mobile);

-- ---------- enrollments ----------
-- Lets enrollments prove their section belongs to their class AND session.
alter table public.sections
  add constraint sections_id_class_session_key unique (id, class_id, academic_session_id);

create table public.student_enrollments (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  student_id           uuid not null,
  academic_session_id  uuid not null,
  class_id             uuid not null,
  section_id           uuid not null,
  admission_number     text not null check (char_length(btrim(admission_number)) between 1 and 30),
  admission_date       date not null check (admission_date > date '1950-01-01'),
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint student_enrollments_student_fkey foreign key (student_id, school_id)
    references public.students (id, school_id) on delete cascade,
  constraint student_enrollments_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id),
  constraint student_enrollments_class_fkey foreign key (class_id, school_id)
    references public.classes (id, school_id),
  constraint student_enrollments_section_fkey foreign key (section_id, class_id, academic_session_id)
    references public.sections (id, class_id, academic_session_id),
  constraint student_enrollments_one_per_session unique (student_id, academic_session_id)
);

-- The rule from the brief: no duplicate admission numbers within a school + session.
create unique index student_enrollments_admission_number_key
  on public.student_enrollments (school_id, academic_session_id, lower(btrim(admission_number)));
create index student_enrollments_section_idx on public.student_enrollments (section_id);
create index student_enrollments_class_idx on public.student_enrollments (class_id);
create index student_enrollments_session_idx on public.student_enrollments (academic_session_id, class_id);

-- ---------- triggers ----------
create trigger students_updated_at before update on public.students
  for each row execute function private.set_updated_at();
create trigger student_enrollments_updated_at before update on public.student_enrollments
  for each row execute function private.set_updated_at();
create trigger students_lock_school before update on public.students
  for each row execute function private.prevent_school_change();
create trigger student_enrollments_lock_school before update on public.student_enrollments
  for each row execute function private.prevent_school_change();

-- Student ID: allocated atomically per school (the counter row is locked).
create or replace function private.assign_student_code()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  n bigint;
begin
  if tg_op = 'INSERT' then
    insert into private.school_counters as c (school_id, kind, last_value)
    values (new.school_id, 'student', 1)
    on conflict (school_id, kind) do update set last_value = c.last_value + 1
    returning last_value into n;
    new.student_code := 'STU' || lpad(n::text, 5, '0');
  elsif new.student_code is distinct from old.student_code then
    raise exception 'A Student ID cannot be changed.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger students_assign_code
  before insert or update on public.students
  for each row execute function private.assign_student_code();

-- Enrollment rules (apply to everyone, including direct SQL).
create or replace function private.guard_enrollment_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_session_name text;
  v_archived timestamptz;
  v_sec record;
  v_cls record;
  v_taken bigint;
begin
  if tg_op = 'UPDATE' and (new.student_id <> old.student_id or new.academic_session_id <> old.academic_session_id) then
    raise exception 'An enrollment cannot be moved to another student or session.' using errcode = 'check_violation';
  end if;

  select name, archived_at into v_session_name, v_archived
    from public.academic_sessions where id = new.academic_session_id;
  if v_archived is not null then
    raise exception 'Session % is archived. Restore it before changing enrollments.', v_session_name
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' or new.section_id <> old.section_id or new.class_id <> old.class_id then
    -- lock the section row so two simultaneous admissions can't overfill it
    select s.name, s.capacity, s.is_active, s.deleted_at into v_sec
      from public.sections s where s.id = new.section_id for update;
    select c.name, c.is_active, c.deleted_at into v_cls
      from public.classes c where c.id = new.class_id;
    if v_cls.deleted_at is not null or not v_cls.is_active then
      raise exception 'Class % is inactive or deleted.', v_cls.name using errcode = 'check_violation';
    end if;
    if v_sec.deleted_at is not null or not v_sec.is_active then
      raise exception 'Section % of % is inactive or deleted.', v_sec.name,
        (select c.name from public.classes c join public.sections s on s.class_id = c.id where s.id = new.section_id)
        using errcode = 'check_violation';
    end if;
    if v_sec.capacity is not null then
      select count(*) into v_taken from public.student_enrollments
       where section_id = new.section_id and id <> new.id;
      if v_taken >= v_sec.capacity then
        raise exception 'Section % of % is full (% of %). Increase its capacity or choose another section.',
          v_sec.name, v_cls.name, v_taken, v_sec.capacity using errcode = 'check_violation';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger student_enrollments_guard
  before insert or update on public.student_enrollments
  for each row execute function private.guard_enrollment_change();

-- ---------- real student counts (replaces the Phase 5 placeholder) ----------
-- Every enrolment counts, whatever the student's status: a section that holds
-- anyone's history must not be deleted.
create or replace function private.section_student_counts(p_section_ids uuid[])
returns table (section_id uuid, student_count bigint)
language sql stable security definer set search_path = '' as $$
  select ids.id, count(e.id)
  from unnest(p_section_ids) as ids(id)
  left join public.student_enrollments e on e.section_id = ids.id
  group by ids.id;
$$;

-- Same section guard as 0004, with wording fit for real counts ("1 student(s)").
create or replace function private.guard_section_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_session_name text;
  v_archived timestamptz;
  v_class_name text;
  v_class_deleted timestamptz;
  v_class_active boolean;
  v_students bigint;
begin
  -- Sections of an archived session are read-only history.
  select name, archived_at into v_session_name, v_archived
    from public.academic_sessions where id = new.academic_session_id;
  if v_archived is not null then
    raise exception 'Session % is archived. Restore it before changing its sections.', v_session_name
      using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.academic_session_id <> old.academic_session_id then
    raise exception 'A section cannot be moved to another session. Create it in that session instead.'
      using errcode = 'check_violation';
  end if;

  -- New or re-assigned sections need a live, active class.
  if tg_op = 'INSERT' or new.class_id <> old.class_id
     or (old.deleted_at is not null and new.deleted_at is null) then
    select name, deleted_at, is_active into v_class_name, v_class_deleted, v_class_active
      from public.classes where id = new.class_id;
    if v_class_deleted is not null then
      raise exception 'Class % has been deleted.', v_class_name using errcode = 'check_violation';
    end if;
    if not v_class_active then
      raise exception 'Class % is inactive. Activate it before adding sections.', v_class_name
        using errcode = 'check_violation';
    end if;
  end if;

  -- Sections with students can't be deleted or moved to another class.
  if tg_op = 'UPDATE'
     and (new.class_id <> old.class_id or (new.deleted_at is not null and old.deleted_at is null)) then
    select c.student_count into v_students from private.section_student_counts(array[old.id]) c;
    if coalesce(v_students, 0) > 0 then
      raise exception 'Section % has % student(s). Move them to another section first.', old.name, v_students
        using errcode = 'restrict_violation';
    end if;
  end if;

  if new.deleted_at is not null then
    new.is_active := false;
  end if;
  return new;
end $$;

-- ---------- grants & RLS (staff only) ----------
revoke all on public.students, public.student_enrollments from anon;
grant select, insert, update on public.students, public.student_enrollments to authenticated;

alter table public.students enable row level security;
alter table public.student_enrollments enable row level security;

create policy students_select on public.students for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin', 'accountant', 'teacher']::public.app_role[]));
create policy students_insert on public.students for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy students_update on public.students for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy enrollments_select on public.student_enrollments for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin', 'accountant', 'teacher']::public.app_role[]));
create policy enrollments_insert on public.student_enrollments for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy enrollments_update on public.student_enrollments for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
-- no delete policies: students are deactivated, never deleted by users

-- ---------- private photo bucket ----------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('student-photos', 'student-photos', false, 2097152, array['image/jpeg'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
