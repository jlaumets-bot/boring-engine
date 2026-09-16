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
// v657 EXTENDS THIS GATE TO THE LEGAL PAGES. /terms.html, /privacy.html and /refunds.html are the
// same shape as the landing page — linked from app.html's footer and from index.html, carrying no
// service-worker code of their own — and ALWAYS_LIVE did not name them, so the worker pinned each
// one on a device the first time it was viewed and updated legal text never reached that user.
// A page that states the terms someone is bound by is the LAST page that may be served from a
// months-old cache, so it is asserted here rather than trusted.
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

// The pages with no service worker of their own: if the worker answers for one of these, the
// visitor has no way left to obtain a newer copy.
/* v663: DERIVED, NOT A LIST OF THREE NAMES I HAPPENED TO THINK OF.
   This gate hardcoded terms/privacy/refunds — so when /faq.html was added, linked from the
   index.html footer and carrying no service worker of its own, it was pinned on every device that
   ever viewed it and no gate noticed. A hardcoded list can only ever catch the pages someone
   already remembered. The rule is structural: any top-level .html linked from index.html that has
   no serviceWorker registration of its own CANNOT ask for a newer copy of itself, so it must be in
   ALWAYS_LIVE. Derive that set from the repo and the next page added is covered for free. */
const LEGAL = (() => {
  const idx = fs.readFileSync(idxPath, "utf8");
  const linked = new Set();
  for (const m of idx.matchAll(/href=["']\/([a-z0-9\-]+\.html)["']/gi)) linked.add(m[1]);
  const out = [];
  for (const f of [...linked].sort()) {
    if (f === 'app.html' || f === 'index.html') continue;   // the shell, and index itself
    const full = path.join(root, f);
    if (!fs.existsSync(full)) continue;
    // A page that registers its own worker can fetch a newer copy of itself; one that does not, cannot.
    if (/serviceWorker/.test(fs.readFileSync(full, 'utf8'))) continue;
    out.push('/' + f);
  }
  return out;
})();

const mustBeLive = [
  [`${ORIGIN}/`, 'the bare root — the URL people type'],
  [`${ORIGIN}/index.html`, 'the landing page by filename'],
  [`${ORIGIN}/?utm_source=x`, 'the root with a campaign query string'],
  [`${ORIGIN}/api/health`, 'the API'],
  ...LEGAL.map(p => [`${ORIGIN}${p}`, `a legal page — updated ${p.slice(1)} must reach a user who already read it once`]),
  // the same page reached with a tracking parameter must not fall through to the cache branch
  [`${ORIGIN}/terms.html?from=signup`, 'a legal page with a query string'],
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
  for (const bad of ['/', '/index.html', ...LEGAL]) {
    if (CORE.includes(bad)) fail(`CORE still precaches ${bad} — it would be re-cached on every update`);
  }
  if (!CORE.includes('/app.html')) fail('CORE no longer precaches /app.html — the app shell would not be refreshed on update');
}
if (!Array.isArray(ALWAYS_LIVE) || !ALWAYS_LIVE.includes('/') || !ALWAYS_LIVE.includes('/index.html')) {
  fail('ALWAYS_LIVE does not name both / and /index.html');
} else {
  for (const p of LEGAL) {
    if (!ALWAYS_LIVE.includes(p)) fail(`ALWAYS_LIVE does not name ${p} — a device that has viewed it once keeps that copy forever`);
  }
}

// ── Why the SW fix is load-bearing: index.html cannot help itself ───────────────────────────────
// If the landing page ever gains its own registration + update logic this assertion should be
// revisited deliberately, not silently — that is why it is asserted rather than assumed.
const idx = fs.readFileSync(idxPath, 'utf8');
if (/serviceWorker\s*\.\s*register/.test(idx)) {
  fail('index.html now registers a service worker — re-check whether it can refresh itself before trusting this gate');
}
// Same premise for the legal pages, and one more: they must actually exist to be linked.
for (const p of LEGAL) {
  const f = path.join(root, p.slice(1));
  if (!fs.existsSync(f)) { fail(`${p} is in ALWAYS_LIVE but the file does not exist`); continue; }
  if (/serviceWorker\s*\.\s*register/.test(fs.readFileSync(f, 'utf8'))) {
    fail(`${p} now registers a service worker — re-check whether it can refresh itself before trusting this gate`);
  }
}
// And they must be reachable, or none of this matters.
// v663: this required EVERY page to be linked from app.html, which was true only because the list
// was the three legal pages. /faq.html is reached from the landing page, not from inside the app —
// that makes it no less able to pin itself, which is the whole point. So the reachability check is
// "a user can get there from somewhere", and the app's own legal obligations keep a check of their
// own, named, rather than riding on a list that now means something broader.
const appHtml = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const idxHtml = fs.readFileSync(idxPath, 'utf8');
for (const p of LEGAL) {
  if (!appHtml.includes(`href="${p}"`) && !idxHtml.includes(`href="${p}"`)) {
    fail(`nothing links ${p} any more — if the page is gone, take it out of ALWAYS_LIVE; if the link moved, confirm the new path is covered`);
  }
}
// The legal pages specifically must stay reachable from INSIDE the app, where the user agreed to them.
for (const p of ['/terms.html', '/privacy.html', '/refunds.html']) {
  if (!appHtml.includes(`href="${p}"`)) {
    fail(`app.html no longer links ${p} — the app has to link its own terms, privacy policy and refund policy`);
  }
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
