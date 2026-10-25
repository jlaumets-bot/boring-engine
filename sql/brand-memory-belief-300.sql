-- v706 — brand memory: a belief (the "point" a post makes) may be up to 300 characters (was 140).
-- WHY: api/_write.js MAX_BELIEF is 300 now (.unlazy/quality/PLAN.md, "hard cuts lifted"). Until this
-- runs, api/brand-memory.js CAPS.belief and app.html rv2MemAdd stay at 140 = the database limit, so a
-- save never fails; a longer point is kept cut at a word boundary.
--
-- RUN ONCE in the Supabase SQL editor. SAFE TO RUN TWICE (drop if exists + add, in one transaction,
-- so there is no moment without a length check). Widening a limit cannot make an existing row
-- break it; the constraint is still added NOT VALID (enforced on every new or changed row, old rows
-- left as they are), the same rule sql/brand-memory.sql follows. No row is changed or deleted.
--
-- AFTER IT RAN: set CAPS.belief = 300 in api/brand-memory.js, 140 -> 300 in BOTH length checks of
-- sql/brand-memory.sql (scripts/verify/rv2-memory-1.mjs keeps them equal), and 140 -> 300 in
-- app.html rv2MemAdd (`kind === 'belief' ? 140`).
begin;
alter table public.brand_memory drop constraint if exists brand_memory_text_len;
alter table public.brand_memory add constraint brand_memory_text_len
  check (char_length(text) between 1 and case kind when 'belief' then 300 when 'story' then 600 else 800 end) not valid;
commit;
