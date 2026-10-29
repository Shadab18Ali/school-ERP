-- =====================================================================
-- Academic-session lifecycle & deletion-safety test (migrations 0001-0003).
-- Run in Supabase SQL Editor. Rolls back; leaves nothing behind.
-- Pass = last row says "ALL SESSION TESTS PASSED"; failure = error "FAIL: ...".
-- =====================================================================
begin;

create function private._t_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._t_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._t_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function private._t_assert(boolean, text), private._t_raises(text, text, text, text), private._t_as(uuid) to authenticated;

-- fixtures
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'sess-test-admin-a@example.invalid'),
  ('a1000000-0000-4000-8000-000000000002', 'sess-test-teacher-a@example.invalid'),
  ('a1000000-0000-4000-8000-000000000003', 'sess-test-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b1000000-0000-4000-8000-00000000000a', 'Session Test A', 'ZZSESS-A'),
  ('b1000000-0000-4000-8000-00000000000b', 'Session Test B', 'ZZSESS-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b1000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000001', 'school_admin'),
  ('b1000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000002', 'teacher'),
  ('b1000000-0000-4000-8000-00000000000b', 'a1000000-0000-4000-8000-000000000003', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000a', '2025-26', '2025-04-01', '2026-03-31', false),
  ('c1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true),
  ('c1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-00000000000a', '2027-28', '2027-04-01', '2028-03-31', false),
  ('c1000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-00000000000b', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name) values
  ('d1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-00000000000a', 'Class 1');
insert into public.sections (school_id, class_id, academic_session_id, name) values
  ('b1000000-0000-4000-8000-00000000000a', 'd1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'A');

-- A stand-in for a FUTURE student/fee table, declared the dangerous way
-- (ON DELETE CASCADE) to prove the guard protects tables that don't exist yet.
create table public.zz_future_fee_records (
  id uuid primary key default gen_random_uuid(),
  academic_session_id uuid not null references public.academic_sessions (id) on delete cascade
);
insert into public.zz_future_fee_records (academic_session_id) values
  ('c1000000-0000-4000-8000-000000000003'), ('c1000000-0000-4000-8000-000000000003');

-- ---------- usage detection ----------
select private._t_assert(
  (select row_count from private.session_usage_unchecked('c1000000-0000-4000-8000-000000000001') where table_name = 'sections') = 1,
  'usage counts sections');
select private._t_assert(
  (select row_count from private.session_usage_unchecked('c1000000-0000-4000-8000-000000000003') where table_name = 'zz_future_fee_records') = 2,
  'usage discovers tables added later');

-- ---------- deletion guard (applies even to the database owner) ----------
select private._t_raises($q$delete from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000002'$q$,
  '23001', 'the current session cannot be deleted', 'current academic session');
select private._t_raises($q$delete from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000001'$q$,
  '23001', 'a session with sections cannot be deleted', '1 sections');
select private._t_raises($q$delete from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000003'$q$,
  '23001', 'a session with (future) fee records cannot be deleted, even with ON DELETE CASCADE', '2 zz_future_fee_records');
select private._t_assert((select count(*) from public.zz_future_fee_records) = 2, 'no fee records were cascaded away');

-- ---------- archive rules ----------
select private._t_raises($q$update public.academic_sessions set archived_at = now() where id = 'c1000000-0000-4000-8000-000000000002'$q$,
  '23514', 'the current session cannot be archived');

-- ---------- school admin A ----------
select private._t_as('a1000000-0000-4000-8000-000000000001');
update public.academic_sessions set archived_at = now() where id = 'c1000000-0000-4000-8000-000000000001';
select private._t_assert((select archived_at is not null from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000001'),
  'admin can archive a past session');
select private._t_raises($q$select private.set_current_academic_session('c1000000-0000-4000-8000-000000000001')$q$,
  '23514', 'an archived session cannot be made current', 'Restore it first');
select private.set_current_academic_session('c1000000-0000-4000-8000-000000000003');
select private._t_assert(
  (select string_agg(name, ',') from public.academic_sessions where is_current and school_id = 'b1000000-0000-4000-8000-00000000000a') = '2027-28',
  'admin can switch the current session; exactly one is current');
select private._t_assert(
  (select sum(row_count) from private.academic_session_usage('c1000000-0000-4000-8000-000000000001')) = 1,
  'admin can see usage of own school''s session');
select private._t_raises($q$select * from private.academic_session_usage('c1000000-0000-4000-8000-000000000004')$q$,
  'P0002', 'admin A cannot probe usage of School B''s session');
select private._t_raises($q$select private.set_current_academic_session('c1000000-0000-4000-8000-000000000004')$q$,
  'P0002', 'admin A cannot switch School B''s session');
-- the former current session (2026-27) is unused and no longer current: deletable
select private._t_assert((select count(*) from private.academic_session_usage('c1000000-0000-4000-8000-000000000002')) = 0,
  '2026-27 has no records');
delete from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000002';
select private._t_assert(not exists (select 1 from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000002'),
  'an unused, non-current session can be deleted');
select private._t_raises($q$delete from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000003'$q$,
  '23001', 'guard also applies to school admins (2027-28 is now current)', 'current academic session');
reset role;

select private._t_assert(
  (select is_current from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000004'),
  'switching School A''s session did not touch School B (checked as owner)');

-- ---------- teacher: read-only ----------
select private._t_as('a1000000-0000-4000-8000-000000000002');
select private._t_assert((select count(*) from public.academic_sessions) = 2, 'teacher can view sessions');
select private._t_raises($q$select private.set_current_academic_session('c1000000-0000-4000-8000-000000000001')$q$,
  '23514', 'teacher is stopped (archived check comes first)');
update public.academic_sessions set archived_at = now() where id = 'c1000000-0000-4000-8000-000000000003';
select private._t_assert((select archived_at is null from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000003'),
  'teacher cannot archive (RLS silently filters the update)');
reset role;

-- ---------- deleting a whole school still works ----------
delete from public.schools where id = 'b1000000-0000-4000-8000-00000000000b';
select private._t_assert(not exists (select 1 from public.academic_sessions where id = 'c1000000-0000-4000-8000-000000000004'),
  'deleting a school removes its sessions, including the current one');

-- ---------- school profile constraints ----------
select private._t_raises($q$update public.schools set udise_code = '12345' where id = 'b1000000-0000-4000-8000-00000000000a'$q$,
  '23514', 'UDISE code must be 11 digits');
select private._t_raises($q$update public.schools set established_year = 1500 where id = 'b1000000-0000-4000-8000-00000000000a'$q$,
  '23514', 'established year must be realistic');

select 'ALL SESSION TESTS PASSED' as result;
rollback;
