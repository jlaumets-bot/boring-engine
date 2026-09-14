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
