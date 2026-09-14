# Gates: deep sweep round 2 — 2026-09-13

Four read-only agents over disjoint scopes (client runtime | money lifecycle | wire contract |
data layer). Then four questions answered against the LIVE database.

OWNS: app.html, api/**, sql/**, scripts/verify/**, .unlazy/deep-sweep/GATES.md

## LIVE DATABASE ANSWERS (run 2026-09-13, production project content-engine)
- brand_members self-referential policy .... CLEAN (fixed in the dashboard; sql/team-tables.sql:31
  still contains the recursive version, so sql/ is NOT the source of truth for that table)
- SECURITY DEFINER with mutable search_path .. user_brand_ids  <-- CONFIRMED LIVE
- pgrst db_max_rows ....................... unset (so the truncation findings are LATENT, not active)
- duplicate (brand_id,title) idea groups ... 5   <-- the duplication bug HAS ALREADY HAPPENED
- brands total 8 | push_subscriptions total 1 | off-vocabulary ideas.status 0

## A — MONEY (proven by executing the real handlers)
- [ ] A1: a stale session_id cannot re-grant a cancelled plan. api/checkout-confirm.js:60-77 checks
      only session-exists + metadata.user_id + payment_status='paid' — no age check, no
      already-consumed check, no live-subscription check. stripe-webhook.js:124 has exactly this
      guard (72h). Replay of one URL from browser history restores pro/agency permanently; the
      subscription is gone so no later event revokes it. $24-79/mo per user, indefinitely.
- [ ] A2: a churned customer can resubscribe. The cancel path never clears stripe_subscription_id,
      and create-checkout.js:84 refuses on `snap.stripeSubscriptionId` forever -> 409
      already_subscribed. It routes them to the Billing Portal, which CANNOT start a new
      subscription. app.html:16804 renders d.error not d.message, so the user's actual experience
      of clicking Upgrade is a toast reading "already_subscribed". Every win-back is blocked.
- [ ] A3: dropping to free does not zero the month. _usage.js:267-289 gives trial and paid plans a
      real window but leaves `free` on the calendar month, so the whole month of trial/Pro spend is
      re-scored against the 40-credit free limit. A trial started on the 1st = 23 consecutive dead
      days, landing exactly on the upgrade decision. Contradicts the design note at _usage.js:11.
- [ ] A4: a failed account deletion cannot hand out a fresh trial. delete-account.js cancels Stripe,
      then deletes user_plans, then can fail at the auth-delete step (the file itself calls that the
      dominant failure mode) — leaving a live signed-in account with no plan row, which
      getOrInitPlan recreates as a NEW 7-day trial with 150 credits and no subscription.
- [ ] A5: one credit buys one post. generate-ideas.js:109 takes `count` straight from the body and
      never clamps it; the UI offers 10 and a direct POST can ask for 50. Metering is per CALL.
      Free 40 credits = 400 briefs; Pro $24 = 7,500. ACTION_COST understates the fuse by the same
      factor. Also :472 fires a second full 16k-token call under the same one credit.
- [ ] A6: the brand limit is enforced server-side. Today app.html:7112 is the ONLY check in the
      product, brands are inserted client-side, and csIsFree() is false during the trial and false
      whenever csUsage is null — so multi-brand, the entire $79 Agency differentiator over $24 Pro,
      is unenforced.
- [ ] A7: seats behave like seats. Every meter keys on the CALLER's own plan, so an Agency seat gets
      its own 40 credits/month, not the owner's. No seat cap, no plan check on inviting, and
      brand_members is never pruned on downgrade — an ex-Agency customer's teammates keep full
      read/write forever.
- [ ] A8: the daily push is metered. send-daily.js:143 calls generate-ideas with CRON_SECRET, which
      skips both the gate and logUsage — so a free/expired account with push on receives ~30
      generated briefs a month that no limit, fuse or rate limiter can see.

## B — SILENT QUALITY LOSS (the worst failure mode in this product: no error anywhere)
- [ ] B1: the stale-brand guard actually fires. Six handlers read `bc.bcFields` where the client
      sends bcFields at the TOP LEVEL — sharpen.js:51, video-beats.js:76, viral-twist.js:33,
      viral-rewrite.js:36, viral-analyze.js:39, brand-voice-chat.js:38. Number.isFinite(undefined)
      is false, so _thin is ALWAYS false and those six generate against a half-empty brain without
      the 424. generate-ideas.js and remix.js get it right. lean-hydration.mjs passes because it
      greps for a string instead of driving the guard.
- [ ] B2: the founder's own rewrites outrank generated ones everywhere. humanEditedTitles is
      uploaded to 7 endpoints and read by 1 (generate-ideas.js:148). On the rest every winner gets
      edited:false and _brain.js picks the weaker header that tells the model NOT to imitate them.
- [ ] B3: Quick Post sends humanEditedTitles. Its lean branch (app.html:12903) omits it entirely
      while the non-lean fallback sends it — the same button produces two different prompts.
- [ ] B4: voice transcription is not pinned to English. transcribe-voice.js:57 defaults
      language='en' and no client site ever sends one. This transcribes the founder's voiceSample,
      which _brain.js:205 renders LAST and strongest in every prompt under "THIS IS THE VOICE".
      For an Estonian founder that poisons every generation with no error.
- [ ] B5: the client does not abandon work the server is still doing and charging for.
      crawl-brand 150s client vs 300s server and 3 credits (the ONBOARDING scan); crawl-social 150
      vs 300; generate-ideas auto-refill 90 vs 300; hook-frame 30 vs 60; people-also-ask 45 vs 45.
      Quick Post (240 vs 300) is the correct pattern the others never adopted.

## C — DATA LOSS AND CORRUPTION
- [ ] C1: two saves within one round-trip cannot duplicate a list. _replaceBrandRows
      (app.html:7774) is read-ids -> insert -> delete-old-ids with NO serialization, unlike
      saveIdeasToDB which has _ideasSaveChain. Proven by execution: expected a b c d e, got
      a b c d a b c d e. FIVE duplicate groups already exist in the live database.
- [ ] C2: concurrent editing does not destroy work. Same function is last-writer-wins over the
      whole list: no version column, no updated_at guard, no per-row identity. Two devices or two
      teammates editing one brand's notebook/bookmarks lose one side's work.
- [ ] C3: cancelling the share sheet does not claim a save. app.html:10317-10326 treats any
      navigator.share rejection INCLUDING the user dismissing it as "fall through to saving", then
      tpDownloadBlob unconditionally toasts "Saved to your phone" and close() revokes the blob URL.
      Where a script-driven <a download> is inert (standalone PWA, in-app browsers) the take is
      gone, with a success message.
- [ ] C4: a paying customer is never shown "Trial plan, 0 / 0 posts" with an Upgrade button.
      refreshUsage swallows every failure (app.html:16656) leaving csUsage null, and planBoxHtml
      defaults to trial/0/0. Proven: csUsage=null -> "Trial plan | 0 / 0 | UPGRADE".
- [ ] C5: post-payment failure is never silent. handleCheckoutReturn's whole body is in an EMPTY
      catch, so a dropped connection on the redirect back from Stripe produces no toast, no
      success overlay and no error — after the card was charged.

## D — DATABASE AND JOBS
- [ ] D1: user_brand_ids() pins its search_path. CONFIRMED LIVE — it is the one SECURITY DEFINER
      function in the database without it, and every brand-scoped RLS policy delegates to it.
      health-check.sql:103 certifies it as secure by checking prosecdef only, which is the half
      that creates the exposure. Fix: alter function public.user_brand_ids() set search_path=public;
- [ ] D2: a brand member cannot re-parent the owner's rows. Every brand-scoped UPDATE policy omits
      WITH CHECK (team-tables.sql:102,144), so Postgres reuses USING and a member can
      `update ideas set brand_id='<my brand>'` and keep the rows after leaving the team. The FOR ALL
      form also grants DELETE. security_health() is blind to both.
- [ ] D3: enabling the ping on a second device does not kill the first. app.html:14534 deletes by
      (user_id, brand_id) and NOT by subscription endpoint, so two devices can never both be
      subscribed — and merely changing the hour re-runs it.
- [ ] D4: deleting a brand cannot leave an unkillable notification. push_subscriptions.brand_id is
      ON DELETE SET NULL by design but the brand-delete sweep skips the table, and send-daily then
      treats brand_id=null as "inactive for 999 days" and pushes daily forever. disableDailyPush
      can only match the null row when no brand is open, which never happens.
- [ ] D5: both crons order and bound their reads. pull-trends-cron.js:65 and send-daily.js:72 are
      unbounded and unordered — _usage.js:343 documents this exact failure and fixed it for
      usage_events only. LATENT today (db_max_rows is unset, 8 brands, 1 subscriber).
- [ ] D6: a cron that abandons its queue reports it. pull-trends-cron slices to 30 BEFORE counting,
      so no number anywhere reveals a backlog, and it never emits 'partial' the way send-daily does
      — so /api/health stays green while feeds go a month stale.
- [ ] D7: edit_signals can be deleted. It has SELECT and INSERT policies but no DELETE, so
      _verifiedBrandWipe reads the rows back and every "Start over" warns the user that data could
      not be removed — unavoidable and wrong.

## E — LOWER
- [ ] E1: the daily ping survives DST. tz_offset_min is captured once at subscribe time
      (app.html:14541) and never refreshed — every DST-region user is an hour off for half the year.
- [ ] E2: the mic stops when the sheet closes. dpToggleMic/apToggleMic recorders are never stopped
      by any close path, so the OS recording indicator stays lit and the next tap pastes the
      previous transcript.
- [ ] E3: legal pages are not frozen forever. sw.js ALWAYS_LIVE covers only / and /index.html, so
      terms.html, privacy.html and refunds.html are pinned on first view, permanently.
- [ ] E4: machine codes never reach the screen. app.html:9189 and :16066 print data.error verbatim,
      so users read "limit_reached".
- [ ] E5: streak survives spring-forward (app.html:22814, 86400000ms arithmetic).
- [ ] E6: toggleBrandSwitcher's close-by-trigger path calls cleanup() (app.html:6936 leaks three
      global listeners per toggle).

## CLEAN — checked, no action
saveIdeasToDB serialization; btnWork's 240s safety timer; every interval except _bhTick; the
split-screen render path; deleteBrand's brand-row delete; teleprompter camera release; all division
and date guards on live paths; the fetch auth patch; charged-for-a-failure (no path meters then
errors); client/server counter disagreement; upgrade/downgrade/past-due sync; redeem_invite and
lookup_invite bodies; brands_pin_ownership; authorizedBrandId; usageThisPeriod paging; both crons'
CRON_SECRET; push_subscriptions RLS; /api/health cron liveness; no brand field dropped by hydration.
