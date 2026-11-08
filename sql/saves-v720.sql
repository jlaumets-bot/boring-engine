-- ============================================================================
-- v720 — stable per-item keys, so a save sends only what changed.
--
-- WHY: every save in the app replaced whole lists (write the local copy, delete
-- the old rows). A phone or laptop holding a stale copy undid what another
-- device had done: approvals, edited scripts, notebook notes, saved versions.
-- The app (v720) now upserts only the items that changed, keyed by
-- (brand_id, client_key), and deletes only items the person removed.
--
-- WHAT THIS ADDS (nothing is deleted; no existing value is changed):
--   * client_key text on ideas, notebook_notes, remixes, product_refs and
--     prompt_history. Existing rows get their own id as the key. New rows get a
--     random key by DEFAULT, so the morning batch (api/send-daily.js inserts
--     ideas without one) and older app versions still get a key.
--   * a UNIQUE index on (brand_id, client_key) for each table — the target the
--     app's upsert names (onConflict: 'brand_id,client_key').
--   * ideas.first_created_at: when the idea was first written (a trigger keeps it; see 1b). Backfilled from
--     created_at — the best date there is, because until v720 every save
--     re-inserted the rows, so created_at was the LAST save. New rows get now()
--     by default; the app never sends this column, so a save never overwrites it.
--   * an UPDATE policy on notebook_notes for the brand's owner and members (it
--     never had one: an edited note was saved by delete + re-insert). Same rule
--     as the other brand tables' "Members can update" policies (v658), plus a
--     WITH CHECK so a note cannot be moved to another brand.
--
-- ONE NEW FUNCTION: the ideas_v720_touch trigger (1b), which lets the database, not the phone's clock,
-- stamp created_at. gen_random_uuid() is built into PostgreSQL 13+.
-- The other RLS policies are unchanged: a new column is covered by the
-- existing row policies. DELETE stays owner-only (sql/v658-member-delete.sql).
--
-- SAFE TO RUN TWICE: add column if not exists, backfill only where null,
-- create index if not exists, drop policy if exists + create.
-- Each table is one DO block, so it runs in one transaction: rows inserted by
-- other sessions wait for it, and none can slip in without a key.
--
-- THE APP WORKS BEFORE AND AFTER THIS RUNS. Before: the rows carry no
-- client_key, so the app keeps the old save. After: the next load switches
-- to the keyed save by itself.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 of 3 — ideas: client_key + first_created_at + the unique key
-- ---------------------------------------------------------------------------
do $$
begin
  alter table public.ideas add column if not exists client_key text;
  alter table public.ideas add column if not exists first_created_at timestamptz;
  -- defaults first, then the backfill: inside this one transaction no row can be left without a key
  alter table public.ideas alter column client_key set default gen_random_uuid()::text;
  alter table public.ideas alter column first_created_at set default now();
  update public.ideas set client_key = id::text where client_key is null;
  update public.ideas set first_created_at = coalesce(created_at, now()) where first_created_at is null;
  create unique index if not exists ideas_brand_client_key_uniq on public.ideas (brand_id, client_key);
end $$;

-- ---------------------------------------------------------------------------
-- 1b — ideas: the DATABASE stamps created_at on a changed row; first_created_at is kept.
-- Until v720 every save re-inserted the rows, so created_at was "last saved" by the database clock,
-- and api/send-daily.js, api/fact-pack.js and api/pull-trends-cron.js read it that way (activity).
-- A keyed save UPDATES rows instead, and PostgREST cannot send now() in an update, so this trigger
-- keeps both meanings: created_at = now() whenever anything else in the row changed, and
-- first_created_at can never be overwritten once set. The one unavoidable function in this file:
-- a trigger function (callable only as a trigger), not SECURITY DEFINER, search_path pinned, and
-- EXECUTE revoked from PUBLIC below and in sql/v658-revoke-security-health.sql.
-- ---------------------------------------------------------------------------
create or replace function public.ideas_v720_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if old.first_created_at is not null then
    new.first_created_at := old.first_created_at;
  end if;
  if (to_jsonb(new) - 'created_at' - 'first_created_at') is distinct from
     (to_jsonb(old) - 'created_at' - 'first_created_at') then
    new.created_at := now();
  end if;
  return new;
end
$fn$;

do $$
begin
  revoke all on function public.ideas_v720_touch() from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.ideas_v720_touch() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on function public.ideas_v720_touch() from authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.ideas_v720_touch() to service_role; end if;
end $$;

drop trigger if exists ideas_v720_touch_trg on public.ideas;
create trigger ideas_v720_touch_trg before update on public.ideas
  for each row execute function public.ideas_v720_touch();

comment on column public.ideas.client_key is
  'v720: stable per-idea key the app upserts on (brand_id, client_key). Existing rows: their id. New rows: random by default.';
comment on column public.ideas.first_created_at is
  'v720: when the idea was first written. Never sent by a save. created_at stays "last saved".';


-- ---------------------------------------------------------------------------
-- 2 of 3 — the four list tables: client_key + the unique key
-- ---------------------------------------------------------------------------
do $$
declare
  tbl text;
begin
  foreach tbl in array array['notebook_notes', 'remixes', 'product_refs', 'prompt_history']
  loop
    if to_regclass('public.' || tbl) is null then
      raise notice 'v720: % does not exist — skipping', tbl;
      continue;
    end if;
    execute format('alter table public.%I add column if not exists client_key text', tbl);
    execute format('alter table public.%I alter column client_key set default gen_random_uuid()::text', tbl);
    execute format('update public.%I set client_key = id::text where client_key is null', tbl);
    execute format('create unique index if not exists %I on public.%I (brand_id, client_key)', tbl || '_brand_client_key_uniq', tbl);
    raise notice 'v720: % — client_key ready', tbl;
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- 3 of 3 — notebook_notes: an UPDATE policy (an edited note is now an update)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.notebook_notes') is not null then
    drop policy if exists "Members can update notebook_notes" on public.notebook_notes;
    create policy "Members can update notebook_notes" on public.notebook_notes
      for update using (brand_id in (select user_brand_ids()))
      with check (brand_id in (select user_brand_ids()));
  end if;
end $$;

-- Tell PostgREST about the new columns now, not on its next schema refresh.
notify pgrst, 'reload schema';


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = every table has its key, no row lacks one,
-- and the unique index the app upserts on exists.
-- ============================================================================
with t(tbl) as (
  values ('ideas'), ('notebook_notes'), ('remixes'), ('product_refs'), ('prompt_history')
)
select t.tbl as problem, 'no client_key column' as detail
from t
where to_regclass('public.' || t.tbl) is not null
  and not exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = t.tbl and c.column_name = 'client_key')
union all
select t.tbl, 'no unique index on (brand_id, client_key) — the app''s upsert would fail'
from t
where to_regclass('public.' || t.tbl) is not null
  and not exists (select 1 from pg_indexes i
                  where i.schemaname = 'public' and i.tablename = t.tbl
                    and i.indexdef ilike '%unique%' and i.indexdef ilike '%(brand_id, client_key)%')
union all
select 'ideas', 'no first_created_at column'
where not exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = 'ideas' and c.column_name = 'first_created_at')
union all
select 'notebook_notes', 'no UPDATE policy — an edited note cannot be saved'
where to_regclass('public.notebook_notes') is not null
  and not exists (select 1 from pg_policies p
                  where p.schemaname = 'public' and p.tablename = 'notebook_notes' and p.cmd in ('UPDATE', 'ALL'))
order by 1, 2;
