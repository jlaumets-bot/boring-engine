-- ============================================================
-- v655 — an invite addressed to someone can no longer be redeemed by anyone else.
-- Run in the Supabase SQL editor. Replaces ONE function. Nothing else changes.
--
-- THE HOLE: redeem_invite matched only on the code. brand_invites.email holds who
-- the invite was addressed to, and nothing ever compared it to the caller. So a
-- targeted invite that leaked — forwarded mail, a screenshot, a shared inbox —
-- let ANY signed-in account claim that brand, permanently.
--
-- THE ONE NUANCE, deliberately preserved: the app creates TWO kinds of invite.
--   inviteTeammate()      -> email IS SET   (addressed to one person)
--   generateInviteLink()  -> email IS NULL  (an open share link, on purpose)
-- So the check fires ONLY when the invite carries an email. An open link stays
-- open — but it is already single-use (used_at) and expires in 14 days (v634).
-- Blanket-requiring an email here would silently break "Copy invite link".
--
-- Safe to run twice. Safe to run on production. No data is touched.
-- ============================================================
create or replace function redeem_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite brand_invites%rowtype;
  v_uid    uuid := auth.uid();
  v_email  text;
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

  -- NEW: an ADDRESSED invite only works for the person it was addressed to.
  -- A null email means an open share link, which is allowed to be open.
  if v_invite.email is not null and length(trim(v_invite.email)) > 0 then
    select email into v_email from auth.users where id = v_uid;
    if v_email is null
       or lower(trim(v_email)) <> lower(trim(v_invite.email)) then
      return null;  -- addressed to someone else
    end if;
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

grant execute on function redeem_invite(text) to authenticated;


-- ============================================================
-- VERIFY — read-only. EMPTY RESULT = the check is live.
-- A row means the new body did not land.
-- ============================================================
select 'redeem_invite' as problem,
       'no caller-email check — an addressed invite is still redeemable by anyone' as detail
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'redeem_invite'
  and pg_get_functiondef(p.oid) not like '%addressed to someone else%';
