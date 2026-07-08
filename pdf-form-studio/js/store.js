/* store.js — tiny namespaced localStorage wrapper.
 * All persisted data (saved signatures, stamps, templates) lives here.
 * Kept behind a small API so it can be swapped for IndexedDB later (v2)
 * without touching callers. Everything is local to this browser.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const PREFIX = 'pfs:';

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        console.warn('[store] read failed', key, e);
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        // Most likely QuotaExceededError.
        console.warn('[store] write failed', key, e);
        PFS.toast && PFS.toast('אין מספיק מקום אחסון מקומי — נסה למחוק נכסים ישנים', 'err');
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(PREFIX + key); } catch (e) {}
    },
    // snapshot / restore all app data (for backup files)
    dump() {
      const o = {};
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.indexOf(PREFIX) === 0) o[k] = localStorage.getItem(k); } } catch (e) {}
      return o;
    },
    restore(obj) {
      if (!obj || typeof obj !== 'object') return false;
      try { Object.keys(obj).forEach((k) => { if (k.indexOf(PREFIX) === 0) localStorage.setItem(k, obj[k]); }); return true; }
      catch (e) { console.warn('[store] restore failed', e); return false; }
    }
  };

  PFS.store = store;
})(window);
