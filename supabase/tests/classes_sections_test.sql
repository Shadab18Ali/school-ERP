-- =====================================================================
-- Class & section rules test (migrations 0001-0005).
-- Run in Supabase SQL Editor. Rolls back; leaves nothing behind.
-- Pass = last row says "ALL CLASS & SECTION TESTS PASSED".
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
create function private._t_rows(stmt text, n int, msg text) returns void language plpgsql as $$
declare got int;
begin
  begin
    execute stmt; get diagnostics got = row_count;
  exception when others then
    raise exception 'FAIL: % (error: %)', msg, sqlerrm using errcode = 'ZT001';
  end;
  if got <> n then raise exception 'FAIL: % (affected % rows, expected %)', msg, got, n using errcode = 'ZT001'; end if;
end $$;
create function private._t_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function private._t_assert(boolean, text), private._t_raises(text, text, text, text),
  private._t_rows(text, int, text), private._t_as(uuid) to authenticated;

-- fixtures
insert into auth.users (id, email) values
  ('a2000000-0000-4000-8000-000000000001', 'cls-test-admin-a@example.invalid'),
  ('a2000000-0000-4000-8000-000000000002', 'cls-test-teacher-a@example.invalid'),
  ('a2000000-0000-4000-8000-000000000003', 'cls-test-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b2000000-0000-4000-8000-00000000000a', 'Class Test A', 'ZZCLS-A'),
  ('b2000000-0000-4000-8000-00000000000b', 'Class Test B', 'ZZCLS-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b2000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000001', 'school_admin'),
  ('b2000000-0000-4000-8000-00000000000a', 'a2000000-0000-4000-8000-000000000002', 'teacher'),
  ('b2000000-0000-4000-8000-00000000000b', 'a2000000-0000-4000-8000-000000000003', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-00000000000a', '2025-26', '2025-04-01', '2026-03-31', false),
  ('c2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true),
  ('c2000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-00000000000b', '2026-27', '2026-04-01', '2027-03-31', true);
insert into public.classes (id, school_id, name, display_order) values
  ('d2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-00000000000a', 'Class 1', 4),
  ('d2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-00000000000a', 'Class 2', 5),
  ('d2000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-00000000000b', 'Class 1', 4);
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('e2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-00000000000a',
   'd2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'A'),
  ('e2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-00000000000a',
   'd2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000002', 'A'),
  ('e2000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-00000000000b',
   'd2000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000003', 'A');

-- ================= school admin A =================
select private._t_as('a2000000-0000-4000-8000-000000000001');

-- class soft delete is guarded while it has live sections
select private._t_raises($q$update public.classes set deleted_at = now() where id = 'd2000000-0000-4000-8000-000000000001'$q$,
  '23001', 'a class with live sections cannot be deleted', '2 section(s)');

-- hard delete is not available to users (no policy: zero rows)
select private._t_rows($q$delete from public.classes where id = 'd2000000-0000-4000-8000-000000000002'$q$, 0,
  'users cannot hard-delete classes');
select private._t_rows($q$delete from public.sections where id = 'e2000000-0000-4000-8000-000000000002'$q$, 0,
  'users cannot hard-delete sections');

-- soft delete a section, then the name can be reused; deleted row is forced inactive
select private._t_rows($q$update public.sections set deleted_at = now() where id = 'e2000000-0000-4000-8000-000000000002'$q$, 1,
  'admin can soft-delete a section');
select private._t_assert((select not is_active from public.sections where id = 'e2000000-0000-4000-8000-000000000002'),
  'soft-deleted section is automatically inactive');
select private._t_rows($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000001',
          'c2000000-0000-4000-8000-000000000002', 'a')$q$, 1, 'deleted section name can be reused');
select private._t_raises($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000001',
          'c2000000-0000-4000-8000-000000000002', ' A ')$q$, '23505', 'live section names stay unique');
-- restoring the old "A" now collides with the new live "a"
select private._t_raises($q$update public.sections set deleted_at = null where id = 'e2000000-0000-4000-8000-000000000002'$q$,
  '23505', 'restore is refused when the name is taken again');

-- inactive class: no new sections
select private._t_rows($q$update public.classes set is_active = false where id = 'd2000000-0000-4000-8000-000000000002'$q$, 1,
  'admin can deactivate a class');
select private._t_raises($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000002',
          'c2000000-0000-4000-8000-000000000002', 'A')$q$, '23514', 'no sections in an inactive class', 'inactive');
select private._t_rows($q$update public.classes set is_active = true where id = 'd2000000-0000-4000-8000-000000000002'$q$, 1,
  'admin can activate a class');

-- move a section to another class (no students): allowed
select private._t_rows($q$update public.sections set class_id = 'd2000000-0000-4000-8000-000000000002'
  where id = 'e2000000-0000-4000-8000-000000000001'$q$, 1, 'section can be re-assigned to another class');
-- but not to another session
select private._t_raises($q$update public.sections set academic_session_id = 'c2000000-0000-4000-8000-000000000002'
  where id = 'e2000000-0000-4000-8000-000000000001'$q$, '23514', 'sections cannot change session');
-- and never to a class of another school (composite FK)
select private._t_raises($q$update public.sections set class_id = 'd2000000-0000-4000-8000-000000000003'
  where id = 'e2000000-0000-4000-8000-000000000001'$q$, '23503', 'sections cannot point at another school''s class');

-- delete a class once its sections are gone; name becomes reusable
select private._t_rows($q$update public.sections set deleted_at = now() where class_id = 'd2000000-0000-4000-8000-000000000002' and deleted_at is null$q$, 1,
  'admin can soft-delete the moved section');
select private._t_rows($q$update public.classes set deleted_at = now() where id = 'd2000000-0000-4000-8000-000000000002'$q$, 1,
  'admin can soft-delete an empty class');
select private._t_assert((select not is_active from public.classes where id = 'd2000000-0000-4000-8000-000000000002'),
  'soft-deleted class is automatically inactive');
select private._t_rows($q$insert into public.classes (school_id, name) values ('b2000000-0000-4000-8000-00000000000a', 'class 2')$q$, 1,
  'deleted class name can be reused');
-- deleted class: no new sections, restore of its sections refused
select private._t_raises($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000002',
          'c2000000-0000-4000-8000-000000000002', 'Z')$q$, '23514', 'no sections in a deleted class', 'deleted');

-- student counts are available for own sections
select private._t_assert((select count(*) from private.section_student_counts(array['e2000000-0000-4000-8000-000000000001'::uuid])) = 1,
  'student counts return one row per section');
reset role;

-- archived session: its sections are read-only, for everyone
update public.academic_sessions set archived_at = now() where id = 'c2000000-0000-4000-8000-000000000001';
select private._t_raises($q$update public.sections set room = 'R1' where academic_session_id = 'c2000000-0000-4000-8000-000000000001'$q$,
  '23514', 'sections of an archived session are read-only', 'archived');
select private._t_raises($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b2000000-0000-4000-8000-00000000000a', 'd2000000-0000-4000-8000-000000000001',
          'c2000000-0000-4000-8000-000000000001', 'Q')$q$, '23514', 'no new sections in an archived session');

-- the guard blocks deleting a section that has students: simulate the students
-- module by temporarily replacing the count function
create or replace function private.section_student_counts(p_section_ids uuid[])
returns table (section_id uuid, student_count bigint)
language sql stable security definer set search_path = '' as $$ select id, 30::bigint from unnest(p_section_ids) as id; $$;
select private._t_raises($q$update public.sections set deleted_at = now()
  where name = 'a' and academic_session_id = 'c2000000-0000-4000-8000-000000000002'$q$,
  '23001', 'a section with students cannot be deleted', '30 student(s)');
select private._t_raises($q$update public.sections set class_id = 'd2000000-0000-4000-8000-000000000001'
  where id = 'e2000000-0000-4000-8000-000000000001'$q$,
  '23514', 'a section in an archived session cannot move');  -- archived check comes first

-- ================= teacher A: read only =================
select private._t_as('a2000000-0000-4000-8000-000000000002');
select private._t_assert((select count(*) from public.classes where school_id <> 'b2000000-0000-4000-8000-00000000000a') = 0,
  'teacher sees only own school''s classes');
select private._t_raises($q$insert into public.classes (school_id, name) values ('b2000000-0000-4000-8000-00000000000a', 'T')$q$,
  '42501', 'teacher cannot add classes');
select private._t_rows($q$update public.classes set name = 'Hacked' where id = 'd2000000-0000-4000-8000-000000000001'$q$, 0,
  'teacher cannot edit classes');
reset role;

-- ================= admin B cannot touch A =================
select private._t_as('a2000000-0000-4000-8000-000000000003');
select private._t_rows($q$update public.classes set is_active = false where id = 'd2000000-0000-4000-8000-000000000001'$q$, 0,
  'admin B cannot deactivate School A''s class');
select private._t_rows($q$update public.sections set deleted_at = now() where school_id = 'b2000000-0000-4000-8000-00000000000a'$q$, 0,
  'admin B cannot delete School A''s sections');
reset role;

-- deleting a whole school still removes everything (deliberate super-admin action)
delete from public.schools where id = 'b2000000-0000-4000-8000-00000000000a';
select private._t_assert(not exists (select 1 from public.classes where school_id = 'b2000000-0000-4000-8000-00000000000a'),
  'deleting a school still cascades');

select 'ALL CLASS & SECTION TESTS PASSED' as result;
rollback;
