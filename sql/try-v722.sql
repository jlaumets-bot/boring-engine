-- v722 — PUBLIC LANDING READER storage (api/try-transcript.js, .unlazy/landing/CONTRACT.md).
--
-- try_transcript_cache  one row per video ('tt:<tiktok id>' | 'yt:<youtube id>'): its exact spoken words, so the
--                       same video is never paid for twice. Written and read by api/try-transcript.js AND by
--                       api/transcribe-url.js (signed-in reads fill and use it too).
-- try_read_slots        the daily caps, as numbered slots. PRIMARY KEY (day, bucket, slot) is the whole
--                       concurrency control: a read must INSERT a free slot number before it may spend money, and
--                       the database refuses a duplicate, so a bucket can never hold more than its cap — parallel
--                       requests and reads still in flight included. Buckets: 'g' = everyone's paid attempts
--                       (default 300/day), 'gf' = everyone's failed reads (default 200/day), 'v:<sha256>' = one
--                       visitor's successful reads (3/day), 'f:<sha256>' = one visitor's failed reads (10/day),
--                       'h:<sha256>' = one visitor's free answers (30/day). <sha256> = SHA-256(server salt, IP, UTC
--                       date): no IP is ever stored. status 'held' while a read runs, 'done' when it is counted.
--                       A read that fails before any provider call deletes its rows; after one, 'g' stays.
--                       The 'g' rows are the usage record for anonymous reads: video_id + cost_eur (estimate).
-- try_transcript_misses one row per video that failed for its OWN reason (no_words, no_captions, too_long,
--                       unavailable). Answered free for 24 h (created_at) without calling any provider.
--                       Daily spend: select day, count(*), sum(cost_eur) from try_read_slots
--                                    where bucket = 'g' and status = 'done' group by day;
--
-- ALL THREE ARE SERVER-ONLY. The API uses the service role (bypasses RLS). RLS is ON with NO policy, and anon /
-- authenticated have no grants at all: no browser can read or write any of them. api/health.js lists all three in
-- ZERO_POLICY_ALLOWED (deny-all by design, like creator_feed_state).
-- No functions are defined here (scripts/verify/invite-link-owner-delete.mjs requires every sql/** function to be
-- named in sql/v658-revoke-security-health.sql).
--
-- SAFE TO RUN TWICE: "if not exists" everywhere; constraints dropped then added.

create table if not exists public.try_transcript_cache (
  video_id      text primary key,
  transcript    text not null,
  creator       text,
  duration_sec  int,
  source        text not null default 'try',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.try_transcript_cache drop constraint if exists try_transcript_cache_key_chk;
alter table public.try_transcript_cache add constraint try_transcript_cache_key_chk
  check (video_id ~ '^(tt:[0-9]{5,25}|yt:[A-Za-z0-9_-]{11})$');
alter table public.try_transcript_cache drop constraint if exists try_transcript_cache_size_chk;
alter table public.try_transcript_cache add constraint try_transcript_cache_size_chk
  check (char_length(transcript) between 1 and 100000 and (creator is null or char_length(creator) <= 60));
alter table public.try_transcript_cache drop constraint if exists try_transcript_cache_source_chk;
alter table public.try_transcript_cache add constraint try_transcript_cache_source_chk
  check (source in ('try', 'app'));

create table if not exists public.try_read_slots (
  day        date not null,
  bucket     text not null,
  slot       int  not null,
  status     text not null default 'held',
  token      text not null,
  held_at    timestamptz not null default now(),
  done_at    timestamptz,
  video_id   text,
  cost_eur   numeric(10,4) not null default 0,
  primary key (day, bucket, slot)
);
alter table public.try_read_slots drop constraint if exists try_read_slots_shape_chk;
alter table public.try_read_slots add constraint try_read_slots_shape_chk
  check (status in ('held', 'done') and slot between 1 and 1000
         and (bucket in ('g', 'gf') or bucket ~ '^[vhf]:[0-9a-f]{64}$'));

create table if not exists public.try_transcript_misses (
  video_id    text primary key,
  outcome     text not null,
  created_at  timestamptz not null default now()
);
alter table public.try_transcript_misses drop constraint if exists try_transcript_misses_shape_chk;
alter table public.try_transcript_misses add constraint try_transcript_misses_shape_chk
  check (video_id ~ '^(tt:[0-9]{5,25}|yt:[A-Za-z0-9_-]{11})$'
         and outcome in ('no_words', 'no_captions', 'too_long', 'unavailable'));

alter table public.try_transcript_cache enable row level security;
alter table public.try_read_slots enable row level security;
alter table public.try_transcript_misses enable row level security;
-- RLS on and NO policy = nothing is visible or writable to anon/authenticated.

revoke all on public.try_transcript_cache from public, anon, authenticated;
revoke all on public.try_read_slots from public, anon, authenticated;
grant select, insert, update, delete on public.try_transcript_cache to service_role;
grant select, insert, update, delete on public.try_read_slots to service_role;
revoke all on public.try_transcript_misses from public, anon, authenticated;
grant select, insert, update, delete on public.try_transcript_misses to service_role;
