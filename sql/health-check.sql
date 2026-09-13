-- ============================================================
-- health-check.sql  —  read-only security posture audit  (v2)
--
-- Creates security_health(): a SECURITY DEFINER function that inspects the
-- LIVE RLS/policy state and returns a compact JSON verdict. The /api/health
-- endpoint calls this daily (via the service role) so account-isolation drift
-- in Supabase (e.g. someone editing a policy in the dashboard) is caught
-- automatically instead of by a customer.
--
-- v2 adds, beyond the original RLS/permissive/zero-policy/membership checks:
--   • permissive_write_policies  — INSERT/DELETE/ALL policies with a true
--     predicate (WITH CHECK true or USING true). A permissive WRITE policy
--     leaks cross-brand writes and was NOT caught by the original read-only
--     (SELECT/UPDATE/ALL USING(true)) test.
--   • unbound_brand_tables       — brand-scoped tables (they have a brand_id
--     column) that DO have policies but NONE of those policies reference the
--     membership function user_brand_ids() or auth.uid(). This is the "live
--     enforcement probe": it proves each brand table's policies are actually
--     bound to the caller, not merely present. Catches a policy that was
--     edited to filter on the wrong thing.
--   • user_brand_ids_secure      — the linchpin membership function must be
--     SECURITY DEFINER, or RLS that depends on it can be bypassed.
--
-- Safe + idempotent. Read-only. Run once in the Supabase SQL editor.
-- ============================================================

create or replace function security_health()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with t as (
    select c.relname as tbl, c.relrowsecurity as rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ),
  -- brand-scoped tables = anything with a brand_id column
  brand_tbls as (
    select distinct table_name as tbl
    from information_schema.columns
    where table_schema = 'public' and column_name = 'brand_id'
  ),
  pol as (
    select tablename, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
  ),
  -- read-side permissive: SELECT/UPDATE/ALL with USING(true)
  read_permissive as (
    select distinct tablename from pol
    where cmd in ('SELECT','UPDATE','ALL') and qual = 'true'
  ),
  -- write-side permissive: INSERT/DELETE/ALL with a true predicate
  -- (INSERT is gated by with_check; DELETE by qual; ALL by either)
  write_permissive as (
    select distinct tablename from pol
    where cmd in ('INSERT','DELETE','ALL')
      and (qual = 'true' or with_check = 'true')
  ),
  pcount as (
    select tablename, count(*) as n from pol group by tablename
  ),
  -- does the table have ANY policy tied to the caller's membership / identity?
  bound as (
    select tablename, bool_or(
      coalesce(qual, '')       ~ 'user_brand_ids|auth\.uid' or
      coalesce(with_check, '') ~ 'user_brand_ids|auth\.uid'
    ) as is_bound
    from pol
    group by tablename
  )
  select jsonb_build_object(
    -- tables with RLS switched OFF entirely (must be empty)
    'rls_disabled',
      (select coalesce(jsonb_agg(tbl order by tbl), '[]'::jsonb) from t where rls = false),
    -- read-side permissive USING(true) SELECT/UPDATE/ALL policies (must be empty)
    'permissive_policies',
      (select coalesce(jsonb_agg(tablename order by tablename), '[]'::jsonb) from read_permissive),
    -- write-side permissive INSERT/DELETE/ALL policies (must be empty)
    'permissive_write_policies',
      (select coalesce(jsonb_agg(tablename order by tablename), '[]'::jsonb) from write_permissive),
    -- RLS-on but zero policies = deny-all. brand_connections / job_heartbeats
    -- are intentional (backend-only via service role); the endpoint allowlists
    -- those. Anything else here is a real gap.
    'zero_policy_tables',
      (select coalesce(jsonb_agg(t.tbl order by t.tbl), '[]'::jsonb)
         from t left join pcount p on p.tablename = t.tbl
        where t.rls and coalesce(p.n, 0) = 0),
    -- brand-scoped tables that HAVE policies but none tie to the caller (must be empty)
    'unbound_brand_tables',
      (select coalesce(jsonb_agg(bt.tbl order by bt.tbl), '[]'::jsonb)
         from brand_tbls bt
         join pcount p on p.tablename = bt.tbl               -- has at least one policy
         left join bound b on b.tablename = bt.tbl
        where coalesce(b.is_bound, false) = false),
    -- the linchpin membership function must exist …
    'has_user_brand_ids',
      exists(select 1 from pg_proc where proname = 'user_brand_ids'),
    -- … and be SECURITY DEFINER, or the RLS that depends on it can be bypassed
    'user_brand_ids_secure',
      exists(select 1 from pg_proc where proname = 'user_brand_ids' and prosecdef)
  );
$$;

grant execute on function security_health() to service_role;
