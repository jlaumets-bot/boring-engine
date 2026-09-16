-- v665 — edit_signals learns WHO wrote the text and WHICH post it came from.
--
-- WHY
--   Two columns, both fixing the same class of bug: the brand brain treating the model's own
--   output as the founder's voice, and the app's most visible post never seeing the voice at all.
--
--   authored_by — Sharpen and Viral twist record a taste signal whose `after` is the MODEL's
--     rewrite. getApprovedExamples matched that text back against the approved post and marked the
--     post human-rewritten, which handed it to the model under "THE BRAND'S OWN WORDS — beats every
--     description of the voice above". The model was being trained on its own output, at the
--     strongest position in the prompt, and it got worse every time someone tapped Sharpen.
--     app.html now tags those signals; this column makes the tag durable so the SERVER can filter
--     them too. NULL means a person typed it — every row written before today is therefore treated
--     as human, which is the conservative reading of data that predates the tag.
--
--   title — which posts the founder REWROTE was knowledge only the writing device held. The server
--     could learn it only from `humanEditedTitles` in a request body, so api/send-daily.js — the
--     one post the app pushes unprompted every day, with no client to send anything — always fell
--     back to the weaker "these were machine-written" heading, and a second device knew nothing
--     about rewrites made on the first. With the title stored, api/_brandctx.js looks the post up
--     by name exactly as the client's own list does.
--
-- SAFE TO RUN TWICE. Both columns are added only if missing; no existing row is modified, and
-- nothing here changes a policy or a grant.
--
-- The app does NOT require this to have been run: the insert retries without the two columns if
-- PostgREST rejects them, and the server's read falls back to the unfiltered query. Running it is
-- what turns the fix on.

alter table public.edit_signals add column if not exists authored_by text;
alter table public.edit_signals add column if not exists title       text;

comment on column public.edit_signals.authored_by is
  'Who wrote after_text. NULL = a person typed it (evidence of voice). ''ai'' = the model rewrote it '
  '(Sharpen / Viral twist) — a taste signal, NOT evidence of how the brand writes.';
comment on column public.edit_signals.title is
  'Title of the post this edit was made on, so the brand-context loader can fetch the rewritten post by name.';

-- The read this enables: brand_id = ?, authored_by is null, title not null, newest 40.
create index if not exists edit_signals_brand_created_idx
  on public.edit_signals (brand_id, created_at desc);

do $$
begin
  raise notice 'v665: edit_signals.authored_by + edit_signals.title added (idempotent)';
end $$;
