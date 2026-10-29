-- Run ONCE in the Supabase SQL editor after creating your own user in
-- Authentication > Users. Replace the email. Super admin can only be
-- granted from the SQL editor (never via the API or the app).
update public.profiles
set is_super_admin = true
where lower(email) = lower('you@example.com');
