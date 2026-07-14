/* vault.js — the "smart personal vault": understand what a form field MEANS
 * and fill it from the user's saved details automatically.
 *
 * Two capabilities:
 *  1. matchKey(label) — map any Hebrew/English field label ("שם משפחה",
 *     "ת.ז.", "טלפון נייד", "last name"…) to a canonical key, so profile
 *     values fill detected fields even when the wording differs.
 *  2. extractFromText(ocrText) — best-effort pull of personal details from an
 *     OCR'd photo of an Israeli ID / license (ID number with checksum, names,
 *     birth date, phone), used to build the profile from a single photo.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  // strip punctuation/quotes/niqqud; keep Hebrew, Latin, digits
  function norm(s) {
    return String(s || '')
      .replace(/[֑-ׇ]/g, '')            // niqqud
      .replace(/["'`״׳:：׃.\-_/\\()\[\]]+/g, ' ')  // punctuation incl. gershayim
      .replace(/\s+/g, ' ')
      .trim().toLowerCase();
  }

  // canonical key → phrases that mean it (normalized "includes" match, longest wins)
  const SYN = {
    last_name:  ['שם משפחה', 'משפחה', 'last name', 'surname', 'family name'],
    first_name: ['שם פרטי', 'פרטי', 'first name', 'given name'],
    full_name:  ['שם מלא', 'שם משפחה ושם פרטי', 'שם פרטי ומשפחה', 'שם המבקש', 'שם העובד', 'שם הלקוח', 'full name', 'name', 'שם'],
    id:         ['תעודת זהות', 'מספר תעודת זהות', 'מספר זהות', 'ת ז', 'תז', 'מס זהות', 'id number', 'id'],
    birth_date: ['תאריך לידה', 'ת לידה', 'שנת לידה', 'date of birth', 'birth date'],
    phone:      ['טלפון נייד', 'מספר טלפון', 'טלפון', 'נייד', 'סלולרי', 'פלאפון', 'phone', 'mobile', 'cell'],
    email:      ['דואר אלקטרוני', 'דוא ל', 'אימייל', 'מייל', 'email', 'e mail'],
    address:    ['כתובת מגורים', 'כתובת מלאה', 'כתובת', 'רחוב', 'address', 'street'],
    city:       ['עיר', 'יישוב', 'ישוב', 'מקום מגורים', 'city', 'town'],
    zip:        ['מיקוד', 'zip', 'postal code'],
    date:       ['תאריך חתימה', 'תאריך מילוי', 'תאריך', 'date']
  };
  // precomputed [key, normalizedPhrase] sorted longest-first so "שם משפחה"
  // beats the generic "שם"
  const PAIRS = [];
  Object.keys(SYN).forEach((k) => SYN[k].forEach((p) => PAIRS.push([k, norm(p)])));
  PAIRS.sort((a, b) => b[1].length - a[1].length);

  function matchKey(label) {
    const n = norm(label);
    if (!n) return null;
    for (let i = 0; i < PAIRS.length; i++) {
      const [key, phrase] = PAIRS[i];
      if (n === phrase || n.indexOf(phrase) !== -1) return key;
    }
    return null;
  }

  // Israeli ID checksum (9 digits, Luhn-like)
  function checkIsraeliId(id) {
    const s = String(id || '').replace(/\D/g, '');
    if (s.length < 5 || s.length > 9) return false;
    const p = s.padStart(9, '0');
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      let d = +p[i] * ((i % 2) + 1);
      if (d > 9) d -= 9;
      sum += d;
    }
    return sum % 10 === 0;
  }

  /* Build {fieldKey: value} for detected fields from a profile's values.
   * Matching order: exact fieldKey === profile key, then canonical-key match
   * (both sides run through matchKey). `skipKeys` avoids refilling elements
   * that already exist (e.g. restored from the form's auto-memory).
   */
  function matchValues(fields, values, skipKeys) {
    const out = {};
    if (!fields || !fields.length || !values) return out;
    const skip = new Set(skipKeys || []);
    // canonical → value (first profile entry that maps to that canon wins)
    const canonVal = {};
    Object.keys(values).forEach((k) => {
      const c = matchKey(k);
      if (c && canonVal[c] === undefined && String(values[k]).trim()) canonVal[c] = values[k];
    });
    // derive full_name / first+last from each other when only one form exists
    if (canonVal.full_name === undefined && (canonVal.first_name || canonVal.last_name)) {
      canonVal.full_name = [canonVal.first_name, canonVal.last_name].filter(Boolean).join(' ');
    }
    // a plain "תאריך:" field means "today" unless the profile says otherwise
    // (birth-date fields map to birth_date, a different canon — never touched)
    if (canonVal.date === undefined) canonVal.date = new Date().toLocaleDateString('he-IL');
    fields.forEach((f) => {
      if (f.type === 'check' || skip.has(f.fieldKey)) return;
      if (values[f.fieldKey] !== undefined && String(values[f.fieldKey]).trim()) { out[f.fieldKey] = values[f.fieldKey]; return; }
      const c = matchKey(f.label) || matchKey(f.fieldKey);
      if (c && canonVal[c] !== undefined) out[f.fieldKey] = canonVal[c];
    });
    return out;
  }

  /* Best-effort extraction from OCR text of an Israeli ID / license photo. */
  function extractFromText(text) {
    const values = {};
    const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const whole = lines.join('\n');

    // ID number: any digit run of 7-9 that passes the checksum
    const digitRuns = whole.replace(/[^\d\n]/g, ' ').match(/\d{7,9}/g) || [];
    for (const d of digitRuns) { if (checkIsraeliId(d)) { values.id = d.padStart(9, '0'); break; } }

    // dates: earliest plausible year = birth date
    const dates = [];
    const dre = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/g;
    let m;
    while ((m = dre.exec(whole))) {
      let y = +m[3]; if (y < 100) y += y > 30 ? 1900 : 2000;
      if (y >= 1900 && y <= 2026) dates.push({ str: m[1] + '.' + m[2] + '.' + y, y });
    }
    if (dates.length) { dates.sort((a, b) => a.y - b.y); values.birth_date = dates[0].str; }

    // phone
    const ph = whole.replace(/[^\d\n+]/g, ' ').match(/05\d[ ]?\d{7}/);
    if (ph) values.phone = ph[0].replace(/\s+/g, '');

    // names: value on the label's line (after it) or on the following line
    function grab(labelRe) {
      for (let i = 0; i < lines.length; i++) {
        if (!labelRe.test(norm(lines[i]))) continue;
        // same line: text after the label words
        const after = lines[i].split(/[:：׃]/)[1];
        const clean = (s) => String(s || '').replace(/[^֐-׿a-zA-Z' -]/g, '').replace(/\s+/g, ' ').trim();
        const same = clean(after);
        if (same && same.length >= 2) return same;
        const next = clean(lines[i + 1]);
        if (next && next.length >= 2 && !matchKey(next)) return next;
      }
      return null;
    }
    const last = grab(/משפחה|surname|last name/);
    const first = grab(/פרטי|given|first name/);
    if (last) values.last_name = last;
    if (first) values.first_name = first;
    if (first || last) values.full_name = [first, last].filter(Boolean).join(' ');

    return values;
  }

  /* OCR a user-supplied image (File / canvas / dataURL) with the vendored
   * Tesseract (Hebrew). Returns raw text. */
  async function recognizeImage(src, onProgress) {
    const c = root.PFS_TESS;
    if (!root.Tesseract || !c) throw new Error('OCR_UNAVAILABLE');
    const worker = await root.Tesseract.createWorker('heb', 1, {
      workerPath: c.worker, corePath: c.core, langPath: c.lang, gzip: false,
      logger: (s) => { if (onProgress && s.progress != null) onProgress(s.progress); }
    });
    try {
      const { data } = await worker.recognize(src);
      return data && data.text || '';
    } finally { try { await worker.terminate(); } catch (e) {} }
  }

  PFS.vault = { matchKey, matchValues, extractFromText, recognizeImage, checkIsraeliId, norm };
})(window);
