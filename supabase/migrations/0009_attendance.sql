-- =====================================================================
-- Phase 10: attendance
--   attendance_records  one row per student per day (unique), with the class
--                       and section the student was in that day
--   private.save_section_attendance()  saves a whole section in ONE statement
--   report functions    daily, monthly grid, per student, per class (all SQL)
-- Attendance % = present / days marked (leave counts as marked, not present).
-- Access: school admins and teachers (mark + view).
-- =====================================================================

create type public.attendance_status as enum ('present', 'absent', 'leave');

create table public.attendance_records (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  student_id           uuid not null,
  enrollment_id        uuid not null,
  academic_session_id  uuid not null,
  class_id             uuid not null,
  section_id           uuid not null,
  attendance_date      date not null,
  status               public.attendance_status not null,
  remarks              text check (remarks is null or char_length(remarks) <= 200),
  marked_by            uuid references auth.users (id) on delete set null,
  updated_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- the brief's rule: never two records for the same student on the same day
  constraint attendance_one_per_student_day unique (student_id, attendance_date),
  constraint attendance_enrollment_fkey foreign key (enrollment_id, school_id)
    references public.student_enrollments (id, school_id) on delete cascade,
  constraint attendance_student_fkey foreign key (student_id, school_id) references public.students (id, school_id),
  constraint attendance_section_fkey foreign key (section_id, class_id, academic_session_id)
    references public.sections (id, class_id, academic_session_id)
);
create index attendance_section_date_idx on public.attendance_records (section_id, attendance_date);
create index attendance_school_date_idx on public.attendance_records (school_id, attendance_date);
create index attendance_enrollment_date_idx on public.attendance_records (enrollment_id, attendance_date);

create trigger attendance_updated_at before update on public.attendance_records
  for each row execute function private.set_updated_at();
create trigger attendance_lock_school before update on public.attendance_records
  for each row execute function private.prevent_school_change();

-- Rules that hold however a row is written.
create or replace function private.guard_attendance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_session record;
  v_enr record;
begin
  if tg_op = 'UPDATE' and (new.student_id, new.enrollment_id, new.attendance_date)
                          is distinct from (old.student_id, old.enrollment_id, old.attendance_date) then
    raise exception 'An attendance record can''t be moved to another student or date.' using errcode = 'check_violation';
  end if;
  select s.name, s.start_date, s.end_date, s.archived_at into v_session
    from public.academic_sessions s where s.id = new.academic_session_id;
  if v_session.archived_at is not null then
    raise exception 'Session % is archived, so its attendance is read-only.', v_session.name using errcode = 'check_violation';
  end if;
  if new.attendance_date > current_date then
    raise exception 'Attendance can''t be marked for a future date.' using errcode = 'check_violation';
  end if;
  if new.attendance_date not between v_session.start_date and v_session.end_date then
    raise exception 'That date is outside session %.', v_session.name using errcode = 'check_violation';
  end if;
  select e.student_id, e.academic_session_id into v_enr from public.student_enrollments e where e.id = new.enrollment_id;
  if v_enr.student_id <> new.student_id or v_enr.academic_session_id <> new.academic_session_id then
    raise exception 'The enrollment doesn''t match this student and session.' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' and exists (select 1 from public.students st where st.id = new.student_id and st.status <> 'active') then
    raise exception 'Inactive students can''t be marked.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger attendance_guard before insert or update on public.attendance_records
  for each row execute function private.guard_attendance();

-- =====================================================================
-- Save a whole section for one date in ONE statement.
--   p_entries: [{"enrollment_id": "...", "status": "present", "remarks": null}, ...]
-- Unchanged rows are not touched. Returns how many were added / changed / unchanged.
-- =====================================================================
create or replace function private.save_section_attendance(p_section_id uuid, p_date date, p_entries jsonb)
returns table (inserted int, updated int, unchanged int, changes jsonb)
language plpgsql security invoker set search_path = '' as $$
declare
  v_sec record;
  v_bad int;
begin
  select s.id, s.school_id, s.class_id, s.academic_session_id into v_sec
    from public.sections s where s.id = p_section_id and s.deleted_at is null;
  if not found then
    raise exception 'Section not found.' using errcode = 'no_data_found';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'Nothing to save.' using errcode = 'check_violation';
  end if;
  if (select count(*) <> count(distinct x.enrollment_id)
      from jsonb_to_recordset(p_entries) as x(enrollment_id uuid, status text, remarks text)) then
    raise exception 'A student appears twice in this save.' using errcode = 'check_violation';
  end if;
  -- every student must currently belong to this section
  select count(*) into v_bad
  from jsonb_to_recordset(p_entries) as x(enrollment_id uuid, status text, remarks text)
  left join public.student_enrollments e on e.id = x.enrollment_id and e.section_id = p_section_id
  where e.id is null;
  if v_bad > 0 then
    raise exception '% of these students aren''t in this section.', v_bad using errcode = 'check_violation';
  end if;

  return query
  with incoming as (
    select x.enrollment_id, x.status::public.attendance_status as status, nullif(btrim(x.remarks), '') as remarks,
           e.student_id
    from jsonb_to_recordset(p_entries) as x(enrollment_id uuid, status text, remarks text)
    join public.student_enrollments e on e.id = x.enrollment_id
  ),
  before as (
    select a.student_id, a.status, a.remarks from public.attendance_records a
    where a.attendance_date = p_date and a.student_id in (select student_id from incoming)
  ),
  written as (
    insert into public.attendance_records as a
      (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status, remarks,
       marked_by, updated_by)
    select v_sec.school_id, i.student_id, i.enrollment_id, v_sec.academic_session_id, v_sec.class_id, v_sec.id, p_date,
           i.status, i.remarks, (select auth.uid()), (select auth.uid())
    from incoming i
    on conflict (student_id, attendance_date) do update
      set status = excluded.status, remarks = excluded.remarks, updated_by = excluded.updated_by,
          section_id = excluded.section_id, class_id = excluded.class_id, enrollment_id = excluded.enrollment_id
      where (a.status, a.remarks) is distinct from (excluded.status, excluded.remarks)
    returning a.student_id, a.status, (xmax = 0) as was_insert
  )
  select (count(*) filter (where w.was_insert))::int,
         (count(*) filter (where not w.was_insert))::int,
         (jsonb_array_length(p_entries) - count(*))::int,
         coalesce(jsonb_agg(jsonb_build_object('student_id', w.student_id, 'from', b.status, 'to', w.status))
                  filter (where not w.was_insert), '[]'::jsonb)
  from written w left join before b on b.student_id = w.student_id;
end $$;

-- ---------- reports (SECURITY INVOKER: RLS applies) ----------
-- Daily: every section's counts for one date.
create or replace function private.attendance_daily(p_school uuid, p_date date)
returns table (section_id uuid, class_id uuid, class_name text, section_name text, class_order int,
               enrolled int, present int, absent int, leave int, unmarked int, percentage numeric)
language sql stable security invoker set search_path = '' as $$
  select sec.id, c.id, c.name, sec.name, c.display_order,
         count(e.id)::int,
         count(a.id) filter (where a.status = 'present')::int,
         count(a.id) filter (where a.status = 'absent')::int,
         count(a.id) filter (where a.status = 'leave')::int,
         (count(e.id) - count(a.id))::int,
         case when count(a.id) = 0 then null
              else round(100.0 * count(a.id) filter (where a.status = 'present') / count(a.id), 1) end
  from public.sections sec
  join public.classes c on c.id = sec.class_id
  join public.academic_sessions s on s.id = sec.academic_session_id and p_date between s.start_date and s.end_date
  left join public.student_enrollments e on e.section_id = sec.id
       and exists (select 1 from public.students st where st.id = e.student_id and st.status = 'active')
  left join public.attendance_records a on a.enrollment_id = e.id and a.attendance_date = p_date
  where sec.school_id = p_school and sec.deleted_at is null and sec.is_active
  group by sec.id, c.id, c.name, sec.name, c.display_order;
$$;

-- Per student over a date range, for a section (class report, monthly totals).
create or replace function private.attendance_student_totals(p_section_id uuid, p_from date, p_to date)
returns table (enrollment_id uuid, student_id uuid, present int, absent int, leave int, marked int, percentage numeric)
language sql stable security invoker set search_path = '' as $$
  select e.id, e.student_id,
         count(a.id) filter (where a.status = 'present')::int,
         count(a.id) filter (where a.status = 'absent')::int,
         count(a.id) filter (where a.status = 'leave')::int,
         count(a.id)::int,
         case when count(a.id) = 0 then null
              else round(100.0 * count(a.id) filter (where a.status = 'present') / count(a.id), 1) end
  from public.student_enrollments e
  left join public.attendance_records a on a.enrollment_id = e.id and a.attendance_date between p_from and p_to
  where e.section_id = p_section_id
  group by e.id, e.student_id;
$$;

-- Per day over a date range, for a section.
create or replace function private.attendance_section_days(p_section_id uuid, p_from date, p_to date)
returns table (attendance_date date, present int, absent int, leave int, marked int, percentage numeric)
language sql stable security invoker set search_path = '' as $$
  select a.attendance_date,
         count(*) filter (where a.status = 'present')::int,
         count(*) filter (where a.status = 'absent')::int,
         count(*) filter (where a.status = 'leave')::int,
         count(*)::int,
         round(100.0 * count(*) filter (where a.status = 'present') / count(*), 1)
  from public.attendance_records a
  where a.section_id = p_section_id and a.attendance_date between p_from and p_to
  group by a.attendance_date
  order by a.attendance_date;
$$;

-- One student, by month, for a session.
create or replace function private.attendance_student_months(p_enrollment_id uuid)
returns table (month date, present int, absent int, leave int, marked int, percentage numeric)
language sql stable security invoker set search_path = '' as $$
  select date_trunc('month', a.attendance_date)::date,
         count(*) filter (where a.status = 'present')::int,
         count(*) filter (where a.status = 'absent')::int,
         count(*) filter (where a.status = 'leave')::int,
         count(*)::int,
         round(100.0 * count(*) filter (where a.status = 'present') / count(*), 1)
  from public.attendance_records a
  where a.enrollment_id = p_enrollment_id
  group by 1 order by 1;
$$;

revoke all on function private.save_section_attendance(uuid, date, jsonb), private.attendance_daily(uuid, date),
  private.attendance_student_totals(uuid, date, date), private.attendance_section_days(uuid, date, date),
  private.attendance_student_months(uuid) from public, anon;
grant execute on function private.save_section_attendance(uuid, date, jsonb), private.attendance_daily(uuid, date),
  private.attendance_student_totals(uuid, date, date), private.attendance_section_days(uuid, date, date),
  private.attendance_student_months(uuid) to authenticated;

-- ---------- grants & RLS: admins + teachers ----------
revoke all on public.attendance_records from anon, authenticated;
grant select, insert, update on public.attendance_records to authenticated;  -- no delete: correct a mark instead
alter table public.attendance_records enable row level security;
create policy attendance_select on public.attendance_records for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]));
create policy attendance_insert on public.attendance_records for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]));
create policy attendance_update on public.attendance_records for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[]));
