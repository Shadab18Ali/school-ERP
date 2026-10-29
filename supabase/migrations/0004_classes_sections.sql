-- =====================================================================
-- Phase 5: class & section management
--   * soft deletion (deleted_at) for classes and sections; users can no longer
--     hard-delete either (history for students/fees/attendance must survive)
--   * name uniqueness ignores soft-deleted rows, so "Class 1" can be re-created
--   * database guards: no sections in archived sessions or deleted/inactive
--     classes; no deleting a class that still has sections; no deleting or
--     moving a section that has students
--   * one function returns student counts per section (0 until the students
--     module replaces its body)
-- =====================================================================

-- ---------- soft-delete columns ----------
alter table public.classes
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id) on delete set null,
  add constraint classes_deleted_inactive check (deleted_at is null or not is_active);

alter table public.sections
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id) on delete set null,
  add constraint sections_deleted_inactive check (deleted_at is null or not is_active);

-- ---------- uniqueness only among live rows ----------
drop index public.classes_school_name_key;
create unique index classes_school_name_key
  on public.classes (school_id, lower(btrim(name))) where deleted_at is null;

drop index public.sections_session_class_name_key;
create unique index sections_session_class_name_key
  on public.sections (academic_session_id, class_id, lower(btrim(name))) where deleted_at is null;

create index classes_school_live_idx on public.classes (school_id, display_order) where deleted_at is null;
create index sections_session_live_idx on public.sections (academic_session_id, class_id) where deleted_at is null;

-- ---------- users may not hard-delete classes or sections ----------
-- (deleting a whole school still cascades: FK actions don't go through RLS)
drop policy classes_delete on public.classes;
drop policy sections_delete on public.sections;

-- ---------- student counts (single source for every screen and rule) ----------
-- The students module will REPLACE this function's body to count enrolments.
create or replace function private.section_student_counts(p_section_ids uuid[])
returns table (section_id uuid, student_count bigint)
language sql stable security definer set search_path = '' as $$
  select id, 0::bigint from unnest(p_section_ids) as id;
$$;
revoke all on function private.section_student_counts(uuid[]) from public, anon;
grant execute on function private.section_student_counts(uuid[]) to authenticated;

-- ---------- section guard ----------
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
      raise exception 'Section % has % students. Move them to another section first.', old.name, v_students
        using errcode = 'restrict_violation';
    end if;
  end if;

  if new.deleted_at is not null then
    new.is_active := false;
  end if;
  return new;
end $$;

create trigger sections_guard_change
  before insert or update on public.sections
  for each row execute function private.guard_section_change();

-- ---------- class guard ----------
create or replace function private.guard_class_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_live bigint;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    select count(*) into v_live from public.sections where class_id = old.id and deleted_at is null;
    if v_live > 0 then
      raise exception 'Class % still has % section(s) across all sessions. Delete those sections first.', old.name, v_live
        using errcode = 'restrict_violation';
    end if;
  end if;
  if new.deleted_at is not null then
    new.is_active := false;
  end if;
  return new;
end $$;

create trigger classes_guard_change
  before update on public.classes
  for each row execute function private.guard_class_change();
