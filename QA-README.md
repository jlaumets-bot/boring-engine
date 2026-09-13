# AI mobile QA tester — how to run it (for any app)

An AI logs into your app on a phone-sized browser, **figures out the features itself**,
uses them like a real person, judges quality + design/UX, and writes a report + a
video + a clickable trace. Works on **any** web app — just give it a URL.

## Run it (any app)

```
cd ~/boring-content-engine-deploy
node qa.js https://your-app.com
```

A phone-sized window opens. **If the app needs a login, log in in that window, then
come back to the terminal and press Enter.** (Already logged in? Just press Enter.)
The login is saved *per site*, so next time you just press Enter.

That's it. When it finishes you get, in `qa-runs/`:

- `qa-<site>-report.md` — per-feature ✅/❌/⚠️, output quality, design/UX, bugs
- `qa-<site>-video.webm` — watch it use the app
- `qa-<site>-trace.zip` — `npx playwright show-trace qa-runs/qa-<site>-trace.zip` to scrub every click

Then paste the report to Claude and say "fix these."

## Steer it (optional)

```
GOAL="sign up and create a project" node qa.js https://your-app.com
PERSONA="a busy shop owner" node qa.js https://your-app.com
MAX_FEATURES=12 PER_FEATURE=8 node qa.js https://your-app.com   # deeper/slower
MODEL=claude-haiku-4-5-20251001 node qa.js https://your-app.com # cheaper/faster driver
```

## One-time setup (already done on this machine)

1. Node + Playwright + a browser: `npm i playwright && npx playwright install chromium`
2. An LLM key in `.env` (any one): `ANTHROPIC_API_KEY=...` (also works: `GROQ_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`).
   Anthropic is recommended — it gives the tester eyes (vision) so it catches UI/UX issues.

## Safety

It will use the app (fill forms, click Generate) but is **blocked** from Publish,
Checkout, Buy, Upgrade, Subscribe, Delete, and Log out. It never sees your password —
you log in yourself in the window.

## The two testers

- `qa.js` — **generic, any app.** Discovers features automatically. Use this for new apps.
- `mobile-user.js` — **tuned for Content Shrimp** (knows its exact screens + quirks).
  Run with `node mobile-user.js`. Use this one for Content Shrimp specifically.
- `mobile-test.js` — fast, free layout/JS/console sweep (no AI, no cost). `node mobile-test.js`.
