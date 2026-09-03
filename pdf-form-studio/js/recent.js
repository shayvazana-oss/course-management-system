/* recent.js — "המסמכים האחרונים": keep the last opened PDFs (bytes included)
 * in IndexedDB so a form can be reopened with one click — no re-hunting for
 * the file. Combined with per-form auto-memory it reopens already filled.
 * Cap 10 docs, oldest evicted. All local, like everything else.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const DB = 'fillo-docs', STORE = 'docs', CAP = 30;

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

  async function save(name, bytes) {
    try {
      const db = await open();
      const all = await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
      // same name → replace (refresh ts); else insert
      const dup = all.find((d) => d.name === name);
      const id = dup ? dup.id : 'd' + Date.now() + Math.random().toString(36).slice(2, 6);
      await tx(db, 'readwrite', (s) => s.put({ id, name, ts: Date.now(), bytes }));
      const rest = all.filter((d) => d.id !== id).sort((a, b) => b.ts - a.ts);
      for (const d of rest.slice(CAP - 1)) await tx(db, 'readwrite', (s) => s.delete(d.id));
      db.close();
    } catch (e) { /* private-mode / quota — recents are a bonus, never block */ }
  }
  async function list() {
    try {
      const db = await open();
      const all = await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
      db.close();
      return all.sort((a, b) => b.ts - a.ts).map(({ id, name, ts }) => ({ id, name, ts }));
    } catch (e) { return []; }
  }
  async function get(id) {
    try {
      const db = await open();
      const doc = await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      db.close(); return doc || null;
    } catch (e) { return null; }
  }

  async function remove(id) {
    try {
      const db = await open();
      await tx(db, 'readwrite', (st) => st.delete(id));
      db.close(); return true;
    } catch (e) { return false; }
  }

  PFS.recent = { save, list, get, remove };
})(window);
