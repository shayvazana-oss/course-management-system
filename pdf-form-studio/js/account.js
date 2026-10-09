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
    const res = await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) { saveSession(null); return false; }
    storeAuth(j); return true;
  }
  async function ensureFresh() {
    if (!authed()) return false;
    if (Date.now() > (session.expires_at || 0) - 60000) return refresh();
    return true;
  }
  function signOut() { saveSession(null); }

  // ---- vault (the user's data row) ---------------------------------------
  // Everything the app persists locally (the pfs: store) is mirrored as one
  // jsonb blob per user. Excludes account/session keys themselves.
  function localData() {
    const all = store.dump(); const out = {};
    Object.keys(all).forEach((k) => { if (k.indexOf('pfs:acct:') !== 0) out[k] = all[k]; });
    return out;
  }
  async function loadVault() {
    await ensureFresh();
    const res = await api('/rest/v1/vaults?select=data&user_id=eq.' + user().id, { auth: true, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP_' + res.status);
    const rows = await res.json().catch(() => []);
    if (rows && rows[0] && rows[0].data && typeof rows[0].data === 'object' && Object.keys(rows[0].data).length) {
      store.restore(rows[0].data); return true;      // cloud is the source of truth
    }
    return false;                                     // no cloud data yet
  }
  async function saveVault() {
    if (!authed()) return false;
    await ensureFresh();
    const body = { user_id: user().id, data: localData(), updated_at: new Date().toISOString() };
    const res = await api('/rest/v1/vaults', {
      method: 'POST', auth: true,
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body
    });
    if (!res.ok) throw new Error('HTTP_' + res.status);
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
    idx.push(Object.assign({ kind, id, ts: Date.now(), size: bytes.byteLength || bytes.length || 0 }, meta || {}));
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
  function fileIndex(kind) { return (store.get('cloud_files', []) || []).filter((f) => !kind || f.kind === kind); }

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
    }
  };

  PFS.account = {
    dept, cfg, configured, authed, user, signUp, signIn, signOut, refresh, loadVault, saveVault, putFile, getFile, deleteFile, fileIndex, _localData: localData, _saveSessionCfg: (o) => store.set(OVER, o) };
})(window);
