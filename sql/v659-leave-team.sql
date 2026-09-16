-- ============================================================================
-- v659 — a team member may LEAVE a team. Their own row, and nobody else's.
-- Run in the Supabase SQL editor. Changes ONE policy. No data is touched.
-- Safe to run twice. Safe on a live database with users on it.
--
-- RUN sql/v659-brand-members-delete.sql FIRST. This file replaces the policy that
-- file creates. Running this one alone still produces the correct end state (it is a
-- drop-and-create of the same policy name), but the reasoning below assumes the
-- owner-only policy is what is live right now.
--
-- ---------------------------------------------------------------------------
-- THE HOLE — a product gap, not a security hole. Be clear about which.
-- ---------------------------------------------------------------------------
-- sql/v659-brand-members-delete.sql:50-52 set the live DELETE policy on
-- brand_members to owner-only:
--
--     create policy "Brand owner can delete members" on public.brand_members
--       for delete using (brand_id in (select id from brands where user_id = auth.uid()));
--
-- That closed a real hole (any teammate could remove any other teammate). It also
-- closed the only door a member had. After it, a member cannot get out of a team they
-- joined by any route the product offers:
--
--   * the only client-side DELETE against this table is removeMember()
--     (app.html:7286-7292 — `await sb.from('brand_members').delete().eq('id', memberId)`),
--     and its button is rendered only for the owner (app.html:20768:
--     `${currentBrand?.user_id === currentUser?.id ? `<button ... removeMember(...)>` : ''}`);
--   * the only other way a membership row disappears is the ON DELETE CASCADE from
--     auth.users on brand_members.user_id (sql/team-tables.sql:8) — i.e. the member
--     deletes their entire Content Shrimp account (api/delete-account.js).
--
-- "Delete your whole account, or ask the owner nicely" is not an acceptable exit from
-- a workspace someone else controls. Jörgen has decided a member MAY leave.
--
-- ---------------------------------------------------------------------------
-- THE FIX
-- ---------------------------------------------------------------------------
-- One arm is appended to the USING clause — exactly the change
-- sql/v659-brand-members-delete.sql:46-47 said it would be:
--
--     using (brand_id in (select id from brands where user_id = auth.uid())
--            or user_id = auth.uid())
--
-- The column is verified, not assumed: brand_members.user_id is declared at
-- sql/team-tables.sql:8 —
--     user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
-- and it is the column every membership query in the app filters on
-- (app.html:6809, 6819, 6880).
--
-- The new arm is `user_id = auth.uid()` and NOT anything routed through
-- user_brand_ids() or a `select ... from brand_members` subquery. That distinction is
-- the entire point. user_brand_ids() (sql/team-tables.sql:139-143) returns brands you
-- own UNIONED WITH brands you merely belong to, so a predicate built on it says "any
-- row of any brand I can see" — which is precisely the drift that
-- sql/v659-brand-members-delete.sql:14-20 found in production and removed. `user_id =
-- auth.uid()` compares the ROW's own user to the caller and can only ever match the
-- caller's own membership row. It cannot be widened by a later edit to a helper,
-- because it calls no helper.
--
-- The owner arm is left byte-for-byte as v659-brand-members-delete.sql wrote it, and
-- it queries `brands` directly for the same reason.
--
-- ---------------------------------------------------------------------------
-- WHAT LEAVING ACTUALLY DOES — AND WHAT IT DOES NOT DO
-- ---------------------------------------------------------------------------
-- It deletes ONE ROW: the leaver's row in brand_members. That is all. In particular:
--
--   * The brand is NOT deleted. The owner's brand row, and every ideas / remixes /
--     product_refs / competitors / prompt_history / notebook_notes / edit_signals row
--     under it, is untouched. This file issues no DELETE at all; it only says who may.
--   * Nothing the leaver CONTRIBUTED is removed. Ideas they wrote, notes they took and
--     edits they made stay in the owner's brand, because those rows are keyed by
--     brand_id, not by author. Leaving is not a retraction.
--   * The leaver loses ACCESS, and loses it everywhere at once, because every
--     brand-scoped policy in the schema resolves membership through user_brand_ids()
--     (sql/team-tables.sql:139-143). Once the row is gone that function stops returning
--     the brand, so reads stop too. app.html:6819 and 6880 will no longer find the
--     membership and will fall back to the user's own brand.
--   * It is NOT reversible by the leaver. brand_members INSERT is
--     "Brand owner or self can insert members" (sql/team-tables.sql:52-55), whose
--     `OR user_id = auth.uid()` arm would in principle let them re-add themselves —
--     but redeem_invite is the path the app actually uses (app.html:7304), and an
--     invite code that was already used is refused. In practice: they need a fresh
--     invite from the owner.
--   * An OWNER cannot leave their own brand this way and does not need to. An owner
--     has no brand_members row for their own brand (the owner is brands.user_id;
--     membership is the other thing). There is nothing for them to delete here.
--
-- ---------------------------------------------------------------------------
-- NO UI CALLS THIS TODAY
-- ---------------------------------------------------------------------------
-- As of this file, app.html contains NO "leave team" button and no self-delete against
-- brand_members. Checked: the only `from('brand_members').delete(...)` in the file is
-- removeMember at app.html:7289, which is the owner's control and is passed a member
-- id, not the caller's own; and a case-insensitive search for "leave" in app.html finds
-- nothing team-related. So on the day this SQL is run, the capability it grants is
-- reachable only through the PostgREST API directly, and the user-visible behaviour of
-- the app does not change at all.
--
-- That is deliberate and it is not a problem: another change, in flight right now, is
-- adding the button. app.html is owned by that change and is not touched here. This
-- file exists so that when the button lands, the policy is already there to permit it —
-- the reverse order (ship the button against an owner-only policy) would give every
-- member a "Leave team" that silently does nothing, because RLS filters the row out
-- rather than raising and PostgREST answers `{ data: [], error: null }`.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE WITH USERS ON THE SITE
-- ---------------------------------------------------------------------------
-- * It is a WIDENING of a DELETE predicate, so no existing, currently-permitted
--   operation can start failing. The owner's removeMember keeps working unchanged: the
--   first arm of the OR is identical to the whole of the previous predicate.
-- * The drop and the create are in ONE DO block, and DDL in PostgreSQL is
--   transactional, so no session can observe a window with no DELETE policy on
--   brand_members. Nothing reads through a DELETE policy anyway, so nobody's team list
--   goes blank mid-run.
-- * to_regclass guards the table, so an install without brand_members is skipped
--   rather than erroring half way.
-- * drop policy if exists + create — re-running produces the identical end state.
-- * SELECT ("Members can view brand members", sql/team-tables.sql:43-49) and INSERT
--   ("Brand owner or self can insert members", sql/team-tables.sql:52-55) are not
--   mentioned by this file and are not altered by it.
-- * No DELETE is issued. This changes who may delete, not what exists.
-- ============================================================================
do $$
begin
  if to_regclass('public.brand_members') is null then
    raise notice 'v659-leave-team: brand_members does not exist — skipping';
    return;
  end if;

  -- Same policy NAME as sql/v659-brand-members-delete.sql:51 and
  -- sql/team-tables.sql:58, so this replaces rather than stacks. Two permissive
  -- DELETE policies would OR together, which would happen to give the right answer
  -- here but would leave two predicates to keep in step forever.
  drop policy if exists "Brand owner can delete members" on public.brand_members;
  create policy "Brand owner can delete members" on public.brand_members
    for delete using (
      brand_id in (select id from brands where user_id = auth.uid())
      or user_id = auth.uid()
    );

  raise notice 'v659-leave-team: brand_members — owner may remove anyone; a member may remove ONLY their own row';
end $$;


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = a member can leave, a member still cannot
-- remove anyone else, and the owner can still remove anyone.
--
-- Three arms, because this change can fail in three directions:
--   * arm 1 — TOO WIDE: the predicate admits other members' rows again (the original
--             production bug, which was exactly this kind of "one more arm" edit);
--   * arm 2 — TOO NARROW at the top: the owner-bound arm is gone, so the owner can no
--             longer remove anyone;
--   * arm 3 — DID NOT TAKE: the self arm is absent, so this whole file was a no-op.
--
-- On how arm 3 reads the predicate: pg_policies.qual is deparsed SQL. The owner arm
-- deparses with its subquery alias attached — `(brands.user_id = auth.uid())` — while
-- the policy's own column deparses bare — `(user_id = auth.uid())`. Arm 3 therefore
-- looks for a `user_id = auth.uid()` that is NOT prefixed by `brands.`, and tolerates
-- an explicit `brand_members.` prefix in case a future PostgreSQL deparses it that way.
-- ============================================================================
select 'brand_members' as problem,
       'policy "' || policyname || '" is FOR ' || cmd ||
       ' and its predicate still admits OTHER members'' rows — a teammate can remove a teammate' as detail
from pg_policies
where schemaname = 'public' and tablename = 'brand_members'
  and cmd in ('DELETE', 'ALL')
  and coalesce(qual, '') ~* '(user_brand_ids|brand_members[^.])'

union all

select 'brand_members',
       'no owner-bound DELETE policy — the OWNER can no longer remove a member'
where not exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'brand_members'
    and cmd in ('DELETE', 'ALL')
    and coalesce(qual, '') ~* 'brands'
    and coalesce(qual, '') ~* 'auth\.uid'
)

union all

select 'brand_members',
       'no self-delete arm on any DELETE policy — a member still cannot leave a team, ' ||
       'which is the only thing this file was for'
where not exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'brand_members'
    and cmd in ('DELETE', 'ALL')
    and coalesce(qual, '') ~* '(^|[^.[:alnum:]_])(brand_members\.)?user_id[[:space:]]*=[[:space:]]*auth\.uid\(\)'
)

order by 1, 2;
