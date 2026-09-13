# Gates: audit every claim made on 2026-08-26

OWNS: scripts/verify/**, GATES.md

Scope: prove or disprove each substantive "this is fixed" claim from today with a runnable oracle, and name every claim that only Jörgen can decide as an explicit handoff rather than reporting it as done.

- [x] G1: every JS the app ships parses — app.html's 5 inline blocks, all api/*.js, sw.js, mobile-user.js
  CHECK: node scripts/verify/parse-all.mjs
  EXPECT: parse verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=59586780d7817f7070538f92315de04d94f7ccbb52716919d9f0b5bbf4e50388; output-bytes=64

- [ ] G2: no LLM endpoint's worst-case internal timeout exceeds its platform maxDuration
  CHECK: node scripts/verify/timeout-budgets.mjs
  EXPECT: timeout budget verification passed
  EVIDENCE: pending

- [ ] G3: the SW BUILD stamp is a real content hash of app.html — changes on edit, restores on revert, backend agrees
  CHECK: node scripts/verify/build-stamp.mjs
  EXPECT: build stamp verification passed
  EVIDENCE: pending

- [ ] G4: ON-SCREEN TEXT is gone from generation, display and both copy-alls, while both load paths survive so existing ideas still open
  CHECK: node scripts/verify/onscreen-removed.mjs
  EXPECT: onscreen removal verification passed
  EVIDENCE: pending

- [ ] G5: the critical-path headline cannot blame the app when the QA driver dies, and cannot claim the chain works from a partial run
  CHECK: node scripts/verify/verdict-honesty.mjs
  EXPECT: verdict honesty verification passed
  EVIDENCE: pending

- [ ] G6: shelved features fire no crons and serve no routes, while the two live crons remain
  CHECK: node scripts/verify/shelved-silent.mjs
  EXPECT: shelved silence verification passed
  EVIDENCE: pending

- [ ] G9: every CSS custom property used in app.html is actually declared, so none silently hardcodes a fallback or fails to apply
  CHECK: node scripts/verify/css-vars.mjs
  EXPECT: css var verification passed
  EVIDENCE: pending

- [ ] G10: the QA harness defects are fixed — cleanup function actually parses, preflight runs on the normal login path, a CLICK BLOCKED diagnostic can no longer flip a pass to a fail, driver-death is reachable
  CHECK: node scripts/verify/harness-fixes.mjs
  EXPECT: harness fixes verification passed
  EVIDENCE: pending

- [ ] G11: no backend fetcher can hang forever — every size-capped fetch settles with the data it collected instead of destroying the stream unresolved
  CHECK: node scripts/verify/backend-fixes.mjs
  EXPECT: backend fixes verification passed
  EVIDENCE: pending

- [ ] G12: the brand brain actually reaches the model — approved winners, learned signals, competitors and review insights all appear in the generate-ideas prompt, and the winners sit after the generic rules
  CHECK: node scripts/verify/brand-prompt.mjs
  EXPECT: brand prompt verification passed
  EVIDENCE: pending

- [ ] G13: a save can never leave the idea library absent from the database, a failed save is reported instead of claimed as success, and a DB error at boot is not mistaken for a brand-new user
  CHECK: node scripts/verify/data-integrity.mjs
  EXPECT: data integrity verification passed
  EVIDENCE: pending

- [ ] G14: dark mode is correct — no dark fix is overridden by a later !important rule, every listed control resolves to a readable pair, and no fixed opacity:0 element can swallow taps
  CHECK: node scripts/verify/dark-mode.mjs
  EXPECT: dark mode verification passed
  EVIDENCE: pending

- [ ] G15: the dark-mode oracle can actually fail — every defect re-broken in a temp copy is detected, including the historical "fix written without !important" failure mode
  CHECK: node scripts/verify/dark-mode.selftest.mjs
  EXPECT: dark mode selftest passed
  EVIDENCE: pending

- [ ] G16: user input cannot inject multipart headers, and a malformed provider response cannot 500 the request
  CHECK: node scripts/verify/backend-hardening.mjs
  EXPECT: backend hardening verification passed
  EVIDENCE: pending

- [ ] G17: app.html stays structurally sound — all 5 inline scripts parse and every style block is brace-balanced
  CHECK: node scripts/verify/app-html-integrity.mjs
  EXPECT: app.html integrity passed
  EVIDENCE: pending

- [ ] G18: the camera, mic and blur pump are released when the take ends — nothing competes with the render
  CHECK: node scripts/verify/filming-fixes.mjs
  EXPECT: PASS
  EVIDENCE: pending

- [ ] G19: onboarding never promises a finished brand brain and then shows a locked control
  CHECK: node scripts/verify/onboarding-fixes.mjs
  EXPECT: PASS
  EVIDENCE: pending

- [ ] G20: no internal file is publishable, every required public asset survives, security headers present
  CHECK: node scripts/verify/public-exposure.mjs
  EXPECT: PASS
  EVIDENCE: pending

- [ ] G21: every metered action consumes credits, the cost fuse is armed, no endpoint is ungated
  CHECK: node scripts/verify/spend-cap.mjs
  EXPECT: PASS: spend-cap
  EVIDENCE: pending

- [ ] G22: client-supplied brand context cannot become an unbounded LLM bill
  CHECK: node scripts/verify/brand-context-cap.mjs
  EXPECT: PASS: brand-context-cap
  EVIDENCE: pending

- [ ] G23: user and model text cannot execute — escaping holds under payloads, benign content unmangled
  CHECK: node scripts/verify/xss-escaping.mjs
  EXPECT: PASS xss-escaping
  EVIDENCE: pending

- [ ] G24: account deletion can never report a success it did not achieve
  CHECK: node scripts/verify/deletion-honesty.mjs
  EXPECT: PASS — delete-account checks every delete status
  EVIDENCE: pending

- [ ] G25: deleting an account cancels the subscription — and never hides a failure to cancel
  CHECK: node scripts/verify/stripe-cancel-on-delete.mjs
  EXPECT: PASS: stripe-cancel-on-delete
  EVIDENCE: pending

- [ ] G26: nothing from a website crawl reaches the brand brain unseen; junk rejected, real brand copy kept
  CHECK: node scripts/verify/crawl-review.mjs
  EXPECT: PASS — crawl findings reach the brand brain only through review
  EVIDENCE: pending

- [ ] G27: the QA harness actually exercises today's fixes, with no unrestored stub and no eaten backslash
  CHECK: node scripts/verify/harness-coverage.mjs
  EXPECT: PASS — harness coverage verified
  EVIDENCE: pending

- [x] G7: trend source links are visible in the running app on Jörgen's phone
  EVIDENCE: MANUAL — Jörgen confirmed on his phone 2026-08-26: "G7 seemed to work". Sources render.
  He also reported a perceived lag between "finished" and the chips appearing. Diagnosed: NOT a render
  delay (renderTrendMemory runs synchronously before the toast) — the status ticker's fixed 50s countdown
  hit zero and displayed "wrapping up…", which reads as FINISHED while the request was still in flight.
  Fixed in v617: past the estimate it holds one honest line and counts UP ("Still pulling — N s over").

- [ ] G28: Quick Post uploads nothing the server discards, and never gives up before the server does
  CHECK: node scripts/verify/request-payload.mjs
  EXPECT: PASS: request-payload
  EVIDENCE: pending

- [ ] G29: Quick Post sends only what the database cannot know, and loses no brand field doing it
  CHECK: node scripts/verify/lean-payload.mjs
  EXPECT: PASS: lean-payload
  EVIDENCE: pending

- [x] G30: no Quick Post action button can be a silent no-op
  EVIDENCE: oracle PASS + MANUAL — Jörgen 2026-08-27: "i did quick post test atm yes with viral twist
  and sharpen and worked". Viral Twist was the reported dead button; it now reaches the server
  (viral-twist 200 at 06:55:58) and returns.
  CHECK: node scripts/verify/tv-dead-buttons.mjs
  EXPECT: PASS: tv-dead-buttons
  EVIDENCE: pending

- [x] G31: xAI reasoning depth is set explicitly and never left on the slow "high" default
  EVIDENCE: MANUAL+LOGS — before: `xAI EMPTY 200 after 52771ms, completion_tokens: 0`. After (v624,
  effort=low): generate-ideas 200 at 06:55:32, viral-twist 200 at 06:55:58, no empty 200s, no retries.
  Jörgen confirmed on his phone: "okay now worked".
  CHECK: node scripts/verify/reasoning-effort.mjs
  EXPECT: PASS: reasoning-effort
  EVIDENCE: pending

- [ ] G32: every endpoint receiving a lean request hydrates the brand and can refuse a stale row
  CHECK: node scripts/verify/lean-hydration.mjs
  EXPECT: PASS: lean-hydration
  EVIDENCE: pending

- [ ] G33: Ideas and Remix no longer upload the whole brand brain either
  CHECK: node scripts/verify/lean-payload-all.mjs
  EXPECT: PASS: lean-payload-all
  EVIDENCE: pending

- [x] G34: one brand renderer — the coach reads the same brain as every generator, and no endpoint can grow a second renderer that quietly falls behind
  CHECK: node scripts/verify/one-brand-renderer.mjs
  EXPECT: PASS: one-brand-renderer
  EVIDENCE: measured with a sentinel fixture, one unique marker per brand field —
  coach BEFORE (hand-rolled): 20/28 fields, 91-char brand section
  coach AFTER  (shared):      28/28 fields, 2779-char brand section
  never reached the coach until now: website, reviewInsights, webMentions, categoryGripes,
  learnedSignals, channels, competitorMoves, approvedExamples.
  Mutation-tested 5 ways, 5 caught: rebuild brandBlock by hand while keeping the import (caught only
  AFTER tightening — the first version of this gate checked the variable NAME and passed the mutant),
  drop the import, drop a field from the shared renderer, delete the coach persona, and add a brand-new
  endpoint that hand-rolls 7 brand fields.

- [ ] G8: generated output is good enough that Jörgen would actually publish it
  EVIDENCE: pending

- [x] G35: the money path cannot report a success it did not achieve, and every metered endpoint both blocks and records
  CHECK: node scripts/verify/billing-honesty.mjs
  EXPECT: PASS: billing-honesty
  EVIDENCE: setPlan swallowed every failure with no log and all 3 callers discarded the boolean —
  checkout-confirm answered {ok:true,plan:'pro'} after a failed plan write (card charged, plan not
  applied), and stripe-webhook answered 200, which tells Stripe never to retry (cancelled customer
  keeps paid access forever / paying customer stays on free). Both fixed; webhook now returns
  non-2xx so Stripe redelivers. stock-photo called guard() and checked neither _g.over nor logged
  usage — the only handler in the app doing so, and each missing half hid the other.
  Mutation-tested 4 ways, 4 caught: discard the result, capture-but-never-branch, silence setPlan,
  remove the over-limit block. The FIRST version of this gate refused to pass when it could not
  reach setPlan (both runs returned an identical 401 / "billing not configured") and said so
  instead of going green — the check was then rewritten to assert only what it can actually prove.

- [x] G36: no endpoint hand-rolls a second brand renderer (see G34) — extended to cover the retired blog
  EVIDENCE: brand-prompt.mjs no longer asserts generate-blog.js reaches an LLM; that endpoint is a
  410 stub as of v627 because the blog feature was retired outright at Jörgen's instruction.

- [x] G37: after a day of deletions, nothing in the UI points at something that no longer exists
  CHECK: node scripts/verify/no-dangling-refs.mjs
  EXPECT: PASS: no-dangling-refs
  EVIDENCE: v633-v636 deleted three whole features (publishing, the marketing blog, the Master
  Prompt doc) and ~55KB of app.html. Parsing proves the file is still valid JavaScript; it says
  NOTHING about whether a button still calls a function that exists or a nav entry still leads to
  a view that exists. Those two break at TAP TIME, in front of the user, and no gate caught them.
  Measured clean after the deletions: 308 inline handlers all resolve, 7 switchView targets all
  have markup, 0 NUL bytes. Mutation-tested 3 ways, 3 caught: point a button at a deleted
  function, point nav at a removed view, reintroduce a raw NUL byte (which happened twice in one
  day and makes the file read as BINARY to grep/diff, hiding it from every text tool).
  Deliberately does NOT check getElementById targets — most elements are created at render time,
  so a static check there is mostly false positives, and a gate that cries wolf gets ignored.

- [x] G38: the shared Supabase timeout fits the tightest endpoint that can reach it, computed not remembered
  CHECK: node scripts/verify/timeout-budgets.mjs
  EXPECT: PASS (prints the floor it computed)
  EVIDENCE: production fired the v628 4s Supabase cut three times in two days — send-daily's
  job_heartbeats write (x2) and pull-trends-cron's approved-titles read (x1). Both run under
  maxDuration 300: a 4s ceiling inside a 300s budget. The heartbeat failure is the worst of the
  two, because it made /api/health report the cron as unobserved even though it HAD run — a false
  alarm in the one monitor built to detect a dead cron. Measured before changing anything: the
  tightest callers (stripe-webhook, checkout-confirm) make ~2 sequential Supabase calls inside the
  ~10s platform default, so 4s is CORRECT there and raising it globally would trade a logged
  timeout for a silent platform kill on the money path. Fixed per-caller instead
  (store/_usage.setRequestBudget, clamped 4s-60s), crons raise themselves to 20s. This floor had
  been worked out by hand four times (v606 and v627 both missed it and shipped an endpoint on the
  default; v628 computed it; v637 recomputed it after v629 deleted two of the endpoints that set
  it) — so the gate computes it now. Mutation-tested 3 ways, 3 caught: raise the default globally
  (names the constraining endpoint and the arithmetic), make the constant unreadable (fails loudly
  rather than passing vacuously), give the floor endpoint a budget (floor correctly MOVES to the
  next tightest, proving it computes rather than hardcodes).

- [x] G39: a backend-only deploy is provable, and a red gate cannot corrupt app.html
  CHECK: node scripts/verify/build-stamp.mjs
  EXPECT: PASS: build stamp verification passed
  EVIDENCE: the silent-skip checklist listed "backend deploy currency" as FIXED because the stamp
  also writes api/_build.js — but the stamp hashed app.html ALONE, so a backend-only change
  produced an identical value and `curl /api/health` could not tell old backend code from new.
  Today's work was backend-only and would have been unverifiable. Split the two questions: sw.js
  BUILD still hashes app.html alone ("does the phone need the new app?" — adding the backend would
  push a needless ~196KB download to every phone on every backend deploy, the stall v309 fixed),
  while api/_build.js now appends a hash of all 44 api files. Proven: a backend-only edit moves the
  server stamp and leaves the phone stamp untouched. Mutation-tested: revert the server stamp to
  the app-only value (caught), freeze the api hash to a well-formed literal (caught by a new
  responsiveness probe — shape alone was passable). AND, found by mutating this gate: every failure
  used to call process.exit() inside the try, which does NOT run finally, so a red run left its own
  positive-control comment appended to app.html and the next stamp baked the corrupted hash in.
  Failures now throw; verified app.html is byte-identical after a deliberately-failed run.

- [x] G40: every surface that writes a script a person reads to camera actually receives the spoken-flow rule
  CHECK: node scripts/verify/spoken-shape.mjs
  EXPECT: spoken-shape: 12 passed, 0 failed
  EVIDENCE: Jörgen filmed a Quick Post and said it was "on point" but did not "sound organically
  like real human speaking". The script was noun phrases with full stops — "Sales follow-ups eating
  hours. Tools that don't talk." — 5 of 10 sentences with no finite verb, 44 words against a 90-150
  spec. Cause was a COVERAGE HOLE, not wording: the SPOKEN-SCRIPT SHAPE rule lived only inside
  writingCraft's opts.spoken branch, and generate-ideas.js — which writes every Quick Post, Ideas,
  Idea Catcher, Notebook-develop, PAA and auto-refill script — does not call writingCraft. Measured
  on the REAL assembled prompt (stubbing only the LLM): 0 flow rules present, 4 compression rules
  present (clarityFlow's "one idea per sentence" + "cut every word that isn't working", the video
  spec's "short sentences", and "never pad"). Cutting pressure with no counterweight strips every
  sentence to a noun phrase. Fixed by extracting spokenShape() as its own export, rewriting it from
  metaphor ("beats, not bullet points" — a model can satisfy a metaphor and still emit fragments)
  into checkable mechanics (complete sentences, connective tissue, listener-cannot-re-read
  restatement, varied length, a countable word floor, and an explicit override of the compression
  rules), appending it directly in generate-ideas, and removing the contradicting "short sentences"
  from the video format spec. writingCraft's branch now delegates to the same function so the two
  callers can never drift. Mutation-tested 3 ways, all caught: unwire it from generate-ideas
  (reintroduces the exact original bug), gut the rule back to a one-liner metaphor (7 assertions
  red), restore "short sentences" to the video spec. Files verified byte-identical afterwards.
  Asserts BEHAVIOUR (the rule reaches the assembled prompt) and CONCEPTS (the mechanics survive),
  never exact phrasing — an assertion coupled to copy punishes improving the copy (v619).

- [ ] G41: the founder's voice sample (v649) is collected in onboarding, editable with a mic in Settings, never routed through the coach, round-trips end to end, and is rendered LAST and capped in every generator's brand block
  CHECK: node scripts/verify/voice-sample.mjs
  EXPECT: voice-sample verification passed
  EVIDENCE: pending

- [ ] G42: the landing page (index.html) is structurally sound, advertises no shelved or removed feature, carries the live prices, and keeps the agreed shape (H1 promise, 6 format cards, 8 tool cards, 4 learn cards led by the voice, 4 comparison rows, pain strip + brain animation kept, loop iframe + hidden demo gone)
  CHECK: node scripts/verify/landing.mjs
  EXPECT: landing verification passed
  EVIDENCE: pending

- [x] G43: a first purchase is granted even when the browser never returns, a redelivered event neither double-applies nor downgrades, a failed plan write is non-2xx so Stripe retries, the usage read is complete and newest-first at any row count, every gated action is priced, and the allowance window follows the real plan period instead of the 1st of the month
  CHECK: node scripts/verify/money-path.mjs
  EXPECT: money path verification passed
  EVIDENCE: four money-path defects, each proved by EXECUTING the real handler rather than grepping.
  (1) GRANT — stripe-webhook handled only deleted/updated/payment_failed, none of which can grant,
  and resolved users via userIdByStripe(), which filters on stripe_subscription_id /
  stripe_customer_id — columns ONLY a successful checkout-confirm writes. Before a successful
  redirect no row carries them, so a closed tab meant charged-and-never-granted with nothing able
  to retry. The gate runs the real handler against a store whose lookup returns null on BOTH keys,
  so the grant tests can only pass via the subscription/session metadata create-checkout stamps.
  (2) USAGE READ — usageThisPeriod was one unbounded GET; PostgREST truncates at db-max-rows
  (1000), so the largest computable credit total was ~1000, BELOW the agency limit of 2500, which
  could never fire; and with no `order=` the OLDEST rows came back, so past 1000 rows/month the
  60-second burst window contained none of them. The gate runs the real function against a fake
  PostgREST that reproduces the truncation, Content-Range and gte/offset/limit/order semantics:
  2600 rows -> 2600 credits and a real checkLimit rejection (a single page yields 1000, under the
  limit), and at 26,000 rows — past the 25-page cap, where order is the ONLY thing that can put
  recent rows in reach — the burst window still sees all 70 (oldest-first sees 0). A truncated
  read blocks rather than failing open. (3) `sharpen` — two sequential LLM calls — was the only
  guard()ed action missing from BOTH weight maps; every guard(req,'x') site in api/*.js is checked
  against both, with a floor on site count so a broken scanner cannot pass vacuously.
  (4) WINDOW — periodStartForRow now anchors a trial to its start and a paid plan to its billing
  anniversary (clamping a 31st anchor into short months), falling back to the calendar month for a
  row with no dates; end to end, a trial started on the 28th read on the 2nd counts all 10 rows and
  filters the real query from the trial start, instead of resetting to 150 fresh credits.
  Mutation-tested 11 ways, 11 caught, every file byte-identical afterwards (sha256 compared):
  remove the metadata fallback; delete the checkout.session.completed handler; make applyPlan
  always write; answer 200 on a failed grant; answer 200 on a failed downgrade (the pre-existing
  v627 behaviour, proved to have survived); delete the PAID-BUT-UNRESOLVABLE log; revert the usage
  read to one unbounded GET; drop ONLY the desc ordering (isolates the burst fix — one assertion
  red, the rest green); unregister sharpen from ACTION_COST; force the window back to the calendar
  month; drop create-checkout's 409 double-subscribe refusal. Two of my own expectations were wrong
  before the code was — a 31st anchor read on the 20th correctly resolves to the PREVIOUS 31st, and
  periodStartForRow takes an explicit clock but its internal effectivePlan() call reads Date.now(),
  so trial classification follows the wall clock (harmless in production, where the caller always
  passes Date.now(); the gate runs those cases under a fake clock). Found while mutating: the gate
  crashed instead of naming a failure, and printed a success note after a failed assertion in the
  same block — both fixed (null-safe reads, notes gated on the failure count), because a gate that
  reports its own result wrongly is worse than no gate.

- [x] G43: app.html cannot re-open the brand-isolation, honesty and visibility bugs — no unguarded brand-scoped writer, no per-brand cache key resolved after an await, no raw localStorage on a bkey() key, no delete that reports a sweep it never performed, no ink-!important control invisible in dark mode, no top-aligned scrollIntoView target the sticky header crops
  CHECK: node scripts/verify/frontend-contract.mjs
  EXPECT: frontend contract verification passed
  EVIDENCE: exit=0; "frontend contract: 16 checks passed over 647 functions, 2633 CSS rules".
  One bug CLASS produced most of this round: a function reads the brand at call time, awaits a
  15-40s round trip, then WRITES using whatever brand is open when the response lands — so a
  switch mid-flight files brand A's data under brand B, silently and permanently. The gate is a
  SCAN, not a list of the functions that were fixed: it slices every top-level function, finds
  writes that land after a completed await, and requires a brandGate() (or switchBrand's
  _switchSeq token) captured before the await AND tested between that await and the write. Half
  the sink list is DERIVED rather than written down — addNewBrand() resets exactly the globals
  that belong to a brand, so whatever it clears counts as brand-scoped and a new global is picked
  up automatically. Pre-existing debt sits in a named KNOWN_UNGATED baseline that can only shrink
  (a stale entry fails the gate), so the scan's real job is the other direction: any writer NOT on
  that list — a new one, or a gated one whose gate was removed — fails immediately. The dark-mode
  check COMPUTES contrast from the declared theme tokens instead of naming selectors, and only
  counts a bare-class [data-theme="dark"] rule as coverage: a :hover or .recording override fixes
  a state, not the resting control, which is how four invisible Settings buttons survived an
  earlier dark-mode pass. Mutation-tested 14 ways, every one caught and named: read the scan flag
  through an undefined helper (the exact half-finished-rename shape — the ReferenceError is
  swallowed by the enclosing try and the feature dies silently) / through raw bkey(); rebuild the
  notebook cache key from currentBrand.id after the await; drop loadTeamData's assignment-time
  re-check; let loadAllBrandsFromDB swallow its read error; remove generateTodayTabPost's gate;
  revert obResetForTesting to an error-only wipe loop; drop .select('id') from its brands delete
  (the stashed-builder form, one indirection further out); revert deleteBrand's child sweep the
  same way; put raw localStorage.removeItem(bkey()) back in clearBrandLocalCache; delete the dark
  override; downgrade it to :hover only (computed 1.02:1); remove the new scroll-margin-top rule;
  and ADD A BRAND-NEW unguarded writer from scratch, which the scan caught by name — the control
  that proves it is a scan rather than a checklist. app.html verified byte-identical after every
  run (sha256 6ddabf66…); the mutation harness restores in a finally and never process.exit()s
  inside the try, per the G36 lesson.
