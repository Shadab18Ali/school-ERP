-- =====================================================================
-- Phase 15: timetable
--   subjects            per-school subject catalogue
--   timetable_periods   the bell schedule of a session: numbered periods with start
--                       and end times (breaks marked); periods never overlap
--   timetable_entries   class (section) + day + period -> subject, teacher, room
-- Conflicts are impossible, not just checked (unique indexes, race-safe):
--   * a class has one subject per day+period
--   * a teacher is in one class per day+period
--   * a room is used once per day+period
-- Because periods of a session can't overlap, "same period" means "same time".
-- =====================================================================

-- ---------- subjects ----------
create table public.subjects (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  code        text check (code is null or code ~ '^[A-Za-z0-9-]{1,12}$'),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint subjects_id_school_key unique (id, school_id)
);
create unique index subjects_school_name_key on public.subjects (school_id, lower(btrim(name)));
create unique index subjects_school_code_key on public.subjects (school_id, upper(code)) where code is not null;
create trigger subjects_updated_at before update on public.subjects for each row execute function private.set_updated_at();
create trigger subjects_lock_school before update on public.subjects for each row execute function private.prevent_school_change();

-- ---------- periods (bell schedule per session) ----------
create table public.timetable_periods (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  academic_session_id  uuid not null,
  period_number        smallint not null check (period_number between 1 and 20),
  label                text check (label is null or char_length(btrim(label)) between 1 and 40),
  start_time           time not null,
  end_time             time not null,
  is_break             boolean not null default false,
  created_at           timestamptz not null default now(),
  constraint periods_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id) on delete cascade,
  constraint periods_id_session_key unique (id, academic_session_id),
  constraint periods_number_key unique (academic_session_id, period_number),
  constraint periods_times_valid check (end_time > start_time and end_time - start_time <= interval '4 hours')
);

create or replace function private.guard_period()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v record; clash record;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.schools where id = old.school_id) then return old; end if;
    select name, archived_at into v from public.academic_sessions where id = old.academic_session_id;
    if v.archived_at is not null then
      raise exception 'Session % is archived, so its timetable is read-only.', v.name using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.timetable_entries e where e.period_id = old.id) then
      raise exception 'Classes are timetabled in this period. Clear them before deleting the period.' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  select name, archived_at into v from public.academic_sessions where id = new.academic_session_id;
  if v.archived_at is not null then
    raise exception 'Session % is archived, so its timetable is read-only.', v.name using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.academic_session_id <> old.academic_session_id then
    raise exception 'A period can''t move to another session.' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and new.is_break and not old.is_break
     and exists (select 1 from public.timetable_entries e where e.period_id = new.id) then
    raise exception 'Classes are timetabled in this period. Clear them before making it a break.' using errcode = 'check_violation';
  end if;
  -- periods of a session must not overlap (this is what makes "same period" mean "same time")
  select p.period_number, p.start_time, p.end_time into clash
  from public.timetable_periods p
  where p.academic_session_id = new.academic_session_id and p.id <> new.id
    and p.start_time < new.end_time and new.start_time < p.end_time
  limit 1;
  if found then
    raise exception 'This overlaps period % (% – %).', clash.period_number,
      to_char(clash.start_time, 'HH24:MI'), to_char(clash.end_time, 'HH24:MI') using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------- entries ----------
create table public.timetable_entries (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  academic_session_id  uuid not null,
  class_id             uuid not null,
  section_id           uuid not null,
  day_of_week          smallint not null check (day_of_week between 1 and 7),  -- ISO: 1 = Monday
  period_id            uuid not null,
  subject_id           uuid not null,
  teacher_id           uuid,
  room                 text check (room is null or char_length(room) between 1 and 30),
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint entries_section_fkey foreign key (section_id, class_id, academic_session_id)
    references public.sections (id, class_id, academic_session_id) on delete cascade,
  constraint entries_class_fkey foreign key (class_id, school_id) references public.classes (id, school_id),
  constraint entries_period_fkey foreign key (period_id, academic_session_id)
    references public.timetable_periods (id, academic_session_id),
  constraint entries_subject_fkey foreign key (subject_id, school_id) references public.subjects (id, school_id),
  constraint entries_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id)
);
-- THE three conflict rules
create unique index tt_class_slot on public.timetable_entries (section_id, day_of_week, period_id);
create unique index tt_teacher_slot on public.timetable_entries (teacher_id, day_of_week, period_id) where teacher_id is not null;
create unique index tt_room_slot on public.timetable_entries (academic_session_id, day_of_week, period_id, lower(room)) where room is not null;
create index tt_teacher_idx on public.timetable_entries (teacher_id);
create trigger entries_updated_at before update on public.timetable_entries for each row execute function private.set_updated_at();
create trigger entries_lock_school before update on public.timetable_entries for each row execute function private.prevent_school_change();

create trigger periods_guard before insert or update or delete on public.timetable_periods
  for each row execute function private.guard_period();

create or replace function private.guard_timetable_entry()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.schools where id = old.school_id) then return old; end if;
    select name, archived_at into v from public.academic_sessions where id = old.academic_session_id;
    if v.archived_at is not null then
      raise exception 'Session % is archived, so its timetable is read-only.', v.name using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.section_id, new.academic_session_id) is distinct from (old.section_id, old.academic_session_id) then
    raise exception 'A timetable slot can''t move to another class.' using errcode = 'check_violation';
  end if;
  new.room := nullif(upper(btrim(new.room)), '');
  select name, archived_at into v from public.academic_sessions where id = new.academic_session_id;
  if v.archived_at is not null then
    raise exception 'Session % is archived, so its timetable is read-only.', v.name using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.sections s where s.id = new.section_id and (s.deleted_at is not null or not s.is_active)) then
    raise exception 'That section is inactive or deleted.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.timetable_periods p where p.id = new.period_id and p.is_break) then
    raise exception 'Nothing can be timetabled in a break.' using errcode = 'check_violation';
  end if;
  if (tg_op = 'INSERT' or new.subject_id is distinct from old.subject_id)
     and exists (select 1 from public.subjects s where s.id = new.subject_id and not s.is_active) then
    raise exception 'That subject is inactive.' using errcode = 'check_violation';
  end if;
  if new.teacher_id is not null and (tg_op = 'INSERT' or new.teacher_id is distinct from old.teacher_id) then
    if exists (select 1 from public.teachers t where t.id = new.teacher_id and t.status <> 'active') then
      raise exception 'That teacher is inactive.' using errcode = 'check_violation';
    end if;
    -- teachers only teach (and only see) classes assigned to them
    if not exists (select 1 from public.teacher_assignments a where a.teacher_id = new.teacher_id and a.section_id = new.section_id) then
      raise exception 'That teacher isn''t assigned to this class. Assign them under Teachers first.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger entries_guard before insert or update or delete on public.timetable_entries
  for each row execute function private.guard_timetable_entry();

-- ---------- who may see a class timetable ----------
-- admins and accountants of the school, a teacher assigned to the class, and the
-- parents / the student themselves of a student enrolled in it
create or replace function private.can_view_section_timetable(p_section_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sections s
    where s.id = p_section_id and (
      private.is_super_admin()
      or private.has_school_role(s.school_id, array['school_admin', 'accountant']::public.app_role[])
      or private.teacher_assigned_section(s.id)
      or exists (select 1 from public.student_enrollments e
                 where e.section_id = s.id and private.can_view_student_record(e.student_id))
    )
  );
$$;

-- Staff names on timetables: visible to members of the teacher's school (a printed
-- timetable goes to parents anyway). Nothing else about the teacher is exposed.
create or replace function private.teacher_display_name(p_teacher_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select t.full_name from public.teachers t
  where t.id = p_teacher_id and (private.is_super_admin() or private.is_school_member(t.school_id));
$$;

revoke all on function private.can_view_section_timetable(uuid), private.teacher_display_name(uuid) from public, anon;
grant execute on function private.can_view_section_timetable(uuid), private.teacher_display_name(uuid) to authenticated;

-- ---------- access ----------
revoke all on public.subjects, public.timetable_periods, public.timetable_entries from anon, authenticated;
grant select, insert, update on public.subjects to authenticated;  -- subjects are deactivated, never deleted
grant select, insert, update, delete on public.timetable_periods, public.timetable_entries to authenticated;
alter table public.subjects enable row level security;
alter table public.timetable_periods enable row level security;
alter table public.timetable_entries enable row level security;

-- the subject list and bell schedule are school-wide, non-sensitive
create policy subjects_select on public.subjects for select to authenticated
  using ((select private.is_super_admin()) or private.is_school_member(school_id));
create policy subjects_write on public.subjects for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy periods_select on public.timetable_periods for select to authenticated
  using ((select private.is_super_admin()) or private.is_school_member(school_id));
create policy periods_write on public.timetable_periods for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
-- entries: only the people who may see that class's timetable
create policy entries_select on public.timetable_entries for select to authenticated
  using (private.can_view_section_timetable(section_id));
create policy entries_write on public.timetable_entries for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- an assignment can't be removed while the teacher is timetabled in that class
create or replace function private.guard_assignment_timetable()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.schools where id = old.school_id)
     and exists (select 1 from public.timetable_entries e where e.teacher_id = old.teacher_id and e.section_id = old.section_id)
     and not exists (select 1 from public.teacher_assignments a
                     where a.teacher_id = old.teacher_id and a.section_id = old.section_id and a.id <> old.id) then
    raise exception 'This teacher is on the timetable for this class. Remove them from those periods first.'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;
create trigger assignments_guard_timetable before delete on public.teacher_assignments
  for each row execute function private.guard_assignment_timetable();
