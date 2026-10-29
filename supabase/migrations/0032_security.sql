-- =====================================================================
-- 0032: security — complete audit trail, append-only audit log, tighter privileges,
-- receipt reversal, and server-side session checks.
--
-- 1. audit_logs records who (and their email at the time), which school, what, on which record,
--    when, from which IP and browser, and details. It is append-only: no one changes or removes
--    a row (a deleted school or user only blanks the link, as before).
-- 2. Sensitive data changes are recorded BY THE DATABASE, whoever makes them and however (the
--    API, a script, the SQL editor, Supabase's REST API): students, enrollments, receipts
--    (recorded, cancelled), attendance changes, school memberships (people added, roles, sign-ins
--    turned off/on), schools, accounts (created, platform-admin rights). Updates record only the
--    columns that changed, as from → to.
-- 3. Sign-ins and sign-outs come from Supabase Auth itself (auth.sessions), with the IP and
--    browser Supabase saw; password and email changes from auth.users. Where a project can't
--    add those triggers, the app reports sign-in/out through the API instead (deduplicated).
-- 4. Payroll entries in the audit log are readable only by that school's payroll admins — not
--    by the platform super admin (salaries stay with the school, as in 0025).
-- 5. Signed-in users lose TRUNCATE, REFERENCES and TRIGGER on every table (TRUNCATE ignores RLS),
--    and direct INSERT on receipts (receipts are made only by private.record_fee_payment).
-- 6. A school admin can cancel (reverse) a receipt with a reason; it is never deleted.
-- 7. private.session_active: the API refuses a token whose sign-in session has ended (signed
--    out, or ended by an admin), instead of trusting it until it expires.
-- =====================================================================

-- ---------------------------------------------------------------- 1. the audit log
alter table public.audit_logs
  add column actor_label text,                                   -- who, as they were known at the time
  add column source text not null default 'api' check (source in ('api', 'database', 'auth', 'app'));
create index audit_logs_action_created_idx on public.audit_logs (action, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_session_idx on public.audit_logs (actor_id, action, (metadata ->> 'session_id'));
comment on column public.audit_logs.source is
  'api: written by the API with the request; database: a data change recorded by a trigger; auth: Supabase Auth (sign-in, sign-out, password); app: sign-in/out reported by the app where Auth triggers are unavailable';

-- who is acting: the signed-in person, or the service doing the work
create or replace function private.audit_actor_label(p_actor uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select coalesce(nullif(p.email, ''), p.full_name) from public.profiles p where p.id = p_actor),
    case current_setting('role', true)
      when 'erp_payments' then 'Online payment (Razorpay)'
      when 'erp_billing' then 'Subscription billing'
      when 'erp_notify' then 'Notification sender'
      else case when p_actor is null then 'System' end
    end);
$$;

create or replace function private.write_audit_log(
  p_school_id uuid, p_action text, p_entity_type text, p_entity_id text,
  p_metadata jsonb, p_ip text, p_user_agent text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  -- an entry can only be written into a school the caller belongs to (or by the platform admin)
  if p_school_id is not null and (select auth.uid()) is not null and not private.is_member_any(p_school_id) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  insert into public.audit_logs (school_id, actor_id, actor_label, action, entity_type, entity_id, metadata, ip_address, user_agent, source)
  values (p_school_id, (select auth.uid()), private.audit_actor_label((select auth.uid())), p_action, p_entity_type, p_entity_id,
          coalesce(p_metadata, '{}'::jsonb),
          left(coalesce(p_ip, nullif(current_setting('app.client_ip', true), '')), 64),
          left(coalesce(p_user_agent, nullif(current_setting('app.user_agent', true), '')), 500), 'api');
end $$;

-- append-only: no edits, no deletions. The only change allowed is the one a foreign key makes when a
-- school or account is deleted (the link is blanked; the row and its details stay).
create or replace function private.audit_logs_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'school_id' - 'actor_id') = (to_jsonb(old) - 'school_id' - 'actor_id')
     and (new.school_id is null or new.school_id = old.school_id)
     and (new.actor_id is null or new.actor_id = old.actor_id) then
    return new;
  end if;
  raise exception 'The audit log can''t be changed or deleted.' using errcode = 'insufficient_privilege';
end $$;
create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function private.audit_logs_append_only();
-- (TRUNCATE is revoked from every user role below; table owners are trusted operators)

-- read: a school's admins see their school's entries; payroll entries only its payroll admins;
-- the platform super admin sees everything else, including platform-level entries (no school)
drop policy audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (
    case
      when school_id is null then (select private.is_super_admin())
      when action like 'payroll.%' then private.is_payroll_admin(school_id)
      else (select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[])
    end
  );

-- ---------------------------------------------------------------- 2. data changes, recorded by the database
-- tg_argv[0] = resource name; tg_argv[1] = columns not worth recording (e.g. updated_at)
create or replace function private.audit_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_res text := tg_argv[0];
  v_skip text[] := coalesce(nullif(tg_argv[1], '')::text[], '{}');
  v_old jsonb; v_new jsonb; v_row jsonb; v_changes jsonb := '{}'; k text;
  v_action text; v_school uuid; v_meta jsonb; v_actor uuid := (select auth.uid());
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old) - v_skip; end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new) - v_skip; end if;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(v_new) loop
      if (v_new -> k) is distinct from (v_old -> k) then
        v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k));
      end if;
    end loop;
    if v_changes = '{}'::jsonb then return null; end if;   -- nothing that matters changed
    v_meta := jsonb_build_object('changes', v_changes);
  else
    v_meta := jsonb_build_object('record', v_row);
  end if;

  v_action := v_res || case tg_op when 'INSERT' then '.created' when 'UPDATE' then '.updated' else '.deleted' end;
  -- clearer names for the changes people look for
  if v_res = 'fee_payment' then
    if tg_op = 'INSERT' then v_action := 'fee_payment.recorded';
    elsif tg_op = 'UPDATE' and v_changes ? 'cancelled_at' and (v_new ->> 'cancelled_at') is not null then v_action := 'fee_payment.cancelled';
    end if;
  elsif v_res = 'attendance' and tg_op = 'UPDATE' then
    v_action := 'attendance.changed';
  elsif v_res = 'membership' and tg_op = 'UPDATE' then
    v_action := case
      when v_changes ? 'role' then 'membership.role_changed'
      when v_changes ? 'status' and v_new ->> 'status' = 'active' then 'membership.enabled'
      when v_changes ? 'status' then 'membership.disabled'
      else 'membership.updated' end;
  elsif v_res = 'school' and tg_op = 'UPDATE' and v_changes ? 'status' then
    v_action := case when v_new ->> 'status' = 'active' then 'school.activated' else 'school.deactivated' end;
  elsif v_res = 'user' and tg_op = 'UPDATE' and v_changes ? 'is_super_admin' then
    v_action := case when (v_new ->> 'is_super_admin')::boolean then 'user.super_admin_granted' else 'user.super_admin_removed' end;
  end if;

  -- something a person recognises the record by
  v_meta := v_meta || jsonb_build_object('label', case v_res
    when 'student' then v_row ->> 'full_name'
    when 'enrollment' then v_row ->> 'admission_number'
    when 'fee_payment' then v_row ->> 'receipt_number'
    when 'attendance' then (v_row ->> 'attendance_date')
    when 'membership' then (select p.email from public.profiles p where p.id = (v_row ->> 'user_id')::uuid) || ' (' || (v_row ->> 'role') || ')'
    when 'school' then v_row ->> 'name'
    when 'user' then v_row ->> 'email'
  end);
  if v_res in ('attendance', 'fee_payment', 'enrollment') then
    v_meta := v_meta || jsonb_build_object('student', (select st.full_name from public.students st where st.id = (v_row ->> 'student_id')::uuid));
  end if;

  v_school := case when v_res = 'school' then (v_row ->> 'id')::uuid else (v_row ->> 'school_id')::uuid end;
  -- a school being deleted takes its rows with it: record the school's own deletion only
  if tg_op = 'DELETE' and v_res <> 'school' and not exists (select 1 from public.schools where id = v_school) then
    return null;
  end if;

  insert into public.audit_logs (school_id, actor_id, actor_label, action, entity_type, entity_id, metadata, ip_address, user_agent, source)
  values (case when tg_op = 'DELETE' and v_res = 'school' then null else v_school end,
          v_actor, private.audit_actor_label(v_actor), v_action, tg_table_name, v_row ->> 'id',
          case when tg_op = 'DELETE' and v_res = 'school' then v_meta || jsonb_build_object('school_id', v_school) else v_meta end,
          left(nullif(current_setting('app.client_ip', true), ''), 64),
          left(nullif(current_setting('app.user_agent', true), ''), 500), 'database');
  return null;
end $$;

create trigger students_audit after insert or update or delete on public.students
  for each row execute function private.audit_change('student', '{updated_at,created_at}');
create trigger student_enrollments_audit after update or delete on public.student_enrollments
  for each row execute function private.audit_change('enrollment', '{updated_at,created_at}');
create trigger fee_payments_audit after insert or update or delete on public.fee_payments
  for each row execute function private.audit_change('fee_payment', '{idempotency_key,created_at}');
-- attendance: the first marking of a day is recorded by the API (one entry per class); changes and removals here, per student
create trigger attendance_records_audit after update or delete on public.attendance_records
  for each row execute function private.audit_change('attendance', '{updated_at,updated_by,created_at,marked_by}');
create trigger school_memberships_audit after insert or update or delete on public.school_memberships
  for each row execute function private.audit_change('membership', '{updated_at,created_at}');
create trigger schools_audit after insert or update or delete on public.schools
  for each row execute function private.audit_change('school', '{updated_at,created_at,logo_url}');
create trigger profiles_audit_created after insert on public.profiles
  for each row execute function private.audit_change('user', '{updated_at,created_at,avatar_url}');
create trigger profiles_audit_admin after update of is_super_admin, email on public.profiles
  for each row execute function private.audit_change('user', '{updated_at,created_at,avatar_url,full_name,phone}');

-- ---------------------------------------------------------------- 3. sign-in, sign-out, passwords
-- One entry per school the person belongs to (so each school's admins see their own people's
-- sign-ins and nothing of other schools), or one platform-level entry for someone in no school.
-- Deduplicated by session: whichever of Auth (trigger) or the app (API) reports first is kept.
create or replace function private.audit_auth_event(
  p_user uuid, p_action text, p_session text, p_ip text, p_ua text, p_source text, p_meta jsonb default '{}'
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_label text; v_n integer := 0; s record;
begin
  if p_user is null then return false; end if;
  if p_session is not null and exists (select 1 from public.audit_logs
       where action = p_action and actor_id = p_user and metadata ->> 'session_id' = p_session) then
    return false;
  end if;
  v_label := private.audit_actor_label(p_user);
  for s in select distinct m.school_id from public.school_memberships m where m.user_id = p_user and m.status = 'active' loop
    insert into public.audit_logs (school_id, actor_id, actor_label, action, entity_type, entity_id, metadata, ip_address, user_agent, source)
    values (s.school_id, p_user, v_label, p_action, 'session', p_session,
            coalesce(p_meta, '{}') || jsonb_build_object('session_id', p_session), left(p_ip, 64), left(p_ua, 500), p_source);
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    insert into public.audit_logs (school_id, actor_id, actor_label, action, entity_type, entity_id, metadata, ip_address, user_agent, source)
    values (null, p_user, v_label, p_action, 'session', p_session,
            coalesce(p_meta, '{}') || jsonb_build_object('session_id', p_session), left(p_ip, 64), left(p_ua, 500), p_source);
  end if;
  return true;
end $$;

-- the API's fallback, for the signed-in person only (their identity comes from the verified JWT)
create or replace function private.audit_my_session_event(p_event text, p_ip text, p_ua text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_sid text := (select auth.jwt()) ->> 'session_id';
begin
  if p_event not in ('login', 'logout') then raise exception 'Unknown event.' using errcode = '22023'; end if;
  return private.audit_auth_event((select auth.uid()), 'auth.' || p_event, v_sid, p_ip, p_ua, 'app');
end $$;

create or replace function private.audit_auth_session() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  perform private.audit_auth_event((r ->> 'user_id')::uuid,
    case tg_op when 'INSERT' then 'auth.login' else 'auth.logout' end, r ->> 'id',
    host((r ->> 'ip')::inet), r ->> 'user_agent', 'auth',
    case when tg_op = 'DELETE' then jsonb_build_object('signed_in_at', r ->> 'created_at') else jsonb_build_object('aal', r ->> 'aal') end);
  return null;
exception when others then
  return null;   -- auditing must never stop someone signing in or out
end $$;

create or replace function private.audit_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    perform private.audit_auth_event(new.id, 'auth.password_changed', null, null, null, 'auth');
  end if;
  if new.email is distinct from old.email then
    perform private.audit_auth_event(new.id, 'auth.email_changed', null, null, null, 'auth',
      jsonb_build_object('from', old.email, 'to', new.email));
  end if;
  return null;
exception when others then
  return null;
end $$;

-- Supabase allows triggers on auth.sessions and auth.users (functions stay in our schema). If a
-- project doesn't, the app's fallback (private.audit_my_session_event) still records sign-in/out.
do $$ begin
  if to_regclass('auth.sessions') is not null then
    begin
      execute 'drop trigger if exists erp_audit_sessions on auth.sessions';
      execute 'create trigger erp_audit_sessions after insert or delete on auth.sessions for each row execute function private.audit_auth_session()';
    exception when insufficient_privilege then
      raise notice 'Could not add the sign-in audit trigger on auth.sessions; the app will report sign-ins instead.';
    end;
  end if;
  begin
    execute 'drop trigger if exists erp_audit_users on auth.users';
    execute 'create trigger erp_audit_users after update of encrypted_password, email on auth.users for each row execute function private.audit_auth_user()';
  exception when insufficient_privilege then
    raise notice 'Could not add the password-change audit trigger on auth.users.';
  end;
end $$;

-- ---------------------------------------------------------------- 4. sessions that have ended
-- true: the token's session is live; false: it has ended (signed out, or ended by an admin);
-- null: this database can't tell (no auth.sessions) — the API then relies on the token's expiry.
create or replace function private.session_active(p_session text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare v boolean;
begin
  if to_regclass('auth.sessions') is null then return null; end if;
  if p_session is null or p_session !~ '^[0-9a-fA-F-]{36}$' then return false; end if;
  execute 'select exists (select 1 from auth.sessions s where s.id = $1 and s.user_id = $2
             and coalesce((to_jsonb(s) ->> ''not_after'')::timestamptz, ''infinity'') > now())'
    into v using p_session::uuid, (select auth.uid());
  return v;
exception when insufficient_privilege then
  return null;
end $$;

-- ---------------------------------------------------------------- 5. privileges
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t.tablename);
  end loop;
end $$;
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;
-- receipts are made only through private.record_fee_payment (now a definer function that checks who is
-- asking itself, instead of relying on table grants) and the payment gateway's functions
create or replace function private.record_fee_payment(
  p_enrollment_id uuid, p_payment_date date, p_mode public.payment_mode, p_reference text, p_remarks text,
  p_idempotency_key uuid, p_allocations jsonb
) returns table (payment_id uuid, receipt_number text, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
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
  -- who may record a receipt: the school's admins and accountants, the platform admin, or the payment
  -- gateway's role after the API verified a payment with Razorpay (private.pay_apply)
  if not found or not (private.is_super_admin()
                       or private.has_school_role(v_enr.school_id, array['school_admin', 'accountant']::public.app_role[])
                       or current_setting('role', true) = 'erp_payments') then
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
revoke insert on public.fee_payments, public.fee_payment_allocations from authenticated;
drop policy if exists payments_insert on public.fee_payments;
drop policy if exists allocations_insert on public.fee_payment_allocations;

-- ---------------------------------------------------------------- 5b. stored file paths stay inside their school
-- Files are read with the storage service key, by the path a row holds. Every path the API writes starts
-- with the row's school id; the database now insists on it (and on no '..'), so a row can't be pointed at
-- another school's file by writing its path directly.
do $$
declare
  c record; v_name text;
begin
  for c in select * from (values
      ('students', 'photo_path', 'school_id'), ('teachers', 'photo_path', 'school_id'),
      ('student_documents', 'file_path', 'school_id'), ('homework_attachments', 'file_path', 'school_id'),
      ('homework_submission_files', 'file_path', 'school_id'), ('transport_documents', 'file_path', 'school_id'),
      ('document_settings', 'signature_path', 'school_id'), ('certificates', 'signature_path', 'school_id'),
      ('report_card_templates', 'principal_signature_path', 'school_id'), ('schools', 'logo_path', 'id')) as t(tbl, col, owner)
  loop
    v_name := c.tbl || '_' || c.col || '_in_school';
    execute format(
      'alter table public.%I add constraint %I check (%I is null or (split_part(%I, ''/'', 1) = %I::text '
      'and %I ~ ''^[0-9a-f-]{36}(/[A-Za-z0-9_.-]+)+$'' and strpos(%I, ''..'') = 0)) not valid',
      c.tbl, v_name, c.col, c.col, c.owner, c.col, c.col);
    begin
      execute format('alter table public.%I validate constraint %I', c.tbl, v_name);
    exception when check_violation then
      raise notice 'public.%.% holds paths outside their school; new writes are checked, existing rows need review', c.tbl, c.col;
    end;
  end loop;
end $$;

-- an application's files are named by the admission form only (under the school's admission code)
create or replace function private.applications_photo_fixed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.photo_path is distinct from old.photo_path then
    raise exception 'An application''s photo can''t be replaced.' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger admission_applications_photo_fixed before update of photo_path on public.admission_applications
  for each row execute function private.applications_photo_fixed();

-- ---------------------------------------------------------------- 6. reversing a receipt
-- A school admin cancels a receipt recorded at the desk (cash, cheque, transfer...) with a reason.
-- It stays on record, marked cancelled, with what it had paid; those dues become payable again.
-- Receipts paid online are reversed by refunding them (Online payments), which cancels them too.
create or replace function private.fee_payment_cancel(p_payment uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.fee_payments;
begin
  select * into r from public.fee_payments where id = p_payment for update;
  if not found or not private.has_school_role(r.school_id, array['school_admin']::public.app_role[]) then
    raise exception 'Receipt not found.' using errcode = 'P0002';
  end if;
  if r.cancelled_at is not null then
    raise exception 'This receipt is already cancelled.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.online_payments o where o.fee_payment_id = r.id) then
    raise exception 'This receipt was paid online: refund it under Online payments, which cancels the receipt.' using errcode = 'check_violation';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'Give the reason for cancelling (at least 5 characters).' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.academic_sessions a where a.id = r.academic_session_id and a.archived_at is not null) then
    raise exception 'That session is archived, so its receipts can''t change.' using errcode = 'check_violation';
  end if;
  update public.fee_payments fp set cancelled_at = now(), cancelled_by = (select auth.uid()),
         cancel_reason = left(btrim(p_reason), 300),
         cancelled_allocations = (select jsonb_agg(jsonb_build_object('due_id', a.due_id, 'amount', a.amount))
                                  from public.fee_payment_allocations a where a.payment_id = fp.id)
  where fp.id = r.id;
  delete from public.fee_payment_allocations where payment_id = r.id;
end $$;

revoke all on function private.audit_actor_label(uuid), private.audit_change(), private.audit_auth_event(uuid, text, text, text, text, text, jsonb),
  private.audit_auth_session(), private.audit_auth_user(), private.audit_logs_append_only(), private.audit_my_session_event(text, text, text),
  private.session_active(text), private.fee_payment_cancel(uuid, text) from public, anon, authenticated;
grant execute on function private.audit_my_session_event(text, text, text), private.session_active(text), private.fee_payment_cancel(uuid, text)
  to authenticated;
grant execute on function private.audit_actor_label(uuid) to erp_payments, erp_billing, erp_notify;
