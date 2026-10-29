-- =====================================================================
-- Phase 25: school inventory
--   inventory_items      what the school owns or stocks: category (computer, furniture,
--                        laboratory, sports, stationery, electronics, other), quantity on
--                        hand, purchase date and cost, location, condition and the staff
--                        member it is assigned to. Each item gets a code (INV-00001...).
--   inventory_movements  the item's history, append-only: stock in (opening, purchase,
--                        donation, returned, found, adjustment), stock out (issued,
--                        consumed, damaged, lost, disposed, returned to vendor, adjustment)
--                        and changes of location, condition, assignee or name.
--
-- Quantity is never typed in: it changes only through private.inventory_move, which
-- locks the item, refuses to take out more than is in stock and records the balance.
-- Changes to location / condition / assignee are logged by a trigger. Movements can't
-- be edited or deleted — a mistake is corrected with an adjustment.
-- Admins manage; accountants read; a staff member sees the items assigned to them.
-- =====================================================================

create table public.inventory_items (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  item_code            text not null check (item_code ~ '^INV-[0-9]{5,}$'),
  name                 text not null check (char_length(btrim(name)) between 2 and 150),
  category             text not null check (category in ('computer', 'furniture', 'laboratory', 'sports', 'stationery', 'electronics', 'other')),
  unit                 text not null default 'piece'
                       check (unit in ('piece', 'set', 'pair', 'box', 'pack', 'ream', 'dozen', 'kg', 'litre', 'metre', 'roll', 'bottle')),
  brand_model          text check (brand_model is null or char_length(brand_model) <= 120),
  serial_number        text check (serial_number is null or char_length(serial_number) <= 80),
  description          text check (description is null or char_length(description) <= 500),
  quantity             numeric(12, 2) not null default 0 check (quantity >= 0),
  min_quantity         numeric(12, 2) check (min_quantity is null or min_quantity >= 0),   -- reorder level
  unit_cost            numeric(12, 2) check (unit_cost is null or (unit_cost >= 0 and unit_cost <= 100000000)),
  purchase_date        date check (purchase_date is null or purchase_date >= date '1950-01-01'),
  vendor               text check (vendor is null or char_length(vendor) <= 120),
  location             text not null check (char_length(btrim(location)) between 1 and 100),
  condition            text not null default 'good' check (condition in ('new', 'good', 'fair', 'needs_repair', 'damaged', 'unusable')),
  assigned_teacher_id  uuid,
  is_active            boolean not null default true,   -- false = archived (no longer stocked or written off)
  notes                text check (notes is null or char_length(notes) <= 500),
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint inventory_items_id_school_key unique (id, school_id),
  constraint inventory_items_teacher_fkey foreign key (assigned_teacher_id, school_id) references public.teachers (id, school_id)
);
create unique index inventory_items_code_key on public.inventory_items (school_id, item_code);
create index inventory_items_school_idx on public.inventory_items (school_id, category, lower(name));
create index inventory_items_teacher_idx on public.inventory_items (assigned_teacher_id) where assigned_teacher_id is not null;

create table public.inventory_movements (
  id             uuid primary key default gen_random_uuid(),
  school_id      uuid not null references public.schools (id) on delete cascade,
  item_id        uuid not null,
  kind           text not null check (kind in ('in', 'out', 'change')),
  reason         text not null,
  quantity       numeric(12, 2) not null,
  balance_after  numeric(12, 2) not null check (balance_after >= 0),
  moved_on       date not null check (moved_on >= date '1950-01-01'),
  unit_cost      numeric(12, 2) check (unit_cost is null or (unit_cost >= 0 and unit_cost <= 100000000)),
  total_cost     numeric(14, 2) generated always as (case when unit_cost is null then null else round(quantity * unit_cost, 2) end) stored,
  vendor         text check (vendor is null or char_length(vendor) <= 120),
  reference      text check (reference is null or char_length(reference) <= 60),   -- bill, voucher or issue slip number
  teacher_id     uuid,                                                               -- staff member it went to / came back from
  recipient      text check (recipient is null or char_length(recipient) <= 120),    -- or who/where else, e.g. "Class 5-A"
  note           text check (note is null or char_length(note) <= 300),
  changes        jsonb,                                                              -- kind = change: {"field": {"from": .., "to": ..}}
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint inventory_movements_item_fkey foreign key (item_id, school_id) references public.inventory_items (id, school_id) on delete cascade,
  constraint inventory_movements_teacher_fkey foreign key (teacher_id, school_id) references public.teachers (id, school_id),
  constraint inventory_movements_reason check (
    (kind = 'in' and reason in ('opening', 'purchase', 'donation', 'returned', 'found', 'adjustment'))
    or (kind = 'out' and reason in ('issued', 'consumed', 'damaged', 'lost', 'disposed', 'returned_to_vendor', 'adjustment'))
    or (kind = 'change' and reason = 'details')),
  constraint inventory_movements_quantity check ((kind = 'change') = (quantity = 0) and quantity >= 0),
  constraint inventory_movements_cost_in check (kind = 'in' or (unit_cost is null and vendor is null)),
  constraint inventory_movements_changes check ((kind = 'change') = (changes is not null))
);
create index inventory_movements_item_idx on public.inventory_movements (item_id, created_at desc);
create index inventory_movements_school_idx on public.inventory_movements (school_id, moved_on desc, created_at desc);

create trigger inventory_items_updated_at before update on public.inventory_items for each row execute function private.set_updated_at();
create trigger inventory_items_school_guard before update on public.inventory_items for each row execute function private.prevent_school_change();

-- ---------------------------------------------------------------------
-- Item codes, clean text, assignee must be active staff
-- ---------------------------------------------------------------------
create or replace function private.inventory_item_before() returns trigger language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtext('inventory_code:' || new.school_id::text));
    select coalesce(max(substring(item_code from 5)::integer), 0) + 1 into n from public.inventory_items where school_id = new.school_id;
    new.item_code := 'INV-' || lpad(n::text, 5, '0');
    new.quantity := 0;   -- stock arrives only through inventory_move
  elsif new.item_code <> old.item_code then
    raise exception 'An item''s code can''t be changed.' using errcode = 'check_violation';
  end if;
  new.name := regexp_replace(btrim(new.name), '\s+', ' ', 'g');
  new.location := regexp_replace(btrim(new.location), '\s+', ' ', 'g');
  if new.assigned_teacher_id is not null and (tg_op = 'INSERT' or new.assigned_teacher_id is distinct from old.assigned_teacher_id)
     and not exists (select 1 from public.teachers t where t.id = new.assigned_teacher_id and t.status = 'active') then
    raise exception 'Items can only be assigned to active staff.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger inventory_items_before before insert or update on public.inventory_items for each row execute function private.inventory_item_before();

-- An item with stock history is kept (archive it instead); a fresh one entered by mistake can go.
create or replace function private.inventory_item_delete_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- maintenance only (clearing a test school), like library.allow_delete; the API never sets it
  if current_setting('inventory.allow_delete', true) = 'on' then return old; end if;
  if (select count(*) from public.inventory_movements m where m.item_id = old.id and m.kind <> 'change') > 1 then
    raise exception 'This item has stock history, so it is kept for the records. Archive it instead.' using errcode = 'foreign_key_violation';
  end if;
  return old;
end $$;
create trigger inventory_items_delete_guard before delete on public.inventory_items for each row execute function private.inventory_item_delete_guard();

-- History is append-only (rows go only with their item or school).
create or replace function private.inventory_movements_locked() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.inventory_items i where i.id = old.item_id) then
    return old;   -- the item (or the school) is being deleted
  end if;
  raise exception 'Stock history can''t be changed. Record an adjustment instead.' using errcode = 'check_violation';
end $$;
create trigger inventory_movements_locked before update or delete on public.inventory_movements
  for each row execute function private.inventory_movements_locked();

-- Log changes of where the item is, its condition, who has it, its name, archiving.
create or replace function private.inventory_item_changed() returns trigger language plpgsql security definer set search_path = '' as $$
declare c jsonb := '{}';
  teacher_name text;
begin
  if new.location is distinct from old.location then
    c := c || jsonb_build_object('location', jsonb_build_object('from', old.location, 'to', new.location));
  end if;
  if new.condition is distinct from old.condition then
    c := c || jsonb_build_object('condition', jsonb_build_object('from', old.condition, 'to', new.condition));
  end if;
  if new.assigned_teacher_id is distinct from old.assigned_teacher_id then
    c := c || jsonb_build_object('assigned_to', jsonb_build_object(
      'from', (select t.full_name from public.teachers t where t.id = old.assigned_teacher_id),
      'to', (select t.full_name from public.teachers t where t.id = new.assigned_teacher_id)));
  end if;
  if new.name is distinct from old.name then
    c := c || jsonb_build_object('name', jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  if new.is_active is distinct from old.is_active then
    c := c || jsonb_build_object('archived', jsonb_build_object('from', not old.is_active, 'to', not new.is_active));
  end if;
  if c <> '{}' then
    insert into public.inventory_movements (school_id, item_id, kind, reason, quantity, balance_after, moved_on, changes, created_by)
    values (new.school_id, new.id, 'change', 'details', 0, new.quantity, private.ist_today(), c, auth.uid());
  end if;
  return null;
end $$;
create trigger inventory_items_changed after update on public.inventory_items for each row execute function private.inventory_item_changed();

-- ---------------------------------------------------------------------
-- Stock in / out
-- ---------------------------------------------------------------------
create or replace function private.is_inventory_admin(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[]);
$$;

create or replace function private.inventory_unit_text(p_unit text, p_quantity numeric)
returns text language sql immutable set search_path = '' as $$
  select case when p_quantity = 1 or p_unit in ('dozen', 'kg') then p_unit when p_unit = 'box' then 'boxes' else p_unit || 's' end;
$$;

create or replace function private.inventory_move(
  p_item uuid, p_kind text, p_reason text, p_quantity numeric, p_moved_on date,
  p_unit_cost numeric, p_vendor text, p_reference text, p_teacher uuid, p_recipient text, p_note text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare i public.inventory_items; v_balance numeric; v_id uuid;
begin
  select * into i from public.inventory_items where id = p_item for update;
  if not found or not private.is_inventory_admin(i.school_id) then
    raise exception 'Item not found.' using errcode = 'P0002';
  end if;
  if p_kind not in ('in', 'out') then raise exception 'Choose stock in or stock out.' using errcode = 'check_violation'; end if;
  if not i.is_active then
    raise exception '% is archived. Restore it before recording stock.', i.name using errcode = 'check_violation';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 2) then
    raise exception 'Enter a quantity greater than zero.' using errcode = 'check_violation';
  end if;
  if i.unit not in ('kg', 'litre', 'metre') and p_quantity <> trunc(p_quantity) then
    raise exception 'Enter a whole number (% is counted in %).', i.name, private.inventory_unit_text(i.unit, 2) using errcode = 'check_violation';
  end if;
  if p_moved_on is null or p_moved_on > private.ist_today() then
    raise exception 'The date can''t be in the future.' using errcode = 'check_violation';
  end if;
  if p_kind = 'out' and p_quantity > i.quantity then
    raise exception 'Only % % of % in stock.', trim_scale(i.quantity), private.inventory_unit_text(i.unit, i.quantity), i.name
      using errcode = 'check_violation';
  end if;
  if p_kind = 'out' and (p_unit_cost is not null or nullif(btrim(p_vendor), '') is not null) then
    raise exception 'Cost and vendor are recorded with stock in only.' using errcode = 'check_violation';
  end if;
  if p_teacher is not null and not exists (select 1 from public.teachers t where t.id = p_teacher and t.school_id = i.school_id and t.status = 'active') then
    raise exception 'Choose an active staff member.' using errcode = 'check_violation';
  end if;
  if p_kind = 'out' and p_reason = 'issued' and p_teacher is null and nullif(btrim(p_recipient), '') is null then
    raise exception 'Say who the items were issued to.' using errcode = 'check_violation';
  end if;

  v_balance := i.quantity + case when p_kind = 'in' then p_quantity else -p_quantity end;
  update public.inventory_items set quantity = v_balance where id = i.id;
  insert into public.inventory_movements (school_id, item_id, kind, reason, quantity, balance_after, moved_on, unit_cost, vendor,
                                          reference, teacher_id, recipient, note, created_by)
  values (i.school_id, i.id, p_kind, p_reason, p_quantity, v_balance, p_moved_on, p_unit_cost, nullif(btrim(p_vendor), ''),
          nullif(btrim(p_reference), ''), p_teacher, nullif(btrim(p_recipient), ''), nullif(btrim(p_note), ''), auth.uid())
  returning id into v_id;

  -- a purchase (or opening stock with a cost) updates the item's latest purchase details
  if p_kind = 'in' and p_reason in ('purchase', 'opening') and (i.purchase_date is null or p_moved_on >= i.purchase_date) then
    update public.inventory_items set purchase_date = p_moved_on, unit_cost = coalesce(p_unit_cost, unit_cost),
      vendor = coalesce(nullif(btrim(p_vendor), ''), vendor) where id = i.id;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Dashboard (admins and accountants)
-- ---------------------------------------------------------------------
create or replace function private.inventory_dashboard(p_school uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.ist_today(); v_month date := date_trunc('month', private.ist_today())::date; out jsonb;
begin
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin', 'accountant']::public.app_role[])) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  with items as (select * from public.inventory_items where school_id = p_school and is_active),
  cats as (
    select c.category,
           count(i.id) as items,
           coalesce(sum(i.quantity), 0) as quantity,
           coalesce(sum(i.quantity * i.unit_cost), 0) as value
    from unnest(array['computer', 'furniture', 'laboratory', 'sports', 'stationery', 'electronics', 'other']) with ordinality c(category, n)
    left join items i on i.category = c.category
    group by c.category, c.n order by c.n),
  moves as (select * from public.inventory_movements where school_id = p_school and kind <> 'change')
  select jsonb_build_object(
    'items', (select count(*) from items),
    'archived', (select count(*) from public.inventory_items where school_id = p_school and not is_active),
    'value', (select coalesce(sum(quantity * unit_cost), 0) from items),
    'items_without_cost', (select count(*) from items where unit_cost is null and quantity > 0),
    'low_stock', (select count(*) from items where min_quantity is not null and quantity <= min_quantity),
    'out_of_stock', (select count(*) from items where quantity = 0),
    'needs_attention', (select count(*) from items where condition in ('needs_repair', 'damaged', 'unusable') and quantity > 0),
    'assigned', (select count(*) from items where assigned_teacher_id is not null),
    'month_in', (select count(*) from moves where kind = 'in' and moved_on >= v_month and moved_on <= v_today),
    'month_out', (select count(*) from moves where kind = 'out' and moved_on >= v_month and moved_on <= v_today),
    'month_spent', (select coalesce(sum(total_cost), 0) from moves where kind = 'in' and reason = 'purchase' and moved_on >= v_month),
    'year_spent', (select coalesce(sum(total_cost), 0) from moves where kind = 'in' and reason = 'purchase'
                   and moved_on >= (case when extract(month from v_today) >= 4 then make_date(extract(year from v_today)::int, 4, 1)
                                         else make_date(extract(year from v_today)::int - 1, 4, 1) end)),
    'by_category', (select jsonb_agg(jsonb_build_object('category', category, 'items', items, 'quantity', quantity, 'value', value)) from cats),
    'low_stock_items', (select coalesce(jsonb_agg(x order by x.quantity, x.name), '[]') from (
        select id, item_code, name, category, unit, quantity, min_quantity, location from items
        where min_quantity is not null and quantity <= min_quantity order by quantity, name limit 10) x),
    'attention_items', (select coalesce(jsonb_agg(x order by x.name), '[]') from (
        select id, item_code, name, category, condition, quantity, unit, location from items
        where condition in ('needs_repair', 'damaged', 'unusable') and quantity > 0 order by name limit 10) x)
  ) into out;
  return out;
end $$;

-- ---------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------
revoke all on public.inventory_items, public.inventory_movements from anon, authenticated;
grant select on public.inventory_items, public.inventory_movements to authenticated;
grant insert (id, school_id, name, category, unit, brand_model, serial_number, description, min_quantity, unit_cost, purchase_date, vendor,
              location, condition, assigned_teacher_id, notes, created_by) on public.inventory_items to authenticated;
grant update (name, category, unit, brand_model, serial_number, description, min_quantity, unit_cost, purchase_date, vendor,
              location, condition, assigned_teacher_id, is_active, notes) on public.inventory_items to authenticated;
grant delete on public.inventory_items to authenticated;
-- quantity and item_code are never written by clients; movements only through inventory_move and the change trigger

alter table public.inventory_items enable row level security;
alter table public.inventory_movements enable row level security;
create policy inventory_items_select on public.inventory_items for select to authenticated using (
  private.is_super_admin() or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[])
  or (assigned_teacher_id is not null and assigned_teacher_id = private.current_teacher_id(school_id)));   -- staff: what they hold
create policy inventory_items_insert on public.inventory_items for insert to authenticated with check (private.is_inventory_admin(school_id));
create policy inventory_items_update on public.inventory_items for update to authenticated
  using (private.is_inventory_admin(school_id)) with check (private.is_inventory_admin(school_id));
create policy inventory_items_delete on public.inventory_items for delete to authenticated using (private.is_inventory_admin(school_id));
create policy inventory_movements_select on public.inventory_movements for select to authenticated using (
  private.is_super_admin() or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]));

revoke all on function private.is_inventory_admin(uuid),
  private.inventory_move(uuid, text, text, numeric, date, numeric, text, text, uuid, text, text),
  private.inventory_dashboard(uuid) from public, anon, authenticated;
grant execute on function private.is_inventory_admin(uuid),
  private.inventory_move(uuid, text, text, numeric, date, numeric, text, text, uuid, text, text),
  private.inventory_dashboard(uuid) to authenticated;
