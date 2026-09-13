// The marketing site must never be served from a stale cache.
//
// Jörgen, on his phone: "mobile website still has old version" — while the origin was serving the
// current page. Two independent layers were holding an old copy of the bare root `/`, the URL a
// person actually types:
//
//   1. THE SERVICE WORKER. Its scope is the whole origin, so once a phone had opened app.html the
//      worker served contentshrimp.com from cache too. index.html contains no service-worker code
//      (no register, no reg.update(), no refresh banner — all of that lives in app.html), so a
//      landing-page visit could never fetch a newer copy of itself. Frozen, with no way for the
//      visitor to clear it.
//   2. THE HEADER. vercel.json's no-store rule is `/(.*\.html)`, which matches `/index.html` and
//      MISSES `/`. Same class as the v613 bug where a CDN edge pinned sw.js and the fix deployed
//      permanently invisible — one door over.
//
// This gate drives the REAL fetch handler out of sw.js rather than grepping it, because a grep
// passes on a bypass that is present but unreachable. It also asserts the POSITIVE side: the app
// shell and static assets must STILL be cache-first, or "fix the landing page" would have quietly
// undone the v309 slow-connection design.
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = process.cwd();
const swPath = path.join(root, 'sw.js');
const idxPath = path.join(root, 'index.html');
const vjPath = path.join(root, 'vercel.json');
const ORIGIN = 'https://contentshrimp.com';

const fails = [];
const fail = m => fails.push(m);

// ── Load the real worker into a fake ServiceWorkerGlobalScope ───────────────────────────────────
const src = fs.readFileSync(swPath, 'utf8');
const listeners = {};
const self_ = {
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  skipWaiting: () => {},
  clients: { claim: async () => {}, matchAll: async () => [] },
  location: { origin: ORIGIN },
  registration: { showNotification: async () => {} },
};
const cacheStore = new Map();
const fakeCache = {
  put: async (k, v) => { cacheStore.set(String(k), v); },
  match: async k => cacheStore.get(String(k)),
  delete: async k => cacheStore.delete(String(k)),
};
const sandbox = {
  self: self_,
  clients: self_.clients,
  caches: { open: async () => fakeCache, match: async () => undefined, keys: async () => [], delete: async () => true },
  fetch: async () => ({ ok: true, type: 'basic', clone: () => ({}) }),
  URL, console, Promise, Map, Set, JSON,
};
sandbox.globalThis = sandbox;
try {
  vm.runInNewContext(src + '\n;globalThis.__CORE=CORE;globalThis.__ALWAYS_LIVE=ALWAYS_LIVE;', sandbox, { timeout: 5000 });
} catch (e) {
  console.error(`sw.js did not evaluate as a service worker: ${e && e.message}`);
  process.exit(1);
}

const CORE = sandbox.__CORE;
const ALWAYS_LIVE = sandbox.__ALWAYS_LIVE;
const onFetch = (listeners.fetch || [])[0];
if (typeof onFetch !== 'function') {
  console.error('sw.js registered no fetch listener — the worker cannot control anything');
  process.exit(1);
}

// ── Drive it: does the worker ANSWER for this request, or leave it to the network? ──────────────
function handled(url, method = 'GET') {
  let answered = false;
  const ev = { request: { method, url }, respondWith: () => { answered = true; } };
  onFetch(ev);
  return answered;
}

const mustBeLive = [
  [`${ORIGIN}/`, 'the bare root — the URL people type'],
  [`${ORIGIN}/index.html`, 'the landing page by filename'],
  [`${ORIGIN}/?utm_source=x`, 'the root with a campaign query string'],
  [`${ORIGIN}/api/health`, 'the API'],
];
for (const [u, why] of mustBeLive) {
  if (handled(u)) fail(`the worker still answers for ${u} (${why}) — it can serve a stale copy`);
}

// POSITIVE CONTROL. If these stop being cache-first the gate above could be "passed" by a worker
// that caches nothing at all, which would re-break first-open on a slow connection (v309).
const mustBeCached = [
  [`${ORIGIN}/app.html`, 'the app shell'],
  [`${ORIGIN}/icon-192.png`, 'a static asset'],
  [`${ORIGIN}/shrimp-mascot.png?v=162`, 'a versioned image'],
];
for (const [u, why] of mustBeCached) {
  if (!handled(u)) fail(`the worker no longer serves ${u} (${why}) from cache — the slow-connection design is broken`);
}

// A non-GET must never be intercepted at all.
if (handled(`${ORIGIN}/app.html`, 'POST')) fail('the worker intercepts a POST — only GET may be cached');

// ── The declared lists must agree with the behaviour ────────────────────────────────────────────
if (!Array.isArray(CORE)) fail('CORE is not an array');
else {
  for (const bad of ['/', '/index.html']) {
    if (CORE.includes(bad)) fail(`CORE still precaches ${bad} — the marketing page would be re-cached on every update`);
  }
  if (!CORE.includes('/app.html')) fail('CORE no longer precaches /app.html — the app shell would not be refreshed on update');
}
if (!Array.isArray(ALWAYS_LIVE) || !ALWAYS_LIVE.includes('/') || !ALWAYS_LIVE.includes('/index.html')) {
  fail('ALWAYS_LIVE does not name both / and /index.html');
}

// ── Why the SW fix is load-bearing: index.html cannot help itself ───────────────────────────────
// If the landing page ever gains its own registration + update logic this assertion should be
// revisited deliberately, not silently — that is why it is asserted rather than assumed.
const idx = fs.readFileSync(idxPath, 'utf8');
if (/serviceWorker\s*\.\s*register/.test(idx)) {
  fail('index.html now registers a service worker — re-check whether it can refresh itself before trusting this gate');
}

// ── Layer 2: the header on the bare root ────────────────────────────────────────────────────────
let rootOk = true;
const vj = JSON.parse(fs.readFileSync(vjPath, 'utf8'));
const noStore = h => {
  const cc = (h.headers || []).find(k => String(k.key).toLowerCase() === 'cache-control');
  return cc && /no-store/i.test(cc.value);
};
const rootHdr = (vj.headers || []).find(h => h.source === '/');
if (!rootHdr) {
  rootOk = false;
  fail('vercel.json has no header rule for "/" — the `/(.*\\.html)` rule does NOT match the bare root, ' +
       'so a CDN edge or the phone browser can pin an old landing page');
} else if (!noStore(rootHdr)) {
  rootOk = false;
  fail('the "/" rule exists but its Cache-Control has no no-store — no-cache PERMITS a shared cache to store and serve it');
}
const htmlHdr = (vj.headers || []).find(h => h.source === '/(.*\\.html)');
if (!htmlHdr || !noStore(htmlHdr)) {
  rootOk = false;
  fail('the *.html no-store rule is gone or weakened — /app.html would become edge-cacheable');
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────────
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`worker leaves ${ALWAYS_LIVE.join(' and ')} to the network, still caches ${CORE.join(' + ')}`);
if (rootOk) console.log('ROOT NO-STORE OK — the bare root cannot be pinned by an edge or a browser cache');
console.log('sw landing verification passed');
