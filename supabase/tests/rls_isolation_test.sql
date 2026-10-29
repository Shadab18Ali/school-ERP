-- =====================================================================
-- Tenant-isolation & integrity test for migrations 0001 + 0002.
--
-- HOW TO RUN: paste the whole file into Supabase Dashboard > SQL Editor > Run.
-- SAFE: everything happens inside one transaction that is ROLLED BACK at the
-- end. No test users, schools or rows are left behind.
--
-- RESULT: the last row says "ALL ... TESTS PASSED". Any failure stops the
-- script with an error whose message starts with "FAIL:".
-- =====================================================================
begin;

-- ---------- tiny test harness (rolled back with everything else) ----------
create function private._t_assert(ok boolean, msg text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if;
end $$;

-- statement must fail with the expected SQLSTATE
create function private._t_raises(stmt text, expected text, msg text) returns void language plpgsql as $$
declare st text;
begin
  begin
    execute stmt;
  exception when others then
    st := sqlstate;
  end;
  if st is null then
    raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001';
  elsif st <> expected then
    raise exception 'FAIL: % (got SQLSTATE %, expected %)', msg, st, expected using errcode = 'ZT001';
  end if;
end $$;

-- statement must succeed and touch exactly n rows
create function private._t_rows(stmt text, n int, msg text) returns void language plpgsql as $$
declare got int;
begin
  execute stmt;
  get diagnostics got = row_count;
  if got <> n then raise exception 'FAIL: % (affected % rows, expected %)', msg, got, n using errcode = 'ZT001'; end if;
end $$;

-- impersonate a signed-in user exactly like the API does
create function private._t_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

grant execute on function private._t_assert(boolean, text), private._t_raises(text, text, text),
  private._t_rows(text, int, text), private._t_as(uuid) to authenticated;

-- ---------- fixtures (as the database owner) ----------
-- users: super admin, admin A, teacher A, admin B, outsider
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'rls-test-super@example.invalid',    '{"full_name":"T Super"}'),
  ('a0000000-0000-4000-8000-000000000002', 'rls-test-admin-a@example.invalid',  '{"full_name":"T Admin A"}'),
  ('a0000000-0000-4000-8000-000000000003', 'rls-test-teacher-a@example.invalid','{"full_name":"T Teacher A"}'),
  ('a0000000-0000-4000-8000-000000000004', 'rls-test-admin-b@example.invalid',  '{"full_name":"T Admin B"}'),
  ('a0000000-0000-4000-8000-000000000005', 'rls-test-outsider@example.invalid', '{"full_name":"T Outsider"}');

select private._t_assert((select count(*) from public.profiles where email like 'rls-test-%@example.invalid') = 5,
  'profiles are auto-created for new auth users');

update public.profiles set is_super_admin = true where id = 'a0000000-0000-4000-8000-000000000001';

insert into public.schools (id, name, code) values
  ('b0000000-0000-4000-8000-00000000000a', 'RLS Test School A', 'ZZRLS-A'),
  ('b0000000-0000-4000-8000-00000000000b', 'RLS Test School B', 'ZZRLS-B');

insert into public.school_memberships (school_id, user_id, role) values
  ('b0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000002', 'school_admin'),
  ('b0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000003', 'teacher'),
  ('b0000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000004', 'school_admin');

insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a', '2025-26', '2025-04-01', '2026-03-31', false),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-00000000000b', '2026-27', '2026-04-01', '2027-03-31', true);

insert into public.classes (id, school_id, name, display_order) values
  ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a', 'Class 1', 1),
  ('d0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000a', 'Class 2', 2),
  ('d0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-00000000000b', 'Class 1', 1);

insert into public.sections (id, school_id, class_id, academic_session_id, name, capacity) values
  ('e0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-00000000000a',
   'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000002', 'A', 40),
  ('e0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-00000000000b',
   'd0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', 'A', 35);

-- ---------- data integrity (applies to everyone, even the owner) ----------
select private._t_raises($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-000000000003',
          'c0000000-0000-4000-8000-000000000002', 'X')$q$,
  '23503', 'section in School A cannot point at a class of School B');
select private._t_raises($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000003', 'X')$q$,
  '23503', 'section in School A cannot point at a session of School B');
select private._t_raises($q$update public.classes set school_id = 'b0000000-0000-4000-8000-00000000000b'
  where id = 'd0000000-0000-4000-8000-000000000002'$q$,
  '23000', 'a class can never be moved to another school');
select private._t_raises($q$insert into public.academic_sessions (school_id, name, start_date, end_date)
  values ('b0000000-0000-4000-8000-00000000000a', 'Overlap', '2026-01-01', '2026-06-30')$q$,
  '23P01', 'overlapping sessions in one school are rejected');
select private._t_raises($q$insert into public.academic_sessions (school_id, name, start_date, end_date, is_current)
  values ('b0000000-0000-4000-8000-00000000000a', '2027-28', '2027-04-01', '2028-03-31', true)$q$,
  '23505', 'only one current session per school');
select private._t_raises($q$insert into public.academic_sessions (school_id, name, start_date, end_date)
  values ('b0000000-0000-4000-8000-00000000000a', 'Backwards', '2030-03-31', '2030-01-01')$q$,
  '23514', 'session must end after it starts');
select private._t_raises($q$insert into public.classes (school_id, name)
  values ('b0000000-0000-4000-8000-00000000000a', '  class 1 ')$q$,
  '23505', 'class names are unique per school (case and spaces ignored)');
select private._t_raises($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000002', 'a')$q$,
  '23505', 'section names are unique per class and session');
select private._t_raises($q$delete from public.classes where id = 'd0000000-0000-4000-8000-000000000001'$q$,
  '23503', 'a class that still has sections cannot be deleted');
-- same class name is fine in a different school
select private._t_rows($q$insert into public.classes (school_id, name)
  values ('b0000000-0000-4000-8000-00000000000b', 'Class 2')$q$, 1, 'same class name allowed in another school');

-- ---------- super admin ----------
select private._t_as('a0000000-0000-4000-8000-000000000001');
select private._t_assert((select count(*) from public.classes
  where school_id in ('b0000000-0000-4000-8000-00000000000a','b0000000-0000-4000-8000-00000000000b')) = 4,
  'super admin sees classes of every school');
select private._t_rows($q$insert into public.classes (school_id, name)
  values ('b0000000-0000-4000-8000-00000000000b', 'Class 3')$q$, 1, 'super admin can write to any school');
reset role;

-- ---------- admin of School A ----------
select private._t_as('a0000000-0000-4000-8000-000000000002');
select private._t_assert((select count(*) from public.academic_sessions where school_id <> 'b0000000-0000-4000-8000-00000000000a') = 0,
  'admin A sees no sessions of other schools');
select private._t_assert((select count(*) from public.classes where school_id <> 'b0000000-0000-4000-8000-00000000000a') = 0,
  'admin A sees no classes of other schools');
select private._t_assert((select count(*) from public.sections where school_id <> 'b0000000-0000-4000-8000-00000000000a') = 0,
  'admin A sees no sections of other schools');
select private._t_assert((select count(*) from public.schools where id <> 'b0000000-0000-4000-8000-00000000000a') = 0,
  'admin A sees no other schools');
select private._t_assert((select count(*) from public.classes) = 2, 'admin A sees both of School A''s classes');
select private._t_rows($q$insert into public.classes (school_id, name)
  values ('b0000000-0000-4000-8000-00000000000a', 'Class 3')$q$, 1, 'admin A can create a class in School A');
select private._t_rows($q$insert into public.sections (school_id, class_id, academic_session_id, name)
  values ('b0000000-0000-4000-8000-00000000000a', 'd0000000-0000-4000-8000-000000000001',
          'c0000000-0000-4000-8000-000000000002', 'B')$q$, 1, 'admin A can create a section in School A');
select private._t_raises($q$insert into public.classes (school_id, name)
  values ('b0000000-0000-4000-8000-00000000000b', 'Injected')$q$,
  '42501', 'admin A cannot create a class in School B');
select private._t_rows($q$update public.classes set name = 'Hacked'
  where id = 'd0000000-0000-4000-8000-000000000003'$q$, 0, 'admin A cannot update School B''s class');
select private._t_rows($q$delete from public.sections
  where id = 'e0000000-0000-4000-8000-000000000002'$q$, 0, 'admin A cannot delete School B''s section');
select private._t_rows($q$delete from public.academic_sessions
  where id = 'c0000000-0000-4000-8000-000000000003'$q$, 0, 'admin A cannot delete School B''s session');
select private._t_raises($q$select private.set_current_academic_session('c0000000-0000-4000-8000-000000000003')$q$,
  'P0002', 'admin A cannot switch School B''s current session');
select private.set_current_academic_session('c0000000-0000-4000-8000-000000000001');
select private._t_assert((select id from public.academic_sessions where is_current) = 'c0000000-0000-4000-8000-000000000001',
  'admin A can switch School A''s current session');
select private._t_raises($q$insert into public.roles (key, name) values ('teacher', 'x')$q$,
  '42501', 'roles are read-only for users');
select private._t_assert((select count(*) from public.roles) = 6, 'everyone can read the role catalogue (6 roles, librarian since Phase 23)');
select private._t_raises($q$update public.profiles set is_super_admin = true
  where id = 'a0000000-0000-4000-8000-000000000002'$q$, '42501', 'admin A cannot make themselves super admin');
select private._t_raises($q$insert into public.school_memberships (school_id, user_id, role)
  values ('b0000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000002', 'school_admin')$q$,
  '42501', 'admin A cannot grant themselves access to School B');
reset role;

-- (Phase 14) teachers only see sections assigned to them: give this fixture teacher a
-- teacher record assigned to every open section of the school
reset role;
select set_config('request.jwt.claims', '{}', true);
insert into public.teachers (school_id, full_name, phone, email, joining_date, account_id)
values ('b0000000-0000-4000-8000-00000000000a', 'Fixture Teacher', '9800000999', 'fixture-teacher-a0000000@example.invalid', '2020-01-01', 'a0000000-0000-4000-8000-000000000003');
insert into public.teacher_assignments (school_id, teacher_id, academic_session_id, class_id, section_id)
select s.school_id, (select id from public.teachers where account_id = 'a0000000-0000-4000-8000-000000000003'), s.academic_session_id, s.class_id, s.id
from public.sections s join public.academic_sessions a on a.id = s.academic_session_id
where s.school_id = 'b0000000-0000-4000-8000-00000000000a' and s.deleted_at is null and s.is_active and a.archived_at is null;
-- ---------- teacher of School A ----------
select private._t_as('a0000000-0000-4000-8000-000000000003');
select private._t_assert((select string_agg(name, ',') from public.classes) = 'Class 1',
  'teacher A sees only the class they are assigned to (not Class 2, nothing from School B)');
select private._t_raises($q$insert into public.classes (school_id, name)
  values ('b0000000-0000-4000-8000-00000000000a', 'Teacher Class')$q$,
  '42501', 'teacher cannot create classes');
select private._t_rows($q$update public.sections set capacity = 99
  where id = 'e0000000-0000-4000-8000-000000000001'$q$, 0, 'teacher cannot edit sections');
select private._t_raises($q$select private.set_current_academic_session('c0000000-0000-4000-8000-000000000002')$q$,
  '42501', 'teacher cannot switch the current session');
reset role;

-- ---------- admin of School B ----------
select private._t_as('a0000000-0000-4000-8000-000000000004');
select private._t_assert((select count(*) from public.sections where school_id = 'b0000000-0000-4000-8000-00000000000a') = 0
  and (select count(*) from public.sections where id = 'e0000000-0000-4000-8000-000000000002') = 1,
  'admin B sees only School B''s sections');
reset role;

-- ---------- signed-in user with no school ----------
select private._t_as('a0000000-0000-4000-8000-000000000005');
select private._t_assert(
  (select count(*) from public.schools) + (select count(*) from public.academic_sessions)
  + (select count(*) from public.classes) + (select count(*) from public.sections)
  + (select count(*) from public.school_memberships) = 0,
  'a user with no membership sees nothing');
reset role;

-- ---------- anonymous (no login) ----------
set local role anon;
do $$
declare st text;
begin
  begin perform 1 from public.classes limit 1; exception when others then st := sqlstate; end;
  if st is distinct from '42501' then raise exception 'FAIL: anonymous users must not read classes (got %)', st; end if;
  st := null;
  begin perform 1 from public.schools limit 1; exception when others then st := sqlstate; end;
  if st is distinct from '42501' then raise exception 'FAIL: anonymous users must not read schools (got %)', st; end if;
end $$;
reset role;

-- ---------- suspension cuts off access immediately ----------
update public.schools set status = 'suspended' where id = 'b0000000-0000-4000-8000-00000000000a';
select private._t_as('a0000000-0000-4000-8000-000000000002');
select private._t_assert((select count(*) from public.classes) + (select count(*) from public.sections) = 0,
  'members of a suspended school lose access');
select private._t_raises($q$insert into public.classes (school_id, name)
  values ('b0000000-0000-4000-8000-00000000000a', 'While Suspended')$q$,
  '42501', 'members of a suspended school cannot write');
reset role;

-- ---------- deleting a school removes all of its data ----------
delete from public.schools where id = 'b0000000-0000-4000-8000-00000000000b';
select private._t_assert((select count(*) from public.classes where school_id = 'b0000000-0000-4000-8000-00000000000b')
  + (select count(*) from public.sections where school_id = 'b0000000-0000-4000-8000-00000000000b')
  + (select count(*) from public.academic_sessions where school_id = 'b0000000-0000-4000-8000-00000000000b') = 0,
  'deleting a school cascades to its sessions, classes and sections');

select 'ALL TENANT-ISOLATION TESTS PASSED' as result;
rollback;
