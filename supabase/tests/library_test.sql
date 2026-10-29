-- =====================================================================
-- Library test (migrations 0001-0022). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL LIBRARY TESTS PASSED".
-- School A (ZZLB-A), session 2026-27, Class 1-A: Child One (Parent One; also has a
-- student login), Child Two, and Child Three (not enrolled this session).
-- Admin, librarian, accountant, teacher (with a staff record); admin of school B.
-- =====================================================================
begin;

create function private._l_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._l_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._l_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._l_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- the copy with an accession number, and the open loan of a copy (as the owner sees them)
create function private._l_copy(p_acc text) returns uuid language sql security definer set search_path = '' as $$
  select id from public.library_copies where school_id = 'b2300000-0000-4000-8000-00000000000a' and accession_number = p_acc;
$$;
create function private._l_loan(p_acc text) returns uuid language sql security definer set search_path = '' as $$
  select l.id from public.library_loans l join public.library_copies c on c.id = l.copy_id
  where c.school_id = 'b2300000-0000-4000-8000-00000000000a' and c.accession_number = p_acc
  order by (l.returned_on is null) desc, l.returned_on desc limit 1;  -- the open loan, else the latest returned
$$;
create function private._l_event(p_dedupe text) returns uuid language sql security definer set search_path = '' as $$
  select id from public.notification_events where dedupe_key = p_dedupe;
$$;
grant execute on function private._l_event(text) to erp_notify;
grant execute on function private._l_assert(boolean, text), private._l_eq(numeric, numeric, text), private._l_raises(text, text, text, text),
  private._l_as(uuid), private._l_copy(text), private._l_loan(text) to authenticated, erp_notify;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a2300000-0000-4000-8000-000000000001', 'lb-admin@example.invalid'),
  ('a2300000-0000-4000-8000-000000000002', 'lb-librarian@example.invalid'),
  ('a2300000-0000-4000-8000-000000000003', 'lb-accountant@example.invalid'),
  ('a2300000-0000-4000-8000-000000000004', 'lb-teacher@example.invalid'),
  ('a2300000-0000-4000-8000-000000000005', 'lb-parent@example.invalid'),
  ('a2300000-0000-4000-8000-000000000006', 'lb-student@example.invalid'),
  ('a2300000-0000-4000-8000-000000000007', 'lb-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b2300000-0000-4000-8000-00000000000a', 'Library A', 'ZZLB-A'),
  ('b2300000-0000-4000-8000-00000000000b', 'Library B', 'ZZLB-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b2300000-0000-4000-8000-00000000000a', 'a2300000-0000-4000-8000-000000000001', 'school_admin'),
  ('b2300000-0000-4000-8000-00000000000a', 'a2300000-0000-4000-8000-000000000002', 'librarian'),
  ('b2300000-0000-4000-8000-00000000000a', 'a2300000-0000-4000-8000-000000000003', 'accountant'),
  ('b2300000-0000-4000-8000-00000000000a', 'a2300000-0000-4000-8000-000000000004', 'teacher'),
  ('b2300000-0000-4000-8000-00000000000a', 'a2300000-0000-4000-8000-000000000005', 'parent'),
  ('b2300000-0000-4000-8000-00000000000a', 'a2300000-0000-4000-8000-000000000006', 'student'),
  ('b2300000-0000-4000-8000-00000000000b', 'a2300000-0000-4000-8000-000000000007', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c2300000-0000-4000-8000-000000000001', 'b2300000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true),
  ('c2300000-0000-4000-8000-000000000002', 'b2300000-0000-4000-8000-00000000000a', '2025-26', '2025-04-01', '2026-03-31', false);
insert into public.classes (id, school_id, name) values
  ('d2300000-0000-4000-8000-000000000001', 'b2300000-0000-4000-8000-00000000000a', 'Class 1');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d2300000-0000-4000-8000-0000000000a1', 'b2300000-0000-4000-8000-00000000000a', 'd2300000-0000-4000-8000-000000000001', 'c2300000-0000-4000-8000-000000000001', 'A'),
  ('d2300000-0000-4000-8000-0000000000b1', 'b2300000-0000-4000-8000-00000000000a', 'd2300000-0000-4000-8000-000000000001', 'c2300000-0000-4000-8000-000000000002', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f2300000-0000-4000-8000-000000000001', 'b2300000-0000-4000-8000-00000000000a', 'Child One', 'Parent One', '2019-01-01', 'male', '9800000011'),
  ('f2300000-0000-4000-8000-000000000002', 'b2300000-0000-4000-8000-00000000000a', 'Child Two', 'Father Two', '2019-02-02', 'female', '9800000022'),
  ('f2300000-0000-4000-8000-000000000003', 'b2300000-0000-4000-8000-00000000000a', 'Child Three', 'Father Three', '2018-03-03', 'female', '9800000033');
update public.students set account_id = 'a2300000-0000-4000-8000-000000000006' where id = 'f2300000-0000-4000-8000-000000000001';
insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date) values
  ('b2300000-0000-4000-8000-00000000000a', 'f2300000-0000-4000-8000-000000000001', 'c2300000-0000-4000-8000-000000000001', 'd2300000-0000-4000-8000-000000000001', 'd2300000-0000-4000-8000-0000000000a1', 'L1', '2026-04-01'),
  ('b2300000-0000-4000-8000-00000000000a', 'f2300000-0000-4000-8000-000000000002', 'c2300000-0000-4000-8000-000000000001', 'd2300000-0000-4000-8000-000000000001', 'd2300000-0000-4000-8000-0000000000a1', 'L2', '2026-04-01'),
  ('b2300000-0000-4000-8000-00000000000a', 'f2300000-0000-4000-8000-000000000003', 'c2300000-0000-4000-8000-000000000002', 'd2300000-0000-4000-8000-000000000001', 'd2300000-0000-4000-8000-0000000000b1', 'L3', '2025-04-01');
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b2300000-0000-4000-8000-00000000000a', 'f2300000-0000-4000-8000-000000000001', 'a2300000-0000-4000-8000-000000000005', 'father');
insert into public.teachers (id, school_id, employee_id, full_name, phone, email, joining_date, account_id) values
  ('a2340000-0000-4000-8000-000000000001', 'b2300000-0000-4000-8000-00000000000a', 'T-1', 'Teacher One', '9811111111', 'lb-teacher@example.invalid', '2020-06-01', 'a2300000-0000-4000-8000-000000000004');

-- ================= ISBN =================
select private._l_assert(private.isbn13('0-306-40615-2') = '9780306406157', 'an ISBN-10 is stored as its ISBN-13');
select private._l_assert(private.isbn13('978 0 306 40615 7') = '9780306406157', 'spaces and hyphens are ignored');
select private._l_assert(private.isbn13('080442957X') = '9780804429573', 'an X check digit is accepted');
select private._l_assert(private.isbn13('') is null, 'no ISBN is fine');
select private._l_raises($q$select private.isbn13('978-0-306-40615-8')$q$, '23514', 'a wrong check digit is refused', 'check digit');
select private._l_raises($q$select private.isbn13('0-306-40615-3')$q$, '23514', 'also for ISBN-10', 'check digit');
select private._l_raises($q$select private.isbn13('12345')$q$, '23514', 'so is a wrong length', '10 or 13');

-- ================= catalogue =================
select private._l_as('a2300000-0000-4000-8000-000000000002');  -- librarian
insert into public.library_categories (id, school_id, name) values
  ('a2350000-0000-4000-8000-000000000001', 'b2300000-0000-4000-8000-00000000000a', 'Fiction'),
  ('a2350000-0000-4000-8000-000000000002', 'b2300000-0000-4000-8000-00000000000a', 'Science');
insert into public.library_authors (id, school_id, name) values
  ('a2360000-0000-4000-8000-000000000001', 'b2300000-0000-4000-8000-00000000000a', 'R. K. Narayan');
insert into public.library_books (id, school_id, title, isbn, category_id, publication_year) values
  ('a2370000-0000-4000-8000-000000000001', 'b2300000-0000-4000-8000-00000000000a', 'Swami and Friends', '0-306-40615-2', 'a2350000-0000-4000-8000-000000000001', 1935),
  ('a2370000-0000-4000-8000-000000000002', 'b2300000-0000-4000-8000-00000000000a', 'Physics Part 1', null, 'a2350000-0000-4000-8000-000000000002', 2023),
  ('a2370000-0000-4000-8000-000000000003', 'b2300000-0000-4000-8000-00000000000a', 'Chemistry Part 1', null, 'a2350000-0000-4000-8000-000000000002', 2023);
insert into public.library_book_authors (book_id, author_id, school_id) values
  ('a2370000-0000-4000-8000-000000000001', 'a2360000-0000-4000-8000-000000000001', 'b2300000-0000-4000-8000-00000000000a');
select private._l_assert((select isbn = '9780306406157' from public.library_books where id = 'a2370000-0000-4000-8000-000000000001'),
  'the librarian adds books; the ISBN is normalised');
select private._l_raises($q$insert into public.library_books (school_id, title, isbn) values ('b2300000-0000-4000-8000-00000000000a', 'Copy', '9780306406157')$q$,
  '23505', 'an ISBN is used once per school');
select private._l_raises($q$insert into public.library_categories (school_id, name) values ('b2300000-0000-4000-8000-00000000000a', ' fiction ')$q$,
  '23505', 'category names are unique (ignoring case and spaces)');
select private._l_eq(private.library_add_copies('a2370000-0000-4000-8000-000000000001', 3, null, 250, '2026-04-10'), 3, 'three copies added');
select private._l_assert((select array_agg(accession_number order by accession_number) = array['ACC-000001', 'ACC-000002', 'ACC-000003']
  from public.library_copies where book_id = 'a2370000-0000-4000-8000-000000000001'), 'with the next accession numbers');
select private.library_add_copies('a2370000-0000-4000-8000-000000000002', 0, array['ACC-000004', 'PHY-2']);
select private._l_eq(private.library_add_copies('a2370000-0000-4000-8000-000000000003', 1), 1, 'auto numbering skips numbers typed by hand');
select private._l_assert((select accession_number = 'ACC-000005' from public.library_copies where book_id = 'a2370000-0000-4000-8000-000000000003'),
  'ACC-000004 was taken, so the next is ACC-000005');
select private._l_raises($q$select private.library_add_copies('a2370000-0000-4000-8000-000000000002', 0, array['phy-2'])$q$, '23505',
  'accession numbers are unique (ignoring case)', 'already used');
select private._l_raises($q$insert into public.library_copies (school_id, book_id, accession_number) values
  ('b2300000-0000-4000-8000-00000000000a', 'a2370000-0000-4000-8000-000000000002', 'X1')$q$, '42501', 'copies are added only through the function');
select private._l_raises($q$update public.library_copies set status = 'issued' where accession_number = 'PHY-2'$q$, '42501',
  'a copy''s status isn''t edited directly');
select private._l_raises($q$insert into public.library_settings (school_id, fine_per_day) values ('b2300000-0000-4000-8000-00000000000a', 5)$q$,
  '42501', 'librarians don''t set the rules or fines');
reset role;

select private._l_as('a2300000-0000-4000-8000-000000000004');  -- teacher
select private._l_raises($q$insert into public.library_books (school_id, title) values ('b2300000-0000-4000-8000-00000000000a', 'Mine')$q$,
  '42501', 'teachers can''t add books');
select private._l_raises($q$select private.library_add_copies('a2370000-0000-4000-8000-000000000002', 1)$q$, 'P0002', 'or copies');
select private._l_eq((select count(*) from public.library_books), 3, 'but see the catalogue');
select private._l_as('a2300000-0000-4000-8000-000000000005');  -- parent
select private._l_eq((select count(*) from public.library_copies), 6, 'so do parents');
select private._l_as('a2300000-0000-4000-8000-000000000007');  -- admin of B
select private._l_eq((select count(*) from public.library_books), 0, 'another school sees none of it');
select private._l_raises($q$select private.library_add_copies('a2370000-0000-4000-8000-000000000002', 1)$q$, 'P0002', 'nor adds to it');
reset role;

-- the admin sets the rules: Rs 2 a day after 1 grace day, at most Rs 20 a book, 2 books, 1 renewal
select private._l_as('a2300000-0000-4000-8000-000000000001');
insert into public.library_settings (school_id, fine_per_day, grace_days, max_fine, max_books_student, max_renewals)
values ('b2300000-0000-4000-8000-00000000000a', 2, 1, 20, 2, 1);
reset role;

-- ================= issuing =================
select private._l_as('a2300000-0000-4000-8000-000000000003');  -- accountant
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000001'), 'f2300000-0000-4000-8000-000000000001', null)$q$,
  'P0002', 'accountants don''t issue books');
select private._l_as('a2300000-0000-4000-8000-000000000002');  -- librarian
select private._l_assert(private.library_issue(private._l_copy('ACC-000001'), 'f2300000-0000-4000-8000-000000000001', null) is not null,
  'the librarian issues a book to Child One');
select private._l_assert((select status = 'issued' from public.library_copies where accession_number = 'ACC-000001'), 'the copy is now issued');
select private._l_assert((select borrower_name = 'Child One' and borrower_class = 'Class 1 – A' and due_date = private.ist_today() + 14
  and fine_per_day = 2 and grace_days = 1 and max_fine = 20 from public.library_loans where id = private._l_loan('ACC-000001')),
  'the loan keeps the borrower, class, a 14-day due date and the fine rules in force');
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000001'), 'f2300000-0000-4000-8000-000000000002', null)$q$,
  '23514', 'an issued copy can''t be issued again', 'not available');
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000002'), 'f2300000-0000-4000-8000-000000000001', null)$q$,
  '23514', 'one copy of a book per borrower', 'already has a copy');
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000002'), 'f2300000-0000-4000-8000-000000000003', null)$q$,
  '23514', 'a student not enrolled this session can''t borrow', 'current session');
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000002'), 'f2300000-0000-4000-8000-000000000002', 'a2340000-0000-4000-8000-000000000001')$q$,
  '23514', 'one borrower only', 'one borrower');
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000002'), 'f2300000-0000-4000-8000-000000000002', null, private.ist_today() - 1)$q$,
  '23514', 'the due date can''t be in the past', 'due date');
select private.library_issue(private._l_copy('ACC-000004'), 'f2300000-0000-4000-8000-000000000001', null);
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000005'), 'f2300000-0000-4000-8000-000000000001', null)$q$,
  '23514', 'the borrowing limit (2) is enforced', 'the limit is 2');
select private.library_issue(private._l_copy('ACC-000002'), null, 'a2340000-0000-4000-8000-000000000001');
select private._l_assert((select due_date = private.ist_today() + 30 and borrower_code = 'T-1' from public.library_loans
  where id = private._l_loan('ACC-000002')), 'staff borrow for 30 days');
select private._l_raises($q$update public.library_loans set due_date = due_date + 10$q$, '42501', 'loans are never edited directly');
select private._l_raises($q$insert into public.library_loans (school_id, copy_id, book_id, student_id, borrower_name, issued_on, due_date, fine_per_day, grace_days)
  values ('b2300000-0000-4000-8000-00000000000a', private._l_copy('ACC-000003'), 'a2370000-0000-4000-8000-000000000001',
          'f2300000-0000-4000-8000-000000000002', 'x', current_date, current_date, 0, 0)$q$, '42501', 'or written');
reset role;

-- ================= who sees which loans =================
select private._l_as('a2300000-0000-4000-8000-000000000005');
select private._l_eq((select count(*) from public.library_loans), 2, 'Parent One sees Child One''s two loans');
select private._l_as('a2300000-0000-4000-8000-000000000006');
select private._l_eq((select count(*) from public.library_loans where student_id = 'f2300000-0000-4000-8000-000000000001'), 2,
  'Child One sees their own');
select private._l_eq((select count(*) from public.library_loans where teacher_id is not null), 0, 'and nobody else''s');
select private._l_as('a2300000-0000-4000-8000-000000000004');
select private._l_eq((select count(*) from public.library_loans), 1, 'the teacher sees only their own loan');
select private._l_as('a2300000-0000-4000-8000-000000000003');
select private._l_eq((select count(*) from public.library_loans), 3, 'the accountant sees all (for fines)');
select private._l_as('a2300000-0000-4000-8000-000000000007');
select private._l_eq((select count(*) from public.library_loans), 0, 'another school sees none');
reset role;

-- ================= renewals =================
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private._l_assert(private.library_renew(private._l_loan('ACC-000004')) = private.ist_today() + 28, 'a renewal adds another 14 days to the due date');
select private._l_raises($q$select private.library_renew(private._l_loan('ACC-000004'))$q$, '23514', 'one renewal allowed', 'most times');
reset role;

-- ================= overdue and fines =================
-- (the test moves dates into the past, as the owner; the loan guard forbids it for everyone else)
alter table public.library_loans disable trigger library_loans_guard;
update public.library_loans set issued_on = private.ist_today() - 20, due_date = private.ist_today() - 6 where id = private._l_loan('ACC-000001');
alter table public.library_loans enable trigger library_loans_guard;
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private._l_eq((select private.library_loan_due(l) from public.library_loans l where id = private._l_loan('ACC-000001')), 10,
  '6 days late, 1 grace day, Rs 2 a day: Rs 10 so far');
select private._l_raises($q$select private.library_renew(private._l_loan('ACC-000001'))$q$, '23514', 'an overdue book can''t be renewed', 'overdue');
select private._l_raises($q$select private.library_return(private._l_loan('ACC-000001'), 'good', private.ist_today() + 1)$q$, '23514',
  'a return can''t be dated in the future');
select private._l_raises($q$select private.library_return(private._l_loan('ACC-000001'), 'good', null, 50)$q$, '23514',
  'a good return has no charge', 'no charge');
select private._l_assert((select fine_amount = 10 and book_charge = 0 and fine_status = 'unpaid' and return_condition = 'good'
  from private.library_return(private._l_loan('ACC-000001'))), 'returned: Rs 10 fine, unpaid');
select private._l_assert((select status = 'available' from public.library_copies where accession_number = 'ACC-000001'), 'the copy is back on the shelf');
select private._l_raises($q$select private.library_return(private._l_loan('ACC-000001'))$q$, '23514', 'a book is returned once', 'already returned');
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000001'), 'f2300000-0000-4000-8000-000000000001', null)$q$,
  '23514', 'an unpaid fine blocks borrowing', 'unpaid library fine');
reset role;
-- an older overdue loan for Child Two: capped at Rs 20, and it blocks new loans
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private.library_issue(private._l_copy('ACC-000005'), 'f2300000-0000-4000-8000-000000000002', null);
reset role;
alter table public.library_loans disable trigger library_loans_guard;
update public.library_loans set issued_on = private.ist_today() - 45, due_date = private.ist_today() - 30 where id = private._l_loan('ACC-000005');
alter table public.library_loans enable trigger library_loans_guard;
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private._l_eq((select private.library_loan_due(l) from public.library_loans l where id = private._l_loan('ACC-000005')), 20,
  'the fine stops at the cap (Rs 20)');
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000003'), 'f2300000-0000-4000-8000-000000000002', null)$q$,
  '23514', 'an overdue book blocks borrowing', 'overdue book');
reset role;

-- collecting: accountants may; a reference is needed for non-cash
select private._l_as('a2300000-0000-4000-8000-000000000003');
select private._l_raises($q$select private.library_collect_fine(private._l_loan('ACC-000001'), 'upi')$q$, '23514', 'UPI needs a reference', 'reference');
select private._l_assert(private.library_collect_fine(private._l_loan('ACC-000001'), 'upi', 'UPI-777') = 'LIB-000001', 'collected, with a receipt number');
select private._l_assert((select fine_status = 'paid' and fine_paid_amount = 10 and fine_reference = 'UPI-777' from public.library_loans
  where id = private._l_loan('ACC-000001')), 'the fine is paid in full');
select private._l_raises($q$select private.library_collect_fine(private._l_loan('ACC-000001'), 'cash')$q$, '23514', 'and can''t be collected twice', 'nothing to collect');
select private._l_raises($q$select private.library_collect_fine(private._l_loan('ACC-000004'), 'cash')$q$, '23514', 'an open loan has nothing to collect yet');
reset role;

-- lost and damaged books
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private._l_raises($q$select private.library_return(private._l_loan('ACC-000004'), 'lost')$q$, '23514',
  'a lost copy with no price needs a charge', 'charge');
select private._l_assert((select book_charge = 350 and fine_amount = 0 and fine_status = 'unpaid' from private.library_return(private._l_loan('ACC-000004'), 'lost', null, 350)),
  'lost: Rs 350 to pay');
select private._l_assert((select status = 'lost' from public.library_copies where accession_number = 'ACC-000004'), 'the copy is marked lost');
update public.library_copies set price = 250 where accession_number = 'ACC-000005';  -- librarians may record a copy's price
select private._l_assert((select book_charge = 250 and fine_amount = 20 from private.library_return(private._l_loan('ACC-000005'), 'lost')),
  'a lost copy with a price is charged its price (Rs 250) plus the fine (Rs 20)');
select private._l_raises($q$select private.library_waive_fine(private._l_loan('ACC-000004'), 'Family hardship')$q$, '42501',
  'librarians can''t waive fines', 'school admins');
reset role;
select private._l_as('a2300000-0000-4000-8000-000000000001');
select private._l_raises($q$select private.library_waive_fine(private._l_loan('ACC-000004'), '')$q$, '23514', 'waiving needs a reason', 'reason');
select private.library_waive_fine(private._l_loan('ACC-000004'), 'Book found damaged in the classroom');
select private._l_assert((select fine_status = 'waived' and fine_waived_at is not null from public.library_loans where id = private._l_loan('ACC-000004')),
  'an admin waives a fine with a reason');
select private._l_raises($q$select private.library_collect_fine(private._l_loan('ACC-000004'), 'cash')$q$, '23514', 'a waived fine isn''t collected');
reset role;

-- ================= copies =================
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private._l_raises($q$select private.library_set_copy_status(private._l_copy('ACC-000002'), 'withdrawn')$q$, '23514',
  'a copy on loan can''t be withdrawn', 'Return it first');
select private._l_raises($q$select private.library_set_copy_status(private._l_copy('ACC-000003'), 'issued')$q$, '23514',
  'nobody marks a copy issued by hand');
select private.library_set_copy_status(private._l_copy('ACC-000003'), 'damaged', 'Torn cover');
select private._l_raises($q$select private.library_issue(private._l_copy('ACC-000003'), 'f2300000-0000-4000-8000-000000000001', null)$q$,
  '23514', 'a damaged copy isn''t issued', 'not available');
select private._l_raises($q$delete from public.library_books where id = 'a2370000-0000-4000-8000-000000000001'$q$, '23503',
  'a book with copies isn''t deleted (withdraw it instead)');
select private._l_raises($q$delete from public.library_copies where accession_number = 'ACC-000001'$q$, '23503',
  'a copy with loans isn''t deleted');
select private._l_raises($q$delete from public.library_categories where name = 'Science'$q$, '23503', 'a category in use isn''t deleted');
reset role;
select private._l_raises($q$delete from public.library_loans$q$, '23514', 'loans are never deleted, even by the owner', 'borrowing history');

-- ================= borrowers and dashboard =================
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private._l_assert((select count(*) = 2 and bool_and(kind = 'student') from private.library_find_borrowers('b2300000-0000-4000-8000-00000000000a', 'child')),
  'borrower search: current students only (Child Three isn''t enrolled this session)');
select private._l_assert((select fines_due = 250 + 20 and open_loans = 0 from private.library_find_borrowers('b2300000-0000-4000-8000-00000000000a', 'two')),
  'with what they owe');
select private._l_assert((select name = 'Child Two' and detail like 'Class 1 – A%' and fines_due = 270 and max_books = 2 and loan_days = 14
  from private.library_borrower('b2300000-0000-4000-8000-00000000000a', 'student', 'f2300000-0000-4000-8000-000000000002')),
  'one borrower''s summary, with the limits');
select private._l_eq((select count(*) from private.library_borrower('b2300000-0000-4000-8000-00000000000a', 'student', 'a2340000-0000-4000-8000-000000000001')), 0,
  'a staff id is not a student');
select private._l_assert((select kind = 'staff' and open_loans = 1 from private.library_find_borrowers('b2300000-0000-4000-8000-00000000000a', 't-1')),
  'staff by employee id');
select private._l_assert((select (d->>'titles')::int = 3 and (d->>'copies')::int = 6 and (d->>'issued')::int = 1 and (d->>'available')::int = 2
  and (d->>'lost')::int = 2 and (d->>'damaged')::int = 1 and (d->>'overdue')::int = 0 and (d->>'fines_unpaid')::numeric = 270
  and (d->>'fines_collected_total')::numeric = 10 and (d->>'fines_waived_total')::numeric = 350
  from private.library_dashboard('b2300000-0000-4000-8000-00000000000a') d), 'the dashboard adds up');
select private._l_as('a2300000-0000-4000-8000-000000000004');
select private._l_raises($q$select private.library_dashboard('b2300000-0000-4000-8000-00000000000a')$q$, '42501', 'teachers don''t see the dashboard');
select private._l_raises($q$select * from private.library_find_borrowers('b2300000-0000-4000-8000-00000000000a', 'child')$q$, '42501',
  'or search borrowers');
select private._l_raises($q$select * from private.library_borrower('b2300000-0000-4000-8000-00000000000a', 'student', 'f2300000-0000-4000-8000-000000000002')$q$,
  '42501', 'or look one up');
reset role;

-- ================= overdue message (Phase 22 notifications) =================
select private._l_as('a2300000-0000-4000-8000-000000000002');
select set_config('lt.loan', private.library_issue(private._l_copy('ACC-000001'), 'f2300000-0000-4000-8000-000000000001', null)::text, false);  -- Child One paid up
reset role;
alter table public.library_loans disable trigger library_loans_guard;
update public.library_loans set issued_on = private.ist_today() - 10, due_date = private.ist_today() - 3 where id = current_setting('lt.loan')::uuid;
alter table public.library_loans enable trigger library_loans_guard;
set local role erp_notify;
select private._l_eq(private.notify_library_overdue(),
  case when extract(hour from now() at time zone 'Asia/Kolkata') >= 9 then 1 else 0 end, 'one message per overdue student loan, from 9 am');
select private._l_eq(private.notify_library_overdue(), 0, 'and never twice for the same loan');
reset role;
select private.notify_enqueue('b2300000-0000-4000-8000-00000000000a', 'library_overdue', 'library_overdue:' || current_setting('lt.loan')::uuid,
  'f2300000-0000-4000-8000-000000000001', jsonb_build_object('loan_id', current_setting('lt.loan')::uuid));
set local role erp_notify;
select private._l_assert((select c->'vars'->>'book_title' = 'Swami and Friends' and (c->'vars'->>'days_overdue')::int = 3
  and (c->'vars'->>'fine_so_far')::numeric = 4 and c->'skip' = 'null'::jsonb
  and c->'recipients' @> '[{"kind":"parent","user_id":"a2300000-0000-4000-8000-000000000005"}]'
  and c->'recipients' @> '[{"kind":"student","user_id":"a2300000-0000-4000-8000-000000000006"}]'
  from private.notify_event_context(private._l_event('library_overdue:' || current_setting('lt.loan')::uuid)) c),
  'the message names the book, days late and fine so far, for the parent and the student');
reset role;
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private.library_return(current_setting('lt.loan')::uuid);
reset role;
set local role erp_notify;
select private._l_assert((select c->>'skip' like '%returned%'
  from private.notify_event_context(private._l_event('library_overdue:' || current_setting('lt.loan')::uuid)) c),
  'a book returned before sending is not chased');
reset role;
select private._l_as('a2300000-0000-4000-8000-000000000002');
select private._l_raises($q$select private.notify_library_overdue()$q$, '42501', 'only the sender runs the overdue job');
reset role;

do $$ begin raise notice 'ALL LIBRARY TESTS PASSED'; end $$;
rollback;
