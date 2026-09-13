-- Daily idea notification subscriptions
-- Run once in Supabase SQL editor
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  brand_id uuid,
  subscription jsonb not null,
  send_hour int not null default 9,        -- local hour 0-23 chosen by the user
  tz_offset_min int not null default 0,    -- JS getTimezoneOffset() at subscribe time
  last_sent_at timestamptz,
  created_at timestamptz default now()
);

alter table push_subscriptions enable row level security;

create policy "own subs select" on push_subscriptions
  for select using (auth.uid() = user_id);
create policy "own subs insert" on push_subscriptions
  for insert with check (auth.uid() = user_id);
create policy "own subs update" on push_subscriptions
  for update using (auth.uid() = user_id);
create policy "own subs delete" on push_subscriptions
  for delete using (auth.uid() = user_id);
