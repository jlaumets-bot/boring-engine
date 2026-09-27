-- v693 — Content Lab: the owner's blind test of three writers (PLAN.md C-SQL-2).
--
-- WHY
--   content-v2 rebuilt how posts are written. api/blind-test.js runs the same inputs through the
--   old remix, the new flow on Grok (effort high) and the new flow on Claude, shows the outputs
--   under random labels, and records which one the owner picks. This table holds one test per row.
--
-- WHO READS / WRITES IT
--   Only api/blind-test.js, with the service role, after its own checks (CONTENT_LAB_USER_IDS +
--   userCanAccessBrand). RLS is ON with NO policies, so a signed-in client can neither read the
--   hidden arm names nor write a pick directly — the service role bypasses RLS, nobody else gets in.
--
-- THE FUNCTIONS
--   Each runCell request writes ONE cell. Rewriting the whole `cells` array from a copy read three
--   minutes earlier would erase a cell another request finished in the meantime, so the endpoint
--   changes one element in place with jsonb_set. Same for a pick. blind_test_set_cell also CLAIMS a
--   cell before it runs, so a cell is never run twice at once. SECURITY INVOKER, service role only.
--
-- SAFE TO RUN TWICE. "if not exists" / "or replace" throughout. Deleting a brand deletes its tests.

create table if not exists public.blind_tests (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid,
  brand_id    uuid references public.brands(id) on delete cascade,
  inputs      jsonb not null default '[]'::jsonb,
  arms        jsonb not null default '[]'::jsonb,
  cells       jsonb not null default '[]'::jsonb,
  picks       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

-- v693 r3 — when the owner pressed Reveal. Until it is set the endpoint shows no writer names, even
-- with every pick made. `reset` clears it (and reshuffles the labels).
alter table public.blind_tests add column if not exists revealed_at timestamptz;

-- v693 r4 — the label generation. `reset` reshuffles the letters and bumps this in the same UPDATE; a
-- pick or a reveal carries the generation it was made in and is stored only if it still matches.
alter table public.blind_tests add column if not exists generation int not null default 0;

-- The list view: one user's tests, newest first.
create index if not exists blind_tests_created_by_idx
  on public.blind_tests (created_by, created_at desc);

alter table public.blind_tests enable row level security;
-- No policies on purpose (service role only). Belt and braces for the API roles:
revoke all on table public.blind_tests from anon, authenticated;

-- ONE function writes a cell, two ways:
--   p_claim = false (default): put p_cell at p_index (a finished result), keeping the stored label
--     and index (v693 r3).
--   p_claim = true  (v693 r2): CLAIM the cell before running it — mark it 'running' only if it is
--     claimable, in the same UPDATE that checks it, so two requests for one cell cannot both run
--     (and pay for) it. Claimable: pending or error; done only with p_force; running only when it
--     started more than 330s ago (longer than the 300s function limit, so that run is dead).
-- Returns true when a row was changed, null when not. The earlier 3-argument version is dropped
-- first so PostgREST never sees two candidates for the same call.
drop function if exists public.blind_test_set_cell(uuid, int, jsonb);
create or replace function public.blind_test_set_cell(
  p_id uuid, p_index int, p_cell jsonb, p_claim boolean default false, p_force boolean default false)
returns boolean
language sql
security invoker
set search_path = public
as $$
  update public.blind_tests
     set cells = jsonb_set(
           cells, array[p_index::text],
           case when p_claim
                then (cells -> p_index) || jsonb_build_object(
                       'status', 'running',
                       'startedAt', (extract(epoch from clock_timestamp()) * 1000)::bigint)
                else p_cell || jsonb_build_object('index', cells -> p_index -> 'index',
                                                  'label', cells -> p_index -> 'label')
           end,
           false)
   where id = p_id
     and jsonb_typeof(cells) = 'array'
     and p_index >= 0
     and p_index < jsonb_array_length(cells)
     -- v693 r3 — identity guard: `reset` renumbers cells, so only write if the cell at p_index is still
     -- the same one (same input, same writer). p_cell carries that identity in both modes.
     and (p_cell is null
          or (cells -> p_index ->> 'inputIndex' = p_cell ->> 'inputIndex'
              and cells -> p_index ->> 'arm' = p_cell ->> 'arm'))
     and (not p_claim
          or coalesce(cells -> p_index ->> 'status', 'pending') in ('pending', 'error')
          or (p_force and cells -> p_index ->> 'status' = 'done')
          or (cells -> p_index ->> 'status' = 'running'
              and coalesce((cells -> p_index ->> 'startedAt')::bigint, 0)
                  < (extract(epoch from clock_timestamp()) * 1000)::bigint - 330000))
  returning true;
$$;

-- v693 r4 — a pick is stored only in the generation it was made in, only before the reveal, and
-- only while some input still has no pick (picks are final once complete). The old 3-argument
-- version is dropped first so PostgREST never sees two candidates.
drop function if exists public.blind_test_set_pick(uuid, int, text);
create or replace function public.blind_test_set_pick(p_id uuid, p_input int, p_label text, p_generation int)
returns boolean
language sql
security invoker
set search_path = public
as $$
  update public.blind_tests
     set picks = jsonb_set(coalesce(picks, '{}'::jsonb), array[p_input::text], to_jsonb(p_label), true)
   where id = p_id
     and generation = p_generation
     and revealed_at is null
     and p_input >= 0
     and p_input < jsonb_array_length(inputs)
     and exists (
       select 1 from generate_series(0, jsonb_array_length(inputs) - 1) as g(i)
        where coalesce(picks ->> g.i::text, '') = '')
  returning true;
$$;

-- v693 r4 — reset in ONE step: write the reshuffled cells only if the cells are exactly what the
-- caller read (so a claim or a finished result that landed in between is never wiped), no cell is
-- being written right now (running and started within 330s), and the generation is unchanged. Clears
-- the picks and the reveal and bumps the generation. Returns the new generation, or null.
create or replace function public.blind_test_reset(p_id uuid, p_old_cells jsonb, p_new_cells jsonb, p_generation int)
returns int
language sql
security invoker
set search_path = public
as $$
  update public.blind_tests
     set cells = p_new_cells,
         picks = '{}'::jsonb,
         revealed_at = null,
         generation = generation + 1
   where id = p_id
     and generation = p_generation
     and cells = p_old_cells
     and jsonb_typeof(p_new_cells) = 'array'
     and jsonb_array_length(p_new_cells) = jsonb_array_length(cells)
     and not exists (
       select 1 from jsonb_array_elements(cells) as e(c)
        where e.c ->> 'status' = 'running'
          and coalesce((e.c ->> 'startedAt')::bigint, 0)
              >= (extract(epoch from clock_timestamp()) * 1000)::bigint - 330000)
  returning generation;
$$;

-- v693 r4 — reveal in ONE step: only if not yet revealed, every input has a pick, and the generation
-- is the one the caller read. A reset that lands first makes this return null (the endpoint says 409).
create or replace function public.blind_test_reveal(p_id uuid, p_generation int)
returns boolean
language sql
security invoker
set search_path = public
as $$
  update public.blind_tests
     set revealed_at = now()
   where id = p_id
     and revealed_at is null
     and generation = p_generation
     and jsonb_array_length(inputs) > 0
     and not exists (
       select 1 from generate_series(0, jsonb_array_length(inputs) - 1) as g(i)
        where coalesce(picks ->> g.i::text, '') = '')
  returning true;
$$;

revoke all on function public.blind_test_set_cell(uuid, int, jsonb, boolean, boolean) from public, anon, authenticated;
revoke all on function public.blind_test_set_pick(uuid, int, text, int) from public, anon, authenticated;
revoke all on function public.blind_test_reset(uuid, jsonb, jsonb, int) from public, anon, authenticated;
revoke all on function public.blind_test_reveal(uuid, int) from public, anon, authenticated;
grant execute on function public.blind_test_set_cell(uuid, int, jsonb, boolean, boolean) to service_role;
grant execute on function public.blind_test_set_pick(uuid, int, text, int) to service_role;
grant execute on function public.blind_test_reset(uuid, jsonb, jsonb, int) to service_role;
grant execute on function public.blind_test_reveal(uuid, int) to service_role;

-- PostgREST caches the schema; without this the new table and functions answer 404 until it reloads.
notify pgrst, 'reload schema';
