-- ============================================================
-- SECURITY FIX — Batch 1b: team invites + member self-join hole
--
-- Problem fixed:
--   * brand_members INSERT allowed ANY logged-in user to add themselves
--     to ANY brand (OR user_id = auth.uid()), i.e. read any brand's data.
--   * brand_invites was readable by everyone (invite-code enumeration) and
--     updatable by everyone.
--
-- Approach: do the join inside two trusted server-side functions
-- (SECURITY DEFINER) that validate the invite, then lock the tables so the
-- client can't self-insert or read/modify invites directly.
--
-- Safe + idempotent. Relies on user_brand_ids() from team-tables.sql.
-- ============================================================

-- 1) Read-only lookup for the "you've been invited to X" banner.
--    Returns a brand name ONLY for a valid, unused invite code.
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
  limit 1;
$$;
grant execute on function lookup_invite(text) to anon, authenticated;

-- 2) Atomic redeem: validate an unused code, add the caller as a member,
--    mark the invite used. Runs with elevated rights so the client never
--    inserts membership directly.
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
  where invite_code = p_code and used_at is null
  limit 1;

  if not found then
    return null;  -- invalid or already-used code
  end if;

  -- Brand owner needs no membership row.
  if exists (select 1 from brands where id = v_invite.brand_id and user_id = v_uid) then
    return v_invite.brand_id;
  end if;

  -- Add membership only if not already present.
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
grant execute on function redeem_invite(text) to authenticated;

-- 3) Lock brand_members INSERT: only a brand OWNER can add members directly.
--    Invited users now join exclusively via redeem_invite().
drop policy if exists "Brand owner or self can insert members" on brand_members;
create policy "Brand owner can insert members" on brand_members
  for insert with check (
    brand_id in (select id from brands where user_id = auth.uid())
  );

-- 4) Lock brand_invites: remove the public read + public update.
drop policy if exists "Anyone can read invites by code" on brand_invites;
drop policy if exists "Anyone can mark invite as used" on brand_invites;

-- Owners/members can still LIST invites for their own brand (team panel).
drop policy if exists "Members can read brand invites" on brand_invites;
create policy "Members can read brand invites" on brand_invites
  for select using (brand_id in (select user_brand_ids()));
