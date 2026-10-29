-- =====================================================================
-- Phase 7: student documents
--   * metadata in public.student_documents, files in the PRIVATE
--     student-documents bucket
--   * files are never handed to browsers as URLs (public or signed): the API
--     checks the caller and streams the bytes itself
--   * only school admins (and the platform super admin) can see or manage
--     documents. Teachers and accountants can see students but NOT their documents.
-- =====================================================================

create type public.student_document_type as enum (
  'birth_certificate', 'previous_marksheet', 'transfer_certificate',
  'address_proof', 'student_id_document', 'other'
);

create table public.student_documents (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  student_id     uuid not null,
  document_type  public.student_document_type not null,
  title          text check (title is null or char_length(btrim(title)) between 1 and 120),
  file_path      text not null unique,
  file_name      text not null check (char_length(file_name) between 1 and 150),
  mime_type      text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes     integer not null check (size_bytes between 1 and 10485760),
  uploaded_by    uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint student_documents_student_fkey foreign key (student_id, school_id)
    references public.students (id, school_id) on delete cascade,
  -- "Other documents" must say what they are
  constraint student_documents_other_needs_title
    check (document_type <> 'other' or coalesce(btrim(title), '') <> ''),
  -- files live under their own school's and student's folder
  constraint student_documents_path_scoped
    check (file_path like school_id::text || '/' || student_id::text || '/%')
);

create index student_documents_student_idx on public.student_documents (student_id, created_at desc);
create index student_documents_school_idx on public.student_documents (school_id);

create trigger student_documents_updated_at before update on public.student_documents
  for each row execute function private.set_updated_at();
create trigger student_documents_lock_school before update on public.student_documents
  for each row execute function private.prevent_school_change();

-- The stored file can't be swapped out from under a record.
create or replace function private.lock_document_file()
returns trigger language plpgsql as $$
begin
  if (new.file_path, new.file_name, new.mime_type, new.size_bytes, new.student_id)
     is distinct from (old.file_path, old.file_name, old.mime_type, old.size_bytes, old.student_id) then
    raise exception 'A document''s file cannot be replaced. Upload a new document instead.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger student_documents_lock_file before update on public.student_documents
  for each row execute function private.lock_document_file();

-- ---------- grants & RLS: school admins only ----------
revoke all on public.student_documents from anon;
grant select, insert, update, delete on public.student_documents to authenticated;
alter table public.student_documents enable row level security;

create policy student_documents_select on public.student_documents for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy student_documents_insert on public.student_documents for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy student_documents_update on public.student_documents for update to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy student_documents_delete on public.student_documents for delete to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- ---------- private bucket ----------
-- No storage.objects policies are created for this bucket, so no browser,
-- anon key or signed-in user can read or write it directly. Only the backend
-- (service role) touches it.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('student-documents', 'student-documents', false, 10485760,
            array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
