-- =====================================================================
-- Transport test (migrations 0001-0023). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "ALL TRANSPORT TESTS PASSED".
-- School A (ZZTR-A) with a session that started 6 months ago (so "today" falls in its 7th
-- month); Class 1-A: Child One (Parent One; also has a student login), Child Two, Child Four;
-- Child Three is not enrolled. Admin, accountant, teacher; admin of school B.
-- Months of the session are called m0..m11 below.
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
create function private._t_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- month k of the session (first day)
create function private._t_m(k int) returns date language sql stable as $$
  select (date_trunc('month', private.ist_today()) - interval '6 months' + make_interval(months => k))::date;
$$;
-- transport dues of a student in a zone (count, and total), as the owner sees them
create function private._t_dues(p_student uuid, p_zone text) returns table (n bigint, total numeric, months date[])
language sql security definer set search_path = '' as $$
  select count(*), coalesce(sum(d.amount), 0), array_agg(d.due_month order by d.due_month)
  from public.student_fee_dues d join public.fee_heads h on h.id = d.fee_head_id
  where d.student_id = p_student and h.name = 'Transport – ' || p_zone;
$$;
create function private._t_id(p_table text, p_name text) returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  execute format('select id from public.%I where school_id = %L and %s = %L', p_table, 'b2400000-0000-4000-8000-00000000000a',
    case p_table when 'transport_vehicles' then 'registration_number' when 'transport_staff' then 'full_name' else 'name' end, p_name) into v;
  return v;
end $$;
create function private._t_asg(p_student uuid) returns uuid language sql security definer set search_path = '' as $$
  select id from public.transport_assignments where student_id = p_student order by start_date desc limit 1;
$$;
grant execute on function private._t_assert(boolean, text), private._t_eq(numeric, numeric, text), private._t_raises(text, text, text, text),
  private._t_as(uuid), private._t_m(int), private._t_dues(uuid, text), private._t_id(text, text), private._t_asg(uuid) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a2400000-0000-4000-8000-000000000001', 'tr-admin@example.invalid'),
  ('a2400000-0000-4000-8000-000000000002', 'tr-accountant@example.invalid'),
  ('a2400000-0000-4000-8000-000000000003', 'tr-teacher@example.invalid'),
  ('a2400000-0000-4000-8000-000000000004', 'tr-parent@example.invalid'),
  ('a2400000-0000-4000-8000-000000000005', 'tr-student@example.invalid'),
  ('a2400000-0000-4000-8000-000000000006', 'tr-admin-b@example.invalid');
insert into public.schools (id, name, code) values
  ('b2400000-0000-4000-8000-00000000000a', 'Transport A', 'ZZTR-A'),
  ('b2400000-0000-4000-8000-00000000000b', 'Transport B', 'ZZTR-B');
insert into public.school_memberships (school_id, user_id, role) values
  ('b2400000-0000-4000-8000-00000000000a', 'a2400000-0000-4000-8000-000000000001', 'school_admin'),
  ('b2400000-0000-4000-8000-00000000000a', 'a2400000-0000-4000-8000-000000000002', 'accountant'),
  ('b2400000-0000-4000-8000-00000000000a', 'a2400000-0000-4000-8000-000000000003', 'teacher'),
  ('b2400000-0000-4000-8000-00000000000a', 'a2400000-0000-4000-8000-000000000004', 'parent'),
  ('b2400000-0000-4000-8000-00000000000a', 'a2400000-0000-4000-8000-000000000005', 'student'),
  ('b2400000-0000-4000-8000-00000000000b', 'a2400000-0000-4000-8000-000000000006', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c2400000-0000-4000-8000-000000000001', 'b2400000-0000-4000-8000-00000000000a', 'This year', private._t_m(0), private._t_m(12) - 1, true);
insert into public.classes (id, school_id, name) values ('d2400000-0000-4000-8000-000000000001', 'b2400000-0000-4000-8000-00000000000a', 'Class 1');
insert into public.sections (id, school_id, class_id, academic_session_id, name) values
  ('d2400000-0000-4000-8000-0000000000a1', 'b2400000-0000-4000-8000-00000000000a', 'd2400000-0000-4000-8000-000000000001', 'c2400000-0000-4000-8000-000000000001', 'A');
insert into public.students (id, school_id, full_name, father_name, date_of_birth, gender, mobile) values
  ('f2400000-0000-4000-8000-000000000001', 'b2400000-0000-4000-8000-00000000000a', 'Child One', 'Parent One', '2018-01-01', 'male', '9800000011'),
  ('f2400000-0000-4000-8000-000000000002', 'b2400000-0000-4000-8000-00000000000a', 'Child Two', 'Father Two', '2018-02-02', 'female', '9800000022'),
  ('f2400000-0000-4000-8000-000000000003', 'b2400000-0000-4000-8000-00000000000a', 'Child Three', 'Father Three', '2018-03-03', 'female', '9800000033'),
  ('f2400000-0000-4000-8000-000000000004', 'b2400000-0000-4000-8000-00000000000a', 'Child Four', 'Father Four', '2018-04-04', 'male', '9800000044');
update public.students set account_id = 'a2400000-0000-4000-8000-000000000005' where id = 'f2400000-0000-4000-8000-000000000001';
insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date)
select 'b2400000-0000-4000-8000-00000000000a', s, 'c2400000-0000-4000-8000-000000000001', 'd2400000-0000-4000-8000-000000000001',
       'd2400000-0000-4000-8000-0000000000a1', 'T' || n, private._t_m(0)
from (values ('f2400000-0000-4000-8000-000000000001'::uuid, 1), ('f2400000-0000-4000-8000-000000000002'::uuid, 2),
             ('f2400000-0000-4000-8000-000000000004'::uuid, 4)) v(s, n);
insert into public.student_guardians (school_id, student_id, user_id, relationship) values
  ('b2400000-0000-4000-8000-00000000000a', 'f2400000-0000-4000-8000-000000000001', 'a2400000-0000-4000-8000-000000000004', 'father');
-- a class fee, to show transport fees sit beside it
insert into public.fee_heads (id, school_id, name) values ('a2410000-0000-4000-8000-000000000001', 'b2400000-0000-4000-8000-00000000000a', 'Tuition Fee');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values
  ('a2420000-0000-4000-8000-000000000001', 'b2400000-0000-4000-8000-00000000000a', 'c2400000-0000-4000-8000-000000000001', 'd2400000-0000-4000-8000-000000000001');
insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency) values
  ('b2400000-0000-4000-8000-00000000000a', 'a2420000-0000-4000-8000-000000000001', 'a2410000-0000-4000-8000-000000000001', 1000, 'monthly');

-- ================= vehicles and staff =================
select private._t_as('a2400000-0000-4000-8000-000000000001');
insert into public.transport_vehicles (school_id, registration_number, vehicle_type, seating_capacity) values
  ('b2400000-0000-4000-8000-00000000000a', 'dl 1p c-1234', 'bus', 40),
  ('b2400000-0000-4000-8000-00000000000a', 'HR26AB0001', 'van', 1);
select private._t_assert(private._t_id('transport_vehicles', 'DL1PC1234') is not null, 'registration numbers are stored without spaces, in capitals');
select private._t_raises($q$insert into public.transport_vehicles (school_id, registration_number, vehicle_type, seating_capacity)
  values ('b2400000-0000-4000-8000-00000000000a', 'DL1PC 1234', 'bus', 30)$q$, '23505', 'a registration number is used once');
select private._t_raises($q$insert into public.transport_vehicles (school_id, registration_number, vehicle_type, seating_capacity)
  values ('b2400000-0000-4000-8000-00000000000a', 'UP14XY9', 'bus', 0)$q$, '23514', 'a vehicle has at least one seat');
select private._t_raises($q$insert into public.transport_staff (school_id, role, full_name, phone) values
  ('b2400000-0000-4000-8000-00000000000a', 'driver', 'No Licence', '9811111111')$q$, '23514', 'a driver needs a licence on record');
insert into public.transport_staff (school_id, role, full_name, phone, license_number, license_valid_until) values
  ('b2400000-0000-4000-8000-00000000000a', 'driver', 'Driver Good', '9811111111', 'dl-0420110012345', private.ist_today() + 100),
  ('b2400000-0000-4000-8000-00000000000a', 'driver', 'Driver Expired', '9822222222', 'DL0420110099999', private.ist_today() - 1);
insert into public.transport_staff (school_id, role, full_name, phone) values
  ('b2400000-0000-4000-8000-00000000000a', 'attendant', 'Attendant One', '9833333333');
select private._t_assert((select license_number = 'DL-0420110012345' from public.transport_staff where full_name = 'Driver Good'), 'licence numbers in capitals');
reset role;
select private._t_as('a2400000-0000-4000-8000-000000000002');  -- accountant
select private._t_raises($q$insert into public.transport_vehicles (school_id, registration_number, vehicle_type, seating_capacity)
  values ('b2400000-0000-4000-8000-00000000000a', 'MH01AA1111', 'bus', 30)$q$, '42501', 'accountants don''t add vehicles');
select private._t_eq((select count(*) from public.transport_staff), 3, 'but can see transport staff');
select private._t_as('a2400000-0000-4000-8000-000000000003');  -- teacher
select private._t_eq((select count(*) from public.transport_vehicles), 0, 'teachers see no transport records');
select private._t_as('a2400000-0000-4000-8000-000000000004');  -- parent
select private._t_eq((select count(*) from public.transport_staff), 0, 'nor do parents (directly)');
select private._t_as('a2400000-0000-4000-8000-000000000006');  -- admin of B
select private._t_eq((select count(*) from public.transport_vehicles), 0, 'nor another school');
reset role;

-- ================= fare zones (fee heads + transport fee structure) =================
select private._t_as('a2400000-0000-4000-8000-000000000002');
select private._t_raises($q$select private.transport_add_zone('b2400000-0000-4000-8000-00000000000a', 'Zone X', 100, 'monthly', null, null)$q$,
  '42501', 'accountants don''t set fares', 'Only school admins');
select private._t_as('a2400000-0000-4000-8000-000000000001');
select private.transport_add_zone('b2400000-0000-4000-8000-00000000000a', 'Zone A', 1200, 'monthly', null, null);
-- Zone B isn't billed in the calendar month of m7 (e.g. a vacation month)
select private.transport_add_zone('b2400000-0000-4000-8000-00000000000a', 'Zone B', 1500, 'monthly',
  (select array_agg(m::smallint) from generate_series(1, 12) m where m <> extract(month from private._t_m(7))), null);
select private._t_assert((select count(*) = 2 from public.fee_heads where name in ('Transport – Zone A', 'Transport – Zone B')),
  'each zone gets its fee head');
select private._t_raises($q$select private.transport_add_zone('b2400000-0000-4000-8000-00000000000a', 'zone a', 900, 'monthly', null, null)$q$,
  '23505', 'zone names are unique');
select private._t_raises($q$insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency) values
  ('b2400000-0000-4000-8000-00000000000a', 'a2420000-0000-4000-8000-000000000001',
   (select fee_head_id from public.transport_fare_zones where name = 'Zone A'), 1200, 'monthly')$q$, '23514',
  'a zone''s fee head can''t be put in a class fee structure', 'charged through transport');
reset role;

-- ================= routes and stops =================
select private._t_as('a2400000-0000-4000-8000-000000000001');
select private._t_raises(format($q$insert into public.transport_routes (school_id, name, vehicle_id, driver_id) values
  ('b2400000-0000-4000-8000-00000000000a', 'Bad', %L, %L)$q$, private._t_id('transport_vehicles', 'DL1PC1234'), private._t_id('transport_staff', 'Driver Expired')),
  '23514', 'a driver with an expired licence can''t be put on a route', 'licence expired');
select private._t_raises(format($q$insert into public.transport_routes (school_id, name, driver_id) values
  ('b2400000-0000-4000-8000-00000000000a', 'Bad', %L)$q$, private._t_id('transport_staff', 'Attendant One')), '23514', 'an attendant can''t drive',
  'not an active driver');
insert into public.transport_routes (school_id, name, code, vehicle_id, driver_id, attendant_id) values
  ('b2400000-0000-4000-8000-00000000000a', 'North', 'R1', private._t_id('transport_vehicles', 'DL1PC1234'), private._t_id('transport_staff', 'Driver Good'),
   private._t_id('transport_staff', 'Attendant One')),
  ('b2400000-0000-4000-8000-00000000000a', 'South', 'R2', private._t_id('transport_vehicles', 'HR26AB0001'), null, null);
insert into public.transport_stops (school_id, route_id, name, sequence, pickup_time, drop_time, fare_zone_id) values
  ('b2400000-0000-4000-8000-00000000000a', private._t_id('transport_routes', 'North'), 'Market', 1, '07:10', '14:20', private._t_id('transport_fare_zones', 'Zone A')),
  ('b2400000-0000-4000-8000-00000000000a', private._t_id('transport_routes', 'North'), 'Lake View', 2, '07:25', '14:05', private._t_id('transport_fare_zones', 'Zone B')),
  ('b2400000-0000-4000-8000-00000000000a', private._t_id('transport_routes', 'South'), 'Station', 1, '07:00', '14:30', private._t_id('transport_fare_zones', 'Zone A'));
reset role;

-- ================= assigning students; fees follow =================
select private._t_as('a2400000-0000-4000-8000-000000000002');
select private._t_raises(format($q$select private.transport_assign('f2400000-0000-4000-8000-000000000001', %L, %L, 'both', %L)$q$,
  private._t_id('transport_routes', 'North'), private._t_id('transport_stops', 'Market'), private._t_m(0)), 'P0002', 'accountants don''t assign transport');
select private._t_as('a2400000-0000-4000-8000-000000000001');
select private.transport_assign('f2400000-0000-4000-8000-000000000001', private._t_id('transport_routes', 'North'),
  private._t_id('transport_stops', 'Market'), 'both', private._t_m(0));
select private._t_assert((select n = 12 and total = 14400 from private._t_dues('f2400000-0000-4000-8000-000000000001', 'Zone A')),
  'Child One from the first day: 12 months of Zone A (12 × 1200)');
select private._t_eq((select count(*) from public.student_fee_dues d join public.fee_heads h on h.id = d.fee_head_id
  where d.student_id = 'f2400000-0000-4000-8000-000000000001' and h.name = 'Tuition Fee'), 12, 'class fees are unchanged beside it');
select private.transport_assign('f2400000-0000-4000-8000-000000000002', private._t_id('transport_routes', 'South'),
  private._t_id('transport_stops', 'Station'), 'pickup', private._t_m(2) + 14);
select private._t_assert((select n = 10 and months[1] = private._t_m(2) from private._t_dues('f2400000-0000-4000-8000-000000000002', 'Zone A')),
  'Child Two from the middle of m2: m2 to m11 (10 months)');
select private._t_raises(format($q$select private.transport_assign('f2400000-0000-4000-8000-000000000004', %L, %L, 'both', %L)$q$,
  private._t_id('transport_routes', 'South'), private._t_id('transport_stops', 'Station'), private._t_m(0)), '23514', 'a full vehicle takes no one else', 'is full');
select private._t_raises(format($q$select private.transport_assign('f2400000-0000-4000-8000-000000000003', %L, %L, 'both', %L)$q$,
  private._t_id('transport_routes', 'North'), private._t_id('transport_stops', 'Market'), private._t_m(0)), '23514',
  'a student not enrolled in the session can''t be assigned', 'enrolled');
select private._t_raises(format($q$select private.transport_assign('f2400000-0000-4000-8000-000000000004', %L, %L, 'both', %L)$q$,
  private._t_id('transport_routes', 'North'), private._t_id('transport_stops', 'Station'), private._t_m(0)), '23514', 'the stop must be on the route', 'isn''t on route');
select private._t_raises(format($q$select private.transport_assign('f2400000-0000-4000-8000-000000000004', %L, %L, 'both', %L)$q$,
  private._t_id('transport_routes', 'North'), private._t_id('transport_stops', 'Market'), private._t_m(12) + 5), '23514',
  'dates must fall in an open session', 'enrolled in an open session');
reset role;

-- a payment on Child One's first transport month (the accountant, at the fee desk)
select private._t_as('a2400000-0000-4000-8000-000000000002');
select * from private.record_fee_payment((select id from public.student_enrollments where student_id = 'f2400000-0000-4000-8000-000000000001'),
  private.ist_today(), 'cash', null, null, gen_random_uuid(),
  (select jsonb_build_array(jsonb_build_object('due_id', d.id, 'amount', 1200)) from public.student_fee_dues d join public.fee_heads h on h.id = d.fee_head_id
   where d.student_id = 'f2400000-0000-4000-8000-000000000001' and h.name = 'Transport – Zone A' and d.due_month = private._t_m(0)));
reset role;

-- fare change: unpaid dues follow, the paid one doesn't
select private._t_as('a2400000-0000-4000-8000-000000000001');
update public.transport_fare_zones set amount = 1300 where name = 'Zone A';
select private._t_assert((select total = 1200 + 11 * 1300 from private._t_dues('f2400000-0000-4000-8000-000000000001', 'Zone A')),
  'a fare change updates unpaid dues only (paid m0 stays 1200)');
select private._t_assert((select i.amount = 1300 from public.fee_structure_items i join public.fee_structures fs on fs.id = i.fee_structure_id
  join public.transport_fare_zones z on z.fee_head_id = i.fee_head_id where fs.kind = 'transport' and z.name = 'Zone A'), 'the transport fee item follows the zone');

-- moving stop mid-way through m6 to Lake View (Zone B): m0-m5 stay Zone A, m6 onwards Zone B (except m7, not billed)
select private.transport_assign('f2400000-0000-4000-8000-000000000001', private._t_id('transport_routes', 'North'),
  private._t_id('transport_stops', 'Lake View'), 'both', private._t_m(6) + 9);
select private._t_assert((select end_date = private._t_m(6) + 8 from public.transport_assignments
  where student_id = 'f2400000-0000-4000-8000-000000000001' and start_date = private._t_m(0)), 'the old assignment ends the day before');
select private._t_assert((select n = 6 and months[6] = private._t_m(5) from private._t_dues('f2400000-0000-4000-8000-000000000001', 'Zone A')),
  'Zone A for m0 to m5');
select private._t_assert((select n = 5 and months[1] = private._t_m(6) and not (private._t_m(7) = any (months))
  from private._t_dues('f2400000-0000-4000-8000-000000000001', 'Zone B')), 'Zone B from m6 (the month of the move), skipping m7');
-- a stop moving to another zone moves its riders' dues
update public.transport_stops set fare_zone_id = private._t_id('transport_fare_zones', 'Zone A') where name = 'Lake View';
select private._t_eq((select n from private._t_dues('f2400000-0000-4000-8000-000000000001', 'Zone B')), 0, 'stop rezoned: no Zone B dues left');
select private._t_eq((select n from private._t_dues('f2400000-0000-4000-8000-000000000001', 'Zone A')), 12, 'all Zone A again');
update public.transport_stops set fare_zone_id = private._t_id('transport_fare_zones', 'Zone B') where name = 'Lake View';

-- ending, and removing an assignment that hasn't started
select private.transport_end(private._t_asg('f2400000-0000-4000-8000-000000000002'), private._t_m(9) - 1);
select private._t_eq((select n from private._t_dues('f2400000-0000-4000-8000-000000000002', 'Zone A')), 7, 'Child Two ends after m8: m2-m8');
select private.transport_assign('f2400000-0000-4000-8000-000000000002', private._t_id('transport_routes', 'South'),
  private._t_id('transport_stops', 'Station'), 'both', private._t_m(10));
select private._t_eq((select n from private._t_dues('f2400000-0000-4000-8000-000000000002', 'Zone A')), 9, 'back from m10: two more months');
select private.transport_end(private._t_asg('f2400000-0000-4000-8000-000000000002'), null);
select private._t_eq((select n from private._t_dues('f2400000-0000-4000-8000-000000000002', 'Zone A')), 7, 'a future assignment removed: its dues go');
select private._t_raises(format($q$select private.transport_end(%L, null)$q$, private._t_asg('f2400000-0000-4000-8000-000000000002')), '23514',
  'started transport is ended with a date, not removed');
select private._t_raises(format($q$select private.transport_end(%L, %L)$q$, private._t_asg('f2400000-0000-4000-8000-000000000002'), private._t_m(1)),
  '23514', 'an end before the start is refused');
-- no fee for a staff child
select private.transport_update_assignment(private._t_asg('f2400000-0000-4000-8000-000000000002'), private._t_id('transport_stops', 'Station'), 'both', false, 'Staff ward');
select private._t_eq((select n from private._t_dues('f2400000-0000-4000-8000-000000000002', 'Zone A')), 0, 'charge_fee off: no transport dues');
select private.transport_update_assignment(private._t_asg('f2400000-0000-4000-8000-000000000002'), private._t_id('transport_stops', 'Station'), 'both', true, null);
reset role;

-- ================= guards =================
select private._t_raises(format($q$insert into public.transport_assignments (school_id, student_id, academic_session_id, route_id, stop_id, start_date)
  values ('b2400000-0000-4000-8000-00000000000a', 'f2400000-0000-4000-8000-000000000001', 'c2400000-0000-4000-8000-000000000001', %L, %L, %L)$q$,
  private._t_id('transport_routes', 'North'), private._t_id('transport_stops', 'Market'), private._t_m(3)), '23514',
  'overlapping assignments are refused (even for the owner)', 'already has transport');
select private._t_as('a2400000-0000-4000-8000-000000000001');
select private._t_raises($q$update public.transport_assignments set start_date = start_date - 1$q$, '42501', 'assignments aren''t edited directly');
select private._t_raises($q$update public.transport_vehicles set status = 'retired' where registration_number = 'DL1PC1234'$q$, '23514',
  'a vehicle on an active route can''t be retired', 'active route');
select private._t_raises($q$update public.transport_staff set status = 'inactive' where full_name = 'Driver Good'$q$, '23514',
  'a driver on an active route can''t be deactivated', 'active route');
select private.transport_assign('f2400000-0000-4000-8000-000000000004', private._t_id('transport_routes', 'North'),
  private._t_id('transport_stops', 'Market'), 'both', private._t_m(0));
select private._t_raises($q$update public.transport_vehicles set seating_capacity = 1 where registration_number = 'DL1PC1234'$q$, '23514',
  'seats can''t drop below the riders', 'seats taken');
select private._t_raises(format($q$update public.transport_routes set vehicle_id = %L where name = 'North'$q$, private._t_id('transport_vehicles', 'HR26AB0001')),
  '23514', 'nor can a route move to a smaller vehicle', 'students ride');
select private._t_raises($q$insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency)
  select 'b2400000-0000-4000-8000-00000000000a', fs.id, 'a2410000-0000-4000-8000-000000000001', 5, 'monthly'
  from public.fee_structures fs where fs.kind = 'transport'$q$, '23514', 'the transport fee structure isn''t edited from the fee screens', 'Fare zones');
select private._t_raises($q$delete from public.fee_structures where kind = 'transport'$q$, '23514', 'nor deleted', 'Fare zones');
select private._t_raises($q$update public.transport_fare_zones set amount = 0 where name = 'Zone A'$q$, '23514', 'a fare is more than 0');
-- documents
insert into public.transport_documents (school_id, vehicle_id, doc_type, number, valid_until, file_path, file_name, mime_type, size_bytes) values
  ('b2400000-0000-4000-8000-00000000000a', private._t_id('transport_vehicles', 'DL1PC1234'), 'insurance', 'POL-1', private.ist_today() + 10,
   'b2400000-0000-4000-8000-00000000000a/transport/v/1.pdf', 'insurance.pdf', 'application/pdf', 1000),
  ('b2400000-0000-4000-8000-00000000000a', private._t_id('transport_vehicles', 'DL1PC1234'), 'pollution_certificate', 'PUC-1', private.ist_today() - 3,
   'b2400000-0000-4000-8000-00000000000a/transport/v/2.pdf', 'puc.pdf', 'application/pdf', 1000);
select private._t_raises(format($q$insert into public.transport_documents (school_id, vehicle_id, doc_type, file_path, file_name, mime_type, size_bytes)
  values ('b2400000-0000-4000-8000-00000000000a', %L, 'driving_license', 'b2400000-0000-4000-8000-00000000000a/transport/x.pdf', 'x.pdf', 'application/pdf', 1)$q$,
  private._t_id('transport_vehicles', 'DL1PC1234')), '23514', 'a vehicle has no driving licence');
select private._t_raises(format($q$insert into public.transport_documents (school_id, staff_id, doc_type, file_path, file_name, mime_type, size_bytes)
  values ('b2400000-0000-4000-8000-00000000000a', %L, 'police_verification', 'b2400000-0000-4000-8000-00000000000b/transport/x.pdf', 'x.pdf', 'application/pdf', 1)$q$,
  private._t_id('transport_staff', 'Driver Good')), '23514', 'files stay in the school''s folder');
reset role;
select private._t_as('a2400000-0000-4000-8000-000000000002');
select private._t_eq((select count(*) from public.transport_documents), 0, 'accountants don''t see transport documents');
reset role;

-- ================= what each person sees =================
select private._t_as('a2400000-0000-4000-8000-000000000004');  -- Parent One
select private._t_eq((select count(*) from public.transport_assignments), 2, 'a parent sees their child''s assignments');
select private._t_assert((select x->>'route_name' = 'North' and x->>'stop_name' = 'Lake View' and x->>'driver_phone' = '9811111111'
  and x->>'registration_number' = 'DL1PC1234' and x->>'attendant_name' = 'Attendant One'
  from jsonb_array_elements(private.transport_for_student('f2400000-0000-4000-8000-000000000001')) x where x->>'start_date' = (private._t_m(6) + 9)::text),
  'and the route, stop, vehicle, driver and attendant');
select private._t_raises($q$select private.transport_for_student('f2400000-0000-4000-8000-000000000002')$q$, 'P0002', 'but nothing of another child');
select private._t_as('a2400000-0000-4000-8000-000000000005');  -- Child One
select private._t_assert(jsonb_array_length(private.transport_for_student('f2400000-0000-4000-8000-000000000001')) = 2, 'the student sees their own');
select private._t_as('a2400000-0000-4000-8000-000000000003');  -- teacher
select private._t_raises($q$select private.transport_dashboard('b2400000-0000-4000-8000-00000000000a', 'c2400000-0000-4000-8000-000000000001')$q$,
  '42501', 'teachers don''t see the transport dashboard');
select private._t_as('a2400000-0000-4000-8000-000000000002');  -- accountant
select private._t_assert((select (d->>'students')::int = 3 and (d->>'routes')::int = 2 and (d->>'vehicles')::int = 2
  and (d->>'documents_expired')::int = 1 and (d->>'documents_expiring')::int = 1 and (d->>'routes_full')::int = 1
  and (d->'fees'->>'collected')::numeric = 1200 and (d->'fees'->>'billed')::numeric > 0
  from private.transport_dashboard('b2400000-0000-4000-8000-00000000000a', 'c2400000-0000-4000-8000-000000000001') d), 'the dashboard adds up');
select private._t_as('a2400000-0000-4000-8000-000000000006');
select private._t_raises($q$select private.transport_dashboard('b2400000-0000-4000-8000-00000000000a', 'c2400000-0000-4000-8000-000000000001')$q$,
  '42501', 'another school''s admin sees nothing');
select private._t_raises(format($q$select private.transport_assign('f2400000-0000-4000-8000-000000000002', %L, %L, 'both', %L)$q$,
  private._t_id('transport_routes', 'North'), private._t_id('transport_stops', 'Market'), private._t_m(9)), 'P0002', 'nor assigns');
reset role;

do $$ begin raise notice 'ALL TRANSPORT TESTS PASSED'; end $$;
rollback;
