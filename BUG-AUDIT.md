# Full-System Bug Audit — Boring Engine
_Read-only swarm audit. Nothing was changed. Date: 2026-06-23._

Four specialist passes: API endpoints, publishing engine, frontend (app.html), database/security (SQL).
Severity: **CRITICAL** (data exposure / public breakage) → **HIGH** → **MEDIUM** → **LOW** (cosmetic/cleanup).

---

## 🔴 CRITICAL — fix first

1. **Two database tables are wide open to all logged-in users.** `edit_signals` and `notebook_notes` have security rules set to "allow everyone," so any logged-in user can read, change, or delete *any other user's* notes and edit history. (`sql/edit-signals.sql`, `sql/notebook-notes.sql`)
2. **Anyone can tamper with team invites.** The `brand_invites` table lets any logged-in user read all invite codes and modify invite rows — they could join brands they were never invited to. (`sql/team-tables.sql`)
3. **The "delete my account" endpoint has no guardrails.** No method check, no origin check — it can be probed/triggered more loosely than it should. (`api/delete-account.js`)
4. **Double-post risk in the publisher.** If a Publer post actually succeeds but the confirmation gets lost (timeout/network blip), the job is marked "failed," which lets the *same content post a second time* publicly — the exact thing the system is meant to prevent. (`api/_publish/publer.js` + `api/publish-now.js`)

## 🟠 HIGH

5. **Wrong brand facts hardcoded into content.** Every "remix" and "product swap" injects *Boring Electrolytes* facts (pink salt, made in Estonia, €0.25/serving) no matter which brand is using it — so other brands get false content. (`api/remix.js`, `api/swap.js`)
6. **Server can be tricked into fetching internal addresses (SSRF).** The five endpoints that fetch a user-supplied URL don't block private/internal addresses. (`crawl-brand.js`, `crawl-social.js`, `extract-article.js`, `transcribe-url.js`, `search-images.js`)
7. **Daily cron is publicly triggerable.** `send-daily.js` uses the master database key but has no secret/auth, so anyone hitting the URL can fire idea-generation and push notifications to everyone. (`api/send-daily.js`)
8. **"Publish now" body still says "scheduled."** The immediate-post path sends a conflicting signal to Publer, so a "post now" could silently become queued and never go live. (`api/_publish/publer.js`)
9. **Dedupe depends on an unstable key.** The no-double-post guard keys off a caller-supplied id / the idea *title*; rename the idea or pass a different id and the guard misses → duplicate post. Also the status values in code vs. the database index don't fully line up. (`api/publish-now.js`, `sql/publish-jobs.sql`)
10. **Dead "Teleprompter" button.** On the Today/preview tab it points at elements that don't exist, so clicking it does nothing. (`app.html`, `tvOpenTeleprompter`)

## 🟡 MEDIUM

11. **Media-id grabbing for image posts is a guess** ("TODO: confirm on first live test") — could attach the wrong/empty image. (`api/_publish/publer.js`)
12. **Scheduled posts never reconciled** — a scheduled slot is locked forever; if it's cancelled/fails at Publer, that content can never be re-published. (`api/publish-now.js`)
13. **Weak encryption key accepted silently.** A short passphrase passes as the token-encryption key with no warning. (`api/_publish/crypto.js`)
14. **Brand-voice chat "Send" can double-fire** — the button isn't disabled while a reply is loading, queuing duplicate requests. (`app.html`, `bvSend`)
15. **"Download all" carousel slides often saves only one file** on Safari/mobile (rapid downloads get blocked). (`app.html`, `cmDownloadAll`)
16. **Raw error messages returned to the client** across several endpoints — leaks internal detail (no keys, but over-sharing). Also several return the full raw LLM output on parse failure. (multiple `api/*`)
17. **Missing input/body guards** — empty or wrong-type requests throw and return a 500 instead of a clean 400; large base64 audio/image decoded before size checks. (multiple `api/*`)
18. **"Test" connections can still post to live accounts** — the `is_test` flag is passed but the Publer adapter ignores it. (`api/_publish/publer.js`)
19. **Missing foreign keys / cascades** on `edit_signals`, `notebook_notes`, `push_subscriptions` → orphaned rows when a brand is deleted; also no indexes on `brand_id` for those tables (slower over time). (`sql/*`)

## 🟢 LOW / cleanup

20. **Leftover `console.log` debug** prints content/state in production. (`app.html`)
21. **30 native `alert()`/`prompt()` popups** that clash with the app's nicer toast system. (`app.html`)
22. **Possibly-dead server code** — `render-graphic.js` (and a few endpoints) aren't called by the app; carousels render in-browser. Confirm before removing. (`api/render-graphic.js`)
23. **A few images missing alt text**; misleading `--gold` theme variable name; minor copy-paste dead code in `transcribe-url.js`; misleading "Gemini fallback" comments (it actually falls back to Groq). (`app.html`, `api/*`)

## ✅ Verified healthy (no action)
- Encryption math (AES-256-GCM) is implemented correctly.
- WordPress defaults to safe **draft**; Wix stub fails loudly (never fakes success).
- Secret tokens are never returned to the client or logged; the key in the browser is the correct public one.
- Capability matrix correctly blocks video/micro/qna from posting.
- All 172 button handlers resolve; all 17 frontend API calls hit real endpoints; transcription flows recover cleanly on error.

## ⚠️ Needs a live check (can't be proven by reading code)
- Whether `ideas` and a few other core tables actually have row-level security *enabled* (policies exist but enabling may live elsewhere) — **verify in Supabase**.
- The Publer media-id field shape — confirm on the first real image post.
- Real visual/design polish — needs eyes on screen.

---

### Suggested fix order
1. **Security emergencies (1, 2, 3, 7)** — close the open tables, invites, account endpoint, and cron. Small, safe, high-impact.
2. **Posting safety (4, 8, 9, 11, 18)** — before any live posting, so we never double-post or post wrong.
3. **Wrong-brand content (5)** — stops fabricated facts for non-Boring brands.
4. **SSRF (6)** + error/body leaks (16, 17).
5. **Frontend bugs (10, 14, 15)** — visible to users.
6. **Cleanup (19–23).**
