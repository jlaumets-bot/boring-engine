# Gates: member safety + the live-database questions v658 left open — 2026-09-15

OWNS: app.html, scripts/verify/start-over-owner-only.mjs, .unlazy/member-safety/GATES.md

Scope: close the app-side half of sql/v658-member-delete.sql (a member must not SEE the
"Start over" button, not merely fail when they press it), and answer — against the LIVE
production database, not from the repo — the three questions the v658 round left open.

## LIVE DATABASE ANSWERS (run 2026-09-15, production project content-engine, SQL editor)

Q1. Can a signed-in user upgrade themselves to Agency by writing user_plans directly?
    ANSWER: NO. Verified, not assumed.
    select tablename, policyname, cmd, roles::text, qual, with_check
      from pg_policies where schemaname='public'
       and tablename in ('user_plans','usage_events','dfy_requests');
    -> 4 rows, and every one of them is read-only or self-scoped:
         user_plans    user_plans_select_own    SELECT  {authenticated}  (auth.uid() = user_id)
         usage_events  usage_events_select_own  SELECT  {authenticated}  (auth.uid() = user_id)
         dfy_requests  dfy_select_own           SELECT  {authenticated}  (auth.uid() = user_id)
         dfy_requests  dfy_insert_own           INSERT  {authenticated}  check (auth.uid() = user_id)
    There is NO UPDATE, NO DELETE and NO "FOR ALL" policy on user_plans or usage_events.
    Under RLS, a command with no policy is denied — so plan writes and usage writes are
    reachable only through service_role (the serverless functions). Self-upgrade is closed,
    and usage rows cannot be deleted by the user to reset their own meter.

Q2. Is RLS actually ENABLED on those tables? (A policy on a table with RLS off is decoration.)
    ANSWER: YES, on every table checked.
    select relname, relrowsecurity, relforcerowsecurity from pg_class ...
    -> brands=true, dfy_requests=true, ideas=true, usage_events=true, user_plans=true
    (relforcerowsecurity is false everywhere, which is correct: it would also constrain the
    table OWNER, and Supabase's service_role deliberately bypasses RLS instead.)

Q3. Is security_health() still callable by the public?
    ANSWER: YES — STILL OPEN AS OF THIS RUN. This is the one live hole left.
    select proacl::text from pg_proc ... where proname='security_health';
    -> {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
    The leading "=X" is PUBLIC holding EXECUTE. anon and authenticated are members of PUBLIC,
    so any signed-in user — and plausibly any anonymous caller, since the anon key ships in
    app.html — can run sb.rpc('security_health') and read back which tables have RLS off, which
    carry permissive policies, and which brand-scoped tables are not bound to the caller.
    /api/health reduces all of that to booleans on purpose (api/health.js:126-139); the RPC
    behind it leaks exactly what that endpoint withholds.
    FIX IS WRITTEN AND WAITING: sql/v658-revoke-security-health.sql. HANDOFF — Jörgen runs it.
    I could not: the sandbox refuses database privilege changes ("Modify Shared Resources"),
    both through the SQL editor's Monaco model and through any other route. Not worked around.

## GATES

- [x] M1: the "Start over (re-run onboarding)" button renders for the brand OWNER and for
      nobody else — not a team member, not a signed-out/unloaded state.
  WHY: app.html obResetForTesting() (:15047) deletes on brand_id alone across ideas, remixes,
  product_refs, competitors, prompt_history, notebook_notes and edit_signals. Until
  sql/v658-member-delete.sql narrows DELETE to the owner, a member pressing this button
  destroyed the owner's whole library behind a single confirm. After that SQL runs the deletes
  are refused — but the button is then a dead control that always ends in "Some of this brand's
  data could not be removed". This gate is the app-side half: a member never sees it.
  CHECK: node scripts/verify/start-over-owner-only.mjs
  EXPECT: PASS: "Start over" renders for the brand owner only (member and signed-out both refused).
  EVIDENCE: exit=0. The gate is BEHAVIOURAL, not a grep: it lifts the actual ${...} interpolation
  wrapping the button out of app.html by brace-matching (template-literal aware), compiles it with
  new Function, and renders it three times — owner {user_id:'user-1'}/user 'user-1' MUST contain
  the button; member {user_id:'user-2'}/user 'user-1' MUST NOT; (null,null) MUST NOT. It also
  requires the member to be told who can do it, so the panel does not just grow a hole.
  MUTATIONS — 3 written, 3 caught, each with the right diagnosis:
    1. invert the test (=== -> !==)        -> FAIL "the BRAND OWNER can no longer see Start over"
    2. delete the condition, button always -> FAIL "button is outside the interpolation"
    3. replace the member explanation      -> FAIL "member sees neither the button nor an explanation"
  app.html verified byte-identical to the fixed version after the mutation run (cmp, exit=0);
  the harness restores through a shell EXIT trap so an abort cannot leave a mutant on disk.

- [x] M2: the whole suite still passes with the change in — 47/47 green, including parse-all,
      which is what proves the nested template literal added here is valid JS rather than a
      1.4MB file that no longer loads.
  CHECK: for f in scripts/verify/*.mjs; do node "$f"; done
  EXPECT: every gate exits 0
  EVIDENCE: 47 PASS / 0 FAIL, run 2026-09-15 after the edit and after the mutation restore.

- [x] M3: only the brand OWNER can remove a team member.
  FOUND BY M2's OWN VERIFY, not by looking. Arm 1 of sql/v658-member-delete.sql's verify scans
  the WHOLE schema for a DELETE/ALL policy whose predicate mentions user_brand_ids or
  brand_members, rather than a list of seven table names — written that way precisely because the
  defect class was "a table inherits a too-wide policy". It returned one row for a table that was
  not part of that change: brand_members.
  THE LIVE POLICY HAD DRIFTED FROM THE REPO. sql/team-tables.sql:58 declares
      USING (brand_id IN (SELECT id FROM brands WHERE user_id = auth.uid()))   -- owner only
  but production carried
      USING (brand_id IN (SELECT user_brand_ids() ...))                        -- owner OR member
  so every teammate could delete rows from brand_members and remove any other teammate.
  app.html:20768 already hides the remove button from non-owners, but removeMember()
  (app.html:7286) is a plain PostgREST delete — a hidden button is not access control.
  NOT BROKEN BY THE FIX, each checked rather than assumed: account deletion runs as service_role
  and bypasses RLS (api/delete-account.js:74-83) with brand_members cascading from brands
  (api/delete-account.js:36); no client path deletes one's own membership row (the only
  brand_members delete in app.html is removeMember at :7289); the SELECT policy is untouched.
  FIX: sql/v659-brand-members-delete.sql. Jörgen ran it; its 3-arm verify returned no rows.
  DECISION LEFT OPEN: a member now cannot LEAVE a team — only the owner can remove them. That
  matches the repo, the policy name and the UI. "Leave team" would need `OR user_id = auth.uid()`
  plus a button that does not exist. Not added on a guess.

## HANDOFF — only Jörgen can do these

- H1: DONE 2026-09-15 — sql/v658-revoke-security-health.sql run, verify returned no rows.
- H2: DONE 2026-09-15 — sql/v658-member-delete.sql run, verify returned one row, which was M3
      above (a different table), not a failure of the seven library tables.
- H2b: DONE 2026-09-15 — sql/v659-brand-members-delete.sql run, verify returned no rows.
- H3: PRICING DECISION, still open: api/_brandlimit.js:39 sets
      { trial:1, free:1, starter:1, pro:1, agency:Infinity }. Does Pro get more than one brand?
      The limit is computed server-side and nothing consumes it yet.
