# Content Shrimp — handoff

Read this first, then `CLAUDE.md` (long, version-by-version history).

## What it is
Single-file PWA. `app.html` (~820KB: 5 inline `<script>` blocks + CSS + markup),
`api/*.js` (~40 Vercel serverless functions), `sw.js` (service worker).
Live: contentshrimp.com · Vercel project `boring1/boring-engine`.
Two test brands: Boring Electrolytes (face-on) and Mila Sourcing (B2B faceless).

## ⚠️ DEPLOY — the thing that cost the most time
The service worker ships an update ONLY when `sw.js` is byte-different. Editing `app.html`
without changing `sw.js` means the fix uploads to the server and **never reaches the device** —
silently, indistinguishable from "the fix didn't work". This burned days.

Now automatic. The stamp MUST be the last step before deploying:
```
node scripts/stamp-build.js && vercel --prod
```
`stamp-build.js` sets `BUILD` in sw.js to `<APP_VERSION>-<sha256(app.html)[:8]>` and writes the
same id to `api/_build.js` (surfaced by `/api/health`). Verify BOTH match after deploy:
```
curl -s https://contentshrimp.com/sw.js | grep BUILD
curl -s https://contentshrimp.com/api/health | grep -o '"build":"[^"]*"'
```

## How to find out what's actually broken (do this FIRST, every session)
Production logs — most bugs were sitting here unread for weeks:
- Vercel MCP `get_runtime_errors`, projectId `prj_LzFJrXCsLzYhjJOeOkA0DgxYOgTf`,
  teamId `team_yu8pX5B9Ak1zvFlRMrq3AC7Z`, since `7d`. (IDs also in `.vercel/project.json`.)
- `get_runtime_logs` TIMES OUT on wide windows — scope to a `deploymentId` + ~10 min, or `group_by`.
- `/api/health` reports build id, key presence, cron heartbeats, isolation posture.
- `node mobile-user.js` — AI-driven QA sim (Playwright + vision LLM), 36 features. It ABORTS if
  the live build doesn't match local, or the backend is stale, or a required key is missing.
  `QA_PROVIDER=xai|openai|anthropic`, `ONLY=feat1,feat2`, `DESKTOP=1`, `FORCE=1` to bypass preflight.

## Open / unverified
- **Trends source links** — code is correct and deployed; the nightly cron (05:00 UTC) had been
  killed by a 120s platform timeout every day since June, so stored `auto_trends` rows are stale.
  Budget + 300s maxDuration now fixed. "Pull fresh trends" also writes them on demand (v608).
- `PEXELS_API_KEY`, `APIFY_API_TOKEN` unset ⇒ stock photos / X trends lane silently return nothing.
- Stripe price IDs are sandbox — must be redone in LIVE mode before launch.
- `transcribe-tmp` Supabase bucket unverified (>3MB Remix uploads).
- Marketing blog (cs_blog_posts) was never set up; cron + routes REMOVED (v608). App's Blog
  feature is separately shelved via `CS_SHELVED` in app.html, along with publishing + meme.

## Traps that cost real time (don't rediscover these)
- **Inline styles beat every stylesheet rule.** Two dark-mode "light islands" were `style="background:#fff"`
  inside JS template literals — must be fixed at source, not overridden.
- **`var(--x, fallback)` where `--x` doesn't exist** silently hardcodes the fallback. Grep the token.
- **Template literals in `mobile-user.js` taps eat single backslashes** — regexes need `\\s`, `\\d`.
- **`state` is a per-load CLONE of `IDEAS`, keyed by array index** — edit BOTH or a reload reverts it.
- **Per-brand localStorage** goes through `lsGet`/`lsSet` (bkey = `key::brandId`). A bare
  `localStorage.setItem` leaks between brands.
- **PURE GROK, no fallback** (owner's explicit choice — no Llama/OpenAI fallback for text).
  grok-4.6 is a reasoning model: it can return 200 OK with EMPTY content, which used to look
  identical to an outage. `_llm.js` now logs `xAI EMPTY 200` and retries.
- **Every endpoint's internal timeout must be UNDER its `maxDuration`** or the platform kills it
  with no app-level error. Audited: 19/19 OK. Re-run that audit if you add an LLM endpoint.
- **A cron "will fix it on the next run" is NOT a completed fix** — verify the run SUCCEEDS.

## Owner
Jörgen. Wants: no half-measures, verify by measurement not reasoning, never deploy for him,
never touch API keys. Prefers blunt and concise. He should NOT have to be the bug-detection
system — read the logs and report unprompted.
