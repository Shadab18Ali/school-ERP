-- =====================================================================
-- Phase 27: document generators — certificates and ID cards
--
--   teachers.staff_type / designation   teaching or non-teaching staff, and their post
--                                       (for Teacher ID vs Staff ID cards)
--   document_settings        per school: principal's name and title, signature image, place,
--                            accent colour, ID card validity and the note on a card's back
--   certificate_templates    the school's certificates: bonafide, character, transfer, study,
--                            custom — a title, a number prefix and wording with {{placeholders}},
--                            plus any extra fields asked for when issuing (e.g. date of leaving)
--   certificates             each issued certificate: a number (TC-2026-0001), the wording as
--                            issued (filled from the student's record when issued, then fixed),
--                            the signatory, and a random token for the QR verification page;
--                            never edited or deleted — revoked with a reason instead
--   id_cards                 a student's / teacher's / staff member's card: card number, valid
--                            until, a verification token; one valid card per person (a reissue
--                            replaces the old card, which then shows as replaced when scanned)
--
-- Certificates are filled in here, from the database's own records — the browser never
-- supplies a student's details. Anyone can check a document by scanning its QR code
-- (intake.verify_document), which returns only what is needed to confirm it is genuine.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Staff records: teaching or not, and their post
-- ---------------------------------------------------------------------
alter table public.teachers add column staff_type text not null default 'teaching' check (staff_type in ('teaching', 'non_teaching'));
alter table public.teachers add column designation text check (designation is null or char_length(btrim(designation)) between 2 and 60);

create or replace function private.is_documents_admin(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[]);
$$;

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------
create table public.document_settings (
  school_id         uuid primary key references public.schools (id) on delete cascade,
  principal_name    text check (principal_name is null or char_length(btrim(principal_name)) between 2 and 100),
  signatory_title   text not null default 'Principal' check (char_length(btrim(signatory_title)) between 2 and 40),
  signature_path    text check (signature_path is null or signature_path like school_id::text || '/signatures/%'),
  place             text check (place is null or char_length(btrim(place)) between 2 and 60),
  accent_color      text not null default '#2f6b57' check (accent_color ~ '^#[0-9a-f]{6}$'),
  card_valid_until  date,                       -- null = the end of the current session
  card_back_note    text check (card_back_note is null or char_length(card_back_note) <= 200),
  updated_at        timestamptz not null default now()
);
create trigger document_settings_updated_at before update on public.document_settings for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- Words for dates on certificates ("Fifth May Two Thousand Fifteen")
-- ---------------------------------------------------------------------
create or replace function private.number_words(n integer)
returns text language plpgsql immutable set search_path = '' as $$
declare
  ones text[] := array['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
                       'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  tens text[] := array['', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  out text := '';
begin
  if n is null or n < 0 or n > 9999 then return null; end if;
  if n = 0 then return 'Zero'; end if;
  if n >= 1000 then out := ones[n / 1000] || ' Thousand'; n := n % 1000; end if;
  if n >= 100 then out := out || case when out = '' then '' else ' ' end || ones[n / 100] || ' Hundred'; n := n % 100; end if;
  if n > 0 then
    out := out || case when out = '' then '' else ' ' end
      || case when n < 20 then ones[n] else tens[n / 10] || case when n % 10 > 0 then '-' || ones[n % 10] else '' end end;
  end if;
  return out;
end $$;

create or replace function private.date_words(d date)
returns text language plpgsql immutable set search_path = '' as $$
declare
  ord text[] := array['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh',
                      'Twelfth', 'Thirteenth', 'Fourteenth', 'Fifteenth', 'Sixteenth', 'Seventeenth', 'Eighteenth', 'Nineteenth',
                      'Twentieth', 'Twenty-First', 'Twenty-Second', 'Twenty-Third', 'Twenty-Fourth', 'Twenty-Fifth', 'Twenty-Sixth',
                      'Twenty-Seventh', 'Twenty-Eighth', 'Twenty-Ninth', 'Thirtieth', 'Thirty-First'];
begin
  if d is null then return null; end if;
  return ord[extract(day from d)::int] || ' ' || to_char(d, 'FMMonth') || ' ' || private.number_words(extract(year from d)::int);
end $$;

-- ---------------------------------------------------------------------
-- Certificate templates
-- ---------------------------------------------------------------------
-- every placeholder a certificate can use (besides a template's own extra fields)
create or replace function private.certificate_placeholders()
returns text[] language sql immutable set search_path = '' as $$
  select array[
    'student_name', 'father_name', 'mother_name', 'parent_name', 'gender', 'son_daughter', 'he_she', 'he_she_cap', 'his_her', 'his_her_cap',
    'him_her', 'date_of_birth', 'date_of_birth_words', 'student_code', 'admission_number', 'admission_date', 'first_admission_date',
    'first_class', 'class_name', 'section_name', 'class_section', 'session_name', 'session_start', 'session_end', 'address',
    'school_name', 'school_address', 'place', 'affiliation', 'issue_date', 'certificate_number', 'purpose', 'principal_name',
    'signatory_title']::text[];
$$;

create table public.certificate_templates (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  kind        text not null check (kind in ('bonafide', 'character', 'transfer', 'study', 'custom')),
  name        text not null check (char_length(btrim(name)) between 2 and 60),
  title       text not null check (char_length(btrim(title)) between 2 and 80),
  prefix      text not null check (prefix ~ '^[A-Z]{1,6}$'),
  body        text not null check (char_length(btrim(body)) between 10 and 5000),
  fields      jsonb not null default '[]',      -- [{key, label, type: text|date, required}]
  show_logo   boolean not null default true,
  show_photo  boolean not null default false,
  show_qr     boolean not null default true,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint certificate_templates_id_school_key unique (id, school_id)
);
create unique index certificate_templates_name_key on public.certificate_templates (school_id, lower(btrim(name)));
create trigger certificate_templates_updated_at before update on public.certificate_templates for each row execute function private.set_updated_at();
create trigger certificate_templates_school_guard before update on public.certificate_templates for each row execute function private.prevent_school_change();

-- tidy the wording and check every {{placeholder}} is known; check the extra fields
create or replace function private.certificate_template_check() returns trigger language plpgsql security definer set search_path = '' as $$
declare f jsonb; keys text[] := '{}'; k text; m text[];
begin
  new.name := btrim(new.name);
  new.title := btrim(new.title);
  new.body := regexp_replace(btrim(new.body), '\{\{\s*([A-Za-z0-9_]+)\s*\}\}', '{{\1}}', 'g');
  if jsonb_typeof(new.fields) <> 'array' or jsonb_array_length(new.fields) > 12 then
    raise exception 'At most 12 extra fields.' using errcode = 'check_violation';
  end if;
  for f in select * from jsonb_array_elements(new.fields) loop
    k := f ->> 'key';
    if k is null or k !~ '^[a-z][a-z0-9_]{1,29}$' then
      raise exception 'An extra field''s key is lower-case letters, digits and _ (e.g. leaving_date).' using errcode = 'check_violation';
    end if;
    if k = any (private.certificate_placeholders()) or k = any (keys) then
      raise exception 'The extra field {{%}} is already used. Choose another key.', k using errcode = 'check_violation';
    end if;
    if char_length(btrim(coalesce(f ->> 'label', ''))) not between 2 and 60 then
      raise exception 'Give the extra field {{%}} a label.', k using errcode = 'check_violation';
    end if;
    if coalesce(f ->> 'type', 'text') not in ('text', 'date') then
      raise exception 'An extra field is text or a date.' using errcode = 'check_violation';
    end if;
    keys := keys || k;
  end loop;
  for m in select regexp_matches(new.body, '\{\{([A-Za-z0-9_]+)\}\}', 'g') loop
    if not (m[1] = any (private.certificate_placeholders()) or m[1] = any (keys)) then
      raise exception 'Unknown placeholder {{%}}. Use one from the list, or add it as an extra field.', m[1] using errcode = 'check_violation';
    end if;
  end loop;
  if new.body ~ '\{\{|\}\}' and regexp_replace(new.body, '\{\{[A-Za-z0-9_]+\}\}', '', 'g') ~ '\{\{|\}\}' then
    raise exception 'A placeholder isn''t closed: write it as {{name}}.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger certificate_templates_check before insert or update on public.certificate_templates
  for each row execute function private.certificate_template_check();

-- ---------------------------------------------------------------------
-- Issued certificates
-- ---------------------------------------------------------------------
create table public.certificates (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  template_id          uuid not null,
  kind                 text not null check (kind in ('bonafide', 'character', 'transfer', 'study', 'custom')),
  student_id           uuid not null,
  academic_session_id  uuid,
  certificate_number   text not null,
  title                text not null,
  body                 text not null,
  field_values         jsonb not null,                -- every value the wording used, as issued
  purpose              text check (purpose is null or char_length(btrim(purpose)) between 2 and 200),
  issued_on            date not null,
  signatory_name       text,
  signatory_title      text not null,
  signature_path       text,
  place                text,
  show_logo            boolean not null,
  show_photo           boolean not null,
  show_qr              boolean not null,
  verify_token         text not null check (verify_token ~ '^[0-9a-f]{32}$'),
  status               text not null default 'issued' check (status in ('issued', 'revoked')),
  revoked_at           timestamptz,
  revoked_by           uuid references auth.users (id) on delete set null,
  revoke_reason        text check (revoke_reason is null or char_length(btrim(revoke_reason)) between 3 and 300),
  issued_by            uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  constraint certificates_id_school_key unique (id, school_id),
  constraint certificates_template_fkey foreign key (template_id, school_id) references public.certificate_templates (id, school_id),
  constraint certificates_student_fkey foreign key (student_id, school_id) references public.students (id, school_id),
  constraint certificates_session_fkey foreign key (academic_session_id, school_id) references public.academic_sessions (id, school_id),
  constraint certificates_revoked check ((status = 'revoked') = (revoked_at is not null and revoke_reason is not null))
);
create unique index certificates_number_key on public.certificates (school_id, certificate_number);
create unique index certificates_token_key on public.certificates (verify_token);
-- a student can hold only one valid transfer certificate
create unique index certificates_one_tc on public.certificates (student_id) where kind = 'transfer' and status = 'issued';
create index certificates_school_idx on public.certificates (school_id, issued_on desc, created_at desc);
create index certificates_student_idx on public.certificates (student_id);

-- an issued certificate is final: only revoking it is allowed; it is never deleted
create or replace function private.certificate_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.schools s where s.id = old.school_id) and current_setting('docs.allow_delete', true) is distinct from 'on' then
      raise exception 'Issued certificates are kept for the record. Revoke it instead.' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status = 'revoked' then raise exception 'This certificate is already revoked.' using errcode = 'check_violation'; end if;
  if (to_jsonb(new) - array['status', 'revoked_at', 'revoked_by', 'revoke_reason']) <> (to_jsonb(old) - array['status', 'revoked_at', 'revoked_by', 'revoke_reason']) then
    raise exception 'An issued certificate can''t be changed. Revoke it and issue a new one.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger certificates_guard before update or delete on public.certificates for each row execute function private.certificate_guard();

-- Fill in a certificate: every value comes from the database (the student, their enrollment, the school,
-- the settings) except the template's own extra fields and the purpose.
create or replace function private.certificate_render(
  p_template uuid, p_student uuid, p_session uuid, p_issued_on date, p_purpose text, p_extra jsonb, p_number text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  t public.certificate_templates; s public.students; e record; first_e record; sess public.academic_sessions; sch public.schools;
  ds public.document_settings; v jsonb; f jsonb; k text; val text; body text; title text; m text[];
  labels jsonb := jsonb_build_object('father_name', 'father''s name', 'mother_name', 'mother''s name', 'address', 'address',
    'class_name', 'class', 'section_name', 'section', 'class_section', 'class', 'admission_number', 'admission number',
    'admission_date', 'admission date', 'place', 'place (Documents → Settings)', 'principal_name', 'principal''s name (Documents → Settings)',
    'purpose', 'purpose', 'affiliation', 'affiliation (School settings)', 'school_address', 'school address (School settings)');
begin
  select * into t from public.certificate_templates where id = p_template;
  if not found then raise exception 'Certificate template not found.' using errcode = 'P0002'; end if;
  select * into s from public.students where id = p_student and school_id = t.school_id;
  if not found then raise exception 'Student not found.' using errcode = 'P0002'; end if;
  select * into sch from public.schools where id = t.school_id;
  select * into ds from public.document_settings where school_id = t.school_id;
  if p_session is not null then
    select * into sess from public.academic_sessions where id = p_session and school_id = t.school_id;
    if not found then raise exception 'Academic session not found.' using errcode = 'P0002'; end if;
  else
    select * into sess from public.academic_sessions where school_id = t.school_id and is_current;
  end if;
  select en.admission_number, en.admission_date, c.name as class_name, sec.name as section_name into e
  from public.student_enrollments en join public.classes c on c.id = en.class_id join public.sections sec on sec.id = en.section_id
  where en.student_id = s.id and en.academic_session_id = sess.id;
  select en.admission_date, c.name as class_name into first_e
  from public.student_enrollments en join public.classes c on c.id = en.class_id join public.academic_sessions a on a.id = en.academic_session_id
  where en.student_id = s.id order by a.start_date, en.admission_date limit 1;

  v := jsonb_build_object(
    'student_name', s.full_name, 'father_name', nullif(btrim(s.father_name), ''), 'mother_name', nullif(btrim(s.mother_name), ''),
    'parent_name', coalesce(nullif(btrim(s.father_name), ''), nullif(btrim(s.mother_name), '')),
    'gender', initcap(s.gender::text),
    'son_daughter', case s.gender when 'male' then 'son' when 'female' then 'daughter' else 'child' end,
    'he_she', case s.gender when 'male' then 'he' when 'female' then 'she' else 'they' end,
    'he_she_cap', case s.gender when 'male' then 'He' when 'female' then 'She' else 'They' end,
    'his_her', case s.gender when 'male' then 'his' when 'female' then 'her' else 'their' end,
    'his_her_cap', case s.gender when 'male' then 'His' when 'female' then 'Her' else 'Their' end,
    'him_her', case s.gender when 'male' then 'him' when 'female' then 'her' else 'them' end,
    'date_of_birth', to_char(s.date_of_birth, 'FMDD FMMonth YYYY'), 'date_of_birth_words', private.date_words(s.date_of_birth),
    'student_code', s.student_code, 'address', nullif(btrim(s.address), ''),
    'admission_number', e.admission_number, 'admission_date', to_char(e.admission_date, 'FMDD FMMonth YYYY'),
    'first_admission_date', to_char(first_e.admission_date, 'FMDD FMMonth YYYY'), 'first_class', first_e.class_name,
    'class_name', e.class_name, 'section_name', e.section_name,
    'class_section', case when e.class_name is null then null else e.class_name || ' – ' || e.section_name end,
    'session_name', sess.name, 'session_start', to_char(sess.start_date, 'FMDD FMMonth YYYY'), 'session_end', to_char(sess.end_date, 'FMDD FMMonth YYYY'),
    'school_name', sch.name,
    'school_address', nullif(concat_ws(', ', nullif(btrim(sch.address), ''), nullif(btrim(sch.city), ''), nullif(btrim(sch.state), ''), nullif(btrim(sch.postal_code), '')), ''),
    'place', coalesce(nullif(btrim(ds.place), ''), nullif(btrim(sch.city), '')),
    'affiliation', case when sch.affiliation_board is not null and sch.affiliation_number is not null
                        then sch.affiliation_board || ' affiliation no. ' || sch.affiliation_number else sch.affiliation_board end,
    'issue_date', to_char(p_issued_on, 'FMDD FMMonth YYYY'), 'certificate_number', p_number,
    'purpose', nullif(btrim(p_purpose), ''), 'principal_name', nullif(btrim(ds.principal_name), ''),
    'signatory_title', coalesce(ds.signatory_title, 'Principal'));

  -- the template's own fields
  for f in select * from jsonb_array_elements(t.fields) loop
    k := f ->> 'key';
    val := nullif(btrim(coalesce(p_extra ->> k, '')), '');
    if val is not null and coalesce(f ->> 'type', 'text') = 'date' then
      begin val := to_char(val::date, 'FMDD FMMonth YYYY');
      exception when others then raise exception '% must be a date.', f ->> 'label' using errcode = 'check_violation'; end;
    end if;
    if val is not null and char_length(val) > 300 then raise exception '% is too long (300 characters at most).', f ->> 'label' using errcode = 'check_violation'; end if;
    if val is null and coalesce((f ->> 'required')::boolean, false) then
      raise exception 'Fill in “%”.', f ->> 'label' using errcode = 'check_violation';
    end if;
    labels := labels || jsonb_build_object(k, f ->> 'label');
    v := v || jsonb_build_object(k, val);
  end loop;

  -- an optional extra field left blank drops the line that uses it ("Conduct: …" simply isn't printed)
  body := t.body; title := t.title;
  for f in select * from jsonb_array_elements(t.fields) loop
    if v ->> (f ->> 'key') is null and not coalesce((f ->> 'required')::boolean, false) then
      body := btrim(regexp_replace(body, '[^\n]*\{\{' || (f ->> 'key') || '\}\}[^\n]*(\n|$)', '', 'g'), E'\n');
    end if;
  end loop;

  -- every placeholder the wording uses must have a value
  for m in select distinct regexp_matches(body || ' ' || title,'\{\{([A-Za-z0-9_]+)\}\}', 'g') loop
    if v ->> m[1] is null then
      if m[1] in ('class_name', 'section_name', 'class_section', 'admission_number', 'admission_date') then
        raise exception '% isn''t enrolled in %, which this certificate needs (the class).', s.full_name, coalesce(sess.name, 'a session')
          using errcode = 'check_violation';
      end if;
      raise exception 'This certificate uses the %, which isn''t recorded. Add it first.', coalesce(labels ->> m[1], replace(m[1], '_', ' '))
        using errcode = 'check_violation';
    end if;
    body := replace(body, '{{' || m[1] || '}}', v ->> m[1]);
    title := replace(title, '{{' || m[1] || '}}', v ->> m[1]);
  end loop;
  return jsonb_build_object('title', title, 'body', body, 'values', jsonb_strip_nulls(v), 'session_id', sess.id, 'kind', t.kind,
    'school_id', t.school_id, 'prefix', t.prefix, 'student_status', s.status, 'student_name', s.full_name);
end $$;

create or replace function private.certificate_preview(
  p_template uuid, p_student uuid, p_session uuid, p_issued_on date, p_purpose text, p_extra jsonb
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t public.certificate_templates;
begin
  select * into t from public.certificate_templates where id = p_template;
  if not found or not private.is_documents_admin(t.school_id) then raise exception 'Certificate template not found.' using errcode = 'P0002'; end if;
  return private.certificate_render(p_template, p_student, p_session, coalesce(p_issued_on, private.ist_today()), p_purpose, p_extra,
    t.prefix || '-' || extract(year from coalesce(p_issued_on, private.ist_today()))::int || '-…');
end $$;

create or replace function private.certificate_issue(
  p_template uuid, p_student uuid, p_session uuid, p_issued_on date, p_purpose text, p_extra jsonb, p_mark_left boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare t public.certificate_templates; r jsonb; v_number text; v_year int; v_id uuid; ds public.document_settings; v_existing text;
begin
  select * into t from public.certificate_templates where id = p_template;
  if not found or not private.is_documents_admin(t.school_id) then raise exception 'Certificate template not found.' using errcode = 'P0002'; end if;
  if not t.is_active then raise exception 'This certificate template isn''t in use.' using errcode = 'check_violation'; end if;
  if p_issued_on is null or p_issued_on > private.ist_today() then
    raise exception 'The issue date can''t be in the future.' using errcode = 'check_violation';
  end if;
  if p_issued_on < private.ist_today() - 366 then
    raise exception 'The issue date can be at most a year back.' using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtext('certificate:' || p_student::text));
  -- a bonafide certificate says the student studies here now; the others (TC, character, study) also suit former students
  if t.kind = 'bonafide' and exists (select 1 from public.students where id = p_student and status <> 'active') then
    raise exception 'This student isn''t active, so a bonafide certificate can''t be issued.' using errcode = 'check_violation';
  end if;
  if t.kind = 'transfer' then
    select certificate_number into v_existing from public.certificates where student_id = p_student and kind = 'transfer' and status = 'issued';
    if found then
      raise exception 'A transfer certificate (%) has already been issued to this student. Revoke it before issuing another.', v_existing
        using errcode = 'check_violation';
    end if;
  end if;
  -- a refusal while filling it in aborts the whole call, so the counter isn't used up
  v_year := extract(year from p_issued_on)::int;
  v_number := t.prefix || '-' || v_year || '-' || lpad(private.next_counter(t.school_id, 'certificate:' || t.prefix || ':' || v_year)::text, 4, '0');
  r := private.certificate_render(p_template, p_student, p_session, p_issued_on, p_purpose, p_extra, v_number);
  select * into ds from public.document_settings where school_id = t.school_id;
  insert into public.certificates (school_id, template_id, kind, student_id, academic_session_id, certificate_number, title, body, field_values,
    purpose, issued_on, signatory_name, signatory_title, signature_path, place, show_logo, show_photo, show_qr, verify_token, issued_by)
  values (t.school_id, t.id, t.kind, p_student, (r ->> 'session_id')::uuid, v_number, r ->> 'title', r ->> 'body', r -> 'values',
    nullif(btrim(p_purpose), ''), p_issued_on, nullif(btrim(ds.principal_name), ''), coalesce(ds.signatory_title, 'Principal'), ds.signature_path,
    r -> 'values' ->> 'place', t.show_logo, t.show_photo, t.show_qr, replace(gen_random_uuid()::text, '-', ''), auth.uid())
  returning id into v_id;
  -- a transfer certificate can mark the student as having left
  if t.kind = 'transfer' and coalesce(p_mark_left, false) then
    update public.students set status = 'inactive', status_reason = left('Left the school: transfer certificate ' || v_number || ' issued', 200)
    where id = p_student and status = 'active';
  end if;
  return v_id;
end $$;

create or replace function private.certificate_revoke(p_certificate uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.certificates;
begin
  select * into c from public.certificates where id = p_certificate for update;
  if not found or not private.is_documents_admin(c.school_id) then raise exception 'Certificate not found.' using errcode = 'P0002'; end if;
  if c.status = 'revoked' then raise exception 'This certificate is already revoked.' using errcode = 'check_violation'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give the reason for revoking.' using errcode = 'check_violation'; end if;
  update public.certificates set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_reason = btrim(p_reason) where id = c.id;
end $$;

-- ---------------------------------------------------------------------
-- ID cards
-- ---------------------------------------------------------------------
create table public.id_cards (
  id                  uuid primary key default gen_random_uuid(),
  school_id           uuid not null references public.schools (id) on delete cascade,
  holder_kind         text not null check (holder_kind in ('student', 'teacher', 'staff')),
  student_id          uuid,
  teacher_id          uuid,
  transport_staff_id  uuid,
  card_number         text not null check (char_length(card_number) between 1 and 30),
  valid_until         date not null,
  verify_token        text not null check (verify_token ~ '^[0-9a-f]{32}$'),
  status              text not null default 'active' check (status in ('active', 'replaced', 'revoked')),
  issued_on           date not null,
  issued_by           uuid references auth.users (id) on delete set null,
  revoked_at          timestamptz,
  revoke_reason       text check (revoke_reason is null or char_length(btrim(revoke_reason)) between 3 and 300),
  created_at          timestamptz not null default now(),
  constraint id_cards_id_school_key unique (id, school_id),
  constraint id_cards_student_fkey foreign key (student_id, school_id) references public.students (id, school_id) on delete cascade,
  constraint id_cards_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id) on delete cascade,
  constraint id_cards_transport_fkey foreign key (transport_staff_id, school_id) references public.transport_staff (id, school_id) on delete cascade,
  constraint id_cards_one_holder check (num_nonnulls(student_id, teacher_id, transport_staff_id) = 1),
  constraint id_cards_kind_matches check (
    (holder_kind = 'student' and student_id is not null) or (holder_kind = 'teacher' and teacher_id is not null)
    or (holder_kind = 'staff' and student_id is null)),
  constraint id_cards_revoked check ((status = 'revoked') = (revoke_reason is not null))
);
create unique index id_cards_token_key on public.id_cards (verify_token);
-- one valid card per person
create unique index id_cards_one_active on public.id_cards (coalesce(student_id, teacher_id, transport_staff_id)) where status = 'active';
create index id_cards_school_idx on public.id_cards (school_id, holder_kind, status);

create or replace function private.id_card_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.schools s where s.id = old.school_id)
       and (old.student_id is null or exists (select 1 from public.students x where x.id = old.student_id))
       and (old.teacher_id is null or exists (select 1 from public.teachers x where x.id = old.teacher_id))
       and (old.transport_staff_id is null or exists (select 1 from public.transport_staff x where x.id = old.transport_staff_id))
       and current_setting('docs.allow_delete', true) is distinct from 'on' then
      raise exception 'Issued ID cards are kept for the record. Revoke the card instead.' using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status <> 'active' then raise exception 'This card is no longer valid and can''t change.' using errcode = 'check_violation'; end if;
  if (to_jsonb(new) - array['status', 'revoked_at', 'revoke_reason']) <> (to_jsonb(old) - array['status', 'revoked_at', 'revoke_reason']) then
    raise exception 'An issued ID card can''t be changed. Issue a new card.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger id_cards_guard before update or delete on public.id_cards for each row execute function private.id_card_guard();

-- Issue (or reuse) a card for each person. p_replace: the old card stops being valid (lost, new session).
create or replace function private.id_card_issue(p_school uuid, p_kind text, p_ids uuid[], p_valid_until date, p_replace boolean)
returns setof uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; holder uuid; existing public.id_cards; v_number text; v_card uuid; v_transport boolean;
begin
  if not private.is_documents_admin(p_school) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  if p_kind not in ('student', 'teacher', 'staff') then raise exception 'Choose student, teacher or staff cards.' using errcode = 'check_violation'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 500 then
    raise exception 'Choose between 1 and 500 people.' using errcode = 'check_violation';
  end if;
  if p_valid_until is null or p_valid_until < private.ist_today() or p_valid_until > private.ist_today() + 1830 then
    raise exception 'Valid until must be from today up to five years ahead.' using errcode = 'check_violation';
  end if;
  foreach holder in array p_ids loop
    v_transport := false;
    if p_kind = 'student' then
      select student_code into v_number from public.students where id = holder and school_id = p_school and status = 'active';
      if not found then raise exception 'Only active students of this school get ID cards.' using errcode = 'check_violation'; end if;
    elsif exists (select 1 from public.teachers where id = holder and school_id = p_school) then
      select employee_id into v_number from public.teachers where id = holder and school_id = p_school and status = 'active'
        and staff_type = case p_kind when 'teacher' then 'teaching' else 'non_teaching' end;
      if not found then
        raise exception 'Teacher cards are for active teaching staff, staff cards for active non-teaching staff (set on the Teachers page).'
          using errcode = 'check_violation';
      end if;
    elsif p_kind = 'staff' and exists (select 1 from public.transport_staff where id = holder and school_id = p_school and status = 'active') then
      v_transport := true;
      -- drivers and attendants have no staff number: their first card gets one, later cards keep it
      select card_number into v_number from public.id_cards where transport_staff_id = holder order by created_at limit 1;
      if v_number is null then
        v_number := 'T-' || lpad(private.next_counter(p_school, 'transport_staff_card')::text, 4, '0');
      end if;
    else
      raise exception 'Person not found in this school, or not active.' using errcode = 'check_violation';
    end if;
    perform pg_advisory_xact_lock(hashtext('id_card:' || holder::text));
    select * into existing from public.id_cards where coalesce(student_id, teacher_id, transport_staff_id) = holder and status = 'active';
    if found and not coalesce(p_replace, false) then
      v_card := existing.id;            -- a reprint of the valid card
    else
      if found then update public.id_cards set status = 'replaced' where id = existing.id; end if;
      insert into public.id_cards (school_id, holder_kind, student_id, teacher_id, transport_staff_id, card_number, valid_until, verify_token,
                                   issued_on, issued_by)
      values (p_school, p_kind, case when p_kind = 'student' then holder end, case when p_kind <> 'student' and not v_transport then holder end,
              case when v_transport then holder end, v_number, p_valid_until, replace(gen_random_uuid()::text, '-', ''), private.ist_today(), auth.uid())
      returning id into v_card;
    end if;
    return next v_card;
  end loop;
end $$;

create or replace function private.id_card_revoke(p_card uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.id_cards;
begin
  select * into c from public.id_cards where id = p_card for update;
  if not found or not private.is_documents_admin(c.school_id) then raise exception 'ID card not found.' using errcode = 'P0002'; end if;
  if c.status <> 'active' then raise exception 'This card is no longer valid.' using errcode = 'check_violation'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give the reason (e.g. lost).' using errcode = 'check_violation'; end if;
  update public.id_cards set status = 'revoked', revoked_at = now(), revoke_reason = btrim(p_reason) where id = c.id;
end $$;

-- ---------------------------------------------------------------------
-- Public verification (QR codes): only what is needed to confirm a document
-- ---------------------------------------------------------------------
create or replace function intake.verify_document(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record; k record;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return null; end if;
  select x.kind, x.title, x.certificate_number, x.issued_on, x.status, x.revoked_at, x.field_values ->> 'class_section' as class_section,
         s.full_name, sch.name as school_name, sch.city
    into c
  from public.certificates x join public.students s on s.id = x.student_id join public.schools sch on sch.id = x.school_id
  where x.verify_token = p_token;
  if found then
    return jsonb_build_object('type', 'certificate', 'kind', c.kind, 'title', c.title, 'number', c.certificate_number,
      'name', c.full_name, 'detail', c.class_section, 'issued_on', c.issued_on, 'school', c.school_name, 'city', c.city,
      'status', case when c.status = 'revoked' then 'revoked' else 'valid' end, 'revoked_on', (c.revoked_at at time zone 'Asia/Kolkata')::date);
  end if;
  select x.holder_kind, x.card_number, x.valid_until, x.status, x.issued_on,
         coalesce(s.full_name, t.full_name, ts.full_name) as full_name,
         case when x.student_id is not null then (select c2.name || ' – ' || sec.name from public.student_enrollments en
                    join public.classes c2 on c2.id = en.class_id join public.sections sec on sec.id = en.section_id
                    join public.academic_sessions a on a.id = en.academic_session_id
                    where en.student_id = x.student_id and a.is_current limit 1)
              when x.teacher_id is not null then coalesce(t.designation, case t.staff_type when 'teaching' then 'Teacher' else 'Staff' end)
              else initcap(ts.role) end as detail,
         sch.name as school_name, sch.city
    into k
  from public.id_cards x join public.schools sch on sch.id = x.school_id
  left join public.students s on s.id = x.student_id
  left join public.teachers t on t.id = x.teacher_id
  left join public.transport_staff ts on ts.id = x.transport_staff_id
  where x.verify_token = p_token;
  if found then
    return jsonb_build_object('type', 'id_card', 'kind', k.holder_kind, 'number', k.card_number, 'name', k.full_name, 'detail', k.detail,
      'issued_on', k.issued_on, 'valid_until', k.valid_until, 'school', k.school_name, 'city', k.city,
      'status', case when k.status <> 'active' then k.status when k.valid_until < private.ist_today() then 'expired' else 'valid' end);
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------
-- Access: school admins only (plus the public verification function)
-- ---------------------------------------------------------------------
revoke all on public.document_settings, public.certificate_templates, public.certificates, public.id_cards from anon, authenticated;
grant select, insert, update on public.document_settings to authenticated;
grant select, insert, update, delete on public.certificate_templates to authenticated;
grant select on public.certificates, public.id_cards to authenticated;
-- certificates and cards are written only by the functions above

alter table public.document_settings enable row level security;
alter table public.certificate_templates enable row level security;
alter table public.certificates enable row level security;
alter table public.id_cards enable row level security;
create policy document_settings_all on public.document_settings for all to authenticated
  using (private.is_documents_admin(school_id)) with check (private.is_documents_admin(school_id));
create policy certificate_templates_all on public.certificate_templates for all to authenticated
  using (private.is_documents_admin(school_id)) with check (private.is_documents_admin(school_id));
create policy certificates_select on public.certificates for select to authenticated using (private.is_documents_admin(school_id));
create policy id_cards_select on public.id_cards for select to authenticated using (private.is_documents_admin(school_id));

-- a template that has issued certificates is kept (switch it off instead)
create or replace function private.certificate_template_delete_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.certificates c where c.template_id = old.id) and exists (select 1 from public.schools s where s.id = old.school_id)
     and current_setting('docs.allow_delete', true) is distinct from 'on' then
    raise exception 'Certificates have been issued from this template, so it is kept. Mark it not in use instead.' using errcode = 'foreign_key_violation';
  end if;
  return old;
end $$;
create trigger certificate_templates_delete_guard before delete on public.certificate_templates
  for each row execute function private.certificate_template_delete_guard();

revoke all on function private.is_documents_admin(uuid), private.number_words(integer), private.date_words(date), private.certificate_placeholders(),
  private.certificate_render(uuid, uuid, uuid, date, text, jsonb, text), private.certificate_preview(uuid, uuid, uuid, date, text, jsonb),
  private.certificate_issue(uuid, uuid, uuid, date, text, jsonb, boolean), private.certificate_revoke(uuid, text),
  private.id_card_issue(uuid, text, uuid[], date, boolean), private.id_card_revoke(uuid, text), intake.verify_document(text)
  from public, anon, authenticated;
grant execute on function private.is_documents_admin(uuid), private.number_words(integer), private.date_words(date), private.certificate_placeholders(),
  private.certificate_preview(uuid, uuid, uuid, date, text, jsonb), private.certificate_issue(uuid, uuid, uuid, date, text, jsonb, boolean),
  private.certificate_revoke(uuid, text), private.id_card_issue(uuid, text, uuid[], date, boolean), private.id_card_revoke(uuid, text)
  to authenticated;
grant execute on function intake.verify_document(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Private bucket for signatures (server only)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('document-assets', 'document-assets', false, 2097152, array['image/png'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
