-- ============================================================
-- health-check.sql  —  read-only security posture audit  (v3)
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
-- v3 (2026-09-13) fixes TWO WAYS THIS FILE REPORTED GREEN ON A REAL HOLE:
--
--   1. user_brand_ids_secure tested `prosecdef` AND NOTHING ELSE. SECURITY DEFINER
--      on its own is not a security property — it is the thing that CREATES the
--      exposure. A definer function with no pinned search_path resolves its
--      unqualified table names against the CALLER's search_path while running as
--      the owner. user_brand_ids() was in exactly that state, and this check
--      reported it healthy *because* of the half that made it dangerous. It now
--      requires prosecdef AND a pinned search_path. See sql/v657-search-path.sql.
--
--   2. write_permissive covered cmd in ('INSERT','DELETE','ALL') only, and
--      read_permissive covers SELECT/UPDATE/ALL with USING(true). A plain UPDATE
--      policy therefore fell between them in two different ways:
--        · UPDATE with `with_check = 'true'` was in NEITHER set → 'UPDATE' is now
--          in write_permissive.
--        · UPDATE (or ALL) with NO WITH CHECK AT ALL was in neither set either,
--          and that is the more dangerous shape: Postgres REUSES USING as the
--          check on the new row, so "brand_id is one of my brands" is satisfied by
--          moving the row INTO one of my brands. Every brand-scoped UPDATE policy
--          in this schema is that shape, and this file called them all healthy.
--          → new key update_unpinned_policies. See sql/v657-brand-pinning.sql.
--
--      update_unpinned_policies is satisfied by EITHER a real WITH CHECK or a
--      BEFORE UPDATE trigger on the table (the tool this schema actually uses,
--      because a WITH CHECK cannot reference OLD). So it goes green once the
--      v657 pin triggers are applied, rather than being a permanent red that
--      someone eventually deletes.
--
-- NOTE FOR api/health.js (not owned by this file): it reads specific keys and
-- ignores unknown ones, so v3 is backward compatible. update_unpinned_policies is
-- NOT yet asserted there — add `add('no_unpinned_update_policies', unpinned.length === 0)`
-- alongside the existing no_permissive_write_policies check to make it load-bearing.
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
  -- write-side permissive: INSERT/UPDATE/DELETE/ALL with a true predicate
  -- (INSERT is gated by with_check; DELETE by qual; UPDATE and ALL by either)
  -- v3: 'UPDATE' added. It was missing, and an UPDATE policy with with_check='true'
  -- was consequently in neither this set nor read_permissive — invisible.
  write_permissive as (
    select distinct tablename from pol
    where cmd in ('INSERT','UPDATE','DELETE','ALL')
      and (qual = 'true' or with_check = 'true')
  ),
  -- v3: tables carrying an ENABLED BEFORE-UPDATE row trigger. Such a trigger is how
  -- this schema constrains the NEW row (brands_pin_ownership, pin_brand_id) — a
  -- WITH CHECK expression cannot reference OLD, so it is the only tool that can say
  -- "this column may not change". tgtype bits: 2 = BEFORE, 16 = UPDATE.
  before_update_pinned as (
    select distinct c.relname as tablename
    from pg_trigger t
    join pg_class c     on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and t.tgenabled <> 'D'
      and (t.tgtype::int & 2)  <> 0
      and (t.tgtype::int & 16) <> 0
  ),
  -- v3: THE CHECK THAT WOULD HAVE CAUGHT THE BRAND-MOVE HOLE.
  -- An UPDATE (or FOR ALL) policy with NO WITH CHECK reuses USING as the check on
  -- the new row, so a predicate like "brand_id in (my brands)" permits moving a row
  -- INTO one of my brands. Satisfied by a real WITH CHECK or by a BEFORE UPDATE
  -- trigger; anything else here is a table whose rows can be re-parented by a client.
  update_unpinned as (
    select distinct p.tablename
    from pol p
    where p.cmd in ('UPDATE','ALL')
      and p.with_check is null
      and p.tablename not in (select tablename from before_update_pinned)
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
    -- write-side permissive INSERT/UPDATE/DELETE/ALL policies (must be empty)
    'permissive_write_policies',
      (select coalesce(jsonb_agg(tablename order by tablename), '[]'::jsonb) from write_permissive),
    -- UPDATE/ALL policies with no WITH CHECK and no BEFORE UPDATE trigger (must be empty)
    'update_unpinned_policies',
      (select coalesce(jsonb_agg(tablename order by tablename), '[]'::jsonb) from update_unpinned),
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
    -- … and be SECURITY DEFINER **AND** carry a pinned search_path.
    -- v3: prosecdef alone was the whole test. That is backwards — SECURITY DEFINER
    -- is the privilege escalation, and a pinned search_path is what makes it safe to
    -- have. Without the pin, the function resolves `brands` / `brand_members` against
    -- the CALLER's search_path while executing as the owner, and every brand-scoped
    -- RLS policy in this database delegates its membership test to it.
    'user_brand_ids_secure',
      exists(
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'user_brand_ids'
          and p.prosecdef
          and exists (
            select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg(setting)
            where cfg.setting ~ '^search_path='
          )
      )
  );
$$;

grant execute on function security_health() to service_role;


-- ============================================================
-- VERIFY — read-only. EMPTY RESULT = the v3 function is live, i.e. the audit can
-- no longer report green on the two holes it certified. A row names what is stale.
-- ============================================================
select 'security_health' as problem, d.detail
from (values
  ('user_brand_ids_secure still tests prosecdef alone — a definer function with no pinned search_path reads green', 'proconfig'),
  ('write_permissive still skips UPDATE — an UPDATE policy with a true predicate is invisible',                     'INSERT'',''UPDATE'),
  ('no update_unpinned_policies key — an UPDATE policy with no WITH CHECK is still invisible',                      'update_unpinned')
) as d(detail, needle)
where not exists (select 1 from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'security_health')
   or (select pg_get_functiondef(p.oid)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'security_health'
       limit 1) not like '%' || d.needle || '%';
