/* pwa.js — installable-app glue: register the service worker (real servers
 * only — never file:// or the single-file artifact) and pick up a PDF that
 * arrived via the OS share sheet (sw.js stashed it in the 'fillo-shared'
 * cache and redirected here with ?shared=1).
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const canSW = 'serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !root.PFS_SINGLE_FILE;
  if (canSW) {
    root.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('[pwa] sw register failed', e));
    });
  }

  // Fetch-and-clear a PDF stashed by the share-target flow. Returns
  // { bytes, name } or null. The app calls this on startup.
  async function takeSharedPdf() {
    if (!('caches' in root)) return null;
    try {
      const cache = await caches.open('fillo-shared');
      const res = await cache.match('shared-pdf');
      if (!res) return null;
      const bytes = await res.arrayBuffer();
      const name = decodeURIComponent(res.headers.get('X-File-Name') || 'shared.pdf');
      await cache.delete('shared-pdf');
      return bytes && bytes.byteLength ? { bytes, name } : null;
    } catch (e) { return null; }
  }

  PFS.pwa = { takeSharedPdf };
})(window);
