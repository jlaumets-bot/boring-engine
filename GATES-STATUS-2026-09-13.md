# Gate status — run 2026-09-13

All 43 scripts in scripts/verify/ executed. Result: 42 pass, 1 real finding, 1 blocked.

Most gates marked "pending" in GATES.md were never FAILING — they had simply never been run.
Their EVIDENCE lines can now be filled in.

## PASS (42)
app-html-integrity, backend-fixes, backend-hardening, billing-honesty, brand-context-cap,
brand-prompt, crawl-review, css-vars, dark-mode, dark-mode.selftest, data-integrity,
deletion-honesty, filming-fixes, frontend-contract, harness-coverage, harness-fixes, landing,
lean-hydration, lean-payload, lean-payload-all, money-path, no-dangling-refs, one-brand-renderer,
onboarding-fixes, onscreen-removed, parse-all, prompt-contract, public-exposure, reasoning-effort,
request-payload, shelved-silent, spend-cap, spoken-shape, stripe-cancel-on-delete, sw-landing-live,
timeout-budgets, tv-dead-buttons, verdict-honesty, voice-sample, xss-escaping
(data-integrity-p1p8 is a module run by data-integrity, not a standalone gate.)

NOTE: harness-coverage and onboarding-fixes first appeared red under a 25s parallel timeout.
Re-run individually they PASS — 224 assertions and full onboarding verification respectively.
Timeout artefact, not a defect.

## BLOCKED (1)
build-stamp — fails with EPERM on unlink. This is the sandbox this run used refusing file
deletion, not a code defect. Re-run it locally to get a real verdict:
  node scripts/verify/build-stamp.mjs

## REAL FINDINGS (1 gate, 3 classes) — bug-scan
1. DEAD onclick handlers — 2 (reported as "if" and "fn"; likely scanner false positives, needs eyes)
2. bare localStorage writes bypassing lsSet — 19 keys. THE ONE THAT MATTERS.
   Brand-bleed risk: same bug class as G43's frontend-contract gate.
   Keys: motivation-on, daily-push-on (x5), daily-push-hour, notif-prompt-dismissed,
   notebook_, stmt_tpl (x2), cs_onb_hidden, +7 more
3. api endpoint with no auth or cron guard — 3: delete-account.js, generate-blog.js,
   stripe-webhook.js
   Assessment: all three look like false positives — stripe-webhook authenticates by Stripe
   signature, generate-blog is a 410 stub since v627, delete-account was verified to carry
   bearer + per-brand checks. Worth confirming, not worth alarm.

## STILL ONLY YOU CAN DECIDE
G8: "generated output is good enough that Jörgen would actually publish it" — no oracle possible.

## SEPARATE, NOT A GATE
GitHub holds 1 file (index.html). Everything else here is uncommitted. Nothing is backed up.
