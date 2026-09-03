/* sw.js — Fillo service worker.
 *
 * Strategy: NETWORK-FIRST for every same-origin GET, with the cache as an
 * offline fallback. The previous worker was cache-first with a fixed version,
 * which froze index.html/app.js/styles.css at whatever the user's FIRST visit
 * installed — every later deploy silently never reached them (hard refresh
 * included, since the worker answered before the network). Freshness beats
 * a few ms of latency for a tool that gets bug fixes; offline still works
 * because every successful response refreshes the fallback cache.
 *
 * '3a23cc5' is stamped with the commit SHA by the deploy workflow, so
 * each deploy gets its own cache and activate() purges all older ones.
 *
 * Also: Web Share Target — WhatsApp/any app shares a PDF → the OS POSTs it to
 * ./share-target → stash in a cache and redirect to the app (see js/pwa.js).
 */
const VER = 'fillo-3a23cc5';
const SHARE_CACHE = 'fillo-shared';
const CORE = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  './js/store.js', './js/ui.js', './js/vault.js', './js/patterns.js', './js/courses.js',
  './js/merge.js', './js/detect.js', './js/fields-panel.js', './js/overlay.js',
  './js/element.js', './js/fontmatch.js', './js/library.js', './js/pwa.js'
];

self.addEventListener('install', (e) => {
  // best-effort precache so offline works even before first runtime fill
  e.waitUntil(
    caches.open(VER)
      .then((c) => Promise.allSettled(CORE.map((p) => c.add(p))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Share target: stash the shared PDF, bounce to the app.
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('pdf') || [...form.values()].find((v) => v && v.arrayBuffer);
        if (file && file.arrayBuffer) {
          const cache = await caches.open(SHARE_CACHE);
          await cache.put('shared-pdf', new Response(await file.arrayBuffer(), {
            headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name || 'shared.pdf') }
          }));
        }
      } catch (err) { /* fall through to the app either way */ }
      return Response.redirect('./index.html?shared=1', 303);
    })());
    return;
  }

  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res && res.ok) {
        const c = await caches.open(VER);
        c.put(e.request, res.clone());     // refresh the offline fallback
      }
      return res;
    } catch (err) {
      // offline: serve the last good copy; navigations fall back to the shell
      const hit = await caches.match(e.request, { ignoreSearch: url.pathname.endsWith('/index.html') });
      if (hit) return hit;
      if (e.request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
