# Full-System Bug-Check & Hardening Prompt (universal)

Copy everything below the line into a new chat. Fill in the two placeholders at the top.

---

I want a maximal, no-holds-barred quality pass on my app — find and fix as many genuine bugs as possible and make sure every feature actually works. Use every resource available (parallel subagents, live testing, database checks, whatever helps). Be skeptical, not reassuring.

CONTEXT
- App / codebase location: <PATH or repo, e.g. the folder I connected>
- What it is / stack: <e.g. single-file PWA + serverless API + Postgres; or Next.js + Supabase; etc.>
- Live URL (if deployed): <URL or "not deployed">
- Anything off-limits: <e.g. don't touch tone/copy, don't spend money on paid APIs without asking>

HARD RULES (follow exactly)
1. FREEZE: do not add new features or redesign anything. Only fix real bugs and make existing features work.
2. Do NOT change tone, copy, prompts, creative output, or product behavior without asking me first. Functional/security/robustness fixes only.
3. Audit what already exists before adding anything — no duplicate systems.
4. Verify every claim against the real code or a live test. Never say "done/fixed" from assumption — show the evidence (file:line, test output, or a live response).
5. Do not handle my credentials or secrets. Do not deploy or publish anything until I explicitly say so.
6. Report honestly, including things you could NOT verify and why.

DO THIS, IN ORDER

Step 1 — Parallel deep audits (spawn separate subagents, run them at once):
- Backend/logic audit: every server file / API handler. Look for crashes, unhandled exceptions, fragile response parsing (e.g. JSON.parse on model/3rd-party output), missing auth on expensive/privileged actions, wrong/mismatched param names between caller and handler, const reassignment, missing awaits, empty-array/off-by-one access, wrong defaults, hanging requests / missing timeouts.
- Frontend audit: dead event handlers (every onclick/onchange must map to a defined function), broken view/route transitions, unhandled promise rejections that leave the UI stuck with no error, null dereferences, race conditions on load, double-binding, storage calls that throw in private mode, leftover/dead code from removed features, service-worker / cache / offline correctness.
- Security & abuse audit: auth gates on every endpoint that spends money or touches user data; injection/SSRF (validate URLs AND redirect hops with DNS resolution, not just string checks); secret exposure (nothing sensitive shipped to the client or logged); access-control/row-ownership checks on privileged reads/writes; unbounded input; stack traces / internal errors leaked to the client.
- Each subagent returns a prioritized list: file:line, what breaks, when it triggers, severity (P0 crash/data-loss / P1 broken feature / P2 edge case), and a minimal proposed fix. Report only — don't let them edit in parallel.

Step 2 — Data/integrity check: list every table/collection/column (or external resource) the code references, then verify each actually exists with correct access rules / permissions in the real datastore. Flag anything the code uses that isn't there (missing tables, missing env vars, broken references).

Step 3 — Live end-to-end test: with the app running/deployed, actually exercise each feature for real (authenticated where needed), watching console + network for errors. Confirm the real responses, not just that the page loads. For anything that costs money or posts publicly, stop and ask me before triggering it.

Step 4 — Consolidate & fix: merge all findings, dedupe, and fix the genuine functional/security/robustness bugs (respecting the tone/behavior rule above). After editing, syntax-check every changed file. Bump any cache/version string if you changed cached assets.

Step 5 — Honest report: give me a prioritized list of (a) bugs found and fixed, (b) anything found but intentionally NOT changed and why, (c) anything you couldn't verify. Then tell me exactly what to deploy/run, and offer to verify live once I deploy.

Use a task list so I can see progress. Start now.
