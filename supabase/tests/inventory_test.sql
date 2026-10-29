-- =====================================================================
-- Inventory test (migrations 0001-0024). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL INVENTORY TESTS PASSED".
-- School A: admin, accountant, teacher (staff record, login), an inactive staff member,
-- librarian, parent. School B: admin.
-- =====================================================================
begin;

create function private._i_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._i_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._i_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._i_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- what the owner sees (bypasses RLS), for checking results
create function private._i_item(p_id uuid) returns public.inventory_items language sql security definer set search_path = '' as $$
  select * from public.inventory_items where id = p_id;
$$;
create function private._i_moves(p_id uuid, p_kind text) returns bigint language sql security definer set search_path = '' as $$
  select count(*) from public.inventory_movements where item_id = p_id and kind = p_kind;
$$;
grant execute on function private._i_assert(boolean, text), private._i_eq(numeric, numeric, text), private._i_raises(text, text, text, text),
  private._i_as(uuid), private._i_item(uuid), private._i_moves(uuid, text) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a2500000-0000-4000-8000-000000000001', 'iv-admin@example.invalid'),
  ('a2500000-0000-4000-8000-000000000002', 'iv-accountant@example.invalid'),
  ('a2500000-0000-4000-8000-000000000003', 'iv-teacher@example.invalid'),
  ('a2500000-0000-4000-8000-000000000004', 'iv-librarian@example.invalid'),
  ('a2500000-0000-4000-8000-000000000005', 'iv-parent@example.invalid'),
  ('a2500000-0000-4000-8000-000000000006', 'iv-admin-b@example.invalid'),
  ('a2500000-0000-4000-8000-000000000007', 'iv-teacher2@example.invalid');
insert into public.schools (id, name, code) values
  ('b2500000-0000-4000-8000-00000000000a', 'Inventory A', 'ZZIV-A'),
  ('b2500000-0000-4000-8000-00000000000b', 'Inventory B', 'ZZIV-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b2500000-0000-4000-8000-00000000000a', 'a2500000-0000-4000-8000-000000000001', 'school_admin'),
  ('b2500000-0000-4000-8000-00000000000a', 'a2500000-0000-4000-8000-000000000002', 'accountant'),
  ('b2500000-0000-4000-8000-00000000000a', 'a2500000-0000-4000-8000-000000000003', 'teacher'),
  ('b2500000-0000-4000-8000-00000000000a', 'a2500000-0000-4000-8000-000000000004', 'librarian'),
  ('b2500000-0000-4000-8000-00000000000a', 'a2500000-0000-4000-8000-000000000005', 'parent'),
  ('b2500000-0000-4000-8000-00000000000a', 'a2500000-0000-4000-8000-000000000007', 'teacher'),
  ('b2500000-0000-4000-8000-00000000000b', 'a2500000-0000-4000-8000-000000000006', 'school_admin');
insert into public.teachers (id, school_id, employee_id, full_name, phone, email, joining_date, account_id, status) values
  ('c2500000-0000-4000-8000-000000000001', 'b2500000-0000-4000-8000-00000000000a', 'T-1', 'Teacher One', '9811111111', 'iv-teacher@example.invalid', '2020-06-01', 'a2500000-0000-4000-8000-000000000003', 'active'),
  ('c2500000-0000-4000-8000-000000000002', 'b2500000-0000-4000-8000-00000000000a', 'T-2', 'Gone Teacher', '9811111112', 'gone@example.invalid', '2019-06-01', null, 'inactive'),
  ('c2500000-0000-4000-8000-000000000003', 'b2500000-0000-4000-8000-00000000000a', 'T-3', 'Teacher Two', '9811111113', 'iv-teacher2@example.invalid', '2021-06-01', 'a2500000-0000-4000-8000-000000000007', 'active'),
  ('c2500000-0000-4000-8000-00000000000b', 'b2500000-0000-4000-8000-00000000000b', 'T-1', 'Teacher B', '9811111119', 'tb@example.invalid', '2020-06-01', null, 'active');

-- ================= items =================
select private._i_as('a2500000-0000-4000-8000-000000000001');  -- admin A
insert into public.inventory_items (id, school_id, name, category, unit, location, condition, min_quantity, serial_number) values
  ('d2500000-0000-4000-8000-000000000001', 'b2500000-0000-4000-8000-00000000000a', '  Desktop   computer ', 'computer', 'piece', 'Computer Lab', 'new', null, null),
  ('d2500000-0000-4000-8000-000000000002', 'b2500000-0000-4000-8000-00000000000a', 'A4 paper', 'stationery', 'ream', 'Store room', 'good', 20, null),
  ('d2500000-0000-4000-8000-000000000003', 'b2500000-0000-4000-8000-00000000000a', 'Copper sulphate', 'laboratory', 'kg', 'Chemistry Lab', 'good', null, null),
  ('d2500000-0000-4000-8000-000000000004', 'b2500000-0000-4000-8000-00000000000a', 'Wrong entry', 'other', 'piece', 'Office', 'good', null, null);
select private._i_assert((select item_code = 'INV-00001' and name = 'Desktop computer' and quantity = 0
  from private._i_item('d2500000-0000-4000-8000-000000000001')), 'the first item is INV-00001, its name is tidied and it starts empty');
select private._i_assert((select item_code from private._i_item('d2500000-0000-4000-8000-000000000004')) = 'INV-00004', 'codes count up per school');
select private._i_raises($q$insert into public.inventory_items (school_id, name, category, location, quantity)
  values ('b2500000-0000-4000-8000-00000000000a', 'Sneaky', 'other', 'Office', 50)$q$, '42501', 'quantity can''t be typed in');
select private._i_raises($q$insert into public.inventory_items (school_id, name, category, location)
  values ('b2500000-0000-4000-8000-00000000000a', 'Rocket', 'space', 'Office')$q$, '23514', 'only the listed categories');
select private._i_raises($q$insert into public.inventory_items (school_id, name, category, location, assigned_teacher_id)
  values ('b2500000-0000-4000-8000-00000000000a', 'Laptop', 'computer', 'Office', 'c2500000-0000-4000-8000-000000000002')$q$,
  '23514', 'not to inactive staff', 'active staff');
select private._i_raises($q$insert into public.inventory_items (school_id, name, category, location, assigned_teacher_id)
  values ('b2500000-0000-4000-8000-00000000000a', 'Laptop', 'computer', 'Office', 'c2500000-0000-4000-8000-00000000000b')$q$,
  '23503', 'not to another school''s staff');
select private._i_raises($q$insert into public.inventory_items (school_id, name, category, location)
  values ('b2500000-0000-4000-8000-00000000000b', 'Into B', 'other', 'Office')$q$, '42501', 'not into another school');
select private._i_raises($q$update public.inventory_items set quantity = 99 where id = 'd2500000-0000-4000-8000-000000000001'$q$,
  '42501', 'quantity can''t be edited');
select private._i_raises($q$update public.inventory_items set item_code = 'INV-00099' where id = 'd2500000-0000-4000-8000-000000000001'$q$,
  '42501', 'nor the code');

-- ================= stock in =================
select private.inventory_move('d2500000-0000-4000-8000-000000000001', 'in', 'purchase', 10, private.ist_today() - 5, 42000, 'Sharma Computers', 'BILL-77', null, null, null);
select private._i_assert((select quantity = 10 and unit_cost = 42000 and purchase_date = private.ist_today() - 5 and vendor = 'Sharma Computers'
  from private._i_item('d2500000-0000-4000-8000-000000000001')), 'a purchase adds stock and sets the purchase date, cost and vendor');
select private._i_assert((select total_cost = 420000 and balance_after = 10 from public.inventory_movements
  where item_id = 'd2500000-0000-4000-8000-000000000001' and kind = 'in'), 'the movement keeps the total cost and the balance');
-- an older purchase entered later doesn't replace the latest purchase details
select private.inventory_move('d2500000-0000-4000-8000-000000000001', 'in', 'purchase', 2, private.ist_today() - 400, 38000, 'Old Vendor', null, null, null, null);
select private._i_assert((select quantity = 12 and unit_cost = 42000 and vendor = 'Sharma Computers' from private._i_item('d2500000-0000-4000-8000-000000000001')),
  'a back-dated purchase adds stock but keeps the latest cost');
select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'in', 'opening', 30, private.ist_today(), 250, null, null, null, null, 'counted');
select private.inventory_move('d2500000-0000-4000-8000-000000000003', 'in', 'donation', 2.5, private.ist_today(), null, null, null, null, null, null);
select private._i_eq((private._i_item('d2500000-0000-4000-8000-000000000003')).quantity, 2.5, 'kilograms can be fractions');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'in', 'purchase', 1.5, private.ist_today(), null, null, null, null, null, null)$q$,
  '23514', 'reams are whole numbers', 'whole number');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'in', 'purchase', 0, private.ist_today(), null, null, null, null, null, null)$q$,
  '23514', 'quantity above zero', 'greater than zero');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'in', 'purchase', 1, private.ist_today() + 1, null, null, null, null, null, null)$q$,
  '23514', 'not in the future', 'future');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'in', 'issued', 1, private.ist_today(), null, null, null, null, null, null)$q$,
  '23514', 'reasons match the direction');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'change', 'details', 1, private.ist_today(), null, null, null, null, null, null)$q$,
  '23514', 'only in or out through the function');

-- ================= stock out =================
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'out', 'issued', 5, private.ist_today(), null, null, null, null, null, null)$q$,
  '23514', 'issuing needs a recipient', 'issued to');
select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'out', 'issued', 5, private.ist_today(), null, null, 'SLIP-1', 'c2500000-0000-4000-8000-000000000001', null, null);
select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'out', 'consumed', 6, private.ist_today(), null, null, null, null, 'Exam cell', null);
select private._i_eq((private._i_item('d2500000-0000-4000-8000-000000000002')).quantity, 19, 'stock out lowers the quantity');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'out', 'consumed', 20, private.ist_today(), null, null, null, null, 'x', null)$q$,
  '23514', 'can''t take out more than is in stock', 'Only 19 reams of A4 paper');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'out', 'consumed', 1, private.ist_today(), 10, null, null, null, 'x', null)$q$,
  '23514', 'cost only with stock in', 'stock in only');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'out', 'issued', 1, private.ist_today(), null, null, null, 'c2500000-0000-4000-8000-000000000002', null, null)$q$,
  '23514', 'not to inactive staff', 'active staff');
select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'in', 'adjustment', 1, private.ist_today(), null, null, null, null, null, 'recount');
select private._i_eq((private._i_item('d2500000-0000-4000-8000-000000000002')).quantity, 20, 'adjustments correct the count');
select private._i_assert((select array_agg(balance_after order by balance_after desc) = array[30, 25, 20, 19]::numeric[] from public.inventory_movements
  where item_id = 'd2500000-0000-4000-8000-000000000002'), 'each movement keeps the balance after it (30, 25, 19, then 20)');

-- ================= changes are logged =================
update public.inventory_items set location = 'Staff room', condition = 'needs_repair', assigned_teacher_id = 'c2500000-0000-4000-8000-000000000001'
  where id = 'd2500000-0000-4000-8000-000000000001';
select private._i_assert((select changes ? 'location' and changes ? 'condition' and changes -> 'assigned_to' ->> 'to' = 'Teacher One'
  and changes -> 'location' ->> 'from' = 'Computer Lab' and quantity = 0 and balance_after = 12
  from public.inventory_movements where item_id = 'd2500000-0000-4000-8000-000000000001' and kind = 'change'),
  'moving, a condition change and assigning are recorded in the history');
update public.inventory_items set notes = 'just a note' where id = 'd2500000-0000-4000-8000-000000000001';
select private._i_eq(private._i_moves('d2500000-0000-4000-8000-000000000001', 'change'), 1, 'a note alone isn''t a history event');
select private._i_raises($q$update public.inventory_items set assigned_teacher_id = 'c2500000-0000-4000-8000-000000000002' where id = 'd2500000-0000-4000-8000-000000000002'$q$,
  '23514', 'reassigning to inactive staff is refused', 'active staff');

-- ================= history is append-only =================
select private._i_raises($q$update public.inventory_movements set quantity = 1 where item_id = 'd2500000-0000-4000-8000-000000000002'$q$, '42501', 'no edits to history');
select private._i_raises($q$delete from public.inventory_movements where item_id = 'd2500000-0000-4000-8000-000000000002'$q$, '42501', 'no deletes either');
select private._i_raises($q$insert into public.inventory_movements (school_id, item_id, kind, reason, quantity, balance_after, moved_on)
  values ('b2500000-0000-4000-8000-00000000000a', 'd2500000-0000-4000-8000-000000000002', 'in', 'found', 100, 100, current_date)$q$, '42501', 'no direct inserts');

-- ================= archive, delete =================
update public.inventory_items set is_active = false where id = 'd2500000-0000-4000-8000-000000000003';
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000003', 'in', 'found', 1, private.ist_today(), null, null, null, null, null, null)$q$,
  '23514', 'no stock movements on an archived item', 'archived');
select private._i_assert((select changes -> 'archived' ->> 'to' = 'true' from public.inventory_movements
  where item_id = 'd2500000-0000-4000-8000-000000000003' and kind = 'change'), 'archiving is in the history');
update public.inventory_items set is_active = true where id = 'd2500000-0000-4000-8000-000000000003';
select private._i_raises($q$delete from public.inventory_items where id = 'd2500000-0000-4000-8000-000000000002'$q$,
  '23503', 'an item with stock history is kept', 'Archive it');
select private.inventory_move('d2500000-0000-4000-8000-000000000004', 'in', 'opening', 3, private.ist_today(), null, null, null, null, null, null);
delete from public.inventory_items where id = 'd2500000-0000-4000-8000-000000000004';
select private._i_assert(private._i_item('d2500000-0000-4000-8000-000000000004') is null, 'an item with only its opening stock can be deleted (a mistake)');
select private._i_eq(private._i_moves('d2500000-0000-4000-8000-000000000004', 'in'), 0, 'its history goes with it');

-- ================= dashboard =================
select private._i_assert((select (d ->> 'items')::int = 3 and (d ->> 'value')::numeric = 12 * 42000 + 20 * 250
  and (d ->> 'items_without_cost')::int = 1 and (d ->> 'low_stock')::int = 1 and (d ->> 'needs_attention')::int = 1
  and (d ->> 'assigned')::int = 1 and (d ->> 'month_spent')::numeric >= 420000
  and jsonb_array_length(d -> 'by_category') = 7 and (d -> 'low_stock_items' -> 0 ->> 'name') = 'A4 paper'
  from private.inventory_dashboard('b2500000-0000-4000-8000-00000000000a') d),
  'dashboard: items, stock value from unit costs, low stock (20 at the reorder level 20), needs repair, assigned');

-- ================= accountant: reads, can't change =================
select private._i_as('a2500000-0000-4000-8000-000000000002');
select private._i_eq((select count(*) from public.inventory_items), 3, 'the accountant sees the items');
select private._i_assert((select count(*) from public.inventory_movements) > 5, 'and the history');
select private._i_assert(private.inventory_dashboard('b2500000-0000-4000-8000-00000000000a') is not null, 'and the dashboard');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'out', 'consumed', 1, private.ist_today(), null, null, null, null, 'x', null)$q$,
  'P0002', 'the accountant can''t move stock');
select private._i_raises($q$insert into public.inventory_items (school_id, name, category, location) values ('b2500000-0000-4000-8000-00000000000a', 'Chair', 'furniture', 'Office')$q$,
  '42501', 'nor add items');
update public.inventory_items set location = 'Nowhere' where id = 'd2500000-0000-4000-8000-000000000002';
select private._i_assert((private._i_item('d2500000-0000-4000-8000-000000000002')).location = 'Store room', 'nor change them (RLS: nothing updated)');

-- ================= staff: only what is assigned to them =================
select private._i_as('a2500000-0000-4000-8000-000000000003');  -- Teacher One holds the computers
select private._i_assert((select count(*) = 1 and bool_and(name = 'Desktop computer') from public.inventory_items), 'a teacher sees only the items assigned to them');
select private._i_eq((select count(*) from public.inventory_movements), 0, 'but no stock history');
select private._i_raises($q$select private.inventory_dashboard('b2500000-0000-4000-8000-00000000000a')$q$, '42501', 'nor the dashboard');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000001', 'out', 'lost', 1, private.ist_today(), null, null, null, null, null, null)$q$,
  'P0002', 'and can''t move stock');
select private._i_as('a2500000-0000-4000-8000-000000000007');  -- Teacher Two holds nothing
select private._i_eq((select count(*) from public.inventory_items), 0, 'another teacher sees nothing');
select private._i_as('a2500000-0000-4000-8000-000000000004');
select private._i_eq((select count(*) from public.inventory_items), 0, 'the librarian sees nothing');
select private._i_as('a2500000-0000-4000-8000-000000000005');
select private._i_eq((select count(*) from public.inventory_items), 0, 'a parent sees nothing');

-- ================= other school =================
select private._i_as('a2500000-0000-4000-8000-000000000006');
select private._i_eq((select count(*) from public.inventory_items), 0, 'school B sees none of school A''s items');
select private._i_eq((select count(*) from public.inventory_movements), 0, 'or its history');
select private._i_raises($q$select private.inventory_move('d2500000-0000-4000-8000-000000000002', 'out', 'lost', 1, private.ist_today(), null, null, null, null, null, null)$q$,
  'P0002', 'and can''t move its stock');
select private._i_raises($q$select private.inventory_dashboard('b2500000-0000-4000-8000-00000000000a')$q$, '42501', 'or read its dashboard');
insert into public.inventory_items (id, school_id, name, category, location) values
  ('d2500000-0000-4000-8000-00000000000b', 'b2500000-0000-4000-8000-00000000000b', 'Bench', 'furniture', 'Hall');
select private._i_assert((select item_code = 'INV-00001' from private._i_item('d2500000-0000-4000-8000-00000000000b')), 'each school numbers its own items');

-- ================= even the owner can't rewrite history =================
reset role;
select private._i_raises($q$update public.inventory_movements set quantity = 1 where item_id = 'd2500000-0000-4000-8000-000000000002' and kind = 'out'$q$,
  '23514', 'the history guard holds for everyone', 'can''t be changed');
insert into public.inventory_items (id, school_id, name, category, location, quantity) values
  ('d2500000-0000-4000-8000-0000000000c1', 'b2500000-0000-4000-8000-00000000000a', 'Owner insert', 'other', 'Office', 40);
select private._i_eq((private._i_item('d2500000-0000-4000-8000-0000000000c1')).quantity, 0, 'stock never starts from a typed quantity, even for the owner');
select private._i_raises($q$update public.inventory_items set item_code = 'INV-00777' where id = 'd2500000-0000-4000-8000-000000000002'$q$,
  '23514', 'codes are fixed for everyone', 'code');

do $$ begin raise notice 'ALL INVENTORY TESTS PASSED'; end $$;
select 'ALL INVENTORY TESTS PASSED' as result;
rollback;
