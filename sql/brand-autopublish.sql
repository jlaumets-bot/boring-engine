-- Distribution layer (additive) — per-brand auto-publish feature flag (OFF by default).
-- Used by Phase 2 cron (/api/auto-publish). Created now so the schema is ready;
-- nothing reads it until the cron ships.

create table if not exists brand_autopublish (
  brand_id   uuid primary key references brands(id) on delete cascade,
  enabled    boolean not null default false,        -- master switch, OFF by default
  config     jsonb   not null default '{}'::jsonb,
  -- config shape:
  -- {
  --   "channels": ["<connection_id>", ...],     // which connected channels to use
  --   "cadence": "daily" | "0 9 * * *",          // when to run (cron or preset)
  --   "window": {"start":"08:00","end":"20:00","tz_offset_min":0},
  --   "postsPerRun": 1,
  --   "requireApproval": true,                    // default: post only from APPROVED pipeline
  --   "allowAutogenerate": false,                 // per-brand opt-in for fully hands-off generation
  --   "formats": ["statement","static","carousel","blog"]   // video/micro/qna are NEVER auto-posted
  -- }
  updated_at timestamptz not null default now()
);

alter table brand_autopublish enable row level security;
create policy ap_select on brand_autopublish for select using (
  exists (select 1 from brands b where b.id = brand_autopublish.brand_id and b.user_id = auth.uid())
  or exists (select 1 from brand_members m where m.brand_id = brand_autopublish.brand_id and m.user_id = auth.uid())
);
-- Writes via service-role function only.
