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

  PFS.account = { cfg, configured, authed, user, signUp, signIn, signOut, refresh, loadVault, saveVault, _localData: localData, _saveSessionCfg: (o) => store.set(OVER, o) };
})(window);
