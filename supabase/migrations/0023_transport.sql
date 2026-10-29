-- =====================================================================
-- Phase 24: transport management (no live GPS)
--   transport_vehicles     buses, vans... registration, type, seats, ownership, status
--   transport_staff        drivers and attendants (licence number and validity for drivers)
--   transport_documents    vehicle and staff documents (RC, insurance, PUC, fitness, permit,
--                          driving licence, police verification...) with validity dates;
--                          the files sit in a private bucket and pass only through the API
--   transport_routes       a route with its vehicle, driver and attendant
--   transport_stops        ordered stops with pickup and drop times, each in a fare zone
--   transport_fare_zones   what a stop costs: amount and billing (monthly, chosen months...)
--   transport_assignments  a student on a route and stop, for dates within a session
--
-- Transport fees are ordinary fees. Each fare zone is a fee head ("Transport – Zone A")
-- with an item in a per-session *transport* fee structure; a student's assignment adds
-- that item's dues to their fee account for the months they use transport. So transport
-- fees are collected at the fee desk, paid online, receipted, reported and reminded
-- like any other fee. Paid dues never change; unpaid ones follow fare and route changes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Fee structures gain a kind: one per class, or the session's transport fares
-- ---------------------------------------------------------------------
alter table public.fee_structures add column kind text not null default 'class' check (kind in ('class', 'transport'));
alter table public.fee_structures alter column class_id drop not null;
alter table public.fee_structures add constraint fee_structures_kind_class check ((kind = 'class') = (class_id is not null));
create unique index fee_structures_one_transport on public.fee_structures (academic_session_id) where kind = 'transport';

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.transport_vehicles (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  registration_number  text not null check (registration_number ~ '^[A-Z0-9]{4,12}$'),   -- stored without spaces, upper case
  vehicle_type         text not null check (vehicle_type in ('bus', 'mini_bus', 'van', 'car', 'other')),
  make_model           text check (make_model is null or char_length(make_model) <= 80),
  seating_capacity     smallint not null check (seating_capacity between 1 and 100),
  manufacture_year     smallint check (manufacture_year is null or manufacture_year between 1980 and 2100),
  ownership            text not null default 'school' check (ownership in ('school', 'contracted')),
  contractor_name      text check (contractor_name is null or char_length(contractor_name) <= 120),
  status               text not null default 'active' check (status in ('active', 'maintenance', 'retired')),
  notes                text check (notes is null or char_length(notes) <= 500),
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint transport_vehicles_id_school_key unique (id, school_id),
  constraint transport_vehicles_contractor check (ownership = 'contracted' or contractor_name is null)
);
create unique index transport_vehicles_reg_key on public.transport_vehicles (school_id, registration_number);

create table public.transport_staff (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  role                 text not null check (role in ('driver', 'attendant')),
  full_name            text not null check (char_length(btrim(full_name)) between 2 and 150),
  phone                text not null check (phone ~ '^\+?[0-9]{10,15}$'),
  alternate_phone      text check (alternate_phone is null or alternate_phone ~ '^\+?[0-9]{10,15}$'),
  license_number       text check (license_number is null or license_number ~ '^[A-Z0-9-]{6,20}$'),
  license_valid_until  date,
  date_of_birth        date check (date_of_birth is null or date_of_birth >= date '1940-01-01'),
  address              text check (address is null or char_length(address) <= 500),
  joined_on            date,
  status               text not null default 'active' check (status in ('active', 'inactive')),
  notes                text check (notes is null or char_length(notes) <= 500),
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint transport_staff_id_school_key unique (id, school_id),
  -- a driver must have a licence on record
  constraint transport_staff_driver_license check (role <> 'driver' or (license_number is not null and license_valid_until is not null))
);
create unique index transport_staff_license_key on public.transport_staff (school_id, license_number) where license_number is not null;

create table public.transport_documents (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references public.schools (id) on delete cascade,
  vehicle_id    uuid,
  staff_id      uuid,
  doc_type      text not null,
  title         text check (title is null or char_length(title) between 2 and 120),
  number        text check (number is null or char_length(number) <= 60),
  issued_on     date,
  valid_until   date,
  file_path     text not null,
  file_name     text not null,
  mime_type     text not null,
  size_bytes    integer not null check (size_bytes > 0),
  uploaded_by   uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint transport_documents_vehicle_fkey foreign key (vehicle_id, school_id)
    references public.transport_vehicles (id, school_id) on delete cascade,
  constraint transport_documents_staff_fkey foreign key (staff_id, school_id)
    references public.transport_staff (id, school_id) on delete cascade,
  constraint transport_documents_one_owner check ((vehicle_id is null) <> (staff_id is null)),
  constraint transport_documents_type check (
    (vehicle_id is not null and doc_type in ('registration_certificate', 'insurance', 'pollution_certificate', 'fitness_certificate',
                                             'permit', 'road_tax', 'other'))
    or (staff_id is not null and doc_type in ('driving_license', 'police_verification', 'medical_certificate', 'id_proof',
                                              'address_proof', 'other'))),
  constraint transport_documents_other_titled check (doc_type <> 'other' or title is not null),
  constraint transport_documents_dates check (valid_until is null or issued_on is null or valid_until >= issued_on),
  constraint transport_documents_path_scoped check (file_path like school_id::text || '/transport/%')
);
create index transport_documents_vehicle_idx on public.transport_documents (vehicle_id) where vehicle_id is not null;
create index transport_documents_staff_idx on public.transport_documents (staff_id) where staff_id is not null;
create index transport_documents_expiry_idx on public.transport_documents (school_id, valid_until) where valid_until is not null;

create table public.transport_fare_zones (
  id              uuid primary key default gen_random_uuid(),
  school_id       uuid not null references public.schools (id) on delete cascade,
  name            text not null check (char_length(btrim(name)) between 1 and 40),
  amount          numeric(12, 2) not null check (amount > 0 and amount <= 1000000),
  frequency       public.fee_frequency not null default 'monthly' check (frequency <> 'one_time'),
  billing_months  smallint[],   -- monthly: which calendar months are billed (null = every month of the session)
  due_month       smallint,     -- quarterly / half-yearly / yearly: calendar month of the first due date
  fee_head_id     uuid not null,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint transport_fare_zones_id_school_key unique (id, school_id),
  constraint transport_fare_zones_head_key unique (fee_head_id),
  constraint transport_fare_zones_head_fkey foreign key (fee_head_id, school_id) references public.fee_heads (id, school_id),
  constraint transport_fare_zones_months_valid check (private.valid_months(billing_months)),
  constraint transport_fare_zones_months_only_monthly check (frequency = 'monthly' or billing_months is null),
  constraint transport_fare_zones_due_month check ((frequency = 'monthly') = (due_month is null) and (due_month is null or due_month between 1 and 12))
);
create unique index transport_fare_zones_name_key on public.transport_fare_zones (school_id, lower(btrim(name)));

create table public.transport_routes (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references public.schools (id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 2 and 80),
  code          text check (code is null or code ~ '^[A-Za-z0-9-]{1,12}$'),
  vehicle_id    uuid,
  driver_id     uuid,
  attendant_id  uuid,
  status        text not null default 'active' check (status in ('active', 'inactive')),
  notes         text check (notes is null or char_length(notes) <= 500),
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint transport_routes_id_school_key unique (id, school_id),
  constraint transport_routes_vehicle_fkey foreign key (vehicle_id, school_id) references public.transport_vehicles (id, school_id),
  constraint transport_routes_driver_fkey foreign key (driver_id, school_id) references public.transport_staff (id, school_id),
  constraint transport_routes_attendant_fkey foreign key (attendant_id, school_id) references public.transport_staff (id, school_id)
);
create unique index transport_routes_name_key on public.transport_routes (school_id, lower(btrim(name)));
create unique index transport_routes_code_key on public.transport_routes (school_id, upper(code)) where code is not null;

create table public.transport_stops (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references public.schools (id) on delete cascade,
  route_id      uuid not null,
  name          text not null check (char_length(btrim(name)) between 2 and 80),
  landmark      text check (landmark is null or char_length(landmark) <= 150),
  sequence      smallint not null check (sequence between 1 and 200),
  pickup_time   time,
  drop_time     time,
  fare_zone_id  uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint transport_stops_id_school_key unique (id, school_id),
  constraint transport_stops_id_route_key unique (id, route_id),
  constraint transport_stops_route_fkey foreign key (route_id, school_id) references public.transport_routes (id, school_id) on delete cascade,
  constraint transport_stops_zone_fkey foreign key (fare_zone_id, school_id) references public.transport_fare_zones (id, school_id)
);
create unique index transport_stops_name_key on public.transport_stops (route_id, lower(btrim(name)));
create index transport_stops_route_idx on public.transport_stops (route_id, sequence);

create table public.transport_assignments (
  id                   uuid primary key default gen_random_uuid(),
  school_id            uuid not null references public.schools (id) on delete cascade,
  student_id           uuid not null,
  academic_session_id  uuid not null,
  route_id             uuid not null,
  stop_id              uuid not null,
  trip                 text not null default 'both' check (trip in ('both', 'pickup', 'drop')),
  start_date           date not null,
  end_date             date,
  charge_fee           boolean not null default true,
  notes                text check (notes is null or char_length(notes) <= 300),
  created_by           uuid references auth.users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint transport_assignments_student_fkey foreign key (student_id, school_id) references public.students (id, school_id),
  constraint transport_assignments_session_fkey foreign key (academic_session_id, school_id)
    references public.academic_sessions (id, school_id),
  constraint transport_assignments_route_fkey foreign key (route_id, school_id) references public.transport_routes (id, school_id),
  -- the stop is on that route
  constraint transport_assignments_stop_fkey foreign key (stop_id, route_id) references public.transport_stops (id, route_id),
  constraint transport_assignments_dates check (end_date is null or end_date >= start_date)
);
create index transport_assignments_student_idx on public.transport_assignments (student_id, start_date);
create index transport_assignments_route_idx on public.transport_assignments (route_id) where end_date is null;
create index transport_assignments_stop_idx on public.transport_assignments (stop_id);

-- housekeeping
do $$ declare t text; begin
  foreach t in array array['transport_vehicles', 'transport_staff', 'transport_fare_zones', 'transport_routes', 'transport_stops', 'transport_assignments'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.prevent_school_change()', t || '_school_guard', t);
  end loop;
end $$;
create trigger transport_documents_school_guard before update on public.transport_documents for each row execute function private.prevent_school_change();

-- ---------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------
create or replace function private.transport_clean() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'transport_vehicles' then
    new.registration_number := upper(regexp_replace(new.registration_number, '[\s.-]', '', 'g'));
  elsif tg_table_name = 'transport_staff' then
    new.license_number := nullif(upper(regexp_replace(coalesce(new.license_number, ''), '\s', '', 'g')), '');
  end if;
  return new;
end $$;
create trigger transport_vehicles_clean before insert or update on public.transport_vehicles for each row execute function private.transport_clean();
create trigger transport_staff_clean before insert or update on public.transport_staff for each row execute function private.transport_clean();

-- Riders on a route right now (or on a given day).
create or replace function private.transport_route_riders(p_route uuid, p_on date default null)
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.transport_assignments a
  join public.students s on s.id = a.student_id and s.status = 'active'
  where a.route_id = p_route and a.start_date <= coalesce(p_on, private.ist_today())
    and (a.end_date is null or a.end_date >= coalesce(p_on, private.ist_today()));
$$;

-- A route's vehicle must be in service with enough seats; its driver must be an active driver
-- with a valid licence; its attendant an active attendant.
create or replace function private.transport_route_guard() returns trigger language plpgsql set search_path = '' as $$
declare v public.transport_vehicles; d public.transport_staff; n int;
begin
  if new.vehicle_id is not null and (tg_op = 'INSERT' or new.vehicle_id is distinct from old.vehicle_id or new.status <> old.status) then
    select * into v from public.transport_vehicles where id = new.vehicle_id;
    if new.status = 'active' and v.status = 'retired' then
      raise exception 'Vehicle % is retired.', v.registration_number using errcode = 'check_violation';
    end if;
    if tg_op = 'UPDATE' then
      n := private.transport_route_riders(new.id);
      if n > v.seating_capacity then
        raise exception 'Vehicle % has % seats; % students ride this route.', v.registration_number, v.seating_capacity, n using errcode = 'check_violation';
      end if;
    end if;
  end if;
  if new.driver_id is not null and (tg_op = 'INSERT' or new.driver_id is distinct from old.driver_id) then
    select * into d from public.transport_staff where id = new.driver_id;
    if d.role <> 'driver' or d.status <> 'active' then
      raise exception '% is not an active driver.', d.full_name using errcode = 'check_violation';
    end if;
    if d.license_valid_until < private.ist_today() then
      raise exception '%''s driving licence expired on %.', d.full_name, to_char(d.license_valid_until, 'DD Mon YYYY') using errcode = 'check_violation';
    end if;
  end if;
  if new.attendant_id is not null and (tg_op = 'INSERT' or new.attendant_id is distinct from old.attendant_id) then
    select * into d from public.transport_staff where id = new.attendant_id;
    if d.role <> 'attendant' or d.status <> 'active' then
      raise exception '% is not an active attendant.', d.full_name using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger transport_routes_guard before insert or update on public.transport_routes
  for each row execute function private.transport_route_guard();

-- Staff and vehicles in use can't be deactivated / retired.
create or replace function private.transport_in_use_guard() returns trigger language plpgsql set search_path = '' as $$
declare st public.transport_staff; v public.transport_vehicles;
begin
  -- (one branch per table: a trigger row only has its own table's fields)
  if tg_table_name = 'transport_staff' then
    st := new;
    if st.status = 'inactive' and old.status = 'active'
       and exists (select 1 from public.transport_routes r where r.status = 'active' and (r.driver_id = st.id or r.attendant_id = st.id)) then
      raise exception '% is on an active route. Assign someone else to the route first.', st.full_name using errcode = 'check_violation';
    end if;
    if st.role <> old.role and exists (select 1 from public.transport_routes r where r.driver_id = st.id or r.attendant_id = st.id) then
      raise exception 'Remove % from their routes before changing their role.', st.full_name using errcode = 'check_violation';
    end if;
  else
    v := new;
    if v.status = 'retired' and old.status <> 'retired'
       and exists (select 1 from public.transport_routes r where r.status = 'active' and r.vehicle_id = v.id) then
      raise exception 'Vehicle % is on an active route. Give the route another vehicle first.', v.registration_number using errcode = 'check_violation';
    end if;
    if v.seating_capacity < old.seating_capacity
       and exists (select 1 from public.transport_routes r where r.vehicle_id = v.id and private.transport_route_riders(r.id) > v.seating_capacity) then
      raise exception 'Students already ride this vehicle on a route with more than % seats taken.', v.seating_capacity using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger transport_staff_in_use before update on public.transport_staff for each row execute function private.transport_in_use_guard();
create trigger transport_vehicles_in_use before update on public.transport_vehicles for each row execute function private.transport_in_use_guard();

-- Assignments: one at a time per student; within the session; the student enrolled in it.
create or replace function private.transport_assignment_guard() returns trigger language plpgsql set search_path = '' as $$
declare a public.academic_sessions;
begin
  select * into a from public.academic_sessions where id = new.academic_session_id;
  if new.start_date < a.start_date or new.start_date > a.end_date or (new.end_date is not null and new.end_date > a.end_date) then
    raise exception 'Transport dates must be within the % session (% to %).', a.name,
      to_char(a.start_date, 'DD Mon YYYY'), to_char(a.end_date, 'DD Mon YYYY') using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.student_enrollments e where e.student_id = new.student_id and e.academic_session_id = new.academic_session_id) then
    raise exception 'The student isn''t enrolled in the % session.', a.name using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.transport_assignments x
             where x.student_id = new.student_id and x.id <> new.id
               and daterange(x.start_date, x.end_date, '[]') && daterange(new.start_date, new.end_date, '[]')) then
    raise exception 'The student already has transport for some of these dates.' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' and (new.student_id <> old.student_id or new.academic_session_id <> old.academic_session_id) then
    raise exception 'Start a new assignment instead.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger transport_assignments_guard before insert or update on public.transport_assignments
  for each row execute function private.transport_assignment_guard();

-- Transport fee items are kept by the transport functions; zone heads stay out of class structures.
create or replace function private.transport_fee_item_guard() returns trigger language plpgsql set search_path = '' as $$
declare r record; v_kind text; v_zone boolean;
begin
  r := case when tg_op = 'DELETE' then old else new end;
  select kind into v_kind from public.fee_structures where id = r.fee_structure_id;
  if v_kind is null then return r; end if;  -- the structure itself is being deleted (guarded below)
  v_zone := exists (select 1 from public.transport_fare_zones z where z.fee_head_id = r.fee_head_id);
  if v_kind = 'transport' and coalesce(current_setting('erp.transport_sync', true), '') <> 'on' then
    raise exception 'Transport fares are changed under Transport → Fare zones.' using errcode = 'check_violation';
  end if;
  if tg_op <> 'DELETE' and v_kind = 'class' and v_zone then
    raise exception 'This fee head is a transport fare zone; it is charged through transport, not the class fee structure.' using errcode = 'check_violation';
  end if;
  return r;
end $$;
create trigger fee_items_transport_guard before insert or update or delete on public.fee_structure_items
  for each row execute function private.transport_fee_item_guard();

-- The transport fee structure itself isn't edited or deleted from the fee screens.
create or replace function private.transport_structure_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if old.kind = 'transport' and coalesce(current_setting('erp.transport_sync', true), '') <> 'on' then
    raise exception 'Transport fares are changed under Transport → Fare zones.' using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger fee_structures_transport_guard before update or delete on public.fee_structures
  for each row execute function private.transport_structure_guard();

-- ---------------------------------------------------------------------
-- Fees: the transport structure, fare-zone items, and the dues they create
-- ---------------------------------------------------------------------
-- The session's transport fee structure (created when first needed), with one item per fare zone.
create or replace function private.transport_structure(p_school uuid, p_session uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; z public.transport_fare_zones;
begin
  select id into v_id from public.fee_structures where academic_session_id = p_session and kind = 'transport';
  if v_id is null then
    insert into public.fee_structures (school_id, academic_session_id, class_id, kind, name, notes)
    values (p_school, p_session, null, 'transport', 'Transport fares', 'Kept by Transport → Fare zones.')
    returning id into v_id;
  end if;
  perform set_config('erp.transport_sync', 'on', true);
  for z in select * from public.transport_fare_zones where school_id = p_school loop
    insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency, billing_months, due_month)
    values (p_school, v_id, z.fee_head_id, z.amount, z.frequency, z.billing_months, z.due_month)
    on conflict (fee_structure_id, fee_head_id) do update
      set amount = excluded.amount, frequency = excluded.frequency, billing_months = excluded.billing_months, due_month = excluded.due_month
      where (fee_structure_items.amount, fee_structure_items.frequency, fee_structure_items.billing_months, fee_structure_items.due_month)
            is distinct from (excluded.amount, excluded.frequency, excluded.billing_months, excluded.due_month);
  end loop;
  perform set_config('erp.transport_sync', '', true);
  return v_id;
end $$;

-- Transport dues an enrollment should have: for each month its assignment covers (a month is
-- charged at the fare of the stop the student moves to, if they move during it).
create or replace function private.transport_wanted_dues(p_enrollment_ids uuid[])
returns table (enrollment_id uuid, school_id uuid, student_id uuid, fee_item_id uuid, fee_head_id uuid, due_month date, amount numeric)
language sql stable security definer set search_path = '' as $$
  with enr as materialized (
    select e.id, e.school_id, e.student_id, e.academic_session_id
    from public.student_enrollments e where e.id = any (p_enrollment_ids)
  ),
  asg as materialized (
    select enr.id as enrollment_id, enr.school_id, enr.student_id, ta.id as assignment_id, ta.start_date, ta.end_date,
           fs.id as structure_id, i.id as item_id
    from enr
    join public.transport_assignments ta on ta.student_id = enr.student_id and ta.academic_session_id = enr.academic_session_id and ta.charge_fee
    join public.transport_stops st on st.id = ta.stop_id
    join public.transport_fare_zones z on z.id = st.fare_zone_id
    join public.fee_structures fs on fs.academic_session_id = enr.academic_session_id and fs.kind = 'transport' and fs.is_active
    join public.fee_structure_items i on i.fee_structure_id = fs.id and i.fee_head_id = z.fee_head_id
  )
  select asg.enrollment_id, asg.school_id, asg.student_id, sc.fee_item_id, sc.fee_head_id, sc.due_month, sc.amount
  from asg
  cross join lateral private.fee_structure_schedule(asg.structure_id) sc
  where sc.fee_item_id = asg.item_id
    and sc.due_month >= date_trunc('month', asg.start_date)
    and (asg.end_date is null or sc.due_month <= date_trunc('month', asg.end_date))
    -- a later assignment starting in this month takes the month
    and not exists (select 1 from public.transport_assignments b
                    where b.student_id = asg.student_id and b.id <> asg.assignment_id and b.start_date > asg.start_date
                      and date_trunc('month', b.start_date) = sc.due_month);
$$;

-- The class fees (as in 0011) plus transport fees.
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
     or exists (select 1 from public.student_fee_optins o where o.enrollment_id = enr.id and o.fee_item_id = sc.fee_item_id)
  union all
  select t.* from private.transport_wanted_dues(p_enrollment_ids) t
  join public.student_enrollments e on e.id = t.enrollment_id
  join public.students s on s.id = e.student_id and s.status = 'active'
  join public.academic_sessions a on a.id = e.academic_session_id and a.archived_at is null;
$$;

-- Bring a student's dues up to date after a transport change (the caller is staff).
create or replace function private.transport_sync_student(p_student uuid, p_session uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  select coalesce(array_agg(e.id), '{}') into v_ids from public.student_enrollments e
  where e.student_id = p_student and (p_session is null or e.academic_session_id = p_session);
  perform private.sync_student_dues(v_ids);
end $$;

-- A fare zone changed: its fee head and items follow, then the dues of its riders.
create or replace function private.transport_zone_changed() returns trigger language plpgsql security definer set search_path = '' as $$
declare s record; r record;
begin
  update public.fee_heads set name = 'Transport – ' || btrim(new.name), is_active = new.is_active
  where id = new.fee_head_id and (name, is_active) is distinct from ('Transport – ' || btrim(new.name), new.is_active);
  for s in select fs.school_id, fs.academic_session_id from public.fee_structures fs
           join public.academic_sessions a on a.id = fs.academic_session_id and a.archived_at is null
           where fs.school_id = new.school_id and fs.kind = 'transport' loop
    perform private.transport_structure(s.school_id, s.academic_session_id);
  end loop;
  if tg_op = 'UPDATE' and (new.amount, new.frequency, new.billing_months, new.due_month)
                          is distinct from (old.amount, old.frequency, old.billing_months, old.due_month) then
    for r in select distinct ta.student_id, ta.academic_session_id from public.transport_assignments ta
             join public.transport_stops st on st.id = ta.stop_id
             join public.academic_sessions a on a.id = ta.academic_session_id and a.archived_at is null
             where st.fare_zone_id = new.id loop
      perform private.transport_sync_student(r.student_id, r.academic_session_id);
    end loop;
  end if;
  return null;
end $$;
create trigger transport_fare_zones_changed after insert or update on public.transport_fare_zones
  for each row execute function private.transport_zone_changed();

-- A stop moved to another zone: its riders' dues follow.
create or replace function private.transport_stop_zone_changed() returns trigger language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select distinct ta.student_id, ta.academic_session_id from public.transport_assignments ta
           join public.academic_sessions a on a.id = ta.academic_session_id and a.archived_at is null
           where ta.stop_id = new.id loop
    perform private.transport_sync_student(r.student_id, r.academic_session_id);
  end loop;
  return null;
end $$;
create trigger transport_stops_zone_changed after update of fare_zone_id on public.transport_stops
  for each row when (new.fare_zone_id is distinct from old.fare_zone_id) execute function private.transport_stop_zone_changed();

-- ---------------------------------------------------------------------
-- Staff functions (admins)
-- ---------------------------------------------------------------------
create or replace function private.is_transport_admin(p_school uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_super_admin() or private.has_school_role(p_school, array['school_admin']::public.app_role[]);
$$;

-- New fare zone: its fee head is created with it.
create or replace function private.transport_add_zone(
  p_school uuid, p_name text, p_amount numeric, p_frequency public.fee_frequency, p_billing_months smallint[], p_due_month smallint
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_head uuid; v_id uuid; v_name text := 'Transport – ' || btrim(p_name);
begin
  if not private.is_transport_admin(p_school) then
    raise exception 'Only school admins can change transport fares.' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from public.fee_heads h where h.school_id = p_school and lower(btrim(h.name)) = lower(v_name)) then
    raise exception 'A fee head called "%" already exists. Choose another zone name.', v_name using errcode = 'unique_violation';
  end if;
  insert into public.fee_heads (school_id, name, description, created_by)
  values (p_school, v_name, 'Transport fare zone (kept by Transport)', (select auth.uid())) returning id into v_head;
  insert into public.transport_fare_zones (school_id, name, amount, frequency, billing_months, due_month, fee_head_id)
  values (p_school, btrim(p_name), p_amount, p_frequency, p_billing_months, p_due_month, v_head) returning id into v_id;
  return v_id;
end $$;

-- Put a student on a route from a date. An assignment already running on that date ends the
-- day before (a change of route or stop); dues are brought up to date at once.
create or replace function private.transport_assign(
  p_student uuid, p_route uuid, p_stop uuid, p_trip text, p_start date, p_charge_fee boolean default true, p_notes text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.transport_routes; st public.transport_stops; v public.transport_vehicles; s public.students;
        v_session uuid; cur public.transport_assignments; v_id uuid; v_riders int;
begin
  select * into r from public.transport_routes where id = p_route for update;
  if not found or not private.is_transport_admin(r.school_id) then raise exception 'Route not found.' using errcode = 'P0002'; end if;
  if r.status <> 'active' then raise exception 'Route % is inactive.', r.name using errcode = 'check_violation'; end if;
  select * into st from public.transport_stops where id = p_stop and route_id = p_route;
  if not found then raise exception 'That stop isn''t on route %.', r.name using errcode = 'check_violation'; end if;
  select * into s from public.students where id = p_student and school_id = r.school_id;
  if not found then raise exception 'Student not found.' using errcode = 'P0002'; end if;
  if s.status <> 'active' then raise exception '% is not an active student.', s.full_name using errcode = 'check_violation'; end if;
  if p_trip not in ('both', 'pickup', 'drop') then raise exception 'Choose pickup, drop or both.' using errcode = 'check_violation'; end if;
  -- the session the start date falls in, which the student is enrolled in
  select e.academic_session_id into v_session from public.student_enrollments e
  join public.academic_sessions a on a.id = e.academic_session_id and a.archived_at is null
  where e.student_id = p_student and p_start between a.start_date and a.end_date;
  if v_session is null then
    raise exception '% isn''t enrolled in an open session that includes %.', s.full_name, to_char(p_start, 'DD Mon YYYY') using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('transport:' || p_student::text, 0));
  -- seats (riders on the start date, not counting this student's current assignment on the same route)
  if r.vehicle_id is not null then
    select * into v from public.transport_vehicles where id = r.vehicle_id;
    select count(*) into v_riders from public.transport_assignments a
      join public.students x on x.id = a.student_id and x.status = 'active'
      where a.route_id = p_route and a.student_id <> p_student
        and a.start_date <= greatest(p_start, private.ist_today()) and (a.end_date is null or a.end_date >= greatest(p_start, private.ist_today()));
    if v_riders >= v.seating_capacity then
      raise exception 'Route % is full: vehicle % has % seats.', r.name, v.registration_number, v.seating_capacity using errcode = 'check_violation';
    end if;
  end if;
  -- the assignment running on the start date ends the day before
  select * into cur from public.transport_assignments a
  where a.student_id = p_student and a.start_date <= p_start and (a.end_date is null or a.end_date >= p_start) for update;
  if found then
    if cur.start_date = p_start then
      raise exception 'The current transport also starts on that day; change its stop instead.' using errcode = 'check_violation';
    end if;
    update public.transport_assignments set end_date = p_start - 1 where id = cur.id;
  end if;
  if exists (select 1 from public.transport_assignments a where a.student_id = p_student and a.start_date > p_start) then
    raise exception '% already has transport starting after this date. End or remove that first.', s.full_name using errcode = 'check_violation';
  end if;
  perform private.transport_structure(r.school_id, v_session);
  insert into public.transport_assignments (school_id, student_id, academic_session_id, route_id, stop_id, trip, start_date, charge_fee, notes, created_by)
  values (r.school_id, p_student, v_session, p_route, p_stop, p_trip, p_start, coalesce(p_charge_fee, true), nullif(btrim(p_notes), ''), (select auth.uid()))
  returning id into v_id;
  perform private.transport_sync_student(p_student, null);
  return v_id;
end $$;

-- Stop using transport after a date (or remove an assignment that hasn't started).
create or replace function private.transport_end(p_assignment uuid, p_end date)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.transport_assignments;
begin
  select * into a from public.transport_assignments where id = p_assignment for update;
  if not found or not private.is_transport_admin(a.school_id) then raise exception 'Assignment not found.' using errcode = 'P0002'; end if;
  if p_end is null then
    -- removing: only before it starts, or if no transport due of it was paid
    if a.start_date <= private.ist_today() then
      raise exception 'Transport that has started is ended with a date, not removed.' using errcode = 'check_violation';
    end if;
    delete from public.transport_assignments where id = p_assignment;
  else
    if p_end < a.start_date then raise exception 'The end date is before the start date.' using errcode = 'check_violation'; end if;
    if a.end_date is not null and p_end > a.end_date and exists (select 1 from public.transport_assignments b
         where b.student_id = a.student_id and b.start_date > a.start_date and b.start_date <= p_end) then
      raise exception 'Another assignment follows this one.' using errcode = 'check_violation';
    end if;
    update public.transport_assignments set end_date = p_end where id = p_assignment;
  end if;
  perform private.transport_sync_student(a.student_id, null);
end $$;

-- Change the stop (same route) or the fee/trip of the current assignment without a new one.
create or replace function private.transport_update_assignment(p_assignment uuid, p_stop uuid, p_trip text, p_charge_fee boolean, p_notes text)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.transport_assignments;
begin
  select * into a from public.transport_assignments where id = p_assignment for update;
  if not found or not private.is_transport_admin(a.school_id) then raise exception 'Assignment not found.' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.transport_stops s where s.id = p_stop and s.route_id = a.route_id) then
    raise exception 'That stop isn''t on this route.' using errcode = 'check_violation';
  end if;
  if p_trip not in ('both', 'pickup', 'drop') then raise exception 'Choose pickup, drop or both.' using errcode = 'check_violation'; end if;
  update public.transport_assignments set stop_id = p_stop, trip = p_trip, charge_fee = coalesce(p_charge_fee, charge_fee),
    notes = nullif(btrim(p_notes), '') where id = p_assignment;
  perform private.transport_sync_student(a.student_id, null);
end $$;

-- What a family sees: their child's route, stop, times, vehicle, driver and attendant (and nothing else).
create or replace function private.transport_for_student(p_student uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_school uuid; out jsonb;
begin
  select school_id into v_school from public.students where id = p_student;
  if v_school is null or not (private.can_view_student_record(p_student) or private.is_super_admin()
     or private.has_school_role(v_school, array['school_admin', 'accountant']::public.app_role[])) then
    raise exception 'Student not found.' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(x order by x.start_date desc), '[]') into out from (
    select a.id, a.start_date, a.end_date, a.trip, a.charge_fee,
           (a.start_date <= private.ist_today() and (a.end_date is null or a.end_date >= private.ist_today())) as is_current,
           r.name as route_name, r.code as route_code, st.name as stop_name, st.landmark, st.pickup_time, st.drop_time,
           z.name as fare_zone, z.amount as fare, z.frequency as fare_frequency,
           v.registration_number, v.vehicle_type, d.full_name as driver_name, d.phone as driver_phone,
           at.full_name as attendant_name, at.phone as attendant_phone
    from public.transport_assignments a
    join public.transport_routes r on r.id = a.route_id
    join public.transport_stops st on st.id = a.stop_id
    join public.transport_fare_zones z on z.id = st.fare_zone_id
    left join public.transport_vehicles v on v.id = r.vehicle_id
    left join public.transport_staff d on d.id = r.driver_id
    left join public.transport_staff at on at.id = r.attendant_id
    where a.student_id = p_student) x;
  return out;
end $$;

-- Dashboard figures (admins and accountants).
create or replace function private.transport_dashboard(p_school uuid, p_session uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := private.ist_today(); out jsonb;
begin
  if not (private.is_super_admin() or private.has_school_role(p_school, array['school_admin', 'accountant']::public.app_role[])) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  select jsonb_build_object(
    'vehicles', (select count(*) from public.transport_vehicles v where v.school_id = p_school and v.status <> 'retired'),
    'vehicles_in_maintenance', (select count(*) from public.transport_vehicles v where v.school_id = p_school and v.status = 'maintenance'),
    'seats', (select coalesce(sum(v.seating_capacity), 0) from public.transport_vehicles v
              where v.school_id = p_school and exists (select 1 from public.transport_routes r where r.vehicle_id = v.id and r.status = 'active')),
    'routes', (select count(*) from public.transport_routes r where r.school_id = p_school and r.status = 'active'),
    'stops', (select count(*) from public.transport_stops s join public.transport_routes r on r.id = s.route_id
              where s.school_id = p_school and r.status = 'active'),
    'drivers', (select count(*) from public.transport_staff s where s.school_id = p_school and s.status = 'active' and s.role = 'driver'),
    'attendants', (select count(*) from public.transport_staff s where s.school_id = p_school and s.status = 'active' and s.role = 'attendant'),
    'students', (select count(distinct a.student_id) from public.transport_assignments a
                 join public.students x on x.id = a.student_id and x.status = 'active'
                 where a.school_id = p_school and a.start_date <= v_today and (a.end_date is null or a.end_date >= v_today)),
    'documents_expired', (select count(*) from public.transport_documents d where d.school_id = p_school and d.valid_until < v_today),
    'documents_expiring', (select count(*) from public.transport_documents d where d.school_id = p_school
                           and d.valid_until between v_today and v_today + 30),
    'licenses_expiring', (select count(*) from public.transport_staff s where s.school_id = p_school and s.status = 'active'
                          and s.license_valid_until <= v_today + 30),
    'routes_full', (select count(*) from public.transport_routes r join public.transport_vehicles v on v.id = r.vehicle_id
                    where r.school_id = p_school and r.status = 'active' and private.transport_route_riders(r.id) >= v.seating_capacity),
    'fees', (select jsonb_build_object(
               'billed', coalesce(sum(d.amount), 0),
               'due_till_now', coalesce(sum(d.amount) filter (where d.due_month <= date_trunc('month', v_today)), 0),
               'collected', coalesce(sum(p.paid), 0),
               'overdue', coalesce(sum(d.amount - coalesce(p.paid, 0)) filter (where d.due_month <= date_trunc('month', v_today)), 0))
             from public.student_fee_dues d
             join public.student_enrollments e on e.id = d.enrollment_id and e.academic_session_id = p_session
             join public.transport_fare_zones z on z.fee_head_id = d.fee_head_id
             left join lateral (select sum(al.amount) as paid from public.fee_payment_allocations al where al.due_id = d.id) p on true
             where d.school_id = p_school)
  ) into out;
  return out;
end $$;

-- ---------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------
revoke all on public.transport_vehicles, public.transport_staff, public.transport_documents, public.transport_fare_zones,
  public.transport_routes, public.transport_stops, public.transport_assignments from anon, authenticated;
grant select on public.transport_vehicles, public.transport_staff, public.transport_documents, public.transport_fare_zones,
  public.transport_routes, public.transport_stops, public.transport_assignments to authenticated;
grant insert, update, delete on public.transport_vehicles, public.transport_staff, public.transport_routes, public.transport_stops to authenticated;
grant insert, delete on public.transport_documents to authenticated;
grant update (title, number, issued_on, valid_until) on public.transport_documents to authenticated;
grant update (name, amount, frequency, billing_months, due_month, is_active) on public.transport_fare_zones to authenticated;
-- zones are created with their fee head by transport_add_zone and never deleted (deactivate instead);
-- assignments change only through the functions

do $$ declare t text; begin
  foreach t in array array['transport_vehicles', 'transport_staff', 'transport_documents', 'transport_fare_zones', 'transport_routes', 'transport_stops',
                           'transport_assignments'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  -- read: admins and accountants (documents: admins only); write: admins
  foreach t in array array['transport_vehicles', 'transport_staff', 'transport_fare_zones', 'transport_routes', 'transport_stops'] loop
    execute format($p$create policy %I on public.%I for select to authenticated using (private.is_super_admin()
      or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[]))$p$, t || '_select', t);
  end loop;
  foreach t in array array['transport_vehicles', 'transport_staff', 'transport_routes', 'transport_stops'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (private.is_transport_admin(school_id))', t || '_insert', t);
  end loop;
  foreach t in array array['transport_vehicles', 'transport_staff', 'transport_fare_zones', 'transport_routes', 'transport_stops'] loop
    execute format('create policy %I on public.%I for update to authenticated using (private.is_transport_admin(school_id)) with check (private.is_transport_admin(school_id))', t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.is_transport_admin(school_id))', t || '_delete', t);
  end loop;
end $$;
create policy transport_documents_select on public.transport_documents for select to authenticated using (private.is_transport_admin(school_id));
create policy transport_documents_insert on public.transport_documents for insert to authenticated with check (private.is_transport_admin(school_id));
create policy transport_documents_update on public.transport_documents for update to authenticated
  using (private.is_transport_admin(school_id)) with check (private.is_transport_admin(school_id));
create policy transport_documents_delete on public.transport_documents for delete to authenticated using (private.is_transport_admin(school_id));
create policy transport_assignments_select on public.transport_assignments for select to authenticated using (
  private.is_super_admin() or private.has_school_role(school_id, array['school_admin', 'accountant']::public.app_role[])
  or private.can_view_student_record(student_id));

revoke all on function private.transport_route_riders(uuid, date), private.transport_structure(uuid, uuid),
  private.transport_wanted_dues(uuid[]), private.transport_sync_student(uuid, uuid), private.is_transport_admin(uuid),
  private.transport_add_zone(uuid, text, numeric, public.fee_frequency, smallint[], smallint),
  private.transport_assign(uuid, uuid, uuid, text, date, boolean, text), private.transport_end(uuid, date),
  private.transport_update_assignment(uuid, uuid, text, boolean, text), private.transport_for_student(uuid),
  private.transport_dashboard(uuid, uuid)
  from public, anon, authenticated;
grant execute on function private.transport_route_riders(uuid, date), private.transport_wanted_dues(uuid[]), private.is_transport_admin(uuid),
  private.transport_add_zone(uuid, text, numeric, public.fee_frequency, smallint[], smallint),
  private.transport_assign(uuid, uuid, uuid, text, date, boolean, text), private.transport_end(uuid, date),
  private.transport_update_assignment(uuid, uuid, text, boolean, text), private.transport_for_student(uuid),
  private.transport_dashboard(uuid, uuid)
  to authenticated;
grant execute on function private.transport_wanted_dues(uuid[]) to erp_notify, erp_payments;

-- ---------------------------------------------------------------------
-- Private bucket for vehicle and staff documents (server only, like student documents)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('transport-documents', 'transport-documents', false, 10485760,
            array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
