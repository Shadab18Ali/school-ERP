-- =====================================================================
-- Phase 8: fee structures
--   fee_heads             per-school catalogue (Tuition Fee, Transport Fee ...)
--   fee_structures        one per class per academic session
--   fee_structure_items   head + amount + frequency (+ optional, months, due month)
-- All money is numeric(12,2). All totals and schedules are computed here, in
-- SQL, from the session's real dates; the application never adds up amounts.
-- Access: school admins and accountants (read + write).
-- =====================================================================

create type public.fee_frequency as enum ('monthly', 'quarterly', 'half_yearly', 'yearly', 'one_time');

-- months like {4,5,6}: 1..12, no duplicates, not empty
create or replace function private.valid_months(m smallint[])
returns boolean language sql immutable as $$
  select m is null or (
    cardinality(m) between 1 and 12
    and (select bool_and(x between 1 and 12) and count(distinct x) = count(*) from unnest(m) as x)
  );
$$;

-- ---------- fee heads ----------
create table public.fee_heads (
  id           uuid primary key default gen_random_uuid(),
  school_id    uuid not null references public.schools (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 2 and 60),
  description  text check (description is null or char_length(description) <= 200),
  is_active    boolean not null default true,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint fee_heads_id_school_key unique (id, school_id)
);
create unique index fee_heads_school_name_key on public.fee_heads (school_id, lower(btrim(name)));

-- ---------- fee structures ----------
create table public.fee_structures (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  academic_session_id  uuid not null,
  class_id             uuid not null,
  name                 text check (name is null or char_length(btrim(name)) between 1 and 80),
  notes                text check (notes is null or char_length(notes) <= 500),
  is_active            boolean not null default true,
  copied_from_id       uuid references public.fee_structures (id) on delete set null,
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint fee_structures_id_school_key unique (id, school_id),
  constraint fee_structures_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id),
  constraint fee_structures_class_fkey foreign key (class_id, school_id)
    references public.classes (id, school_id),
  constraint fee_structures_one_per_class unique (academic_session_id, class_id)
);
create index fee_structures_school_session_idx on public.fee_structures (school_id, academic_session_id);

-- ---------- items ----------
create table public.fee_structure_items (
  id                uuid primary key default gen_random_uuid(),
  school_id         uuid not null references public.schools (id) on delete cascade,
  fee_structure_id  uuid not null,
  fee_head_id       uuid not null,
  amount            numeric(12, 2) not null check (amount > 0 and amount <= 10000000),
  frequency         public.fee_frequency not null,
  is_optional       boolean not null default false,
  billing_months    smallint[],   -- monthly only: which calendar months are billed (null = every month)
  due_month         smallint,     -- non-monthly: calendar month of the (first) due date (null = session start)
  sort_order        smallint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint fee_items_structure_fkey foreign key (fee_structure_id, school_id)
    references public.fee_structures (id, school_id) on delete cascade,
  constraint fee_items_head_fkey foreign key (fee_head_id, school_id)
    references public.fee_heads (id, school_id),
  constraint fee_items_one_per_head unique (fee_structure_id, fee_head_id),
  constraint fee_items_months_valid check (private.valid_months(billing_months)),
  constraint fee_items_months_only_monthly check (frequency = 'monthly' or billing_months is null),
  constraint fee_items_due_month_range check (due_month is null or due_month between 1 and 12),
  constraint fee_items_due_month_not_monthly check (frequency <> 'monthly' or due_month is null)
);
create index fee_items_structure_idx on public.fee_structure_items (fee_structure_id, sort_order);

-- ---------- triggers ----------
create trigger fee_heads_updated_at before update on public.fee_heads for each row execute function private.set_updated_at();
create trigger fee_structures_updated_at before update on public.fee_structures for each row execute function private.set_updated_at();
create trigger fee_items_updated_at before update on public.fee_structure_items for each row execute function private.set_updated_at();
create trigger fee_heads_lock_school before update on public.fee_heads for each row execute function private.prevent_school_change();
create trigger fee_structures_lock_school before update on public.fee_structures for each row execute function private.prevent_school_change();
create trigger fee_items_lock_school before update on public.fee_structure_items for each row execute function private.prevent_school_change();

-- Structures of an archived session are read-only; a structure keeps its class and session.
create or replace function private.guard_fee_structure()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_sid uuid;
  v_name text;
  v_archived timestamptz;
begin
  -- Deleting a whole school cascades through here: allowed.
  if tg_op = 'DELETE' and not exists (select 1 from public.schools where id = old.school_id) then
    return old;
  end if;

  if tg_table_name = 'fee_structures' then
    if tg_op = 'UPDATE' and (new.academic_session_id <> old.academic_session_id or new.class_id <> old.class_id) then
      raise exception 'A fee structure cannot be moved to another class or session. Copy it instead.'
        using errcode = 'check_violation';
    end if;
    v_sid := case when tg_op = 'DELETE' then old.academic_session_id else new.academic_session_id end;
  else
    if tg_op = 'UPDATE' and new.fee_structure_id <> old.fee_structure_id then
      raise exception 'A fee item cannot be moved to another structure.' using errcode = 'check_violation';
    end if;
    select fs.academic_session_id into v_sid from public.fee_structures fs
     where fs.id = case when tg_op = 'DELETE' then old.fee_structure_id else new.fee_structure_id end;
  end if;

  select name, archived_at into v_name, v_archived from public.academic_sessions where id = v_sid;
  if v_archived is not null then
    raise exception 'Session % is archived, so its fee structures are read-only.', v_name
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

create trigger fee_structures_guard before insert or update or delete on public.fee_structures
  for each row execute function private.guard_fee_structure();
create trigger fee_items_guard before insert or update or delete on public.fee_structure_items
  for each row execute function private.guard_fee_structure();

-- =====================================================================
-- Calculations (SECURITY INVOKER: RLS applies to whoever calls them)
-- =====================================================================

-- Every due date of every item, month by month, from the session's actual dates.
--   monthly      every session month (or only billing_months)
--   quarterly    from the due month, every 3 months while the session lasts
--   half_yearly  from the due month, every 6 months
--   yearly / one_time  once, in the due month (default: first session month)
create or replace function private.fee_structure_schedule(p_structure_id uuid)
returns table (
  due_month date, fee_item_id uuid, fee_head_id uuid, fee_head_name text,
  amount numeric, frequency public.fee_frequency, is_optional boolean
)
language sql stable security invoker set search_path = '' as $$
  with st as (
    select s.start_date, s.end_date
    from public.fee_structures fs
    join public.academic_sessions s on s.id = fs.academic_session_id
    where fs.id = p_structure_id
  ),
  months as (
    select (row_number() over (order by m) - 1)::int as idx, m::date as month, extract(month from m)::int as mn
    from st, generate_series(date_trunc('month', st.start_date), date_trunc('month', st.end_date), interval '1 month') as m
  ),
  items as (
    select i.id, i.fee_head_id, h.name as head_name, i.amount, i.frequency, i.is_optional, i.billing_months,
           coalesce((select min(mo.idx) from months mo where mo.mn = i.due_month), 0) as due_idx
    from public.fee_structure_items i
    join public.fee_heads h on h.id = i.fee_head_id
    where i.fee_structure_id = p_structure_id
  )
  select m.month, it.id, it.fee_head_id, it.head_name, it.amount, it.frequency, it.is_optional
  from items it
  join months m on case it.frequency
      when 'monthly'     then it.billing_months is null or m.mn = any (it.billing_months)
      when 'quarterly'   then m.idx >= it.due_idx and (m.idx - it.due_idx) % 3 = 0
      when 'half_yearly' then m.idx >= it.due_idx and (m.idx - it.due_idx) % 6 = 0
      else m.idx = it.due_idx
    end
  order by m.month, it.head_name;
$$;

-- Per item: how many times it falls due in the session, the yearly amount, and the months.
create or replace function private.fee_item_breakdown(p_structure_id uuid)
returns table (fee_item_id uuid, occurrences int, annual_amount numeric, due_months date[])
language sql stable security invoker set search_path = '' as $$
  select i.id,
         count(s.due_month)::int,
         coalesce(sum(s.amount), 0)::numeric(14, 2),
         coalesce(array_agg(s.due_month order by s.due_month) filter (where s.due_month is not null), '{}')
  from public.fee_structure_items i
  left join private.fee_structure_schedule(p_structure_id) s on s.fee_item_id = i.id
  where i.fee_structure_id = p_structure_id
  group by i.id;
$$;

-- Per structure: the figures a school and a parent care about.
create or replace function private.fee_structure_totals(p_structure_ids uuid[])
returns table (
  fee_structure_id uuid, item_count int,
  annual_compulsory numeric, annual_optional numeric,
  monthly_compulsory numeric, one_time_compulsory numeric
)
language sql stable security invoker set search_path = '' as $$
  select ids.id,
         (select count(*) from public.fee_structure_items i where i.fee_structure_id = ids.id)::int,
         coalesce(sum(s.amount) filter (where not s.is_optional), 0)::numeric(14, 2),
         coalesce(sum(s.amount) filter (where s.is_optional), 0)::numeric(14, 2),
         (select coalesce(sum(i.amount), 0) from public.fee_structure_items i
           where i.fee_structure_id = ids.id and i.frequency = 'monthly' and not i.is_optional)::numeric(14, 2),
         (select coalesce(sum(i.amount), 0) from public.fee_structure_items i
           where i.fee_structure_id = ids.id and i.frequency = 'one_time' and not i.is_optional)::numeric(14, 2)
  from unnest(p_structure_ids) as ids(id)
  left join lateral private.fee_structure_schedule(ids.id) s on true
  group by ids.id;
$$;

-- Copy a structure (with an optional % change, rounded to the nearest p_round_to rupees).
create or replace function private.copy_fee_structure(
  p_source uuid, p_session uuid, p_class uuid, p_increase_percent numeric default 0, p_round_to numeric default 1
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_new uuid;
  v_src public.fee_structures%rowtype;
begin
  if p_round_to is null or p_round_to <= 0 then
    raise exception 'Rounding must be a positive amount.' using errcode = 'check_violation';
  end if;
  if p_increase_percent is null or p_increase_percent < -50 or p_increase_percent > 100 then
    raise exception 'The change must be between -50%% and +100%%.' using errcode = 'check_violation';
  end if;
  select * into v_src from public.fee_structures where id = p_source;
  if not found then
    raise exception 'Fee structure not found.' using errcode = 'no_data_found';
  end if;

  insert into public.fee_structures (school_id, academic_session_id, class_id, name, notes, is_active, copied_from_id, created_by)
  values (v_src.school_id, p_session, p_class, v_src.name, v_src.notes, true, v_src.id, (select auth.uid()))
  returning id into v_new;

  insert into public.fee_structure_items
    (school_id, fee_structure_id, fee_head_id, amount, frequency, is_optional, billing_months, due_month, sort_order)
  select i.school_id, v_new, i.fee_head_id,
         greatest(p_round_to, round(i.amount * (1 + p_increase_percent / 100) / p_round_to) * p_round_to)::numeric(12, 2),
         i.frequency, i.is_optional, i.billing_months, i.due_month, i.sort_order
  from public.fee_structure_items i
  where i.fee_structure_id = p_source;

  return v_new;
end $$;

revoke all on function private.fee_structure_schedule(uuid), private.fee_item_breakdown(uuid),
  private.fee_structure_totals(uuid[]), private.copy_fee_structure(uuid, uuid, uuid, numeric, numeric) from public, anon;
grant execute on function private.fee_structure_schedule(uuid), private.fee_item_breakdown(uuid),
  private.fee_structure_totals(uuid[]), private.copy_fee_structure(uuid, uuid, uuid, numeric, numeric),
  private.valid_months(smallint[]) to authenticated;

-- ---------- grants & RLS: school admins + accountants ----------
revoke all on public.fee_heads, public.fee_structures, public.fee_structure_items from anon;
grant select, insert, update on public.fee_heads to authenticated;
grant select, insert, update, delete on public.fee_structures, public.fee_structure_items to authenticated;

alter table public.fee_heads enable row level security;
alter table public.fee_structures enable row level security;
alter table public.fee_structure_items enable row level security;

create policy fee_heads_all on public.fee_heads for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy fee_structures_all on public.fee_structures for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
create policy fee_items_all on public.fee_structure_items for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));
-- fee heads: no delete grant at all (deactivate instead); structures: deactivate is
-- the normal path, delete exists so an empty mistake can be removed.
