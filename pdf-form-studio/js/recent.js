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

  // save(name, bytes, opts?) → the doc id (a cloud copy is stored under the
  // same id, so the two sides always agree). opts.id / opts.ts pin a cloud
  // record being brought back to this computer.
  // opts.fill = the filled state (element models) saved WITH the document —
  // a finished form for one student is its own history entry, labelled with
  // the student's name, and reopens exactly as it was exported
  async function save(name, bytes, opts) {
    try {
      const db = await open();
      const all = await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
      // same name → replace (refresh ts); else insert. A filled snapshot never
      // replaces the blank form's entry (different name) but does replace an
      // earlier snapshot of the same form + same student.
      const dup = all.find((d) => d.name === name);
      const id = (opts && opts.id) || (dup ? dup.id : 'd' + Date.now() + Math.random().toString(36).slice(2, 6));
      const rec = { id, name, ts: (opts && opts.ts) || Date.now(), bytes };
      if (opts && opts.fill) rec.fill = opts.fill;
      if (opts && opts.label) rec.label = opts.label;
      await tx(db, 'readwrite', (s) => s.put(rec));
      const rest = all.filter((d) => d.id !== id && d.name !== name).sort((a, b) => b.ts - a.ts);
      for (const d of rest.slice(CAP - 1)) await tx(db, 'readwrite', (s) => s.delete(d.id));
      db.close();
      return id;
    } catch (e) { return null; /* private-mode / quota — recents are a bonus, never block */ }
  }
  async function clearAll() {
    try { const db = await open(); await tx(db, 'readwrite', (s) => s.clear()); db.close(); } catch (e) {}
  }
  async function list() {
    try {
      const db = await open();
      const all = await new Promise((res) => { const r = db.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); });
      db.close();
      return all.sort((a, b) => b.ts - a.ts).map(({ id, name, ts, label, fill }) => ({ id, name, ts, label: label || '', filled: !!fill }));
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

  PFS.recent = { save, list, get, remove, clearAll };
})(window);
