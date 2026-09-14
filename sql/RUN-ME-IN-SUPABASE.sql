-- ============================================================
-- RUN ME IN THE SUPABASE SQL EDITOR. Paste the whole file, press Run.
-- Safe with users on the site. Safe to run twice. Deletes nothing.
-- A result of "Success. No rows returned" at the end means everything worked.
-- Generated 2026-09-13. Source files: v657-search-path, v657-edit-signals-delete,
-- v657-brand-pinning, health-check.
-- ============================================================

-- ---------- 1 of 4: pin the search path (already applied; safe to repeat) ----------
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

-- ---------- 2 of 4: let "Start over" actually delete edit signals ----------
-- ============================================================================
-- v657 — edit_signals gets the DELETE policy it was missed for.
-- Run in the Supabase SQL editor. One policy. No data is touched. Idempotent.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- edit_signals has exactly two policies (sql/edit-signals.sql:11-13, rescoped by
-- sql/security-fixes-batch1.sql:11-18): SELECT and INSERT. It has never had a
-- DELETE policy. With RLS enabled, no policy for a command means that command is
-- DENIED — silently, and in PostgREST's case with NO error at all: a refused
-- DELETE resolves as `{ data: [], error: null }`.
--
-- notebook_notes, fixed in the same batch on the same day, DID get one
-- (security-fixes-batch1.sql:33-34). edit_signals was simply missed.
--
-- ---------------------------------------------------------------------------
-- WHAT THE USER SEES
-- ---------------------------------------------------------------------------
-- app.html's obResetForTesting ("Start over") wipes seven tables through
-- _verifiedBrandWipe (app.html:14709). That helper exists precisely because a
-- refusal is indistinguishable from success: it deletes with .select('id'), and
-- when zero rows come back it RE-READS the table — rows still present after a
-- "successful" delete is a proven refusal, and it returns ok:false.
--
-- edit_signals is the last table in that loop. So on every "Start over" for any
-- brand that has ever recorded an edit signal, the delete removes nothing, the
-- re-read finds the rows, and the user is shown:
--
--     "Some of this brand's data could not be removed from your account,
--      so onboarding may not re-run. Clear this device anyway?"
--
-- The warning is CORRECT — the data really is not being removed. The app is not
-- lying; the database is refusing. That is why the fix belongs here and not in
-- app.html. _verifiedBrandWipe needs no change; it has been reporting this
-- accurately all along.
--
-- Scoped identically to the SELECT/INSERT policies already on the table, so a user
-- can delete exactly the signals they can already read: their own brands'.
--
-- Safe on a live database: adding a policy grants a capability that is currently
-- denied to everyone. It cannot break a caller that works today.
-- ============================================================================
do $$
begin
  if to_regclass('public.edit_signals') is null then
    raise notice 'edit_signals does not exist — skipping';
    return;
  end if;

  -- drop-then-create keeps this re-runnable and also repairs a hand-edited copy.
  drop policy if exists "edit_signals delete own brand" on public.edit_signals;
  create policy "edit_signals delete own brand" on public.edit_signals
    for delete using (brand_id in (select user_brand_ids()));
end $$;


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = every table the "Start over" loop wipes has
-- a caller-bound DELETE policy, so nothing in that loop can refuse silently.
--
-- Written over the WHOLE wipe list, not just edit_signals: this defect was a table
-- being missed from a list, so the verify checks the list rather than the table.
-- A row names a table "Start over" will still fail to clear.
-- ============================================================================
select t.tbl as problem,
       'no caller-bound DELETE policy — "Start over" removes nothing and warns the user their data could not be removed' as detail
from unnest(array['ideas','remixes','product_refs','competitors',
                  'prompt_history','notebook_notes','edit_signals']) as t(tbl)
where to_regclass('public.' || t.tbl) is not null
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename  = t.tbl
      and p.cmd in ('DELETE', 'ALL')
      and coalesce(p.qual, '') ~ 'user_brand_ids|auth\.uid'
  )
order by 1;

-- ---------- 3 of 4: stop a teammate moving your rows into their own brand ----------
-- ============================================================================
-- v657 — a row can no longer be MOVED from one brand to another by a client.
-- Run in the Supabase SQL editor. Creates one function + one trigger per
-- brand-scoped table. No data is touched. Idempotent.
--
-- ---------------------------------------------------------------------------
-- THE HOLE
-- ---------------------------------------------------------------------------
-- Every brand-scoped UPDATE policy in this schema omits WITH CHECK:
--
--   sql/team-tables.sql:101-108   ideas, FOR UPDATE USING (brand_id IN (...))
--   sql/team-tables.sql:136-147   the DO-loop, FOR ALL USING (brand_id IN (SELECT user_brand_ids()))
--                                 → remixes, product_refs, competitors, prompt_history
--
-- When an UPDATE policy has no WITH CHECK, Postgres REUSES USING as the check on
-- the NEW row. USING says "brand_id is one of my brands". The new row satisfies
-- that if its brand_id is one of MY brands. So an invited member can run
--
--     update ideas set brand_id = '<a brand I own>' where brand_id = '<the owner''s brand>';
--
-- Both sides pass: the old row is in a brand they belong to, the new row is in a
-- brand they own. The owner's entire idea library is now filed under the member's
-- own workspace — and stays there after the owner removes them from the team,
-- because the rows are no longer the owner's to see. It is not a copy. It is a
-- one-way move, and there is no undo in the app.
--
-- The FOR ALL form is the same defect plus one more: FOR ALL applies USING to
-- SELECT, UPDATE and DELETE, so on remixes / product_refs / competitors /
-- prompt_history a member can also simply DELETE the owner's rows. That half is
-- NOT fixed here — fixing it needs a roles concept (owner/editor/viewer), which
-- this schema does not have and which would touch every policy and the whole team
-- UI. sql/security-fixes-batch2.sql:45-48 made the same call for the same reason.
-- This file closes the half that is silent, permanent and undoable.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT A POLICY
-- ---------------------------------------------------------------------------
-- The rule that closes this is "the NEW brand_id must equal the OLD brand_id".
-- A WITH CHECK expression CANNOT reference OLD — it only ever sees the new row —
-- so no policy can express it. A BEFORE UPDATE trigger is the narrowest correct
-- tool. sql/security-fixes-batch2.sql:65-99 already does exactly this for
-- brands.user_id (brands_pin_ownership); this is the same pattern applied to the
-- other end of the same relationship, and it inherits that file's reasoning:
--
--   * SILENT RESET, not an exception. Raising would turn any future client that
--     happens to echo brand_id back in an UPDATE payload into a hard save failure.
--     brands_pin_ownership() reset user_id silently for precisely that reason
--     (settingsToBrand() sends user_id on every save). Resetting can only ever
--     put the row back where it already was, so it cannot lose anything.
--   * THE SERVICE ROLE IS EXEMPT. auth.uid() is null for the service role and for
--     backend jobs, so api/*.js keeps working and an owner can still move a row
--     between brands deliberately from the SQL editor. The exposure being closed
--     is a CLIENT holding nothing but the public anon key; the service role
--     already has, and must keep, full authority.
--   * SECURITY INVOKER, with a pinned search_path — same as brands_pin_ownership.
--
-- BLAST RADIUS TODAY: zero. app.html performs NO UPDATE at all on any of these
-- tables — _saveIdeasToDBNow (app.html:7584+) is insert-then-delete, and the only
-- two `.update()` calls in the whole app are on `brands` and `push_subscriptions`.
-- So this trigger changes the behaviour of exactly nothing that currently runs.
-- It only removes an attack.
--
-- ---------------------------------------------------------------------------
-- A NOTE ON WHAT THE REPO CLAIMS vs WHAT PRODUCTION HAS
-- ---------------------------------------------------------------------------
-- sql/team-tables.sql:31-37 declares the brand_members SELECT policy as a
-- SELF-REFERENTIAL query (brand_members selecting from brand_members). The LIVE
-- policy, checked against the production database on 2026-09-13, is CLEAN — it
-- does not contain that recursion. The REPO is the thing that is out of date, not
-- production. Nothing in this file "fixes" brand_members, and nothing here should
-- be used as a reason to re-run sql/team-tables.sql against production; doing so
-- would REPLACE a good live policy with the stale one in the repo. A note to that
-- effect has been added at team-tables.sql:27.
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- The trigger function. One function, reused by every brand-scoped table.
-- ----------------------------------------------------------------------------
create or replace function public.pin_brand_id()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  -- Service role / backend jobs have no auth.uid(): leave them alone.
  if v_uid is null then
    return new;
  end if;

  -- A row's brand is immutable from any client, deliberate or accidental.
  if new.brand_id is distinct from old.brand_id then
    new.brand_id := old.brand_id;
  end if;

  return new;
end;
$fn$;


-- ----------------------------------------------------------------------------
-- Attach it to EVERY table in `public` that has a brand_id column.
--
-- Driven off the catalog rather than a hand-written list on purpose: a hard-coded
-- list is exactly how ideas got a bespoke policy and the other four got the
-- DO-loop, and how the next brand-scoped table will get neither. Any table added
-- later is covered by re-running this file.
--
-- `brands` itself has no brand_id column, so it is naturally excluded; its own
-- ownership pin is brands_pin_ownership (security-fixes-batch2.sql).
-- drop-then-create keeps this re-runnable with no duplicate triggers.
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.relname as tbl
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
                       and a.attname  = 'brand_id'
                       and a.attnum   > 0
                       and not a.attisdropped
    where n.nspname = 'public'
      and c.relkind = 'r'
    order by c.relname
  loop
    execute format('drop trigger if exists pin_brand_id_trg on public.%I', r.tbl);
    execute format('create trigger pin_brand_id_trg before update on public.%I for each row execute function public.pin_brand_id()', r.tbl);
    raise notice 'pinned brand_id on public.%', r.tbl;
  end loop;
end $$;


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = every brand-scoped table in `public` has the
-- BEFORE UPDATE trigger, so no client can move a row between brands.
-- A row names a table that is still movable.
-- ============================================================================
select c.relname as problem,
       'brand-scoped table has no pin_brand_id_trg — a member can UPDATE brand_id and move these rows into their own workspace' as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid
                   and a.attname  = 'brand_id'
                   and a.attnum   > 0
                   and not a.attisdropped
where n.nspname = 'public'
  and c.relkind = 'r'
  and not exists (
    select 1 from pg_trigger t
    where t.tgrelid = c.oid
      and not t.tgisinternal
      and t.tgname = 'pin_brand_id_trg'
      and t.tgenabled <> 'D'          -- a DISABLED trigger is not a fix
  )
order by 1;

-- ---------- 4 of 4: fix the health check that certified the hole as safe ----------
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
