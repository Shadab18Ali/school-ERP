-- =====================================================================
-- Tenant isolation audit. Run in the Supabase SQL Editor on ANY database: the test fixture,
-- a staging copy, or production. It changes nothing (everything is rolled back).
-- Pass = "TENANT ISOLATION AUDIT PASSED". Any problem is listed and the script fails.
--
-- 1. Structure: row-level security is on for every table; the anonymous role has no table
--    access; views in public run with the caller's rights; every security-definer function pins
--    its search_path; every school_id column is NOT NULL (except audit_logs) and references schools.
-- 2. Reading: for one person of every role in every school (admins, accountants, teachers,
--    librarians, parents, students), every table with a school_id shows no row of any other
--    school; the schools and profiles they can see are their own school's.
-- 3. Writing: those people can update or delete no other school's row, and can't move one of
--    their own rows into another school.
-- 4. Suspension: once a school is deactivated, its own people see none of its rows.
--
-- Tables are found from the catalog, so a table added later is audited automatically.
-- =====================================================================
begin;

create temp table audit_fail (area text, detail text) on commit drop;
create temp table audit_info (k text primary key, v bigint) on commit drop;
grant all on audit_fail, audit_info to authenticated;

-- ---------------------------------------------------------------- 1. structure
insert into audit_fail
select 'structure', 'row-level security is off on public.' || c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

insert into audit_fail
select 'structure', 'the anonymous role can ' || lower(g.privilege_type) || ' public.' || g.table_name
from information_schema.role_table_grants g
where g.grantee in ('anon', 'PUBLIC') and g.table_schema = 'public';

-- TRUNCATE ignores row-level security altogether; REFERENCES and TRIGGER have no use for a user (0032)
insert into audit_fail
select 'structure', 'signed-in users can ' || lower(g.privilege_type) || ' public.' || g.table_name
from information_schema.role_table_grants g
where g.grantee = 'authenticated' and g.table_schema = 'public' and g.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER');

insert into audit_fail
select 'structure', 'view public.' || c.relname || ' runs with its owner''s rights (set security_invoker)'
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and not coalesce(c.reloptions @> array['security_invoker=true'] or c.reloptions @> array['security_invoker=on'], false)
  and has_table_privilege('authenticated', c.oid, 'select');

insert into audit_fail
select 'structure', 'security-definer function ' || n.nspname || '.' || p.proname || ' has no fixed search_path'
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'private') and p.prosecdef
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');

insert into audit_fail
select 'structure', 'public.' || c.table_name || '.school_id may be empty'
from information_schema.columns c join pg_class t on t.relname = c.table_name
join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
where c.table_schema = 'public' and c.column_name = 'school_id' and c.is_nullable = 'YES' and t.relkind = 'r'
  and c.table_name not in ('audit_logs');   -- platform events have no school

-- school_id must reference schools, directly or through a composite key that ties the row to a
-- parent row of the same school (e.g. a book's authors: (book_id, school_id) → books)
insert into audit_fail
select 'structure', 'public.' || t.relname || '.school_id is not tied to a school'
from pg_class t join pg_namespace n on n.oid = t.relnamespace
join pg_attribute a on a.attrelid = t.oid and a.attname = 'school_id' and not a.attisdropped
where n.nspname = 'public' and t.relkind = 'r'
  and not exists (select 1 from pg_constraint k where k.conrelid = t.oid and k.contype = 'f' and a.attnum = any (k.conkey)
                  and (k.confrelid = 'public.schools'::regclass or cardinality(k.conkey) > 1));

-- ---------------------------------------------------------------- the people to audit
-- one person per (school, role), plus every school's first guardian and student login
create temp table audit_people on commit drop as
select distinct on (m.school_id, m.role) m.user_id, m.school_id, m.role::text as role
from public.school_memberships m
join public.schools s on s.id = m.school_id and s.status = 'active'
join public.profiles p on p.id = m.user_id and not p.is_super_admin
where m.status = 'active'
order by m.school_id, m.role, m.created_at;
grant select on audit_people to authenticated;

create temp table audit_tables on commit drop as
select c.relname::text as t,
       -- a column the signed-in role may update (school_id if it may), for the write probes
       coalesce((select 'school_id' where has_column_privilege('authenticated', c.oid, 'school_id', 'UPDATE')),
                (select x.attname::text from pg_attribute x where x.attrelid = c.oid and x.attnum > 0 and not x.attisdropped
                   and has_column_privilege('authenticated', c.oid, x.attname, 'UPDATE') order by x.attnum limit 1)) as col,
       -- an updatable column with a default, for a "blind" write that reads nothing (only write rules apply)
       (select x.attname::text from pg_attribute x where x.attrelid = c.oid and x.attnum > 0 and not x.attisdropped and x.atthasdef
          and x.attgenerated = '' and x.attidentity = '' and x.attname not in ('id', 'school_id')
          and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype in ('p', 'u', 'f') and x.attnum = any (k.conkey))
          and has_column_privilege('authenticated', c.oid, x.attname, 'UPDATE')
        order by (x.attname = 'updated_at') desc, x.attnum limit 1) as blind
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attname = 'school_id' and not a.attisdropped
where n.nspname = 'public' and c.relkind in ('r', 'p', 'v')
order by 1;
grant select on audit_tables to authenticated;

insert into audit_info select 'people audited', count(*) from audit_people;
insert into audit_info select 'schools with people', count(distinct school_id) from audit_people;
insert into audit_info select 'tables with school_id', count(*) from audit_tables;
insert into audit_info select 'rows in those tables (all schools)', 0;
do $$ declare r record; n bigint; total bigint := 0; begin
  for r in select t from audit_tables loop
    execute format('select count(*) from public.%I', r.t) into n; total := total + n;
  end loop;
  update audit_info set v = total where k = 'rows in those tables (all schools)';
end $$;

-- ---------------------------------------------------------------- 2-3. reading and writing as each person
create function pg_temp.audit_as(p_user uuid, p_school uuid, p_role text) returns void language plpgsql as $$
declare
  r record; n bigint; mine uuid[]; other uuid; who text; own jsonb := '{}';
begin
  select coalesce(array_agg(distinct m.school_id), '{}') into mine
  from public.school_memberships m join public.schools s on s.id = m.school_id and s.status = 'active'
  where m.user_id = p_user and m.status = 'active';
  select s.id into other from public.schools s where s.id <> all (mine) order by s.created_at limit 1;
  who := p_role || ' of school ' || p_school;
  -- how many rows each table holds for their own school(s) (counted before acting as them)
  for r in select t from audit_tables loop
    execute format('select count(*) from public.%I where school_id = any ($1)', r.t) using mine into n;
    own := own || jsonb_build_object(r.t, n);
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- schools and profiles
  select count(*) into n from public.schools where id <> all (mine);
  if n > 0 then insert into audit_fail values ('read', who || ' sees ' || n || ' other school(s)'); end if;
  select count(*) into n from public.profiles p
  where p.id <> p_user and not exists (
    select 1 from public.school_memberships m where m.user_id = p.id and m.school_id = any (mine));
  if n > 0 then insert into audit_fail values ('read', who || ' sees ' || n || ' profile(s) of people outside their school'); end if;

  for r in select t, col, blind from audit_tables loop
    -- reading
    begin
      execute format('select count(*) from public.%I where school_id is null or school_id <> all ($1)', r.t)
        using mine into n;
    exception when insufficient_privilege then n := 0;
    end;
    if n > 0 then insert into audit_fail values ('read', who || ': ' || r.t || ' shows ' || n || ' row(s) of another school'); end if;

    -- writing someone else's rows (undone straight away whatever happens)
    begin
      execute format('update public.%I set %I = %I where school_id <> all ($1)', r.t, coalesce(r.col, 'school_id'), coalesce(r.col, 'school_id')) using mine;
      get diagnostics n = row_count;
      raise exception using errcode = 'ZZ999', message = n::text;
    exception
      when sqlstate 'ZZ999' then
        if sqlerrm::bigint > 0 then insert into audit_fail values ('write', who || ': could update ' || sqlerrm || ' row(s) of another school in ' || r.t); end if;
      when others then null;   -- refused outright: fine
    end;
    begin
      execute format('delete from public.%I where school_id <> all ($1)', r.t) using mine;
      get diagnostics n = row_count;
      raise exception using errcode = 'ZZ999', message = n::text;
    exception
      when sqlstate 'ZZ999' then
        if sqlerrm::bigint > 0 then insert into audit_fail values ('write', who || ': could delete ' || sqlerrm || ' row(s) of another school in ' || r.t); end if;
      when others then null;
    end;
    -- the same without naming any column: then only the write rules apply (no read rule), so a
    -- write rule that is too wide shows as more rows touched than their own school(s) hold
    begin
      if r.blind is not null then
        execute format('update public.%I set %I = default', r.t, r.blind);   -- reads nothing: only write rules apply
      else
        execute format('update public.%I set %I = %I', r.t, coalesce(r.col, 'school_id'), coalesce(r.col, 'school_id'));
      end if;
      get diagnostics n = row_count;
      raise exception using errcode = 'ZZ999', message = n::text;
    exception
      when sqlstate 'ZZ999' then
        if sqlerrm::bigint > (own ->> r.t)::bigint then
          insert into audit_fail values ('write', who || ': an unfiltered update of ' || r.t || ' touched ' || sqlerrm || ' row(s); their school has ' || (own ->> r.t));
        end if;
      when others then null;
    end;
    begin
      execute format('delete from public.%I', r.t);
      get diagnostics n = row_count;
      raise exception using errcode = 'ZZ999', message = n::text;
    exception
      when sqlstate 'ZZ999' then
        if sqlerrm::bigint > (own ->> r.t)::bigint then
          insert into audit_fail values ('write', who || ': an unfiltered delete of ' || r.t || ' touched ' || sqlerrm || ' row(s); their school has ' || (own ->> r.t));
        end if;
      when others then null;
    end;
    -- moving one of their own rows into another school
    if other is not null then
      begin
        execute format('update public.%I set school_id = $2 where ctid = (select ctid from public.%I where school_id = any ($1) limit 1)', r.t, r.t)
          using mine, other;
        get diagnostics n = row_count;
        raise exception using errcode = 'ZZ999', message = n::text;
      exception
        when sqlstate 'ZZ999' then
          if sqlerrm::bigint > 0 then insert into audit_fail values ('write', who || ': could move a row of ' || r.t || ' into another school'); end if;
        when others then null;
      end;
    end if;
  end loop;

  perform set_config('role', 'none', true);
  reset role;
end $$;

do $$ declare p record; begin
  for p in select * from audit_people order by school_id, role loop
    perform pg_temp.audit_as(p.user_id, p.school_id, p.role);
  end loop;
end $$;

-- ---------------------------------------------------------------- 4. a deactivated school's own people
do $$ declare s uuid; p record; r record; n bigint; begin
  select school_id into s from audit_people group by school_id order by count(*) desc limit 1;
  if s is null then return; end if;
  update public.schools set status = 'suspended' where id = s;
  for p in select * from audit_people where school_id = s loop
    perform set_config('request.jwt.claims', json_build_object('sub', p.user_id, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    for r in select t from audit_tables loop
      begin
        -- their own membership rows stay readable: it's how the app tells them the school is inactive
        execute format('select count(*) from public.%I x where school_id = $1'
                       || case when r.t = 'school_memberships' then ' and x.user_id <> $2' else '' end, r.t)
          using s, p.user_id into n;
      exception when insufficient_privilege then n := 0;
      end;
      if n > 0 then insert into audit_fail values ('suspended', p.role || ' of a deactivated school still sees ' || n || ' row(s) of ' || r.t); end if;
    end loop;
    perform set_config('role', 'none', true);
    reset role;
  end loop;
  insert into audit_info values ('deactivated-school people audited', (select count(*) from audit_people where school_id = s));
end $$;

-- ---------------------------------------------------------------- result
select k as audited, v as count from audit_info order by k;
select area, detail from audit_fail order by area, detail;
do $$ declare n int; begin
  select count(*) into n from audit_fail;
  if n > 0 then raise exception 'TENANT ISOLATION AUDIT FAILED: % problem(s), listed above', n using errcode = 'ZT001'; end if;
  if (select v from audit_info where k = 'people audited') < 1 then
    raise notice 'TENANT ISOLATION AUDIT PASSED (structure only: this database has no school members yet, so the reading and writing checks had nobody to run as)';
  else
    raise notice 'TENANT ISOLATION AUDIT PASSED';
  end if;
end $$;
select 'TENANT ISOLATION AUDIT PASSED' as result;
rollback;
