-- Brand Notebook: raw brand thoughts/ideas/notes. Run once in Supabase SQL editor.
create table if not exists notebook_notes (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  text text,
  created_at timestamptz default now()
);
alter table notebook_notes enable row level security;
create policy "notebook insert" on notebook_notes for insert with check (true);
create policy "notebook select" on notebook_notes for select using (true);
create policy "notebook delete" on notebook_notes for delete using (true);
