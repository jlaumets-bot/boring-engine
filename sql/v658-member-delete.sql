-- ============================================================================
-- v658 — a team member can no longer delete the brand owner's content library.
-- Run in the Supabase SQL editor. Changes POLICIES only. No data is touched, no
-- function is replaced. Safe to run twice. Safe on a live database with users on it.
--
-- RUN sql/v658-revoke-security-health.sql FIRST OR SECOND, EITHER ORDER — the two
-- files are independent. Both must be run.
--
-- ---------------------------------------------------------------------------
-- THE HOLE
-- ---------------------------------------------------------------------------
-- sql/team-tables.sql:136-147 loops over remixes, product_refs, competitors and
-- prompt_history and gives each ONE policy:
--
--     CREATE POLICY "Users can access <t>" ON <t> FOR ALL USING (brand_id IN (SELECT user_brand_ids()))
--
-- FOR ALL means SELECT, INSERT, UPDATE **and DELETE**. user_brand_ids()
-- (team-tables.sql:139-143) returns brands you OWN *unioned with* brands you merely
-- BELONG TO. So every teammate holds DELETE on the owner's rows in all four tables.
--
-- ideas, notebook_notes and edit_signals reach the same place by a different road —
-- their own DELETE policies are member-scoped (team-tables.sql:122-130,
-- security-fixes-batch1.sql:33-34, v657-edit-signals-delete.sql:52-55).
--
-- That is all seven tables of the content library, deletable by anyone the owner
-- ever invited — including, after v655 made invites addressable, anyone who was
-- invited once and has since been removed from the team but whose brand_members row
-- outlives the intent.
--
-- IT IS NOT THEORETICAL. app.html:20659 ships a button labelled
-- "Start over (re-run onboarding)" whose handler obResetForTesting (app.html:14884)
-- loops over EXACTLY these seven tables and deletes on brand_id alone:
--     for (const t of ['ideas','remixes','product_refs','competitors',
--                      'prompt_history','notebook_notes','edit_signals'])
-- The button is in the settings panel, it is visible to members, and it asks only
-- "Start over? This deletes this brand's ideas, notes and voice data". A member who
-- presses it out of curiosity destroys the owner's entire library, permanently.
--
-- sql/v657-brand-pinning.sql stopped a member MOVING rows into their own brand. It
-- says so explicitly and it did not address deleting them. This is that second half.
--
-- ---------------------------------------------------------------------------
-- THE FIX
-- ---------------------------------------------------------------------------
-- Members keep everything collaboration needs — reading, inserting and updating are
-- unchanged. Only DELETE is narrowed, from "a brand I can see" to "a brand I own":
--
--     USING (brand_id IN (SELECT id FROM brands WHERE user_id = auth.uid()))
--
-- Note this is NOT user_brand_ids() with the membership arm removed — it queries
-- `brands` directly, so it cannot be widened later by an edit to that helper.
--
-- The four FOR ALL policies are replaced by four explicit per-command policies each.
-- Splitting FOR ALL is the only way to say "three of these commands are for members
-- and the fourth is not"; a FOR ALL policy cannot express a per-command difference.
-- The SELECT/INSERT/UPDATE predicates are copied verbatim from what FOR ALL already
-- applied, so a member sees and writes exactly what they did yesterday.
--
-- The UPDATE policies carry no WITH CHECK, deliberately and identically to what they
-- replace: the rule needed is "the new brand_id must equal the OLD brand_id", WITH
-- CHECK cannot see OLD, and that rule is already enforced by the pin_brand_id_trg
-- BEFORE UPDATE trigger from v657-brand-pinning.sql. See scripts/verify/sql-update-pinning.mjs.
--
-- ---------------------------------------------------------------------------
-- WHAT A MEMBER NOW EXPERIENCES WHEN THEY PRESS "Start over" — READ THIS
-- ---------------------------------------------------------------------------
-- Nothing is deleted from the account, and the app tells them so. In detail:
--
--   1. The confirm appears as always and they accept it.
--   2. For each of the seven tables, _verifiedBrandWipe (app.html:14860-14883) runs
--      the delete, gets back zero rows — RLS filters the rows out rather than raising,
--      so PostgREST answers `{ data: [], error: null }` — then RE-READS the table,
--      finds the rows still there, and correctly returns ok:false.
--   3. The brands row delete was ALREADY refused for a member before this change:
--      app.html:14905 pins it with .eq('user_id', currentUser.id), so for a member it
--      matches nothing whatever the policy says.
--   4. dbOk is false, so they get the second dialog:
--        "Some of this brand's data could not be removed from your account, so
--         onboarding may not re-run. Clear this device anyway?"
--   5. If they accept THAT, only this device's local caches are wiped and the page
--      reloads. The brand and all its content are untouched on the server; the member
--      re-syncs them on next load.
--
-- So the member's outcome is an honest refusal instead of silent destruction of
-- someone else's work. Note that step 3 means a member ALREADY got that dialog today
-- — after their delete had already emptied the owner's seven tables.
--
-- THE OWNER'S "Start over" IS UNAFFECTED. The owner satisfies
-- brands.user_id = auth.uid() for their own brand, so every delete in the loop
-- matches exactly the rows it did before, the brands row is removed as before, and
-- onboarding re-runs. This was the one thing worth breaking and it is not broken;
-- scripts/verify/invite-link-owner-delete.mjs and the VERIFY below both assert that
-- an owner-bound DELETE policy exists on all seven tables, precisely so that a
-- narrowing that went one step too far shows up as a failure rather than as a
-- support ticket.
--
-- app.html is owned by another change right now, so nothing here hides the button.
-- THE DECISION THAT IS LEFT TO YOU: the button is still shown to members and will
-- now always end in the "could not be removed" dialog. Hiding it for non-owners (or
-- relabelling it) is an app.html change, and this file does not presume it.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE WITH USERS ON THE SITE
-- ---------------------------------------------------------------------------
-- * Each table's drop-and-recreate happens inside ONE DO block, and DDL in PostgreSQL
--   is transactional, so no session can ever observe a window in which a table has no
--   SELECT policy. Nobody's app goes blank mid-run.
-- * Every statement is guarded by to_regclass, so a table this database does not have
--   is skipped rather than erroring out half way.
-- * drop policy IF EXISTS + create — re-running produces the identical end state.
-- * No DELETE is issued by this file. It changes who may delete, not what exists.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 of 2 — the four tables that were given a single FOR ALL policy.
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
begin
  foreach tbl in array array['remixes','product_refs','competitors','prompt_history']
  loop
    if to_regclass('public.' || tbl) is null then
      raise notice 'v658: % does not exist — skipping', tbl;
      continue;
    end if;

    -- The FOR ALL policy this file exists to retire. Named exactly as team-tables.sql:156
    -- created it. "Users can view own %1$s" is dropped too: team-tables.sql:155 dropped it
    -- before creating the FOR ALL, so a database that predates that file may still have it.
    execute format('drop policy if exists "Users can access %1$s" ON public.%1$s', tbl);
    execute format('drop policy if exists "Users can view own %1$s" ON public.%1$s', tbl);

    -- Members: unchanged. Same predicate the FOR ALL policy applied.
    execute format('drop policy if exists "Members can read %1$s" ON public.%1$s', tbl);
    execute format('create policy "Members can read %1$s" ON public.%1$s for select using (brand_id in (select user_brand_ids()))', tbl);

    execute format('drop policy if exists "Members can insert %1$s" ON public.%1$s', tbl);
    execute format('create policy "Members can insert %1$s" ON public.%1$s for insert with check (brand_id in (select user_brand_ids()))', tbl);

    -- No WITH CHECK: brand_id immutability is carried by pin_brand_id_trg (v657).
    execute format('drop policy if exists "Members can update %1$s" ON public.%1$s', tbl);
    execute format('create policy "Members can update %1$s" ON public.%1$s for update using (brand_id in (select user_brand_ids()))', tbl);

    -- DELETE: owner only. This is the whole change.
    execute format('drop policy if exists "Owner can delete %1$s" ON public.%1$s', tbl);
    execute format('create policy "Owner can delete %1$s" ON public.%1$s for delete using (brand_id in (select id from brands where user_id = auth.uid()))', tbl);

    raise notice 'v658: % — delete narrowed to the brand owner', tbl;
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- 2 of 2 — the three tables that already had their own member-scoped DELETE policy.
-- Dropped by their real names (they differ per table) and replaced with owner-only.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.ideas') is not null then
    drop policy if exists "Users can delete own or member ideas" on public.ideas;   -- team-tables.sql:123
    drop policy if exists "Users can delete own ideas"           on public.ideas;   -- pre-team-tables name
    drop policy if exists "Owner can delete ideas"               on public.ideas;
    create policy "Owner can delete ideas" on public.ideas
      for delete using (brand_id in (select id from brands where user_id = auth.uid()));
    raise notice 'v658: ideas — delete narrowed to the brand owner';
  end if;

  if to_regclass('public.notebook_notes') is not null then
    drop policy if exists "notebook delete"              on public.notebook_notes;  -- security-fixes-batch1.sql:33
    drop policy if exists "Owner can delete notebook_notes" on public.notebook_notes;
    create policy "Owner can delete notebook_notes" on public.notebook_notes
      for delete using (brand_id in (select id from brands where user_id = auth.uid()));
    raise notice 'v658: notebook_notes — delete narrowed to the brand owner';
  end if;

  if to_regclass('public.edit_signals') is not null then
    drop policy if exists "edit_signals delete own brand"   on public.edit_signals; -- v657-edit-signals-delete.sql:53
    drop policy if exists "Owner can delete edit_signals"   on public.edit_signals;
    create policy "Owner can delete edit_signals" on public.edit_signals
      for delete using (brand_id in (select id from brands where user_id = auth.uid()));
    raise notice 'v658: edit_signals — delete narrowed to the brand owner';
  end if;
end $$;


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = across every table in the "Start over" loop,
-- DELETE is reachable by the brand OWNER and by nobody else, and members still have
-- the read/insert/update they had before.
--
-- Three arms, because this change can fail in three directions:
--   * arm 1 — a DELETE-capable policy that still admits members (the hole is open);
--   * arm 2 — no owner-bound DELETE policy at all (the owner's "Start over" is now
--             broken, which is the mistake a careless narrowing makes);
--   * arm 3 — a member lost SELECT / INSERT / UPDATE (collaboration broken).
--
-- Arm 1 is written over pg_policies for the WHOLE schema rather than a list of seven
-- names: the defect was a table inheriting a too-wide policy from a loop, so a table
-- added to that loop tomorrow must show up here by itself.
-- ============================================================================
with wipe(tbl) as (
  values ('ideas'), ('remixes'), ('product_refs'), ('competitors'),
         ('prompt_history'), ('notebook_notes'), ('edit_signals')
)
select p.tablename as problem,
       'policy "' || p.policyname || '" is FOR ' || p.cmd ||
       ' and its predicate admits brand MEMBERS — a teammate can delete the owner''s rows' as detail
from pg_policies p
where p.schemaname = 'public'
  and p.cmd in ('DELETE', 'ALL')
  and coalesce(p.qual, '') ~* '(user_brand_ids|brand_members)'

union all

select w.tbl,
       'no owner-bound DELETE policy — the BRAND OWNER can no longer clear this table, ' ||
       'so "Start over" now fails for them too'
from wipe w
where to_regclass('public.' || w.tbl) is not null
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename  = w.tbl
      and p.cmd in ('DELETE', 'ALL')
      and coalesce(p.qual, '') ~* 'brands'
      and coalesce(p.qual, '') ~* 'auth\.uid'
  )

union all

-- Arm 3 covers ONLY the four tables whose single FOR ALL policy this file splits into
-- four. They are the only ones that can lose a command here. It deliberately does NOT
-- ask the other three for an UPDATE policy: notebook_notes and edit_signals have never
-- had one (sql/security-fixes-batch1.sql:23-34, sql/edit-signals.sql) and nothing in
-- this file takes one away, so demanding it would make this verify report a failure
-- that is neither new nor caused by v658 — and a verify that cannot come back empty
-- teaches you to ignore it.
select s.tbl,
       'members lost ' || c.cmd || ' on this table — splitting FOR ALL took away more than DELETE'
from (values ('remixes'), ('product_refs'), ('competitors'), ('prompt_history')) as s(tbl)
cross join (values ('SELECT'), ('INSERT'), ('UPDATE')) as c(cmd)
where to_regclass('public.' || s.tbl) is not null
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename  = s.tbl
      and p.cmd in (c.cmd, 'ALL')
      and (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~* 'user_brand_ids|brand_members'
  )

order by 1, 2;
