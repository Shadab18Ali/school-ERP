-- =====================================================================
-- Phase 23: library management
--   library_settings      per school: loan periods, borrowing limits, fine per day,
--                         grace days, fine cap, renewals, when to refuse an issue
--   library_categories    e.g. Fiction, Science, Reference
--   library_authors
--   library_books         a title (ISBN stored as a validated ISBN-13)
--   library_book_authors  book <-> authors, in order
--   library_copies        each physical copy, with its accession number and status
--   library_loans         every issue: borrower (student or staff), dates, renewals,
--                         return condition, fine and book charge, how the fine was
--                         settled. Never deleted: this is the borrowing history.
--
-- Rules live here, not in the app: a copy is on one loan at a time; borrowing
-- limits, overdue and unpaid-fine blocks; fines are calculated by the database
-- from the rate in force when the book was issued; only school admins change the
-- rules or waive fines. Borrowers' names are copied onto the loan at issue, so the
-- librarian can work without access to student or staff records.
-- =====================================================================

insert into public.roles (key, name, description, display_order)
values ('librarian', 'Librarian', 'Library catalogue, issues, returns and fines', 6)
on conflict (key) do nothing;

-- admins and librarians run the library
create or replace function private.is_library_staff(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_super_admin() or private.has_school_role(p_school, array['school_admin', 'librarian']::public.app_role[]);
$$;
-- ...and accountants may also collect fines
create or replace function private.can_collect_library_fines(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_super_admin() or private.has_school_role(p_school, array['school_admin', 'librarian', 'accountant']::public.app_role[]);
$$;

-- ISBN-10 or ISBN-13 (spaces and hyphens allowed) -> ISBN-13, or an error if the check digit is wrong.
create or replace function private.isbn13(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare s text := upper(regexp_replace(coalesce(p, ''), '[\s-]', '', 'g')); total int := 0; i int; d int;
begin
  if s = '' then return null; end if;
  if s ~ '^[0-9]{9}[0-9X]$' then
    for i in 1..10 loop
      d := case when substr(s, i, 1) = 'X' then 10 else substr(s, i, 1)::int end;
      total := total + d * (11 - i);
    end loop;
    if total % 11 <> 0 then
      raise exception 'That ISBN isn''t valid: the check digit doesn''t match.' using errcode = 'check_violation';
    end if;
    s := '978' || substr(s, 1, 9);
    total := 0;
    for i in 1..12 loop total := total + substr(s, i, 1)::int * (case when i % 2 = 0 then 3 else 1 end); end loop;
    return s || ((10 - total % 10) % 10)::text;
  elsif s ~ '^97[89][0-9]{10}$' then
    for i in 1..12 loop total := total + substr(s, i, 1)::int * (case when i % 2 = 0 then 3 else 1 end); end loop;
    if (10 - total % 10) % 10 <> substr(s, 13, 1)::int then
      raise exception 'That ISBN isn''t valid: the check digit doesn''t match.' using errcode = 'check_violation';
    end if;
    return s;
  end if;
  raise exception 'An ISBN has 10 or 13 digits (ISBN-13 starts with 978 or 979).' using errcode = 'check_violation';
end $$;

-- =====================================================================
-- Tables
-- =====================================================================
create table public.library_settings (
  school_id            uuid primary key references public.schools (id) on delete cascade,
  loan_days_student    smallint not null default 14 check (loan_days_student between 1 and 180),
  loan_days_staff      smallint not null default 30 check (loan_days_staff between 1 and 365),
  max_books_student    smallint not null default 2 check (max_books_student between 1 and 20),
  max_books_staff      smallint not null default 5 check (max_books_staff between 1 and 50),
  fine_per_day         numeric(10, 2) not null default 0 check (fine_per_day between 0 and 1000),  -- 0 = no fines until the school sets one
  grace_days           smallint not null default 0 check (grace_days between 0 and 30),
  max_fine             numeric(10, 2) check (max_fine is null or max_fine > 0),               -- cap per book; null = no cap
  max_renewals         smallint not null default 1 check (max_renewals between 0 and 5),
  block_when_overdue   boolean not null default true,
  block_when_fines_due boolean not null default true,
  updated_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now()
);

create table public.library_categories (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 2 and 80),
  created_at  timestamptz not null default now(),
  constraint library_categories_id_school_key unique (id, school_id)
);
create unique index library_categories_name_key on public.library_categories (school_id, lower(btrim(name)));

create table public.library_authors (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 2 and 150),
  created_at  timestamptz not null default now(),
  constraint library_authors_id_school_key unique (id, school_id)
);
create unique index library_authors_name_key on public.library_authors (school_id, lower(btrim(name)));

create table public.library_books (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references public.schools (id) on delete cascade,
  title             text not null check (char_length(btrim(title)) between 1 and 300),
  subtitle          text check (subtitle is null or char_length(subtitle) <= 300),
  isbn              text check (isbn is null or isbn ~ '^97[89][0-9]{10}$'),
  publisher         text check (publisher is null or char_length(publisher) <= 150),
  edition           text check (edition is null or char_length(edition) <= 50),
  publication_year  smallint check (publication_year is null or publication_year between 1450 and 2100),
  language          text check (language is null or char_length(language) <= 40),
  category_id       uuid,
  shelf_location    text check (shelf_location is null or char_length(shelf_location) <= 40),
  description       text check (description is null or char_length(description) <= 2000),
  is_active         boolean not null default true,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint library_books_id_school_key unique (id, school_id),
  constraint library_books_category_fkey foreign key (category_id, school_id)
    references public.library_categories (id, school_id) on delete restrict
);
create unique index library_books_isbn_key on public.library_books (school_id, isbn) where isbn is not null;
create index library_books_school_title_idx on public.library_books (school_id, lower(title));

create table public.library_book_authors (
  book_id    uuid not null,
  author_id  uuid not null,
  school_id  uuid not null,
  position   smallint not null default 1 check (position between 1 and 20),
  primary key (book_id, author_id),
  constraint library_book_authors_book_fkey foreign key (book_id, school_id)
    references public.library_books (id, school_id) on delete cascade,
  constraint library_book_authors_author_fkey foreign key (author_id, school_id)
    references public.library_authors (id, school_id) on delete restrict
);
create index library_book_authors_author_idx on public.library_book_authors (author_id);

create table public.library_copies (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references public.schools (id) on delete cascade,
  book_id           uuid not null,
  accession_number  text not null check (accession_number ~ '^[A-Za-z0-9/_-]{1,30}$'),
  status            text not null default 'available' check (status in ('available', 'issued', 'lost', 'damaged', 'withdrawn')),
  price             numeric(10, 2) check (price is null or price between 0 and 1000000),  -- used as the charge for a lost copy
  acquired_on       date,
  note              text check (note is null or char_length(note) <= 300),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint library_copies_id_school_key unique (id, school_id),
  constraint library_copies_book_fkey foreign key (book_id, school_id)
    references public.library_books (id, school_id) on delete restrict
);
create unique index library_copies_accession_key on public.library_copies (school_id, lower(accession_number));
create index library_copies_book_idx on public.library_copies (book_id);

create table public.library_loans (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  copy_id              uuid not null,
  book_id              uuid not null,
  student_id           uuid,
  teacher_id           uuid,
  -- copied at issue: the history stays readable, and the librarian needs no access to student/staff records
  borrower_name        text not null,
  borrower_code        text,
  borrower_class       text,
  issued_on            date not null,
  due_date             date not null,
  returned_on          date,
  return_condition     text check (return_condition in ('good', 'damaged', 'lost')),
  renewals             smallint not null default 0 check (renewals >= 0),
  -- the rules in force when the book was issued
  fine_per_day         numeric(10, 2) not null check (fine_per_day >= 0),
  grace_days           smallint not null check (grace_days >= 0),
  max_fine             numeric(10, 2),
  -- settled at return
  fine_amount          numeric(10, 2) not null default 0 check (fine_amount >= 0),
  book_charge          numeric(10, 2) not null default 0 check (book_charge >= 0),
  fine_status          text not null default 'none' check (fine_status in ('none', 'unpaid', 'paid', 'waived')),
  fine_paid_amount     numeric(10, 2) check (fine_paid_amount is null or fine_paid_amount >= 0),
  fine_paid_at         timestamptz,
  fine_payment_mode    text check (fine_payment_mode in ('cash', 'upi', 'card', 'bank_transfer', 'cheque')),
  fine_reference       text check (fine_reference is null or char_length(fine_reference) <= 60),
  fine_receipt_number  text,
  fine_collected_by    uuid references auth.users (id) on delete set null,
  fine_waived_by       uuid references auth.users (id) on delete set null,
  fine_waived_at       timestamptz,
  fine_waive_reason    text check (fine_waive_reason is null or char_length(fine_waive_reason) between 3 and 300),
  note                 text check (note is null or char_length(note) <= 300),
  issued_by            uuid references auth.users (id) on delete set null,
  returned_by          uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint library_loans_copy_fkey foreign key (copy_id, school_id) references public.library_copies (id, school_id) on delete restrict,
  constraint library_loans_book_fkey foreign key (book_id, school_id) references public.library_books (id, school_id) on delete restrict,
  constraint library_loans_student_fkey foreign key (student_id, school_id) references public.students (id, school_id) on delete restrict,
  constraint library_loans_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id) on delete restrict,
  constraint library_loans_one_borrower check ((student_id is null) <> (teacher_id is null)),
  constraint library_loans_dates check (due_date >= issued_on and (returned_on is null or returned_on >= issued_on)),
  -- an open loan has nothing settled yet; a returned one has its condition
  constraint library_loans_open_state check (
    (returned_on is null and return_condition is null and fine_amount = 0 and book_charge = 0 and fine_status = 'none')
    or (returned_on is not null and return_condition is not null)),
  constraint library_loans_fine_state check (
    (fine_status = 'none' and fine_amount + book_charge = 0)
    or (fine_status = 'unpaid' and fine_amount + book_charge > 0 and fine_paid_at is null and fine_waived_at is null)
    or (fine_status = 'paid' and fine_paid_at is not null and fine_paid_amount = fine_amount + book_charge and fine_receipt_number is not null)
    or (fine_status = 'waived' and fine_waived_at is not null and fine_waive_reason is not null))
);
-- one copy, one open loan
create unique index library_loans_open_copy_key on public.library_loans (copy_id) where returned_on is null;
create index library_loans_open_idx on public.library_loans (school_id, due_date) where returned_on is null;
create index library_loans_student_idx on public.library_loans (student_id, issued_on desc) where student_id is not null;
create index library_loans_teacher_idx on public.library_loans (teacher_id, issued_on desc) where teacher_id is not null;
create index library_loans_school_issued_idx on public.library_loans (school_id, issued_on desc);
create index library_loans_unpaid_idx on public.library_loans (school_id) where fine_status = 'unpaid';

-- housekeeping triggers
create trigger library_books_updated_at before update on public.library_books for each row execute function private.set_updated_at();
create trigger library_copies_updated_at before update on public.library_copies for each row execute function private.set_updated_at();
create trigger library_loans_updated_at before update on public.library_loans for each row execute function private.set_updated_at();
create trigger library_settings_updated_at before update on public.library_settings for each row execute function private.set_updated_at();
create trigger library_categories_school_guard before update on public.library_categories for each row execute function private.prevent_school_change();
create trigger library_authors_school_guard before update on public.library_authors for each row execute function private.prevent_school_change();
create trigger library_books_school_guard before update on public.library_books for each row execute function private.prevent_school_change();
create trigger library_copies_school_guard before update on public.library_copies for each row execute function private.prevent_school_change();
create trigger library_loans_school_guard before update on public.library_loans for each row execute function private.prevent_school_change();

create or replace function private.library_books_isbn() returns trigger language plpgsql set search_path = '' as $$
begin
  new.isbn := private.isbn13(new.isbn);
  new.title := btrim(new.title);
  return new;
end $$;
create trigger library_books_isbn before insert or update of isbn, title on public.library_books
  for each row execute function private.library_books_isbn();

-- A copy's status follows its loans: "issued" only with an open loan, and an issued
-- copy changes only through return (enforced for everyone, including the functions below).
create or replace function private.library_copy_status_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_open boolean;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  v_open := exists (select 1 from public.library_loans l where l.copy_id = new.id and l.returned_on is null);
  if new.status = 'issued' and not v_open then
    raise exception 'A copy is issued only through the issue desk.' using errcode = 'check_violation';
  end if;
  if new.status <> 'issued' and v_open then
    raise exception 'This copy is on loan. Return it first.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger library_copies_status_guard before insert or update of status on public.library_copies
  for each row execute function private.library_copy_status_guard();

-- Loans are history: no deleting, and borrower, copy and issue date never change.
create or replace function private.library_loan_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- maintenance only (e.g. clearing a test school); app users have no delete right on loans anyway
    if current_setting('library.allow_delete', true) = 'on' then return old; end if;
    raise exception 'Loans are kept as the borrowing history and can''t be deleted.' using errcode = 'check_violation';
  end if;
  if new.copy_id <> old.copy_id or new.book_id <> old.book_id or new.student_id is distinct from old.student_id
     or new.teacher_id is distinct from old.teacher_id or new.issued_on <> old.issued_on
     or new.fine_per_day <> old.fine_per_day or new.grace_days <> old.grace_days or new.max_fine is distinct from old.max_fine then
    raise exception 'The borrower, copy, issue date and fine rules of a loan can''t be changed.' using errcode = 'check_violation';
  end if;
  if old.returned_on is not null and (new.returned_on is distinct from old.returned_on or new.fine_amount <> old.fine_amount
     or new.book_charge <> old.book_charge or new.return_condition is distinct from old.return_condition) then
    raise exception 'A returned loan can''t be changed.' using errcode = 'check_violation';
  end if;
  if old.fine_status in ('paid', 'waived') and new.fine_status <> old.fine_status then
    raise exception 'This fine is already settled.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger library_loans_guard before update or delete on public.library_loans
  for each row execute function private.library_loan_guard();

-- =====================================================================
-- Rules and calculations
-- =====================================================================
create or replace function private.library_rules(p_school uuid)
returns public.library_settings language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s from public.library_settings s where s.school_id = p_school),
    row(p_school, 14, 30, 2, 5, 0, 0, null, 1, true, true, null, now())::public.library_settings);
$$;

-- Days late beyond the grace days, times the rate, capped per book.
create or replace function private.library_fine(p_due date, p_on date, p_rate numeric, p_grace smallint, p_cap numeric)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_on - p_due - p_grace <= 0 then 0::numeric
              else least((p_on - p_due - p_grace) * p_rate, coalesce(p_cap, (p_on - p_due - p_grace) * p_rate)) end::numeric(10, 2);
$$;

-- What a loan owes right now: for an open loan, the fine so far (as of today, India time);
-- for a returned one, what is still unpaid.
create or replace function private.library_loan_due(l public.library_loans)
returns numeric language sql stable set search_path = '' as $$
  select case
    when l.returned_on is null then private.library_fine(l.due_date, private.ist_today(), l.fine_per_day, l.grace_days, l.max_fine)
    when l.fine_status = 'unpaid' then l.fine_amount + l.book_charge
    else 0 end::numeric(10, 2);
$$;

create or replace function private.library_counter(p_school uuid, p_kind text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare n bigint;
begin
  insert into private.school_counters as c (school_id, kind, last_value) values (p_school, p_kind, 1)
  on conflict (school_id, kind) do update set last_value = c.last_value + 1
  returning last_value into n;
  return n;
end $$;

-- =====================================================================
-- Catalogue
-- =====================================================================
-- Add copies of a book: given accession numbers, or the next numbers (ACC-000001...).
create or replace function private.library_add_copies(
  p_book uuid, p_count integer, p_accessions text[] default null, p_price numeric default null, p_acquired_on date default null
) returns integer language plpgsql security definer set search_path = '' as $$
declare b public.library_books; n integer := 0; v_acc text; i integer;
begin
  select * into b from public.library_books where id = p_book;
  if not found or not private.is_library_staff(b.school_id) then
    raise exception 'Book not found.' using errcode = 'P0002';
  end if;
  if not b.is_active then raise exception 'This book is withdrawn from the catalogue.' using errcode = 'check_violation'; end if;
  if p_acquired_on is not null and p_acquired_on > private.ist_today() then
    raise exception 'The date acquired can''t be in the future.' using errcode = 'check_violation';
  end if;
  if p_accessions is not null and cardinality(p_accessions) > 0 then
    if cardinality(p_accessions) > 100 then raise exception 'Add at most 100 copies at a time.' using errcode = 'check_violation'; end if;
    foreach v_acc in array p_accessions loop
      if exists (select 1 from public.library_copies c where c.school_id = b.school_id and lower(c.accession_number) = lower(btrim(v_acc))) then
        raise exception 'Accession number % is already used.', btrim(v_acc) using errcode = 'unique_violation';
      end if;
      insert into public.library_copies (school_id, book_id, accession_number, price, acquired_on)
      values (b.school_id, b.id, btrim(v_acc), p_price, p_acquired_on);
      n := n + 1;
    end loop;
    return n;
  end if;
  if p_count is null or p_count < 1 or p_count > 100 then
    raise exception 'Add between 1 and 100 copies at a time.' using errcode = 'check_violation';
  end if;
  for i in 1..p_count loop
    loop  -- skip numbers already typed in by hand
      v_acc := 'ACC-' || lpad(private.library_counter(b.school_id, 'library_accession')::text, 6, '0');
      exit when not exists (select 1 from public.library_copies c where c.school_id = b.school_id and lower(c.accession_number) = lower(v_acc));
    end loop;
    insert into public.library_copies (school_id, book_id, accession_number, price, acquired_on)
    values (b.school_id, b.id, v_acc, p_price, p_acquired_on);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Mark a copy available / damaged / lost / withdrawn (not while it is on loan).
create or replace function private.library_set_copy_status(p_copy uuid, p_status text, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.library_copies;
begin
  select * into c from public.library_copies where id = p_copy for update;
  if not found or not private.is_library_staff(c.school_id) then raise exception 'Copy not found.' using errcode = 'P0002'; end if;
  if p_status not in ('available', 'damaged', 'lost', 'withdrawn') then
    raise exception 'Choose available, damaged, lost or withdrawn.' using errcode = 'check_violation';
  end if;
  update public.library_copies set status = p_status, note = coalesce(nullif(btrim(p_note), ''), note) where id = p_copy;
end $$;

-- =====================================================================
-- Borrowers (the librarian can't read student or staff records directly)
-- =====================================================================
create or replace function private.library_find_borrowers(p_school uuid, p_q text)
returns table (kind text, id uuid, name text, code text, detail text, open_loans integer, overdue integer, fines_due numeric)
language plpgsql stable security definer set search_path = '' as $$
declare q text := lower(btrim(coalesce(p_q, '')));
begin
  if not private.is_library_staff(p_school) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  if char_length(q) < 2 then return; end if;
  return query
  with cand as (
    (select 'student'::text as kind, s.id, s.full_name as name, s.student_code as code,
            c.name || ' – ' || sec.name || coalesce(' · Adm. ' || e.admission_number, '') as detail
     from public.students s
     join public.student_enrollments e on e.student_id = s.id
     join public.academic_sessions a on a.id = e.academic_session_id and a.is_current and a.archived_at is null
     join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id
     where s.school_id = p_school and s.status = 'active'
       and (lower(s.full_name) like '%' || q || '%' or lower(s.student_code) = q or lower(e.admission_number) = q)
     order by s.full_name limit 15)
    union all
    (select 'staff', t.id, t.full_name, t.employee_id, coalesce(t.subject, 'Staff')
     from public.teachers t
     where t.school_id = p_school and t.status = 'active'
       and (lower(t.full_name) like '%' || q || '%' or lower(t.employee_id) = q)
     order by t.full_name limit 10)
  )
  select cand.kind, cand.id, cand.name, cand.code, cand.detail,
         (select count(*)::int from public.library_loans l where l.returned_on is null and (l.student_id = cand.id or l.teacher_id = cand.id)),
         (select count(*)::int from public.library_loans l where l.returned_on is null and l.due_date < private.ist_today()
            and (l.student_id = cand.id or l.teacher_id = cand.id)),
         (select coalesce(sum(private.library_loan_due(l)), 0)::numeric(10, 2) from public.library_loans l
            where (l.student_id = cand.id or l.teacher_id = cand.id) and (l.returned_on is null or l.fine_status = 'unpaid'))
  from cand;
end $$;

-- One borrower, for the borrower page: who, how many books out, what is owed, and the limit.
create or replace function private.library_borrower(p_school uuid, p_kind text, p_id uuid)
returns table (kind text, id uuid, name text, code text, detail text, open_loans integer, overdue integer, fines_due numeric,
               max_books integer, loan_days integer, is_active boolean)
language plpgsql stable security definer set search_path = '' as $$
declare r public.library_settings := private.library_rules(p_school);
begin
  if not private.is_library_staff(p_school) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  return query
  with who as (
    select 'student'::text as kind, s.id, s.full_name as name, s.student_code as code,
           (select c.name || ' – ' || sec.name || coalesce(' · Adm. ' || e.admission_number, '')
              from public.student_enrollments e
              join public.academic_sessions a on a.id = e.academic_session_id and a.is_current and a.archived_at is null
              join public.classes c on c.id = e.class_id join public.sections sec on sec.id = e.section_id
              where e.student_id = s.id) as detail,
           r.max_books_student::int as max_books, r.loan_days_student::int as loan_days, s.status = 'active' as is_active
    from public.students s where p_kind = 'student' and s.id = p_id and s.school_id = p_school
    union all
    select 'staff', t.id, t.full_name, t.employee_id, coalesce(t.subject, 'Staff'), r.max_books_staff::int, r.loan_days_staff::int,
           t.status = 'active'
    from public.teachers t where p_kind = 'staff' and t.id = p_id and t.school_id = p_school
  )
  select who.kind, who.id, who.name, who.code, who.detail,
         (select count(*)::int from public.library_loans l where l.returned_on is null and (l.student_id = who.id or l.teacher_id = who.id)),
         (select count(*)::int from public.library_loans l where l.returned_on is null and l.due_date < private.ist_today()
            and (l.student_id = who.id or l.teacher_id = who.id)),
         (select coalesce(sum(private.library_loan_due(l)), 0)::numeric(10, 2) from public.library_loans l
            where (l.student_id = who.id or l.teacher_id = who.id) and (l.returned_on is null or l.fine_status = 'unpaid')),
         who.max_books, who.loan_days, who.is_active
  from who;
end $$;

-- =====================================================================
-- Circulation
-- =====================================================================
create or replace function private.library_issue(p_copy uuid, p_student uuid, p_teacher uuid, p_due date default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.library_copies; b public.library_books; r public.library_settings; v_today date := private.ist_today();
        v_name text; v_code text; v_class text; v_limit int; v_days int; v_open int; v_due date; v_id uuid;
begin
  select * into c from public.library_copies where id = p_copy for update;
  if not found or not private.is_library_staff(c.school_id) then raise exception 'Copy not found.' using errcode = 'P0002'; end if;
  select * into b from public.library_books where id = c.book_id;
  if c.status <> 'available' then
    raise exception 'Copy % is not available (it is %).', c.accession_number, c.status using errcode = 'check_violation';
  end if;
  if not b.is_active then raise exception 'This book is withdrawn from the catalogue.' using errcode = 'check_violation'; end if;
  if (p_student is null) = (p_teacher is null) then
    raise exception 'Choose one borrower: a student or a staff member.' using errcode = 'check_violation';
  end if;
  r := private.library_rules(c.school_id);

  if p_student is not null then
    select s.full_name, s.student_code, cl.name || ' – ' || sec.name into v_name, v_code, v_class
      from public.students s
      join public.student_enrollments e on e.student_id = s.id
      join public.academic_sessions a on a.id = e.academic_session_id and a.is_current and a.archived_at is null
      join public.classes cl on cl.id = e.class_id join public.sections sec on sec.id = e.section_id
      where s.id = p_student and s.school_id = c.school_id and s.status = 'active';
    if v_name is null then
      raise exception 'Only active students enrolled in the current session can borrow.' using errcode = 'check_violation';
    end if;
    v_limit := r.max_books_student; v_days := r.loan_days_student;
  else
    select t.full_name, t.employee_id into v_name, v_code
      from public.teachers t where t.id = p_teacher and t.school_id = c.school_id and t.status = 'active';
    if v_name is null then raise exception 'Only active staff can borrow.' using errcode = 'check_violation'; end if;
    v_limit := r.max_books_staff; v_days := r.loan_days_staff;
  end if;

  -- one borrower's loans are checked one at a time (two desks can't both pass the limit)
  perform pg_advisory_xact_lock(hashtextextended('library:' || coalesce(p_student, p_teacher)::text, 0));
  select count(*) into v_open from public.library_loans l
    where l.returned_on is null and (l.student_id = p_student or l.teacher_id = p_teacher);
  if v_open >= v_limit then
    raise exception '% already has % book(s) out; the limit is %.', v_name, v_open, v_limit using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.library_loans l join public.library_copies lc on lc.id = l.copy_id
             where l.returned_on is null and lc.book_id = b.id and (l.student_id = p_student or l.teacher_id = p_teacher)) then
    raise exception '% already has a copy of this book.', v_name using errcode = 'check_violation';
  end if;
  if r.block_when_overdue and exists (select 1 from public.library_loans l where l.returned_on is null and l.due_date < v_today
                                       and (l.student_id = p_student or l.teacher_id = p_teacher)) then
    raise exception '% has an overdue book. Return it before borrowing another.', v_name using errcode = 'check_violation';
  end if;
  if r.block_when_fines_due and exists (select 1 from public.library_loans l where l.fine_status = 'unpaid'
                                         and (l.student_id = p_student or l.teacher_id = p_teacher)) then
    raise exception '% has an unpaid library fine. Settle it before borrowing.', v_name using errcode = 'check_violation';
  end if;

  v_due := coalesce(p_due, v_today + v_days);
  if v_due < v_today or v_due > v_today + 365 then
    raise exception 'The due date must be between today and a year from now.' using errcode = 'check_violation';
  end if;

  insert into public.library_loans (school_id, copy_id, book_id, student_id, teacher_id, borrower_name, borrower_code, borrower_class,
                                    issued_on, due_date, fine_per_day, grace_days, max_fine, issued_by)
  values (c.school_id, c.id, b.id, p_student, p_teacher, v_name, v_code, v_class,
          v_today, v_due, r.fine_per_day, r.grace_days, r.max_fine, (select auth.uid()))
  returning id into v_id;
  update public.library_copies set status = 'issued' where id = c.id;
  return v_id;
end $$;

create or replace function private.library_return(
  p_loan uuid, p_condition text default 'good', p_returned_on date default null, p_charge numeric default null, p_note text default null
) returns public.library_loans language plpgsql security definer set search_path = '' as $$
declare l public.library_loans; c public.library_copies; v_on date; v_fine numeric; v_charge numeric := 0;
begin
  select * into l from public.library_loans where id = p_loan for update;
  if not found or not private.is_library_staff(l.school_id) then raise exception 'Loan not found.' using errcode = 'P0002'; end if;
  if l.returned_on is not null then raise exception 'This book was already returned.' using errcode = 'check_violation'; end if;
  if p_condition not in ('good', 'damaged', 'lost') then
    raise exception 'Choose good, damaged or lost.' using errcode = 'check_violation';
  end if;
  v_on := coalesce(p_returned_on, private.ist_today());
  if v_on < l.issued_on or v_on > private.ist_today() then
    raise exception 'The return date must be between the issue date and today.' using errcode = 'check_violation';
  end if;
  select * into c from public.library_copies where id = l.copy_id for update;
  if p_charge is not null and p_charge < 0 then raise exception 'A charge can''t be negative.' using errcode = 'check_violation'; end if;
  if p_condition = 'good' then
    if coalesce(p_charge, 0) > 0 then raise exception 'A book returned in good condition has no charge.' using errcode = 'check_violation'; end if;
  elsif p_condition = 'lost' then
    v_charge := coalesce(p_charge, c.price);
    if v_charge is null then
      raise exception 'Enter the charge for the lost book (this copy has no price recorded).' using errcode = 'check_violation';
    end if;
  else
    v_charge := coalesce(p_charge, 0);
  end if;
  v_fine := private.library_fine(l.due_date, v_on, l.fine_per_day, l.grace_days, l.max_fine);

  update public.library_loans set
    returned_on = v_on, return_condition = p_condition, returned_by = (select auth.uid()),
    fine_amount = v_fine, book_charge = v_charge,
    fine_status = case when v_fine + v_charge > 0 then 'unpaid' else 'none' end,
    note = coalesce(nullif(btrim(p_note), ''), note)
  where id = p_loan returning * into l;
  update public.library_copies set status = case p_condition when 'good' then 'available' else p_condition end where id = c.id;
  return l;
end $$;

create or replace function private.library_renew(p_loan uuid)
returns date language plpgsql security definer set search_path = '' as $$
declare l public.library_loans; r public.library_settings; v_due date;
begin
  select * into l from public.library_loans where id = p_loan for update;
  if not found or not private.is_library_staff(l.school_id) then raise exception 'Loan not found.' using errcode = 'P0002'; end if;
  if l.returned_on is not null then raise exception 'This book was already returned.' using errcode = 'check_violation'; end if;
  if l.due_date < private.ist_today() then
    raise exception 'An overdue book can''t be renewed. Return it (and settle any fine) first.' using errcode = 'check_violation';
  end if;
  r := private.library_rules(l.school_id);
  if l.renewals >= r.max_renewals then
    raise exception 'This book has been renewed the most times allowed (%).', r.max_renewals using errcode = 'check_violation';
  end if;
  -- another loan period from the current due date
  v_due := greatest(l.due_date, private.ist_today()) + case when l.student_id is not null then r.loan_days_student else r.loan_days_staff end;
  update public.library_loans set due_date = v_due, renewals = renewals + 1 where id = p_loan;
  return v_due;
end $$;

-- =====================================================================
-- Fines
-- =====================================================================
create or replace function private.library_collect_fine(p_loan uuid, p_mode text, p_reference text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare l public.library_loans; v_receipt text;
begin
  select * into l from public.library_loans where id = p_loan for update;
  if not found or not private.can_collect_library_fines(l.school_id) then raise exception 'Loan not found.' using errcode = 'P0002'; end if;
  if l.fine_status <> 'unpaid' then raise exception 'There is nothing to collect on this loan.' using errcode = 'check_violation'; end if;
  if p_mode not in ('cash', 'upi', 'card', 'bank_transfer', 'cheque') then
    raise exception 'Choose how the fine was paid.' using errcode = 'check_violation';
  end if;
  if p_mode <> 'cash' and coalesce(btrim(p_reference), '') = '' then
    raise exception 'Enter the transaction or cheque reference.' using errcode = 'check_violation';
  end if;
  v_receipt := 'LIB-' || lpad(private.library_counter(l.school_id, 'library_fine')::text, 6, '0');
  update public.library_loans set fine_status = 'paid', fine_paid_amount = fine_amount + book_charge, fine_paid_at = now(),
    fine_payment_mode = p_mode, fine_reference = nullif(btrim(p_reference), ''), fine_receipt_number = v_receipt,
    fine_collected_by = (select auth.uid())
  where id = p_loan;
  return v_receipt;
end $$;

create or replace function private.library_waive_fine(p_loan uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare l public.library_loans;
begin
  select * into l from public.library_loans where id = p_loan for update;
  if not found or not private.can_collect_library_fines(l.school_id) then raise exception 'Loan not found.' using errcode = 'P0002'; end if;
  if not (private.is_super_admin() or private.has_school_role(l.school_id, array['school_admin']::public.app_role[])) then
    raise exception 'Only school admins can waive a fine.' using errcode = 'insufficient_privilege';
  end if;
  if l.fine_status <> 'unpaid' then raise exception 'There is no unpaid fine on this loan.' using errcode = 'check_violation'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason for waiving the fine.' using errcode = 'check_violation'; end if;
  update public.library_loans set fine_status = 'waived', fine_waived_by = (select auth.uid()), fine_waived_at = now(),
    fine_waive_reason = btrim(p_reason)
  where id = p_loan;
end $$;

-- =====================================================================
-- Dashboard
-- =====================================================================
create or replace function private.library_dashboard(p_school uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.ist_today(); v_month date := date_trunc('month', private.ist_today())::date; out jsonb;
begin
  if not private.can_collect_library_fines(p_school) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  select jsonb_build_object(
    'titles', (select count(*) from public.library_books b where b.school_id = p_school and b.is_active),
    'copies', (select count(*) from public.library_copies c where c.school_id = p_school and c.status <> 'withdrawn'),
    'available', (select count(*) from public.library_copies c where c.school_id = p_school and c.status = 'available'),
    'issued', (select count(*) from public.library_loans l where l.school_id = p_school and l.returned_on is null),
    'overdue', (select count(*) from public.library_loans l where l.school_id = p_school and l.returned_on is null and l.due_date < v_today),
    'damaged', (select count(*) from public.library_copies c where c.school_id = p_school and c.status = 'damaged'),
    'lost', (select count(*) from public.library_copies c where c.school_id = p_school and c.status = 'lost'),
    'borrowers', (select count(distinct coalesce(l.student_id, l.teacher_id)) from public.library_loans l
                  where l.school_id = p_school and l.returned_on is null),
    'issued_today', (select count(*) from public.library_loans l where l.school_id = p_school and l.issued_on = v_today),
    'returned_today', (select count(*) from public.library_loans l where l.school_id = p_school and l.returned_on = v_today),
    'fines_unpaid', (select coalesce(sum(l.fine_amount + l.book_charge), 0) from public.library_loans l
                     where l.school_id = p_school and l.fine_status = 'unpaid'),
    'fines_unpaid_count', (select count(*) from public.library_loans l where l.school_id = p_school and l.fine_status = 'unpaid'),
    'fines_accruing', (select coalesce(sum(private.library_loan_due(l)), 0) from public.library_loans l
                       where l.school_id = p_school and l.returned_on is null and l.due_date < v_today),
    'fines_collected_month', (select coalesce(sum(l.fine_paid_amount), 0) from public.library_loans l
                              where l.school_id = p_school and l.fine_status = 'paid' and (l.fine_paid_at at time zone 'Asia/Kolkata')::date >= v_month),
    'fines_collected_total', (select coalesce(sum(l.fine_paid_amount), 0) from public.library_loans l
                              where l.school_id = p_school and l.fine_status = 'paid'),
    'fines_waived_total', (select coalesce(sum(l.fine_amount + l.book_charge), 0) from public.library_loans l
                           where l.school_id = p_school and l.fine_status = 'waived'),
    'fine_per_day', (private.library_rules(p_school)).fine_per_day,
    'by_category', (select coalesce(jsonb_agg(x order by x.copies desc, x.name), '[]') from (
                      select coalesce(cat.name, 'Uncategorised') as name, count(c.id) as copies,
                             count(c.id) filter (where c.status = 'issued') as issued
                      from public.library_books b
                      left join public.library_categories cat on cat.id = b.category_id
                      join public.library_copies c on c.book_id = b.id and c.status <> 'withdrawn'
                      where b.school_id = p_school and b.is_active
                      group by 1) x),
    'top_books', (select coalesce(jsonb_agg(x order by x.loans desc, x.title), '[]') from (
                    select b.id, b.title, count(*) as loans from public.library_loans l join public.library_books b on b.id = l.book_id
                    where l.school_id = p_school and l.issued_on >= v_today - 90
                    group by b.id, b.title order by count(*) desc, b.title limit 5) x)
  ) into out;
  return out;
end $$;

-- =====================================================================
-- Notifications: one "overdue" message per loan to the student's family (Phase 22)
-- =====================================================================
alter table public.notification_events drop constraint notification_events_event_key_check;
alter table public.notification_events add constraint notification_events_event_key_check check (event_key in (
  'fee_reminder', 'payment_received', 'student_absent', 'homework_assigned', 'exam_scheduled', 'results_published',
  'admission_update', 'notice_published', 'library_overdue', 'test'));

-- Run by the sender: from 9 am India time, loans of students that became overdue.
create or replace function private.notify_library_overdue() returns integer language plpgsql security definer set search_path = '' as $$
declare n integer := 0; r record;
begin
  if extract(hour from now() at time zone 'Asia/Kolkata') < 9 then return 0; end if;
  for r in select l.id, l.school_id, l.student_id from public.library_loans l
           where l.returned_on is null and l.student_id is not null and l.due_date < private.ist_today()
  loop
    if private.notify_enqueue(r.school_id, 'library_overdue', 'library_overdue:' || r.id, r.student_id,
         jsonb_build_object('loan_id', r.id, 'student_id', r.student_id)) then
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- The sender's view of an event, now including library_overdue (same as Phase 22 otherwise).
create or replace function private.notify_event_context(p_event uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare e public.notification_events; sch record; v_vars jsonb := '{}'; v_rec jsonb := '[]'; x record; v_skip text;
begin
  select * into e from public.notification_events where id = p_event;
  select s.name, s.code, s.phone, s.email into sch from public.schools s where s.id = e.school_id;

  if e.event_key = 'payment_received' then
    select p.amount, p.receipt_number, p.payment_mode::text as mode, p.payment_date, p.balance_after, p.student_id, p.cancelled_at,
           c.name || ' – ' || sec.name as class_section
      into x from public.fee_payments p join public.student_enrollments en on en.id = p.enrollment_id
      join public.classes c on c.id = en.class_id join public.sections sec on sec.id = en.section_id
      where p.id = (e.payload->>'payment_id')::uuid;
    if x.cancelled_at is not null then v_skip := 'The receipt was cancelled.'; end if;
    v_vars := jsonb_build_object('amount', x.amount, 'receipt_number', x.receipt_number, 'payment_mode', x.mode,
      'payment_date', x.payment_date, 'balance', x.balance_after, 'class_section', x.class_section, 'student_id', x.student_id);
    select coalesce(jsonb_agg(f), '[]') into v_rec from private.notify_family(x.student_id, false) f;

  elsif e.event_key = 'student_absent' then
    select c.name || ' – ' || sec.name as class_section, ar.status::text as status, ar.remarks into x
      from public.attendance_records ar join public.classes c on c.id = ar.class_id join public.sections sec on sec.id = ar.section_id
      where ar.student_id = (e.payload->>'student_id')::uuid and ar.attendance_date = (e.payload->>'date')::date;
    if x.status is distinct from 'absent' then v_skip := 'The student is no longer marked absent.'; end if;
    v_vars := jsonb_build_object('date', e.payload->>'date', 'class_section', x.class_section);
    select coalesce(jsonb_agg(f), '[]') into v_rec from private.notify_family((e.payload->>'student_id')::uuid, false) f;

  elsif e.event_key = 'homework_assigned' then
    select h.title, h.kind::text as kind, h.due_at, h.section_id, sub.name as subject, c.name || ' – ' || sec.name as class_section into x
      from public.homework h join public.classes c on c.id = h.class_id join public.sections sec on sec.id = h.section_id
      left join public.subjects sub on sub.id = h.subject_id
      where h.id = (e.payload->>'homework_id')::uuid;
    if x.title is null then v_skip := 'The homework was deleted.'; end if;
    v_vars := jsonb_build_object('title', x.title, 'kind', initcap(x.kind), 'subject', coalesce(x.subject, 'General'),
      'due_date', (x.due_at at time zone 'Asia/Kolkata')::date, 'class_section', x.class_section, 'homework_id', e.payload->>'homework_id');
    select coalesce(jsonb_agg(f), '[]') into v_rec
      from public.student_enrollments en cross join lateral private.notify_family(en.student_id, true) f
      where en.section_id = x.section_id;

  elsif e.event_key in ('exam_scheduled', 'results_published') then
    select ex.name, ex.academic_session_id, (select min(pp.exam_date) from public.exam_papers pp where pp.exam_id = ex.id) as first_date,
           (select max(pp.exam_date) from public.exam_papers pp where pp.exam_id = ex.id) as last_date into x
      from public.exams ex where ex.id = (e.payload->>'exam_id')::uuid;
    v_vars := jsonb_build_object('exam_name', x.name, 'first_date', x.first_date, 'last_date', x.last_date);
    select coalesce(jsonb_agg(f), '[]') into v_rec
      from public.student_enrollments en cross join lateral private.notify_family(en.student_id, true) f
      where en.academic_session_id = x.academic_session_id
        and en.class_id in (select pp.class_id from public.exam_papers pp where pp.exam_id = (e.payload->>'exam_id')::uuid);

  elsif e.event_key = 'admission_update' then
    select ap.student_name, ap.application_number, ap.status::text as status, ap.rejection_reason, ap.fee_amount, ap.contact_email,
           ap.contact_phone, coalesce(nullif(ap.father_name, ''), ap.mother_name) as parent_name, c.name as class_name into x
      from public.admission_applications ap join public.classes c on c.id = ap.class_id
      where ap.id = (e.payload->>'application_id')::uuid;
    if x.status is distinct from e.payload->>'status' then v_skip := 'The application has moved on since.'; end if;
    v_vars := jsonb_build_object('student_name', x.student_name, 'application_number', x.application_number, 'status', x.status,
      'reason', x.rejection_reason, 'admission_fee', x.fee_amount, 'class_name', x.class_name);
    v_rec := jsonb_build_array(jsonb_build_object('kind', 'applicant', 'user_id', null, 'name', x.parent_name, 'email', x.contact_email,
                                                  'phone', x.contact_phone, 'student_id', null, 'student_name', x.student_name));

  elsif e.event_key = 'notice_published' then
    select n.title, n.body, n.audience::text as audience, n.class_ids, n.publish_at, n.expires_at into x
      from public.notices n where n.id = (e.payload->>'notice_id')::uuid;
    if x.title is null then v_skip := 'The notice was deleted.';
    elsif x.publish_at > now() then v_skip := 'The notice is scheduled for later.';
    end if;
    v_vars := jsonb_build_object('title', x.title, 'excerpt', left(regexp_replace(x.body, '\s+', ' ', 'g'), 300));
    with fam as (
      select f from public.student_enrollments en
      join public.academic_sessions a on a.id = en.academic_session_id and a.is_current
      cross join lateral private.notify_family(en.student_id, x.audience in ('everyone', 'students')) f
      where en.school_id = e.school_id and x.audience in ('everyone', 'parents', 'students')
        and (x.class_ids is null or en.class_id = any (x.class_ids))
    ), staff as (
      select distinct on (p.id) jsonb_build_object('kind', 'staff', 'user_id', p.id, 'name', p.full_name, 'email', p.email, 'phone', p.phone,
                                                   'student_id', null, 'student_name', null) as f
      from public.school_memberships m join public.profiles p on p.id = m.user_id
      where m.school_id = e.school_id and m.status = 'active' and m.role in ('school_admin', 'accountant', 'teacher')
        and x.audience in ('everyone', 'staff')
    )
    select coalesce(jsonb_agg(f), '[]') into v_rec from (
      select f from fam where x.audience <> 'students' or f->>'kind' = 'student'
      union all select f from staff) u;

  elsif e.event_key = 'fee_reminder' then
    select t.overdue, t.outstanding, c.name || ' – ' || sec.name as class_section into x
      from public.student_enrollments en
      join public.academic_sessions a on a.id = en.academic_session_id and a.is_current
      join public.classes c on c.id = en.class_id join public.sections sec on sec.id = en.section_id
      cross join lateral private.enrollment_fee_totals(array[en.id]) t
      where en.student_id = (e.payload->>'student_id')::uuid;
    if coalesce(x.overdue, 0) <= 0 then v_skip := 'Nothing is overdue any more.'; end if;
    v_vars := jsonb_build_object('amount_due', x.overdue, 'total_outstanding', x.outstanding, 'class_section', x.class_section);
    select coalesce(jsonb_agg(f), '[]') into v_rec from private.notify_family((e.payload->>'student_id')::uuid, false) f;

  elsif e.event_key = 'library_overdue' then
    select l.returned_on, l.due_date, l.student_id, b.title, private.library_loan_due(l) as fine, lc.accession_number
      into x from public.library_loans l join public.library_books b on b.id = l.book_id
      join public.library_copies lc on lc.id = l.copy_id
      where l.id = (e.payload->>'loan_id')::uuid;
    if x.title is null then v_skip := 'The loan no longer exists.';
    elsif x.returned_on is not null then v_skip := 'The book was returned before the message went out.';
    end if;
    v_vars := jsonb_build_object('book_title', x.title, 'due_date', x.due_date, 'days_overdue', private.ist_today() - x.due_date,
      'fine_so_far', x.fine, 'accession_number', x.accession_number, 'student_id', x.student_id);
    select coalesce(jsonb_agg(f), '[]') into v_rec from private.notify_family(x.student_id, true) f;

  elsif e.event_key = 'test' then
    v_vars := '{}';
    v_rec := jsonb_build_array(e.payload->'recipient');
  end if;

  return jsonb_build_object('event_key', e.event_key, 'skip', v_skip,
    'school', jsonb_build_object('name', sch.name, 'code', sch.code, 'phone', sch.phone, 'email', sch.email),
    'vars', v_vars, 'recipients', v_rec);
end $$;

-- =====================================================================
-- Access
-- =====================================================================
revoke all on public.library_settings, public.library_categories, public.library_authors, public.library_books,
  public.library_book_authors, public.library_copies, public.library_loans from anon, authenticated;
grant select on public.library_settings, public.library_categories, public.library_authors, public.library_books,
  public.library_book_authors, public.library_copies, public.library_loans to authenticated;
grant insert, update on public.library_settings to authenticated;
grant insert, update, delete on public.library_categories, public.library_authors, public.library_book_authors to authenticated;
grant insert, delete on public.library_books to authenticated;
grant update (title, subtitle, isbn, publisher, edition, publication_year, language, category_id, shelf_location, description, is_active)
  on public.library_books to authenticated;
grant delete on public.library_copies to authenticated;  -- copies are added by library_add_copies
grant update (accession_number, price, acquired_on, note) on public.library_copies to authenticated;
-- loans: no direct writes at all (issue, return, renew, fines go through the functions)

alter table public.library_settings enable row level security;
alter table public.library_categories enable row level security;
alter table public.library_authors enable row level security;
alter table public.library_books enable row level security;
alter table public.library_book_authors enable row level security;
alter table public.library_copies enable row level security;
alter table public.library_loans enable row level security;

create policy library_settings_select on public.library_settings for select to authenticated
  using (private.is_super_admin() or private.is_school_member(school_id));
create policy library_settings_admin_insert on public.library_settings for insert to authenticated
  with check (private.is_super_admin() or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy library_settings_admin_update on public.library_settings for update to authenticated
  using (private.is_super_admin() or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check (private.is_super_admin() or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- the catalogue is readable by everyone in the school; the library staff maintain it
do $$ declare t text; begin
  foreach t in array array['library_categories', 'library_authors', 'library_books', 'library_book_authors', 'library_copies'] loop
    execute format('create policy %I on public.%I for select to authenticated using (private.is_super_admin() or private.is_school_member(school_id))', t || '_select', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_library_staff(school_id))', t || '_delete', t);
    if t <> 'library_copies' then
      execute format('create policy %I on public.%I for insert to authenticated with check (private.is_library_staff(school_id))', t || '_insert', t);
    end if;
    if t not in ('library_book_authors') then
      execute format('create policy %I on public.%I for update to authenticated using (private.is_library_staff(school_id)) with check (private.is_library_staff(school_id))', t || '_update', t);
    end if;
  end loop;
end $$;

-- loans: library staff and accountants (fines) see all; staff see their own; families their child's
create policy library_loans_select on public.library_loans for select to authenticated using (
  private.can_collect_library_fines(school_id)
  or (teacher_id is not null and teacher_id = private.current_teacher_id(school_id))
  or (student_id is not null and private.can_view_student_record(student_id)));

revoke all on function private.is_library_staff(uuid), private.can_collect_library_fines(uuid), private.isbn13(text),
  private.library_rules(uuid), private.library_fine(date, date, numeric, smallint, numeric), private.library_loan_due(public.library_loans),
  private.library_counter(uuid, text), private.library_add_copies(uuid, integer, text[], numeric, date),
  private.library_set_copy_status(uuid, text, text), private.library_find_borrowers(uuid, text),
  private.library_borrower(uuid, text, uuid), private.library_issue(uuid, uuid, uuid, date), private.library_return(uuid, text, date, numeric, text),
  private.library_renew(uuid), private.library_collect_fine(uuid, text, text), private.library_waive_fine(uuid, text),
  private.library_dashboard(uuid), private.notify_library_overdue()
  from public, anon, authenticated;
grant execute on function private.is_library_staff(uuid), private.can_collect_library_fines(uuid), private.isbn13(text),
  private.library_rules(uuid), private.library_fine(date, date, numeric, smallint, numeric), private.library_loan_due(public.library_loans),
  private.library_add_copies(uuid, integer, text[], numeric, date), private.library_set_copy_status(uuid, text, text),
  private.library_find_borrowers(uuid, text), private.library_borrower(uuid, text, uuid), private.library_issue(uuid, uuid, uuid, date),
  private.library_return(uuid, text, date, numeric, text), private.library_renew(uuid),
  private.library_collect_fine(uuid, text, text), private.library_waive_fine(uuid, text), private.library_dashboard(uuid)
  to authenticated;
grant execute on function private.notify_library_overdue(), private.library_loan_due(public.library_loans) to erp_notify;
