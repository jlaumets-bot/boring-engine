-- ============================================================================
-- v659 — the brand limit becomes real. Enforced in the database, on INSERT.
-- Run in the Supabase SQL editor. Adds TWO functions and ONE trigger. No policy is
-- changed, no row is touched. Safe to run twice. Safe on a live database.
--
-- ---------------------------------------------------------------------------
-- THE HOLE
-- ---------------------------------------------------------------------------
-- The product is SOLD with a per-plan brand count. index.html:698-702 sells Free as
-- "40 posts a month, one brand"; index.html:710-715 sells Pro as "750 posts a month"
-- plus "2 brands on one account"; index.html:723-729 sells Agency as "Multiple brands
-- & seats for your team".
--
-- Nothing enforces it. api/_brandlimit.js:3-14 lays this out and names the only thing
-- that ever tried — one line of client JavaScript, app.html:7161:
--
--     if (typeof csIsFree==='function' && csIsFree() && (allBrands||[]).length >= 1)
--       { showFeatureLock('multibrand'); return; }
--
-- It does not hold even in the browser (csIsFree() reads a cached /api/usage response,
-- so it is false during the trial and false whenever that call failed), and it is not
-- on the path that creates a brand anyway: saveBrand INSERTs straight from the browser
-- through PostgREST at app.html:7486 —
--
--     const { data, error } = await sb.from('brands').insert(brandData).select().single();
--
-- api/_brandlimit.js:16-18 states the conclusion exactly:
--
--     "It cannot close the hole on its own — a browser INSERT never passes through this
--      code, and the only thing that can actually REFUSE that insert is a database
--      policy in sql/ (out of scope here) or the client asking first."
--
-- This file is that missing piece.
--
-- ---------------------------------------------------------------------------
-- RLS POLICY OR TRIGGER? — AND THE "SECOND PERMISSIVE POLICY" TRAP
-- ---------------------------------------------------------------------------
-- DECISION: a BEFORE INSERT trigger.
--
-- THE TRAP FIRST, because it is the thing that would look like it worked and would not.
-- Multiple PERMISSIVE policies for the same command are OR-ed together, not AND-ed
-- (PostgreSQL: "at least one permissive policy must permit"). `brands` must already
-- carry an INSERT policy — every account in production created its brand through the
-- browser INSERT above, and app.html:7487-7494 has a hand-written recovery path for
-- the row-level-security error that INSERT returns on a stale JWT, so the policy is
-- demonstrably there and demonstrably load-bearing. Adding a SECOND permissive INSERT
-- policy that says "…and you are under your brand limit" would therefore change
-- nothing at all: the pre-existing policy would still permit the row on its own. The
-- limit would appear to be installed and would refuse nobody, which is worse than not
-- installing it, because it would stop anyone looking again.
--
-- THAT LEAVES THREE HONEST OPTIONS. All three were considered:
--
--   (a) REPLACE the existing INSERT policy with a narrower one. Rejected, and this is
--       the important rejection: that policy is NOT IN THIS REPO. There is no
--       `CREATE POLICY … ON brands FOR INSERT` and no `CREATE TABLE brands` anywhere in
--       sql/ (grep confirms), so its live text is unknown here. sql/v657-search-path.sql:22-27
--       already warns, in this exact schema, that "the repo's copy of this schema is
--       known to be out of date in places … so re-declaring the body from the repo could
--       silently revert a live fix". Dropping and re-writing, from guesswork, the one
--       policy that every new account must pass through to create its first brand is the
--       change whose failure mode is "nobody can sign up". Not done.
--
--   (b) A RESTRICTIVE INSERT policy (`as restrictive`). This is a legitimate option and
--       it does not have the OR problem — restrictive policies AND with the permissive
--       ones, and it needs no knowledge of the existing policy. It was rejected on two
--       narrower grounds, not on correctness:
--         * the failure it produces is the generic "new row violates row-level security
--           policy for table brands". app.html:7487 matches on exactly that string and
--           responds by refreshing the session and REPEATING the insert (app.html:7490-7494),
--           so a user who hit their plan limit would get a silent retry and then an
--           alert() containing RLS jargon. A trigger raises its own sentence, which
--           app.html:7512 shows verbatim.
--         * the policy predicate is evaluated as the QUERYING role, so reading user_plans
--           from it needs a SECURITY DEFINER helper regardless — the trigger version is
--           the same helper with no policy bolted on beside it.
--
--   (c) A BEFORE INSERT trigger. Chosen. It composes with whatever the live INSERT
--       policy says instead of arguing with it (RLS decides whether the row may be
--       attempted; the trigger decides whether it lands), it carries its own message,
--       and it is the pattern this table already uses — brands_pin_ownership_trg
--       (sql/security-fixes-batch2.sql:65-99) is a BEFORE trigger on public.brands doing
--       structurally the same job, including the service-role exemption copied below.
--
-- ---------------------------------------------------------------------------
-- WHERE THE PLAN LIVES — read, not assumed
-- ---------------------------------------------------------------------------
-- TABLE public.user_plans, one row per user, keyed by user_id, plan name in a column
-- called `plan`:
--
--   api/_usage.js:590   `/rest/v1/user_plans?user_id=eq.${encodeURIComponent(userId)}&select=*`
--   api/_usage.js:611   const plan = (row && row.plan) || 'trial';
--   api/delete-account.js:44  const USER_SCOPED = ['dfy_requests','usage_events','user_plans'];
--
-- THE PLAN THAT APPLIES IS NOT ALWAYS THE COLUMN. api/_usage.js:610-618:
--
--     function effectivePlan(row) {
--       const plan = (row && row.plan) || 'trial';
--       if (plan === 'trial') {
--         const ends = row && row.trial_ends_at ? new Date(row.trial_ends_at) : null;
--         if (ends && Date.now() > ends.getTime()) return 'free';
--         return 'trial';
--       }
--       ...
--
-- so a NULL plan means trial, and an EXPIRED trial behaves as free. The trigger below
-- reproduces both rules against user_plans.plan and user_plans.trial_ends_at. It has
-- to: without them a signed-up-and-forgotten account would keep Pro-sized headroom
-- forever.
--
-- CAUTION, AND IT IS A REAL ONE: there is no CREATE TABLE for this table in the repo.
-- sql/security-fixes-batch2.sql:281-282 says so outright — "There is no CREATE TABLE for
-- user_plans, usage_events or dfy_requests anywhere in this repo". The column NAMES
-- above are read off the code that queries the table every day, which is strong
-- evidence, but the table's RLS settings and the exact type of trial_ends_at were NOT
-- verifiable from this repository. Everything below is therefore written so that a
-- missing table, a missing column, a wrong type or an RLS refusal ends in ALLOW — see
-- the next section.
--
-- ---------------------------------------------------------------------------
-- SAFETY REQUIREMENT 1 — ONBOARDING IS NEVER BLOCKED. HOW IT IS MET.
-- ---------------------------------------------------------------------------
-- api/_brandlimit.js:24-27 and :74-78 are unambiguous:
--
--     "this is a limit, but it must never be the reason a new account cannot start"
--     // ONBOARDING IS NEVER BLOCKED. A user with no brands gets their first one even
--     // if the plan read below would have failed, and even if a future limit table said 0.
--     if (brands === 0) { … reason: 'first_brand' }
--
-- The trigger does the same thing in the same order, and that order is the mechanism:
-- it counts the user's existing brands BEFORE it has looked at any plan at all, and
-- returns NEW on zero. The plan lookup is not merely ignored in that case — it is
-- never reached. So a missing user_plans row, an unreadable one, an RLS refusal or a
-- limit table that someone edits to 0 tomorrow cannot block a first brand, because
-- none of them is consulted. The VERIFY has an arm that fails if that early return is
-- ever edited out of the body.
--
-- ---------------------------------------------------------------------------
-- SAFETY REQUIREMENT 2 — FAIL OPEN, NOT CLOSED. HOW IT IS MET.
-- ---------------------------------------------------------------------------
-- Every single way this can not-know ends in `return new`:
--
--   auth.uid() is null          -> allow. Service role and SQL editor. Same exemption,
--                                  same reasoning, as sql/security-fixes-batch2.sql:74-77
--                                  ("Service role / backend jobs have no auth.uid():
--                                  leave them alone").
--   the brand count query raises-> allow (wrapped in its own exception handler).
--   the user owns 0 brands      -> allow. Requirement 1.
--   public.user_plans missing   -> allow (to_regclass guard).
--   the plan query raises       -> allow. This is what catches a renamed column, a
--                                  wrong type, or a permission error.
--   no user_plans row           -> allow. A user who has never touched /api/usage has
--                                  no row (api/_usage.js:588-607 creates it lazily).
--   an UNRECOGNISED plan name   -> allow, treated as unlimited.
--   plan is agency              -> allow, unlimited.
--
-- That last one is a DELIBERATE DIVERGENCE from api/_brandlimit.js:40-43, which falls
-- an unknown plan name back to the FREE allowance. In JavaScript that fallback decides
-- what a button looks like. Here it would decide whether a paying customer can use the
-- product, and a plan string this file has not been taught (say a future `pro_annual`
-- written by a Stripe webhook through api/_usage.js:904-908) would lock that customer
-- out of their own account. A paying customer locked out is far worse than one extra
-- brand, so the unknown case opens. It is called out again in the limit table below.
--
-- The trigger also NEVER writes and never modifies NEW. It either returns the row it
-- was given, unchanged, or raises. There is no state it can corrupt.
--
-- ONE THING THIS FILE LEANS ON AND CANNOT PROVE HERE: the allowance is counted against
-- `coalesce(new.user_id, auth.uid())`, i.e. against the row's declared owner. That is
-- only the right question if the live INSERT policy on brands already refuses a row
-- whose user_id is somebody else's. Every sign says it does — app.html:7493 resets
-- `brandData.user_id = currentUser.id` before retrying, and brands_pin_ownership
-- (security-fixes-batch2.sql:79-82) exists precisely to make ownership immutable from a
-- client, though note that trigger is BEFORE UPDATE (security-fixes-batch2.sql:97-99) and
-- so says nothing about INSERT — but that policy is not in this repo (see below) and was
-- NOT read. If it
-- turns out a client CAN insert a brand owned by another user, the brand limit is the
-- least of the problems, and this line is not what should be fixed.
--
-- ---------------------------------------------------------------------------
-- SAFETY REQUIREMENT 3 — THE NUMBERS LIVE IN EXACTLY ONE PLACE.
-- ---------------------------------------------------------------------------
-- public.brand_limit_for(text), below. It is the ONLY place in this database where a
-- brand count appears; the trigger holds no number of its own and the VERIFY reads the
-- numbers back out of it rather than restating them. It is the SQL twin of
-- BRAND_LIMITS in api/_brandlimit.js:39, which that file calls "THE POLICY … deliberately
-- the only place a brand count is decided" (api/_brandlimit.js:35-38).
--
-- ►► THE TWO MUST BE CHANGED TOGETHER. The constant is `BRAND_LIMITS`, on line 39 of
--    the file `api/_brandlimit.js`. Change one without the other and the app will offer
--    a brand the database then refuses, or refuse one the database would have allowed.
--
-- ►► AND THEY DISAGREE TODAY, ON PURPOSE. api/_brandlimit.js:39 currently reads
--       const BRAND_LIMITS = { trial: 1, free: 1, starter: 1, pro: 1, agency: Infinity };
--    This file uses pro 2 and trial 2, per Jörgen's decision and per the pricing page
--    (index.html:715, "2 brands on one account", in the Pro tier at index.html:710).
--    The JS is the side that is wrong — it is stricter than what Pro is sold as — and it
--    is not edited here because api/_brandlimit.js is owned by another change this round.
--    THIS IS AN OPEN ITEM: until that line says `{ trial: 2, free: 1, starter: 1, pro: 2,
--    agency: Infinity }`, /api/usage will tell a Pro user with one brand that they cannot
--    create a second, while this trigger would happily let them. That direction is the
--    safe one (the UI under-promises, the database does not wrongly refuse), which is why
--    it is acceptable to ship this file first — but it is not finished until both say 2.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE WITH USERS ON THE SITE
-- ---------------------------------------------------------------------------
-- * Nothing that works today stops working. The only new refusal is on an INSERT into
--   brands by a signed-in user who ALREADY OWNS at least one brand and whose plan is
--   known and finite. Reading, updating and deleting brands are untouched; no policy is
--   dropped, created or altered by this file.
-- * EXISTING brands are never affected. This is a BEFORE INSERT trigger only. A user
--   who is already over the limit (there was nothing stopping them until now) keeps
--   every brand they have; they simply cannot add another. Nothing is deleted, hidden
--   or downgraded, and no support ticket is generated by running this file.
-- * create or replace function + drop trigger if exists + create trigger: re-running
--   produces the identical end state.
-- * The whole install is one DO block, and DDL in PostgreSQL is transactional, so no
--   session can observe a half-installed state.
-- * CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on public.brands. That blocks
--   concurrent WRITES to brands for the instant the statement runs; it does not block
--   reads, so nobody's app goes blank. brands is a tiny table and there is no rewrite.
-- * to_regclass guards the table, so an install without `brands` is skipped rather than
--   erroring half way.
-- * Neither new function makes sql/v657-search-path.sql's VERIFY report anything:
--   brands_enforce_limit is SECURITY DEFINER *with* a pinned search_path, and
--   brand_limit_for is SECURITY INVOKER.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1 of 3 — THE LIMIT TABLE. The one place a brand count is written.
--          NULL means UNLIMITED (there is no "0 brands" plan and there must not be).
-- ---------------------------------------------------------------------------
create or replace function public.brand_limit_for(p_plan text)
returns integer
language sql
immutable
security invoker
set search_path = public, pg_temp
as $fn$
  -- Mirrors BRAND_LIMITS in api/_brandlimit.js:39 — CHANGE BOTH OR NEITHER.
  -- Sourced from the pricing page, which is what the company actually sells:
  --   index.html:702  Free    "40 posts a month, one brand"
  --   index.html:715  Pro     "2 brands on one account"
  --   index.html:729  Agency  "Multiple brands & seats for your team"
  -- `trial` inherits Pro because the trial IS Pro (index.html:695, "Try Pro free for
  -- 7 days"). `starter` appears nowhere on the pricing page — it exists only in
  -- api/_usage.js:34 — so it takes the Free allowance.
  select case lower(coalesce(p_plan, ''))
           when 'free'    then 1
           when 'starter' then 1
           when 'trial'   then 2
           when 'pro'     then 2
           when 'agency'  then null::integer   -- unlimited
           -- A plan name this table has not been taught is UNLIMITED, not free.
           -- See "FAIL OPEN" in the header: guessing low here locks a paying customer
           -- out of their own product. Deliberately unlike api/_brandlimit.js:40-43.
           else                null::integer
         end
$fn$;


-- ---------------------------------------------------------------------------
-- 2 of 3 — THE RULE. Reads only; returns NEW or raises.
--          SECURITY DEFINER so that the plan row can actually be read regardless of
--          what RLS user_plans carries (the repo cannot tell us — see the header).
--          search_path is pinned for the reason given in sql/v657-search-path.sql:5-11.
-- ---------------------------------------------------------------------------
create or replace function public.brands_enforce_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid   uuid := auth.uid();
  v_owner uuid;
  v_count integer;
  v_plan  text;
  v_ends  timestamptz;
  v_limit integer;
  v_found boolean := false;
begin
  -- Service role / backend jobs / the SQL editor have no auth.uid(): leave them alone.
  -- Same exemption as public.brands_pin_ownership (security-fixes-batch2.sql:74-77).
  if v_uid is null then
    return new;
  end if;

  -- Whose allowance is being spent. api/_brandlimit.js:45-46: "Membership of somebody
  -- else's brand is not ownership and does not count against a seat's own allowance".
  v_owner := coalesce(new.user_id, v_uid);

  -- ── ONBOARDING GATE ──────────────────────────────────────────────────────────
  -- Counted FIRST, before any plan is read, so that no plan problem can ever reach a
  -- user who has no brands yet. Do not move this below the plan lookup.
  begin
    select count(*) into v_count from public.brands where user_id = v_owner;
  exception when others then
    return new;                      -- cannot count -> allow
  end;

  if v_count is null or v_count = 0 then
    return new;                      -- FIRST BRAND IS ALWAYS ALLOWED
  end if;
  -- ─────────────────────────────────────────────────────────────────────────────

  if to_regclass('public.user_plans') is null then
    return new;                      -- no plan table -> allow
  end if;

  begin
    select p.plan::text, p.trial_ends_at
      into v_plan, v_ends
      from public.user_plans p
     where p.user_id = v_owner
     limit 1;
    v_found := found;
  exception when others then
    return new;                      -- missing column, wrong type, denied -> allow
  end;

  if not v_found then
    return new;                      -- no plan row yet -> allow
  end if;

  -- effectivePlan(), api/_usage.js:610-618: null means trial, an expired trial is free.
  v_plan := lower(coalesce(v_plan, 'trial'));
  if v_plan = 'trial' and v_ends is not null and v_ends < now() then
    v_plan := 'free';
  end if;

  v_limit := public.brand_limit_for(v_plan);

  if v_limit is null then
    return new;                      -- unlimited, or a plan name we do not know -> allow
  end if;

  if v_count < v_limit then
    return new;                      -- within the allowance
  end if;

  -- The only path that refuses. The message is shown to the user verbatim by
  -- app.html:7509-7512 (the `else if (error)` branch: `alert('Brand save error: ' + error.message)`), so it is written to
  -- be read by a person. It deliberately does NOT contain the words "row-level
  -- security": app.html:7487 matches on that string and would refresh the session and
  -- retry the insert, turning one refusal into two.
  raise exception
    'Your plan includes % brand(s) and you already have %. Upgrade your plan to add another brand.',
    v_limit, v_count
    using errcode = '42501',
          hint = 'plan=' || v_plan || ' owned=' || v_count || ' limit=' || v_limit;
end;
$fn$;

-- Trigger functions cannot be called directly ("trigger functions can only be called as
-- triggers"), but PUBLIC EXECUTE is granted by default on CREATE FUNCTION and this repo
-- closes that by hand — see sql/v658-revoke-security-health.sql:69-77, which also records
-- why revoking is safe: "PostgreSQL checks EXECUTE on a trigger function when the TRIGGER
-- IS CREATED, not each time it fires". brand_limit_for is deliberately NOT revoked: it
-- takes no input but a plan name, returns a number already printed on the pricing page,
-- and the VERIFY below reads it.
revoke all on function public.brands_enforce_limit() from public;


-- ---------------------------------------------------------------------------
-- 3 of 3 — ATTACH IT.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.brands') is null then
    raise notice 'v659-brand-limit: brands does not exist — skipping';
    return;
  end if;

  drop trigger if exists brands_enforce_limit_trg on public.brands;
  create trigger brands_enforce_limit_trg
    before insert on public.brands
    for each row execute function public.brands_enforce_limit();

  raise notice 'v659-brand-limit: installed — first brand always allowed, then free/starter 1, trial/pro 2, agency unlimited';
end $$;


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = the limit is installed AND it cannot refuse
-- anybody their first brand.
--
-- Five arms:
--   * arm 1 — the trigger is not attached, or is DISABLED. Not installed.
--   * arm 2 — the limit table function is gone. The trigger would have nothing to
--             consult; it fails open, so the limit is silently off.
--   * arm 3 — ONBOARDING: the "first brand is always allowed" early return has been
--             edited out of the trigger body.
--   * arm 4 — ONBOARDING: some plan has been given a limit of 0, which would refuse a
--             first brand the moment arm 3 also regressed. api/_brandlimit.js:75 names
--             this exact mistake ("even if a future limit table said 0").
--   * arm 5 — THE TRAP: somebody re-implemented this as a PERMISSIVE INSERT policy on
--             brands. Permissive policies OR together, so such a policy refuses nothing
--             and only looks like enforcement. (A RESTRICTIVE one would be legitimate
--             and is not flagged.)
--
-- Arms 3 and 4 read the function bodies out of the catalog rather than CALLING them, so
-- that this query still returns rows — instead of erroring — on a database where the
-- install above was never run.
--
-- To see the numbers themselves, run this separately (it is not part of the VERIFY
-- because it errors rather than reports when nothing is installed):
--   select p as plan, coalesce(public.brand_limit_for(p)::text, 'unlimited') as brands
--   from unnest(array['free','starter','trial','pro','agency','something_new']) p;
-- ============================================================================
select 'brands' as problem,
       'no enabled BEFORE INSERT trigger brands_enforce_limit_trg — the brand limit is NOT installed; ' ||
       'brands can be created without limit straight from the browser (app.html:7486)' as detail
where to_regclass('public.brands') is not null
  and not exists (
    select 1 from pg_trigger t
    where t.tgrelid = to_regclass('public.brands')::oid
      and not t.tgisinternal
      and t.tgname = 'brands_enforce_limit_trg'
      and t.tgenabled <> 'D'
  )

union all

select 'brand_limit_for',
       'public.brand_limit_for(text) is missing — the trigger has no limit table to consult ' ||
       'and every insert falls through its allow path'
where to_regclass('public.brands') is not null
  and to_regprocedure('public.brand_limit_for(text)') is null

union all

select 'brands_enforce_limit',
       'ONBOARDING AT RISK — the trigger body no longer returns early on a zero brand count, ' ||
       'so a user with no brands can now be refused their FIRST one'
where to_regprocedure('public.brands_enforce_limit()') is not null
  and pg_get_functiondef(to_regprocedure('public.brands_enforce_limit()')::oid)
      !~ 'v_count[[:space:]]*=[[:space:]]*0'

union all

select 'brand_limit_for',
       'ONBOARDING AT RISK — the limit table maps a plan to 0 brands; no plan may ever allow fewer than 1'
where to_regprocedure('public.brand_limit_for(text)') is not null
  and pg_get_functiondef(to_regprocedure('public.brand_limit_for(text)')::oid)
      ~ 'then[[:space:]]+0[^0-9]'

union all

select 'brands',
       'policy "' || policyname || '" is a PERMISSIVE ' || cmd ||
       ' policy that tries to enforce the brand limit — permissive policies are OR-ed together, ' ||
       'so it cannot refuse any insert the existing INSERT policy already allows'
from pg_policies
where schemaname = 'public' and tablename = 'brands'
  and cmd in ('INSERT', 'ALL')
  and permissive = 'PERMISSIVE'
  and coalesce(with_check, '') ~* '(user_plans|brand_limit)'

order by 1, 2;
