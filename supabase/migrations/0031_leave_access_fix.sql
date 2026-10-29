-- =====================================================================
-- 0031: leave access fix (found by the Phase 32 tenant API audit)
--
-- private.leave_cancel and private.leave_balances asked "is this the caller's own leave?" as
-- `teacher_id = private.current_staff_id(school)`. For someone with no staff record in that
-- school — another school's admin, a parent — that comparison is NULL, and `not (false or NULL)`
-- is NULL, so the refusal didn't fire: another school's staff could cancel a pending leave
-- application (or see a balance) by its id. The comparison now counts NULL as "not theirs".
-- Behaviour for everyone entitled is unchanged.
-- =====================================================================

create or replace function private.leave_cancel(p_app uuid, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.leave_applications; v_admin boolean; v_own boolean;
begin
  select * into a from public.leave_applications where id = p_app for update;
  if not found then raise exception 'Leave application not found.' using errcode = 'P0002'; end if;
  v_admin := coalesce(private.is_hr_admin(a.school_id), false);
  v_own := coalesce(a.teacher_id = private.current_staff_id(a.school_id), false);
  if not (v_admin or v_own) then raise exception 'Leave application not found.' using errcode = 'P0002'; end if;
  if a.status not in ('pending', 'approved') then raise exception 'This application is already %.', a.status using errcode = 'check_violation'; end if;
  if a.status = 'approved' and not v_admin and a.start_date <= private.ist_today() then
    raise exception 'Leave that has started can only be cancelled by the school office.' using errcode = 'check_violation';
  end if;
  if a.status = 'approved' and private.payroll_locked(a.school_id, a.start_date, a.end_date) then
    raise exception 'Payroll for that month is finalized, so its leave can''t change.' using errcode = 'check_violation';
  end if;
  update public.leave_applications set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
    decision_note = coalesce(nullif(btrim(p_note), ''), decision_note) where id = a.id;
end $$;

create or replace function private.leave_balances(p_school uuid, p_teacher uuid, p_session uuid)
returns table (leave_type_id uuid, name text, code text, is_paid boolean, allowance numeric, used numeric, pending numeric, available numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (coalesce(private.is_hr_admin(p_school), false) or coalesce(p_teacher = private.current_staff_id(p_school), false)) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  return query
    select t.id, t.name, t.code, t.is_paid, b.allowance, b.used, b.pending, b.available
    from public.leave_types t, lateral private.leave_balance(p_teacher, t.id, p_session) b
    where t.school_id = p_school and (t.is_active or b.used > 0 or b.pending > 0)
    order by t.is_paid desc, t.name;
end $$;
revoke all on function private.leave_cancel(uuid, text), private.leave_balances(uuid, uuid, uuid) from public, anon;
grant execute on function private.leave_cancel(uuid, text), private.leave_balances(uuid, uuid, uuid) to authenticated;
