-- ============================================================
-- SECURITY FIX — Batch 1
-- Locks down two tables that were readable/writable by ANY logged-in user.
-- Safe to run in the Supabase SQL editor. Idempotent (drops old policies first).
-- Relies on the helper function user_brand_ids() defined in team-tables.sql.
-- ============================================================

-- ---------- edit_signals ----------
-- Before: insert/select used (true) → anyone could read/write anyone's edit history.
-- After:  scoped to brands the current user owns or is a member of.
drop policy if exists "edit_signals insert own brand" on edit_signals;
drop policy if exists "edit_signals select own brand" on edit_signals;

create policy "edit_signals select own brand" on edit_signals
  for select using (brand_id in (select user_brand_ids()));

create policy "edit_signals insert own brand" on edit_signals
  for insert with check (brand_id in (select user_brand_ids()));

-- ---------- notebook_notes ----------
-- Before: insert/select/delete used (true) → anyone could read/write/delete anyone's notes.
-- After:  scoped to the current user's brands.
drop policy if exists "notebook insert" on notebook_notes;
drop policy if exists "notebook select" on notebook_notes;
drop policy if exists "notebook delete" on notebook_notes;

create policy "notebook select" on notebook_notes
  for select using (brand_id in (select user_brand_ids()));

create policy "notebook insert" on notebook_notes
  for insert with check (brand_id in (select user_brand_ids()));

create policy "notebook delete" on notebook_notes
  for delete using (brand_id in (select user_brand_ids()));

-- ---------- helpful indexes (lookups are by brand_id) ----------
create index if not exists edit_signals_brand_id_idx on edit_signals(brand_id);
create index if not exists notebook_notes_brand_id_idx on notebook_notes(brand_id);
