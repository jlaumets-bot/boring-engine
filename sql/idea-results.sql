-- content-v3 F2/F3 — what happened after posting, and which of the three hooks was used.
--
-- WHY
--   The writers only ever learned from "approved" (one tap on text the app wrote) and "filmed". The
--   one outcome that says a script worked is how the posted video actually did. The founder marks it
--   (Flopped / OK / Great, optional post link) through api/idea-result.js; api/_brandctx.js reads the
--   latest results back so the writers can lean on what worked and stop repeating what flopped.
--   F3: the writer returns three opening lines per script (hook_alts); the founder films all three
--   and says which one was posted (hook_used = its index in hook_alts).
--
-- COLUMNS (all nullable, no default, no backfill — existing rows read as "not marked yet")
--   result     text         'flop' | 'ok' | 'great'
--   result_at  timestamptz  when it was marked (set by api/idea-result.js)
--   post_url   text         the posted video's link: https only, at most 500 characters
--   hook_alts  jsonb        the three opening lines: a JSON array of at most 3 strings
--   hook_used  int          which of hook_alts was posted, 0..2; NULL = not known
--
-- SAFE TO RUN TWICE. Columns use "add column if not exists"; each CHECK is added only when a
-- constraint of that name is not already on the table (DO blocks below). The new columns are all
-- NULL, so the checks validate instantly.
--
-- POLICIES: NONE ADDED OR CHANGED. public.ideas already has a client UPDATE policy
-- ("Users can update own or member ideas", sql/team-tables.sql), and the pin_brand_id_trg trigger
-- (sql/v657-brand-pinning.sql) still pins brand_id; new columns are covered by the existing row
-- policies. api/idea-result.js writes with the service role after its own access check.
-- No function is created here.

alter table public.ideas add column if not exists result    text;
alter table public.ideas add column if not exists result_at timestamptz;
alter table public.ideas add column if not exists post_url  text;
alter table public.ideas add column if not exists hook_alts jsonb;
alter table public.ideas add column if not exists hook_used int;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ideas'::regclass and conname = 'ideas_result_check') then
    alter table public.ideas add constraint ideas_result_check
      check (result is null or result in ('flop', 'ok', 'great'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ideas'::regclass and conname = 'ideas_post_url_check') then
    alter table public.ideas add constraint ideas_post_url_check
      check (post_url is null or (char_length(post_url) <= 500 and post_url ~ '^https://'));
  end if;

  -- An array of at most 3 strings, and small (three 20-word lines fit in far less than 2,000 bytes).
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ideas'::regclass and conname = 'ideas_hook_alts_check') then
    alter table public.ideas add constraint ideas_hook_alts_check
      check (hook_alts is null or (
        jsonb_typeof(hook_alts) = 'array'
        and jsonb_array_length(hook_alts) <= 3
        and not jsonb_path_exists(hook_alts, '$[*] ? (@.type() != "string")')
        and octet_length(hook_alts::text) <= 2000));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.ideas'::regclass and conname = 'ideas_hook_used_check') then
    alter table public.ideas add constraint ideas_hook_used_check
      check (hook_used is null or hook_used between 0 and 2);
  end if;
end
$$;

comment on column public.ideas.result is
  'How the posted video did, as the founder marked it: flop | ok | great. NULL = not marked. Written by api/idea-result.js.';
comment on column public.ideas.result_at is 'When result was last marked.';
comment on column public.ideas.post_url is 'Link to the posted video (https, <= 500 chars). Optional.';
comment on column public.ideas.hook_alts is
  'The three opening lines the writer offered for this script (JSON array of <= 3 strings; index 0 = the hook).';
comment on column public.ideas.hook_used is 'Which hook_alts entry was posted (0..2). NULL = unknown.';

-- Tell PostgREST to pick up the new columns now rather than on its next schema-cache refresh.
notify pgrst, 'reload schema';
