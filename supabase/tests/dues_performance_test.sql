-- =====================================================================
-- Dues performance check (migrations 0001-0011). Run in Supabase SQL Editor.
-- Rolls back; leaves nothing behind. Pass = "DUES PERFORMANCE CHECK PASSED".
-- Builds a 600-student school (3 fee items) and refreshes everyone's dues twice.
-- Before the 0011 fix this took ~20 s per refresh; it must stay well under 5 s.
-- =====================================================================
begin;

insert into public.schools (id, name, code) values ('b0000000-0000-4000-8000-0000000000ff', 'Bench', 'ZZBENCH');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values ('c0000000-0000-4000-8000-0000000000ff','b0000000-0000-4000-8000-0000000000ff','2026-27','2026-04-01','2027-03-31',true);
insert into public.classes (id, school_id, name) values ('d0000000-0000-4000-8000-0000000000ff','b0000000-0000-4000-8000-0000000000ff','Class 5');
insert into public.sections (school_id, class_id, academic_session_id, name, capacity)
  select 'b0000000-0000-4000-8000-0000000000ff','d0000000-0000-4000-8000-0000000000ff','c0000000-0000-4000-8000-0000000000ff', chr(64+g), 100 from generate_series(1,6) g;
insert into public.students (school_id, full_name, father_name, date_of_birth, gender, mobile)
  select 'b0000000-0000-4000-8000-0000000000ff', 'Bench '||g, 'P', '2015-01-01', 'male', '98'||lpad(g::text, 8, '0') from generate_series(1,600) g;
with st as (select id, school_id, full_name, row_number() over (order by full_name) as n from public.students where school_id = 'b0000000-0000-4000-8000-0000000000ff'),
     sec as (select id, row_number() over (order by name) - 1 as k from public.sections where school_id = 'b0000000-0000-4000-8000-0000000000ff')
insert into public.student_enrollments (school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date)
  select st.school_id, st.id, 'c0000000-0000-4000-8000-0000000000ff', 'd0000000-0000-4000-8000-0000000000ff', sec.id, st.full_name, '2026-04-01'
  from st join sec on sec.k = st.n % 6;
insert into public.fee_heads (id, school_id, name) values ('a0000000-0000-4000-8000-0000000000f1','b0000000-0000-4000-8000-0000000000ff','Tuition'),('a0000000-0000-4000-8000-0000000000f2','b0000000-0000-4000-8000-0000000000ff','Annual'),('a0000000-0000-4000-8000-0000000000f3','b0000000-0000-4000-8000-0000000000ff','Exam');
insert into public.fee_structures (id, school_id, academic_session_id, class_id) values ('a1000000-0000-4000-8000-0000000000ff','b0000000-0000-4000-8000-0000000000ff','c0000000-0000-4000-8000-0000000000ff','d0000000-0000-4000-8000-0000000000ff');
insert into public.fee_structure_items (school_id, fee_structure_id, fee_head_id, amount, frequency) values
 ('b0000000-0000-4000-8000-0000000000ff','a1000000-0000-4000-8000-0000000000ff','a0000000-0000-4000-8000-0000000000f1',1500,'monthly'),
 ('b0000000-0000-4000-8000-0000000000ff','a1000000-0000-4000-8000-0000000000ff','a0000000-0000-4000-8000-0000000000f2',5000,'yearly'),
 ('b0000000-0000-4000-8000-0000000000ff','a1000000-0000-4000-8000-0000000000ff','a0000000-0000-4000-8000-0000000000f3',800,'quarterly');

do $$
declare
  t0 timestamptz;
  ids uuid[] := array(select id from public.student_enrollments where school_id = 'b0000000-0000-4000-8000-0000000000ff');
  first_ms numeric;
  second_ms numeric;
begin
  t0 := clock_timestamp();
  perform private.sync_student_dues(ids);
  first_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  if (select count(*) from public.student_fee_dues where school_id = 'b0000000-0000-4000-8000-0000000000ff') <> 10200 then
    raise exception 'FAIL: expected 10200 dues (600 students x 17 dues)';
  end if;
  t0 := clock_timestamp();
  perform private.sync_student_dues(ids);
  second_ms := extract(epoch from clock_timestamp() - t0) * 1000;
  raise notice 'dues refresh for 600 students: first % ms, unchanged % ms', round(first_ms), round(second_ms);
  if first_ms > 5000 or second_ms > 5000 then
    raise exception 'FAIL: refreshing dues for 600 students is too slow (% ms / % ms)', round(first_ms), round(second_ms);
  end if;
end $$;

select 'DUES PERFORMANCE CHECK PASSED' as result;
rollback;
