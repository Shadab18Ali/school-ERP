-- =====================================================================
-- Fee structure test (migrations 0001-0007). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL FEE STRUCTURE TESTS PASSED".
-- Uses the brief's Class 5 example.
-- =====================================================================
begin;

create function private._t_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;
create function private._t_eq(got numeric, want numeric, msg text) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'FAIL: % (got %, expected %)', msg, got, want using errcode = 'ZT001'; end if; end $$;
create function private._t_raises(stmt text, expected text, msg text, needle text default null) returns void language plpgsql as $$
declare st text; m text;
begin
  begin execute stmt; exception when others then st := sqlstate; m := sqlerrm; end;
  if st is null then raise exception 'FAIL: % (statement unexpectedly succeeded)', msg using errcode = 'ZT001'; end if;
  if st <> expected then raise exception 'FAIL: % (got SQLSTATE % "%", expected %)', msg, st, m, expected using errcode = 'ZT001'; end if;
  if needle is not null and position(needle in m) = 0 then
    raise exception 'FAIL: % (message "%" lacks "%")', msg, m, needle using errcode = 'ZT001'; end if;
end $$;
create function private._t_rows(stmt text, n int, msg text) returns void language plpgsql as $$
declare got int;
begin
  begin execute stmt; get diagnostics got = row_count;
  exception when others then raise exception 'FAIL: % (error: %)', msg, sqlerrm using errcode = 'ZT001'; end;
  if got <> n then raise exception 'FAIL: % (affected % rows, expected %)', msg, got, n using errcode = 'ZT001'; end if;
end $$;
create function private._t_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
grant execute on function private._t_assert(boolean, text), private._t_eq(numeric, numeric, text),
  private._t_raises(text, text, text, text), private._t_rows(text, int, text), private._t_as(uuid) to authenticated;

insert into auth.users (id, email) values
  ('a5000000-0000-4000-8000-000000000001', 'fee-test-accountant-a@example.invalid'),
  ('a5000000-0000-4000-8000-000000000002', 'fee-test-teacher-a@example.invalid'),
  ('a5000000-0000-4000-8000-000000000003', 'fee-test-admin-b@example.invalid'),
  ('a5000000-0000-4000-8000-000000000004', 'fee-test-parent-a@example.invalid');
insert into public.schools (id, name, code) values
  ('b5000000-0000-4000-8000-00000000000a', 'Fee Test A', 'ZZFEE-A'),
  ('b5000000-0000-4000-8000-00000000000b', 'Fee Test B', 'ZZFEE-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000001', 'accountant'),
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000002', 'teacher'),
  ('b5000000-0000-4000-8000-00000000000a', 'a5000000-0000-4000-8000-000000000004', 'parent'),
  ('b5000000-0000-4000-8000-00000000000b', 'a5000000-0000-4000-8000-000000000003', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-00000000000a', '2026-27', '2026-04-01', '2027-03-31', true),
  ('c5000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-00000000000a', '2027-28', '2027-04-01', '2028-03-31', false),
  ('c5000000-0000-4000-8000-000000000003', 'b5000000-0000-4000-8000-00000000000a', '2025-26', '2025-04-01', '2026-03-31', false);
insert into public.classes (id, school_id, name) values
  ('d5000000-0000-4000-8000-000000000005', 'b5000000-0000-4000-8000-00000000000a', 'Class 5'),
  ('d5000000-0000-4000-8000-000000000006', 'b5000000-0000-4000-8000-00000000000a', 'Class 6'),
  ('d5000000-0000-4000-8000-0000000000b1', 'b5000000-0000-4000-8000-00000000000b', 'Class 5');
insert into public.fee_heads (id, school_id, name) values
  ('e5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-00000000000a', 'Admission Fee'),
  ('e5000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-00000000000a', 'Annual Fee'),
  ('e5000000-0000-4000-8000-000000000003', 'b5000000-0000-4000-8000-00000000000a', 'Exam Fee'),
  ('e5000000-0000-4000-8000-000000000004', 'b5000000-0000-4000-8000-00000000000a', 'Tuition Fee'),
  ('e5000000-0000-4000-8000-000000000005', 'b5000000-0000-4000-8000-00000000000a', 'Transport Fee'),
  ('e5000000-0000-4000-8000-000000000006', 'b5000000-0000-4000-8000-00000000000a', 'Computer Fee'),
  ('e5000000-0000-4000-8000-0000000000b1', 'b5000000-0000-4000-8000-00000000000b', 'Tuition Fee');

-- ================= accountant of School A builds Class 5 =================
select private._t_as('a5000000-0000-4000-8000-000000000001');
select private._t_rows($q$insert into public.fee_structures (id, school_id, academic_session_id, class_id, name)
  values ('f5000000-0000-4000-8000-000000000005', 'b5000000-0000-4000-8000-00000000000a',
          'c5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000005', 'Class 5 fees')$q$, 1,
  'accountant can create a fee structure');
select private._t_rows($q$insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency, is_optional, billing_months, due_month) values
  ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000001', 2000, 'one_time', false, null, null),
  ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000002', 5000, 'yearly',   false, null, null),
  ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000003', 1000, 'yearly',   false, null, 9),
  ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000004', 1500, 'monthly',  false, null, null),
  ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000005', 1000, 'monthly',  true,  '{1,2,3,4,7,8,9,10,11,12}', null)$q$,
  5, 'accountant can add the five fee items');

-- ---------- database-driven totals ----------
select private._t_eq((select annual_compulsory from private.fee_structure_totals(array['f5000000-0000-4000-8000-000000000005'::uuid])),
  26000, 'compulsory per year = 2000 + 5000 + 1000 + 1500 x 12');
select private._t_eq((select annual_optional from private.fee_structure_totals(array['f5000000-0000-4000-8000-000000000005'::uuid])),
  10000, 'optional transport = 1000 x 10 billed months (no May/June)');
select private._t_eq((select monthly_compulsory from private.fee_structure_totals(array['f5000000-0000-4000-8000-000000000005'::uuid])),
  1500, 'monthly compulsory = tuition');
select private._t_eq((select one_time_compulsory from private.fee_structure_totals(array['f5000000-0000-4000-8000-000000000005'::uuid])),
  2000, 'one-time = admission');
select private._t_eq((select count(*) from private.fee_structure_schedule('f5000000-0000-4000-8000-000000000005')
  where due_month = '2026-04-01' and not is_optional), 3, 'April: admission + annual + tuition');
select private._t_eq((select sum(amount) from private.fee_structure_schedule('f5000000-0000-4000-8000-000000000005')
  where due_month = '2026-09-01' and not is_optional), 2500, 'September: exam 1000 + tuition 1500');
select private._t_eq((select count(*) from private.fee_structure_schedule('f5000000-0000-4000-8000-000000000005')
  where fee_head_name = 'Transport Fee' and due_month in ('2026-05-01', '2026-06-01')), 0, 'no transport in May and June');
select private._t_eq((select occurrences from private.fee_item_breakdown('f5000000-0000-4000-8000-000000000005') b
  join public.fee_structure_items i on i.id = b.fee_item_id where i.fee_head_id = 'e5000000-0000-4000-8000-000000000004'),
  12, 'tuition falls due 12 times');

-- quarterly from July = Jul, Oct, Jan; half-yearly from April = Apr, Oct
insert into public.fee_structures (id, school_id, academic_session_id, class_id)
  values ('f5000000-0000-4000-8000-000000000006', 'b5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000006');
insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency, due_month) values
  ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000006', 600, 'quarterly', 7),
  ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000006', 'e5000000-0000-4000-8000-000000000003', 750, 'half_yearly', null);
select private._t_assert((select string_agg(to_char(due_month, 'Mon'), ',' order by due_month) from private.fee_structure_schedule('f5000000-0000-4000-8000-000000000006')
  where fee_head_name = 'Computer Fee') = 'Jul,Oct,Jan', 'quarterly from July: Jul, Oct, Jan');
select private._t_assert((select string_agg(to_char(due_month, 'Mon'), ',' order by due_month) from private.fee_structure_schedule('f5000000-0000-4000-8000-000000000006')
  where fee_head_name = 'Exam Fee') = 'Apr,Oct', 'half-yearly: Apr, Oct');
select private._t_eq((select annual_compulsory from private.fee_structure_totals(array['f5000000-0000-4000-8000-000000000006'::uuid])),
  3300, '600 x 3 + 750 x 2');

-- ---------- data rules ----------
select private._t_raises($q$insert into public.fee_structures (school_id, academic_session_id, class_id)
  values ('b5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000005')$q$,
  '23505', 'one fee structure per class per session');
select private._t_raises($q$insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency)
  values ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-000000000004', 100, 'yearly')$q$,
  '23505', 'a fee head appears once per structure');
select private._t_raises($q$update public.fee_structure_items set amount = 0 where fee_head_id = 'e5000000-0000-4000-8000-000000000004'$q$,
  '23514', 'amounts must be positive');
select private._t_raises($q$update public.fee_structure_items set billing_months = '{4,5}' where fee_head_id = 'e5000000-0000-4000-8000-000000000002'$q$,
  '23514', 'billing months are only for monthly fees');
select private._t_raises($q$update public.fee_structure_items set billing_months = '{4,4}' where fee_head_id = 'e5000000-0000-4000-8000-000000000004'$q$,
  '23514', 'billing months must not repeat');
select private._t_raises($q$update public.fee_structure_items set billing_months = '{13}' where fee_head_id = 'e5000000-0000-4000-8000-000000000004'$q$,
  '23514', 'billing months are 1-12');
select private._t_raises($q$update public.fee_structure_items set due_month = 5 where fee_head_id = 'e5000000-0000-4000-8000-000000000004'$q$,
  '23514', 'monthly fees have no due month');
select private._t_raises($q$insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency)
  values ('b5000000-0000-4000-8000-00000000000a', 'f5000000-0000-4000-8000-000000000005', 'e5000000-0000-4000-8000-0000000000b1', 100, 'yearly')$q$,
  '23503', 'cannot use another school''s fee head');
select private._t_raises($q$update public.fee_structures set class_id = 'd5000000-0000-4000-8000-000000000006' where id = 'f5000000-0000-4000-8000-000000000005'$q$,
  '23514', 'a structure keeps its class', 'Copy it instead');

-- ---------- copy: +10% rounded to 10, into next session ----------
select private._t_assert(private.copy_fee_structure('f5000000-0000-4000-8000-000000000005', 'c5000000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-000000000005', 10, 10) is not null, 'accountant can copy a structure');
select private._t_eq((select annual_compulsory from private.fee_structure_totals(array[
  (select id from public.fee_structures where academic_session_id = 'c5000000-0000-4000-8000-000000000002' and class_id = 'd5000000-0000-4000-8000-000000000005')])),
  28600, 'copied +10%: 2200 + 5500 + 1100 + 1650 x 12');
select private._t_assert((select copied_from_id = 'f5000000-0000-4000-8000-000000000005' from public.fee_structures
  where academic_session_id = 'c5000000-0000-4000-8000-000000000002' and class_id = 'd5000000-0000-4000-8000-000000000005'), 'copy remembers its source');
select private._t_raises($q$select private.copy_fee_structure('f5000000-0000-4000-8000-000000000005', 'c5000000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-000000000005', 0, 1)$q$, '23505', 'copying onto an existing structure is refused');
-- 7% rounded to 50: 1500 -> 1605 -> 1600
select private.copy_fee_structure('f5000000-0000-4000-8000-000000000005', 'c5000000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-000000000006', 7, 50);
select private._t_eq((select i.amount from public.fee_structure_items i join public.fee_structures fs on fs.id = i.fee_structure_id
  where fs.academic_session_id = 'c5000000-0000-4000-8000-000000000002' and fs.class_id = 'd5000000-0000-4000-8000-000000000006'
    and i.fee_head_id = 'e5000000-0000-4000-8000-000000000004'), 1600, '1500 + 7% rounded to 50 = 1600');
select private._t_raises($q$select private.copy_fee_structure('f5000000-0000-4000-8000-000000000005', 'c5000000-0000-4000-8000-000000000003',
  'd5000000-0000-4000-8000-000000000005', 500, 1)$q$, '23514', 'the % change is bounded');
reset role;

-- ---------- archived session is read-only ----------
update public.academic_sessions set archived_at = now() where id = 'c5000000-0000-4000-8000-000000000003';
select private._t_as('a5000000-0000-4000-8000-000000000001');
select private._t_raises($q$insert into public.fee_structures (school_id, academic_session_id, class_id)
  values ('b5000000-0000-4000-8000-00000000000a', 'c5000000-0000-4000-8000-000000000003', 'd5000000-0000-4000-8000-000000000005')$q$,
  '23514', 'no new structures in an archived session', 'archived');
reset role;

-- ================= teacher & parent: no access =================
select private._t_as('a5000000-0000-4000-8000-000000000002');
select private._t_eq((select count(*) from public.fee_structures) + (select count(*) from public.fee_heads), 0, 'teachers cannot see fee structures');
select private._t_raises($q$insert into public.fee_heads (school_id, name) values ('b5000000-0000-4000-8000-00000000000a', 'Teacher Fee')$q$,
  '42501', 'teachers cannot add fee heads');
reset role;
select private._t_as('a5000000-0000-4000-8000-000000000004');
select private._t_eq((select count(*) from public.fee_structure_items), 0, 'parents cannot browse fee structures');
select private._t_eq((select count(*) from private.fee_structure_schedule('f5000000-0000-4000-8000-000000000005')), 0,
  'calculations respect RLS: nothing leaks through the schedule function');
reset role;

-- ================= admin B: isolation =================
select private._t_as('a5000000-0000-4000-8000-000000000003');
select private._t_eq((select count(*) from public.fee_structures where school_id = 'b5000000-0000-4000-8000-00000000000a'), 0, 'admin B sees no School A structures');
select private._t_rows($q$update public.fee_structure_items set amount = 1 where school_id = 'b5000000-0000-4000-8000-00000000000a'$q$, 0,
  'admin B cannot change School A amounts');
select private._t_raises($q$select private.copy_fee_structure('f5000000-0000-4000-8000-000000000005', 'c5000000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-0000000000b1', 0, 1)$q$, 'P0002', 'admin B cannot copy School A''s structure');
reset role;

-- deleting a school removes its fee data, even with an archived session
delete from public.schools where id = 'b5000000-0000-4000-8000-00000000000a';
select private._t_eq((select count(*) from public.fee_structures where school_id = 'b5000000-0000-4000-8000-00000000000a'), 0,
  'deleting a school removes its fee structures');

select 'ALL FEE STRUCTURE TESTS PASSED' as result;
rollback;
