-- =====================================================================
-- Phase 31: the platform — subscriptions, usage, system analytics, and tighter tenancy
--
--   Super Admin → Schools → School Admin → Teachers / Accountants → Parents / Students
--
-- 1. A deactivated school is closed to its own people everywhere. Before this, a few
--    "your own row" rules ignored the school's status, so after deactivation a person could
--    still read their notifications (which carry fee amounts, marks...), a parent their
--    guardian links, and a teacher their teacher record and class assignments (found by
--    supabase/tests/tenant_isolation_audit.sql). Platform-wide notifications (no school) and a
--    person's own membership rows (how the app tells them the school is inactive) stay visible.
-- 2. Only the super admin creates, changes or removes school administrators. A school admin
--    still manages every other role in their own school (teacher, accountant, librarian,
--    parent, student logins).
-- 3. Subscription plans (priced by the super admin — no amount is built in) and each school's
--    subscription, with a history of every change.
-- 4. Usage per school and system analytics, computed from the records (super admin; a
--    school's admin sees their own school's usage and plan).
-- =====================================================================

-- ---------------------------------------------------------------- 1. deactivated schools
create or replace function private.school_is_active(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.schools s where s.id = p_school and s.status = 'active');
$$;
revoke all on function private.school_is_active(uuid) from public, anon;
grant execute on function private.school_is_active(uuid) to authenticated;

drop policy notifications_own_select on public.notifications;
drop policy notifications_own_update on public.notifications;
drop policy notifications_own_delete on public.notifications;
create policy notifications_own_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and (school_id is null or private.school_is_active(school_id)));
create policy notifications_own_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid()) and (school_id is null or private.school_is_active(school_id)))
  with check (user_id = (select auth.uid()));
create policy notifications_own_delete on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()) and (school_id is null or private.school_is_active(school_id)));

drop policy teachers_select on public.teachers;
create policy teachers_select on public.teachers for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin']::public.app_role[])
         or (account_id = (select auth.uid()) and private.school_is_active(school_id)));  -- a teacher's own record

drop policy assignments_select on public.teacher_assignments;
create policy assignments_select on public.teacher_assignments for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin']::public.app_role[])
         or (private.school_is_active(school_id) and exists (select 1 from public.teachers t
               where t.id = teacher_assignments.teacher_id and t.account_id = (select auth.uid()))));

drop policy guardians_select on public.student_guardians;
create policy guardians_select on public.student_guardians for select to authenticated
  using ((user_id = (select auth.uid()) and private.school_is_active(school_id))
         or (select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- ---------------------------------------------------------------- 2. administrators: super admin only
drop policy memberships_write on public.school_memberships;
create policy memberships_write on public.school_memberships for all to authenticated
  using ((select private.is_super_admin())
         or (role <> 'school_admin' and private.has_school_role(school_id, array['school_admin']::public.app_role[])))
  with check ((select private.is_super_admin())
         or (role <> 'school_admin' and private.has_school_role(school_id, array['school_admin']::public.app_role[])));

-- ---------------------------------------------------------------- 3. plans and subscriptions
create type public.subscription_status as enum ('trial', 'active', 'past_due', 'cancelled');
create type public.billing_cycle as enum ('monthly', 'yearly');

create table public.subscription_plans (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique check (code ~ '^[A-Z0-9-]{2,30}$'),
  name           text not null check (char_length(btrim(name)) between 2 and 60),
  description    text check (char_length(description) <= 500),
  price_monthly  numeric(12, 2) not null check (price_monthly >= 0),
  price_yearly   numeric(12, 2) not null check (price_yearly >= 0),
  max_students   integer check (max_students > 0),   -- empty = no limit
  max_staff      integer check (max_staff > 0),
  features       text[] not null default '{}' check (cardinality(features) <= 20),
  is_active      boolean not null default true,       -- inactive plans can't be given to more schools
  display_order  integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index subscription_plans_name_key on public.subscription_plans (lower(btrim(name)));
create trigger subscription_plans_updated_at before update on public.subscription_plans
  for each row execute function private.set_updated_at();

-- one subscription per school (its history is in school_subscription_events)
create table public.school_subscriptions (
  school_id             uuid primary key references public.schools(id) on delete cascade,
  plan_id               uuid not null references public.subscription_plans(id) on delete restrict,
  status                public.subscription_status not null,
  billing_cycle         public.billing_cycle not null,
  price                 numeric(12, 2) not null check (price >= 0),   -- agreed price per billing cycle
  current_period_start  date not null,
  current_period_end    date not null,
  trial_ends_at         date,
  notes                 text check (char_length(notes) <= 1000),
  updated_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint school_subscriptions_period check (current_period_end >= current_period_start),
  constraint school_subscriptions_trial check (status <> 'trial' or trial_ends_at is not null)
);
create index school_subscriptions_plan_idx on public.school_subscriptions (plan_id);
create trigger school_subscriptions_updated_at before update on public.school_subscriptions
  for each row execute function private.set_updated_at();

create table public.school_subscription_events (
  id                    bigint generated always as identity primary key,
  school_id             uuid not null references public.schools(id) on delete cascade,
  plan_id               uuid references public.subscription_plans(id) on delete set null,
  plan_name             text not null,
  status                public.subscription_status not null,
  billing_cycle         public.billing_cycle not null,
  price                 numeric(12, 2) not null,
  current_period_start  date not null,
  current_period_end    date not null,
  trial_ends_at         date,
  notes                 text,
  changed_by            uuid references auth.users(id) on delete set null,
  changed_at            timestamptz not null default now()
);
create index school_subscription_events_school_idx on public.school_subscription_events (school_id, changed_at desc);

-- every change is kept, with who made it
create or replace function private.record_subscription_event()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.plan_id, new.status, new.billing_cycle, new.price, new.current_period_start,
       new.current_period_end, new.trial_ends_at, new.notes)
     is not distinct from (old.plan_id, old.status, old.billing_cycle, old.price, old.current_period_start,
       old.current_period_end, old.trial_ends_at, old.notes) then
    return new;
  end if;
  insert into public.school_subscription_events (school_id, plan_id, plan_name, status, billing_cycle, price,
    current_period_start, current_period_end, trial_ends_at, notes, changed_by)
  select new.school_id, new.plan_id, p.name, new.status, new.billing_cycle, new.price,
         new.current_period_start, new.current_period_end, new.trial_ends_at, new.notes, (select auth.uid())
  from public.subscription_plans p where p.id = new.plan_id;
  return new;
end $$;
create trigger school_subscriptions_history after insert or update on public.school_subscriptions
  for each row execute function private.record_subscription_event();

-- a school's plan can't be swapped to an inactive one (keeping a school on a retired plan is fine)
create or replace function private.check_subscription_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (tg_op = 'INSERT' or new.plan_id <> old.plan_id)
     and not exists (select 1 from public.subscription_plans p where p.id = new.plan_id and p.is_active) then
    raise exception 'This plan is no longer offered.' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger school_subscriptions_plan_check before insert or update on public.school_subscriptions
  for each row execute function private.check_subscription_plan();
create trigger school_subscriptions_lock_school before update on public.school_subscriptions
  for each row execute function private.prevent_school_change();

alter table public.subscription_plans enable row level security;
alter table public.school_subscriptions enable row level security;
alter table public.school_subscription_events enable row level security;
revoke all on public.subscription_plans, public.school_subscriptions, public.school_subscription_events from anon, authenticated;
grant select, insert, update, delete on public.subscription_plans, public.school_subscriptions to authenticated;
grant select on public.school_subscription_events to authenticated;

-- the platform manages plans; a school's admin can read the plan their school is on
create policy plans_super on public.subscription_plans for all to authenticated
  using ((select private.is_super_admin())) with check ((select private.is_super_admin()));
create policy plans_own_school on public.subscription_plans for select to authenticated
  using (exists (select 1 from public.school_subscriptions s where s.plan_id = subscription_plans.id
                 and private.has_school_role(s.school_id, array['school_admin']::public.app_role[])));
create policy subscriptions_super on public.school_subscriptions for all to authenticated
  using ((select private.is_super_admin())) with check ((select private.is_super_admin()));
create policy subscriptions_own_school on public.school_subscriptions for select to authenticated
  using (private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy subscription_events_read on public.school_subscription_events for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- where a subscription stands today (stored status + dates)
create or replace function private.subscription_state(p_status public.subscription_status, p_end date, p_trial date)
returns text language sql stable set search_path = '' as $$
  select case
    when p_status = 'cancelled' then 'cancelled'
    when p_status = 'trial' then case when p_trial >= private.ist_today() then 'trial' else 'trial_ended' end
    when p_end < private.ist_today() then 'lapsed'
    else p_status::text end;   -- active / past_due
$$;

-- a subscription's price per month (yearly plans spread over 12 months), for recurring revenue
create or replace function private.monthly_value(p_cycle public.billing_cycle, p_price numeric)
returns numeric language sql immutable set search_path = '' as $$
  select round(case when p_cycle = 'yearly' then p_price / 12 else p_price end, 2);
$$;

-- ---------------------------------------------------------------- 4. usage and system analytics
-- Who may see a school's usage: the super admin, or that school's own admins.
create or replace function private.platform_access(p_school uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.is_super_admin()
          or (p_school is not null and private.has_school_role(p_school, array['school_admin']::public.app_role[]))) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- How much of the platform a school uses. Counts only; nothing personal.
create or replace function private.school_usage(p_school uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.ist_today(); v_since date := private.ist_today() - 29;
  v_session uuid; v_session_name text; v_storage bigint; out jsonb;
begin
  perform private.platform_access(p_school);
  if not exists (select 1 from public.schools where id = p_school) then return null; end if;
  select id, name into v_session, v_session_name from public.academic_sessions where school_id = p_school and is_current;

  v_storage := null;   -- files kept in Supabase Storage under the school's folder
  if exists (select 1 from information_schema.columns
             where table_schema = 'storage' and table_name = 'objects' and column_name = 'metadata') then
    execute $q$select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects
               where split_part(name, '/', 1) = $1::text$q$ into v_storage using p_school;
  end if;

  select jsonb_build_object(
    'school_id', p_school,
    'session', case when v_session is null then null else jsonb_build_object('id', v_session, 'name', v_session_name) end,
    'students', jsonb_build_object(
      'active', (select count(*) from public.students where school_id = p_school and status = 'active'),
      'total', (select count(*) from public.students where school_id = p_school),
      'enrolled_this_session', (select count(*) from public.student_enrollments where school_id = p_school and academic_session_id = v_session)),
    'people', jsonb_build_object(
      'school_admins', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'school_admin'),
      'accountants', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'accountant'),
      'teachers', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'teacher'),
      'librarians', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'librarian'),
      'parents', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'parent'),
      'students', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active' and role = 'student'),
      'staff', (select count(distinct user_id) from public.school_memberships where school_id = p_school and status = 'active'
                and role in ('school_admin', 'accountant', 'teacher', 'librarian'))),
    'teacher_records', (select count(*) from public.teachers where school_id = p_school and status = 'active'),
    'classes', (select count(*) from public.classes where school_id = p_school and deleted_at is null and is_active),
    'sections', (select count(*) from public.sections where school_id = p_school and academic_session_id = v_session and deleted_at is null),
    'last_30_days', jsonb_build_object(
      'from', v_since, 'to', v_today,
      'attendance_days', (select count(distinct attendance_date) from public.attendance_records where school_id = p_school and attendance_date between v_since and v_today),
      'receipts', (select count(*) from public.fee_payments where school_id = p_school and cancelled_at is null and payment_date between v_since and v_today),
      'collected', (select coalesce(sum(amount), 0) from public.fee_payments where school_id = p_school and cancelled_at is null and payment_date between v_since and v_today),
      'notifications', (select count(*) from public.notifications where school_id = p_school and created_at >= v_since),
      'actions', (select count(*) from public.audit_logs where school_id = p_school and created_at >= v_since)),
    'last_activity_at', (select max(created_at) from public.audit_logs where school_id = p_school),
    'storage_bytes', v_storage,
    'limits', (select jsonb_build_object('max_students', p.max_students, 'max_staff', p.max_staff)
               from public.school_subscriptions s join public.subscription_plans p on p.id = s.plan_id where s.school_id = p_school)
  ) into out;

  out := out || jsonb_build_object('over_limits', jsonb_build_object(
    'students', coalesce((out #>> '{limits,max_students}')::int < (out #>> '{students,active}')::int, false),
    'staff', coalesce((out #>> '{limits,max_staff}')::int < (out #>> '{people,staff}')::int, false)));
  return out;
end $$;

-- The schools list, with each school's plan, size and activity (super admin).
create or replace function private.platform_schools(p_ids uuid[])
returns table (school_id uuid, plan_name text, subscription_state text, current_period_end date, trial_ends_at date,
               students_active bigint, staff bigint, max_students integer, last_activity_at timestamptz)
language plpgsql stable security definer set search_path = '' set jit = off as $$
begin
  perform private.platform_access(null);
  return query
  select s.id, p.name, case when sub.school_id is null then null else private.subscription_state(sub.status, sub.current_period_end, sub.trial_ends_at) end,
         sub.current_period_end, sub.trial_ends_at,
         (select count(*) from public.students st where st.school_id = s.id and st.status = 'active'),
         (select count(distinct m.user_id) from public.school_memberships m where m.school_id = s.id and m.status = 'active'
            and m.role in ('school_admin', 'accountant', 'teacher', 'librarian')),
         p.max_students,
         (select max(a.created_at) from public.audit_logs a where a.school_id = s.id)
  from public.schools s
  left join public.school_subscriptions sub on sub.school_id = s.id
  left join public.subscription_plans p on p.id = sub.plan_id
  where s.id = any (p_ids);
end $$;

-- System analytics across every school (super admin).
create or replace function private.platform_analytics()
returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.ist_today(); v_month date := date_trunc('month', private.ist_today())::date; out jsonb;
begin
  perform private.platform_access(null);
  with subs as (
    select s.*, sc.name as school_name, sc.status as school_status, p.name as plan_name,
           private.subscription_state(s.status, s.current_period_end, s.trial_ends_at) as state,
           private.monthly_value(s.billing_cycle, s.price) as mrr
    from public.school_subscriptions s join public.schools sc on sc.id = s.school_id
    join public.subscription_plans p on p.id = s.plan_id
  ),
  months as (select (v_month - make_interval(months => g))::date as month from generate_series(11, 0, -1) g),
  activity as (   -- a school is "active" when its people did something in the system
    select school_id, max(created_at) as at from public.audit_logs where school_id is not null group by school_id
  ),
  sizes as (
    select sc.id, sc.name, sc.status,
           (select count(*) from public.students st where st.school_id = sc.id and st.status = 'active') as students,
           (select count(distinct m.user_id) from public.school_memberships m where m.school_id = sc.id and m.status = 'active'
              and m.role in ('school_admin', 'accountant', 'teacher', 'librarian')) as staff
    from public.schools sc
  )
  select jsonb_build_object(
    'as_of', v_today,
    'schools', jsonb_build_object(
      'total', (select count(*) from public.schools),
      'active', (select count(*) from public.schools where status = 'active'),
      'inactive', (select count(*) from public.schools where status <> 'active'),
      'added_this_month', (select count(*) from public.schools where created_at >= v_month),
      'active_last_7_days', (select count(*) from activity where at >= v_today - 6),
      'active_last_30_days', (select count(*) from activity where at >= v_today - 29),
      'without_subscription', (select count(*) from public.schools sc where not exists (select 1 from public.school_subscriptions s where s.school_id = sc.id)),
      'without_admin', (select count(*) from public.schools sc where not exists (select 1 from public.school_memberships m
                          where m.school_id = sc.id and m.role = 'school_admin' and m.status = 'active'))),
    'people', jsonb_build_object(
      'students_active', (select count(*) from public.students where status = 'active'),
      'staff', (select count(distinct (school_id, user_id)) from public.school_memberships where status = 'active' and role in ('school_admin', 'accountant', 'teacher', 'librarian')),
      'parents', (select count(distinct user_id) from public.school_memberships where status = 'active' and role = 'parent'),
      'student_logins', (select count(distinct user_id) from public.school_memberships where status = 'active' and role = 'student'),
      'accounts', (select count(*) from public.profiles where not is_super_admin)),
    'subscriptions', jsonb_build_object(
      'by_state', coalesce((select jsonb_object_agg(state, n) from (select state, count(*) n from subs group by state) t), '{}'),
      'mrr', coalesce((select sum(mrr) from subs where state in ('active', 'past_due') and school_status = 'active'), 0),
      'arr', coalesce((select sum(mrr) * 12 from subs where state in ('active', 'past_due') and school_status = 'active'), 0),
      'by_plan', coalesce((select jsonb_agg(jsonb_build_object('plan', p.name, 'plan_id', p.id, 'is_active', p.is_active,
            'schools', (select count(*) from subs where plan_id = p.id),
            'paying', (select count(*) from subs where plan_id = p.id and state in ('active', 'past_due') and school_status = 'active'),
            'mrr', coalesce((select sum(mrr) from subs where plan_id = p.id and state in ('active', 'past_due') and school_status = 'active'), 0))
          order by p.display_order, p.name) from public.subscription_plans p), '[]'),
      'renewals_due', coalesce((select jsonb_agg(jsonb_build_object('school_id', school_id, 'school', school_name, 'plan', plan_name,
            'state', state, 'date', coalesce(case when state = 'trial' then trial_ends_at end, current_period_end)) order by coalesce(case when state = 'trial' then trial_ends_at end, current_period_end))
          from subs where state in ('trial', 'active', 'past_due')
            and coalesce(case when state = 'trial' then trial_ends_at end, current_period_end) between v_today and v_today + 30), '[]'),
      'needs_attention', coalesce((select jsonb_agg(jsonb_build_object('school_id', school_id, 'school', school_name, 'plan', plan_name,
            'state', state, 'date', coalesce(case when state = 'trial_ended' then trial_ends_at end, current_period_end)) order by school_name)
          from subs where state in ('lapsed', 'trial_ended', 'past_due') and school_status = 'active'), '[]')),
    'growth', (select jsonb_agg(jsonb_build_object('month', mo.month,
        'new_schools', (select count(*) from public.schools sc where date_trunc('month', sc.created_at at time zone 'Asia/Kolkata') = mo.month),
        'schools', (select count(*) from public.schools sc where (sc.created_at at time zone 'Asia/Kolkata')::date < (mo.month + interval '1 month')::date),
        'new_students', (select count(*) from public.students st where date_trunc('month', st.created_at at time zone 'Asia/Kolkata') = mo.month),
        'fees_collected', (select coalesce(sum(fp.amount), 0) from public.fee_payments fp where fp.cancelled_at is null and date_trunc('month', fp.payment_date) = mo.month),
        'receipts', (select count(*) from public.fee_payments fp where fp.cancelled_at is null and date_trunc('month', fp.payment_date) = mo.month),
        'active_schools', (select count(distinct a.school_id) from public.audit_logs a where a.school_id is not null
                             and date_trunc('month', a.created_at at time zone 'Asia/Kolkata') = mo.month))
        order by mo.month) from months mo),
    'largest_schools', coalesce((select jsonb_agg(jsonb_build_object('school_id', id, 'school', name, 'status', status, 'students', students, 'staff', staff)
        order by students desc, name) from (select * from sizes order by students desc, name limit 10) t), '[]'),
    'over_limits', coalesce((select jsonb_agg(jsonb_build_object('school_id', z.id, 'school', z.name, 'plan', p.name,
          'students', z.students, 'max_students', p.max_students, 'staff', z.staff, 'max_staff', p.max_staff) order by z.name)
        from sizes z join public.school_subscriptions s on s.school_id = z.id join public.subscription_plans p on p.id = s.plan_id
        where (p.max_students is not null and z.students > p.max_students) or (p.max_staff is not null and z.staff > p.max_staff)), '[]')
  ) into out;
  return out;
end $$;

revoke all on function private.platform_access(uuid), private.school_usage(uuid), private.platform_schools(uuid[]),
  private.platform_analytics(), private.subscription_state(public.subscription_status, date, date),
  private.monthly_value(public.billing_cycle, numeric) from public, anon;
grant execute on function private.school_usage(uuid), private.platform_schools(uuid[]), private.platform_analytics(),
  private.subscription_state(public.subscription_status, date, date), private.monthly_value(public.billing_cycle, numeric) to authenticated;
