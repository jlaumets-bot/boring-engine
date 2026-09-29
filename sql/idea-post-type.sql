-- types — what each idea is ABOUT (.unlazy/types/PLAN.md): one of six post types.
--
-- WHY
--   "What's today's post about?" is a first-class choice now: tip / about / news / qna / story / bts.
--   api/generate-ideas.js returns idea.postType on every idea; the app (and api/send-daily.js for the
--   morning batch) save it here so the Ideas list can show and filter by type.
--
-- SAFE TO RUN TWICE. Nullable, no default, no backfill: older rows read as "no type" (the app shows
-- them as Tip, which is what they were). The CHECK is added only if it is not there yet. RLS
-- policies and the pin_brand_id_trg trigger are unchanged (a new column is covered by the table's
-- existing row policies). The app and send-daily work before and after this runs: an insert that
-- PostgREST refuses for the unknown column is retried without it, like emphasis and gen_flow.

alter table public.ideas
  add column if not exists post_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ideas_post_type_check'
       and conrelid = 'public.ideas'::regclass
  ) then
    alter table public.ideas
      add constraint ideas_post_type_check
      check (post_type is null or post_type in ('tip', 'about', 'news', 'qna', 'story', 'bts'));
  end if;
end
$$;

comment on column public.ideas.post_type is
  'What the post is about: tip | about | news | qna | story | bts. NULL = saved before post types existed (shown as tip).';

-- Tell PostgREST to pick up the new column now rather than on its next refresh.
notify pgrst, 'reload schema';
