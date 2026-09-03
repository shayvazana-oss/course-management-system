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
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
        // actively look for a newer deploy — on load and whenever the tab
        // comes back to the foreground (long-lived pinned tabs).
        const check = () => reg.update().catch(() => {});
        check();
        document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
        // when an updated worker takes control, reload ONCE so the user is
        // actually running the new code (the old cache-first worker used to
        // freeze users on their first-ever version — never again).
        const hadController = !!navigator.serviceWorker.controller;
        let reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!hadController || reloaded) return;   // first install → no reload
          reloaded = true;
          // never yank a form out from under the user — with unsaved work we
          // announce instead of reloading
          if (PFS.isDirty && PFS.isDirty()) {
            PFS.toast && PFS.toast('גרסה חדשה של Fillo מוכנה — שמרו/ייצאו ורעננו את הדף 🔄', 'ok', 8000);
            return;
          }
          location.reload();
        });
      }).catch((e) => console.warn('[pwa] sw register failed', e));
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

  // ---- install-as-app plumbing ----
  // Chrome/Android fire beforeinstallprompt; iOS never does (install is
  // Share → "הוסף למסך הבית"), so we expose both: a real prompt when the
  // browser offers one, and an instructions path otherwise.
  let deferredPrompt = null;
  const isStandalone = () =>
    matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
  root.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.dispatchEvent(new CustomEvent('pfs-installable'));
  });
  async function promptInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const res = await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      return res && res.outcome === 'accepted' ? 'accepted' : 'dismissed';
    }
    return isIOS() ? 'ios' : 'unsupported';
  }

  PFS.pwa = { takeSharedPdf, promptInstall, canInstall: () => !!deferredPrompt, isStandalone, isIOS };
})(window);
