-- v693 — which writing flow produced each idea (PLAN.md C-SQL-3), and the filmed-rate count.
--
-- WHY
--   content-v2 saves the ideas it writes with gen_flow = 'v2'. Older ideas stay NULL and count as
--   'v1'. api/content-metrics.js compares the two by the one outcome that matters: how many
--   generated ideas were actually filmed (status filming or done).
--
-- SAFE TO RUN TWICE. Nullable, no default, no backfill: existing rows read as v1, which is what
-- they are. RLS policies and the pin_brand_id_trg trigger are unchanged (a new column is covered by
-- the table's existing row policies). The app works before and after this runs: a save PostgREST
-- refuses for an unknown column is retried without it, and the metrics endpoint counts everything
-- as v1 and says so.

alter table public.ideas
  add column if not exists gen_flow text;

comment on column public.ideas.gen_flow is
  'Which writing flow produced this idea: ''v2'' = content-v2 (angles -> write). NULL = the older flow (counted as v1).';

-- The one grouped query behind api/content-metrics.js. SECURITY INVOKER and callable by the
-- service role only; the endpoint checks brand access before calling it.
create or replace function public.content_metrics(p_brand_id uuid, p_since timestamptz)
returns table (flow text, generated bigint, filmed bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(i.gen_flow, 'v1') as flow,
         count(*) as generated,
         count(*) filter (where i.status in ('filming', 'done')) as filmed
    from public.ideas i
   where i.brand_id = p_brand_id
     and i.is_generated is true
     and (p_since is null or i.created_at >= p_since)
   group by 1;
$$;

revoke all on function public.content_metrics(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.content_metrics(uuid, timestamptz) to service_role;

-- Tell PostgREST to pick up the new column and function now rather than on its next refresh.
notify pgrst, 'reload schema';
