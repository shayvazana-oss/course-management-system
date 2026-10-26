/* account.js — real user accounts + automatic cloud save (the SaaS layer).
 *
 * Unlike sync.js (a personal, bring-your-own-Firebase, sync-code tool), this is
 * the product path: ONE backend (owned by the operator) serves every customer.
 * A user signs up / logs in with email + password; from then on everything —
 * handwriting, signatures, stamps, templates, per-form memory, profiles — is
 * loaded from their account on login and saved back automatically on change.
 * No sync codes, no setup, "log in anywhere and it's all there."
 *
 * Backend: Supabase, reached over plain REST (no SDK):
 *   - Auth  (GoTrue):  /auth/v1/signup, /auth/v1/token
 *   - Data  (PostgREST): /rest/v1/vaults  (one row per user, RLS-isolated)
 *
 * Operator config is baked into the page once (window.PFS_SUPABASE = {url,
 * anonKey}); a localStorage override ('acct:cfg') lets the operator try it
 * before baking, and tests point PFS.SUPA_BASE at a mock.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const store = PFS.store;
  const SESS = 'acct:session';       // {access_token, refresh_token, user, expires_at}
  const OVER = 'acct:cfg';           // optional local {url, anonKey} override

  function cfg() {
    const o = store.get(OVER, null);
    const baked = root.PFS_SUPABASE || {};
    const url = (root.PFS_SUPA_BASE) || (o && o.url) || baked.url || '';
    const anonKey = (o && o.anonKey) || baked.anonKey || '';
    return { url: String(url).replace(/\/$/, ''), anonKey };
  }
  function configured() { const c = cfg(); return !!(c.url && c.anonKey); }

  let session = store.get(SESS, null);
  function saveSession(s) { session = s; s ? store.set(SESS, s) : store.remove(SESS); }
  // Another tab of this app shares this computer's session. Tokens it
  // refreshed are adopted here (Supabase rotates refresh tokens: reusing the
  // old one got the session revoked); a sign-out or a different person signed
  // in there means this tab's in-memory session is stale — it must not keep
  // saving as the old user (that wiped or overwrote the vault).
  try {
    root.addEventListener('storage', (e) => {
      if (e.key !== 'pfs:' + SESS) return;
      let next = null; try { next = e.newValue ? JSON.parse(e.newValue) : null; } catch (er) {}
      const was = session && session.user && session.user.id;
      if (next && next.user && was && next.user.id === was) { session = next; return; }
      if (!was && !next) return;
      session = next;
      root.dispatchEvent(new CustomEvent('pfs:acct-elsewhere', { detail: { signedOut: !next } }));
    });
  } catch (e) {}
  function user() { return session && session.user; }
  function authed() { return !!(session && session.access_token); }

  async function api(pathname, opts) {
    const c = cfg();
    if (!c.url) throw new Error('NOT_CONFIGURED');
    const headers = Object.assign({ apikey: c.anonKey, 'Content-Type': 'application/json' }, (opts && opts.headers) || {});
    if (opts && opts.auth && session) headers.Authorization = 'Bearer ' + session.access_token;
    const res = await fetch(c.url + pathname, { method: (opts && opts.method) || 'GET', headers, body: opts && opts.body ? JSON.stringify(opts.body) : undefined });
    return res;
  }

  // ---- auth ---------------------------------------------------------------
  function storeAuth(j) {
    if (!j || !j.access_token) return false;
    saveSession({
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: j.user || (session && session.user)
    });
    return true;
  }
  async function signUp(email, password) {
    const res = await api('/auth/v1/signup', { method: 'POST', body: { email, password } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.msg || j.error_description || j.error || ('HTTP_' + res.status));
    // Some projects require e-mail confirmation → no session returned yet.
    if (j.access_token) storeAuth(j);
    return { needsConfirm: !j.access_token, user: j.user };
  }
  async function signIn(email, password) {
    const res = await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new Error(j.error_description || j.msg || 'BAD_CREDENTIALS');
    storeAuth(j);
    return true;
  }
  async function refresh() {
    if (!session || !session.refresh_token) return false;
    // another tab may have refreshed already: its newer tokens are the live ones
    const stored = store.get(SESS, null);
    if (stored && stored.refresh_token && stored.refresh_token !== session.refresh_token && stored.user && session.user && stored.user.id === session.user.id) {
      session = stored;
      if (Date.now() < (session.expires_at || 0) - 60000) return true;
    }
    let res;
    try { res = await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } }); }
    catch (e) { return false; }   // offline: keep the session, try again later
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      if (res.status >= 500) return false;   // the server hiccuped: not a sign-out
      saveSession(null);
      // the person is signed out now: the app must show the sign-in screen
      // (it used to lock the keyboard behind an invisible gate)
      try { root.dispatchEvent(new CustomEvent('pfs:acct-lost')); } catch (e) {}
      return false;
    }
    storeAuth(j); return true;
  }
  async function ensureFresh() {
    if (!authed()) return false;
    if (Date.now() > (session.expires_at || 0) - 60000) return refresh();
    return true;
  }
  function signOut() { saveSession(null); loadedFor = null; }

  // ---- "שכחתי סיסמה" ------------------------------------------------------
  // The server e-mails a one-time link that comes back to this page as
  // #access_token=…&type=recovery (or #error=… when it expired). NB: the
  // project's built-in mailer only reaches the Supabase team's own addresses
  // (2 an hour) — for clerks the department admin resets the password
  // instead (dept.setPassword), or a custom SMTP is set up (SUPABASE.md §5).
  async function recover(email, redirectTo) {
    const res = await api('/auth/v1/recover' + (redirectTo ? '?redirect_to=' + encodeURIComponent(redirectTo) : ''), { method: 'POST', body: { email } });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error_code || j.msg || j.error_description || ('HTTP_' + res.status)); }
    return true;
  }
  // → null | {error, description} | {type, access_token, refresh_token, expires_in}
  // (the tokens leave the address bar at once — never in history or a bookmark)
  function readRedirect() {
    const h = String(root.location.hash || '').replace(/^#/, '');
    if (!/(^|&)(access_token|error|error_code)=/.test(h)) return null;
    const p = new URLSearchParams(h);
    try { root.history.replaceState(null, '', root.location.pathname + root.location.search); } catch (e) {}
    if (p.get('error') || p.get('error_code')) return { error: p.get('error_code') || p.get('error'), description: p.get('error_description') || '' };
    return { type: p.get('type') || '', access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: +p.get('expires_in') || 3600 };
  }
  async function adoptTokens(t) {
    if (!t || !t.access_token) throw new Error('BAD_LINK');
    const c = cfg();
    const res = await fetch(c.url + '/auth/v1/user', { headers: { apikey: c.anonKey, Authorization: 'Bearer ' + t.access_token } });
    const u = await res.json().catch(() => null);
    if (!res.ok || !u || !u.id) throw new Error('BAD_LINK');
    saveSession({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, user: u });
    loadedFor = null;
    return true;
  }
  async function updatePassword(password) {
    if (!(await ensureFresh())) throw new Error('NO_SESSION');
    const res = await api('/auth/v1/user', { method: 'PUT', auth: true, body: { password } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error_code || j.msg || j.error_description || ('HTTP_' + res.status));
    return true;
  }

  // ---- vault (the user's data row) ---------------------------------------
  // Everything the app persists locally (the pfs: store) is mirrored as one
  // jsonb blob per user. Excludes account/session keys themselves.
  function localData() {
    const all = store.dump(); const out = {};
    Object.keys(all).forEach((k) => { if (k.indexOf('pfs:acct:') !== 0) out[k] = all[k]; });
    return out;
  }
  /* The FIRST sign-in on a computer that already holds work must lose
   * nothing — neither this computer's work nor what the account already has
   * in the cloud. Everything is merged, key by key:
   *   lists      → union (by id; the newer copy of the same item wins)
   *   objects    → field by field, lists inside merged the same way
   *   numbers    → the larger (a serial counter never steps back)
   *   the rest   → this computer's value
   * Later loads on the same computer take the cloud as the source of truth
   * (a deletion made elsewhere must not come back from here). */
  const STAMP = ['updatedAt', 'updated', 'ts', 'at', 'savedAt', 'added'];
  const stampOf = (x) => { for (const k of STAMP) if (x && typeof x[k] === 'number') return x[k]; return 0; };
  const idOf = (x) => (x && typeof x === 'object' && (x.id != null ? 'id:' + x.id : null));
  function mergeLists(local, cloud) {
    const out = [], seen = new Map();
    const add = (item, fromLocal) => {
      const k = idOf(item) || 'v:' + JSON.stringify(item);
      if (!seen.has(k)) { seen.set(k, out.length); out.push(item); return; }
      const i = seen.get(k), cur = out[i];
      if (stampOf(item) > stampOf(cur) || (fromLocal && stampOf(item) === stampOf(cur))) out[i] = item;
    };
    cloud.forEach((x) => add(x, false));
    local.forEach((x) => add(x, true));
    return out;
  }
  function mergeValue(local, cloud, depth) {
    if (Array.isArray(local) && Array.isArray(cloud)) return mergeLists(local, cloud);
    if (typeof local === 'number' && typeof cloud === 'number') return Math.max(local, cloud);
    if (local && cloud && typeof local === 'object' && typeof cloud === 'object' && !Array.isArray(local) && !Array.isArray(cloud) && depth < 3) {
      const out = Object.assign({}, cloud);
      Object.keys(local).forEach((k) => { out[k] = k in cloud ? mergeValue(local[k], cloud[k], depth + 1) : local[k]; });
      return out;
    }
    return local === undefined ? cloud : local;
  }
  function mergeData(localRaw, cloudRaw) {
    const out = Object.assign({}, cloudRaw);
    Object.keys(localRaw).forEach((k) => {
      if (!(k in cloudRaw) || localRaw[k] === cloudRaw[k]) { out[k] = localRaw[k]; return; }
      let l, c;
      try { l = JSON.parse(localRaw[k]); c = JSON.parse(cloudRaw[k]); } catch (e) { out[k] = localRaw[k]; return; }
      out[k] = JSON.stringify(mergeValue(l, c, 0));
    });
    return out;
  }
  // → true (cloud loaded) | 'merged' (first sign-in here: both kept) | false (no cloud data yet)
  // A save REPLACES the account's whole vault, so it is allowed only after
  // this page has read the vault for this very person. When that read failed
  // (offline at sign-in, a server error), saving this computer's — possibly
  // just-wiped — store used to overwrite everything the account had.
  let loadedFor = null;
  // Changes not yet in the cloud (closed within the 2-second debounce,
  // offline, a failed save): the next start MERGES them in instead of
  // restoring the cloud copy over them.
  const UNSYNCED = 'acct:unsynced';
  let changeSeq = 0;
  function noteLocalChange() { changeSeq++; if (!store.get(UNSYNCED, false)) store.set(UNSYNCED, true); }
  function hasUnsynced() { return !!store.get(UNSYNCED, false); }
  async function loadVault(opts) {
    if (!(await ensureFresh())) throw new Error('NO_SESSION');
    const res = await api('/rest/v1/vaults?select=data&user_id=eq.' + user().id, { auth: true, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP_' + res.status);
    const rows = await res.json();   // unreadable ≠ "no cloud data": throw, never save over it
    if (!Array.isArray(rows)) throw new Error('BAD_VAULT');
    const uid = user().id;
    if (rows[0] && rows[0].data && typeof rows[0].data === 'object' && Object.keys(rows[0].data).length) {
      const merge = (opts && opts.merge) || hasUnsynced();
      if (!store.restore(merge ? mergeData(localData(), rows[0].data) : rows[0].data)) throw new Error('RESTORE_FAILED');
      loadedFor = uid;
      return merge ? 'merged' : true;                 // cloud is the source of truth
    }
    loadedFor = uid;
    return false;                                     // no cloud data yet
  }
  function vaultLoaded() { return !!(session && session.user && loadedFor === session.user.id); }
  async function saveVault() {
    if (!authed()) return false;
    if (!vaultLoaded()) throw new Error('NOT_LOADED');
    if (!(await ensureFresh())) throw new Error('NO_SESSION');
    const seq = changeSeq;
    const body = { user_id: user().id, data: localData(), updated_at: new Date().toISOString() };
    const res = await api('/rest/v1/vaults', {
      method: 'POST', auth: true,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body
    });
    if (!res.ok) throw new Error('HTTP_' + res.status);
    if (seq === changeSeq) store.set(UNSYNCED, false);
    return true;
  }

  // ---- files (the user's documents: history, certificate formats, appendices) --
  // Bytes live in a PRIVATE Storage bucket ('docs'), one folder per user
  // (`<user id>/<kind>/<id>.pdf`), guarded by storage policies so a user can
  // only ever touch their own folder. The index of what exists rides in the
  // vault (store key 'cloud_files'), so it syncs with everything else.
  const BUCKET = 'docs';
  function filePath(kind, id) { return user().id + '/' + kind + '/' + id + '.pdf'; }
  async function putFile(kind, id, bytes, meta) {
    if (!authed()) return false;
    await ensureFresh();
    const c = cfg();
    const res = await fetch(c.url + '/storage/v1/object/' + BUCKET + '/' + filePath(kind, id), {
      method: 'POST',
      headers: { apikey: c.anonKey, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/pdf', 'x-upsert': 'true' },
      body: bytes
    });
    if (!res.ok) throw new Error('HTTP_' + res.status);
    // index entry (deduped by kind+id)
    const idx = (store.get('cloud_files', []) || []).filter((f) => !(f.kind === kind && f.id === id));
    const m = Object.assign({}, meta || {});
    if (Array.isArray(m.fill)) m.fill = packFill(m.fill);
    idx.push(Object.assign({ kind, id, ts: Date.now(), size: bytes.byteLength || bytes.length || 0 }, m));
    store.set('cloud_files', idx.slice(-120));
    return true;
  }
  async function getFile(kind, id) {
    if (!authed()) return null;
    await ensureFresh();
    const c = cfg();
    const res = await fetch(c.url + '/storage/v1/object/authenticated/' + BUCKET + '/' + filePath(kind, id), {
      headers: { apikey: c.anonKey, Authorization: 'Bearer ' + session.access_token }
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }
  async function deleteFile(kind, id) {
    if (!authed()) return false;
    await ensureFresh();
    const c = cfg();
    await fetch(c.url + '/storage/v1/object/' + BUCKET, {
      method: 'DELETE',
      headers: { apikey: c.anonKey, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [filePath(kind, id)] })
    }).catch(() => {});
    store.set('cloud_files', (store.get('cloud_files', []) || []).filter((f) => !(f.kind === kind && f.id === id)));
    return true;
  }
  function fileIndex(kind) {
    return (store.get('cloud_files', []) || []).filter((f) => !kind || f.kind === kind)
      .map((f) => (Array.isArray(f.fill) && f.fill.some((e) => e && e.imgRef) ? Object.assign({}, f, { fill: unpackFill(f.fill) }) : f));
  }
  // A history entry's fill carries its signature/stamp as an image. Stored in
  // every entry, the same signature filled the browser's storage after enough
  // exports (and then every save failed): each image is kept ONCE, by content.
  const IMGS = 'cloud_imgs';
  function imgKey(u) { let h = 0; for (let i = 0; i < u.length; i += Math.max(1, (u.length / 4096) | 0)) h = (h * 31 + u.charCodeAt(i)) | 0; return 'i' + (h >>> 0).toString(36) + '_' + u.length; }
  function packFill(fill) {
    const imgs = store.get(IMGS, {}) || {}; let added = false;
    const out = fill.map((e) => {
      if (!e || typeof e.imgUrl !== 'string' || e.imgUrl.indexOf('data:') !== 0) return e;
      const k = imgKey(e.imgUrl);
      if (imgs[k] !== e.imgUrl) { imgs[k] = e.imgUrl; added = true; }
      const c = Object.assign({}, e); delete c.imgUrl; c.imgRef = k; return c;
    });
    if (added) store.set(IMGS, imgs);
    return out;
  }
  function unpackFill(fill) {
    const imgs = store.get(IMGS, {}) || {};
    return fill.map((e) => (e && e.imgRef ? Object.assign({}, e, { imgUrl: imgs[e.imgRef] || null }) : e));
  }

  // ---- the certificates department (shared, see SUPABASE.md §4) ----------
  // Personal data stays personal; what the department shares is its
  // certificate archive, its serial numbering and its certificate formats.
  // The server decides who is a member (row-level security on every table),
  // and numbers are handed out by ONE atomic counter, so two clerks producing
  // at the same moment can never print the same serial.
  async function rest(pathname, opts) {
    if (!authed()) throw new Error('NOT_SIGNED_IN');
    await ensureFresh();
    const res = await api(pathname, Object.assign({ auth: true }, opts || {}));
    if (res.status === 404) { const j = await res.json().catch(() => ({})); const e = new Error('DEPT_NOT_INSTALLED'); e.detail = j; throw e; }
    if (!res.ok) throw new Error('HTTP_' + res.status);
    if (res.status === 204) return null;
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }
  const me = () => String((user() && user().email) || '').toLowerCase();
  const dept = {
    // {installed, member, role, members:[{email, role}]}
    async status() {
      try {
        const rows = await rest('/rest/v1/dept_members?select=email,role&order=email.asc', { headers: { Accept: 'application/json' } });
        const mine = (rows || []).find((r) => r.email === me());
        return { installed: true, member: !!mine, role: mine ? mine.role : null, members: rows || [] };
      } catch (e) {
        if (e.message === 'DEPT_NOT_INSTALLED') return { installed: false, member: false, role: null, members: [] };
        throw e;
      }
    },
    // the first person to set the department up becomes its admin
    async claim() { return !!(await rest('/rest/v1/rpc/dept_claim', { method: 'POST', body: {} })); },
    async addMember(email) {
      return rest('/rest/v1/dept_members', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { email: String(email).trim().toLowerCase(), role: 'member', added_by: me() } });
    },
    async removeMember(email) { return rest('/rest/v1/dept_members?email=eq.' + encodeURIComponent(String(email).toLowerCase()), { method: 'DELETE' }); },
    // the admin sets a new password for a member who forgot theirs (no e-mail
    // needed); the server function checks that the caller is the admin and
    // the person is in the department — SUPABASE.md §5
    async setPassword(email, password) { return !!(await rest('/rest/v1/rpc/dept_set_password', { method: 'POST', body: { p_email: String(email).trim().toLowerCase(), p_password: password } })); },
    async listBatches() {
      const rows = await rest('/rest/v1/dept_batches?select=id,data,created_by,created_at&order=created_at.asc', { headers: { Accept: 'application/json' } });
      return (rows || []).map((r) => Object.assign({}, r.data || {}, { id: r.id, by: r.created_by, shared: true }));
    },
    async putBatch(b) {
      const data = Object.assign({}, b); delete data.by; delete data.shared; delete data.pending;
      return rest('/rest/v1/dept_batches', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { id: b.id, data, updated_at: new Date().toISOString() } });
    },
    async deleteBatch(id) { return rest('/rest/v1/dept_batches?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: { Prefer: 'return=representation' } }); },
    // `count` consecutive numbers from the shared counter → the first one
    async nextSerials(name, count) { return Number(await rest('/rest/v1/rpc/dept_next', { method: 'POST', body: { p_name: name, p_count: count } })); },
    // the counter never goes below numbers already issued (only ever raises it)
    async seedSerials(name, floor) { return Number(await rest('/rest/v1/rpc/dept_seed', { method: 'POST', body: { p_name: name, p_floor: floor } })); },
    async listFormats() { return (await rest('/rest/v1/dept_formats?select=id,name,created_by,created_at&order=created_at.asc', { headers: { Accept: 'application/json' } })) || []; },
    async putFormat(id, name, bytes) {
      await ensureFresh();
      const c = cfg();
      const res = await fetch(c.url + '/storage/v1/object/' + BUCKET + '/dept/formats/' + id + '.pdf', {
        method: 'POST', headers: { apikey: c.anonKey, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, body: bytes
      });
      if (!res.ok) throw new Error('HTTP_' + res.status);
      await rest('/rest/v1/dept_formats', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { id, name } });
      return true;
    },
    async getFormat(id) {
      await ensureFresh();
      const c = cfg();
      const res = await fetch(c.url + '/storage/v1/object/authenticated/' + BUCKET + '/dept/formats/' + id + '.pdf', { headers: { apikey: c.anonKey, Authorization: 'Bearer ' + session.access_token } });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    },
    // The team's signatures, stamps and clips: one JSON file in the
    // department's folder — the same members-only storage rules as the
    // formats, so nothing new is installed on the server.
    // → {items:[…]}; nothing shared yet → {items: []}; unreadable → throws
    // (a share that follows must never write over what it could not read)
    async getAssets() {
      await ensureFresh();
      const c = cfg();
      const res = await fetch(c.url + '/storage/v1/object/authenticated/' + BUCKET + '/dept/assets.json', { headers: { apikey: c.anonKey, Authorization: 'Bearer ' + session.access_token }, cache: 'no-store' });
      if (res.ok) {
        const j = await res.json().catch(() => null);
        if (!j || !Array.isArray(j.items)) throw new Error('BAD_ASSETS');
        return j;
      }
      // storage answers a missing file with 400 {"statusCode":"404"} (older) or 404
      const t = await res.text().catch(() => '');
      if (res.status === 404 || (res.status === 400 && /not[_ ]?found|"404"/i.test(t))) return { items: [] };
      throw new Error('HTTP_' + res.status);
    },
    async putAssets(doc) {
      await ensureFresh();
      const c = cfg();
      const res = await fetch(c.url + '/storage/v1/object/' + BUCKET + '/dept/assets.json', {
        method: 'POST', headers: { apikey: c.anonKey, Authorization: 'Bearer ' + session.access_token, 'Content-Type': 'application/json', 'x-upsert': 'true' }, body: JSON.stringify(doc)
      });
      if (!res.ok) throw new Error('HTTP_' + res.status);
      return true;
    }
  };

  PFS.account = {
    dept, _mergeData: mergeData, cfg, configured, authed, user, signUp, signIn, signOut, refresh, recover, readRedirect, adoptTokens, updatePassword, loadVault, saveVault, vaultLoaded: () => vaultLoaded(), noteLocalChange: () => noteLocalChange(), hasUnsynced: () => hasUnsynced(), putFile, getFile, deleteFile, fileIndex, _localData: localData, _saveSessionCfg: (o) => store.set(OVER, o) };
})(window);
