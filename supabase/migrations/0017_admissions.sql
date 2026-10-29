-- =====================================================================
-- Phase 19: online admission
--   admission_windows        per session and class: open or closed, seats,
--                            admission fee, last date, instructions
--   admission_applications   submitted online by parents (no account needed)
--   admission_documents      files sent with an application
--   admission_events         the application's timeline (written by trigger)
--
-- Workflow (enforced by guard_admission):
--   submitted -> under_review -> verified -> approved | rejected
--   approved -> fee_paid -> enrolled (student created)
--   rejected -> under_review (reopened by an admin)
-- Any open step can also be rejected. "enrolled" is final.
--
-- The public can't touch any table. Anonymous visitors may only call these three
-- functions, kept in their own schema "intake" (nothing else is reachable):
--   intake.admission_form(school code)       open classes, fees, instructions
--   intake.submit_admission(code, data)      creates an application
--   intake.admission_status(code, number, phone)   their own status
-- Staff: school admins run the workflow; accountants see applications and
-- record the admission fee (approved -> fee_paid) and nothing else.
-- =====================================================================

create type public.admission_status as enum
  ('submitted', 'under_review', 'verified', 'approved', 'rejected', 'fee_paid', 'enrolled');
create type public.admission_document_type as enum
  ('birth_certificate', 'transfer_certificate', 'previous_report_card', 'address_proof', 'parent_id_proof', 'other');

-- ---------- what is open for admission ----------
create table public.admission_windows (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  academic_session_id  uuid not null,
  class_id             uuid not null,
  is_open              boolean not null default false,
  seats                integer check (seats is null or seats between 1 and 5000),
  admission_fee        numeric(12, 2) not null default 0 check (admission_fee >= 0 and admission_fee <= 10000000),
  last_date            date,
  instructions         text check (instructions is null or char_length(instructions) <= 1000),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint admission_windows_one_per_class unique (academic_session_id, class_id),
  constraint admission_windows_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id) on delete cascade,
  constraint admission_windows_class_fkey foreign key (class_id, school_id) references public.classes (id, school_id)
);
create trigger admission_windows_updated_at before update on public.admission_windows for each row execute function private.set_updated_at();
create trigger admission_windows_lock_school before update on public.admission_windows for each row execute function private.prevent_school_change();

-- ---------- applications ----------
create table public.admission_applications (
  id                    uuid primary key default gen_random_uuid(),
  school_id             uuid not null references public.schools (id) on delete cascade,
  academic_session_id   uuid not null,
  class_id              uuid not null,
  application_number    text not null,
  status                public.admission_status not null default 'submitted',
  -- student
  student_name          text not null check (char_length(btrim(student_name)) between 2 and 150),
  date_of_birth         date not null check (date_of_birth > date '1990-01-01' and date_of_birth <= current_date),
  gender                public.gender not null,
  blood_group           text check (blood_group is null or blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  -- parents
  father_name           text check (father_name is null or char_length(btrim(father_name)) between 2 and 150),
  father_phone          text check (father_phone is null or father_phone ~ '^\+?[0-9]{10,15}$'),
  father_occupation     text check (father_occupation is null or char_length(father_occupation) <= 100),
  mother_name           text check (mother_name is null or char_length(btrim(mother_name)) between 2 and 150),
  mother_phone          text check (mother_phone is null or mother_phone ~ '^\+?[0-9]{10,15}$'),
  mother_occupation     text check (mother_occupation is null or char_length(mother_occupation) <= 100),
  contact_phone         text not null check (contact_phone ~ '^\+?[0-9]{10,15}$'),
  contact_email         text check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- address
  address_line          text not null check (char_length(btrim(address_line)) between 5 and 300),
  city                  text not null check (char_length(btrim(city)) between 2 and 80),
  state                 text not null check (char_length(btrim(state)) between 2 and 80),
  postal_code           text not null check (postal_code ~ '^[0-9]{6}$'),
  -- previous school
  previous_school       text check (previous_school is null or char_length(previous_school) <= 200),
  previous_class        text check (previous_class is null or char_length(previous_class) <= 50),
  previous_board        text check (previous_board is null or char_length(previous_board) <= 50),
  -- photo (private admissions bucket)
  photo_path            text,
  -- review
  review_note           text check (review_note is null or char_length(review_note) <= 1000),   -- staff only
  rejection_reason      text check (rejection_reason is null or char_length(rejection_reason) <= 500),  -- shown to the applicant
  status_note           text check (status_note is null or char_length(status_note) <= 500),    -- note for the last status change
  reviewed_by           uuid references auth.users (id) on delete set null,
  reviewed_at           timestamptz,
  verified_by           uuid references auth.users (id) on delete set null,
  verified_at           timestamptz,
  decided_by            uuid references auth.users (id) on delete set null,
  decided_at            timestamptz,
  -- admission fee
  fee_amount            numeric(12, 2) check (fee_amount is null or fee_amount >= 0),
  fee_paid_amount       numeric(12, 2) check (fee_paid_amount is null or fee_paid_amount >= 0),
  fee_payment_mode      public.payment_mode,
  fee_reference         text check (fee_reference is null or char_length(fee_reference) <= 60),
  fee_paid_on           date,
  fee_receipt_number    text,
  fee_recorded_by       uuid references auth.users (id) on delete set null,
  -- the student created from this application
  student_id            uuid,
  enrolled_at           timestamptz,
  enrolled_by           uuid references auth.users (id) on delete set null,
  submitted_at          timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint admission_applications_id_school_key unique (id, school_id),
  constraint admission_applications_number_key unique (school_id, application_number),
  constraint admission_applications_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id),
  constraint admission_applications_class_fkey foreign key (class_id, school_id) references public.classes (id, school_id),
  constraint admission_applications_student_fkey foreign key (student_id, school_id) references public.students (id, school_id),
  constraint admission_applications_one_student unique (student_id),
  constraint admission_applications_fee_receipt_key unique (school_id, fee_receipt_number)
);
create index admission_applications_school_status_idx on public.admission_applications (school_id, status, submitted_at desc);
create index admission_applications_class_idx on public.admission_applications (academic_session_id, class_id, status);
create trigger admission_applications_updated_at before update on public.admission_applications for each row execute function private.set_updated_at();
create trigger admission_applications_lock_school before update on public.admission_applications for each row execute function private.prevent_school_change();

create table public.admission_documents (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools (id) on delete cascade,
  application_id  uuid not null,
  document_type   public.admission_document_type not null,
  file_name       text not null check (char_length(file_name) between 1 and 160),
  mime_type       text not null,
  size_bytes      integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  file_path       text not null unique,
  created_at      timestamptz not null default now(),
  constraint admission_documents_app_fkey foreign key (application_id, school_id)
    references public.admission_applications (id, school_id) on delete cascade
);
create index admission_documents_app_idx on public.admission_documents (application_id);

create table public.admission_events (
  id              bigint generated always as identity primary key,
  school_id       uuid not null references public.schools (id) on delete cascade,
  application_id  uuid not null,
  from_status     public.admission_status,
  to_status       public.admission_status not null,
  note            text,
  actor           uuid references auth.users (id) on delete set null,   -- null = the applicant
  created_at      timestamptz not null default now(),
  constraint admission_events_app_fkey foreign key (application_id, school_id)
    references public.admission_applications (id, school_id) on delete cascade
);
create index admission_events_app_idx on public.admission_events (application_id, id);

-- =====================================================================
-- Workflow guard
-- =====================================================================
create or replace function private.guard_admission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_admin boolean; v_taken int; w record; n bigint; v_fee_cols text[] :=
  array['status', 'status_note', 'fee_paid_amount', 'fee_payment_mode', 'fee_reference', 'fee_paid_on',
        'fee_receipt_number', 'fee_recorded_by', 'updated_at'];
begin
  if new.application_number is distinct from old.application_number or new.submitted_at is distinct from old.submitted_at then
    raise exception 'The application number and submission time can''t be changed.' using errcode = 'check_violation';
  end if;
  if old.status = 'enrolled' then
    raise exception 'This application has been completed (student created) and can''t be changed.' using errcode = 'check_violation';
  end if;
  v_admin := private.is_super_admin() or private.has_school_role(new.school_id, array['school_admin']::public.app_role[]);

  -- accountants: only record the admission fee of an approved application
  if not v_admin then
    if not (old.status = 'approved' and new.status = 'fee_paid')
       or (to_jsonb(new) - v_fee_cols) is distinct from (to_jsonb(old) - v_fee_cols) then
      raise exception 'Only school admins can change applications; accountants can record the admission fee.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.status = old.status then
    -- details may be corrected before the decision; the class only until approval
    if old.status in ('approved', 'fee_paid') and (new.class_id, new.academic_session_id) is distinct from (old.class_id, old.academic_session_id) then
      raise exception 'The class can''t be changed after approval.' using errcode = 'check_violation';
    end if;
    if old.status = 'fee_paid' and (new.fee_paid_amount, new.fee_payment_mode, new.fee_reference, new.fee_paid_on, new.fee_receipt_number)
       is distinct from (old.fee_paid_amount, old.fee_payment_mode, old.fee_reference, old.fee_paid_on, old.fee_receipt_number) then
      raise exception 'A recorded admission fee payment can''t be changed.' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if not (
    (old.status = 'submitted' and new.status in ('under_review', 'rejected')) or
    (old.status = 'under_review' and new.status in ('verified', 'rejected')) or
    (old.status = 'verified' and new.status in ('approved', 'rejected')) or
    (old.status = 'approved' and new.status in ('fee_paid', 'rejected')) or
    (old.status = 'fee_paid' and new.status = 'enrolled') or
    (old.status = 'rejected' and new.status = 'under_review')
  ) then
    raise exception 'An application can''t go from "%" to "%".', replace(old.status::text, '_', ' '), replace(new.status::text, '_', ' ')
      using errcode = 'check_violation';
  end if;

  if new.status = 'under_review' then
    new.reviewed_by := (select auth.uid()); new.reviewed_at := now();
    new.rejection_reason := null;  -- reopening clears an earlier rejection
  elsif new.status = 'verified' then
    new.verified_by := (select auth.uid()); new.verified_at := now();
  elsif new.status = 'rejected' then
    if nullif(btrim(new.rejection_reason), '') is null then
      raise exception 'Give the reason for rejecting (the applicant will see it).' using errcode = 'check_violation';
    end if;
    new.decided_by := (select auth.uid()); new.decided_at := now();
  elsif new.status = 'approved' then
    select * into w from public.admission_windows
    where academic_session_id = new.academic_session_id and class_id = new.class_id;
    if w.seats is not null then
      select count(*) into v_taken from public.admission_applications a
      where a.academic_session_id = new.academic_session_id and a.class_id = new.class_id and a.id <> new.id
        and a.status in ('approved', 'fee_paid', 'enrolled');
      if v_taken >= w.seats then
        raise exception 'All % seats for this class are taken.', w.seats using errcode = 'check_violation';
      end if;
    end if;
    new.fee_amount := coalesce(w.admission_fee, 0);   -- the fee at the time of approval
    new.decided_by := (select auth.uid()); new.decided_at := now();
  elsif new.status = 'fee_paid' then
    if new.fee_paid_amount is distinct from new.fee_amount then
      raise exception 'The admission fee is %; record exactly that amount.', new.fee_amount using errcode = 'check_violation';
    end if;
    if new.fee_amount > 0 and new.fee_payment_mode is null then
      raise exception 'Choose how the fee was paid.' using errcode = 'check_violation';
    end if;
    if new.fee_paid_on is null or new.fee_paid_on > current_date then
      raise exception 'The payment date can''t be empty or in the future.' using errcode = 'check_violation';
    end if;
    insert into private.school_counters as c (school_id, kind, last_value) values (new.school_id, 'admission_receipt', 1)
    on conflict (school_id, kind) do update set last_value = c.last_value + 1 returning last_value into n;
    new.fee_receipt_number := 'ADR-' || lpad(n::text, 5, '0');
    new.fee_recorded_by := (select auth.uid());
  elsif new.status = 'enrolled' then
    if new.student_id is null or not exists (select 1 from public.students s where s.id = new.student_id and s.school_id = new.school_id) then
      raise exception 'Create the student first.' using errcode = 'check_violation';
    end if;
    new.enrolled_by := (select auth.uid()); new.enrolled_at := now();
  end if;
  return new;
end $$;
create trigger admission_applications_guard before update on public.admission_applications
  for each row execute function private.guard_admission();

create or replace function private.log_admission_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.admission_events (school_id, application_id, from_status, to_status, note, actor)
    values (new.school_id, new.id, null, new.status, null, (select auth.uid()));
  elsif new.status is distinct from old.status then
    insert into public.admission_events (school_id, application_id, from_status, to_status, note, actor)
    values (new.school_id, new.id, old.status, new.status,
            coalesce(case when new.status = 'rejected' then new.rejection_reason end, nullif(btrim(new.status_note), '')),
            (select auth.uid()));
  end if;
  return null;
end $$;
create trigger admission_applications_log after insert or update on public.admission_applications
  for each row execute function private.log_admission_event();

-- =====================================================================
-- Public functions (anonymous visitors), in their own schema
-- =====================================================================
create schema if not exists intake;
revoke all on schema intake from public;
grant usage on schema intake to anon, authenticated;
-- The school's admission page: contact details and the classes open for admission.
create or replace function intake.admission_form(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'school', jsonb_build_object('name', s.name, 'code', s.code, 'address', s.address, 'city', s.city, 'state', s.state,
                                 'phone', s.phone, 'email', s.email, 'logo_url', s.logo_url),
    'windows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'window_id', w.id, 'session_id', a.id, 'session_name', a.name, 'class_id', c.id, 'class_name', c.name,
        'admission_fee', w.admission_fee, 'last_date', w.last_date, 'instructions', w.instructions,
        'seats_left', case when w.seats is null then null else greatest(w.seats - (
          select count(*) from public.admission_applications x
          where x.academic_session_id = w.academic_session_id and x.class_id = w.class_id
            and x.status in ('approved', 'fee_paid', 'enrolled')), 0) end
      ) order by a.start_date, c.display_order, c.name)
      from public.admission_windows w
      join public.academic_sessions a on a.id = w.academic_session_id and a.archived_at is null
      join public.classes c on c.id = w.class_id and c.is_active and c.deleted_at is null
      where w.school_id = s.id and w.is_open and (w.last_date is null or w.last_date >= current_date)
    ), '[]'::jsonb)
  )
  from public.schools s
  where upper(s.code) = upper(btrim(p_code)) and s.status = 'active';
$$;

-- Submits an application. p_data holds the form fields (already cleaned by the API)
-- plus photo_path and documents [{type, file_name, mime_type, size_bytes, file_path}].
create or replace function intake.submit_admission(p_code text, p_data jsonb)
returns table (application_id uuid, application_number text)
language plpgsql security definer set search_path = '' as $$
declare s record; w record; v_id uuid; v_number text; n bigint; dup text; d jsonb; v_dob date; v_phone text;
begin
  select id into s from public.schools where upper(code) = upper(btrim(p_code)) and status = 'active';
  if s.id is null then
    raise exception 'This school isn''t accepting applications online.' using errcode = 'P0002';
  end if;
  select w0.*, a.name as session_name, a.start_date, a.archived_at into w
  from public.admission_windows w0 join public.academic_sessions a on a.id = w0.academic_session_id
  join public.classes c on c.id = w0.class_id and c.is_active and c.deleted_at is null
  where w0.id = (p_data->>'window_id')::uuid and w0.school_id = s.id;
  if w.id is null or not w.is_open or w.archived_at is not null or (w.last_date is not null and w.last_date < current_date) then
    raise exception 'Admission to this class is closed.' using errcode = 'check_violation';
  end if;
  v_dob := (p_data->>'date_of_birth')::date;
  v_phone := p_data->>'contact_phone';
  -- one open application per child per class and session
  select x.application_number into dup from public.admission_applications x
  where x.school_id = s.id and x.academic_session_id = w.academic_session_id
    and lower(btrim(x.student_name)) = lower(btrim(p_data->>'student_name')) and x.date_of_birth = v_dob
    and right(x.contact_phone, 10) = right(v_phone, 10) and x.status <> 'rejected'
  limit 1;
  if dup is not null then
    raise exception 'An application for this child is already in progress (%). Use it to check the status.', dup
      using errcode = 'unique_violation';
  end if;
  if jsonb_array_length(coalesce(p_data->'documents', '[]'::jsonb)) > 8 then
    raise exception 'Attach at most 8 documents.' using errcode = 'check_violation';
  end if;

  insert into private.school_counters as c (school_id, kind, last_value)
  values (s.id, 'admission:' || w.academic_session_id, 1)
  on conflict (school_id, kind) do update set last_value = c.last_value + 1 returning last_value into n;
  v_number := 'ADM' || to_char(w.start_date, 'YYYY') || '-' || lpad(n::text, 5, '0');

  insert into public.admission_applications (
    school_id, academic_session_id, class_id, application_number, student_name, date_of_birth, gender, blood_group,
    father_name, father_phone, father_occupation, mother_name, mother_phone, mother_occupation, contact_phone, contact_email,
    address_line, city, state, postal_code, previous_school, previous_class, previous_board, photo_path)
  values (
    s.id, w.academic_session_id, w.class_id, v_number, btrim(p_data->>'student_name'), v_dob, (p_data->>'gender')::public.gender,
    nullif(p_data->>'blood_group', ''),
    nullif(btrim(p_data->>'father_name'), ''), nullif(p_data->>'father_phone', ''), nullif(btrim(p_data->>'father_occupation'), ''),
    nullif(btrim(p_data->>'mother_name'), ''), nullif(p_data->>'mother_phone', ''), nullif(btrim(p_data->>'mother_occupation'), ''),
    v_phone, nullif(lower(btrim(p_data->>'contact_email')), ''),
    btrim(p_data->>'address_line'), btrim(p_data->>'city'), btrim(p_data->>'state'), p_data->>'postal_code',
    nullif(btrim(p_data->>'previous_school'), ''), nullif(btrim(p_data->>'previous_class'), ''), nullif(btrim(p_data->>'previous_board'), ''),
    nullif(p_data->>'photo_path', ''))
  returning id into v_id;

  for d in select * from jsonb_array_elements(coalesce(p_data->'documents', '[]'::jsonb)) loop
    insert into public.admission_documents (school_id, application_id, document_type, file_name, mime_type, size_bytes, file_path)
    values (s.id, v_id, (d->>'type')::public.admission_document_type, d->>'file_name', d->>'mime_type', (d->>'size_bytes')::int, d->>'file_path');
  end loop;
  return query select v_id, v_number;
end $$;

-- An applicant's own status: needs the application number AND the contact mobile.
create or replace function intake.admission_status(p_code text, p_number text, p_phone text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'application_number', x.application_number, 'status', x.status, 'student_name', x.student_name,
    'class_name', c.name, 'session_name', a.name, 'submitted_at', x.submitted_at,
    'rejection_reason', case when x.status = 'rejected' then x.rejection_reason end,
    'fee_amount', x.fee_amount, 'fee_paid_on', x.fee_paid_on, 'fee_receipt_number', x.fee_receipt_number,
    'instructions', w.instructions, 'school_name', s.name, 'school_phone', s.phone, 'school_email', s.email,
    'timeline', (select jsonb_agg(jsonb_build_object('status', e.to_status, 'at', e.created_at,
                   'note', case when e.to_status = 'rejected' then e.note end) order by e.id)
                 from public.admission_events e where e.application_id = x.id)
  )
  from public.admission_applications x
  join public.schools s on s.id = x.school_id and upper(s.code) = upper(btrim(p_code))
  join public.classes c on c.id = x.class_id
  join public.academic_sessions a on a.id = x.academic_session_id
  left join public.admission_windows w on w.academic_session_id = x.academic_session_id and w.class_id = x.class_id
  where upper(x.application_number) = upper(btrim(p_number)) and right(x.contact_phone, 10) = right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 10)
    and length(regexp_replace(p_phone, '[^0-9]', '', 'g')) >= 10;
$$;

revoke all on function intake.admission_form(text), intake.submit_admission(text, jsonb),
  intake.admission_status(text, text, text) from public;
grant execute on function intake.admission_form(text), intake.submit_admission(text, jsonb),
  intake.admission_status(text, text, text) to anon, authenticated;

-- =====================================================================
-- RLS (staff)
-- =====================================================================
revoke all on public.admission_windows, public.admission_applications, public.admission_documents, public.admission_events
  from anon, authenticated;
grant select, insert, update, delete on public.admission_windows to authenticated;
grant select, update on public.admission_applications to authenticated;   -- created only by submit_admission; never deleted
grant select on public.admission_documents, public.admission_events to authenticated;
alter table public.admission_windows enable row level security;
alter table public.admission_applications enable row level security;
alter table public.admission_documents enable row level security;
alter table public.admission_events enable row level security;

create policy admission_windows_select on public.admission_windows for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy admission_windows_write on public.admission_windows for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

create policy admission_applications_select on public.admission_applications for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy admission_applications_update on public.admission_applications for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));

create policy admission_documents_select on public.admission_documents for select to authenticated
  using (exists (select 1 from public.admission_applications x where x.id = application_id));
create policy admission_events_select on public.admission_events for select to authenticated
  using (exists (select 1 from public.admission_applications x where x.id = application_id));

-- ---------- private bucket for application photos and documents ----------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('admission-files', 'admission-files', false, 10485760,
            array['application/pdf', 'image/jpeg', 'image/png'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
