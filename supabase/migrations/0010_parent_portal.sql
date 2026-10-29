-- =====================================================================
-- Phase 12: parent portal + notices
--   student_guardians  links a parent's account to a student (admins only)
--   is_guardian_of()   the single check every parent policy uses
--   parent RLS         read-only, OWN CHILDREN ONLY: students, enrollments,
--                      attendance, dues, receipts (+ the fee names they are billed for)
--   notices            school notices; parents see those addressed to parents /
--                      everyone, optionally limited to their children's classes
-- =====================================================================

create type public.guardian_relationship as enum ('father', 'mother', 'guardian', 'other');
create type public.notice_audience as enum ('everyone', 'parents', 'staff');

create table public.student_guardians (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references public.schools (id) on delete cascade,
  student_id    uuid not null,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  relationship  public.guardian_relationship not null,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint guardians_student_fkey foreign key (student_id, school_id) references public.students (id, school_id) on delete cascade,
  constraint guardians_one_link unique (student_id, user_id)
);
create index guardians_user_idx on public.student_guardians (user_id);

-- A link is only valid for an account that is a PARENT of that same school.
create or replace function private.guard_guardian_link()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.school_memberships m
                 where m.user_id = new.user_id and m.school_id = new.school_id and m.role = 'parent' and m.status = 'active') then
    raise exception 'That account isn''t a parent in this school.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger guardians_guard before insert or update on public.student_guardians
  for each row execute function private.guard_guardian_link();

-- THE check: is the signed-in user an active parent linked to this student?
create or replace function private.is_guardian_of(p_student_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.student_guardians g
    join public.school_memberships m on m.user_id = g.user_id and m.school_id = g.school_id
                                     and m.role = 'parent' and m.status = 'active'
    join public.schools s on s.id = g.school_id and s.status = 'active'
    where g.student_id = p_student_id and g.user_id = (select auth.uid())
  );
$$;
revoke all on function private.is_guardian_of(uuid) from public, anon;
grant execute on function private.is_guardian_of(uuid) to authenticated;

-- Parents can't write dues; this refreshes their child's dues after checking the link.
create or replace function private.sync_dues_for_guardian(p_student_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ids uuid[];
begin
  if not private.is_guardian_of(p_student_id) then
    raise exception 'Student not found.' using errcode = 'no_data_found';
  end if;
  select coalesce(array_agg(id), '{}') into v_ids from public.student_enrollments where student_id = p_student_id;
  perform private.sync_student_dues(v_ids);
end $$;
revoke all on function private.sync_dues_for_guardian(uuid) from public, anon;
grant execute on function private.sync_dues_for_guardian(uuid) to authenticated;

-- ---------- guardians table access ----------
revoke all on public.student_guardians from anon, authenticated;
grant select, insert, delete on public.student_guardians to authenticated;
alter table public.student_guardians enable row level security;
create policy guardians_select on public.student_guardians for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy guardians_insert on public.student_guardians for insert to authenticated
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));
create policy guardians_delete on public.student_guardians for delete to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- ---------- parent read access: own children only (policies add to the staff ones) ----------
create policy students_select_guardian on public.students for select to authenticated
  using (private.is_guardian_of(id));
create policy enrollments_select_guardian on public.student_enrollments for select to authenticated
  using (private.is_guardian_of(student_id));
create policy attendance_select_guardian on public.attendance_records for select to authenticated
  using (private.is_guardian_of(student_id));
create policy dues_select_guardian on public.student_fee_dues for select to authenticated
  using (private.is_guardian_of(student_id));
create policy payments_select_guardian on public.fee_payments for select to authenticated
  using (private.is_guardian_of(student_id));
create policy allocations_select_guardian on public.fee_payment_allocations for select to authenticated
  using (exists (select 1 from public.fee_payments p
                 where p.id = fee_payment_allocations.payment_id and private.is_guardian_of(p.student_id)));
-- only the fee names / items their own child is billed for
-- (columns are table-qualified: an unqualified "id" here would bind to the dues table)
create policy fee_heads_select_guardian on public.fee_heads for select to authenticated
  using (exists (select 1 from public.student_fee_dues d
                 where d.fee_head_id = fee_heads.id and private.is_guardian_of(d.student_id)));
create policy fee_items_select_guardian on public.fee_structure_items for select to authenticated
  using (exists (select 1 from public.student_fee_dues d
                 where d.fee_item_id = fee_structure_items.id and private.is_guardian_of(d.student_id)));

-- ---------- notices ----------
create table public.notices (
  id          uuid primary key default gen_random_uuid(),
  school_id   uuid not null references public.schools (id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 3 and 150),
  body        text not null check (char_length(btrim(body)) between 1 and 5000),
  audience    public.notice_audience not null default 'everyone',
  class_ids   uuid[] check (class_ids is null or cardinality(class_ids) between 1 and 50),  -- null = all classes
  is_pinned   boolean not null default false,
  publish_at  timestamptz not null default now(),
  expires_at  timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint notices_expiry_after_publish check (expires_at is null or expires_at > publish_at)
);
create index notices_school_publish_idx on public.notices (school_id, publish_at desc);
create trigger notices_updated_at before update on public.notices for each row execute function private.set_updated_at();
create trigger notices_lock_school before update on public.notices for each row execute function private.prevent_school_change();

revoke all on public.notices from anon, authenticated;
grant select, insert, update, delete on public.notices to authenticated;
alter table public.notices enable row level security;
-- staff see every notice of their school (incl. scheduled / expired)
create policy notices_select_staff on public.notices for select to authenticated
  using ((select private.is_super_admin())
         or private.has_school_role(school_id, array['school_admin', 'accountant', 'teacher']::public.app_role[]));
-- parents: published, not expired, addressed to parents/everyone, and either
-- school-wide or for a class one of their children is in
create policy notices_select_parent on public.notices for select to authenticated
  using (
    audience in ('everyone', 'parents')
    and publish_at <= now() and (expires_at is null or expires_at > now())
    and private.has_school_role(school_id, array['parent']::public.app_role[])
    and (class_ids is null or exists (
      select 1 from public.student_guardians g
      join public.student_enrollments e on e.student_id = g.student_id
      where g.user_id = (select auth.uid()) and g.school_id = notices.school_id and e.class_id = any (notices.class_ids)))
  );
create policy notices_write on public.notices for all to authenticated
  using ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]))
  with check ((select private.is_super_admin()) or private.has_school_role(school_id, array['school_admin']::public.app_role[]));

-- Admins linking an EXISTING account as a parent need its id; profiles of people
-- outside the school are invisible to them, so this returns only the id, only to
-- that school's admins.
create or replace function private.find_account_by_email(p_school_id uuid, p_email text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  if not (private.is_super_admin() or private.has_school_role(p_school_id, array['school_admin']::public.app_role[])) then
    raise exception 'Not allowed.' using errcode = 'insufficient_privilege';
  end if;
  return (select id from public.profiles where lower(email) = lower(btrim(p_email)));
end $$;
revoke all on function private.find_account_by_email(uuid, text) from public, anon;
grant execute on function private.find_account_by_email(uuid, text) to authenticated;
