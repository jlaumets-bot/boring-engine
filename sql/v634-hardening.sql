-- ============================================================
-- v634 hardening — run in the Supabase SQL editor, ONE STEP AT A TIME.
--
-- Closes the two gaps the 2026-08-27 auth audit left open, plus optional
-- cleanup of the tables orphaned when the publishing feature was deleted.
--
-- STEP 1 is read-only. Run it first and READ the result before STEP 2.
-- STEP 2 DELETES rows (orphans only). STEP 1 tells you exactly how many.
-- ============================================================


-- ============================================================
-- STEP 1 — READ-ONLY SURVEY. Changes nothing. Run this first.
--
-- For every table that has a brand_id, shows how many rows point at a brand
-- that no longer exists ("orphan_rows"), and whether the table already has a
-- foreign key to brands. Step 2 will delete exactly those orphan rows, so
-- these numbers are your preview of what it will remove.
-- ============================================================
select
  c.table_name,
  (xpath('/row/c/text()', query_to_xml(format(
     'select count(*) as c from public.%I x
        left join public.brands b on b.id = x.brand_id
       where x.brand_id is not null and b.id is null', c.table_name),
     false, true, '')))[1]::text::bigint                       as orphan_rows,
  (xpath('/row/c/text()', query_to_xml(format(
     'select count(*) as c from public.%I', c.table_name),
     false, true, '')))[1]::text::bigint                       as total_rows,
  exists (
    select 1 from pg_constraint k
     where k.conrelid  = format('public.%I', c.table_name)::regclass
       and k.contype   = 'f'
       and k.confrelid = 'public.brands'::regclass
  )                                                             as already_linked
from information_schema.columns c
where c.table_schema = 'public'
  and c.column_name  = 'brand_id'
order by 1;


-- ============================================================
-- STEP 2 — LINK EVERY BRAND-SCOPED TABLE TO brands, SO DELETING A BRAND
--          ACTUALLY REMOVES ITS CONTENT.
--
-- Why: deleting a brand deletes the brands row first (so a failed delete can
-- never destroy your library — that was the v634 fix). But once that row is
-- gone, the app is no longer allowed to touch the child rows, and that refusal
-- is invisible: Postgres returns "0 rows" with no error. So the content became
-- unreachable but stayed in the database. A cascade makes the database do it.
--
-- DELETES DATA: only rows whose brand_id points at a brand that no longer
-- exists. Those are already unreachable in the app. STEP 1 showed you the count.
--
-- push_subscriptions is deliberately SET NULL rather than CASCADE: if a brand
-- goes away the daily ping should fall back to a generic reminder, not silently
-- unsubscribe the person.
--
-- Safe to run twice — it skips any table that is already linked.
-- ============================================================
do $$
declare
  r record;
  n bigint;
  rule text;
begin
  for r in
    select c.table_name as t
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.column_name  = 'brand_id'
       and c.table_name  <> 'brands'
     order by 1
  loop
    if exists (
      select 1 from pg_constraint k
       where k.conrelid  = format('public.%I', r.t)::regclass
         and k.contype   = 'f'
         and k.confrelid = 'public.brands'::regclass
    ) then
      raise notice '% — already linked, skipped', r.t;
      continue;
    end if;

    -- remove rows pointing at a brand that no longer exists
    execute format(
      'delete from public.%I x
        where x.brand_id is not null
          and not exists (select 1 from public.brands b where b.id = x.brand_id)', r.t);
    get diagnostics n = row_count;

    rule := case when r.t = 'push_subscriptions' then 'set null' else 'cascade' end;

    execute format(
      'alter table public.%I
         add constraint %I foreign key (brand_id)
         references public.brands(id) on delete %s',
      r.t, r.t || '_brand_id_fkey', rule);

    raise notice '% — cleared % orphan row(s), linked with on delete %', r.t, n, rule;
  end loop;
end $$;


-- ============================================================
-- STEP 3 — GIVE INVITE CODES AN EXPIRY.
--
-- Today an unused invite code works forever, for anyone holding the link.
-- This makes both invite functions refuse a code older than 14 days. The code
-- itself is untouched — only its age is now checked, so nothing else changes.
--
-- Change the two "interval '14 days'" values if you want a different window.
-- ============================================================
create or replace function lookup_invite(p_code text)
returns table (brand_id uuid, brand_name text)
language sql
security definer
set search_path = public
stable
as $$
  select b.id, b.brand_name
  from brand_invites i
  join brands b on b.id = i.brand_id
  where i.invite_code = p_code
    and i.used_at is null
    and i.created_at > now() - interval '14 days'
  limit 1;
$$;

create or replace function redeem_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite brand_invites%rowtype;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from brand_invites
  where invite_code = p_code
    and used_at is null
    and created_at > now() - interval '14 days'
  limit 1;

  if not found then
    return null;  -- invalid, already used, or expired
  end if;

  if exists (select 1 from brands where id = v_invite.brand_id and user_id = v_uid) then
    return v_invite.brand_id;
  end if;

  insert into brand_members (brand_id, user_id, user_email, invited_by)
  select v_invite.brand_id, v_uid,
         coalesce((select email from auth.users where id = v_uid), ''),
         v_invite.created_by
  where not exists (
    select 1 from brand_members
    where brand_id = v_invite.brand_id and user_id = v_uid
  );

  update brand_invites
  set used_by = v_uid, used_at = now()
  where id = v_invite.id;

  return v_invite.brand_id;
end;
$$;

grant execute on function lookup_invite(text)  to anon, authenticated;
grant execute on function redeem_invite(text)  to authenticated;


-- ============================================================
-- STEP 4 — OPTIONAL. Remove the tables left behind when the publishing
--          feature was deleted in v633. Nothing reads or writes them.
--
-- Only run this if you are sure you will not revive in-app publishing.
-- Run STEP 2 BEFORE this one (step 2 walks every table with a brand_id, and
-- these still have one — dropping them first is fine too, just less tidy).
-- ============================================================
-- drop table if exists public.publish_jobs;
-- drop table if exists public.brand_autopublish;
-- drop table if exists public.brand_connections;
