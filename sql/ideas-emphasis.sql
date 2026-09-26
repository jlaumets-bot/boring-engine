-- v692 — keep the teleprompter's stress marks with the idea.
--
-- WHY: the generator returns `emphasis` — 2-5 short phrases copied verbatim from the script that
-- the teleprompter bolds while the person reads to camera. public.ideas had no column for it, so
-- the app could not save it: the marks existed only in the tab that generated the idea and were
-- gone after a reload or on any other device (the teleprompter fell back to its guesswork).
--
-- SAFE TO RUN TWICE. Nullable, no default, no backfill: existing rows read as "no marks", which
-- is exactly what they have today. RLS policies and the pin_brand_id_trg trigger are unchanged
-- (a new column is covered by the table's existing row policies).
-- The app works before and after this runs: loading ignores a missing column, and a save that
-- PostgREST refuses because the column is unknown is retried without the marks.

alter table public.ideas
  add column if not exists emphasis jsonb;

comment on column public.ideas.emphasis is
  'Teleprompter stress marks: JSON array of short phrases (<=120 chars, max 6) copied verbatim '
  'from the script/hook/caption/bold text. NULL or [] = none (the app falls back to its heuristic).';

-- Tell PostgREST to pick up the new column now rather than on its next schema-cache refresh.
notify pgrst, 'reload schema';
