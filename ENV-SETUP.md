# Environment Variables — Setup Guide (Content Shrimp)

Every key below is set in **Vercel → Project → Settings → Environment Variables** (scope: Production, and Preview if you use preview deploys). After adding/changing keys you must **redeploy** for them to take effect.

Legend: **[Required]** core features break without it · **[Optional]** only one feature depends on it · **[Self-generated]** you create the value yourself, not from a vendor.

---

## Core AI — the writing engine

### `ANTHROPIC_API_KEY` **[Required]**
Powers Claude, the default writer for every generation feature.
- Get it: https://console.anthropic.com → **Settings → API Keys → Create Key**.
- Tip: you must add billing/credits under **Plans & Billing** or calls fail with a balance error. Start with a small top-up and watch usage under **Usage**.

### `XAI_API_KEY` **[Recommended]**
Grok — the fallback writer (and selectable engine). If Claude has a hiccup, generation still works.
- Get it: https://console.x.ai → **API Keys → Create**. Requires a paid xAI account with credits.

### `GROQ_API_KEY` **[Recommended]**
Two jobs: (1) final LLM fallback, (2) **Whisper transcription** for the TikTok/video transcribe feature. Groq has a generous free tier.
- Get it: https://console.groq.com/keys → **Create API Key**.

### `OPENAI_API_KEY` **[Optional]**
Only used if a user explicitly picks the OpenAI engine. Not needed if you run Claude/Grok (recommended). Leave unset to keep OpenAI fully out of the app.
- Get it (if you want it): https://platform.openai.com/api-keys.

---

## Database & auth (Supabase)

### `SUPABASE_URL` **[Required]**
Your project's API URL.
- Get it: https://supabase.com/dashboard → your project → **Settings → API → Project URL** (looks like `https://xxxx.supabase.co`).

### `SUPABASE_SERVICE_ROLE_KEY` **[Required]**
Server-side key the API uses for privileged reads/writes (bypasses row-level security).
- Get it: **Settings → API → Project API keys → `service_role`** (click reveal).
- ⚠️ Secret. Server env only. **Never** put this in the frontend/app.html — the frontend uses the separate **anon** key, which is already hard-coded in app.html and is safe to expose.

---

## Web push notifications (the daily-idea reminder)

### `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` **[Required for push]** · **[Self-generated]**
- Generate both at once in a terminal: `npx web-push generate-vapid-keys`
- Paste the printed **Public Key** and **Private Key** into the two env vars.

### `VAPID_SUBJECT` **[Optional]**
A contact URL for push. Set to `mailto:you@yourdomain.com`. Defaults to a placeholder if unset.

### `CRON_SECRET` **[Required for the daily push]** · **[Self-generated]**
A password that lets Vercel's scheduled cron call the send-daily/auto-publish jobs (and nothing else can). Without it, the daily personalized-idea push falls back to a generic nudge.
- Generate: `openssl rand -hex 32` (or any long random string).
- Add it as `CRON_SECRET`. Vercel Cron automatically sends it — no other setup needed.

---

## Encryption

### `APP_ENC_KEY` **[Required if you use publishing connections]** · **[Self-generated]**
Encrypts stored 3rd-party connection secrets (e.g. Publer tokens) at rest.
- Generate: `openssl rand -hex 32`. Keep it stable — if you change it, existing saved connections can't be decrypted.

---

## Optional feature keys (each powers ONE feature; skip if you don't use it)

### `SERPAPI_KEY` **[Optional]** — "What people search" (People Also Ask)
- Get it: https://serpapi.com → sign up → **Dashboard → Your API Key**. Free tier ~100 searches/mo.

### `EXA_API_KEY` **[Optional]** — Inspiration / competitor content search
- Get it: https://dashboard.exa.ai → **API Keys**. Has a free tier.

### `APIFY_API_TOKEN` **[Optional]** — TikTok scrape *fallback* for transcription
- Get it: https://console.apify.com → **Settings → Integrations → API tokens**. Only kicks in if the primary transcription route fails, so lowest priority.

### `COBALT_API_URL` + `COBALT_API_KEY` **[Optional]** — secondary media-download route for transcription
- Cobalt is a media downloader. Use a hosted instance URL + its key, or self-host (https://github.com/imputnet/cobalt). Optional — the app works without it via the primary route + Groq.

### `PUBLER_API_KEY` + `PUBLER_WORKSPACE_ID` **[Optional]** — auto-publishing to social via Publer
- Get them: https://app.publer.com → **Settings → Access / API** for the key; the **Workspace ID** is in the workspace URL/settings. Only needed if you enable auto-publish.

---

## Auto-provided (do nothing)

### `VERCEL_URL`
Injected automatically by Vercel at build/runtime. Don't set it manually.

---

## Quick priority order for a fresh deploy
1. **Must-have to boot:** `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
2. **Strongly recommended:** `GROQ_API_KEY` (transcription + fallback), `XAI_API_KEY` (fallback), the two `VAPID_*` keys + `CRON_SECRET` (daily push), `APP_ENC_KEY`.
3. **Add when you want the feature:** `SERPAPI_KEY`, `EXA_API_KEY`, `APIFY_API_TOKEN`, `COBALT_*`, `PUBLER_*`.

Reminder: **redeploy after any env change.** If a feature says "not configured," its key is missing or in the wrong environment scope.
