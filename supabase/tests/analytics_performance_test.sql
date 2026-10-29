-- =====================================================================
-- Analytics performance test (migrations 0001-0028). Rolls back.
-- Pass = "ALL ANALYTICS PERFORMANCE TESTS PASSED".
-- A large school: 1,500 students in 10 classes x 3 sections, 200 days of attendance
-- (300,000 records), 12 monthly dues each (18,000) with 9,000 receipts, 3 exams of
-- 6 papers each (~27,000 marks), 2,000 enquiries and 800 applications.
-- Each analytics tab must answer in under 3 seconds.
-- =====================================================================
begin;
create function private._ap_assert(ok boolean, msg text) returns void language plpgsql as $$
begin if ok is not true then raise exception 'FAIL: %', msg using errcode = 'ZT001'; end if; end $$;

insert into auth.users (id, email) values ('a3900000-0000-4000-8000-0000000000aa', 'perf-admin@example.invalid');
insert into public.schools (id, name, code) values ('b3900000-0000-4000-8000-00000000000a', 'Big School', 'ZZPF-A');
insert into public.school_memberships (school_id, user_id, role) values ('b3900000-0000-4000-8000-00000000000a', 'a3900000-0000-4000-8000-0000000000aa', 'school_admin');
insert into public.academic_sessions (id, school_id, name, start_date, end_date, is_current) values
  ('c3900000-0000-4000-8000-000000000001', 'b3900000-0000-4000-8000-00000000000a', 'Big year',
   (date_trunc('month', private.ist_today()) - interval '7 months')::date, (date_trunc('month', private.ist_today()) + interval '5 months')::date - 1, true);
create temp table k as select 'b3900000-0000-4000-8000-00000000000a'::uuid as s, 'c3900000-0000-4000-8000-000000000001'::uuid as sess,
  (date_trunc('month', private.ist_today()) - interval '7 months')::date as start;

insert into public.classes (id, school_id, name, display_order)
select ('d3900000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, k.s, 'Class ' || i, i from k, generate_series(1, 10) i;
insert into public.sections (id, school_id, class_id, academic_session_id, name, capacity)
select ('d3910000-0000-4000-8000-000000000' || lpad(i::text, 2, '0') || j)::uuid, k.s, ('d3900000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, k.sess,
       chr(64 + j), 55
from k, generate_series(1, 10) i, generate_series(1, 3) j;
insert into public.students (id, school_id, student_code, full_name, father_name, date_of_birth, gender, mobile)
select ('f3900000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, k.s, 'PF' || n, 'Student ' || n, 'Parent ' || n, '2015-01-01',
       case when n % 2 = 0 then 'female' else 'male' end::public.gender, '9' || lpad(n::text, 9, '0')
from k, generate_series(1, 1500) n;
insert into public.student_enrollments (id, school_id, student_id, academic_session_id, class_id, section_id, admission_number, admission_date)
select ('e3900000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, k.s, ('f3900000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, k.sess,
       ('d3900000-0000-4000-8000-0000000000' || lpad((1 + n % 10)::text, 2, '0'))::uuid,
       ('d3910000-0000-4000-8000-000000000' || lpad((1 + n % 10)::text, 2, '0') || (1 + (n / 10) % 3))::uuid, 'A' || n, k.start + (n % 60)
from k, generate_series(1, 1500) n;
insert into public.attendance_records (school_id, student_id, enrollment_id, academic_session_id, class_id, section_id, attendance_date, status)
select k.s, en.student_id, en.id, k.sess, en.class_id, en.section_id, k.start + d,
       (case when (abs(hashtext(en.id::text)) + d) % 11 = 0 then 'absent' when (abs(hashtext(en.id::text)) + d) % 37 = 0 then 'leave' else 'present' end)::public.attendance_status
from k, generate_series(0, 199) d, public.student_enrollments en
where en.academic_session_id = k.sess and k.start + d <= private.ist_today();

insert into public.fee_heads (id, school_id, name) values ('a3950000-0000-4000-8000-000000000001', 'b3900000-0000-4000-8000-00000000000a', 'Tuition');
insert into public.fee_structures (id, school_id, academic_session_id, class_id)
select ('a3960000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, k.s, k.sess, ('d3900000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid
from k, generate_series(1, 10) i;
insert into public.fee_structure_items (id, school_id, fee_structure_id, fee_head_id, amount, frequency)
select ('a3970000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid, k.s, ('a3960000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid,
       'a3950000-0000-4000-8000-000000000001', 1000 + 100 * i, 'monthly'
from k, generate_series(1, 10) i;
insert into public.student_fee_dues (school_id, enrollment_id, student_id, fee_item_id, fee_head_id, due_month, amount)
select k.s, en.id, en.student_id, ('a3970000-0000-4000-8000-0000000000' || right(en.class_id::text, 2))::uuid, 'a3950000-0000-4000-8000-000000000001',
       (k.start + m * interval '1 month')::date, 1000
from k, public.student_enrollments en, generate_series(0, 11) m where en.academic_session_id = k.sess;
-- six months paid for every student: one receipt per two months
insert into public.fee_payments (id, school_id, student_id, enrollment_id, academic_session_id, receipt_number, payment_date, amount, payment_mode, reference_number, balance_after, idempotency_key)
select gen_random_uuid(), k.s, en.student_id, en.id, k.sess, 'PF-' || en.admission_number || '-' || m, k.start + m * 60 + 3, 2000,
       (array['cash', 'cash', 'bank_transfer', 'cheque'])[1 + (m + length(en.admission_number)) % 4]::public.payment_mode, 'REF-' || m, 0, gen_random_uuid()
from k, public.student_enrollments en, generate_series(0, 2) m where en.academic_session_id = k.sess;
insert into public.fee_payment_allocations (school_id, payment_id, due_id, amount)
select k.s, fp.id, d.id, 1000
from k, public.fee_payments fp join public.student_fee_dues d on d.enrollment_id = fp.enrollment_id
  and d.due_month in (date_trunc('month', fp.payment_date)::date, (date_trunc('month', fp.payment_date) + interval '1 month')::date)
where fp.school_id = k.s;

insert into public.grade_bands (school_id, grade, min_percentage) select k.s, g, m from k, (values ('A1', 91), ('A2', 81), ('B1', 71), ('B2', 61), ('C1', 51), ('C2', 41), ('D', 33), ('E', 0)) v(g, m);
insert into public.subjects (id, school_id, name) select ('a3980000-0000-4000-8000-00000000000' || i)::uuid, k.s, 'Subject ' || i from k, generate_series(1, 6) i;
insert into public.exam_types (id, school_id, name) values ('a3990000-0000-4000-8000-000000000001', 'b3900000-0000-4000-8000-00000000000a', 'Term');
insert into public.exams (id, school_id, academic_session_id, exam_type_id, name)
select ('a39a0000-0000-4000-8000-00000000000' || x)::uuid, k.s, k.sess, 'a3990000-0000-4000-8000-000000000001', 'Exam ' || x from k, generate_series(1, 3) x;
insert into public.exam_papers (id, school_id, exam_id, academic_session_id, class_id, subject_id, exam_date, start_time, end_time, max_marks, pass_marks)
select gen_random_uuid(), k.s, ('a39a0000-0000-4000-8000-00000000000' || x)::uuid, k.sess, ('d3900000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid,
       ('a3980000-0000-4000-8000-00000000000' || j)::uuid, k.start + 40 * x + j, '09:00', '12:00', 100, 33
from k, generate_series(1, 3) x, generate_series(1, 10) i, generate_series(1, 6) j;
insert into public.exam_marks (school_id, paper_id, student_id, enrollment_id, section_id, marks, is_absent)
select k.s, p.id, en.student_id, en.id, en.section_id,
       case when (length(en.admission_number) + extract(day from p.exam_date)::int) % 29 = 0 then null else 20 + (abs(hashtext(en.id::text || p.id::text)) % 81) end,
       (length(en.admission_number) + extract(day from p.exam_date)::int) % 29 = 0
from k, public.exam_papers p join public.student_enrollments en on en.class_id = p.class_id and en.academic_session_id = p.academic_session_id
where p.school_id = k.s;

insert into public.admission_enquiries (school_id, academic_session_id, enquiry_number, enquiry_date, parent_name, student_name, phone, class_id, source, status)
select k.s, k.sess, 'PE' || n, k.start - 60 + (n % 200), 'Parent ' || n, 'Child ' || n, '8' || lpad(n::text, 9, '0'),
       ('d3900000-0000-4000-8000-0000000000' || lpad((1 + n % 10)::text, 2, '0'))::uuid,
       (array['walk_in', 'phone_call', 'website', 'referral'])[1 + n % 4]::public.enquiry_source,
       (array['new', 'contacted', 'interested', 'rejected', 'admitted'])[1 + n % 5]::public.enquiry_status
from k, generate_series(1, 2000) n;
insert into public.admission_applications (school_id, academic_session_id, class_id, application_number, status, student_name, date_of_birth, gender,
  contact_phone, address_line, city, state, postal_code, submitted_at)
select k.s, k.sess, ('d3900000-0000-4000-8000-0000000000' || lpad((1 + n % 10)::text, 2, '0'))::uuid, 'PA' || n,
       (array['submitted', 'verified', 'approved', 'rejected'])[1 + n % 4]::public.admission_status, 'Child ' || n, '2016-01-01', 'male',
       '7' || lpad(n::text, 9, '0'), '1 Road', 'City', 'State', '110001', (k.start - 60 + (n % 200))::timestamp at time zone 'Asia/Kolkata'
from k, generate_series(1, 800) n;
analyze;

select private._ap_assert((select count(*) from public.attendance_records ar, k where ar.school_id = k.s) > 250000, 'the fixture is large');

create temp table timings (tab text, ms numeric);
grant all on timings to authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'a3900000-0000-4000-8000-0000000000aa', 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ declare t timestamptz; r jsonb; begin
  t := clock_timestamp(); r := private.analytics_students('b3900000-0000-4000-8000-00000000000a', null, null, null, null, null);
  insert into timings values ('students', extract(epoch from clock_timestamp() - t) * 1000);
  perform private._ap_assert((r #>> '{enrollment,kpis,students}')::int = 1500, 'all 1500 students counted');
  t := clock_timestamp();
  perform private.analytics_sync_dues('b3900000-0000-4000-8000-00000000000a',
    (select id from public.academic_sessions where school_id = 'b3900000-0000-4000-8000-00000000000a' and is_current));
  insert into timings values ('fees: bring dues up to date', extract(epoch from clock_timestamp() - t) * 1000);
  t := clock_timestamp(); r := private.analytics_fees('b3900000-0000-4000-8000-00000000000a', null, null, null, null);
  insert into timings values ('fees', extract(epoch from clock_timestamp() - t) * 1000);
  perform private._ap_assert((r #>> '{kpis,receipts}')::int = 4500, 'all receipts counted');
  t := clock_timestamp(); r := private.analytics_admissions('b3900000-0000-4000-8000-00000000000a', null, null, null, null);
  insert into timings values ('admissions', extract(epoch from clock_timestamp() - t) * 1000);
  perform private._ap_assert((r #>> '{kpis,enquiries}')::int = 2000, 'all enquiries counted');
  t := clock_timestamp(); r := private.analytics_students('b3900000-0000-4000-8000-00000000000a', null, 'd3900000-0000-4000-8000-000000000003', null, null, null);
  insert into timings values ('students, one class', extract(epoch from clock_timestamp() - t) * 1000);
end $$;
reset role;
select tab, round(ms) as ms from timings;
select private._ap_assert(max(ms) < 3000, 'every tab answers in under 3 s (slowest: ' || round(max(ms)) || ' ms)') from timings;

do $$ begin raise notice 'ALL ANALYTICS PERFORMANCE TESTS PASSED'; end $$;
select 'ALL ANALYTICS PERFORMANCE TESTS PASSED' as result;
rollback;
