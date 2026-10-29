-- =====================================================================
-- Phase 9: fee collection
--   student_fee_optins       which optional fees a student takes (e.g. transport)
--   student_fee_dues         what each student owes: one row per fee item per due month
--   fee_payments             receipts (immutable), with a unique receipt number
--   fee_payment_allocations  how each receipt is split across dues
-- Every money rule lives in SQL:
--   * dues are generated from the class's active fee structure (sync function);
--     a due that has any payment is frozen
--   * private.record_fee_payment() records a payment atomically: locks the dues,
--     refuses more than the outstanding balance, allocates the receipt number,
--     and returns the existing receipt for a repeated submission (idempotency key)
-- Access: school admins and accountants. Payments can never be edited or deleted.
-- =====================================================================

create type public.payment_mode as enum ('cash', 'upi', 'bank_transfer', 'cheque', 'other');

alter table public.student_enrollments add constraint student_enrollments_id_school_key unique (id, school_id);
alter table public.fee_structure_items add constraint fee_structure_items_id_school_key unique (id, school_id);

-- ---------- optional fee opt-ins ----------
create table public.student_fee_optins (
  school_id      uuid not null references public.schools (id) on delete cascade,
  enrollment_id  uuid not null,
  fee_item_id    uuid not null,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  primary key (enrollment_id, fee_item_id),
  constraint optins_enrollment_fkey foreign key (enrollment_id, school_id)
    references public.student_enrollments (id, school_id) on delete cascade,
  constraint optins_item_fkey foreign key (fee_item_id, school_id)
    references public.fee_structure_items (id, school_id) on delete cascade
);

-- ---------- dues ----------
create table public.student_fee_dues (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  enrollment_id  uuid not null,
  student_id     uuid not null,
  fee_item_id    uuid not null,
  fee_head_id    uuid not null,
  due_month      date not null check (due_month = date_trunc('month', due_month)::date),
  amount         numeric(12, 2) not null check (amount > 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint dues_id_school_key unique (id, school_id),
  constraint dues_one_per_month unique (enrollment_id, fee_item_id, due_month),
  constraint dues_enrollment_fkey foreign key (enrollment_id, school_id)
    references public.student_enrollments (id, school_id) on delete cascade,
  constraint dues_student_fkey foreign key (student_id, school_id) references public.students (id, school_id),
  -- removing a fee item removes its UNPAID dues; paid ones block the removal (allocations restrict)
  constraint dues_item_fkey foreign key (fee_item_id, school_id)
    references public.fee_structure_items (id, school_id) on delete cascade,
  constraint dues_head_fkey foreign key (fee_head_id, school_id) references public.fee_heads (id, school_id)
);
create index dues_enrollment_idx on public.student_fee_dues (enrollment_id, due_month);
create index dues_student_idx on public.student_fee_dues (student_id);

-- ---------- payments (receipts) ----------
create table public.fee_payments (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  student_id           uuid not null,
  enrollment_id        uuid not null,
  academic_session_id  uuid not null,
  receipt_number       text not null,
  payment_date         date not null,
  amount               numeric(12, 2) not null check (amount > 0),
  payment_mode         public.payment_mode not null,
  reference_number     text check (reference_number is null or char_length(btrim(reference_number)) between 1 and 60),
  remarks              text check (remarks is null or char_length(remarks) <= 300),
  balance_after        numeric(12, 2) not null check (balance_after >= 0),
  idempotency_key      uuid not null,
  received_by          uuid references auth.users (id) on delete set null,
  received_by_name     text,  -- snapshot of the cashier's name, printed on the receipt
  created_at           timestamptz not null default now(),
  constraint fee_payments_id_school_key unique (id, school_id),
  constraint fee_payments_receipt_key unique (school_id, receipt_number),
  constraint fee_payments_idempotency_key unique (school_id, idempotency_key),
  constraint fee_payments_reference_required
    check (payment_mode not in ('upi', 'bank_transfer', 'cheque') or coalesce(btrim(reference_number), '') <> ''),
  constraint fee_payments_student_fkey foreign key (student_id, school_id) references public.students (id, school_id),
  constraint fee_payments_enrollment_fkey foreign key (enrollment_id, school_id)
    references public.student_enrollments (id, school_id),
  constraint fee_payments_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id)
);
create index fee_payments_student_idx on public.fee_payments (student_id, payment_date desc);
create index fee_payments_school_date_idx on public.fee_payments (school_id, payment_date desc);

create table public.fee_payment_allocations (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  payment_id  uuid not null,
  due_id      uuid not null,
  amount      numeric(12, 2) not null check (amount > 0),
  constraint allocations_one_per_due unique (payment_id, due_id),
  constraint allocations_payment_fkey foreign key (payment_id, school_id) references public.fee_payments (id, school_id),
  constraint allocations_due_fkey foreign key (due_id, school_id) references public.student_fee_dues (id, school_id)
);
create index allocations_due_idx on public.fee_payment_allocations (due_id);

create trigger dues_updated_at before update on public.student_fee_dues for each row execute function private.set_updated_at();

-- A due that has payments can't change amount, item, month or student.
create or replace function private.freeze_paid_due()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.fee_payment_allocations a where a.due_id = old.id)
     and (new.amount, new.fee_item_id, new.due_month, new.enrollment_id)
         is distinct from (old.amount, old.fee_item_id, old.due_month, old.enrollment_id) then
    raise exception 'This fee already has payments, so it can''t be changed.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger dues_freeze_paid before update on public.student_fee_dues for each row execute function private.freeze_paid_due();

-- Friendly message when a structure change would remove a fee that has payments.
create or replace function private.guard_paid_item_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.student_fee_dues d join public.fee_payment_allocations a on a.due_id = d.id
             where d.fee_item_id = old.id)
     and exists (select 1 from public.schools where id = old.school_id) then
    raise exception 'Payments have been recorded against this fee, so it can''t be removed. Deactivate the structure instead.'
      using errcode = 'restrict_violation';
  end if;
  return old;
end $$;
create trigger fee_items_guard_paid before delete on public.fee_structure_items
  for each row execute function private.guard_paid_item_delete();

-- Counter shared helper (school_counters has no user grants).
create or replace function private.next_counter(p_school uuid, p_kind text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare n bigint;
begin
  -- only that school's admins/accountants (or the platform admin) may advance its counters
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin', 'accountant']::public.app_role[])) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  insert into private.school_counters as c (school_id, kind, last_value) values (p_school, p_kind, 1)
  on conflict (school_id, kind) do update set last_value = c.last_value + 1
  returning last_value into n;
  return n;
end $$;
revoke all on function private.next_counter(uuid, text) from public, anon;
grant execute on function private.next_counter(uuid, text) to authenticated;

-- =====================================================================
-- Dues: what each student should owe, from the ACTIVE fee structure of their
-- class. Unpaid dues follow the structure; paid dues are frozen. Inactive
-- students and archived sessions are left untouched.
-- =====================================================================
create or replace function private.wanted_dues(p_enrollment_ids uuid[])
returns table (enrollment_id uuid, school_id uuid, student_id uuid, fee_item_id uuid, fee_head_id uuid, due_month date, amount numeric)
language sql stable security invoker set search_path = '' as $$
  with enr as (
    select e.id, e.school_id, e.student_id, fs.id as structure_id
    from public.student_enrollments e
    join public.students s on s.id = e.student_id and s.status = 'active'
    join public.academic_sessions a on a.id = e.academic_session_id and a.archived_at is null
    join public.fee_structures fs on fs.academic_session_id = e.academic_session_id and fs.class_id = e.class_id and fs.is_active
    where e.id = any (p_enrollment_ids)
  ),
  sched as (
    select st.structure_id, x.*
    from (select distinct structure_id from enr) st
    cross join lateral private.fee_structure_schedule(st.structure_id) x
  )
  select enr.id, enr.school_id, enr.student_id, sc.fee_item_id, sc.fee_head_id, sc.due_month, sc.amount
  from enr join sched sc on sc.structure_id = enr.structure_id
  where not sc.is_optional
     or exists (select 1 from public.student_fee_optins o where o.enrollment_id = enr.id and o.fee_item_id = sc.fee_item_id);
$$;

create or replace function private.sync_student_dues(p_enrollment_ids uuid[])
returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_ids uuid[];
begin
  -- only enrollments we may change: active student, open session
  select coalesce(array_agg(e.id), '{}') into v_ids
  from public.student_enrollments e
  join public.students s on s.id = e.student_id and s.status = 'active'
  join public.academic_sessions a on a.id = e.academic_session_id and a.archived_at is null
  where e.id = any (p_enrollment_ids);
  if cardinality(v_ids) = 0 then return; end if;

  with w as (
    select * from private.wanted_dues(v_ids)
  ),
  -- unpaid dues that no longer apply
  removed as (
    delete from public.student_fee_dues d
    where d.enrollment_id = any (v_ids)
      and not exists (select 1 from public.fee_payment_allocations a where a.due_id = d.id)
      and not exists (select 1 from w where w.enrollment_id = d.enrollment_id and w.fee_item_id = d.fee_item_id and w.due_month = d.due_month)
    returning 1
  ),
  -- unpaid dues whose amount changed
  changed as (
    update public.student_fee_dues d set amount = w.amount
    from w
    where d.enrollment_id = w.enrollment_id and d.fee_item_id = w.fee_item_id and d.due_month = w.due_month
      and d.amount <> w.amount
      and not exists (select 1 from public.fee_payment_allocations a where a.due_id = d.id)
    returning 1
  )
  -- new dues
  insert into public.student_fee_dues (school_id, enrollment_id, student_id, fee_item_id, fee_head_id, due_month, amount)
  select w.school_id, w.enrollment_id, w.student_id, w.fee_item_id, w.fee_head_id, w.due_month, w.amount
  from w
  on conflict (enrollment_id, fee_item_id, due_month) do nothing;
end $$;

-- Per due: amount, paid, balance (RLS applies).
create or replace function private.student_fee_status(p_enrollment_id uuid)
returns table (
  due_id uuid, fee_item_id uuid, fee_head_name text, frequency public.fee_frequency, is_optional boolean,
  due_month date, amount numeric, paid numeric, balance numeric
)
language sql stable security invoker set search_path = '' as $$
  select d.id, d.fee_item_id, h.name, i.frequency, i.is_optional, d.due_month, d.amount,
         coalesce(p.paid, 0)::numeric(12, 2), (d.amount - coalesce(p.paid, 0))::numeric(12, 2)
  from public.student_fee_dues d
  join public.fee_heads h on h.id = d.fee_head_id
  join public.fee_structure_items i on i.id = d.fee_item_id
  left join lateral (select sum(a.amount) as paid from public.fee_payment_allocations a where a.due_id = d.id) p on true
  where d.enrollment_id = p_enrollment_id
  order by d.due_month, i.is_optional, h.name;
$$;

-- Per enrollment totals (for lists): total, paid, outstanding, overdue (due this month or earlier).
create or replace function private.enrollment_fee_totals(p_enrollment_ids uuid[])
returns table (enrollment_id uuid, total numeric, paid numeric, outstanding numeric, overdue numeric)
language sql stable security invoker set search_path = '' as $$
  select ids.id,
         coalesce(sum(d.amount), 0)::numeric(14, 2),
         coalesce(sum(p.paid), 0)::numeric(14, 2),
         coalesce(sum(d.amount - coalesce(p.paid, 0)), 0)::numeric(14, 2),
         coalesce(sum(d.amount - coalesce(p.paid, 0)) filter (where d.due_month <= date_trunc('month', current_date)), 0)::numeric(14, 2)
  from unnest(p_enrollment_ids) as ids(id)
  left join public.student_fee_dues d on d.enrollment_id = ids.id
  left join lateral (select sum(a.amount) as paid from public.fee_payment_allocations a where a.due_id = d.id) p on true
  group by ids.id;
$$;

-- =====================================================================
-- Record a payment, atomically.
--   p_allocations: [{"due_id": "...", "amount": "1500.00"}, ...]
-- Returns the receipt; a repeated idempotency key returns the ORIGINAL receipt.
-- =====================================================================
create or replace function private.record_fee_payment(
  p_enrollment_id uuid, p_payment_date date, p_mode public.payment_mode, p_reference text, p_remarks text,
  p_idempotency_key uuid, p_allocations jsonb
) returns table (payment_id uuid, receipt_number text, duplicate boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  v_enr record;
  v_existing record;
  v_total numeric(12, 2);
  v_bad record;
  v_payment uuid;
  v_receipt text;
  v_balance numeric(12, 2);
begin
  if p_idempotency_key is null then
    raise exception 'A submission key is required.' using errcode = 'check_violation';
  end if;

  select e.id, e.school_id, e.student_id, e.academic_session_id, a.name as session_name, a.archived_at, sc.code as school_code
    into v_enr
  from public.student_enrollments e
  join public.academic_sessions a on a.id = e.academic_session_id
  join public.schools sc on sc.id = e.school_id
  where e.id = p_enrollment_id;
  if not found then
    raise exception 'Student enrollment not found.' using errcode = 'no_data_found';
  end if;

  -- One submission = one receipt, even if it arrives twice at the same moment.
  perform pg_advisory_xact_lock(hashtextextended(v_enr.school_id::text || p_idempotency_key::text, 0));
  select fp.id, fp.receipt_number into v_existing
  from public.fee_payments fp where fp.school_id = v_enr.school_id and fp.idempotency_key = p_idempotency_key;
  if found then
    return query select v_existing.id, v_existing.receipt_number, true;
    return;
  end if;

  if v_enr.archived_at is not null then
    raise exception 'Session % is archived. Restore it to record payments.', v_enr.session_name using errcode = 'check_violation';
  end if;
  if p_payment_date is null or p_payment_date > current_date then
    raise exception 'The payment date can''t be in the future.' using errcode = 'check_violation';
  end if;
  if p_payment_date < date '2000-01-01' then
    raise exception 'Check the payment date.' using errcode = 'check_violation';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Choose at least one fee to pay.' using errcode = 'check_violation';
  end if;

  if exists (select 1 from jsonb_to_recordset(p_allocations) as al(due_id uuid, amount numeric) where amount is null or amount <= 0 or amount <> round(amount, 2)) then
    raise exception 'Each amount must be more than zero with at most 2 decimal places.' using errcode = 'check_violation';
  end if;
  if (select count(*) <> count(distinct due_id) from jsonb_to_recordset(p_allocations) as al(due_id uuid, amount numeric)) then
    raise exception 'The same fee appears twice in this payment.' using errcode = 'check_violation';
  end if;

  -- Lock the dues being paid so two cashiers can't both take the same balance.
  perform 1 from public.student_fee_dues d
   where d.id in (select al.due_id from jsonb_to_recordset(p_allocations) as al(due_id uuid, amount numeric)) for update;
  if (select count(*) from public.student_fee_dues d
      where d.id in (select al.due_id from jsonb_to_recordset(p_allocations) as al(due_id uuid, amount numeric))
        and d.enrollment_id = p_enrollment_id) <> jsonb_array_length(p_allocations) then
    raise exception 'One of the fees doesn''t belong to this student.' using errcode = 'check_violation';
  end if;

  -- No payment above the outstanding balance (no advance payments).
  select h.name, d.due_month, (d.amount - coalesce(sum(pa.amount), 0)) as outstanding, al.amount as asked
    into v_bad
  from jsonb_to_recordset(p_allocations) as al(due_id uuid, amount numeric)
  join public.student_fee_dues d on d.id = al.due_id
  join public.fee_heads h on h.id = d.fee_head_id
  left join public.fee_payment_allocations pa on pa.due_id = d.id
  group by h.name, d.due_month, d.amount, al.amount
  having al.amount > d.amount - coalesce(sum(pa.amount), 0)
  limit 1;
  if found then
    raise exception '% for % has only ₹% outstanding; ₹% is more than that.',
      v_bad.name, to_char(v_bad.due_month, 'Mon YYYY'), v_bad.outstanding, v_bad.asked
      using errcode = 'check_violation';
  end if;

  select sum(al.amount)::numeric(12, 2) into v_total from jsonb_to_recordset(p_allocations) as al(due_id uuid, amount numeric);
  v_receipt := v_enr.school_code || '/' || v_enr.session_name || '/'
               || lpad(private.next_counter(v_enr.school_id, 'receipt:' || v_enr.academic_session_id)::text, 6, '0');

  -- outstanding for the whole enrollment after this payment
  select coalesce(sum(d.amount - coalesce(p.paid, 0)), 0) - v_total into v_balance
  from public.student_fee_dues d
  left join lateral (select sum(pa.amount) as paid from public.fee_payment_allocations pa where pa.due_id = d.id) p on true
  where d.enrollment_id = p_enrollment_id;

  insert into public.fee_payments (school_id, student_id, enrollment_id, academic_session_id, receipt_number, payment_date,
                                   amount, payment_mode, reference_number, remarks, balance_after, idempotency_key, received_by,
                                   received_by_name)
  values (v_enr.school_id, v_enr.student_id, p_enrollment_id, v_enr.academic_session_id, v_receipt, p_payment_date,
          v_total, p_mode, nullif(btrim(p_reference), ''), nullif(btrim(p_remarks), ''), v_balance, p_idempotency_key,
          (select auth.uid()), (select nullif(pr.full_name, '') from public.profiles pr where pr.id = (select auth.uid())))
  returning id into v_payment;

  insert into public.fee_payment_allocations (school_id, payment_id, due_id, amount)
  select v_enr.school_id, v_payment, al.due_id, al.amount
  from jsonb_to_recordset(p_allocations) as al(due_id uuid, amount numeric);

  return query select v_payment, v_receipt, false;
end $$;

revoke all on function private.wanted_dues(uuid[]), private.sync_student_dues(uuid[]), private.student_fee_status(uuid),
  private.enrollment_fee_totals(uuid[]),
  private.record_fee_payment(uuid, date, public.payment_mode, text, text, uuid, jsonb) from public, anon;
grant execute on function private.wanted_dues(uuid[]), private.sync_student_dues(uuid[]), private.student_fee_status(uuid),
  private.enrollment_fee_totals(uuid[]),
  private.record_fee_payment(uuid, date, public.payment_mode, text, text, uuid, jsonb) to authenticated;

-- ---------- grants & RLS: admins + accountants; payments are append-only ----------
revoke all on public.student_fee_optins, public.student_fee_dues, public.fee_payments, public.fee_payment_allocations from anon;
-- Supabase grants everything to authenticated by default: start from nothing for receipts.
revoke all on public.fee_payments, public.fee_payment_allocations from authenticated;
-- (and close a gap from 0007: fee heads are deactivated, never deleted)
revoke delete on public.fee_heads from authenticated;
grant select, insert, delete on public.student_fee_optins to authenticated;
grant select, insert, update, delete on public.student_fee_dues to authenticated;
grant select, insert on public.fee_payment_allocations to authenticated;
grant select, insert on public.fee_payments to authenticated;  -- insert-only: receipts are never changed

alter table public.student_fee_optins enable row level security;
alter table public.student_fee_dues enable row level security;
alter table public.fee_payments enable row level security;
alter table public.fee_payment_allocations enable row level security;

create policy optins_all on public.student_fee_optins for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy dues_all on public.student_fee_dues for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy payments_select on public.fee_payments for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy payments_insert on public.fee_payments for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy allocations_select on public.fee_payment_allocations for select to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy allocations_insert on public.fee_payment_allocations for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
-- no delete policies on payments or allocations: receipts are permanent
