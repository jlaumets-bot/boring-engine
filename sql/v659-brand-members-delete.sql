-- ============================================================================
-- v659 — only the brand OWNER can remove a team member.
-- Run in the Supabase SQL editor. Changes ONE policy. No data is touched.
-- Safe to run twice. Safe on a live database.
--
-- ---------------------------------------------------------------------------
-- THE HOLE — found by the whole-schema arm of sql/v658-member-delete.sql's VERIFY
-- ---------------------------------------------------------------------------
-- The LIVE policy had drifted from the repo. sql/team-tables.sql:58 declares:
--
--   CREATE POLICY "Brand owner can delete members" ON brand_members FOR DELETE
--   USING (brand_id IN (SELECT id FROM brands WHERE user_id = auth.uid()));
--
-- but production actually carried:
--
--   USING (brand_id IN (SELECT user_brand_ids() ...))
--
-- user_brand_ids() returns brands you OWN *unioned with* brands you merely BELONG
-- TO (team-tables.sql:139-143). So every teammate could delete rows from
-- brand_members for that brand — that is, remove any other teammate.
--
-- app.html:20768 already hides the remove button from non-owners:
--   ${currentBrand?.user_id === currentUser?.id ? `<button ... removeMember(...)>` : ''}
-- A hidden button is not access control. removeMember() (app.html:7286) is a plain
-- PostgREST delete, so anything holding the anon key and a member session could call
-- it directly. The policy is the only thing that was supposed to stop that, and its
-- own NAME says what it was meant to do.
--
-- ---------------------------------------------------------------------------
-- WHAT DOES NOT BREAK
-- ---------------------------------------------------------------------------
-- * ACCOUNT DELETION. api/delete-account.js authenticates with
--   SUPABASE_SERVICE_ROLE_KEY (api/delete-account.js:74-83), which bypasses RLS,
--   and brand_members is `on delete cascade` from brands (api/delete-account.js:36).
--   No client-side delete of one's own membership row exists — the only client call
--   against this table's DELETE is removeMember(), which is the owner's control.
-- * READING the team list. "Members can view brand members" is FOR SELECT and is
--   left exactly as it is: a member must still see their teammates.
-- * JOINING. "Brand owner can insert members" is FOR INSERT and is untouched.
--
-- ---------------------------------------------------------------------------
-- A DECISION LEFT TO JÖRGEN — should a member be able to LEAVE a team?
-- ---------------------------------------------------------------------------
-- After this, they cannot: only the owner can remove anyone, including them. That
-- matches the repo, the policy's name and the UI, so it is what this file does. If
-- you want "leave team", the change is to append `OR user_id = auth.uid()` to the
-- USING clause below — and the app needs a button, which it does not have today.
-- Not added on a guess.
-- ============================================================================
drop policy if exists "Brand owner can delete members" on public.brand_members;
create policy "Brand owner can delete members" on public.brand_members
  for delete using (brand_id in (select id from brands where user_id = auth.uid()));


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = a member can no longer remove a teammate,
-- and the owner still can.
-- ============================================================================
select 'brand_members' as problem,
       'policy "' || policyname || '" is FOR ' || cmd ||
       ' and its predicate still admits MEMBERS' as detail
from pg_policies
where schemaname = 'public' and tablename = 'brand_members'
  and cmd in ('DELETE', 'ALL')
  and coalesce(qual, '') ~* '(user_brand_ids|brand_members)'

union all

select 'brand_members',
       'no owner-bound DELETE policy — the OWNER can no longer remove a member either'
where not exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'brand_members'
    and cmd in ('DELETE', 'ALL')
    and coalesce(qual, '') ~* 'brands'
    and coalesce(qual, '') ~* 'auth\.uid'
)

union all

select 'brand_members',
       'members lost SELECT on the team list — they can no longer see their teammates'
where not exists (
  select 1 from pg_policies
  where schemaname = 'public' and tablename = 'brand_members'
    and cmd in ('SELECT', 'ALL')
    and coalesce(qual, '') ~* 'user_brand_ids|brand_members'
)

order by 1, 2;
