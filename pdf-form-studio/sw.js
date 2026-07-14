/* sw.js — Fillo service worker.
 * 1. Offline app shell: core files precached on install; vendor assets are
 *    runtime-cached on first use (tesseract/fonts are heavy — no precache).
 * 2. Web Share Target: WhatsApp/any app shares a PDF → the OS POSTs it to
 *    ./share-target → we stash it in a cache and redirect to the app, which
 *    picks it up and opens it (see js/pwa.js).
 */
const VER = 'fillo-v1';
const CORE = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'
];
const SHARE_CACHE = 'fillo-shared';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VER).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VER && k !== SHARE_CACHE).map((k) => caches.delete(k))))
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

  // App shell + same-origin assets: cache-first with network fill.
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: url.pathname.endsWith('/index.html') });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && (url.pathname.includes('/vendor/') || CORE.some((p) => url.pathname.endsWith(p.slice(1))))) {
        const c = await caches.open(VER);
        c.put(e.request, res.clone());
      }
      return res;
    } catch (err) {
      // offline fallback: the shell for navigations
      if (e.request.mode === 'navigate') { const shell = await caches.match('./index.html'); if (shell) return shell; }
      throw err;
    }
  })());
});
