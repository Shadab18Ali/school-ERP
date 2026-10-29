-- =====================================================================
-- Phase 17: exams, marks and results
--   exam_types    Unit Test, Half Yearly, Annual, and any custom type (per school)
--   grade_bands   the school's grading scale: a grade from a minimum percentage
--   exams         an exam of a session: draft -> scheduled -> published
--   exam_papers   the date sheet: class + subject, date and time, maximum and
--                 passing marks
--   exam_marks    one row per student per paper: marks, or absent
-- Results (totals, percentage, grade, pass/fail, rank) are calculated here, in
-- SQL, by private.exam_results / private.exam_result_marks.
--
-- Students who have left (inactive) are not counted in results or publication checks.
-- Who may do what:
--   * school admins: everything
--   * teachers: see exams and date sheets; enter marks only for students of
--     sections assigned to them, and only until results are published
--   * parents / students: see the date sheet once an exam is scheduled, and
--     their own (child's) marks and result only once results are published
-- Invalid marks are impossible: negative, above the paper's maximum, more than
-- two decimals, for a student not in that class, or after publication.
-- =====================================================================

create type public.exam_status as enum ('draft', 'scheduled', 'published');

-- ---------- exam types ----------
create table public.exam_types (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 2 and 60),
  display_order  smallint not null default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  constraint exam_types_id_school_key unique (id, school_id)
);
create unique index exam_types_school_name_key on public.exam_types (school_id, lower(btrim(name)));
create trigger exam_types_lock_school before update on public.exam_types for each row execute function private.prevent_school_change();

-- ---------- grading scale ----------
create table public.grade_bands (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools (id) on delete cascade,
  grade           text not null check (grade ~ '^[A-Za-z0-9+\-]{1,4}$'),
  min_percentage  numeric(5, 2) not null check (min_percentage >= 0 and min_percentage <= 100),
  remark          text check (remark is null or char_length(remark) <= 60),
  created_at      timestamptz not null default now()
);
create unique index grade_bands_school_grade_key on public.grade_bands (school_id, upper(grade));
create unique index grade_bands_school_min_key on public.grade_bands (school_id, min_percentage);
create trigger grade_bands_lock_school before update on public.grade_bands for each row execute function private.prevent_school_change();

-- ---------- exams ----------
create table public.exams (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null references public.schools (id) on delete cascade,
  academic_session_id   uuid not null,
  exam_type_id          uuid not null,
  name                  text not null check (char_length(btrim(name)) between 2 and 100),
  status                public.exam_status not null default 'draft',
  results_published_at  timestamptz,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint exams_id_school_key unique (id, school_id),
  constraint exams_id_session_key unique (id, academic_session_id),
  constraint exams_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id) on delete cascade,
  constraint exams_type_fkey foreign key (exam_type_id, school_id) references public.exam_types (id, school_id),
  constraint exams_published_stamp check ((status = 'published') = (results_published_at is not null))
);
create unique index exams_session_name_key on public.exams (academic_session_id, lower(btrim(name)));
create trigger exams_updated_at before update on public.exams for each row execute function private.set_updated_at();
create trigger exams_lock_school before update on public.exams for each row execute function private.prevent_school_change();

-- ---------- date sheet ----------
create table public.exam_papers (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  exam_id              uuid not null,
  academic_session_id  uuid not null,
  class_id             uuid not null,
  subject_id           uuid not null,
  exam_date            date not null,
  start_time           time not null,
  end_time             time not null,
  max_marks            numeric(6, 2) not null check (max_marks > 0 and max_marks <= 1000),
  pass_marks           numeric(6, 2) not null check (pass_marks >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint exam_papers_id_school_key unique (id, school_id),
  constraint exam_papers_one_per_subject unique (exam_id, class_id, subject_id),
  constraint exam_papers_exam_fkey foreign key (exam_id, academic_session_id)
    references public.exams (id, academic_session_id) on delete cascade,
  constraint exam_papers_class_fkey foreign key (class_id, school_id) references public.classes (id, school_id),
  constraint exam_papers_subject_fkey foreign key (subject_id, school_id) references public.subjects (id, school_id),
  constraint exam_papers_pass_within_max check (pass_marks <= max_marks),
  constraint exam_papers_times check (end_time > start_time and end_time - start_time <= interval '6 hours')
);
create index exam_papers_exam_class_idx on public.exam_papers (exam_id, class_id);
create index exam_papers_class_date_idx on public.exam_papers (class_id, exam_date);
create trigger exam_papers_updated_at before update on public.exam_papers for each row execute function private.set_updated_at();
create trigger exam_papers_lock_school before update on public.exam_papers for each row execute function private.prevent_school_change();

-- ---------- marks ----------
create table public.exam_marks (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  paper_id       uuid not null,
  student_id     uuid not null,
  enrollment_id  uuid not null,
  section_id     uuid not null,     -- copied from the enrollment by the trigger (used by RLS)
  marks          numeric(6, 2),
  is_absent      boolean not null default false,
  entered_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint exam_marks_one_per_student unique (paper_id, student_id),
  constraint exam_marks_paper_fkey foreign key (paper_id, school_id) references public.exam_papers (id, school_id) on delete cascade,
  constraint exam_marks_student_fkey foreign key (student_id, school_id) references public.students (id, school_id) on delete cascade,
  constraint exam_marks_enrollment_fkey foreign key (enrollment_id, school_id)
    references public.student_enrollments (id, school_id) on delete cascade,
  constraint exam_marks_marks_or_absent check ((is_absent and marks is null) or (not is_absent and marks is not null)),
  constraint exam_marks_not_negative check (marks is null or marks >= 0)
);
create index exam_marks_section_idx on public.exam_marks (section_id);
create index exam_marks_student_idx on public.exam_marks (student_id);
create trigger exam_marks_updated_at before update on public.exam_marks for each row execute function private.set_updated_at();
create trigger exam_marks_lock_school before update on public.exam_marks for each row execute function private.prevent_school_change();

-- =====================================================================
-- Guards
-- =====================================================================
create or replace function private.guard_exam()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_session record; v_missing record; v_count int;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.schools where id = old.school_id) then return old; end if;
    if exists (select 1 from public.exam_marks m join public.exam_papers p on p.id = m.paper_id where p.exam_id = old.id) then
      raise exception 'Marks have been entered for this exam, so it can''t be deleted.' using errcode = 'check_violation';
    end if;
    select name, archived_at into v_session from public.academic_sessions where id = old.academic_session_id;
    if v_session.archived_at is not null then
      raise exception 'Session % is archived, so its exams are read-only.', v_session.name using errcode = 'check_violation';
    end if;
    return old;
  end if;

  select name, archived_at into v_session from public.academic_sessions where id = new.academic_session_id;
  if v_session.archived_at is not null then
    raise exception 'Session % is archived, so its exams are read-only.', v_session.name using errcode = 'check_violation';
  end if;
  new.name := btrim(new.name);
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.status := 'draft';
    new.results_published_at := null;
    if not (select is_active from public.exam_types where id = new.exam_type_id) then
      raise exception 'That exam type is inactive.' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  new.created_by := old.created_by;
  if new.academic_session_id <> old.academic_session_id then
    raise exception 'An exam can''t be moved to another session.' using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status then
    if new.status in ('scheduled', 'published')
       and not exists (select 1 from public.exam_papers p where p.exam_id = new.id) then
      raise exception 'Add the date sheet (at least one paper) first.' using errcode = 'check_violation';
    end if;
    if new.status = 'published' then
      -- every student of every class in the exam needs marks (or "absent") for every paper
      select count(*) into v_count
      from public.exam_papers p
      join public.student_enrollments e on e.class_id = p.class_id and e.academic_session_id = p.academic_session_id
      join public.students s on s.id = e.student_id and s.status = 'active'
      where p.exam_id = new.id
        and not exists (select 1 from public.exam_marks m where m.paper_id = p.id and m.student_id = e.student_id);
      if v_count > 0 then
        select c.name || ' – ' || sec.name as cls, st.full_name, sub.name as subject into v_missing
        from public.exam_papers p
        join public.student_enrollments e on e.class_id = p.class_id and e.academic_session_id = p.academic_session_id
        join public.students st on st.id = e.student_id and st.status = 'active'
        join public.classes c on c.id = e.class_id
        join public.sections sec on sec.id = e.section_id
        join public.subjects sub on sub.id = p.subject_id
        where p.exam_id = new.id
          and not exists (select 1 from public.exam_marks m where m.paper_id = p.id and m.student_id = e.student_id)
        order by c.name, sec.name, st.full_name, sub.name limit 1;
        raise exception '% mark(s) are missing (for example % in %, %). Enter them, or mark the student absent, before publishing.',
          v_count, v_missing.full_name, v_missing.cls, v_missing.subject using errcode = 'check_violation';
      end if;
      new.results_published_at := now();
    else
      new.results_published_at := null;
    end if;
  else
    new.results_published_at := old.results_published_at;
  end if;
  return new;
end $$;
create trigger exams_guard before insert or update or delete on public.exams
  for each row execute function private.guard_exam();

create or replace function private.guard_exam_paper()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_exam record; v_session record; v_clash record; v_top numeric; v_rec record;
begin
  v_rec := coalesce(new, old);
  if not exists (select 1 from public.schools where id = v_rec.school_id) then return v_rec; end if;
  select status into v_exam from public.exams where id = v_rec.exam_id;
  if v_exam.status is null then return v_rec; end if;  -- the exam itself is being deleted
  select name, start_date, end_date, archived_at into v_session from public.academic_sessions where id = v_rec.academic_session_id;
  if v_session.archived_at is not null then
    raise exception 'Session % is archived, so its exams are read-only.', v_session.name using errcode = 'check_violation';
  end if;
  if v_exam.status = 'published' then
    raise exception 'Results of this exam are published. Unpublish them to change the date sheet.' using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    if exists (select 1 from public.exam_marks m where m.paper_id = old.id) then
      raise exception 'Marks have been entered for this paper, so it can''t be removed.' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if new.exam_date < v_session.start_date or new.exam_date > v_session.end_date then
    raise exception 'The date must be within session % (% to %).', v_session.name,
      to_char(v_session.start_date, 'DD Mon YYYY'), to_char(v_session.end_date, 'DD Mon YYYY') using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' or new.subject_id <> old.subject_id then
    if not (select is_active from public.subjects where id = new.subject_id) then
      raise exception 'That subject is inactive.' using errcode = 'check_violation';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if (new.class_id, new.subject_id, new.exam_id) is distinct from (old.class_id, old.subject_id, old.exam_id)
       and exists (select 1 from public.exam_marks m where m.paper_id = old.id) then
      raise exception 'Marks have been entered for this paper, so its class and subject can''t change.' using errcode = 'check_violation';
    end if;
    select max(marks) into v_top from public.exam_marks m where m.paper_id = old.id;
    if v_top is not null and new.max_marks < v_top then
      raise exception 'A student already has % marks in this paper, so the maximum can''t be lower than that.', v_top
        using errcode = 'check_violation';
    end if;
  end if;
  -- a class can't sit two papers at the same time (in any exam of the session)
  select sub.name, x.name as exam, p.start_time, p.end_time into v_clash
  from public.exam_papers p join public.subjects sub on sub.id = p.subject_id join public.exams x on x.id = p.exam_id
  where p.class_id = new.class_id and p.exam_date = new.exam_date and p.id <> new.id
    and p.start_time < new.end_time and new.start_time < p.end_time
  limit 1;
  if found then
    raise exception 'This class already has % (%) from % to % on that day.', v_clash.name, v_clash.exam,
      to_char(v_clash.start_time, 'HH24:MI'), to_char(v_clash.end_time, 'HH24:MI') using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger exam_papers_guard before insert or update or delete on public.exam_papers
  for each row execute function private.guard_exam_paper();

create or replace function private.guard_exam_mark()
returns trigger language plpgsql security definer set search_path = '' as $$
declare p record; v_enr record; v_rec record;
begin
  v_rec := coalesce(new, old);
  if not exists (select 1 from public.schools where id = v_rec.school_id) then return v_rec; end if;
  select pp.max_marks, pp.class_id, pp.academic_session_id, x.status, sub.name as subject, a.archived_at, a.name as session_name
    into p
  from public.exam_papers pp join public.exams x on x.id = pp.exam_id
  join public.subjects sub on sub.id = pp.subject_id
  join public.academic_sessions a on a.id = pp.academic_session_id
  where pp.id = v_rec.paper_id;
  if p.status is null then return v_rec; end if;  -- paper being deleted with its exam
  if p.archived_at is not null then
    raise exception 'Session % is archived, so its marks are read-only.', p.session_name using errcode = 'check_violation';
  end if;
  if p.status = 'published' then
    raise exception 'Results of this exam are published. Unpublish them to change marks.' using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; end if;

  select id, student_id, class_id, section_id, academic_session_id into v_enr
  from public.student_enrollments where id = new.enrollment_id;
  if v_enr.student_id is distinct from new.student_id or v_enr.class_id <> p.class_id
     or v_enr.academic_session_id <> p.academic_session_id then
    raise exception 'This student doesn''t sit this paper (wrong class).' using errcode = 'check_violation';
  end if;
  new.section_id := v_enr.section_id;   -- never taken from the caller (RLS relies on it)
  if tg_op = 'UPDATE' and (new.paper_id, new.student_id) is distinct from (old.paper_id, old.student_id) then
    raise exception 'A mark can''t be moved to another paper or student.' using errcode = 'check_violation';
  end if;
  if new.marks is not null then
    if new.marks > p.max_marks then
      raise exception 'Marks for % can''t be more than %.', p.subject, trim(to_char(p.max_marks, 'FM9999990.99'), '.')
        using errcode = 'check_violation';
    end if;
    if new.marks <> round(new.marks, 2) then
      raise exception 'Marks can have at most 2 decimal places.' using errcode = 'check_violation';
    end if;
  end if;
  new.entered_by := (select auth.uid());
  return new;
end $$;
create trigger exam_marks_guard before insert or update or delete on public.exam_marks
  for each row execute function private.guard_exam_mark();

-- =====================================================================
-- Access helpers
-- =====================================================================
-- marks of a paper are visible to parents/students only after publication
create or replace function private.exam_paper_published(p_paper_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.exam_papers p join public.exams x on x.id = p.exam_id
                 where p.id = p_paper_id and x.status = 'published');
$$;

-- grade for a percentage on the school's scale (null if no scale)
create or replace function private.grade_for(p_school_id uuid, p_pct numeric)
returns text language sql stable security definer set search_path = '' as $$
  select g.grade from public.grade_bands g
  where g.school_id = p_school_id and p_pct is not null and g.min_percentage <= p_pct
  order by g.min_percentage desc limit 1;
$$;

revoke all on function private.exam_paper_published(uuid), private.grade_for(uuid, numeric) from public, anon;
grant execute on function private.exam_paper_published(uuid), private.grade_for(uuid, numeric) to authenticated;

-- =====================================================================
-- Results (calculated in SQL)
-- Staff (admins, teachers of the section) get every student of the section.
-- Parents/students get only their own child's / own row, and only once the
-- exam is published; rank is still computed over the whole section.
-- Rules:
--   subject passed = not absent and marks >= passing marks
--   total = sum of marks (absent = 0); out of = sum of maximum marks
--   percentage = total / out of x 100, rounded to 2 decimals
--   result = incomplete (a mark is missing) | fail (any subject failed) | pass
--   rank = position in the section by percentage among complete results (ties share a rank)
-- =====================================================================
create or replace function private._exam_access(p_exam_id uuid, p_section_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare x record;
begin
  select e.school_id, e.status, e.academic_session_id into x from public.exams e where e.id = p_exam_id;
  if x is null or not exists (select 1 from public.sections s where s.id = p_section_id
                                and s.school_id = x.school_id and s.academic_session_id = x.academic_session_id) then
    return null;
  end if;
  if private.is_super_admin() or private.has_school_role(x.school_id, array['school_admin']::public.app_role[])
     or private.teacher_assigned_section(p_section_id) then
    return 'all';
  end if;
  if x.status = 'published' then return 'own'; end if;
  return null;
end $$;

create or replace function private.exam_results(p_exam_id uuid, p_section_id uuid)
returns table (
  student_id uuid, enrollment_id uuid, full_name text, admission_number text,
  papers int, entered int, absent int, failed int,
  total numeric, max_total numeric, percentage numeric, grade text, result text, rank int, section_size int
)
language plpgsql stable security definer set search_path = '' as $$
declare v_access text := private._exam_access(p_exam_id, p_section_id); v_school uuid;
begin
  if v_access is null then return; end if;
  select school_id into v_school from public.exams where id = p_exam_id;
  return query
  with st as (
    select en.id as enrollment_id, en.student_id, en.class_id, s.full_name, en.admission_number
    from public.student_enrollments en join public.students s on s.id = en.student_id and s.status = 'active'
    where en.section_id = p_section_id
  ), cells as (
    select st.student_id, p.max_marks, p.pass_marks, m.marks, m.is_absent, (m.id is not null) as has
    from st join public.exam_papers p on p.class_id = st.class_id and p.exam_id = p_exam_id
    left join public.exam_marks m on m.paper_id = p.id and m.student_id = st.student_id
  ), agg as (
    select c.student_id, count(*)::int as papers, count(*) filter (where c.has)::int as entered,
      count(*) filter (where c.is_absent)::int as absent,
      count(*) filter (where c.has and (c.is_absent or c.marks < c.pass_marks))::int as failed,
      coalesce(sum(c.marks), 0) as total, sum(c.max_marks) as max_total
    from cells c group by c.student_id
  ), res as (
    select st.student_id, st.enrollment_id, st.full_name, st.admission_number,
      coalesce(a.papers, 0) as papers, coalesce(a.entered, 0) as entered, coalesce(a.absent, 0) as absent,
      coalesce(a.failed, 0) as failed, a.total, a.max_total,
      case when a.papers > 0 and a.entered = a.papers then round(a.total * 100 / a.max_total, 2) end as percentage
    from st left join agg a on a.student_id = st.student_id
  ), ranked as (
    select r.*, private.grade_for(v_school, r.percentage) as grade,
      case when r.papers = 0 or r.entered < r.papers then 'incomplete' when r.failed > 0 then 'fail' else 'pass' end as result,
      case when r.percentage is not null then
        (rank() over (partition by r.percentage is not null order by r.percentage desc))::int end as rank,
      (count(*) over ())::int as section_size
    from res r
  )
  select k.student_id, k.enrollment_id, k.full_name, k.admission_number, k.papers, k.entered, k.absent, k.failed,
    k.total, k.max_total, k.percentage, k.grade, k.result, k.rank, k.section_size
  from ranked k
  where v_access = 'all' or private.can_view_student_record(k.student_id)
  order by k.rank nulls last, lower(k.full_name);
end $$;

create or replace function private.exam_result_marks(p_exam_id uuid, p_section_id uuid)
returns table (
  student_id uuid, paper_id uuid, subject_name text, exam_date date, max_marks numeric, pass_marks numeric,
  marks numeric, is_absent boolean, entered boolean, percentage numeric, grade text, passed boolean
)
language plpgsql stable security definer set search_path = '' as $$
declare v_access text := private._exam_access(p_exam_id, p_section_id); v_school uuid;
begin
  if v_access is null then return; end if;
  select school_id into v_school from public.exams where id = p_exam_id;
  return query
  select en.student_id, p.id, sub.name, p.exam_date, p.max_marks, p.pass_marks, m.marks, coalesce(m.is_absent, false),
    m.id is not null,
    case when m.marks is not null then round(m.marks * 100 / p.max_marks, 2) end,
    case when m.is_absent then 'AB' else private.grade_for(v_school, round(m.marks * 100 / p.max_marks, 2)) end,
    case when m.id is null then null else (not m.is_absent and m.marks >= p.pass_marks) end
  from public.student_enrollments en
  join public.students st on st.id = en.student_id and st.status = 'active'
  join public.exam_papers p on p.class_id = en.class_id and p.exam_id = p_exam_id
  join public.subjects sub on sub.id = p.subject_id
  left join public.exam_marks m on m.paper_id = p.id and m.student_id = en.student_id
  where en.section_id = p_section_id
    and (v_access = 'all' or private.can_view_student_record(en.student_id))
  order by en.student_id, p.exam_date, p.start_time, sub.name;
end $$;

revoke all on function private._exam_access(uuid, uuid), private.exam_results(uuid, uuid),
  private.exam_result_marks(uuid, uuid) from public, anon;
grant execute on function private.exam_results(uuid, uuid), private.exam_result_marks(uuid, uuid) to authenticated;
grant execute on function private._exam_access(uuid, uuid) to authenticated;

-- =====================================================================
-- RLS
-- =====================================================================
revoke all on public.exam_types, public.grade_bands, public.exams, public.exam_papers, public.exam_marks from anon, authenticated;
grant select, insert, update on public.exam_types to authenticated;   -- deactivated, never deleted
grant select, insert, update, delete on public.grade_bands, public.exams, public.exam_papers, public.exam_marks to authenticated;
alter table public.exam_types enable row level security;
alter table public.grade_bands enable row level security;
alter table public.exams enable row level security;
alter table public.exam_papers enable row level security;
alter table public.exam_marks enable row level security;

create policy exam_types_select on public.exam_types for select to authenticated
  using ((select private.is_super_admin()) or private.is_school_member(school_id));
create policy exam_types_write on public.exam_types for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy grade_bands_select on public.grade_bands for select to authenticated
  using ((select private.is_super_admin()) or private.is_school_member(school_id));
create policy grade_bands_write on public.grade_bands for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- drafts are staff-only; parents/students see scheduled and published exams
create policy exams_select on public.exams for select to authenticated
  using ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin', 'teacher']::public.app_role[])
    or (status <> 'draft' and private.is_school_member(school_id)));
create policy exams_write on public.exams for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy exam_papers_select on public.exam_papers for select to authenticated
  using (exists (select 1 from public.exams x where x.id = exam_id));   -- exams RLS applies
create policy exam_papers_write on public.exam_papers for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy exam_marks_select on public.exam_marks for select to authenticated
  using ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or private.teacher_assigned_section(section_id)
    or (private.can_view_student_record(student_id) and private.exam_paper_published(paper_id)));
-- section_id is set by the trigger from the enrollment, before this check runs
create policy exam_marks_insert on public.exam_marks for insert to authenticated
  with check ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or private.teacher_assigned_section(section_id));
create policy exam_marks_update on public.exam_marks for update to authenticated
  using ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or private.teacher_assigned_section(section_id))
  with check ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or private.teacher_assigned_section(section_id));
create policy exam_marks_delete on public.exam_marks for delete to authenticated
  using ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or private.teacher_assigned_section(section_id));
