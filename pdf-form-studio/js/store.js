/* store.js — tiny namespaced storage wrapper.
 * All persisted data (saved signatures, stamps, templates, handwriting) lives
 * here. Uses localStorage when the browser allows it; inside a sandboxed
 * iframe (e.g. a hosted artifact) localStorage access throws SecurityError,
 * so we fall back to an in-memory map — everything works for the session and
 * `persistent` is false so the app can tell the user to use backup/restore.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const PREFIX = 'pfs:';

  // pick a backend: real localStorage if usable, else in-memory Map
  let backend, persistent;
  try {
    const probe = PREFIX + '__probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    backend = {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
      remove: (k) => localStorage.removeItem(k),
      keys: () => { const a = []; for (let i = 0; i < localStorage.length; i++) a.push(localStorage.key(i)); return a; }
    };
    persistent = true;
  } catch (e) {
    const mem = new Map();
    backend = {
      get: (k) => (mem.has(k) ? mem.get(k) : null),
      set: (k, v) => { mem.set(k, String(v)); },
      remove: (k) => { mem.delete(k); },
      keys: () => [...mem.keys()]
    };
    persistent = false;
    console.warn('[store] localStorage unavailable (sandboxed?) — using in-memory storage for this session');
  }

  const store = {
    persistent,
    get(key, fallback) {
      try {
        const raw = backend.get(PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        console.warn('[store] read failed', key, e);
        return fallback;
      }
    },
    set(key, value) {
      try {
        backend.set(PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {
        // Most likely QuotaExceededError.
        console.warn('[store] write failed', key, e);
        PFS.toast && PFS.toast('אין מספיק מקום אחסון מקומי — נסה למחוק נכסים ישנים', 'err');
        return false;
      }
    },
    remove(key) {
      try { backend.remove(PREFIX + key); } catch (e) {}
    },
    // snapshot / restore all app data (for backup files)
    dump() {
      const o = {};
      try { backend.keys().forEach((k) => { if (k && k.indexOf(PREFIX) === 0) o[k] = backend.get(k); }); } catch (e) {}
      return o;
    },
    restore(obj) {
      if (!obj || typeof obj !== 'object') return false;
      try { Object.keys(obj).forEach((k) => { if (k.indexOf(PREFIX) === 0) backend.set(k, obj[k]); }); return true; }
      catch (e) { console.warn('[store] restore failed', e); return false; }
    }
  };

  PFS.store = store;
})(window);
