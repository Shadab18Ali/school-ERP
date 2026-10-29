-- =====================================================================
-- Phase 23 (part 1): the librarian role.
-- Kept in its own migration: Postgres can't use a new enum value in the same
-- transaction that adds it, and the SQL Editor runs a whole script as one.
-- =====================================================================
alter type public.app_role add value if not exists 'librarian';
