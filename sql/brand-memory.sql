-- v693 — brand memory: the founder's own stories, beliefs and speech samples.
--
-- WHY
--   The writers invented numbers, names and cases because nothing held the founder's real ones.
--   content-v2 asks for a missing story as a 20-second voice note, keeps the angle the user
--   picked as a belief, and keeps take transcripts as samples of how they actually talk. This
--   table is where those live, so every later writer can reuse them (api/_brandctx.js loads them
--   into bc.beliefs / bc.stories / bc.speechSamples; api/brand-memory.js reads and writes them).
--
-- SERVICE ROLE ONLY — NO CLIENT POLICIES (v693 round 4).
--   app.html never touches this table directly; every read, add and delete goes through
--   api/brand-memory.js, which checks access itself and uses the service role (which bypasses
--   RLS). An earlier version of this file gave members INSERT: with the public anon key any
--   member could then write straight to /rest/v1/brand_memory, skip every length and count limit,
--   and set created_by to the OWNER's id — and the loader puts the owner's speech first, so forged
--   rows became "the owner's voice". RLS is on and there are no policies, so a signed-in client can
--   neither read nor write a single row. The drops below remove the policies an earlier run made.
--
-- LIMITS THE DATABASE ENFORCES (the API enforces the same ones first, with friendlier errors):
--   * kind is story, belief or speech; text is 1..140 (belief), 1..600 (story), 1..800 (speech);
--   * at most 50 beliefs and 200 stories per brand — a BEFORE INSERT trigger that takes a
--     per-brand-per-kind transaction lock BEFORE it counts, so two simultaneous adds are counted
--     one after the other and can never both land past the cap (the app-side recount could not
--     promise that: two transactions that commit in the opposite order both see themselves inside
--     the cap). Speech has no count cap here; the API prunes it to the newest 20 per person.
--
-- SAFE TO RUN TWICE. Table and indexes are "if not exists"; constraints are added only when
-- missing; the function is "create or replace" and the trigger is dropped then created.
-- Brand deletion cascades to its rows.

create table if not exists public.brand_memory (
  id          uuid primary key default gen_random_uuid(),
  brand_id    uuid not null references public.brands(id) on delete cascade,
  kind        text not null check (kind in ('story', 'belief', 'speech')),
  text        text not null,
  tags        text[] not null default '{}',
  meta        jsonb not null default '{}',
  created_by  uuid,
  created_at  timestamptz not null default now()
);

-- The one read every writer makes: this brand's items, newest first (optionally one kind).
create index if not exists brand_memory_brand_kind_created_idx
  on public.brand_memory (brand_id, kind, created_at desc);

-- The same belief twice is one belief. api/brand-memory.js checks first; this makes a
-- double-tap race land on the existing row instead of a second copy.
create unique index if not exists brand_memory_belief_once_idx
  on public.brand_memory (brand_id, lower(text)) where kind = 'belief';

alter table public.brand_memory enable row level security;

-- Every policy any earlier version of this file created. None is re-created.
drop policy if exists "brand_memory select member" on public.brand_memory;
drop policy if exists "brand_memory insert member" on public.brand_memory;
drop policy if exists "brand_memory delete member" on public.brand_memory;
drop policy if exists "brand_memory delete owner" on public.brand_memory;

-- Text length per kind. Added only if missing. If rows already break it (possible only through the
-- client INSERT policy removed above — the API always capped), NOTHING IS DELETED: the constraint is
-- added NOT VALID, which enforces it on every new or changed row and leaves the old rows as they
-- are, and a NOTICE says how many. `validate constraint brand_memory_text_len` later, once handled.
do $$
declare
  v_bad integer;
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'brand_memory_text_len' and conrelid = 'public.brand_memory'::regclass) then
    select count(*) into v_bad from public.brand_memory
     where char_length(text) < 1
        or char_length(text) > case kind when 'belief' then 140 when 'story' then 600 else 800 end;
    if v_bad = 0 then
      alter table public.brand_memory add constraint brand_memory_text_len
        check (char_length(text) between 1 and case kind when 'belief' then 140 when 'story' then 600 else 800 end);
    else
      raise notice 'brand_memory: % row(s) break the length limits; constraint added NOT VALID, no row changed', v_bad;
      alter table public.brand_memory add constraint brand_memory_text_len
        check (char_length(text) between 1 and case kind when 'belief' then 140 when 'story' then 600 else 800 end) not valid;
    end if;
  end if;
end $$;

-- The count cap. SECURITY INVOKER (the default): the only writer is the service role, which sees
-- every row. The lock is a transaction-level advisory lock on (brand, kind): a second add for the
-- same brand and kind WAITS here until the first one commits or rolls back, then counts it.
-- The caps must match KIND_MAX in api/brand-memory.js (scripts/verify/rv2-memory-1.mjs checks).
create or replace function public.brand_memory_enforce_cap()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_max   integer;
  v_count integer;
begin
  v_max := case new.kind when 'belief' then 50 when 'story' then 200 else null end;
  if v_max is null then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('brand_memory:' || new.brand_id::text), hashtext(new.kind));
  select count(*) into v_count from public.brand_memory
   where brand_id = new.brand_id and kind = new.kind;
  if v_count >= v_max then
    raise exception 'brand_memory_full' using errcode = 'P0001', detail = v_max::text,
      hint = 'This brand already holds ' || v_count || ' ' || new.kind || ' items (max ' || v_max || ').';
  end if;
  return new;
end
$fn$;

drop trigger if exists brand_memory_enforce_cap_trg on public.brand_memory;
create trigger brand_memory_enforce_cap_trg
  before insert on public.brand_memory
  for each row execute function public.brand_memory_enforce_cap();

-- PostgREST caches the schema; without this the new table answers PGRST205 until it reloads.
notify pgrst, 'reload schema';
