# Gates: the marketing site must never be served from a stale cache

Jörgen, on his phone: "mobile website still has old version." The ORIGIN is correct — fetching
contentshrimp.com right now returns the current page (H1 "Never wonder what to post again", the six
formats, the 8-row ChatGPT table, no "THE LOOP" section). So this is not a deploy that failed to
land. It is the page being served to him from a cache he cannot clear.

TWO INDEPENDENT LAYERS, both hitting the bare root `/` — the URL a person actually types:

1. THE SERVICE WORKER CACHES THE MARKETING PAGE AND CAN NEVER REFRESH IT.
   `CORE = ['/app.html', '/index.html', '/', '/manifest.json']` and the fetch handler is
   CACHE-FIRST (v309, deliberately, to stop a 1.8MB re-download on a 0.5KB/s line). The worker is
   registered from app.html with scope `/`, so once a phone has opened the app even once, the SW
   controls the whole origin — including the landing page. And `index.html` contains ZERO
   service-worker code (grep: no `serviceWorker`, no `sw.js`, no `APP_VERSION`): the update check,
   the `reg.update()` poll and the refresh banner all live in app.html's early script. So a visit to
   the landing page can never pull a newer copy of itself. It is frozen until a BUILD bump happens
   to install a new worker while he is inside the app.
   Caching it buys nothing: `manifest.json` start_url is `/app.html`, so the installed PWA never
   opens `/`. The marketing page has no offline value — it only needs to be current.

2. THE BARE ROOT HAS NO no-store HEADER.
   vercel.json's rule is `"source": "/(.*\\.html)"`. That matches `/index.html` and misses `/`.
   So the browser HTTP cache and the CDN edge are both free to hold the root. This is the exact
   v613 class — an edge pinning a file whose whole job is to be current — one door over from the
   `/sw.js` case that gate already guards.

FIX: stop caching the marketing page in the SW (bypass it, drop it from CORE, purge the stale
entries on activate), add no-store for `/`, and bump the stamp so existing phones actually receive
the new worker. This is a frontend/SW round, so the phone stamp SHOULD move — unlike v655-backend.

OWNS: sw.js, vercel.json, app.html, scripts/verify/sw-landing-live.mjs,
.unlazy/landing-freshness/GATES.md, api/_build.js, CLAUDE.md

- [x] G1: the service worker no longer answers for the marketing page — driving the REAL fetch handler with a request for `/` and for `/index.html` leaves them unhandled so the browser goes to the network, while `/app.html` and a static image are still served cache-first (the slow-connection behaviour the cache-first design exists for is not weakened)
  CHECK: node scripts/verify/sw-landing-live.mjs
  EXPECT: sw landing verification passed
  EVIDENCE: exit=0; EXPECT=matched; the gate loads the real sw.js into a fake ServiceWorkerGlobalScope and fires actual fetch events — `/`, `/index.html`, `/?utm_source=x` and `/api/health` all go unanswered (network), while `/app.html`, `/icon-192.png` and `/shrimp-mascot.png?v=162` are still answered from cache and a POST is never intercepted. Mutation-proven 4 ways, 4 caught: M1 put `/` + `/index.html` back in CORE -> red naming both; M2 delete the ALWAYS_LIVE bypass -> red on all three landing URLs (this is the behavioural half — a grep would still have passed); M4 positive control, make the worker cache nothing -> red on all three cached URLs, so "leave the landing alone" cannot be satisfied by breaking cache-first. sw.js sha256-identical after restore.

- [x] G2: no shared cache can pin the marketing page — the bare root `/` carries no-store, not just `*.html`, so neither the CDN edge nor the phone's HTTP cache can serve an old copy behind the service worker's back
  CHECK: node scripts/verify/sw-landing-live.mjs
  EXPECT: ROOT NO-STORE OK
  EVIDENCE: exit=0; EXPECT=matched; vercel.json gained a `"source": "/"` rule with `no-store, max-age=0, must-revalidate`, and the gate also asserts the existing `*.html` rule is not weakened in the process. Mutation M3 (remove the `/` rule) -> red naming it; vercel.json sha256-identical after restore.

- [x] G3: phones that already hold the stale worker actually receive this fix — the phone stamp moves for this frontend round (a backend-only stamp would leave every installed device on the old worker forever), and the stamp is still a real content hash that changes on edit and restores on revert
  CHECK: node scripts/verify/build-stamp.mjs
  EXPECT: build stamp verification passed
  EVIDENCE: exit=0; EXPECT=matched; APP_VERSION v654 -> v655 and the phone stamp moved v654-b337b221 -> v655-a55d54fb (the OPPOSITE of the v655-backend round, correctly — this one must reach devices). Server stamp v655-a55d54fb+api.26e75c52: the api hash is unchanged because no api file changed. Stamp verified responsive by the gate's own positive control (v655-05ceece8 on edit, restored).

- [x] G4: every JS the app ships still parses, including the rewritten service worker
  CHECK: node scripts/verify/parse-all.mjs
  EXPECT: parse verification passed
  EVIDENCE: exit=0; EXPECT=matched; parsed 51 files/blocks with no errors

- [x] G5: nothing else regressed — the landing page's own content gate still holds and the brand/prompt suite is unaffected by the stamp bump
  CHECK: node scripts/verify/landing.mjs && node scripts/verify/brand-prompt.mjs && node scripts/verify/one-brand-renderer.mjs && node scripts/verify/public-exposure.mjs
  EXPECT: brand prompt verification passed
  EVIDENCE: exit=0; EXPECT=matched; landing 60 assertions, RECENCY OK across all 7 prompts, one-brand-renderer 28/28 fields, public-exposure green

- [ ] G6: MANUAL, Jörgen's, after deploy — open contentshrimp.com on the phone. The page shows the current landing — H1 "Never wonder what to post again", six format cards, the 8-row ChatGPT table, three pricing cards ($0/$24/$79), and NO phone-mockup "THE LOOP" section. If it is still the old page, say so and report whether the installed app icon also still shows an old build.
  EVIDENCE: FAILED 2026-09-13 — Jörgen: "landing on mobile was old version".
  NOT an origin fault, measured the same day: GET / returns 200 with the CURRENT page (new H1 present,
  THE LOOP absent, ChatGPT table present, $0/$24/$79) under cache-control "no-store, max-age=0,
  must-revalidate"; live sw.js contains ALWAYS_LIVE and CORE is now ['/app.html', '/manifest.json'].
  So the fix IS deployed and correct.
  DIAGNOSIS — THE FIX CANNOT DELIVER ITSELF. His phone still runs the PRE-v655 worker, which holds
  '/' in CORE and answers cache-first, so a visit to the landing is served from that worker and never
  reaches the network — therefore never fetches the NEW worker either. The update poll and
  registration live only in app.html (G1 asserts index.html has no SW code, deliberately). A phone
  frozen BEFORE v655 can only be released by opening app.html once.
  => The round fixed the cause for every future visitor and left every ALREADY-FROZEN device stuck.
  NEXT: (a) confirm by opening app.html then reloading the landing; (b) if confirmed, the real fix is
  a minimal self-heal in index.html (getRegistration -> update, no register), which REOPENS G1 by
  design — that gate asserts index.html carries no SW code, so it must be revised deliberately, not
  quietly broken.
  UPDATE 2026-09-13 — THE FIX IS PROVEN CORRECT IN A REAL BROWSER, NOT JUST IN THE ORACLE.
  Installed the LIVE worker in a clean browser, confirmed active + controlling with scope
  https://contentshrimp.com/, then read its cache directly: cs-shell holds /app.html,
  /manifest.json, /supabase.min.js, /sw.js and the mascot images — and NEITHER '/' NOR
  '/index.html'. Fetching '/' while controlled returned 200 from the network with
  cache-control "no-store, max-age=0, must-revalidate", new H1 present, THE LOOP absent.
  So G1/G2 hold against a real ServiceWorker, not only the fake global the gate drives.
  G6 REMAINS UNMET, AND CORRECTLY SO — it is about an ALREADY-FROZEN device. Jörgen's phone
  holds the PRE-v655 worker, which has '/' in CORE and is cache-first, so it answers the
  landing from its own cache and never reaches the network — and therefore never fetches the
  new sw.js either. NO DEPLOY CAN REACH IT: the thing that would fix it is precisely the thing
  it refuses to request.
  DECIDED: DO NOT add self-heal code to index.html. It cannot work — an already-frozen device is
  served the OLD cached index.html, which by definition does not contain the new script. It would
  only run on devices that are not frozen, and those can no longer become frozen. G1's assertion
  that index.html carries no SW code therefore STANDS and is not reopened.
  RESOLUTION PATH, the only one that exists: open /app.html once. That registers and updates the
  worker, the new worker stops caching the landing, and the page is correct from then on. The
  affected population is exactly "people who have opened the app", so opening the app is both the
  cause of exposure and the cure. Self-limiting, no follow-up round required.
