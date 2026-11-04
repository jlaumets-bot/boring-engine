-- v711 — CREATOR FEED storage (api/creator-feed.js, .unlazy/creator-feed/CONTRACT.md).
--
-- creator_videos      the latest TikTok videos of the creators a brand follows, plus any transcript.
-- creator_feed_state  one row per brand: when the last Apify pull finished (the 24 h / 6 h cost guards),
--                     which creators it covered, the one-pull-at-a-time lock (lock_until, expires by
--                     itself), a run already paid for (run_id — re-read later, never bought twice; its cost
--                     is logged once: logged_run_id) and failures (failed_at, fail_count: 30 min, 6 h after 2).
--
-- BOTH ARE SERVER-WRITTEN ONLY. The API writes with the service role (bypasses RLS). Signed-in users
-- may READ their brands' videos (owner or member, the same user_brand_ids() rule as every brand table);
-- nobody but the service role can insert, update or delete, and creator_feed_state is not readable at all.
-- No functions are defined here (scripts/verify/invite-link-owner-delete.mjs requires every sql/**
-- function to be named in sql/v658-revoke-security-health.sql).
--
-- SAFE TO RUN TWICE: "if not exists" everywhere, policies dropped then created.

create table if not exists public.creator_videos (
  brand_id          uuid not null references public.brands(id) on delete cascade,
  video_id          text not null,
  handle            text not null,
  url               text not null,
  caption           text,
  views             bigint,
  likes             bigint,
  comments          bigint,
  shares            bigint,
  posted_at         timestamptz,
  duration_sec      int,
  cover             text,
  score             numeric not null default 0,
  transcript        text,
  transcript_status text not null default 'none',
  auto              boolean not null default false,
  transcribed_at    timestamptz,
  auto_tried_at     timestamptz,          -- a free weekly-winner attempt (counts toward 3 per ISO week, even if it failed)
  fetched_at        timestamptz not null default now(),
  primary key (brand_id, video_id)
);
alter table public.creator_videos add column if not exists auto_tried_at timestamptz;

-- 'working' = one transcript job holds the video (api/creator-feed.js claimVideo; transcribed_at = the claim time).
alter table public.creator_videos drop constraint if exists creator_videos_transcript_status_chk;
alter table public.creator_videos add constraint creator_videos_transcript_status_chk
  check (transcript_status in ('none', 'ready', 'failed', 'working'));

-- The one read the API makes: a brand's rows, newest pull first.
create index if not exists creator_videos_brand_fetched_idx on public.creator_videos (brand_id, fetched_at desc);

create table if not exists public.creator_feed_state (
  brand_id        uuid primary key references public.brands(id) on delete cascade,
  fetched_at      timestamptz,
  handles         text[] not null default '{}',
  lock_until      timestamptz,
  run_id          text,
  run_started_at  timestamptz,
  failed_at       timestamptz,
  fail_count      int not null default 0,   -- failed pulls in a row (2+ = wait 6 h)
  logged_run_id   text,                     -- the last Apify run whose cost is in usage_events (logged once per run)
  last_error      text,
  updated_at      timestamptz not null default now()
);
alter table public.creator_feed_state add column if not exists fail_count int not null default 0;
alter table public.creator_feed_state add column if not exists logged_run_id text;

alter table public.creator_videos enable row level security;
alter table public.creator_feed_state enable row level security;

drop policy if exists "creator_videos select member" on public.creator_videos;
create policy "creator_videos select member" on public.creator_videos
  for select using (brand_id in (select public.user_brand_ids()));
-- creator_feed_state: RLS on and NO policy = no row is visible or writable to anon/authenticated.

revoke all on public.creator_videos from anon, authenticated;
grant select on public.creator_videos to authenticated;
revoke all on public.creator_feed_state from anon, authenticated;
