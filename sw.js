// ── Content Shrimp service worker ──
// CACHE is STABLE and must survive every deploy — DO NOT bump it per release (that is what forced a
// full cold re-download of the ~1.8MB app on every deploy). To ship an app update, bump BUILD below:
// changing BUILD makes this file byte-different, the browser detects a new worker, and `install`
// pulls the fresh app.html into the SAME stable cache while the OLD copy keeps serving instantly.
const CACHE = 'cs-shell';   // stable — never rename
const BUILD = 'v656-ee99fe10';       // ← bump this string on every app.html/asset change to push an update

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
const ALWAYS_LIVE = ['/', '/index.html'];

self.addEventListener('install', e => {
  self.skipWaiting();
  // Pull the fresh shell into the stable cache IN THE BACKGROUND. The currently-cached copy keeps
  // serving instantly the whole time, so this launch is never blocked. If the network is dead, the
  // per-URL catch swallows it and we simply keep the old copy — the app is never left empty/bricked.
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.allSettled(CORE.map(u =>
        fetch(u, { cache: 'reload' })
          .then(r => (r && r.ok) ? c.put(u, r) : null)
          .catch(() => {})
      ))
    )
  );
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
