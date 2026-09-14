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
