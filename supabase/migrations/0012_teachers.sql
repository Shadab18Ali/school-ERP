-- =====================================================================
-- Phase 14: teacher management + teacher portal
--   teachers             staff records (Employee ID, contact, qualification, subject,
--                        joining date, address, photo, status) + optional login link
--   teacher_assignments  teacher -> section (class + session), optional subject,
--                        "class teacher" flag (at most one per section)
--   access               teachers no longer see the whole school: students,
--                        enrollments, attendance, classes and sections are visible
--                        to a teacher ONLY for sections assigned to them
-- =====================================================================

create type public.teacher_status as enum ('active', 'inactive');

create table public.teachers (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  employee_id    text not null check (employee_id ~ '^[A-Za-z0-9/_-]{1,30}$'),
  full_name      text not null check (char_length(btrim(full_name)) between 2 and 150),
  phone          text not null check (phone ~ '^\+?[0-9]{10,15}$'),
  email          text not null check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length(email) <= 254),
  qualification  text check (qualification is null or char_length(qualification) between 1 and 150),
  subject        text check (subject is null or char_length(subject) between 1 and 100),
  joining_date   date not null check (joining_date >= date '1950-01-01'),
  address        text check (address is null or char_length(address) <= 500),
  photo_path     text,
  status         public.teacher_status not null default 'active',
  status_reason  text check (status_reason is null or char_length(status_reason) <= 300),
  account_id     uuid references public.profiles (id) on delete set null,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint teachers_id_school_key unique (id, school_id),
  constraint teachers_account_unique unique (account_id),
  -- a photo must sit in this school's / this teacher's folder
  constraint teachers_photo_path_scoped check (
    photo_path is null or photo_path like school_id::text || '/teachers/' || id::text || '/%')
);
create unique index teachers_school_employee_key on public.teachers (school_id, lower(employee_id));
create unique index teachers_school_email_key on public.teachers (school_id, lower(email));
create index teachers_school_name_idx on public.teachers (school_id, lower(full_name));

create trigger teachers_updated_at before update on public.teachers for each row execute function private.set_updated_at();
create trigger teachers_lock_school before update on public.teachers for each row execute function private.prevent_school_change();

-- Employee ID: given by the school, or allocated as EMP0001, EMP0002 ... when left empty.
create or replace function private.assign_employee_id()
returns trigger language plpgsql security definer set search_path = '' as $$
declare n bigint;
begin
  if new.employee_id is null or btrim(new.employee_id) = '' then
    loop
      insert into private.school_counters as c (school_id, kind, last_value) values (new.school_id, 'employee', 1)
      on conflict (school_id, kind) do update set last_value = c.last_value + 1
      returning last_value into n;
      new.employee_id := 'EMP' || lpad(n::text, 4, '0');
      exit when not exists (select 1 from public.teachers t
                            where t.school_id = new.school_id and lower(t.employee_id) = lower(new.employee_id));
    end loop;
  else
    new.employee_id := upper(btrim(new.employee_id));
  end if;
  return new;
end $$;
create trigger teachers_assign_employee_id before insert on public.teachers
  for each row execute function private.assign_employee_id();

-- Joining date not in the future; login link only by admins, only to a TEACHER of this school.
create or replace function private.guard_teacher()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.joining_date > current_date then
    raise exception 'The joining date can''t be in the future.' using errcode = 'check_violation';
  end if;
  if (tg_op = 'INSERT' and new.account_id is not null or tg_op = 'UPDATE' and new.account_id is distinct from old.account_id)
     and (select auth.uid()) is not null
     and not (private.is_super_admin() or private.has_school_role(new.school_id, array['school_admin']::public.app_role[])) then
    raise exception 'Only school administrators can link teacher logins.' using errcode = 'insufficient_privilege';
  end if;
  if new.account_id is not null and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id)
     and not exists (select 1 from public.school_memberships m
                     where m.user_id = new.account_id and m.school_id = new.school_id
                       and m.role = 'teacher' and m.status = 'active') then
    raise exception 'That account isn''t a teacher in this school.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger teachers_guard before insert or update on public.teachers
  for each row execute function private.guard_teacher();

-- ---------- assignments ----------
create table public.teacher_assignments (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  teacher_id           uuid not null,
  academic_session_id  uuid not null,
  class_id             uuid not null,
  section_id           uuid not null,
  subject              text check (subject is null or char_length(btrim(subject)) between 1 and 100),
  is_class_teacher     boolean not null default false,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  constraint assignments_teacher_fkey foreign key (teacher_id, school_id)
    references public.teachers (id, school_id) on delete cascade,
  constraint assignments_section_fkey foreign key (section_id, class_id, academic_session_id)
    references public.sections (id, class_id, academic_session_id) on delete cascade,
  constraint assignments_class_fkey foreign key (class_id, school_id) references public.classes (id, school_id),
  constraint assignments_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id)
);
-- the same teacher can't be given the same subject in the same section twice
create unique index assignments_unique on public.teacher_assignments (teacher_id, section_id, lower(coalesce(subject, '')));
-- at most one class teacher per section
create unique index assignments_one_class_teacher on public.teacher_assignments (section_id) where is_class_teacher;
create index assignments_section_idx on public.teacher_assignments (section_id);
create index assignments_teacher_idx on public.teacher_assignments (teacher_id);

create or replace function private.guard_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.schools where id = old.school_id) then return old; end if;  -- school deletion
    select archived_at, name into v from public.academic_sessions where id = old.academic_session_id;
    if v.archived_at is not null then
      raise exception 'Session % is archived, so its assignments are read-only.', v.name using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.teacher_id, new.section_id) is distinct from (old.teacher_id, old.section_id) then
    raise exception 'Remove the assignment and add a new one instead.' using errcode = 'check_violation';
  end if;
  select archived_at, name into v from public.academic_sessions where id = new.academic_session_id;
  if v.archived_at is not null then
    raise exception 'Session % is archived, so its assignments are read-only.', v.name using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from public.teachers t where t.id = new.teacher_id and t.status <> 'active') then
      raise exception 'Inactive teachers can''t be given classes.' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.sections s where s.id = new.section_id and (s.deleted_at is not null or not s.is_active)) then
      raise exception 'That section is inactive or deleted.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger assignments_guard before insert or update or delete on public.teacher_assignments
  for each row execute function private.guard_assignment();

-- =====================================================================
-- Access helpers (security definer, so RLS can call them without recursion).
-- A teacher counts only while: their teacher record is active, it is linked to
-- the signed-in account, that account holds an active teacher role in the school,
-- and the school is active.
-- =====================================================================
create or replace function private.teacher_assigned_section(p_section_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.teacher_assignments a
    join public.teachers t on t.id = a.teacher_id and t.status = 'active'
    join public.school_memberships m on m.user_id = t.account_id and m.school_id = t.school_id
                                     and m.role = 'teacher' and m.status = 'active'
    join public.schools s on s.id = t.school_id and s.status = 'active'
    where a.section_id = p_section_id and t.account_id = (select auth.uid())
  );
$$;

create or replace function private.teacher_sees_class(p_class_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.teacher_assignments a
    join public.teachers t on t.id = a.teacher_id and t.status = 'active'
    join public.school_memberships m on m.user_id = t.account_id and m.school_id = t.school_id
                                     and m.role = 'teacher' and m.status = 'active'
    join public.schools s on s.id = t.school_id and s.status = 'active'
    where a.class_id = p_class_id and t.account_id = (select auth.uid())
  );
$$;

create or replace function private.teacher_sees_student(p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.student_enrollments e
    join public.teacher_assignments a on a.section_id = e.section_id
    join public.teachers t on t.id = a.teacher_id and t.status = 'active'
    join public.school_memberships m on m.user_id = t.account_id and m.school_id = t.school_id
                                     and m.role = 'teacher' and m.status = 'active'
    join public.schools s on s.id = t.school_id and s.status = 'active'
    where e.student_id = p_student_id and t.account_id = (select auth.uid())
  );
$$;

revoke all on function private.teacher_assigned_section(uuid), private.teacher_sees_class(uuid),
  private.teacher_sees_student(uuid) from public, anon;
grant execute on function private.teacher_assigned_section(uuid), private.teacher_sees_class(uuid),
  private.teacher_sees_student(uuid) to authenticated;

-- =====================================================================
-- Replace whole-school teacher access with assigned-sections-only access.
-- (Parents and students keep the class/section names they could see before;
-- their own records stay governed by the portal policies.)
-- =====================================================================
drop policy students_select on public.students;
create policy students_select on public.students for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[])
         or private.teacher_sees_student(id));

drop policy enrollments_select on public.student_enrollments;
create policy enrollments_select on public.student_enrollments for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[])
         or private.teacher_assigned_section(section_id));

drop policy attendance_select on public.attendance_records;
drop policy attendance_insert on public.attendance_records;
drop policy attendance_update on public.attendance_records;
create policy attendance_select on public.attendance_records for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin']::public.app_role[])
         or private.teacher_assigned_section(section_id));
create policy attendance_insert on public.attendance_records for insert to authenticated
  with check ((select private.is_super_admin())
              or private.has_school_role(school_id, array['school_admin']::public.app_role[])
              or private.teacher_assigned_section(section_id));
create policy attendance_update on public.attendance_records for update to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin']::public.app_role[])
         or private.teacher_assigned_section(section_id))
  with check ((select private.is_super_admin())
              or private.has_school_role(school_id, array['school_admin']::public.app_role[])
              or private.teacher_assigned_section(section_id));

drop policy classes_select on public.classes;
create policy classes_select on public.classes for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin', 'accountant', 'parent', 'student']::public.app_role[])
         or private.teacher_sees_class(id));

drop policy sections_select on public.sections;
create policy sections_select on public.sections for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin', 'accountant', 'parent', 'student']::public.app_role[])
         or private.teacher_assigned_section(id));

-- ---------- teachers / assignments access ----------
revoke all on public.teachers, public.teacher_assignments from anon, authenticated;
grant select, insert, update on public.teachers to authenticated;  -- no delete: deactivate instead
grant select, insert, update, delete on public.teacher_assignments to authenticated;
alter table public.teachers enable row level security;
alter table public.teacher_assignments enable row level security;

create policy teachers_select on public.teachers for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin']::public.app_role[])
         or account_id = (select auth.uid()));  -- a teacher sees their own record
create policy teachers_insert on public.teachers for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy teachers_update on public.teachers for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy assignments_select on public.teacher_assignments for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin']::public.app_role[])
         or exists (select 1 from public.teachers t
                    where t.id = teacher_assignments.teacher_id and t.account_id = (select auth.uid())));
create policy assignments_write on public.teacher_assignments for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- ---------- private photo bucket for staff ----------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('staff-photos', 'staff-photos', false, 2097152, array['image/jpeg'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
