-- =====================================================================
-- Phase 13: student login
--   students.account_id        one sign-in account <-> one student record
--   is_student_self()          is the signed-in user this student?
--   can_view_student_record()  parent-of OR self: the ONE rule behind all portal reads
--   portal RLS                 the Phase 12 parent policies are replaced by policies
--                              on can_view_student_record (same tables, same limits)
--   notices                    new "students" audience
-- =====================================================================

alter table public.students add column account_id uuid references public.profiles (id) on delete set null;
alter table public.students add constraint students_account_unique unique (account_id);

-- The account must be an active STUDENT of the same school.
create or replace function private.guard_student_account()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- only school admins (or the platform admin / backend maintenance) may change the link
  if (tg_op = 'INSERT' and new.account_id is not null or tg_op = 'UPDATE' and new.account_id is distinct from old.account_id)
     and (select auth.uid()) is not null
     and not (private.is_super_admin() or private.has_school_role(new.school_id, array['school_admin']::public.app_role[])) then
    raise exception 'Only school administrators can link student logins.' using errcode = 'insufficient_privilege';
  end if;
  if new.account_id is not null and (tg_op = 'INSERT' or new.account_id is distinct from old.account_id)
     and not exists (select 1 from public.school_memberships m
                     where m.user_id = new.account_id and m.school_id = new.school_id
                       and m.role = 'student' and m.status = 'active') then
    raise exception 'That account isn''t a student in this school.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger students_guard_account before insert or update of account_id on public.students
  for each row execute function private.guard_student_account();

create or replace function private.is_student_self(p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.students st
    join public.school_memberships m on m.user_id = st.account_id and m.school_id = st.school_id
                                     and m.role = 'student' and m.status = 'active'
    join public.schools s on s.id = st.school_id and s.status = 'active'
    where st.id = p_student_id and st.account_id = (select auth.uid())
  );
$$;

create or replace function private.can_view_student_record(p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_guardian_of(p_student_id) or private.is_student_self(p_student_id);
$$;

-- dues refresh for the portal (parents and students can't write dues themselves)
create or replace function private.sync_dues_for_portal(p_student_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if not private.can_view_student_record(p_student_id) then
    raise exception 'Student not found.' using errcode = 'no_data_found';
  end if;
  select coalesce(array_agg(id), '{}') into v_ids from public.student_enrollments where student_id = p_student_id;
  perform private.sync_student_dues(v_ids);
end $$;

revoke all on function private.is_student_self(uuid), private.can_view_student_record(uuid),
  private.sync_dues_for_portal(uuid) from public, anon;
grant execute on function private.is_student_self(uuid), private.can_view_student_record(uuid),
  private.sync_dues_for_portal(uuid) to authenticated;

-- ---------- portal read access: replace the parent-only policies ----------
drop policy students_select_guardian on public.students;
drop policy enrollments_select_guardian on public.student_enrollments;
drop policy attendance_select_guardian on public.attendance_records;
drop policy dues_select_guardian on public.student_fee_dues;
drop policy payments_select_guardian on public.fee_payments;
drop policy allocations_select_guardian on public.fee_payment_allocations;
drop policy fee_heads_select_guardian on public.fee_heads;
drop policy fee_items_select_guardian on public.fee_structure_items;

create policy students_select_portal on public.students for select to authenticated
  using (private.can_view_student_record(id));
create policy enrollments_select_portal on public.student_enrollments for select to authenticated
  using (private.can_view_student_record(student_id));
create policy attendance_select_portal on public.attendance_records for select to authenticated
  using (private.can_view_student_record(student_id));
create policy dues_select_portal on public.student_fee_dues for select to authenticated
  using (private.can_view_student_record(student_id));
create policy payments_select_portal on public.fee_payments for select to authenticated
  using (private.can_view_student_record(student_id));
create policy allocations_select_portal on public.fee_payment_allocations for select to authenticated
  using (exists (select 1 from public.fee_payments p
                 where p.id = fee_payment_allocations.payment_id and private.can_view_student_record(p.student_id)));
-- (columns are table-qualified: an unqualified "id" here would bind to the dues table)
create policy fee_heads_select_portal on public.fee_heads for select to authenticated
  using (exists (select 1 from public.student_fee_dues d
                 where d.fee_head_id = fee_heads.id and private.can_view_student_record(d.student_id)));
create policy fee_items_select_portal on public.fee_structure_items for select to authenticated
  using (exists (select 1 from public.student_fee_dues d
                 where d.fee_item_id = fee_structure_items.id and private.can_view_student_record(d.student_id)));

-- ---------- notices for students ----------
alter type public.notice_audience add value if not exists 'students';
-- (compared as text below: a value added in this same transaction can't be used as an enum literal yet)
create policy notices_select_student on public.notices for select to authenticated
  using (
    audience::text in ('everyone', 'students')
    and publish_at <= now() and (expires_at is null or expires_at > now())
    and private.has_school_role(school_id, array['student']::public.app_role[])
    and (class_ids is null or exists (
      select 1 from public.students st
      join public.student_enrollments e on e.student_id = st.id
      where st.account_id = (select auth.uid()) and st.school_id = notices.school_id and e.class_id = any (notices.class_ids)))
  );

-- =====================================================================
-- Performance fix for private.wanted_dues (from 0008).
-- Postgres was inlining the per-class fee schedule into the per-student join and
-- recomputing it once PER STUDENT: refreshing dues for 600 students took ~20 s
-- (it runs on every dashboard / pending-fees / class report load for fee staff).
-- MATERIALIZED makes it compute once per class: ~0.4 s for the same 600 students.
-- Behaviour is unchanged; only the plan differs.
-- =====================================================================
create or replace function private.wanted_dues(p_enrollment_ids uuid[])
returns table (enrollment_id uuid, school_id uuid, student_id uuid, fee_item_id uuid, fee_head_id uuid, due_month date, amount numeric)
language sql stable security invoker set search_path = '' as $$
  with enr as materialized (
    select e.id, e.school_id, e.student_id, fs.id as structure_id
    from public.student_enrollments e
    join public.students s on s.id = e.student_id and s.status = 'active'
    join public.academic_sessions a on a.id = e.academic_session_id and a.archived_at is null
    join public.fee_structures fs on fs.academic_session_id = e.academic_session_id and fs.class_id = e.class_id and fs.is_active
    where e.id = any (p_enrollment_ids)
  ),
  sched as materialized (
    select st.structure_id, x.*
    from (select distinct structure_id from enr) st
    cross join lateral private.fee_structure_schedule(st.structure_id) x
  )
  select enr.id, enr.school_id, enr.student_id, sc.fee_item_id, sc.fee_head_id, sc.due_month, sc.amount
  from enr join sched sc on sc.structure_id = enr.structure_id
  where not sc.is_optional
     or exists (select 1 from public.student_fee_optins o where o.enrollment_id = enr.id and o.fee_item_id = sc.fee_item_id);
$$;

