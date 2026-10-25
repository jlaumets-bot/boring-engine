-- v706 — fact pack (.unlazy/quality/PLAN.md, Agent F): checked outside facts a writer may cite.
--
-- WHAT
--   1. One jsonb column on brands:
--        brands.fact_pack = { rev, updatedAt, lastSearchAt, facts: [{ id:'F1', text, url, title, topic, fetchedAt }] }
--      Written ONLY by api/fact-pack.js with the service role (weekly cron, the owner's "Refresh facts",
--      removing a fact), after every fact was checked against its source page. Read by api/_brandctx.js
--      (bc.facts) and by the app (Settings > Brand brain > Fact pack), which loads brands with select('*').
--   2. A trigger that makes the column SERVER-ONLY. The brands UPDATE policy lets the owner and every
--      member update the whole row (team-tables.sql), and brands_pin_ownership only pins user_id and
--      gemini_key_enc. Without this, an owner could null lastSearchAt and loop paid refreshes, and a
--      member could plant "checked" facts that writers would then state as true.
--      A client (role anon / authenticated) that changes fact_pack is SILENTLY kept on the old value,
--      and a client INSERT always stores NULL — silent, not an error, so a normal brand save that
--      carries the row back unchanged (or with a stale copy) keeps working. Same choice and reason as
--      user_id in brands_pin_ownership (security-fixes-batch2.sql).
--      The service role and a session with no JWT (the SQL editor) are not clients and write freely.
--
-- SAFE TO RUN TWICE: add column if not exists, create or replace function, drop trigger if exists.
-- No new table or policy: the column is covered by the brands table's EXISTING row policies, so it is
-- visible to exactly who can already read the brand. After this file, RE-RUN
-- sql/v658-revoke-security-health.sql (it names brands_pin_fact_pack; this file also locks it down).

alter table public.brands
  add column if not exists fact_pack jsonb;

comment on column public.brands.fact_pack is
  'Checked facts for writers: {rev, updatedAt, lastSearchAt, facts:[{id,text,url,title,topic,fetchedAt}]}. Server-only (brands_pin_fact_pack_trg). NULL = no pack yet.';

create or replace function public.brands_pin_fact_pack()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'));
begin
  -- Only a CLIENT is pinned: PostgREST runs a client request as the anon / authenticated role.
  if not (current_user in ('anon', 'authenticated') or coalesce(v_jwt_role, '') in ('anon', 'authenticated')) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.fact_pack := null;                      -- a client can never seed a pack
  elsif new.fact_pack is distinct from old.fact_pack then
    new.fact_pack := old.fact_pack;             -- a client can never change one (silently kept)
  end if;

  return new;
end;
$fn$;

drop trigger if exists brands_pin_fact_pack_trg on public.brands;
create trigger brands_pin_fact_pack_trg
  before insert or update on public.brands
  for each row execute function public.brands_pin_fact_pack();

-- A trigger function is not meant to be called; take it off PostgreSQL's default PUBLIC EXECUTE grant
-- (the v658 rule for every function in sql/**). Triggers still fire: EXECUTE is checked when the
-- trigger is created, not when it fires.
do $$
declare
  v_role text;
begin
  execute 'revoke all on function public.brands_pin_fact_pack() from public';
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on function public.brands_pin_fact_pack() from %I', v_role);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.brands_pin_fact_pack() to service_role';
  end if;
end
$$;

-- Tell PostgREST to pick up the new column now rather than on its next refresh.
notify pgrst, 'reload schema';
