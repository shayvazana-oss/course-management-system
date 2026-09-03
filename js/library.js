/* library.js — the permanent document library ("המאגר").
 *
 * Recents evict after 10; the library is CURATED: the forms the office uses
 * every day (הצעת מחיר, נספח ה3, נספח ו…) live here by name, forever, and
 * open with one click — no re-hunting through the Downloads folder. Bytes +
 * metadata in IndexedDB (same proven pattern as recent.js, no eviction cap),
 * so it survives restarts and works offline.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const DB = 'fillo-library', STORE = 'docs';
  const MAX_BYTES = 15 * 1024 * 1024;

  function open() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => { rq.result.createObjectStore(STORE, { keyPath: 'id' }); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  }
  function tx(db, mode, fn) {
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode); const s = t.objectStore(STORE);
      const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  }
  const uid = () => 'lib' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  async function add(name, bytes) {
    if (!bytes || !bytes.byteLength) throw new Error('קובץ ריק');
    if (bytes.byteLength > MAX_BYTES) throw new Error('הקובץ גדול מדי למאגר (עד 15MB)');
    const clean = String(name || 'מסמך').replace(/\.pdf$/i, '').trim() || 'מסמך';
    const rec = { id: uid(), name: clean, bytes, size: bytes.byteLength, added: Date.now(), lastUsed: 0 };
    const db = await open();
    await tx(db, 'readwrite', (s) => s.put(rec));
    return { id: rec.id, name: rec.name };
  }

  async function list() {
    try {
      const db = await open();
      const all = await tx(db, 'readonly', (s) => s.getAll());
      return (all || [])
        .map((r) => ({ id: r.id, name: r.name, size: r.size, added: r.added, lastUsed: r.lastUsed }))
        .sort((a, b) => (b.lastUsed || b.added) - (a.lastUsed || a.added));
    } catch (e) { return []; }
  }

  async function get(id) {
    const db = await open();
    const rec = await tx(db, 'readonly', (s) => s.get(id));
    if (rec) { rec.lastUsed = Date.now(); tx(db, 'readwrite', (s) => s.put(rec)).catch(() => {}); }
    return rec || null;
  }

  async function rename(id, name) {
    const clean = String(name || '').trim();
    if (!clean) return false;
    const db = await open();
    const rec = await tx(db, 'readonly', (s) => s.get(id));
    if (!rec) return false;
    rec.name = clean;
    await tx(db, 'readwrite', (s) => s.put(rec));
    return true;
  }

  async function remove(id) {
    const db = await open();
    await tx(db, 'readwrite', (s) => s.delete(id));
  }

  PFS.library = { add, list, get, rename, remove };
})(window);
