-- v678 — store the SUBSCRIBER'S TIMEZONE NAME, not just today's offset.
--
-- WHY: push_subscriptions.tz_offset_min is a snapshot taken the last time the app was open,
-- and nothing refreshes it unless the person opens the app. So on a DST changeover the row
-- still carries the previous day's offset and the daily ping arrives an hour early or an hour
-- late — measured against the real Europe/London zone: 2026-10-25 a 09:00 ping lands at 08:00;
-- 2026-03-29 it lands at 10:00. Sunday morning is exactly when nobody has opened the app.
--
-- A zone NAME ("Europe/Tallinn") never goes stale, so api/send-daily.js can work out the real
-- offset for the day it is actually sending. tz_offset_min stays as the fallback for rows
-- written before this and for any browser without Intl.
--
-- SAFE TO RUN TWICE. Nullable, no default, no backfill: existing rows keep working exactly as
-- they do today until their owner next opens the app, which fills the name in.

alter table public.push_subscriptions
  add column if not exists tz_name text;

comment on column public.push_subscriptions.tz_name is
  'IANA timezone name from the browser (Intl.DateTimeFormat().resolvedOptions().timeZone). '
  'Preferred over tz_offset_min, which is a snapshot and drifts across DST.';
