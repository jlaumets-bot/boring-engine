-- ============================================================================
-- SECURITY FIX — Batch 2
--
-- Fixes two things that only the database owner can apply:
--   (a) A team member can silently SEIZE a brand (change brands.user_id).
--   (b) Two foreign keys with no ON DELETE clause can BLOCK account deletion,
--       which is what makes /api/delete-account fail (GDPR Art. 17).
--
-- Safe to run in the Supabase SQL editor. IDEMPOTENT — re-running changes nothing.
-- Does NOT lock the owner out: every rule below either leaves the owner untouched
-- or exempts the service role entirely.
--
-- Depends on: sql/team-tables.sql, sql/security-fixes-batch1b.sql (already applied).
-- ============================================================================


-- ============================================================================
-- PART A — a member can no longer take over a brand
-- ============================================================================
--
-- THE HOLE, as it stands today (sql/team-tables.sql lines 120-124):
--
--   CREATE POLICY "Users can update own or member brands" ON brands FOR UPDATE
--   USING (user_id = auth.uid()
--          OR id IN (SELECT brand_id FROM brand_members WHERE user_id = auth.uid()));
--
-- There is no WITH CHECK, so Postgres reuses USING as the check on the NEW row —
-- and membership alone satisfies it. An invited member can therefore run
--   update brands set user_id = <anyone> where id = <the brand>
-- with nothing but the public anon key, and the brand is theirs. They can also
-- overwrite gemini_key_enc (the stored image-generation key).
--
-- IT IS WORSE THAN A DELIBERATE ATTACK. app.html's settingsToBrand() ALWAYS sends
--   user_id: currentUser.id
-- in its brands UPDATE payload. So a member who simply opens Settings and saves
-- their brand voice silently becomes the owner. This is happening by accident.
--
-- WHY RLS CANNOT FIX IT: a WITH CHECK expression cannot reference OLD, so no policy
-- can express "the new user_id must equal the old one". Column-level REVOKE is also
-- unusable here — a table-level GRANT UPDATE overrides column-level revokes, so it
-- would require enumerating and re-granting every other column of `brands`, and the
-- brands table has no CREATE TABLE in this repo to enumerate from. A BEFORE UPDATE
-- trigger is the narrowest correct tool.
--
-- THERE IS NO ROLES CONCEPT IN THIS SCHEMA (no owner/editor/viewer column anywhere),
-- and inventing one would touch every policy and the whole team UI. This fix
-- therefore does the minimum that closes the hole: ownership becomes IMMUTABLE from
-- any client, for everyone. Members keep exactly the edit rights they have today.

-- Pin the two columns that must never be rewritten by a client.
-- BEHAVIOURAL CHANGE:
--   * user_id is silently RESET to its previous value on every client UPDATE.
--     Silent (not an error) on purpose: settingsToBrand() sends user_id on every
--     save, so raising here would break a member's ability to save brand settings
--     at all — a flow that today only "works" by stealing the brand. Owners see no
--     change whatsoever (they send their own id, so nothing differs).
--   * gemini_key_enc raises for a NON-owner. Raising is safe here because no client
--     code ever writes this column — api/meme.js sets it with the service role — so
--     any authenticated attempt to change it is by definition tampering, and it
--     should be loud.
--   * The service role is exempt (auth.uid() is null), so api/meme.js keeps working
--     and the owner can still transfer a brand deliberately from the SQL editor.
--   * to_jsonb() is used for gemini_key_enc so this function is valid even on an
--     install where that column does not exist.
create or replace function public.brands_pin_ownership()
returns trigger
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  -- Service role / backend jobs have no auth.uid(): leave them alone.
  if v_uid is null then
    return new;
  end if;

  -- Ownership is immutable from any client, deliberate or accidental.
  if new.user_id is distinct from old.user_id then
    new.user_id := old.user_id;
  end if;

  -- Only the owner may touch the stored API key.
  if v_uid is distinct from old.user_id
     and (to_jsonb(new) ->> 'gemini_key_enc') is distinct from (to_jsonb(old) ->> 'gemini_key_enc') then
    raise exception 'only the brand owner can change this brand''s API key'
      using errcode = '42501';
  end if;

  return new;
end;
$fn$;

-- Attach it. drop-then-create keeps this re-runnable.
drop trigger if exists brands_pin_ownership_trg on public.brands;
create trigger brands_pin_ownership_trg
  before update on public.brands
  for each row execute function public.brands_pin_ownership();


-- ----------------------------------------------------------------------------
-- A2. Only a brand OWNER can mint invites.
--
-- team-tables.sql line 57 lets any MEMBER create an invite for a brand they merely
-- belong to, so one collaborator can hand access to a workspace that is not theirs
-- — and each new member can invite again, without limit.
--
-- BEHAVIOURAL CHANGE: a member pressing "Invite" in the team panel now gets an
-- RLS error instead of an invite code. Owners are unaffected. This is the narrowest
-- correct rule while there are no roles; if you decide members SHOULD be able to
-- invite, revert by restoring the "Brand access can create invites" policy from
-- sql/team-tables.sql lines 57-63.
-- Reading, listing, redeeming and deleting invites are all unchanged.
do $$
begin
  if to_regclass('public.brand_invites') is null then
    raise notice 'brand_invites does not exist — skipping invite policy';
    return;
  end if;
  drop policy if exists "Brand access can create invites" on public.brand_invites;
  drop policy if exists "Brand owner can create invites" on public.brand_invites;
  create policy "Brand owner can create invites" on public.brand_invites
    for insert with check (
      brand_id in (select id from public.brands where user_id = auth.uid())
    );
end $$;


-- ============================================================================
-- PART B — foreign keys that can block account deletion
-- ============================================================================
--
-- THE HOLE: three columns reference auth.users(id) with NO ON DELETE clause, so they
-- default to NO ACTION and REFUSE the parent delete:
--
--   brand_members.invited_by   (team-tables.sql:10)
--   brand_invites.created_by   (team-tables.sql:21, also NOT NULL)
--   brand_invites.used_by      (team-tables.sql:23)
--
-- Rows on a user's OWN brands cascade away with the brand, so this is invisible for
-- a solo account. But a user who touched a brand they only BELONG to leaves a row
-- behind on someone else's brand:
--   * they invited a teammate     → brand_members.invited_by  points at them
--   * they created an invite      → brand_invites.created_by  points at them
--   * they redeemed an invite     → brand_invites.used_by     points at them
-- Those rows survive their own brands' cascade and block `DELETE auth.users`. The
-- account stays alive and the email stays taken — while the app (before the v613 fix
-- to api/delete-account.js) told them it was deleted.
--
-- FIX: SET NULL, not CASCADE. The referencing rows describe SOMEONE ELSE's workspace;
-- deleting a departing user must not evict their teammate from a brand or erase the
-- audit trail of a used invite. SET NULL keeps the row and forgets the person, which
-- is also the correct erasure outcome.
--
-- Each block finds the existing constraint by COLUMN rather than by name (the inline
-- names are auto-generated and can differ per install), drops it, and re-adds it with
-- the right rule — so this is safe to run repeatedly.

-- B1. brand_members.invited_by → ON DELETE SET NULL
--     Effect: the membership survives; we simply stop recording who invited them.
do $$
declare c record;
begin
  if to_regclass('public.brand_members') is null then
    raise notice 'brand_members does not exist — skipping';
    return;
  end if;
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.brand_members'::regclass
      and con.contype = 'f'
      and att.attname = 'invited_by'
      and array_length(con.conkey, 1) = 1
  loop
    execute format('alter table public.brand_members drop constraint %I', c.conname);
  end loop;

  alter table public.brand_members
    add constraint brand_members_invited_by_fkey
    foreign key (invited_by) references auth.users(id) on delete set null;
end $$;

-- B2. brand_invites.created_by → drop NOT NULL, then ON DELETE SET NULL
--     NOT NULL must go first: SET NULL is impossible while the column forbids NULL,
--     and CASCADE is the wrong alternative because it would silently delete the
--     invite rows (and their used_at audit) on someone else's brand.
--     Effect: an invite whose creator deleted their account keeps working and keeps
--     its history; created_by simply reads NULL ("creator no longer exists").
--     Nothing depends on it being non-null — app.html always sets it on insert, the
--     RLS policies key off brand_id, and redeem_invite() copies it into
--     brand_members.invited_by, which is nullable.
do $$
declare c record;
begin
  if to_regclass('public.brand_invites') is null then
    raise notice 'brand_invites does not exist — skipping';
    return;
  end if;

  alter table public.brand_invites alter column created_by drop not null;

  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.brand_invites'::regclass
      and con.contype = 'f'
      and att.attname = 'created_by'
      and array_length(con.conkey, 1) = 1
  loop
    execute format('alter table public.brand_invites drop constraint %I', c.conname);
  end loop;

  alter table public.brand_invites
    add constraint brand_invites_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null;
end $$;

-- B3. brand_invites.used_by → ON DELETE SET NULL
--     Not named in the original report but identical in kind, and the MOST likely
--     trigger in practice: every invited user has a used_by row pointing at them on
--     a brand they do not own, so any of them would be undeletable.
--     Effect: used_at is preserved (the invite stays spent); we forget who spent it.
do $$
declare c record;
begin
  if to_regclass('public.brand_invites') is null then
    return;
  end if;
  for c in
    select con.conname
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.brand_invites'::regclass
      and con.contype = 'f'
      and att.attname = 'used_by'
      and array_length(con.conkey, 1) = 1
  loop
    execute format('alter table public.brand_invites drop constraint %I', c.conname);
  end loop;

  alter table public.brand_invites
    add constraint brand_invites_used_by_fkey
    foreign key (used_by) references auth.users(id) on delete set null;
end $$;


-- ============================================================================
-- VERIFY — run these after applying. Expected results are stated inline.
-- ============================================================================

-- 1) All three FKs should now read 'SET NULL' (confdeltype 'n').
--    Anything showing 'a' (NO ACTION) is still able to block account deletion.
-- select con.conrelid::regclass as tbl, att.attname as col,
--        case con.confdeltype when 'a' then 'NO ACTION (BLOCKS DELETE)'
--                             when 'n' then 'SET NULL (ok)'
--                             when 'c' then 'CASCADE' else con.confdeltype::text end as on_delete
-- from pg_constraint con
-- join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
-- where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
-- order by 1, 2;

-- 2) The ownership trigger should exist and be enabled ('O').
-- select tgname, tgenabled from pg_trigger
-- where tgrelid = 'public.brands'::regclass and not tgisinternal;

-- 3) THE ONE THAT MATTERS — prove the takeover is dead. Run as a MEMBER (not the
--    owner) from the app's own session, e.g. in the browser console while signed in
--    as a member:
--      await sb.from('brands').update({ user_id: '<the member id>' }).eq('id','<brand id>');
--      await sb.from('brands').select('user_id').eq('id','<brand id>').single();
--    EXPECT: no error, and user_id UNCHANGED (still the original owner).

-- 4) THE QUESTION THIS REPO CANNOT ANSWER — do the remaining personal-data tables
--    cascade from auth.users? There is no CREATE TABLE for user_plans, usage_events
--    or dfy_requests anywhere in this repo, so their ON DELETE rules are unknown.
--    api/delete-account.js now deletes all three by user_id explicitly, so erasure no
--    longer depends on the answer — but any row that does NOT cascade is also a row
--    that can BLOCK the auth.users delete, so check it:
--
-- select con.conrelid::regclass as tbl, att.attname as col,
--        case con.confdeltype when 'a' then 'NO ACTION — CAN BLOCK ACCOUNT DELETION'
--                             when 'n' then 'SET NULL'
--                             when 'c' then 'CASCADE'
--                             when 'r' then 'RESTRICT — CAN BLOCK ACCOUNT DELETION'
--                             else con.confdeltype::text end as on_delete
-- from pg_constraint con
-- join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
-- where con.contype = 'f' and con.confrelid = 'auth.users'::regclass
-- order by con.confdeltype, 1;
--
--    Any row that comes back NO ACTION or RESTRICT needs the same SET NULL / CASCADE
--    treatment as Part B before deletion is reliable for every user.
