// ── Content Shrimp service worker ──
// CACHE is STABLE and must survive every deploy — DO NOT bump it per release (that is what forced a
// full cold re-download of the ~1.8MB app on every deploy). To ship an app update, bump BUILD below:
// changing BUILD makes this file byte-different, the browser detects a new worker, and `install`
// pulls the fresh app.html into the SAME stable cache while the OLD copy keeps serving instantly.
const CACHE = 'cs-shell';   // stable — never rename
const BUILD = 'v673-87520e0c';       // ← bump this string on every app.html/asset change to push an update

// Only the app shell is refreshed on update. Images/icons are cached lazily on first use (never
// eagerly precached — on a very slow connection an eager 1.8MB precache saturates the pipe and is
// exactly what made first-open hang for minutes).
//
// THE MARKETING PAGE ('/' and '/index.html') IS DELIBERATELY ABSENT — see the fetch handler. It used
// to be here, and that is what froze contentshrimp.com on an old build for anyone who had ever
// opened the app: this worker's scope is the whole origin, so it served the landing page from cache
// too, and index.html carries no service-worker code of its own to ever ask for a newer copy.
const CORE = ['/app.html', '/manifest.json'];

// Requests the worker must never answer from cache. Compared against the pathname, not the raw URL,
// so a query string or a hash cannot slip a stale copy through (`/?utm_source=…` is still the
// landing page).
//
// THE LEGAL PAGES BELONG HERE FOR THE SAME REASON AS THE LANDING PAGE, AND THEY WERE MISSED.
// /terms.html, /privacy.html and /refunds.html are linked from app.html (the footer, around line
// 8639) and from index.html. This worker's scope is the whole origin, so the cache-first branch
// below pinned each of them on a device the FIRST time that device viewed it — and, exactly like
// index.html, none of them carries any service-worker code of its own, so nothing on those pages
// can ever ask for a newer copy. A user who read the terms once was then held on that version
// forever: updated terms, an updated privacy policy or a changed refund window never reached them,
// while the origin served the current text to everyone else. These are the documents where "the
// user saw the current version" is the entire point.
// v663: /faq.html was missed, one door over from the pages this comment is about. It is linked
// from the index.html footer, it is in the sitemap, and it carries no service-worker code of its
// own — so it was pinned on a device the first time that device viewed it, exactly like the legal
// pages were. Someone who read the FAQ once kept that FAQ forever: a rewritten pricing answer or a
// changed "does it post for me?" never reached them while everyone else saw the current text.
// THE RULE, so the next page added does not repeat this: every top-level .html that is linked from
// index.html and has no service worker of its own belongs here. scripts/verify/sw-landing-live.mjs
// now derives the list from index.html rather than hardcoding three names.
const ALWAYS_LIVE = ['/', '/index.html', '/terms.html', '/privacy.html', '/refunds.html', '/faq.html'];

// v663: the marker that says WHICH build's shell is actually in the cache. Without it nothing
// could tell a successful update from a failed one — see the install handler below.
const SHELL_MARK = '/__cs_shell_build';
self.addEventListener('install', e => {
  self.skipWaiting();
  // Pull the fresh shell into the stable cache IN THE BACKGROUND. The currently-cached copy keeps
  // serving instantly the whole time, so this launch is never blocked. If the network is dead, the
  // per-URL catch swallows it and we simply keep the old copy — the app is never left empty/bricked.
  /* v663: A FAILED SHELL DOWNLOAD USED TO FREEZE THE USER ON THE OLD APP FOREVER, AND THE APP
     THEN TOLD THEM THEY WERE UP TO DATE.
     Every failure here is swallowed by the per-URL catch, so install always "succeeds". activate
     then finds a shell in the cache — the OLD one — and prunes as though the update landed. From
     that moment nothing retries: there was no message/sync listener, the fetch handler below was
     pure cache-first with no revalidation, and reg.update() now downloads a byte-identical sw.js,
     so `updatefound` never fires again. The user taps the "New version ready · Refresh" banner,
     gets the same old build, and "check for update" answers "You're on the latest ✓" — the exact
     opposite of the truth. On a weak connection this compounds, and this product ships fixes daily.
     Two things change. First, record whether the shell ACTUALLY arrived, so the app can tell the
     difference. Second, see the fetch handler: the shell now revalidates in the background, so a
     missed download heals itself on the next launch instead of never. */
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      let shellOk = false;
      await Promise.allSettled(CORE.map(u =>
        fetch(u, { cache: 'reload' })
          .then(r => {
            if (!r || !r.ok) return null;
            if (u === '/app.html') shellOk = true;
            return c.put(u, r);
          })
          .catch(() => {})
      ));
      // The marker is written ONLY when this build's shell really landed. A stale marker is worse
      // than none: it is what would let the app claim an update it does not have.
      try {
        if (shellOk) await c.put(SHELL_MARK, new Response(BUILD, { headers: { 'content-type': 'text/plain' } }));
        else await c.delete(SHELL_MARK).catch(() => {});
      } catch (_) {}
    })
  );
});

// v663: let the page ask what the cache actually holds, and ask for a retry. Both are cheap and
// neither existed, which is why a stuck device had no way back short of a URL nobody knows.
self.addEventListener('message', e => {
  const msg = (e.data && e.data.type) || '';
  if (msg === 'cs-shell-build') {
    e.waitUntil((async () => {
      let have = null;
      try { const r = await caches.match(SHELL_MARK); if (r) have = (await r.text()).trim(); } catch (_) {}
      try { (e.ports && e.ports[0]) && e.ports[0].postMessage({ build: BUILD, shell: have }); } catch (_) {}
    })());
  } else if (msg === 'cs-refetch-shell') {
    e.waitUntil((async () => {
      let ok = false;
      try {
        const c = await caches.open(CACHE);
        const r = await fetch('/app.html', { cache: 'reload' });
        if (r && r.ok) { await c.put('/app.html', r); await c.put(SHELL_MARK, new Response(BUILD, { headers: { 'content-type': 'text/plain' } })); ok = true; }
      } catch (_) {}
      try { (e.ports && e.ports[0]) && e.ports[0].postMessage({ ok: ok }); } catch (_) {}
    })());
  }
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Only prune old caches ONCE the new stable cache actually holds the shell — never delete the
    // last good copy and leave the user with nothing to open.
    const c = await caches.open(CACHE);
    const hasShell = await c.match('/app.html');
    if (hasShell) {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    }
    // Evict the marketing page a previous worker cached. The fetch handler already bypasses it, so
    // this is hygiene rather than correctness — but it means a device carrying a months-old copy of
    // the landing page is not still carrying it after this update.
    await Promise.all(ALWAYS_LIVE.map(u => c.delete(u).catch(() => {})));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = e.request.url;
  if (url.includes('/api/')) return;                 // API: always live, never cached
  if (url.includes('brand-brain-animation')) return; // LOOP animation: always fresh (per-load ?t=)
  if (url.includes('nocache=1')) return;             // v468: dev bypass — app.html?nocache=1 always fetches the LIVE deployed build
  // THE MARKETING PAGE IS ALWAYS LIVE. This worker's scope is the whole origin, so without this it
  // serves contentshrimp.com from cache to anyone who has ever opened the app — and index.html has
  // no service-worker code of its own, so a landing-page visit can never fetch a newer copy of
  // itself. The result is a marketing site frozen on an old build with no way for the visitor to
  // clear it. A marketing page needs to be current, not offline-capable; the app shell below is the
  // thing that genuinely needs cache-first on a 0.5KB/s line.
  let _path = '';
  try { _path = new URL(url).pathname; } catch (_) {}
  if (ALWAYS_LIVE.indexOf(_path) !== -1) return;
  // CACHE-FIRST: serve the cached copy INSTANTLY and do NOT re-download it in the background on every
  // launch (that background refetch would hog a 0.5KB/s connection and stall the generate calls the
  // user actually cares about). `caches.match` searches ALL caches, so a copy stashed under an older
  // cache name is still found during a migration. App updates arrive via the BUILD bump above, not here.
  /* v663: THE SHELL — and only the shell — now revalidates in the background.
     The comment above is right that a background refetch of EVERY asset would hog a 0.5KB/s line,
     so this is deliberately limited to /app.html: one request per launch, after the response has
     already been served from cache, so nothing the user is waiting on is delayed. It is what makes
     a failed install heal itself instead of stranding the device on an old build forever. */
  if (_path === '/app.html') {
    e.respondWith((async () => {
      const cached = await caches.match(e.request);
      const revalidate = (async () => {
        try {
          const r = await fetch('/app.html', { cache: 'reload' });
          if (r && r.ok) {
            const c = await caches.open(CACHE);
            await c.put('/app.html', r.clone());
            await c.put(SHELL_MARK, new Response(BUILD, { headers: { 'content-type': 'text/plain' } }));
          }
          return r;
        } catch (_) { return null; }
      })();
      if (cached) { e.waitUntil(revalidate); return cached; }
      const fresh = await revalidate;
      return fresh || fetch(e.request);
    })());
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (r && r.ok && r.type === 'basic') {
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return r;
      }).catch(() => cached); // offline + not cached → nothing we can do
    })
  );
});


// ── Daily idea notification ──
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Content Shrimp', {
    body: d.body || 'Your post is ready.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: d.url || '/app.html' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/app.html';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.includes('/app.html') && 'focus' in c) return c.focus(); }
    return clients.openWindow(url);
  }));
});
