/* patterns.js — the learning engine: Fillo's single value-memory.
 *
 * Every successful export is a de-facto confirmation that the filled values
 * were right. This module records them per field-slot, so that:
 *   - a value that keeps recurring ("שם מוסד הלימודים") starts filling itself,
 *   - a slot that accumulates SEVERAL values (campus addresses) becomes a
 *     choice list the user picks from,
 * turning a repeatedly-filled form into a form generator.
 *
 * Design constraints (each one guards a real failure mode):
 *   - SLOT SAFETY: canonical slots only for the stable-organization whitelist.
 *     vault.matchKey is a substring matcher — 'Course name' resolves to
 *     full_name — so everything else is keyed by its exact normalized label,
 *     and person/date/amount canons are never learned at all.
 *   - SINGLE MEMORY: this store absorbs the old fields-panel `field_history`
 *     (one-time migration); the datalist and the choice dropdown must never
 *     disagree about what was learned.
 *   - NO SELF-REINFORCEMENT: learnFrom skips values that were auto-filled and
 *     left untouched — only human-typed/confirmed values gain weight.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const KEY = 'patterns';
  const CAP = 8;                     // values kept per slot
  const AUTO_MIN = 2;                // strictly: a value auto-fills only from n>=2

  // canons stable enough to share learning across differently-worded forms
  const CANON_WHITELIST = new Set([
    'institution_name', 'institution_phone', 'institution_address',
    'contact_person', 'business_id', 'business_name', 'health_fund',
    // benign personal canons — wording-stable, non-identity; keeping them
    // canon-keyed preserves the old cross-form autocomplete behaviour
    'phone', 'email', 'address', 'city', 'zip', 'house_no', 'occupation'
  ]);
  // never learned: per-person identity, dates (auto-today poisons), amounts
  const CANON_BLOCKLIST = new Set([
    'date', 'birth_date', 'amount', 'amount_words',
    'id', 'full_name', 'first_name', 'last_name'
  ]);

  const norm = (s) => (PFS.vault && PFS.vault.norm) ? PFS.vault.norm(s) : String(s || '').trim().toLowerCase();

  const load = () => PFS.store.get(KEY, {}) || {};
  const save = (o) => PFS.store.set(KEY, o);

  /* slotFor(labelOrField) → { slot, blocked } */
  function slotFor(field) {
    const label = typeof field === 'string' ? field : (field.label || field.fieldKey || '');
    const canon = PFS.vault && PFS.vault.matchKey ? (PFS.vault.matchKey(label) || PFS.vault.matchKey(field.fieldKey || '')) : null;
    if (canon && CANON_BLOCKLIST.has(canon)) return { slot: null, blocked: true };
    if (canon && CANON_WHITELIST.has(canon)) return { slot: canon, blocked: false };
    const n = norm(label);
    return { slot: n || null, blocked: !n };
  }

  function slotEntry(data, slot, label) {
    if (!data[slot]) data[slot] = { label: label || slot, values: [] };
    else if (label) data[slot].label = label;
    return data[slot];
  }

  function upsert(entry, value, { count = 0, pinned } = {}) {
    const v = String(value || '').trim();
    if (!v) return null;
    const nv = norm(v);
    let rec = entry.values.find((r) => norm(r.v) === nv);
    if (!rec) {
      rec = { v, n: 0, last: Date.now() };
      entry.values.push(rec);
    }
    rec.v = v;                        // keep the freshest spelling/casing
    rec.n += count;
    rec.last = Date.now();
    if (pinned !== undefined) rec.pinned = !!pinned;
    // eviction: pinned are exempt; lowest (n, recency) goes first
    const evictable = entry.values.filter((r) => !r.pinned);
    while (entry.values.length > CAP && evictable.length) {
      evictable.sort((a, b) => (a.n - b.n) || (a.last - b.last));
      const drop = evictable.shift();
      const i = entry.values.indexOf(drop);
      if (i >= 0) entry.values.splice(i, 1); else break;
    }
    return rec;
  }

  const sortOptions = (a, b) =>
    ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (b.n - a.n) || (b.last - a.last);

  /* learnFrom(fields, valuesMap, autoFilledKeys) — the ONLY place counts grow.
   * fields: detection fields (label+fieldKey+type); valuesMap: {fieldKey: text}
   * (overlay.currentValues()); autoFilledKeys: fieldKeys whose value came from
   * prefill and was never touched — skipped to avoid self-reinforcement. */
  function learnFrom(fields, valuesMap, autoFilledKeys) {
    if (!fields || !fields.length || !valuesMap) return 0;
    const skip = new Set(autoFilledKeys || []);
    const data = load();
    let learned = 0;
    const personVals = personNames();
    fields.forEach((f) => {
      if (!f || f.type === 'check') return;
      if (skip.has(f.fieldKey)) return;
      const val = valuesMap[f.fieldKey];
      if (val == null || !String(val).trim()) return;
      const { slot, blocked } = slotFor(f);
      if (blocked || !slot) return;
      // a person's name never belongs to a learnable slot (person canons are
      // blocklisted wholesale) — so a profile-name VALUE arriving here is a
      // leak (e.g. the historical 'שם הקורס' one), not a pattern
      if (personVals.has(norm(val))) return;
      upsert(slotEntry(data, slot, f.label), val, { count: 1 });
      learned++;
    });
    if (learned) save(data);
    return learned;
  }

  /* touch(labelOrField, value) — upsert with NO count (the old `remember`
   * timing: fires per input-commit; only export confirms enough to count). */
  function touch(field, value) {
    const { slot, blocked } = slotFor(field);
    if (blocked || !slot) return;
    const data = load();
    upsert(slotEntry(data, slot, typeof field === 'string' ? field : field.label), value, { count: 0 });
    save(data);
  }

  function optionsFor(field) {
    const { slot } = slotFor(field);
    if (!slot) return [];
    const e = load()[slot];
    return e ? e.values.slice().sort(sortOptions) : [];
  }

  /* suggest(field) → {mode:'auto', value} | {mode:'choices', options} | null */
  function suggest(field) {
    if (field && field.type === 'check') return null;
    const opts = optionsFor(field);
    if (!opts.length) return null;
    if (opts.length === 1) {
      return (opts[0].n >= AUTO_MIN || opts[0].pinned)
        ? { mode: 'auto', value: opts[0].v }
        : null;
    }
    return { mode: 'choices', options: opts };
  }

  function removeValue(field, value) {
    const { slot } = slotFor(field);
    if (!slot) return false;
    const data = load();
    const e = data[slot];
    if (!e) return false;
    const nv = norm(value);
    const i = e.values.findIndex((r) => norm(r.v) === nv);
    if (i < 0) return false;
    e.values.splice(i, 1);
    if (!e.values.length) delete data[slot];
    save(data);
    return true;
  }

  function pin(field, value, on = true) {
    const { slot } = slotFor(field);
    if (!slot) return false;
    const data = load();
    const e = data[slot];
    if (!e) return false;
    const nv = norm(value);
    const rec = e.values.find((r) => norm(r.v) === nv);
    if (!rec) return false;
    rec.pinned = !!on;
    save(data);
    return true;
  }

  // management-card variant: remove by the STORED slot key (no re-resolution)
  function removeAt(slot, value) {
    const data = load();
    const e = data[slot];
    if (!e) return false;
    const nv = norm(value);
    const i = e.values.findIndex((r) => norm(r.v) === nv);
    if (i < 0) return false;
    e.values.splice(i, 1);
    if (!e.values.length) delete data[slot];
    save(data);
    return true;
  }

  // normalized person-name values from ALL saved profiles
  function personNames() {
    const out = new Set();
    try {
      (PFS.store.get('profiles', []) || []).forEach((p) => {
        ['שם מלא', 'שם פרטי', 'שם משפחה'].forEach((k) => {
          const v = p.values && p.values[k];
          if (v && String(v).trim().length >= 2) out.add(norm(v));
        });
      });
    } catch (e) {}
    return out;
  }

  /* purgePersonValues() — heal slots poisoned before the bare-'שם' guard:
   * remove any learned value that equals a profile person-name. Returns the
   * number removed (app runs this once per boot). */
  function purgePersonValues() {
    const pv = personNames();
    if (!pv.size) return 0;
    const data = load();
    let removed = 0;
    Object.keys(data).forEach((slot) => {
      const e = data[slot];
      e.values = e.values.filter((r) => {
        const bad = pv.has(norm(r.v));
        if (bad) removed++;
        return !bad;
      });
      if (!e.values.length) delete data[slot];
    });
    if (removed) save(data);
    return removed;
  }

  const all = () => load();
  function clear() { PFS.store.remove(KEY); }

  // one-time migration: absorb the old per-canon field_history (values only,
  // n:1 — they were remembered, not export-confirmed) then delete it.
  (function migrate() {
    try {
      const old = PFS.store.get('field_history', null);
      if (!old) return;
      const data = load();
      Object.keys(old).forEach((canon) => {
        if (CANON_BLOCKLIST.has(canon)) return;
        const slot = CANON_WHITELIST.has(canon) ? canon : canon; // keep original key
        (old[canon] || []).forEach((v) => upsert(slotEntry(data, slot, canon), v, { count: 1 }));
      });
      save(data);
      PFS.store.remove('field_history');
    } catch (e) { /* migration is best-effort */ }
  })();

  PFS.patterns = { learnFrom, touch, optionsFor, suggest, removeValue, removeAt, pin, all, clear, slotFor, purgePersonValues, AUTO_MIN };
})(window);
