-- Taste signals: how users rewrite generated drafts. Run once in Supabase SQL editor.
create table if not exists edit_signals (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  format text,
  field text,
  before_text text,
  after_text text,
  created_at timestamptz default now()
);
alter table edit_signals enable row level security;
create policy "edit_signals insert own brand" on edit_signals for insert with check (true);
create policy "edit_signals select own brand" on edit_signals for select using (true);
