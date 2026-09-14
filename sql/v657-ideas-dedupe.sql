-- ============================================================================
-- v657 — remove the duplicate ideas that already exist, and prepare the UNIQUE
-- index that would make the whole class structurally impossible.
--
-- READ THE TWO PARTS BEFORE RUNNING ANYTHING.
--   PART 1 (cleanup)  — safe on a live database TODAY. Archives, then deletes.
--   PART 2 (the index)— IS NOT ENABLED, AND MUST NOT BE UNTIL app.html CHANGES.
--                       Turning it on today breaks EVERY save. See PART 2.
--
-- ---------------------------------------------------------------------------
-- WHERE THE DUPLICATES COME FROM
-- ---------------------------------------------------------------------------
-- _saveIdeasToDBNow (app.html:7584) writes the whole in-memory library, then
-- deletes the superseded copies it captured BEFORE the insert. That order is
-- deliberate and correct — the previous order (delete-all, then insert) left a
-- multi-second window in which the user's entire library did not exist, and a
-- dropped connection in that window destroyed it permanently. The cost of the
-- safe order is that a FAILED cleanup leaves a duplicate behind, which the code
-- states outright: "A failed cleanup is NOT a failed save ... it leaves a
-- superseded duplicate, and the read path dedups by title, so the fresh copy
-- wins" (app.html:7634-7636). The read path hides them; nothing ever removes them.
--
-- FIVE such groups exist in production today (confirmed 2026-09-13).
--
-- ---------------------------------------------------------------------------
-- THE "KEEP" RULE, TAKEN FROM THE APP, NOT INVENTED HERE
-- ---------------------------------------------------------------------------
-- loadIdeasFromDB sorts by _ideaRowRecency (app.html:7710-7715) —
--     updated_at, else created_at, else numeric id
-- newest first, and then keeps the FIRST row per title. So the row the user can
-- actually see is the NEWEST one. This script keeps exactly that row and archives
-- the rest. Deleting the others removes only rows that are already unreachable in
-- the UI; the visible library does not change by one character.
--
-- Ordering here is written as coalesce(updated_at, created_at) desc, then ctid
-- desc, and reads both timestamps through to_jsonb() so the script is valid even
-- on an install where one of those columns does not exist (this repo has no
-- CREATE TABLE for `ideas` to check against). ctid desc is the last tiebreak —
-- physically newest — which is the closest available stand-in for the app's
-- numeric-id fallback and is deterministic within a single run.
--
-- ---------------------------------------------------------------------------
-- EXACT TITLE, NOT lower(trim(title)) — DELIBERATE
-- ---------------------------------------------------------------------------
-- The app's READ path dedupes case-insensitively (`i.title.toLowerCase().trim()`,
-- app.html:7037) but its WRITE path matches titles EXACTLY — `.eq('title', a)`
-- (app.html:6887, 17157) and `.in('title', titles)` (app.html:7599). Collapsing
-- case variants here would delete a row the app still treats as its own and would
-- simply re-create on the next save, and a case-insensitive UNIQUE index would
-- make saving "Foo" fail outright while "foo" exists. Exact title is the rule the
-- database can enforce without contradicting the client.
--
-- Rows with a NULL or empty title are left alone, and PART 2's index is partial
-- for the same reason: an untitled row is not a duplicate of another untitled row,
-- and constraining them would block a legitimate save.
--
-- ---------------------------------------------------------------------------
-- REVERSIBLE BY INSPECTION
-- ---------------------------------------------------------------------------
-- Every row this script deletes is copied first, in full, into
--     archive.ideas_dupes_removed_v657
-- and left there. To see what was removed:
--     select * from archive.ideas_dupes_removed_v657;
-- To put it all back:
--     insert into public.ideas select * from archive.ideas_dupes_removed_v657;
--
-- The archive lives in a NEW `archive` schema, not in `public`, on purpose:
-- PostgREST only exposes `public`, so the copy is unreachable from the anon key —
-- a backup table in `public` with no RLS would hand every idea title to any signed
-- in user. It also keeps health-check.sql's zero_policy_tables clean.
--
-- Idempotent: PART 1 removes the duplicates, so a second run finds none, archives
-- nothing and deletes nothing. The archive from the first run is left untouched.
-- ============================================================================


-- ============================================================================
-- STEP 0 — PREVIEW. Read-only. RUN THIS ALONE FIRST, look at the output, and only
-- then run the rest of the file. It shows every row that PART 1 would delete.
-- ============================================================================
-- with ranked as (
--   select i.id, i.brand_id, i.title,
--          coalesce((to_jsonb(i) ->> 'updated_at')::timestamptz,
--                   (to_jsonb(i) ->> 'created_at')::timestamptz) as recency,
--          row_number() over (
--            partition by i.brand_id, i.title
--            order by coalesce((to_jsonb(i) ->> 'updated_at')::timestamptz,
--                              (to_jsonb(i) ->> 'created_at')::timestamptz) desc nulls last,
--                     i.ctid desc
--          ) as rn
--   from public.ideas i
--   where i.title is not null and i.title <> ''
-- )
-- select id, brand_id, title, recency, rn as would_delete_rank
-- from ranked where rn > 1
-- order by brand_id, title, rn;


-- ============================================================================
-- PART 1 — CLEANUP. Archive first, then delete. Safe to run on production.
-- ============================================================================
create schema if not exists archive;

-- Exact-shape copy of `ideas`, so a restore is a plain `insert ... select *`.
create table if not exists archive.ideas_dupes_removed_v657 as
  select * from public.ideas where false;

-- STEP A — THE REPORT. Read-only: prints, for this exact run, every duplicate group
-- and how many superseded copies it holds. Supabase shows RAISE NOTICE output.
do $$
declare
  v_rows int := 0;
  r      record;
begin
  if to_regclass('public.ideas') is null then
    raise notice 'ideas does not exist — skipping';
    return;
  end if;

  for r in
    with ranked as (
      select i.brand_id, i.title,
             row_number() over (
               partition by i.brand_id, i.title
               order by coalesce((to_jsonb(i) ->> 'updated_at')::timestamptz,
                                 (to_jsonb(i) ->> 'created_at')::timestamptz) desc nulls last,
                        i.ctid desc
             ) as rn
      from public.ideas i
      where i.title is not null and i.title <> ''
    )
    select brand_id, title, count(*) as n from ranked where rn > 1 group by 1, 2 order by 1, 2
  loop
    v_rows := v_rows + r.n;
    raise notice 'brand % : % superseded copy(ies) of "%"', r.brand_id, r.n, r.title;
  end loop;

  if v_rows = 0 then
    raise notice '--- v657 ideas dedupe: nothing to do (already clean) ---';
  else
    raise notice '--- v657 ideas dedupe: % superseded row(s) will be archived to archive.ideas_dupes_removed_v657 and removed ---', v_rows;
  end if;
end $$;

-- STEP B — ARCHIVE, THEN DELETE, IN ONE STATEMENT.
--
-- Written as data-modifying CTEs rather than as two statements over a temp table for
-- two reasons. First, the DELETE consumes the ids RETURNED by the INSERT, so the copy
-- is provably made before the row is removed — the ordering is enforced by the data
-- flow, not by the order the lines happen to appear in. Second, it is one statement:
-- there is no window in which a concurrent save can change what "the losers" are
-- between choosing them and deleting them, and nothing survives a failure half-done.
--
-- The ranking is IDENTICAL to STEP A's, so what was reported is what is removed.
-- Idempotent: a second run ranks every remaining title rn = 1 and deletes nothing.
with ranked as (
  select i.id,
         row_number() over (
           partition by i.brand_id, i.title
           order by coalesce((to_jsonb(i) ->> 'updated_at')::timestamptz,
                             (to_jsonb(i) ->> 'created_at')::timestamptz) desc nulls last,
                    i.ctid desc
         ) as rn
  from public.ideas i
  where i.title is not null and i.title <> ''
),
losers as (
  select id from ranked where rn > 1
),
archived as (
  insert into archive.ideas_dupes_removed_v657
  select i.* from public.ideas i join losers l on l.id = i.id
  returning id
)
delete from public.ideas i using archived a where a.id = i.id;


-- ============================================================================
-- PART 2 — THE UNIQUE INDEX. DO NOT UNCOMMENT THIS YET.
--
--   create unique index if not exists ideas_brand_title_uniq
--     on public.ideas (brand_id, title)
--     where title is not null and title <> '';
--
-- IT IS CORRECT AND IT IS THE REAL FIX — it makes the duplicate class impossible
-- instead of merely cleaned up. It is held back because, applied to production
-- TODAY, it would break every single save of an existing idea:
--
--   _saveIdeasToDBNow INSERTS the new copy of a row WHILE THE OLD ROW IS STILL
--   THERE, and deletes the old one only after the insert is confirmed
--   (app.html:7584-7660, "WRITE-BEFORE-DELETE"). It is a plain `.insert(batch)` —
--   no upsert, no onConflict. Under this index every one of those inserts raises
--   23505 unique_violation. The batch fails, the row-by-row retry fails, `failed`
--   is incremented for every idea, and saveIdeasToDB throws
--   "N idea(s) failed to save" — on every approve, mark-done and dismiss. Nothing
--   would persist. That is a full outage of the app's write path, not a hardening.
--
-- THE COMPANION CHANGE, in app.html (owned by another agent — NOT made here):
--   replace   await sb.from('ideas').insert(batch)
--   with      await sb.from('ideas').upsert(batch, { onConflict: 'brand_id,title' })
--   (and the same for the row-by-row retry a few lines below). An upsert keeps the
--   write-before-delete safety property exactly — the new content lands in one
--   statement, the library is never absent — while satisfying the index. The
--   dropSuperseded pass afterwards becomes a no-op that removes 0 of 0 rows, which
--   is already its normal quiet path.
--
-- ORDER OF OPERATIONS, once that lands:
--   1. deploy the app.html upsert change
--   2. re-run PART 1 of this file (any duplicate created in the meantime)
--   3. uncomment PART 2 and run it
--   4. the VERIFY below then reports the index as present
--
-- scripts/verify/sql-ideas-index-safe.mjs enforces this pairing: it goes red if
-- this index is enabled while app.html still inserts, or if the app switches to
-- upsert and the index is still missing.
-- ============================================================================


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = no brand has two ideas under the same title,
-- so the library the user sees and the library the database holds are the same.
-- A row names a (brand, title) that is still duplicated and how many copies exist.
--
-- This checks the STATE (no duplicates), not the MECHANISM (the index), because
-- the mechanism is deliberately not enabled yet — see PART 2. It is the honest
-- assertion for what this file actually applies today, and it stays correct after
-- PART 2 is enabled.
-- ============================================================================
select i.brand_id::text || ' / ' || i.title as problem,
       'still ' || count(*)::text || ' copies of this title in this brand — the older ones are invisible in the app and will never be removed by it' as detail
from public.ideas i
where i.title is not null and i.title <> ''
group by i.brand_id, i.title
having count(*) > 1
order by 1;
