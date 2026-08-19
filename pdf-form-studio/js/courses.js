/* courses.js — the course binder: who submitted what.
 *
 * A course groups a student list with the set of forms each student must
 * submit. Every successful export auto-marks the matching cell (the exported
 * form's fingerprint identifies the FORM; a student's ת"ז or full name found
 * among the filled values identifies WHO). The grid answers, at a glance, the
 * question that otherwise lives in a side spreadsheet: "מי חסר מה?".
 *
 * Stored under PFS.store('courses'):
 *   [{ id, name,
 *      students: [{ name, tz, phone }],
 *      forms:    [{ name, fp, libId }],       // fp = doc fingerprint, libId = library record
 *      subs:     { studentKey: { formName: ts } } }]
 * studentKey = tz when present (stable), else normalized name.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const KEY = 'courses';

  const norm = (s) => (PFS.vault ? PFS.vault.norm(s) : String(s || '').trim().toLowerCase());
  const load = () => PFS.store.get(KEY, []) || [];
  const save = (list) => PFS.store.set(KEY, list);
  const uid = () => 'c' + Math.random().toString(36).slice(2, 9);

  const studentKey = (st) => (st.tz && String(st.tz).trim()) ? String(st.tz).trim() : norm(st.name);

  function all() { return load(); }
  function get(id) { return load().find((c) => c.id === id) || null; }

  function create(name) {
    const list = load();
    const c = { id: uid(), name: String(name || 'קורס חדש').trim(), students: [], forms: [], subs: {} };
    list.push(c); save(list);
    return c;
  }
  function remove(id) { save(load().filter((c) => c.id !== id)); }
  function update(course) {
    const list = load();
    const i = list.findIndex((c) => c.id === course.id);
    if (i >= 0) { list[i] = course; save(list); return true; }
    return false;
  }

  /* addStudents(courseId, rows) — rows: [{name, tz, phone}]; dedups by key */
  function addStudents(courseId, rows) {
    const c = get(courseId); if (!c) return 0;
    let added = 0;
    rows.forEach((r) => {
      const name = String(r.name || '').trim();
      if (!name) return;
      const st = { name, tz: String(r.tz || '').trim(), phone: String(r.phone || '').trim() };
      const k = studentKey(st);
      if (c.students.some((x) => studentKey(x) === k)) return;
      c.students.push(st); added++;
    });
    if (added) update(c);
    return added;
  }
  function removeStudent(courseId, key) {
    const c = get(courseId); if (!c) return;
    c.students = c.students.filter((s) => studentKey(s) !== key);
    delete c.subs[key];
    update(c);
  }

  function addForm(courseId, form) {   // {name, fp?, libId?}
    const c = get(courseId); if (!c) return false;
    if (c.forms.some((f) => (form.fp && f.fp === form.fp) || f.name === form.name)) return false;
    c.forms.push({ name: form.name, fp: form.fp || null, libId: form.libId || null });
    update(c);
    return true;
  }
  function removeForm(courseId, formName) {
    const c = get(courseId); if (!c) return;
    c.forms = c.forms.filter((f) => f.name !== formName);
    Object.keys(c.subs).forEach((k) => { if (c.subs[k]) delete c.subs[k][formName]; });
    update(c);
  }

  function setSubmitted(courseId, key, formName, on) {
    const c = get(courseId); if (!c) return;
    c.subs[key] = c.subs[key] || {};
    if (on) c.subs[key][formName] = Date.now();
    else delete c.subs[key][formName];
    update(c);
  }
  const isSubmitted = (c, key, formName) => !!(c.subs[key] && c.subs[key][formName]);

  function missingCount(c) {
    let n = 0;
    c.students.forEach((s) => c.forms.forEach((f) => { if (!isSubmitted(c, studentKey(s), f.name)) n++; }));
    return n;
  }

  /* ===== the course CASE FILE: deal-level facts ledger =====
   *
   * patterns.js deliberately refuses to learn dates, amounts and course names
   * GLOBALLY — one course's start date poisons the next course's forms. But
   * inside a single course those exact values are constants, retyped dozens of
   * times a week. The ledger scopes them to the course: harvested passively
   * from every export made in a course context, consumed by prefill for ANY
   * form — including forms never seen before, because resolution is by
   * MEANING (vault canons + date direction), not by template.
   *
   * course.facts = { factKey: { v, n, last } }
   * factKey ∈ course_name | branch | course_hours | amount |
   *           course_start | course_end   (bare 'date' fields never touch it)
   */
  const FACT_CANONS = new Set(['course_name', 'branch', 'course_hours', 'amount']);

  /* factKeyFor(labelOrField) → ledger key | null */
  function factKeyFor(field) {
    const label = typeof field === 'string' ? field : (field.label || field.fieldKey || '');
    const V = PFS.vault;
    const canon = V.matchKey(label);
    if (canon && FACT_CANONS.has(canon)) return canon;
    // period dates are deal facts; a bare "תאריך" is a per-form variable.
    // Forms word these as תאריך or מועד ("מועד סיום הלימודים", "תאריך פתיחה")
    if (canon === 'date' || /תאריך|מועד/.test(label)) {
      if (/סיום/.test(label)) return 'course_end';
      if (/תחילת|התחלה|פתיחה/.test(label)) return 'course_start';
    }
    return null;
  }

  function setFact(courseId, factKey, value) {
    const c = get(courseId); if (!c) return false;
    const v = String(value == null ? '' : value).trim();
    if (!v) return false;
    c.facts = c.facts || {};
    const cur = c.facts[factKey];
    if (cur && norm(cur.v) === norm(v)) { cur.v = v; cur.n++; cur.last = Date.now(); }
    else c.facts[factKey] = { v, n: 1, last: Date.now() };
    update(c);
    return true;
  }
  function removeFact(courseId, factKey) {
    const c = get(courseId); if (!c || !c.facts) return;
    delete c.facts[factKey];
    update(c);
  }
  function getFacts(courseId) {
    const c = get(courseId);
    return (c && c.facts) || {};
  }

  /* harvestFacts(courseId, fields, valuesMap) — the passive population hook:
   * runs on every export made while this course is active. Any filled value
   * whose label resolves to a fact key is written into the ledger (freshest
   * spelling wins, n counts confirmations). Returns how many were absorbed. */
  function harvestFacts(courseId, fields, valuesMap) {
    if (!courseId || !fields || !valuesMap) return 0;
    let n = 0;
    fields.forEach((f) => {
      if (!f || f.type === 'check') return;
      const val = valuesMap[f.fieldKey];
      if (val == null || !String(val).trim()) return;
      const k = factKeyFor(f);
      if (k && setFact(courseId, k, val)) n++;
    });
    return n;
  }

  /* factFill(courseId, fields) → { fieldKey: value } for the prefill pass:
   * resolves every detected field by meaning against this course's ledger.
   * amount_words fields derive from the course price via numwords. */
  function factFill(courseId, fields) {
    const out = {};
    const facts = getFacts(courseId);
    if (!fields || !Object.keys(facts).length) return out;
    const V = PFS.vault;
    fields.forEach((f) => {
      if (!f || f.type === 'check') return;
      const k = factKeyFor(f);
      if (k && facts[k]) { out[f.fieldKey] = facts[k].v; return; }
      if (facts.amount && V.matchKey(f.label) === 'amount_words' && PFS.numwords) {
        const num = parseFloat(String(facts.amount.v).replace(/[^\d.]/g, ''));
        if (isFinite(num)) out[f.fieldKey] = PFS.numwords.shekels(num);
      }
    });
    return out;
  }

  /* recordExport(fp, values) — called after every successful export.
   * Finds courses containing a form with this fingerprint, then looks for a
   * registered student inside the filled values (ת"ז beats name — 9 digits
   * are unambiguous; a name must match a whole filled value, not a substring).
   * Returns [{course, student, form}] for the marks it made. */
  function recordExport(fp, values) {
    if (!fp || !values) return [];
    const vals = Object.values(values).map((v) => String(v || '').trim()).filter(Boolean);
    if (!vals.length) return [];
    const marks = [];
    load().forEach((c) => {
      const form = c.forms.find((f) => f.fp === fp);
      if (!form) return;
      const st = c.students.find((s) =>
        (s.tz && vals.some((v) => v.replace(/\D/g, '') === s.tz.replace(/\D/g, '') && s.tz.replace(/\D/g, '').length >= 5)) ||
        vals.some((v) => norm(v) === norm(s.name))
      );
      if (!st) return;
      const k = studentKey(st);
      if (!isSubmitted(c, k, form.name)) {
        setSubmitted(c.id, k, form.name, true);
        marks.push({ course: c, student: st, form });
      }
    });
    return marks;
  }

  /* parseStudentRows(text) — reuse the merge parser + vault mapping to turn a
   * pasted spreadsheet (with or without a header row) into student rows. */
  function parseStudentRows(text) {
    const parsed = PFS.merge.parseCSV(text);
    if (!parsed.records.length && !parsed.headers.length) return [];
    const V = PFS.vault;
    const canonOf = (h) => V.matchKey(h);
    const headerCanons = parsed.headers.map(canonOf);
    const looksLikeHeader = headerCanons.some((c) => c === 'full_name' || c === 'first_name' || c === 'id' || c === 'phone');
    const rows = [];
    if (looksLikeHeader) {
      const col = (canons) => parsed.headers.find((h, i) => canons.includes(headerCanons[i]));
      const nameH = col(['full_name', 'first_name']);
      const lastH = col(['last_name']);
      const tzH = col(['id']);
      const phoneH = col(['phone']);
      parsed.records.forEach((r) => rows.push({
        // separate first/last columns join into one display name
        name: [r[nameH], lastH ? r[lastH] : ''].filter(Boolean).join(' ').trim(),
        tz: tzH ? r[tzH] : '', phone: phoneH ? r[phoneH] : ''
      }));
    } else {
      // no header: treat every line as cells; name = first non-numeric cell,
      // tz = first 8-9 digit cell, phone = first 05x/0x-prefixed cell
      const allRows = [parsed.headers, ...parsed.records.map((r) => parsed.headers.map((h) => r[h]))];
      allRows.forEach((cells) => {
        const cs = cells.map((x) => String(x || '').trim()).filter(Boolean);
        if (!cs.length) return;
        const tz = cs.find((x) => /^\d{8,9}$/.test(x.replace(/\D/g, '')) && x.replace(/\D/g, '').length >= 8 && !/^05/.test(x.replace(/\D/g, '')));
        const phone = cs.find((x) => /^0\d{1,2}[- ]?\d{7}$/.test(x.replace(/\s/g, '')));
        const name = cs.find((x) => /[א-תa-zA-Z]{2,}/.test(x) && x !== phone);
        if (name) rows.push({ name, tz: tz || '', phone: phone || '' });
      });
    }
    return rows.filter((r) => r.name);
  }

  PFS.courses = {
    all, get, create, remove, update,
    addStudents, removeStudent, addForm, removeForm,
    setSubmitted, isSubmitted, missingCount, recordExport,
    parseStudentRows, studentKey,
    factKeyFor, setFact, removeFact, getFacts, harvestFacts, factFill
  };
})(window);
