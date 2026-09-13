# Gates: the full-sweep round — every defect three parallel audits found, 2026-09-13

Jörgen: "we need a fully working app without any bugs everything fully working."

Three read-only audits ran in parallel over disjoint scopes: app.html, api/, scripts/verify/.
The third one matters most: SEVERAL GATES CANNOT FAIL, so parts of the suite have been
certifying outcomes they never measured. Fix the oracles before trusting any green.

OWNS: app.html, api/**, scripts/verify/**, .vercelignore, .unlazy/full-sweep/GATES.md

ORDER IS DELIBERATE: the gates that cannot fail come FIRST (B-group), because every later fix
is verified by them. A fix proven by a blind gate is not proven.

## B — ORACLES THAT CANNOT FAIL (proven by mutation in /tmp, project untouched)

- [x] B1: billing-honesty checks EVERY metered endpoint, not just the one where the bug was found. Line 78 requires the literal `_g = await guard(` and so reaches 1 of 23 files; deleting both the over-limit block AND the logUsage call from viral-twist.js passes today.
  CHECK: node scripts/verify/billing-honesty.mjs
  EXPECT: PASS: billing-honesty
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] B2: spend-cap actually detects an UNGATED endpoint — its title claims "no endpoint is ungated" while checking two hardcoded filenames. A brand-new api/free-money.js with no auth and no guard passes today.
  CHECK: node scripts/verify/spend-cap.mjs
  EXPECT: PASS: spend-cap
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] B3: xss-escaping's call-site scan cannot be satisfied by proximity. A raw href="${x}" is excused when the string safeUrl( appears anywhere in the preceding 400 chars — so a new sink inside the same template literal as a safe one passes.
  CHECK: node scripts/verify/xss-escaping.mjs
  EXPECT: PASS xss-escaping
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] B4: build-stamp is green for a real reason. It is RED today because it commits its own probe file: api/_build_probe_tmp.js is in git, byte-identical to what the gate writes, so "add an api file" is a no-op. A red run also mutates api/_build.js and deletes the probe.
  CHECK: node scripts/verify/build-stamp.mjs
  EXPECT: build stamp verification passed
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] B5: api/_build_probe_tmp.js is not served to the public. public-exposure --explain says PUBLISHED.
  CHECK: node scripts/verify/public-exposure.mjs
  EXPECT: PASS
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] B6: public-exposure treats ANY non-asset file as sensitive, not a 7-extension allowlist. secrets.txt, notes.json, service-account.pem and backup.log all report PUBLISHED today.
  CHECK: node scripts/verify/public-exposure.mjs
  EXPECT: PASS
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] B7: bug-scan is a listed gate with a real oracle, or is deliberately abandoned with a reason. It is RED, appears zero times in GATES.md, and is the ONLY script that enumerates for a missing guard.
  CHECK: node scripts/verify/bug-scan.mjs
  EXPECT: no findings
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] B8: no assertion in the suite is a tautology or tests the gate's own copy of the code. voice-sample A3 compares lastIndexOf('ZQVS') with an algebraically identical expression; onboarding-fixes re-implements escHtml/vlEscAttr inline and tests those.
  CHECK: node scripts/verify/voice-sample.mjs && node scripts/verify/onboarding-fixes.mjs
  EXPECT: voice-sample verification passed
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] B9: GATES.md titles match what their CHECK measures — G21, G35, G23, G9, G1 all overclaim, and G40's EXPECT says "12 passed" while the script prints 22.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

## A — DATA CORRUPTION, user-visible (brand-bleed: capture brand, await, write to whoever is open now)

- [x] A1: generateAndCacheScenes cannot write brand A's scenes into brand B's DATABASE row. app.html:18869 — no gate, awaits an AI generation, then settings.dayScenes/quickScenes and saveBrandToDB() PATCH currentBrand.id. The only ungated writer found that reaches Supabase. Permanent, survives reload.
  CHECK: node scripts/verify/frontend-contract.mjs
  EXPECT: frontend contract verification passed
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] A2: pullWebTrends cannot append brand A's trends to brand B. app.html:20806, explicit 65s abort budget, writes lsSet('brand_trends') and assigns currentBrand.auto_trends. The store auto-feeds generation, so B's future ideas are built on A's trends.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] A3: generateBlogPosts, fetchPAAQuestions, loadSettingsExamples, refreshCreatorPosts, brainDistill, memeGenerate are all gated. app.html:23923, 13637, 19325, 18531, 8956, 17473.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] A4: blogImprove cannot silently discard the user's rewrite. app.html:24073 — after a switch, `post` is no longer in the reassigned blogPosts array, so saveBlogPosts() persists the untouched array. No error, no toast, work gone.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] A5: the Daily Idea Ping toggle reflects the CURRENT brand. daily-push-on / daily-push-hour / motivation-on are device-global flags (app.html:14473+) but the subscription rows are per-brand. Enable on A, switch to B: B reads ON with no subscription.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] A6: the dead SETTINGS_KEY write is removed. Written on every keystroke (8477) and never read — loadSettings() has no caller and the code says so at 7381. It carries base64 brandLogo/founderPhoto, so it is the most likely cause of the "This device's storage is full" QuotaExceededError at 8442.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] A7: deleteBrand removes notebook_<brandId>. Its sweep filters k.endsWith('::'+brandId), which does not match that key, so deleted brands leave notes behind forever.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

## C — BACKEND

- [x] C1: an unresolvable subscription.deleted/updated is never answered 200. api/stripe-webhook.js:185-190,251 logs only the `created` case; the others fall through to 200, Stripe stops retrying, and a cancelled customer keeps paid access forever with no log.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] C2: no outbound request can hang forever. api/speak.js:38-65 sets no socket timeout (the only https.request in api/ without one); api/transcribe.js:75-86 fetches YouTube innertube with no AbortSignal, so the HTML fallback at :95 is never reached.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] C3: crawl-social passes its timeout as a timeout. api/crawl-social.js:82 calls apifyRequest('GET',…,apiToken,DATASET_TIMEOUT_MS) against the signature (method,path,token,body,timeoutMs) — so 12000 is written as a GET body and the timeout silently falls back to 30s, collapsing the LLM budget to its 12s floor. The user pays for a completed Apify run and gets "Couldn't read your posts clearly".
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] C4: no money-spending call site is unmetered. api/health.js:236 `?ping=1` calls the real model behind a Bearer check only — no guard(), no logUsage(), in neither weight map. A signed-in free account can loop it.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] C5: a body-less POST answers 400, not 500. Nine handlers destructure req.body directly (speak:21, transcribe:64, transcribe-voice:57, transcribe-url:95, crawl-social:37, people-also-ask:23, brand-voice-chat:19, generate-ideas:109, remix:21); two leak the raw error message.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

- [x] C6: usage rows cannot be attributed to a brand the caller does not own. Eight handlers log an unverified client-supplied brandId; four others already call store.userCanAccessBrand first.
  EVIDENCE: met 2026-09-13 — see the RUN RECORD at the end of this file

## HANDOFF — Jörgen only
- [ ] H1: phone — open contentshrimp.com/app.html once, then contentshrimp.com. Closes landing-freshness G6 and landing-rewrite G5.
- [ ] H2: push the backup branch (no credentials in the agent shell): git push origin HEAD:backup-2026-09-13


## RUN RECORD — 2026-09-13, v656-ee99fe10+api.1f61069d

Three fixers ran in PARALLEL over disjoint OWNS (scripts/verify+.vercelignore | api/** | app.html),
then three cross-cutting items were closed by hand. FINAL: 42 of 42 gates green, 0 red.

ORACLES (the part that mattered most — these were certifying outcomes they never measured):
- billing-honesty reached 1 of 23 metered endpoints; now 23, with a printed REACHED floor of 20.
  Mutation: strip the over-limit block + logUsage from viral-twist.js -> RED (was green).
- spend-cap could not see an ungated endpoint at all; now enumerates all 45 api files
  (26 metered, 10 allowlisted with a mechanically re-checked reason, 0 ungated).
  Mutation: add api/free-money.js with no auth -> RED (was green), incl. a variant where the
  auth words appear only in a comment and a string.
- xss-escaping excused a raw href when "safeUrl(" appeared within 400 chars; now judges the
  interpolated EXPRESSION itself. Its extractor also stopped at the first "}", which hid 1 href
  and ALL 4 src sinks containing {allowData:true} — brace-balanced now, with a count check.
  THIS FOUND A REAL LIVE XSS: app.html:15677 rendered ${slide.text} raw into a <textarea>, and
  slide.text is LLM-generated carousel content, so a "</textarea>" in a generated idea broke out
  of the element. Fixed to ${escHtml(slide.text)}.
- build-stamp was RED because it COMMITTED its own probe file (api/_build_probe_tmp.js), making
  "add an api file" a no-op; a red run also mutated api/_build.js and deleted the tracked probe.
  Probe is now uniquely named per run, .vercelignore'd, and app.html/sw.js/api/_build.js are
  snapshotted and restored in finally (proven byte-identical after a forced failure).
- public-exposure used a 7-extension denylist; inverted to an allowlist of known public asset
  types. This immediately found three REAL exposures, now excluded: /.gitignore, /.vercelignore,
  and /CLAUDE.md.bak-20260913 — 900KB of internal architecture that was publishable.
- voice-sample A3 was the tautology lastIndexOf(x) === lastIndexOf(x); replaced with the claim it
  advertises, plus a negative control.
- onboarding-fixes tested the gate's OWN copies of escHtml/vlEscAttr; now lifts the real ones out
  of app.html.
- bug-scan was RED, and appeared ZERO times in GATES.md despite being the only enumerating scan.
  Its 5 false positives are gone (2 "dead handlers" that were a keyword and a comment; 3
  "unguarded" endpoints that authenticate by bearer, 410 stub and Stripe signature). The 12
  remaining localStorage findings were judged, not silenced: 8 are device-global keys now in a
  documented DEVICE_GLOBAL allowlist, notebook_<id> pins its brand id before the await.
  Mutation: add a brand-scoped bare write -> RED. New shared scripts/verify/_srcscan.mjs strips
  comments/strings/regex literals and self-tests 12 cases before any consumer trusts it.

CLIENT — 12 fixes, all brand-bleed or dead weight (app.html only):
- generateAndCacheScenes: the only one that reached the DATABASE. Gated; A's scenes can no longer
  be PATCHed into B's Supabase row.
- pullWebTrends (65s window), generateBlogPosts, fetchPAAQuestions, loadSettingsExamples,
  refreshCreatorPosts, brainDistill, memeGenerate: all gated.
- blogImprove: silently discarded the user's rewrite after a switch; now saves correctly or says so.
- Daily Idea Ping flags made per-brand (14 sites). Two further real bugs found doing it:
  disableDailyPush read its brand id AFTER three awaits, so a mid-flight switch deleted the OTHER
  brand's push_subscriptions row; and setMotivationReminders updated by user_id ALONE, rewriting
  motivation_on for every brand.
- SETTINGS_KEY: written on every keystroke, read by nothing (loadSettings has no caller). It
  carried brandLogo + founderPhoto as base64 — the cause of "This device's storage is full".
  Writes removed and the stale blob cleared on load.
- deleteBrand now sweeps notebook_<brandId>, which its ::<id> filter never matched.

BACKEND — 7 fixes (api/** only), each proven with a before/after runtime harness, not by reading:
- stripe-webhook: an unresolvable subscription deleted/updated returned 200, so Stripe never
  retried and a cancelled customer kept paid access forever with no log. Now logs and returns 500
  for anything that would change a plan, while genuinely ignorable events still return 200.
- speak.js had NO socket timeout (the only https.request in api/ without one): verified hanging
  past 40s before, settles at 25s with a real JSON error after.
- transcribe.js YouTube innertube fetch had no AbortSignal, so the HTML-scrape fallback was
  unreachable: verified hanging at 45s before, aborts at 12.1s and the fallback succeeds after.
- crawl-social passed DATASET_TIMEOUT_MS into the BODY slot, so a GET carried "12000" as a body
  and the timeout silently became 30s, collapsing the LLM budget to its floor — the user paid for
  a completed Apify run and got "Couldn't read your posts clearly". Budget now matches the
  file's own comment: 56 + 12 + 28 = 96s.
- health.js ?ping=1 called the real model with no guard and no logUsage, in neither weight map.
  Now metered as 'healthping' (0.25 credits / EUR 0.002); the unauthenticated plain GET the crons
  and app poll is untouched, still free and public.
- Nine handlers 500'd on a body-less POST where the next line already returned 400; five (not the
  two reported) leaked the raw error message. Fixed.
- Eight handlers logged an unverified client-supplied brandId; all now run the existing
  userCanAccessBrand check, and in all 24 test runs the usage row is still written when it fails.

DELIBERATELY NOT DONE, measured and flagged:
- disableDailyPush unsubscribes the DEVICE while the rows are per-brand, so turning the ping off
  on A also kills B's pings. Pre-existing design mismatch; fixing it means unsubscribing only when
  no other brand holds a row — a behaviour change, so it is a separate round.
- saveBrandToDB has no gate of its own. Verified safe rather than changed: switchBrand assigns
  currentBrand and settings as adjacent synchronous statements, so no continuation can observe a
  mismatched pair.
- vercel.json gives api/crawl-social.js maxDuration 300 while its comment says 120. The 96s budget
  fits either, so the conclusion holds; comment left alone as out of scope.

STAMPED: APP_VERSION v655 -> v656, BUILD v655-9cc65ac6 -> v656-ee99fe10, server
v656-ee99fe10+api.1f61069d. Frontend round, so the phone stamp MOVES — which is what delivers the
v655 landing-page fix to already-frozen devices on their next app open.
NOT DEPLOYED. Deploy is Jörgen's step.
