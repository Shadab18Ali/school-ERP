-- =====================================================================
-- Phase 16: homework & assignments
--   homework                     set for one class section: title, description,
--                                deadline, optional maximum marks, late allowed?
--   homework_attachments         files the teacher attaches
--   homework_submissions         one per student per homework: answer text,
--                                submitted time, late flag, marks, feedback
--   homework_submission_files    files the student attaches to their submission
--
-- Who may do what (RLS + triggers, so the API can't be talked out of it):
--   * school admins: everything in their school
--   * teachers: see homework of sections assigned to them; create homework only
--     there; edit, delete and review only homework they set themselves
--   * students: see homework of their own section(s), submit their own work
--     before the deadline (or late, if the teacher allows it), change it until
--     it is reviewed; never marks or feedback, never other students' work
--   * parents: see their children's homework, submissions, marks and feedback;
--     read only
--   * accountants: nothing
-- =====================================================================

create type public.homework_kind as enum ('homework', 'assignment');

create table public.homework (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  academic_session_id  uuid not null,
  class_id             uuid not null,
  section_id           uuid not null,
  kind                 public.homework_kind not null default 'homework',
  subject_id           uuid,
  title                text not null check (char_length(btrim(title)) between 2 and 150),
  description          text not null default '' check (char_length(description) <= 5000),
  due_at               timestamptz not null,
  max_marks            numeric(6, 2) check (max_marks is null or (max_marks > 0 and max_marks <= 1000)),
  allow_late           boolean not null default false,
  teacher_id           uuid,          -- the teacher who set it (null when set by an admin)
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint homework_id_school_key unique (id, school_id),
  constraint homework_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id) on delete cascade,
  constraint homework_class_fkey foreign key (class_id, school_id) references public.classes (id, school_id),
  constraint homework_section_fkey foreign key (section_id, class_id, academic_session_id)
    references public.sections (id, class_id, academic_session_id),
  constraint homework_subject_fkey foreign key (subject_id, school_id) references public.subjects (id, school_id),
  constraint homework_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id)
);
create index homework_section_due_idx on public.homework (section_id, due_at desc);
create index homework_school_due_idx on public.homework (school_id, due_at desc);
create index homework_teacher_idx on public.homework (teacher_id) where teacher_id is not null;
create trigger homework_updated_at before update on public.homework for each row execute function private.set_updated_at();
create trigger homework_lock_school before update on public.homework for each row execute function private.prevent_school_change();

create table public.homework_attachments (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references public.schools (id) on delete cascade,
  homework_id  uuid not null,
  file_name    text not null check (char_length(file_name) between 1 and 160),
  mime_type    text not null,
  size_bytes   integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  file_path    text not null unique,
  uploaded_by  uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint homework_attachments_homework_fkey foreign key (homework_id, school_id)
    references public.homework (id, school_id) on delete cascade
);
create index homework_attachments_homework_idx on public.homework_attachments (homework_id);

create table public.homework_submissions (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  homework_id    uuid not null,
  student_id     uuid not null,
  enrollment_id  uuid not null,
  answer         text not null default '' check (char_length(answer) <= 5000),
  submitted_at   timestamptz not null default now(),
  is_late        boolean not null default false,
  marks          numeric(6, 2) check (marks is null or marks >= 0),
  feedback       text check (feedback is null or char_length(feedback) <= 2000),
  reviewed_at    timestamptz,
  reviewed_by    uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint homework_submissions_id_school_key unique (id, school_id),
  constraint homework_submissions_one_per_student unique (homework_id, student_id),
  constraint homework_submissions_homework_fkey foreign key (homework_id, school_id)
    references public.homework (id, school_id) on delete cascade,
  constraint homework_submissions_student_fkey foreign key (student_id, school_id)
    references public.students (id, school_id) on delete cascade,
  constraint homework_submissions_enrollment_fkey foreign key (enrollment_id, school_id)
    references public.student_enrollments (id, school_id) on delete cascade
);
create index homework_submissions_student_idx on public.homework_submissions (student_id);
create trigger submissions_updated_at before update on public.homework_submissions for each row execute function private.set_updated_at();
create trigger submissions_lock_school before update on public.homework_submissions for each row execute function private.prevent_school_change();

create table public.homework_submission_files (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  submission_id  uuid not null,
  file_name      text not null check (char_length(file_name) between 1 and 160),
  mime_type      text not null,
  size_bytes     integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  file_path      text not null unique,
  created_at     timestamptz not null default now(),
  constraint submission_files_submission_fkey foreign key (submission_id, school_id)
    references public.homework_submissions (id, school_id) on delete cascade
);
create index submission_files_submission_idx on public.homework_submission_files (submission_id);

-- =====================================================================
-- Access helpers
-- =====================================================================
-- the signed-in user's active, linked teacher record in a school (null if none)
create or replace function private.current_teacher_id(p_school_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select t.id
  from public.teachers t
  join public.school_memberships m on m.user_id = t.account_id and m.school_id = t.school_id
                                   and m.role = 'teacher' and m.status = 'active'
  join public.schools s on s.id = t.school_id and s.status = 'active'
  where t.school_id = p_school_id and t.account_id = (select auth.uid()) and t.status = 'active'
  limit 1;
$$;

-- see a section's homework: admins, its teachers, and its students / their parents
create or replace function private.can_view_section_homework(p_section_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.sections s
    where s.id = p_section_id and (
      private.is_super_admin()
      or private.has_school_role(s.school_id, array['school_admin']::public.app_role[])
      or private.teacher_assigned_section(s.id)
      or exists (select 1 from public.student_enrollments e
                 where e.section_id = s.id and private.can_view_student_record(e.student_id))
    )
  );
$$;

-- change a homework, its files, and review its submissions: admins, or the
-- teacher who set it while they are still assigned to that section
create or replace function private.can_manage_homework(p_homework_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.homework h
    where h.id = p_homework_id and (
      private.is_super_admin()
      or private.has_school_role(h.school_id, array['school_admin']::public.app_role[])
      or (h.teacher_id is not null and h.teacher_id = private.current_teacher_id(h.school_id)
          and private.teacher_assigned_section(h.section_id))
    )
  );
$$;

revoke all on function private.current_teacher_id(uuid), private.can_view_section_homework(uuid),
  private.can_manage_homework(uuid) from public, anon;
grant execute on function private.current_teacher_id(uuid), private.can_view_section_homework(uuid),
  private.can_manage_homework(uuid) to authenticated;

-- =====================================================================
-- Guards
-- =====================================================================
create or replace function private.guard_homework()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_session record; v_section record; v_subject record; v_top numeric;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.schools where id = old.school_id) then return old; end if;
    select name, archived_at into v_session from public.academic_sessions where id = old.academic_session_id;
    if v_session.archived_at is not null then
      raise exception 'Session % is archived, so its homework is read-only.', v_session.name using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.homework_submissions s where s.homework_id = old.id) then
      raise exception 'Students have already submitted work for this, so it can''t be deleted.' using errcode = 'check_violation';
    end if;
    return old;
  end if;

  select name, archived_at into v_session from public.academic_sessions where id = new.academic_session_id;
  if v_session.archived_at is not null then
    raise exception 'Session % is archived, so its homework is read-only.', v_session.name using errcode = 'check_violation';
  end if;
  new.title := btrim(new.title);

  if tg_op = 'INSERT' then
    -- who set it is decided here, never by the caller
    new.teacher_id := private.current_teacher_id(new.school_id);
    new.created_by := (select auth.uid());
    select is_active, deleted_at into v_section from public.sections where id = new.section_id;
    if v_section.deleted_at is not null or not v_section.is_active then
      raise exception 'This section is inactive, so homework can''t be set for it.' using errcode = 'check_violation';
    end if;
    if new.due_at <= now() then
      raise exception 'The deadline must be in the future.' using errcode = 'check_violation';
    end if;
  else
    new.teacher_id := old.teacher_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if new.due_at <> old.due_at and new.due_at <= now() then
      raise exception 'The deadline must be in the future.' using errcode = 'check_violation';
    end if;
    if (new.section_id, new.class_id, new.academic_session_id) is distinct from (old.section_id, old.class_id, old.academic_session_id)
       and exists (select 1 from public.homework_submissions s where s.homework_id = old.id) then
      raise exception 'Students have already submitted work, so the class can''t be changed.' using errcode = 'check_violation';
    end if;
    select max(marks) into v_top from public.homework_submissions s where s.homework_id = old.id;
    if v_top is not null and (new.max_marks is null or new.max_marks < v_top) then
      raise exception 'Some work is already marked out of the current maximum (highest mark %). The maximum can''t go below it.', v_top
        using errcode = 'check_violation';
    end if;
  end if;

  if new.subject_id is not null and (tg_op = 'INSERT' or new.subject_id is distinct from old.subject_id) then
    select is_active into v_subject from public.subjects where id = new.subject_id;
    if not v_subject.is_active then
      raise exception 'That subject is inactive.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger homework_guard before insert or update or delete on public.homework
  for each row execute function private.guard_homework();

create or replace function private.guard_homework_attachment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v record;
begin
  if not exists (select 1 from public.schools where id = coalesce(new.school_id, old.school_id)) then return coalesce(new, old); end if;
  select a.archived_at, a.name into v from public.homework h join public.academic_sessions a on a.id = h.academic_session_id
  where h.id = coalesce(new.homework_id, old.homework_id);
  if v.archived_at is not null then
    raise exception 'Session % is archived, so its homework is read-only.', v.name using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    new.uploaded_by := (select auth.uid());
    if (select count(*) from public.homework_attachments where homework_id = new.homework_id) >= 10 then
      raise exception 'A homework can have at most 10 files.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  return old;
end $$;
create trigger homework_attachments_guard before insert or delete on public.homework_attachments
  for each row execute function private.guard_homework_attachment();

-- Students may only change their answer, and only while it can still be submitted;
-- reviewers may only change marks and feedback.
create or replace function private.guard_submission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare h record; v_section uuid; v_archived timestamptz; v_late boolean;
begin
  select hw.*, a.archived_at as session_archived_at into h
  from public.homework hw join public.academic_sessions a on a.id = hw.academic_session_id
  where hw.id = new.homework_id;
  if h.session_archived_at is not null then
    raise exception 'This session is archived, so its homework is read-only.' using errcode = 'check_violation';
  end if;

  if private.is_student_self(new.student_id) then
    if tg_op = 'UPDATE' then
      if old.reviewed_at is not null then
        raise exception 'Your teacher has already reviewed this, so it can''t be changed.' using errcode = 'check_violation';
      end if;
      if (new.homework_id, new.student_id, new.enrollment_id) is distinct from (old.homework_id, old.student_id, old.enrollment_id) then
        raise exception 'A submission can''t be moved.' using errcode = 'check_violation';
      end if;
    end if;
    select section_id into v_section from public.student_enrollments
    where id = new.enrollment_id and student_id = new.student_id;
    if v_section is distinct from h.section_id then
      raise exception 'This homework isn''t set for your class.' using errcode = 'check_violation';
    end if;
    v_late := now() > h.due_at;
    if v_late and not h.allow_late then
      raise exception 'The deadline has passed, so this can''t be submitted any more.' using errcode = 'check_violation';
    end if;
    if new.marks is not null or new.feedback is not null or new.reviewed_at is not null or new.reviewed_by is not null then
      raise exception 'Only a teacher can add marks or feedback.' using errcode = 'insufficient_privilege';
    end if;
    new.submitted_at := now();
    new.is_late := v_late;
    return new;
  end if;

  -- staff (RLS has already decided they may manage this homework): review only
  if tg_op = 'INSERT' then
    raise exception 'Only the student can submit their work.' using errcode = 'insufficient_privilege';
  end if;
  if (new.answer, new.submitted_at, new.is_late, new.student_id, new.enrollment_id, new.homework_id)
     is distinct from (old.answer, old.submitted_at, old.is_late, old.student_id, old.enrollment_id, old.homework_id) then
    raise exception 'A teacher can''t change a student''s submitted work.' using errcode = 'insufficient_privilege';
  end if;
  if new.marks is not null then
    if h.max_marks is null then
      raise exception 'This homework isn''t marked. Set maximum marks on it first.' using errcode = 'check_violation';
    end if;
    if new.marks > h.max_marks then
      raise exception 'Marks can''t be more than the maximum (%).', h.max_marks using errcode = 'check_violation';
    end if;
  end if;
  new.feedback := nullif(btrim(new.feedback), '');
  if new.marks is null and new.feedback is null then
    new.reviewed_at := null; new.reviewed_by := null;
  else
    new.reviewed_at := now(); new.reviewed_by := (select auth.uid());
  end if;
  return new;
end $$;
create trigger submissions_guard before insert or update on public.homework_submissions
  for each row execute function private.guard_submission();

create or replace function private.guard_submission_file()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s record;
begin
  if not exists (select 1 from public.schools where id = coalesce(new.school_id, old.school_id)) then return coalesce(new, old); end if;
  select sub.reviewed_at, hw.due_at, hw.allow_late, a.archived_at into s
  from public.homework_submissions sub
  join public.homework hw on hw.id = sub.homework_id
  join public.academic_sessions a on a.id = hw.academic_session_id
  where sub.id = coalesce(new.submission_id, old.submission_id);
  if s is null then return coalesce(new, old); end if;  -- cascading delete of the submission
  if s.archived_at is not null then
    raise exception 'This session is archived, so its homework is read-only.' using errcode = 'check_violation';
  end if;
  if s.reviewed_at is not null then
    raise exception 'Your teacher has already reviewed this, so it can''t be changed.' using errcode = 'check_violation';
  end if;
  if now() > s.due_at and not s.allow_late then
    raise exception 'The deadline has passed, so this can''t be changed any more.' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if (select count(*) from public.homework_submission_files where submission_id = new.submission_id) >= 5 then
      raise exception 'You can attach at most 5 files.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  return old;
end $$;
create trigger submission_files_guard before insert or delete on public.homework_submission_files
  for each row execute function private.guard_submission_file();

-- a teacher can't be unassigned from a class while their homework there has submissions
create or replace function private.guard_assignment_homework()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.schools where id = old.school_id) then return old; end if;
  if exists (
    select 1 from public.homework h
    where h.section_id = old.section_id and h.teacher_id = old.teacher_id
      and exists (select 1 from public.homework_submissions s where s.homework_id = h.id and s.reviewed_at is null)
      and not exists (select 1 from public.teacher_assignments a
                      where a.section_id = old.section_id and a.teacher_id = old.teacher_id and a.id <> old.id)
  ) then
    raise exception 'This teacher has homework in this class waiting to be reviewed. Review it (or ask an admin to) before removing them.'
      using errcode = 'check_violation';
  end if;
  return old;
end $$;
create trigger assignments_guard_homework before delete on public.teacher_assignments
  for each row execute function private.guard_assignment_homework();

-- =====================================================================
-- RLS
-- =====================================================================
revoke all on public.homework, public.homework_attachments, public.homework_submissions,
  public.homework_submission_files from anon, authenticated;
grant select, insert, update, delete on public.homework, public.homework_attachments to authenticated;
grant select, insert, update on public.homework_submissions to authenticated;   -- submissions are never deleted by users
grant select, insert, delete on public.homework_submission_files to authenticated;
alter table public.homework enable row level security;
alter table public.homework_attachments enable row level security;
alter table public.homework_submissions enable row level security;
alter table public.homework_submission_files enable row level security;

create policy homework_select on public.homework for select to authenticated
  using (private.can_view_section_homework(section_id));
-- teachers: only in sections assigned to them, and only their own (teacher_id is set by the trigger)
create policy homework_insert on public.homework for insert to authenticated
  with check ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or (private.teacher_assigned_section(section_id) and teacher_id = private.current_teacher_id(school_id)));
create policy homework_update on public.homework for update to authenticated
  using (private.can_manage_homework(id))
  with check ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or (private.teacher_assigned_section(section_id) and teacher_id = private.current_teacher_id(school_id)));
create policy homework_delete on public.homework for delete to authenticated
  using (private.can_manage_homework(id));

create policy homework_attachments_select on public.homework_attachments for select to authenticated
  using (exists (select 1 from public.homework h where h.id = homework_id));   -- homework RLS applies
create policy homework_attachments_insert on public.homework_attachments for insert to authenticated
  with check (private.can_manage_homework(homework_id));
create policy homework_attachments_delete on public.homework_attachments for delete to authenticated
  using (private.can_manage_homework(homework_id));

create policy submissions_select on public.homework_submissions for select to authenticated
  using (private.can_view_student_record(student_id) or private.can_manage_homework(homework_id));
create policy submissions_insert on public.homework_submissions for insert to authenticated
  with check (private.is_student_self(student_id));
create policy submissions_update on public.homework_submissions for update to authenticated
  using (private.is_student_self(student_id) or private.can_manage_homework(homework_id))
  with check (private.is_student_self(student_id) or private.can_manage_homework(homework_id));

create policy submission_files_select on public.homework_submission_files for select to authenticated
  using (exists (select 1 from public.homework_submissions s where s.id = submission_id));  -- submission RLS applies
create policy submission_files_insert on public.homework_submission_files for insert to authenticated
  with check (exists (select 1 from public.homework_submissions s where s.id = submission_id and private.is_student_self(s.student_id)));
create policy submission_files_delete on public.homework_submission_files for delete to authenticated
  using (exists (select 1 from public.homework_submissions s where s.id = submission_id and private.is_student_self(s.student_id)));

-- ---------- private bucket: files are streamed through the API only ----------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('homework-files', 'homework-files', false, 10485760, array[
      'application/pdf', 'image/jpeg', 'image/png',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
