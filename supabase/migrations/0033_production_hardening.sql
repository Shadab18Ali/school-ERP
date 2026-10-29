-- Phase 34: production audit fixes.
--
-- 1. A school can no longer be deleted through the Data API. Deleting a school cascades to every
--    student, receipt, mark and payslip it ever had; a deactivated school keeps its history. Only the
--    database owner (a deliberate maintenance step, never the app) can still remove one.
-- 2. The subscription renewal run takes a lock, so API processes running it at the same moment
--    (uvicorn --workers N, several containers) don't race each other: one issues the invoices, the
--    others skip that run instead of failing and rolling back.
-- 3. A rate limiter shared by every API process (the in-memory one counted per process, so N
--    workers allowed N times the limit). Keys are stored hashed: no IP address is kept.
-- 4. Indexes for foreign keys that are looked up or checked on deletes, and a duplicate index removed.

-- 1 -----------------------------------------------------------------------------------------------
drop policy if exists schools_delete on public.schools;
revoke delete on public.schools from anon, authenticated, service_role;

-- 2 -----------------------------------------------------------------------------------------------
create or replace function private.billing_run() returns integer language plpgsql security definer set search_path = '' as $$
declare s record; b record; v_next date; n integer := 0; v_status text;
begin
  if not private.billing_actor_ok(true) then raise exception 'Not allowed.' using errcode = 'insufficient_privilege'; end if;
  -- one run at a time across every API process; a run already under way does the work
  if not pg_try_advisory_xact_lock(hashtext('erp.billing_run')) then return 0; end if;
  select * into b from public.billing_settings;
  if not found then return 0; end if;
  for s in select * from public.school_subscriptions ss join public.schools sc on sc.id = ss.school_id
           where ss.cancelled_at is null and not ss.cancel_at_period_end and sc.status = 'active' loop
    v_status := private.subscription_status(s.school_id) ->> 'status';
    continue when v_status in ('expired', 'cancelled');
    continue when exists (select 1 from public.subscription_invoices i where i.school_id = s.school_id and i.voided_at is null
                          and private.invoice_paid_amount(i.id) < i.total);
    v_next := private.billing_next_period(s.school_id);
    continue when v_next - b.renewal_lead_days > private.ist_today();
    -- a period already invoiced (by a run that finished just before this one) is skipped, not an error
    continue when exists (select 1 from public.subscription_invoices i where i.school_id = s.school_id and i.voided_at is null
                          and i.period_start = v_next);
    perform private.billing_issue_invoice(s.school_id, v_next,
      case when exists (select 1 from public.subscription_invoices i where i.school_id = s.school_id and i.voided_at is null) then 'renewal' else 'subscription' end);
    n := n + 1;
  end loop;
  return n;
end $$;
-- (create or replace keeps its grants: erp_billing for the API's run, authenticated for the super admin)

-- 3 -----------------------------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'erp_ratelimit') then
    create role erp_ratelimit nologin noinherit;
  end if;
end $$;
grant erp_ratelimit to current_user;   -- the API connects as this user and switches to it to count requests
grant usage on schema private to erp_ratelimit;

create table if not exists private.rate_limits (
  key_hash bytea primary key,            -- sha256 of bucket + client (IP or user id): nothing readable is kept
  window_start timestamptz not null,
  hits integer not null
);
revoke all on private.rate_limits from public, anon, authenticated, service_role;

-- Counts one request. Returns 0 when it is allowed, otherwise the seconds until the window resets.
create or replace function private.rate_hit(p_key text, p_max integer, p_window integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_hash bytea := sha256(convert_to(p_key, 'UTF8')); r record; v_now timestamptz := clock_timestamp();
begin
  if current_setting('role', true) is distinct from 'erp_ratelimit' then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  if p_max < 1 or p_window < 1 or p_window > 86400 then raise exception 'Bad limit.' using errcode = '22023'; end if;
  insert into private.rate_limits as l (key_hash, window_start, hits) values (v_hash, v_now, 1)
  on conflict (key_hash) do update set
    window_start = case when l.window_start <= v_now - make_interval(secs => p_window) then v_now else l.window_start end,
    hits = case when l.window_start <= v_now - make_interval(secs => p_window) then 1 else l.hits + 1 end
  returning l.window_start, l.hits into r;
  -- forget clients that have gone quiet (about one call in 500 sweeps), so the table stays small
  if random() < 0.002 then
    delete from private.rate_limits where window_start < v_now - interval '1 day';
  end if;
  if r.hits > p_max then
    return greatest(1, ceil(extract(epoch from (r.window_start + make_interval(secs => p_window) - v_now)))::integer);
  end if;
  return 0;
end $$;
revoke all on function private.rate_hit(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function private.rate_hit(text, integer, integer) to erp_ratelimit;

-- 4 -----------------------------------------------------------------------------------------------
drop index if exists public.fee_payment_allocations_due_idx;   -- same as allocations_due_idx
create index if not exists fee_payments_enrollment_idx on public.fee_payments (enrollment_id);
create index if not exists online_payments_enrollment_idx on public.online_payments (enrollment_id);
create index if not exists dues_item_idx on public.student_fee_dues (fee_item_id);
create index if not exists optins_item_idx on public.student_fee_optins (fee_item_id);
create index if not exists exam_marks_enrollment_idx on public.exam_marks (enrollment_id);
create index if not exists report_card_remarks_enrollment_idx on public.report_card_remarks (enrollment_id);
create index if not exists report_card_remarks_student_idx on public.report_card_remarks (student_id);
create index if not exists homework_submissions_enrollment_idx on public.homework_submissions (enrollment_id);
create index if not exists payslips_teacher_idx on public.payslips (teacher_id);
create index if not exists payslip_adjustments_payslip_idx on public.payslip_adjustments (payslip_id);
create index if not exists id_cards_student_idx on public.id_cards (student_id) where student_id is not null;
create index if not exists id_cards_teacher_idx on public.id_cards (teacher_id) where teacher_id is not null;
create index if not exists timetable_entries_subject_idx on public.timetable_entries (subject_id);
create index if not exists library_loans_book_idx on public.library_loans (book_id);
create index if not exists library_books_category_idx on public.library_books (category_id) where category_id is not null;

-- 5 -----------------------------------------------------------------------------------------------
-- Row-level security that scaled with the size of the school. The parent/student ("portal") read
-- rules called private.can_view_student_record() once per ROW, and three of them ran a sub-query per
-- row as well: listing fee heads or fee structures scanned every student's dues once per head/item
-- (a school with 11 fee structures took 6 seconds to list them; with a full school's dues it would
-- time out). The same rules now compare against the caller's own children / own record, worked out
-- ONCE per query. Who can see what is unchanged (production_test.sql checks it, and every portal
-- test still passes).

-- The students the caller may see as a parent (an active parent of the student, in an active school)
-- or as the student themself (an active student account, in an active school). Same rule as
-- private.can_view_student_record(), as a list.
create or replace function private.my_student_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x.id), '{}') from (
    select g.student_id as id
    from public.student_guardians g
    join public.school_memberships m on m.user_id = g.user_id and m.school_id = g.school_id
                                     and m.role = 'parent' and m.status = 'active'
    join public.schools s on s.id = g.school_id and s.status = 'active'
    where g.user_id = (select auth.uid())
    union
    select st.id
    from public.students st
    join public.school_memberships m on m.user_id = st.account_id and m.school_id = st.school_id
                                     and m.role = 'student' and m.status = 'active'
    join public.schools s on s.id = st.school_id and s.status = 'active'
    where st.account_id = (select auth.uid())
  ) x;
$$;
revoke all on function private.my_student_ids() from public, anon;
grant execute on function private.my_student_ids() to authenticated;

alter policy students_select_portal on public.students using (id = any ((select private.my_student_ids())::uuid[]));
alter policy enrollments_select_portal on public.student_enrollments using (student_id = any ((select private.my_student_ids())::uuid[]));
alter policy attendance_select_portal on public.attendance_records using (student_id = any ((select private.my_student_ids())::uuid[]));
alter policy dues_select_portal on public.student_fee_dues using (student_id = any ((select private.my_student_ids())::uuid[]));
alter policy payments_select_portal on public.fee_payments using (student_id = any ((select private.my_student_ids())::uuid[]));
alter policy allocations_select_portal on public.fee_payment_allocations using (
  cardinality((select private.my_student_ids())) > 0
  and exists (select 1 from public.fee_payments p
              where p.id = fee_payment_allocations.payment_id and p.student_id = any ((select private.my_student_ids())::uuid[])));
alter policy fee_heads_select_portal on public.fee_heads using (
  cardinality((select private.my_student_ids())) > 0
  and exists (select 1 from public.student_fee_dues d
              where d.fee_head_id = fee_heads.id and d.student_id = any ((select private.my_student_ids())::uuid[])));
alter policy fee_items_select_portal on public.fee_structure_items using (
  cardinality((select private.my_student_ids())) > 0
  and exists (select 1 from public.student_fee_dues d
              where d.fee_item_id = fee_structure_items.id and d.student_id = any ((select private.my_student_ids())::uuid[])));
alter policy submissions_select on public.homework_submissions using (
  student_id = any ((select private.my_student_ids())::uuid[]) or private.can_manage_homework(homework_id));
alter policy exam_marks_select on public.exam_marks using (
  (select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin'::public.app_role])
  or private.teacher_assigned_section(section_id)
  or (student_id = any ((select private.my_student_ids())::uuid[]) and private.exam_paper_published(paper_id)));
alter policy rc_remarks_select on public.report_card_remarks using (
  (select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin'::public.app_role])
  or private.teacher_assigned_section(section_id)
  or (student_id = any ((select private.my_student_ids())::uuid[]) and private.exam_published(exam_id)));
alter policy library_loans_select on public.library_loans using (
  private.can_collect_library_fines(school_id)
  or (teacher_id is not null and teacher_id = private.current_teacher_id(school_id))
  or (student_id is not null and student_id = any ((select private.my_student_ids())::uuid[])));
alter policy transport_assignments_select on public.transport_assignments using (
  (select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin'::public.app_role, 'accountant'::public.app_role])
  or student_id = any ((select private.my_student_ids())::uuid[]));
create index if not exists dues_head_idx on public.student_fee_dues (fee_head_id);
