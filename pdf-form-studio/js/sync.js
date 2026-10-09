/* sync.js — optional end-to-end-encrypted cross-device sync.
 *
 * The app is normally 100% local. This module lets a user mirror their data
 * (handwriting, signatures, stamps, templates, profiles) between their own
 * devices through a cloud key/value doc — WITHOUT trusting the cloud: every
 * byte is encrypted in the browser with a key derived from the user's private
 * "sync code", so the server only ever stores ciphertext.
 *
 * Backend: Firestore via its REST API (no SDK to vendor, no build step). The
 * user supplies just their own Firebase projectId + Web API key; we read/write
 * a single document whose id is a hash of the sync code. Data is E2E encrypted,
 * so even fully-open security rules expose nothing but random-looking bytes.
 *
 * The base URL is overridable (PFS.SYNC_BASE) so tests can point it at a local
 * mock of the two REST endpoints.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const store = PFS.store;
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ---- config (persisted locally; never uploaded) ------------------------
  const CFG = 'sync:cfg';
  function getCfg() { return store.get(CFG, { projectId: '', apiKey: '', code: '', auto: false }); }
  function setCfg(patch) { const c = Object.assign(getCfg(), patch); store.set(CFG, c); return c; }
  function configured() { const c = getCfg(); return !!(c.projectId && c.apiKey && c.code); }

  // ---- base64 helpers ----------------------------------------------------
  function bufToB64(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function b64ToBuf(b64) { const s = atob(b64); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }

  // ---- crypto: PBKDF2 → AES-GCM -----------------------------------------
  async function deriveKey(code, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }
  async function encryptObj(code, obj) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(code, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return 'v1.' + bufToB64(salt) + '.' + bufToB64(iv) + '.' + bufToB64(ct);
  }
  async function decryptStr(code, blob) {
    const parts = String(blob || '').split('.');
    if (parts[0] !== 'v1' || parts.length !== 4) throw new Error('bad payload');
    const salt = b64ToBuf(parts[1]), iv = b64ToBuf(parts[2]), ct = b64ToBuf(parts[3]);
    const key = await deriveKey(code, salt);
    let pt;
    try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); }
    catch (e) { throw new Error('WRONG_CODE'); }   // GCM auth fail = wrong sync code
    return JSON.parse(dec.decode(pt));
  }

  // Fixed vault id: each user has their OWN Firebase project, so one document
  // per project is the natural model. Keeping the id independent of the sync
  // code means a wrong code still finds the doc and fails to DECRYPT — a clear
  // "wrong code" error — instead of silently looking like "no data yet". The
  // doc holds only ciphertext, so a predictable id leaks nothing.
  async function docId(/* code */) { return 'fillo_vault'; }

  // ---- Firestore REST ----------------------------------------------------
  function base() { return root.PFS.SYNC_BASE || 'https://firestore.googleapis.com/v1'; }
  function docUrl(c, id) {
    return base() + '/projects/' + encodeURIComponent(c.projectId) +
      '/databases/(default)/documents/fillo/' + id + '?key=' + encodeURIComponent(c.apiKey);
  }

  async function push() {
    const c = getCfg();
    if (!configured()) throw new Error('NOT_CONFIGURED');
    const payload = await encryptObj(c.code, store.dump());
    if (payload.length > 900 * 1024) throw new Error('TOO_BIG');
    const id = await docId(c.code);
    const body = { fields: { blob: { stringValue: payload }, ts: { integerValue: String(Date.now()) } } };
    const res = await fetch(docUrl(c, id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('HTTP_' + res.status);
    return true;
  }

  async function pull() {
    const c = getCfg();
    if (!configured()) throw new Error('NOT_CONFIGURED');
    const id = await docId(c.code);
    const res = await fetch(docUrl(c, id));
    if (res.status === 404) throw new Error('EMPTY');       // nothing pushed yet
    if (!res.ok) throw new Error('HTTP_' + res.status);
    const doc = await res.json();
    const blob = doc && doc.fields && doc.fields.blob && doc.fields.blob.stringValue;
    if (!blob) throw new Error('EMPTY');
    const data = await decryptStr(c.code, blob);           // throws WRONG_CODE on mismatch
    store.restore(data);
    return true;
  }

  PFS.sync = { getCfg, setCfg, configured, push, pull, docId, _enc: encryptObj, _dec: decryptStr };
})(window);
