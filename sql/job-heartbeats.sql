-- ============================================================
-- job-heartbeats.sql  —  cron liveness tracking
--
-- One row per scheduled job, upserted on each SUCCESSFUL run. /api/health reads
-- this so a cron that silently dies (or was never deployed) surfaces in the
-- daily health check instead of failing quietly for days.
--
-- Backend-only: written exclusively by the service role from the cron handlers.
-- RLS is ON with NO client policies (deny-all to end users), same posture as
-- brand_connections. Because it is deny-all-by-design it is allowlisted in
-- api/health.js (ZERO_POLICY_ALLOWED) so the isolation audit does not flag it.
-- It has no brand_id column, so it is not a brand-scoped table.
--
-- Safe + idempotent. Run once in the Supabase SQL editor.
-- ============================================================

create table if not exists public.job_heartbeats (
  job              text primary key,
  last_success_at  timestamptz not null default now(),
  last_status      text,
  detail           jsonb
);

alter table public.job_heartbeats enable row level security;

-- Service role bypasses RLS; grant explicit DML for clarity. No policies for
-- anon/authenticated => users can never read or write this table.
grant select, insert, update on public.job_heartbeats to service_role;
