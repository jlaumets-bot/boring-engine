-- Distribution layer (additive) — per-brand channel connections.
-- Tokens are stored ENCRYPTED (AES-256-GCM, see api/_publish/crypto.js) and are
-- ONLY ever read/decrypted by serverless functions using the service-role key.
-- The browser never reads this table directly (RLS denies anon); it goes through
-- /api/connections.js which masks secrets.

create table if not exists brand_connections (
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references brands(id) on delete cascade,
  channel_type    text not null check (channel_type in ('publer','wordpress','wix','webhook')),
  label           text,
  credentials_enc text not null,                 -- AES-256-GCM blob (base64)
  account_map     jsonb not null default '{}'::jsonb,  -- publer: {workspaceId, accounts:[{id,provider,name}]}
  status          text not null default 'active',
  is_test         boolean not null default false,      -- SAFE FIRST TEST: secondary/test target
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_bc_brand on brand_connections(brand_id);

-- RLS ON with NO anon policies => browser (anon key) cannot read/write this table.
-- The service role used by /api functions bypasses RLS.
alter table brand_connections enable row level security;
