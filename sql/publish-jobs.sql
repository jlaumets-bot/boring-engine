-- Distribution layer (additive) — publish ledger + DEDUPE guard.
-- This table is the single source of truth for "what has been published where",
-- so the existing `ideas` / blog schemas and app flows are never touched.

create table if not exists publish_jobs (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid not null references brands(id) on delete cascade,
  source_type   text not null,                  -- 'idea' | 'blog'
  source_id     text not null,                  -- stable key: idea TITLE (matches saveIdeasToDB dedupe) or blog id
  channel_type  text not null,                  -- 'publer' | 'wordpress' | 'wix'
  connection_id uuid references brand_connections(id) on delete set null,
  target        text,                           -- network/provider e.g. 'instagram','facebook','wordpress'
  status        text not null default 'queued', -- queued|publishing|pending|published|scheduled|failed|skipped
  external_id   text,                           -- publer job/post id, wp post id, wix post id
  scheduled_for timestamptz,
  error         text,
  payload       jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists idx_pj_brand on publish_jobs(brand_id);
create index if not exists idx_pj_source on publish_jobs(brand_id, source_id);

-- HARD DEDUPE: a given source can occupy ONE in-flight/successful slot per channel.
-- The publisher INSERTs a 'publishing' claim row BEFORE any network call; the DB rejects
-- a second concurrent claim, so a double-fire (or the cron racing itself) can never
-- double-post. 'pending' (post may exist but unconfirmed) stays in the set so we never
-- re-post something that might already be live. Only 'failed'/'skipped' drop out so
-- genuine retries remain possible.
drop index if exists uq_publish_once;
create unique index uq_publish_once
  on publish_jobs(brand_id, source_id, channel_type)
  where status in ('publishing','pending','published','scheduled');

alter table publish_jobs enable row level security;
-- Brand owners/members may READ their own publish history (status only — no secrets here).
create policy pj_select on publish_jobs for select using (
  exists (select 1 from brands b where b.id = publish_jobs.brand_id and b.user_id = auth.uid())
  or exists (select 1 from brand_members m where m.brand_id = publish_jobs.brand_id and m.user_id = auth.uid())
);
-- Writes happen only via service-role functions (bypass RLS); no insert/update policy for anon.
