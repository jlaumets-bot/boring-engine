-- ============================================================
-- v657 — pin the search_path on user_brand_ids().
-- Run in the Supabase SQL editor. ONE statement. No data is touched.
--
-- THE HOLE: user_brand_ids() (sql/team-tables.sql:127-131) is SECURITY DEFINER —
-- it executes with the OWNER's privileges — but it carries no `SET search_path`.
-- A SECURITY DEFINER function without a pinned search_path resolves its unqualified
-- names (`brands`, `brand_members`) against the CALLER's search_path. Any role that
-- can create a schema and prepend it to its own search_path can therefore put its
-- own `brands` / `brand_members` in front of the real ones, and this function will
-- happily read them AS THE OWNER.
--
-- WHY THIS ONE MATTERS MORE THAN ANY OTHER FUNCTION: every brand-scoped RLS policy
-- in the database delegates its membership test to it —
--     USING (brand_id IN (SELECT user_brand_ids()))
-- (sql/team-tables.sql:144, sql/security-fixes-batch1.sql:14-34, and every table
-- added since). Controlling what this function returns is controlling the answer to
-- "which brands are mine" for the entire schema at once. It is the single highest
-- leverage function in the database, and it was the ONLY SECURITY DEFINER function
-- without a pinned search_path (confirmed against the live database, 2026-09-13).
--
-- WHY `ALTER FUNCTION` AND NOT `CREATE OR REPLACE`: this changes ONLY the search_path
-- setting and leaves the function BODY exactly as production has it. The repo's copy
-- of this schema is known to be out of date in places (see the note in
-- sql/v657-brand-pinning.sql about brand_members), so re-declaring the body from the
-- repo could silently revert a live fix. Attaching a setting cannot.
--
-- pg_temp is named LAST on purpose: an unqualified name must never resolve to a
-- temporary table the caller created a moment earlier.
--
-- Idempotent: re-running sets the same setting again and changes nothing.
-- Safe on a live database — this is a catalog-only change; no rows are read or written,
-- no table is locked for longer than it takes to update one pg_proc row.
-- ============================================================
alter function public.user_brand_ids() set search_path = public, pg_temp;


-- ============================================================
-- VERIFY — read-only. EMPTY RESULT = every SECURITY DEFINER function in `public`
-- has a pinned search_path, user_brand_ids() included.
--
-- Deliberately NOT written as "does user_brand_ids have a search_path". Written as
-- "is there ANY definer function still missing one", so the next function added
-- without one is caught by this same query instead of needing a new one.
-- A row names the function that is still exposed.
-- ============================================================
select p.proname as problem,
       'SECURITY DEFINER with no pinned search_path — resolves its tables against the CALLER''s search_path while running as the owner' as detail
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg(setting)
    where cfg.setting ~ '^search_path='
  )
order by 1;
