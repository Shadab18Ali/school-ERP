-- =====================================================================
-- Phase 30: school analytics — students, fees, admissions
--
--   private.analytics_students(school, session, class, from, to, exam)
--   private.analytics_fees(school, session, class, from, to)
--   private.analytics_admissions(school, session, class, from, to)
--
-- Each returns one jsonb document with every figure for one tab of the Analytics page,
-- computed here from the school's own records (no stored totals, no sample data).
-- Who may see what is checked first, by private.analytics_access: students (including exam
-- performance) for the school's admins; fees and admissions for its admins and accountants;
-- the platform's super admin for any school. Anyone else gets an error, whatever school they
-- name. (The functions then read the whole school directly instead of filtering every row
-- through row-level security, which on a large school was ~60 times slower — the result
-- is school-wide figures only these roles may see anyway.) JIT compilation is off for them:
-- it cost two seconds per call to save a few milliseconds.
--
-- Filters: session (default: the current one), class (optional), and a date range that
-- defaults to the session's start up to today (never beyond the session or today).
--
-- Definitions are the ones the rest of the system uses, so the numbers agree everywhere:
--   attendance %   present / (present + absent + leave) over marked days (as the dashboard)
--   exam result    a student's % counts only when every paper has marks; pass = no paper
--                  failed or absent; grades from the school's grade bands (as report cards)
--   collected      receipts not cancelled (a refund cancels its receipt), by receipt date
--   outstanding    dues not yet paid; overdue = due in or before the current month
-- =====================================================================

-- who may see which analytics (mirrors the API's permissions)
create or replace function private.analytics_access(p_school uuid, p_area text)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_school is null or not (private.is_super_admin() or private.has_school_role(p_school,
       case p_area when 'students' then array['school_admin']::public.app_role[]
                   else array['school_admin', 'accountant']::public.app_role[] end)) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
end $$;

-- helper: the session asked for (or the current one) and the date window inside it
create or replace function private.analytics_window(p_school uuid, p_session uuid, p_from date, p_to date)
returns table (session_id uuid, session_name text, start_date date, end_date date, win_from date, win_to date)
language sql stable security invoker set search_path = '' as $$
  select a.id, a.name, a.start_date, a.end_date,
         greatest(coalesce(p_from, a.start_date), a.start_date),
         least(coalesce(p_to, a.end_date), a.end_date, private.ist_today())
  from public.academic_sessions a
  where a.school_id = p_school and (a.id = p_session or (p_session is null and a.is_current))
  order by a.start_date desc limit 1;
$$;

-- helper: the session each student was first enrolled in (their admission to the school)
create or replace function private.analytics_first_enrollments(p_school uuid)
returns table (student_id uuid, enrollment_id uuid, academic_session_id uuid, admission_date date, class_id uuid)
language sql stable security invoker set search_path = '' as $$
  select distinct on (en.student_id) en.student_id, en.id, en.academic_session_id, en.admission_date, en.class_id
  from public.student_enrollments en join public.academic_sessions a on a.id = en.academic_session_id
  where en.school_id = p_school
  order by en.student_id, a.start_date, en.admission_date;
$$;

-- =====================================================================
-- Students: enrollment, class strength, attendance, performance
-- =====================================================================
create or replace function private.analytics_students(p_school uuid, p_session uuid, p_class uuid, p_from date, p_to date, p_exam uuid)
returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  w record; v_exam uuid; out jsonb;
  k_enrolled jsonb; k_strength jsonb; k_att jsonb; k_perf jsonb;
begin
  perform private.analytics_access(p_school, 'students');
  select * into w from private.analytics_window(p_school, p_session, p_from, p_to);
  if w.session_id is null then return null; end if;

  -- ---------- enrollment ----------
  with firsts as (select * from private.analytics_first_enrollments(p_school)),
  e as (
    select en.id, en.student_id, en.class_id, en.section_id, st.gender, st.status, (f.academic_session_id = w.session_id) as is_new
    from public.student_enrollments en join public.students st on st.id = en.student_id
    left join firsts f on f.student_id = en.student_id
    where en.school_id = p_school and en.academic_session_id = w.session_id and (p_class is null or en.class_id = p_class)
  ),
  trend as (
    select a.id, a.name, a.start_date, a.is_current,
           count(en.id) as enrolled,
           count(en.id) filter (where f.academic_session_id = a.id) as new_students
    from public.academic_sessions a
    left join public.student_enrollments en on en.academic_session_id = a.id and (p_class is null or en.class_id = p_class)
    left join firsts f on f.student_id = en.student_id
    where a.school_id = p_school and a.start_date <= greatest(w.start_date, private.ist_today())
    group by a.id order by a.start_date
  ),
  months as (
    select m::date as month from generate_series(date_trunc('month', w.start_date), date_trunc('month', w.end_date), interval '1 month') m
  ),
  admitted as (   -- new students by month of admission; before the session's start counts in its first month
    select greatest(date_trunc('month', f.admission_date), date_trunc('month', w.start_date))::date as month, count(*) as n
    from firsts f where f.academic_session_id = w.session_id and (p_class is null or f.class_id = p_class)
    group by 1
  )
  select jsonb_build_object(
    'kpis', (select jsonb_build_object(
        'students', count(*) filter (where status = 'active'),
        'enrolled_all', count(*),
        'left', count(*) filter (where status <> 'active'),
        'new_students', count(*) filter (where is_new),
        'boys', count(*) filter (where status = 'active' and gender = 'male'),
        'girls', count(*) filter (where status = 'active' and gender = 'female'),
        'other', count(*) filter (where status = 'active' and gender not in ('male', 'female'))) from e),
    'trend', coalesce((select jsonb_agg(jsonb_build_object('session_id', id, 'session', name, 'current', is_current,
        'enrolled', enrolled, 'new_students', new_students, 'continuing', enrolled - new_students) order by start_date) from trend), '[]'),
    'admissions_by_month', (select jsonb_agg(jsonb_build_object('month', mo.month, 'new_students', coalesce(ad.n, 0)) order by mo.month)
        from months mo left join admitted ad on ad.month = mo.month))
  into k_enrolled;

  -- ---------- class strength (active students, active sections) ----------
  with sec as (
    select c.id as class_id, c.name as class_name, c.display_order, s.id as section_id, s.name as section_name, s.capacity
    from public.classes c join public.sections s on s.class_id = c.id
    where c.school_id = p_school and s.academic_session_id = w.session_id and s.deleted_at is null and s.is_active
      and c.deleted_at is null and (p_class is null or c.id = p_class)
  ),
  counts as (
    select sec.*, count(st.id) as students,
           count(st.id) filter (where st.gender = 'male') as boys, count(st.id) filter (where st.gender = 'female') as girls
    from sec left join public.student_enrollments en on en.section_id = sec.section_id and en.academic_session_id = w.session_id
    left join public.students st on st.id = en.student_id and st.status = 'active'
    group by sec.class_id, sec.class_name, sec.display_order, sec.section_id, sec.section_name, sec.capacity
  ),
  by_class as (
    select class_id, class_name, display_order, sum(students) as students, sum(boys) as boys, sum(girls) as girls,
           count(*) as sections, sum(capacity) as capacity, sum(students) filter (where capacity is not null) as seated,
           jsonb_agg(jsonb_build_object('section_id', section_id, 'section', section_name, 'students', students, 'boys', boys,
             'girls', girls, 'capacity', capacity) order by lower(section_name)) as sections_detail
    from counts group by class_id, class_name, display_order
  )
  select jsonb_build_object(
    'sections', coalesce((select sum(sections) from by_class), 0),
    'average_section', (select round(sum(students)::numeric / nullif(sum(sections), 0), 1) from by_class),
    'capacity', (select sum(capacity) from by_class),
    'fill_percent', (select round(100.0 * sum(seated) / nullif(sum(capacity), 0), 1) from by_class),
    'classes', coalesce((select jsonb_agg(jsonb_build_object('class_id', class_id, 'class', class_name, 'students', students, 'boys', boys,
        'girls', girls, 'other', students - boys - girls, 'sections', sections, 'capacity', capacity,
        'fill_percent', round(100.0 * seated / nullif(capacity, 0), 1), 'detail', sections_detail)
        order by display_order, lower(class_name)) from by_class), '[]'))
  into k_strength;

  -- ---------- attendance (in the date window) ----------
  with r as (
    select ar.student_id, ar.class_id, ar.attendance_date, ar.status
    from public.attendance_records ar
    where ar.school_id = p_school and ar.academic_session_id = w.session_id
      and ar.attendance_date between w.win_from and w.win_to and (p_class is null or ar.class_id = p_class)
  ),
  per_student as (
    select r.student_id, round(100.0 * count(*) filter (where r.status = 'present') / count(*), 1) as pct
    from r join public.students st on st.id = r.student_id and st.status = 'active' group by r.student_id
  ),
  months as (
    select m::date as month from generate_series(date_trunc('month', w.win_from), date_trunc('month', w.win_to), interval '1 month') m
    where w.win_from <= w.win_to
  )
  select jsonb_build_object(
    'from', w.win_from, 'to', w.win_to,
    'days_marked', (select count(distinct attendance_date) from r),
    'present', (select count(*) filter (where status = 'present') from r),
    'absent', (select count(*) filter (where status = 'absent') from r),
    'leave', (select count(*) filter (where status = 'leave') from r),
    'percent', (select round(100.0 * count(*) filter (where status = 'present') / nullif(count(*), 0), 1) from r),
    'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', mo.month, 'present', x.p, 'absent', x.a, 'leave', x.l,
        'percent', round(100.0 * x.p / nullif(x.p + x.a + x.l, 0), 1)) order by mo.month)
        from months mo left join lateral (select count(*) filter (where status = 'present') as p, count(*) filter (where status = 'absent') as a,
          count(*) filter (where status = 'leave') as l from r where date_trunc('month', r.attendance_date) = mo.month) x on true), '[]'),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'percent', pct, 'marked', n) order by d) from (
        select attendance_date as d, round(100.0 * count(*) filter (where status = 'present') / count(*), 1) as pct, count(*) as n
        from r group by attendance_date order by attendance_date desc limit 60) t), '[]'),
    'by_class', coalesce((select jsonb_agg(jsonb_build_object('class_id', c.id, 'class', c.name, 'percent', x.pct, 'marked', x.n)
        order by c.display_order, lower(c.name)) from (
        select class_id, round(100.0 * count(*) filter (where status = 'present') / count(*), 1) as pct, count(*) as n
        from r group by class_id) x join public.classes c on c.id = x.class_id), '[]'),
    'students_counted', (select count(*) from per_student),
    'bands', jsonb_build_array(
        jsonb_build_object('band', '90% and above', 'students', (select count(*) from per_student where pct >= 90)),
        jsonb_build_object('band', '75% to 89.9%', 'students', (select count(*) from per_student where pct >= 75 and pct < 90)),
        jsonb_build_object('band', 'Below 75%', 'students', (select count(*) from per_student where pct < 75))))
  into k_att;

  -- ---------- exam performance ----------
  -- the exam asked for, else the most recent one in the session that has marks
  v_exam := (select x.id from public.exams x where x.id = p_exam and x.school_id = p_school and x.academic_session_id = w.session_id);
  if v_exam is null then
    select p.exam_id into v_exam from public.exam_papers p join public.exam_marks m on m.paper_id = p.id
    where p.school_id = p_school and p.academic_session_id = w.session_id and (p_class is null or p.class_id = p_class)
    group by p.exam_id order by max(p.exam_date) desc nulls last limit 1;
  end if;

  with st as (   -- every active student of the session, in the classes that have papers
    select en.student_id, en.class_id from public.student_enrollments en join public.students s on s.id = en.student_id and s.status = 'active'
    where en.school_id = p_school and en.academic_session_id = w.session_id and (p_class is null or en.class_id = p_class)
  ),
  cells as (
    select p.exam_id, st.student_id, st.class_id, p.subject_id, p.max_marks, p.pass_marks, m.marks, coalesce(m.is_absent, false) as is_absent,
           (m.id is not null) as has
    from st join public.exam_papers p on p.class_id = st.class_id and p.academic_session_id = w.session_id and p.school_id = p_school
    left join public.exam_marks m on m.paper_id = p.id and m.student_id = st.student_id
  ),
  results as (   -- one row per student per exam, as report cards compute it
    select exam_id, student_id, class_id, count(*) as papers, count(*) filter (where has) as entered,
           count(*) filter (where has and (is_absent or marks < pass_marks)) as failed,
           case when count(*) = count(*) filter (where has) then round(coalesce(sum(marks), 0) * 100 / sum(max_marks), 2) end as pct
    from cells group by exam_id, student_id, class_id
  ),
  sel as (select * from results where exam_id = v_exam),
  exams_list as (
    select x.id, x.name, x.status, min(p.exam_date) as first_date,
           exists (select 1 from public.exam_marks m join public.exam_papers pp on pp.id = m.paper_id where pp.exam_id = x.id) as has_marks
    from public.exams x left join public.exam_papers p on p.exam_id = x.id and (p_class is null or p.class_id = p_class)
    where x.school_id = p_school and x.academic_session_id = w.session_id
    group by x.id
  )
  select jsonb_build_object(
    'exams', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'status', status, 'first_date', first_date, 'has_marks', has_marks)
        order by first_date nulls last, lower(name)) from exams_list), '[]'),
    'exam_id', v_exam,
    'exam_name', (select name from public.exams where id = v_exam),
    'students', (select count(*) from sel),
    'complete', (select count(*) from sel where pct is not null),
    'incomplete', (select count(*) from sel where pct is null),
    'average_percent', (select round(avg(pct), 1) from sel where pct is not null),
    'passed', (select count(*) from sel where pct is not null and failed = 0),
    'failed', (select count(*) from sel where pct is not null and failed > 0),
    'pass_rate', (select round(100.0 * count(*) filter (where failed = 0) / nullif(count(*), 0), 1) from sel where pct is not null),
    'by_class', coalesce((select jsonb_agg(jsonb_build_object('class_id', c.id, 'class', c.name, 'students', x.n, 'average_percent', x.avg_pct,
        'pass_rate', x.rate) order by c.display_order, lower(c.name)) from (
        select class_id, count(*) as n, round(avg(pct), 1) as avg_pct,
               round(100.0 * count(*) filter (where failed = 0) / nullif(count(*), 0), 1) as rate
        from sel where pct is not null group by class_id) x join public.classes c on c.id = x.class_id), '[]'),
    'by_subject', coalesce((select jsonb_agg(jsonb_build_object('subject_id', sub.id, 'subject', sub.name, 'average_percent', x.avg_pct,
        'pass_rate', x.rate, 'sat', x.sat, 'absent', x.absent) order by lower(sub.name)) from (
        select subject_id, round(100.0 * sum(marks) filter (where has and not is_absent) / nullif(sum(max_marks) filter (where has and not is_absent), 0), 1) as avg_pct,
               round(100.0 * count(*) filter (where has and not is_absent and marks >= pass_marks) / nullif(count(*) filter (where has), 0), 1) as rate,
               count(*) filter (where has and not is_absent) as sat, count(*) filter (where is_absent) as absent
        from cells where exam_id = v_exam group by subject_id) x join public.subjects sub on sub.id = x.subject_id), '[]'),
    'grades', coalesce((select jsonb_agg(jsonb_build_object('grade', g.grade, 'min_percent', g.min_percentage,
        'students', (select count(*) from sel where pct is not null and private.grade_for(p_school, pct) = g.grade)) order by g.min_percentage desc)
        from public.grade_bands g where g.school_id = p_school), '[]'),
    'trend', coalesce((select jsonb_agg(jsonb_build_object('exam_id', el.id, 'exam', el.name, 'average_percent', t.avg_pct, 'pass_rate', t.rate,
        'students', t.n) order by el.first_date nulls last, lower(el.name)) from exams_list el join (
        select exam_id, count(*) as n, round(avg(pct), 1) as avg_pct, round(100.0 * count(*) filter (where failed = 0) / nullif(count(*), 0), 1) as rate
        from results where pct is not null group by exam_id) t on t.exam_id = el.id), '[]'))
  into k_perf;

  out := jsonb_build_object(
    'session', jsonb_build_object('id', w.session_id, 'name', w.session_name, 'start_date', w.start_date, 'end_date', w.end_date),
    'window', jsonb_build_object('from', w.win_from, 'to', w.win_to),
    'enrollment', k_enrolled, 'strength', k_strength, 'attendance', k_att, 'performance', k_perf);
  return out;
end $$;

-- =====================================================================
-- Fees: collection, pending, by class, payment method, outstanding over time
-- (call private.analytics_sync_dues first, so dues follow the fee structures)
-- =====================================================================

-- School-wide "bring dues up to date" for the fee office (dashboard, fee collection list, reports).
-- private.sync_student_dues runs as the signed-in user, and row-level security on every due it reads
-- made it very slow for whole schools (3 min 6 s for 1,500 students; 0.85 s as owner). What is due
-- follows only from the fee structures and opt-ins, never from who asks, so this runs it as the
-- owner — but only for that school's admins and accountants (or the super admin), and only for
-- that school's enrollments. Anyone else could not change dues anyway (RLS), so for them it does
-- nothing, exactly as before.
create or replace function private.sync_school_dues(p_school uuid, p_enrollment_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if p_school is null or not (private.is_super_admin()
     or private.has_school_role(p_school, array['school_admin', 'accountant']::public.app_role[])) then
    return;
  end if;
  select coalesce(array_agg(e.id), '{}') into v_ids from public.student_enrollments e
  where e.school_id = p_school and e.id = any (p_enrollment_ids);
  perform private.sync_student_dues(v_ids);
end $$;

-- Brings the session's dues in line with the fee structures before the fee figures are read.
-- Same rule as everywhere else (private.sync_student_dues: what is due follows only from the fee
-- structures and opt-ins, never from who asks), run as the owner after the same role check as the
-- fee analytics: as the signed-in user, row-level security made it ~14x slower (7 s for 69 students).
create or replace function private.analytics_sync_dues(p_school uuid, p_session uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  perform private.analytics_access(p_school, 'fees');
  select coalesce(array_agg(e.id), '{}') into v_ids from public.student_enrollments e
  where e.school_id = p_school and e.academic_session_id = p_session;
  perform private.sync_student_dues(v_ids);
end $$;

create or replace function private.analytics_fees(p_school uuid, p_session uuid, p_class uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $$
declare w record; prev record; v_today date := private.ist_today(); v_month date := date_trunc('month', private.ist_today())::date; out jsonb;
begin
  perform private.analytics_access(p_school, 'fees');
  select * into w from private.analytics_window(p_school, p_session, p_from, p_to);
  if w.session_id is null then return null; end if;
  select a.id, a.name, a.start_date into prev from public.academic_sessions a
  where a.school_id = p_school and a.start_date < w.start_date order by a.start_date desc limit 1;

  with en as (
    select e.id, e.class_id from public.student_enrollments e
    where e.school_id = p_school and e.academic_session_id = w.session_id and (p_class is null or e.class_id = p_class)
  ),
  dues as (   -- every due of the session with what has been paid against it so far
    select d.id, d.enrollment_id, en.class_id, d.fee_head_id, d.due_month, d.amount,
           coalesce((select sum(a.amount) from public.fee_payment_allocations a where a.due_id = d.id), 0) as paid
    from public.student_fee_dues d join en on en.id = d.enrollment_id
  ),
  pay as (   -- receipts in the window
    select fp.id, fp.amount, fp.payment_date, fp.payment_mode, fp.cancelled_at, en.class_id
    from public.fee_payments fp join en on en.id = fp.enrollment_id
    where fp.school_id = p_school and fp.academic_session_id = w.session_id and fp.payment_date between w.win_from and w.win_to
  ),
  months as (
    select m::date as month from generate_series(date_trunc('month', w.start_date), date_trunc('month', w.end_date), interval '1 month') m
  ),
  prev_pay as (   -- the previous session, month by month, for comparison
    select extract(year from age(date_trunc('month', fp.payment_date), date_trunc('month', prev.start_date))) * 12
             + extract(month from age(date_trunc('month', fp.payment_date), date_trunc('month', prev.start_date))) as idx,
           sum(fp.amount) as amount
    from public.fee_payments fp join public.student_enrollments e on e.id = fp.enrollment_id
    where prev.id is not null and fp.school_id = p_school and fp.academic_session_id = prev.id and fp.cancelled_at is null
      and (p_class is null or e.class_id = p_class)
    group by 1
  )
  select jsonb_build_object(
    'session', jsonb_build_object('id', w.session_id, 'name', w.session_name, 'start_date', w.start_date, 'end_date', w.end_date),
    'previous_session', case when prev.id is null then null else jsonb_build_object('id', prev.id, 'name', prev.name) end,
    'window', jsonb_build_object('from', w.win_from, 'to', w.win_to),
    'kpis', jsonb_build_object(
      'collected', (select coalesce(sum(amount), 0) from pay where cancelled_at is null),
      'receipts', (select count(*) from pay where cancelled_at is null),
      'cancelled', (select coalesce(sum(amount), 0) from pay where cancelled_at is not null),
      'cancelled_receipts', (select count(*) from pay where cancelled_at is not null),
      'billed', (select coalesce(sum(amount), 0) from dues),
      'due_to_date', (select coalesce(sum(amount), 0) from dues where due_month <= v_month),
      'paid_to_date', (select coalesce(sum(paid), 0) from dues where due_month <= v_month),
      'collection_rate', (select round(100.0 * sum(paid) / nullif(sum(amount), 0), 1) from dues where due_month <= v_month),
      'outstanding', (select coalesce(sum(amount - paid), 0) from dues),
      'overdue', (select coalesce(sum(amount - paid), 0) from dues where due_month <= v_month),
      'students_with_dues', (select count(distinct enrollment_id) from dues where due_month <= v_month and amount > paid)),
    'monthly', (select jsonb_agg(jsonb_build_object('month', mo.month,
        'collected', coalesce((select sum(amount) from pay where cancelled_at is null and date_trunc('month', payment_date) = mo.month), 0),
        'receipts', (select count(*) from pay where cancelled_at is null and date_trunc('month', payment_date) = mo.month),
        'previous', case when prev.id is null then null else coalesce((select sum(pp.amount) from prev_pay pp
          where pp.idx = extract(year from age(mo.month, date_trunc('month', w.start_date))) * 12
                       + extract(month from age(mo.month, date_trunc('month', w.start_date)))), 0) end,
        'in_window', mo.month between date_trunc('month', w.win_from) and date_trunc('month', w.win_to)) order by mo.month) from months mo),
    'by_class', coalesce((select jsonb_agg(jsonb_build_object('class_id', c.id, 'class', c.name, 'collected', coalesce(x.collected, 0),
        'billed', coalesce(y.billed, 0), 'due_to_date', coalesce(y.due, 0), 'outstanding', coalesce(y.outstanding, 0),
        'overdue', coalesce(y.overdue, 0), 'collection_rate', y.rate) order by c.display_order, lower(c.name))
        from public.classes c
        left join (select class_id, sum(amount) as collected from pay where cancelled_at is null group by class_id) x on x.class_id = c.id
        left join (select class_id, sum(amount) as billed, sum(amount) filter (where due_month <= v_month) as due,
                     sum(amount - paid) as outstanding, sum(amount - paid) filter (where due_month <= v_month) as overdue,
                     round(100.0 * sum(paid) filter (where due_month <= v_month) / nullif(sum(amount) filter (where due_month <= v_month), 0), 1) as rate
                   from dues group by class_id) y on y.class_id = c.id
        where c.school_id = p_school and (x.class_id is not null or y.class_id is not null)), '[]'),
    'by_method', coalesce((select jsonb_agg(jsonb_build_object('method', mode, 'amount', amt, 'receipts', n) order by amt desc) from (
        select payment_mode::text as mode, sum(amount) as amt, count(*) as n from pay where cancelled_at is null group by payment_mode) t), '[]'),
    'online_methods', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'amount', amt, 'receipts', n) order by amt desc) from (
        select coalesce(nullif(o.method, ''), 'unknown') as method, sum(p.amount) as amt, count(*) as n
        from pay p join public.online_payments o on o.fee_payment_id = p.id
        where p.cancelled_at is null and p.payment_mode = 'online' group by 1) t), '[]'),
    'by_head', coalesce((select jsonb_agg(jsonb_build_object('fee_head', h.name, 'billed', x.billed, 'outstanding', x.outstanding, 'overdue', x.overdue)
        order by x.outstanding desc, lower(h.name)) from (
        select fee_head_id, sum(amount) as billed, sum(amount - paid) as outstanding, sum(amount - paid) filter (where due_month <= v_month) as overdue
        from dues group by fee_head_id) x join public.fee_heads h on h.id = x.fee_head_id), '[]'),
    'aging', jsonb_build_array(   -- unpaid dues by how late they are (months after the due month)
        jsonb_build_object('bucket', 'Due this month', 'amount', (select coalesce(sum(amount - paid), 0) from dues where due_month = v_month)),
        jsonb_build_object('bucket', '1 month late', 'amount', (select coalesce(sum(amount - paid), 0) from dues where due_month = (v_month - interval '1 month')::date)),
        jsonb_build_object('bucket', '2 months late', 'amount', (select coalesce(sum(amount - paid), 0) from dues where due_month = (v_month - interval '2 months')::date)),
        jsonb_build_object('bucket', '3+ months late', 'amount', (select coalesce(sum(amount - paid), 0) from dues where due_month <= (v_month - interval '3 months')::date)),
        jsonb_build_object('bucket', 'Not yet due', 'amount', (select coalesce(sum(amount - paid), 0) from dues where due_month > v_month))),
    -- what was owed and unpaid at the end of each month: dues due by then, less what receipts dated by then
    -- paid against them (receipts later cancelled don't count; amounts as the dues stand today)
    'outstanding_trend', (select jsonb_agg(jsonb_build_object('month', mo.month,
        'due', coalesce((select sum(amount) from dues where due_month <= mo.month), 0),
        'outstanding', coalesce((select sum(d.amount) from dues d where d.due_month <= mo.month), 0)
          - coalesce((select sum(a.amount) from public.fee_payment_allocations a join dues d on d.id = a.due_id
                      join public.fee_payments fp on fp.id = a.payment_id
                      where d.due_month <= mo.month and fp.cancelled_at is null
                        and fp.payment_date <= (mo.month + interval '1 month' - interval '1 day')::date), 0))
        order by mo.month) from months mo where mo.month <= v_month)
  ) into out;
  return out;
end $$;

-- =====================================================================
-- Admissions: enquiries, applications, conversion, admissions
-- =====================================================================
create or replace function private.analytics_admissions(p_school uuid, p_session uuid, p_class uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' set jit = off as $$
declare w record; v_today date := private.ist_today(); out jsonb;
begin
  perform private.analytics_access(p_school, 'admissions');
  select * into w from private.analytics_window(p_school, p_session, p_from, p_to);
  if w.session_id is null then return null; end if;
  -- admissions season runs before the session starts: the window here is the date range asked for,
  -- else everything for this session whatever its date
  with q as (
    select e.* from public.admission_enquiries e
    where e.school_id = p_school and e.academic_session_id = w.session_id and (p_class is null or e.class_id = p_class)
      and (p_from is null or e.enquiry_date >= p_from) and (p_to is null or e.enquiry_date <= p_to)
  ),
  ap as (
    select a.*, (a.submitted_at at time zone 'Asia/Kolkata')::date as submitted_on from public.admission_applications a
    where a.school_id = p_school and a.academic_session_id = w.session_id and (p_class is null or a.class_id = p_class)
      and (p_from is null or (a.submitted_at at time zone 'Asia/Kolkata')::date >= p_from)
      and (p_to is null or (a.submitted_at at time zone 'Asia/Kolkata')::date <= p_to)
  ),
  newst as (   -- students admitted to the school in this session (first enrollment), and how
    select f.student_id, f.class_id, f.admission_date,
           exists (select 1 from public.admission_applications x where x.student_id = f.student_id and x.status = 'enrolled') as online
    from private.analytics_first_enrollments(p_school) f
    where f.academic_session_id = w.session_id and (p_class is null or f.class_id = p_class)
      and (p_from is null or f.admission_date >= p_from) and (p_to is null or f.admission_date <= p_to)
  ),
  span as (
    select date_trunc('month', least(
             coalesce((select min(enquiry_date) from q), w.start_date), coalesce((select min(submitted_on) from ap), w.start_date),
             coalesce((select min(admission_date) from newst), w.start_date), coalesce(p_from, w.start_date)))::date as m0,
           date_trunc('month', least(greatest(
             coalesce((select max(enquiry_date) from q), w.start_date), coalesce((select max(submitted_on) from ap), w.start_date),
             coalesce((select max(admission_date) from newst), w.start_date)), coalesce(p_to, v_today), v_today))::date as m1
  ),
  months as (select m::date as month from span, generate_series(span.m0, span.m1, interval '1 month') m)
  select jsonb_build_object(
    'session', jsonb_build_object('id', w.session_id, 'name', w.session_name, 'start_date', w.start_date, 'end_date', w.end_date),
    'window', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', jsonb_build_object(
      'enquiries', (select count(*) from q),
      'enquiries_to_application', (select count(*) from q where application_id is not null or status in ('application', 'approved', 'admitted')),
      'enquiries_admitted', (select count(*) from q where status = 'admitted'),
      'enquiries_open', (select count(*) from q where status not in ('admitted', 'rejected')),
      'follow_ups_overdue', (select count(*) from q where status not in ('admitted', 'rejected') and follow_up_date < v_today),
      'applications', (select count(*) from ap),
      'applications_pending', (select count(*) from ap where status in ('submitted', 'under_review', 'verified')),
      'applications_approved', (select count(*) from ap where status in ('approved', 'fee_paid', 'enrolled')),
      'applications_rejected', (select count(*) from ap where status = 'rejected'),
      'applications_enrolled', (select count(*) from ap where status = 'enrolled'),
      'admissions', (select count(*) from newst),
      'admissions_online', (select count(*) from newst where online),
      'admissions_direct', (select count(*) from newst where not online),
      'enquiry_conversion', (select round(100.0 * count(*) filter (where status = 'admitted') / nullif(count(*), 0), 1) from q),
      'application_conversion', (select round(100.0 * count(*) filter (where status = 'enrolled') / nullif(count(*), 0), 1) from ap)),
    'monthly', coalesce((select jsonb_agg(jsonb_build_object('month', mo.month,
        'enquiries', (select count(*) from q where date_trunc('month', enquiry_date) = mo.month),
        'applications', (select count(*) from ap where date_trunc('month', submitted_on) = mo.month),
        'admissions', (select count(*) from newst where date_trunc('month', admission_date) = mo.month)) order by mo.month) from months mo), '[]'),
    'enquiry_funnel', jsonb_build_array(
        jsonb_build_object('stage', 'Enquiries', 'count', (select count(*) from q)),
        jsonb_build_object('stage', 'Applied', 'count', (select count(*) from q where application_id is not null or status in ('application', 'approved', 'admitted'))),
        jsonb_build_object('stage', 'Approved', 'count', (select count(*) from q where status in ('approved', 'admitted'))),
        jsonb_build_object('stage', 'Admitted', 'count', (select count(*) from q where status = 'admitted'))),
    'application_funnel', jsonb_build_array(
        jsonb_build_object('stage', 'Applied', 'count', (select count(*) from ap)),
        jsonb_build_object('stage', 'Verified', 'count', (select count(*) from ap where verified_at is not null or status in ('verified', 'approved', 'fee_paid', 'enrolled'))),
        jsonb_build_object('stage', 'Approved', 'count', (select count(*) from ap where status in ('approved', 'fee_paid', 'enrolled'))),
        jsonb_build_object('stage', 'Enrolled', 'count', (select count(*) from ap where status = 'enrolled'))),
    'by_source', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'enquiries', n, 'admitted', adm,
        'conversion', round(100.0 * adm / nullif(n, 0), 1)) order by n desc, source) from (
        select source::text, count(*) as n, count(*) filter (where status = 'admitted') as adm from q group by source) t), '[]'),
    'by_status', coalesce((select jsonb_agg(jsonb_build_object('status', s.st, 'enquiries', (select count(*) from q where status::text = s.st)) order by s.ord)
        from unnest(array['new', 'contacted', 'follow_up', 'interested', 'application', 'approved', 'rejected', 'admitted']) with ordinality s(st, ord)), '[]'),
    'application_status', coalesce((select jsonb_agg(jsonb_build_object('status', s.st, 'applications', (select count(*) from ap where status::text = s.st)) order by s.ord)
        from unnest(array['submitted', 'under_review', 'verified', 'approved', 'fee_paid', 'enrolled', 'rejected']) with ordinality s(st, ord)), '[]'),
    'by_class', coalesce((select jsonb_agg(jsonb_build_object('class_id', c.id, 'class', c.name,
        'enquiries', (select count(*) from q where class_id = c.id), 'applications', (select count(*) from ap where class_id = c.id),
        'admissions', (select count(*) from newst where class_id = c.id)) order by c.display_order, lower(c.name))
        from public.classes c where c.school_id = p_school and c.deleted_at is null and (p_class is null or c.id = p_class)
          and (exists (select 1 from q where class_id = c.id) or exists (select 1 from ap where class_id = c.id) or exists (select 1 from newst where class_id = c.id))), '[]')
  ) into out;
  return out;
end $$;

revoke all on function private.analytics_sync_dues(uuid, uuid), private.sync_school_dues(uuid, uuid[]) from public, anon;
grant execute on function private.analytics_sync_dues(uuid, uuid), private.sync_school_dues(uuid, uuid[]) to authenticated;
revoke all on function private.analytics_access(uuid, text), private.analytics_window(uuid, uuid, date, date),
  private.analytics_first_enrollments(uuid), private.analytics_students(uuid, uuid, uuid, date, date, uuid),
  private.analytics_fees(uuid, uuid, uuid, date, date), private.analytics_admissions(uuid, uuid, uuid, date, date)
  from public, anon, authenticated;
grant execute on function private.analytics_students(uuid, uuid, uuid, date, date, uuid), private.analytics_fees(uuid, uuid, uuid, date, date),
  private.analytics_admissions(uuid, uuid, uuid, date, date) to authenticated;

-- receipts by session (the fee charts read them per session and month)
create index if not exists fee_payments_session_date_idx on public.fee_payments (academic_session_id, payment_date) where cancelled_at is null;
create index if not exists fee_payment_allocations_due_idx on public.fee_payment_allocations (due_id);
create index if not exists attendance_session_date_idx on public.attendance_records (academic_session_id, attendance_date);
