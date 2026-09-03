/* companions.js — linked follow-up forms ("נספחים").
 *
 * A quote often travels with an appendix, a request form with a consent page.
 * Linking teaches Fillo the pair ONCE: while form A is open, the user attaches
 * the companion PDF; from then on, whenever a form matching A's fingerprint is
 * opened, the app offers the companion — and opens it pre-filled by carrying
 * form A's values across via the semantic field matcher (vault.matchKey), so
 * "שם הלקוח" on the appendix picks up what "שם לקוח" said on the quote.
 *
 * Metadata lives in localStorage; the companion PDF bytes live in the Cache
 * API (same mechanism the share-target already uses), with a base64
 * localStorage fallback for environments without caches (file://, sandboxes).
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const KEY = 'companions';
  const CACHE = 'fillo-companions';
  const MAX_BYTES = 8 * 1024 * 1024;   // sane ceiling for a stored appendix

  const all = () => PFS.store.get(KEY, []) || [];
  const save = (arr) => PFS.store.set(KEY, arr);
  const uid = () => 'cp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const hasCaches = () => typeof caches !== 'undefined' && /^https?:$/.test(location.protocol);

  async function putBytes(id, bytes) {
    if (hasCaches()) {
      const c = await caches.open(CACHE);
      await c.put('./' + id, new Response(bytes, { headers: { 'Content-Type': 'application/pdf' } }));
      return 'cache';
    }
    // fallback: base64 in localStorage (small forms only — quota is tight)
    let bin = ''; const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    PFS.store.set('companion_bytes_' + id, btoa(bin));
    return 'ls';
  }
  async function readBytes(id) {
    if (hasCaches()) {
      try {
        const c = await caches.open(CACHE);
        const res = await c.match('./' + id);
        if (res) return await res.arrayBuffer();
      } catch (e) {}
    }
    const b64 = PFS.store.get('companion_bytes_' + id, null);
    if (!b64) return null;
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  async function dropBytes(id) {
    if (hasCaches()) { try { const c = await caches.open(CACHE); await c.delete('./' + id); } catch (e) {} }
    PFS.store.remove('companion_bytes_' + id);
  }

  /* add({ ownerFp, ownerName, name, bytes }) → link record */
  async function add(opts) {
    if (!opts || !opts.ownerFp) throw new Error('אין טופס פתוח לקשר אליו');
    if (!opts.bytes || !opts.bytes.byteLength) throw new Error('קובץ הנספח ריק');
    if (opts.bytes.byteLength > MAX_BYTES) throw new Error('הנספח גדול מדי לשמירה (עד 8MB)');
    const id = uid();
    await putBytes(id, opts.bytes);
    const rec = {
      id,
      ownerFp: opts.ownerFp,                       // fingerprint of the trigger form
      ownerName: opts.ownerName || '',
      name: (opts.name || 'נספח').replace(/\.pdf$/i, ''),
      created: Date.now()
    };
    save([...all(), rec]);
    return rec;
  }

  async function remove(id) {
    save(all().filter((r) => r.id !== id));
    await dropBytes(id);
  }

  /* companions linked to the given form fingerprint (fuzzy — same scorer that
   * drives template auto-apply, so scans match too) */
  function listFor(fp) {
    if (!fp) return [];
    return all().filter((r) => {
      try { return PFS.fingerprint.score(fp, r.ownerFp) >= 0.85; } catch (e) { return false; }
    });
  }

  // patch(id, obj) — merge metadata onto a record (e.g. caching the
  // companion's own fingerprint for the reverse owner lookup)
  function patch(id, obj) {
    save(all().map((r) => (r.id === id ? Object.assign({}, r, obj) : r)));
  }

  PFS.companions = { add, remove, listFor, all, patch, getBytes: readBytes };
})(window);
