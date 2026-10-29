-- =====================================================================
-- Phase 18: report cards
--   report_card_templates   per-school designs: layout, colour, title, which
--                           sections appear, signature labels, principal's name
--                           and signature image, footer note; one default
--   exams.report_card_template_id   the template an exam uses (null = default)
--   report_card_remarks     per exam per student: class teacher's remarks and
--                           principal's remarks
--
-- Who may do what:
--   * templates: every member of the school can read them (report cards are
--     built with the reader's identity); only school admins change them
--   * teacher remarks: admins, and teachers of the student's section
--   * principal remarks: school admins only (enforced by trigger)
--   * remarks lock when the exam's results are published (like marks), and
--     parents/students see them only then
-- =====================================================================

create type public.report_card_layout as enum ('classic', 'modern');

create table public.report_card_templates (
  id                        uuid primary key default gen_random_uuid(),
  school_id                 uuid not null references public.schools (id) on delete cascade,
  name                      text not null check (char_length(btrim(name)) between 2 and 60),
  is_default                boolean not null default false,
  layout                    public.report_card_layout not null default 'classic',
  accent_color              text not null default '#2f6b57' check (accent_color ~ '^#[0-9a-fA-F]{6}$'),
  title                     text not null default 'Report Card' check (char_length(btrim(title)) between 2 and 60),
  show_logo                 boolean not null default true,
  show_photo                boolean not null default true,
  show_rank                 boolean not null default true,
  show_attendance           boolean not null default true,
  show_subject_grades       boolean not null default true,
  show_pass_marks           boolean not null default true,
  show_grade_scale          boolean not null default true,
  show_teacher_remarks      boolean not null default true,
  show_principal_remarks    boolean not null default true,
  signature_1               text default 'Class Teacher' check (signature_1 is null or char_length(signature_1) between 1 and 40),
  signature_2               text default 'Principal' check (signature_2 is null or char_length(signature_2) between 1 and 40),
  signature_3               text default 'Parent / Guardian' check (signature_3 is null or char_length(signature_3) between 1 and 40),
  principal_name            text check (principal_name is null or char_length(principal_name) <= 100),
  principal_signature_path  text,   -- object in the private report-card-assets bucket
  footer_note               text check (footer_note is null or char_length(footer_note) <= 300),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint report_card_templates_id_school_key unique (id, school_id)
);
create unique index report_card_templates_name_key on public.report_card_templates (school_id, lower(btrim(name)));
create unique index report_card_templates_one_default on public.report_card_templates (school_id) where is_default;
create trigger report_card_templates_updated_at before update on public.report_card_templates for each row execute function private.set_updated_at();
create trigger report_card_templates_lock_school before update on public.report_card_templates for each row execute function private.prevent_school_change();

create or replace function private.guard_report_card_template()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.is_default and exists (select 1 from public.schools where id = old.school_id) then
      raise exception 'The default template can''t be deleted. Make another template the default first.' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  new.name := btrim(new.name);
  new.title := btrim(new.title);
  new.accent_color := lower(new.accent_color);
  return new;
end $$;
create trigger report_card_templates_guard before insert or update or delete on public.report_card_templates
  for each row execute function private.guard_report_card_template();

-- an exam's template (deleting the template falls back to the default)
alter table public.exams add column report_card_template_id uuid;
alter table public.exams add constraint exams_report_card_template_fkey foreign key (report_card_template_id, school_id)
  references public.report_card_templates (id, school_id) on delete set null (report_card_template_id);

-- ---------- remarks ----------
create table public.report_card_remarks (
  id                 uuid primary key default gen_random_uuid(),
  school_id          uuid not null references public.schools (id) on delete cascade,
  exam_id            uuid not null,
  student_id         uuid not null,
  enrollment_id      uuid not null,
  section_id         uuid not null,   -- copied from the enrollment by the trigger (used by RLS)
  teacher_remarks    text check (teacher_remarks is null or char_length(teacher_remarks) <= 500),
  principal_remarks  text check (principal_remarks is null or char_length(principal_remarks) <= 500),
  updated_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint report_card_remarks_one_per_student unique (exam_id, student_id),
  constraint report_card_remarks_exam_fkey foreign key (exam_id, school_id) references public.exams (id, school_id) on delete cascade,
  constraint report_card_remarks_student_fkey foreign key (student_id, school_id) references public.students (id, school_id) on delete cascade,
  constraint report_card_remarks_enrollment_fkey foreign key (enrollment_id, school_id)
    references public.student_enrollments (id, school_id) on delete cascade
);
create index report_card_remarks_section_idx on public.report_card_remarks (section_id);
create trigger report_card_remarks_updated_at before update on public.report_card_remarks for each row execute function private.set_updated_at();
create trigger report_card_remarks_lock_school before update on public.report_card_remarks for each row execute function private.prevent_school_change();

create or replace function private.guard_report_card_remarks()
returns trigger language plpgsql security definer set search_path = '' as $$
declare x record; v_enr record; v_admin boolean; v_rec record;
begin
  v_rec := coalesce(new, old);
  if not exists (select 1 from public.schools where id = v_rec.school_id) then return v_rec; end if;
  select e.status, e.academic_session_id, a.archived_at, a.name as session_name into x
  from public.exams e join public.academic_sessions a on a.id = e.academic_session_id where e.id = v_rec.exam_id;
  if x.status is null then return v_rec; end if;  -- the exam is being deleted
  if x.archived_at is not null then
    raise exception 'Session % is archived, so its report cards are read-only.', x.session_name using errcode = 'check_violation';
  end if;
  if x.status = 'published' then
    raise exception 'Results of this exam are published. Unpublish them to change remarks.' using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then return old; end if;

  select student_id, section_id, academic_session_id into v_enr from public.student_enrollments where id = new.enrollment_id;
  if v_enr.student_id is distinct from new.student_id or v_enr.academic_session_id <> x.academic_session_id then
    raise exception 'This student isn''t enrolled in the exam''s session.' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and (new.exam_id, new.student_id) is distinct from (old.exam_id, old.student_id) then
    raise exception 'Remarks can''t be moved to another exam or student.' using errcode = 'check_violation';
  end if;
  new.section_id := v_enr.section_id;   -- never taken from the caller
  new.teacher_remarks := nullif(btrim(new.teacher_remarks), '');
  new.principal_remarks := nullif(btrim(new.principal_remarks), '');

  -- principal's remarks: school admins only
  v_admin := private.is_super_admin() or private.has_school_role(new.school_id, array['school_admin']::public.app_role[]);
  if not v_admin then
    if new.principal_remarks is distinct from (case when tg_op = 'UPDATE' then old.principal_remarks end) then
      raise exception 'Only the principal''s office (school admins) can write the principal''s remarks.' using errcode = 'insufficient_privilege';
    end if;
  end if;
  new.updated_by := (select auth.uid());
  return new;
end $$;
create trigger report_card_remarks_guard before insert or update or delete on public.report_card_remarks
  for each row execute function private.guard_report_card_remarks();

-- remarks are visible to families only after publication
create or replace function private.exam_published(p_exam_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.exams where id = p_exam_id and status = 'published');
$$;
revoke all on function private.exam_published(uuid) from public, anon;
grant execute on function private.exam_published(uuid) to authenticated;

-- the class teacher's name for a section, for report cards (members of the school only;
-- nothing else about the teacher is exposed)
create or replace function private.class_teacher_name(p_section_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select t.full_name from public.teacher_assignments a join public.teachers t on t.id = a.teacher_id
  where a.section_id = p_section_id and a.is_class_teacher
    and (private.is_super_admin() or private.is_school_member(a.school_id))
  limit 1;
$$;
revoke all on function private.class_teacher_name(uuid) from public, anon;
grant execute on function private.class_teacher_name(uuid) to authenticated;

-- ---------- access ----------
revoke all on public.report_card_templates, public.report_card_remarks from anon, authenticated;
grant select, insert, update, delete on public.report_card_templates, public.report_card_remarks to authenticated;
alter table public.report_card_templates enable row level security;
alter table public.report_card_remarks enable row level security;

create policy rc_templates_select on public.report_card_templates for select to authenticated
  using ((select private.is_super_admin()) or private.is_school_member(school_id));
create policy rc_templates_write on public.report_card_templates for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy rc_remarks_select on public.report_card_remarks for select to authenticated
  using ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or private.teacher_assigned_section(section_id)
    or (private.can_view_student_record(student_id) and private.exam_published(exam_id)));
create policy rc_remarks_write on public.report_card_remarks for all to authenticated
  using ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or private.teacher_assigned_section(section_id))
  with check ((select private.is_super_admin())
    or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    or private.teacher_assigned_section(section_id));

-- ---------- private bucket for signature images (streamed by the server only) ----------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('report-card-assets', 'report-card-assets', false, 1048576, array['image/png'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
