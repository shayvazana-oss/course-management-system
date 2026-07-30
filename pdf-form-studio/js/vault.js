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

  // canonical key → phrases that mean it (normalized "includes" match, longest
  // wins). Hebrew (many real-world variants) + English + Arabic — no other
  // Hebrew filler auto-maps Arabic labels, and ~20% of Israeli forms need it.
  const SYN = {
    last_name:  ['שם משפחה', 'שם המשפחה', 'משפחה', 'שם משפחה באנגלית', 'last name', 'surname', 'family name', 'اسم العائلة', 'العائلة', 'اسم العائله'],
    first_name: ['שם פרטי', 'השם הפרטי', 'פרטי', 'first name', 'given name', 'الاسم الشخصي', 'الاسم الأول', 'الاسم'],
    full_name:  ['שם מלא', 'שם משפחה ושם פרטי', 'שם פרטי ומשפחה', 'שם המבקש', 'שם המבוטח', 'שם העובד', 'שם הלקוח', 'שם התלמיד', 'שם ההורה', 'שם וחתימה', 'full name', 'name', 'שם', 'الاسم الكامل', 'الاسم الرباعي'],
    id:         ['תעודת זהות', 'מספר תעודת זהות', 'מספר זהות', 'מס תעודת זהות', 'ת ז', 'תז', 'ת.ז', 'מס זהות', 'מספר ת ז', 'זהות', 'מספר זיהוי', 'id number', 'national id', 'id', 'رقم الهوية', 'الهوية', 'رقم هوية', 'بطاقة الهوية'],
    birth_date: ['תאריך לידה', 'ת לידה', 'שנת לידה', 'תאריך הלידה', 'date of birth', 'birth date', 'dob', 'تاريخ الميلاد', 'تاريخ الولادة', 'الميلاد'],
    phone:      ['טלפון נייד', 'מספר טלפון', 'מס טלפון', 'טלפון', 'נייד', 'סלולרי', 'סלולארי', 'פלאפון', 'מספר נייד', 'טל', 'phone', 'mobile', 'cell', 'tel', 'رقم الهاتف', 'الهاتف', 'الجوال', 'هاتف نقال', 'موبايل'],
    // 'כתובת דואל' (len 10) is listed so it out-ranks the address phrase 'כתובת'
    email:      ['דואר אלקטרוני', 'דוא ל', 'אימייל', 'מייל', 'כתובת מייל', 'כתובת דואל', 'דואל', 'email', 'e mail', 'البريد الالكتروني', 'الايميل', 'بريد الكتروني'],
    address:    ['כתובת מגורים', 'כתובת מלאה', 'כתובת', 'מען', 'רחוב ומספר', 'רחוב', 'address', 'street', 'العنوان', 'عنوان السكن', 'الشارع'],
    house_no:   ['מספר בית', 'מס בית', 'בית מספר', 'house number', 'house no', 'رقم البيت', 'رقم المنزل'],
    city:       ['עיר', 'יישוב', 'ישוב', 'עיר מגורים', 'מקום מגורים', 'שם היישוב', 'city', 'town', 'المدينة', 'البلدة', 'مكان السكن'],
    zip:        ['מיקוד', 'מיקוד דואר', 'zip', 'zip code', 'postal code', 'الرمز البريدي'],
    occupation: ['מקצוע', 'עיסוק', 'משלח יד', 'תפקיד', 'occupation', 'profession', 'المهنة', 'الوظيفة'],
    gender:     ['מין', 'מגדר', 'sex', 'gender', 'الجنس'],
    // amount_words must out-rank amount (longer phrase wins in matchKey)
    amount_words: ['סכום במילים', 'סכום במלים', 'הסכום במילים', 'amount in words', 'sum in words'],
    amount:     ['סכום בשח', 'סכום', 'סך הכל', 'סך הכול', 'סה״כ', 'סהכ', 'amount', 'total', 'sum', 'المبلغ', 'المجموع'],
    // Israeli business/tax forms (101, VAT): company / dealer numbers use the
    // SAME 9-digit checksum as ת.ז, so they can be validated the same way.
    business_id:   ['מספר עוסק מורשה', 'עוסק מורשה', 'עוסק פטור', 'מספר עוסק', 'מספר חברה', 'מספר תאגיד', 'ח.פ', 'ח״פ', 'חפ', 'company number', 'vat number', 'business number', 'business id'],
    business_name: ['שם העסק', 'שם החברה', 'שם התאגיד', 'שם עסק', 'business name', 'company name'],
    // organization/institution fields — training providers, colleges, schools
    // (the longer phrases out-rank the generic phone/address/name canons)
    institution_name:    ['שם מוסד ההכשרה', 'שם מוסד הלימודים', 'שם המוסד', 'שם המכללה', 'שם מוסד', 'מוסד ההכשרה', 'מוסד הלימודים', 'שם בית הספר', 'institution name', 'college name', 'school name'],
    institution_phone:   ['טלפון מוסד ההכשרה', 'טלפון המוסד', 'טלפון המכללה', 'טלפון מוסד', 'טלפון בית הספר', 'institution phone'],
    institution_address: ['כתובת מוסד ההכשרה', 'כתובת המוסד', 'כתובת המכללה', 'כתובת מוסד', 'כתובת בית הספר', 'institution address'],
    contact_person:      ['שם איש קשר', 'איש קשר', 'איש הקשר', 'פרטי איש קשר', 'שם איש הקשר', 'contact person', 'contact name'],
    marital_status: ['מצב משפחתי', 'מצב אישי', 'marital status', 'الحالة الاجتماعية'],
    health_fund: ['קופת חולים', 'קופ״ח', 'קופח', 'קופה', 'health fund', 'hmo', 'صندوق المرضى'],
    date:       ['תאריך חתימה', 'תאריך מילוי', 'תאריך הבקשה', 'תאריך', 'date', 'today', 'التاريخ', 'تاريخ']
  };

  // option-value dictionaries for single-choice questions: canonical value →
  // the words that denote it, so a stored gender ("זכר" / "ז" / "male") and a
  // form option ("○ זכר") resolve to the same value across languages.
  const GENDER = {
    male:   ['זכר', 'ז', 'male', 'm', 'man', 'ذكر'],
    female: ['נקבה', 'נ', 'female', 'f', 'woman', 'أنثى', 'انثى']
  };
  // marital status — Form 101 and most Israeli forms ask it as a radio group
  const MARITAL = {
    single:    ['רווק', 'רווקה', 'single', 'أعزب', 'عزباء'],
    married:   ['נשוי', 'נשואה', 'married', 'متزوج', 'متزوجة'],
    divorced:  ['גרוש', 'גרושה', 'divorced', 'مطلق', 'مطلقة'],
    widowed:   ['אלמן', 'אלמנה', 'widowed', 'أرمل', 'أرملة'],
    separated: ['פרוד', 'פרודה', 'separated', 'منفصل', 'منفصلة'],
    commonlaw: ['ידוע בציבור', 'ידועה בציבור', 'common law']
  };
  // health funds (קופת חולים) — Form 101 and health forms ask this
  const HEALTH = {
    clalit:   ['כללית', 'שירותי בריאות כללית', 'clalit'],
    maccabi:  ['מכבי', 'מכבי שירותי בריאות', 'maccabi'],
    meuhedet: ['מאוחדת', 'meuhedet'],
    leumit:   ['לאומית', 'leumit']
  };
  // single-choice categories: canonical field → its option-value dictionary
  const CHOICE_CATS = { gender: GENDER, marital_status: MARITAL, health_fund: HEALTH };
  // which canonical value (if any) a free string denotes in a dictionary —
  // exact or whole-word match on the normalized form (so "ז" won't hit "מזכיר")
  function valInDict(str, dict) {
    const n = norm(str);
    if (!n) return null;
    for (const key of Object.keys(dict)) {
      for (const syn of dict[key]) {
        const s = norm(syn);
        if (n === s || (' ' + n + ' ').indexOf(' ' + s + ' ') !== -1) return key;
      }
    }
    return null;
  }
  // precomputed [key, normalizedPhrase] sorted longest-first so "שם משפחה"
  // beats the generic "שם"
  const PAIRS = [];
  Object.keys(SYN).forEach((k) => SYN[k].forEach((p) => PAIRS.push([k, norm(p)])));
  PAIRS.sort((a, b) => b[1].length - a[1].length);

  // Institution/contact phrases like 'מוסד ההכשרה' appear INSIDE longer labels
  // that mean something else entirely ('שם מנהל מוסד ההכשרה או מי מטעמו' is a
  // PERSON, section headings quote the institution too). For these canons a
  // substring hit only counts when the label is essentially the phrase itself.
  const TIGHT_CANONS = new Set(['institution_name', 'institution_phone', 'institution_address', 'contact_person']);
  // the bare 'שם'/'name' synonyms are radioactive: as substrings they claim
  // ANY "שם ה<something>" label — 'שם הקורס' got filled with the user's own
  // name. They may only match when the label IS the word (plus punctuation).
  const ULTRA_GENERIC = new Set([norm('שם'), 'name', norm('الاسم')]);
  function matchKey(label) {
    const n = norm(label);
    if (!n) return null;
    for (let i = 0; i < PAIRS.length; i++) {
      const [key, phrase] = PAIRS[i];
      if (n === phrase || n.indexOf(phrase) !== -1) {
        if (ULTRA_GENERIC.has(phrase) && n.length > phrase.length + 2) continue;
        if (TIGHT_CANONS.has(key) && n.length > phrase.length + 8) continue;
        return key;
      }
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
  function matchValues(fields, values, skipKeys, opts) {
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
    // the reverse: a saved full name fills separate first/last fields
    // (Hebrew order: first token = given name, the rest = surname)
    if (canonVal.full_name && (canonVal.first_name === undefined || canonVal.last_name === undefined)) {
      const toks = String(canonVal.full_name).trim().split(/\s+/);
      if (toks.length >= 2) {
        if (canonVal.first_name === undefined) canonVal.first_name = toks[0];
        if (canonVal.last_name === undefined) canonVal.last_name = toks.slice(1).join(' ');
      }
    }
    // one combined address fills separate עיר / מספר בית / מיקוד fields too
    if (canonVal.address) {
      const pa = parseAddress(canonVal.address);
      ['city', 'house_no', 'zip'].forEach((k) => { if (canonVal[k] === undefined && pa[k]) canonVal[k] = pa[k]; });
    }
    // a plain "תאריך:" field means "today" unless the profile says otherwise
    // (birth-date fields map to birth_date, a different canon — never touched)
    if (canonVal.date === undefined) canonVal.date = new Date().toLocaleDateString('he-IL');
    // normalized-label fallback: when no canonical meaning is known for a key,
    // an identically-worded label still matches (a quote and its appendix
    // usually share field wording — that carry-over must work even for terms
    // the synonym map has never heard of, in any language).
    const normVal = {};
    Object.keys(values).forEach((k) => {
      const nk = norm(k);
      if (nk && normVal[nk] === undefined && String(values[k]).trim()) normVal[nk] = values[k];
    });
    fields.forEach((f) => {
      if (f.type === 'check' || skip.has(f.fieldKey)) return;
      if (values[f.fieldKey] !== undefined && String(values[f.fieldKey]).trim()) { out[f.fieldKey] = values[f.fieldKey]; return; }
      // exact wording BEFORE synonyms: when both forms literally say
      // "שם מנהל מוסד ההכשרה", that beats a fuzzy canon guess (whose
      // substring matching can misread an institution name as a person's)
      const nv = normVal[norm(f.label)] !== undefined ? normVal[norm(f.label)] : normVal[norm(f.fieldKey)];
      if (nv !== undefined) { out[f.fieldKey] = nv; return; }
      if (opts && opts.labelOnly) return;   // carry-over: no synonym guessing
      const c = matchKey(f.label) || matchKey(f.fieldKey);
      if (c && canonVal[c] !== undefined) out[f.fieldKey] = canonVal[c];
    });
    return out;
  }

  /* Best-effort split of one Israeli address string into its parts, so a
   * profile that stores only a combined "כתובת" can still fill separate
   * עיר / מספר בית / מיקוד fields. Heuristic, tolerant of missing pieces:
   *   "רחוב הרצל 15, תל אביב 6100000" → {street:'הרצל', house_no:'15',
   *    city:'תל אביב', zip:'6100000', address:<original>}
   */
  function parseAddress(s) {
    const out = {};
    const str = String(s || '').trim();
    if (!str) return out;
    out.address = str;
    // zip: an Israeli postcode is 5 or 7 digits; take the last such run
    const zips = str.match(/\b(\d{7}|\d{5})\b/g);
    if (zips) out.zip = zips[zips.length - 1];
    // house number: first digit run (optionally a Hebrew apartment letter).
    // A trailing \b can't follow a Hebrew letter (Hebrew isn't a \w char), so a
    // negative lookahead for digit/Hebrew is used instead — otherwise the letter
    // in "7א" is silently dropped.
    const hm = str.match(/\b(\d{1,4}[א-ת]?)(?![\dא-ת])/);
    if (hm && hm[1] !== out.zip) out.house_no = hm[1];
    const parts = str.split(/[,،]/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      // "<street + house>, <city> [zip]"
      let cityPart = parts.slice(1).join(' ');
      if (out.zip) cityPart = cityPart.split(out.zip).join(' ');
      cityPart = cityPart.replace(/\d+/g, ' ').replace(/\s+/g, ' ').trim();
      if (cityPart) out.city = cityPart;
      const street = parts[0].replace(/\b\d{1,4}[א-ת]?(?![\dא-ת])/, ' ').replace(/^(רחוב|רח['׳]?|שדרות|שד['׳]?|שכ['׳]?|דרך)\s+/, '').replace(/\s+/g, ' ').trim();
      if (street) out.street = street;
    }
    return out;
  }

  /* Classify a ticked option so the app can remember the choice for next time
   * ("○ זכר" ticked → {canon:'gender', value:'זכר'}). null when the option
   * isn't a known single-choice value. */
  function classifyChoice(label) {
    for (const cat of Object.keys(CHOICE_CATS)) {
      if (valInDict(label, CHOICE_CATS[cat])) return { canon: cat, value: String(label).trim() };
    }
    return null;
  }

  /* Extend memory to SELECTIONS: which detected check/radio options should be
   * auto-ticked from the saved details. Returns {fieldKey: true}.
   *  - gender options match the saved gender across languages ("מין: זכר" →
   *    tick "○ זכר"), never the opposite option;
   *  - any option whose text equals a saved value is ticked (city, marital
   *    status, etc. that the user stored verbatim).
   * At most one option per radio group is chosen (they're mutually exclusive).
   */
  function matchChecks(fields, values, skipKeys) {
    const out = {};
    if (!fields || !fields.length || !values) return out;
    const skip = new Set(skipKeys || []);
    const canonVal = {};
    Object.keys(values).forEach((k) => {
      const c = matchKey(k);
      if (c && canonVal[c] === undefined && String(values[k]).trim()) canonVal[c] = values[k];
    });
    // resolve each single-choice category's saved value to its canonical key
    const storedKey = {};
    Object.keys(CHOICE_CATS).forEach((cat) => { if (canonVal[cat]) storedKey[cat] = valInDict(canonVal[cat], CHOICE_CATS[cat]); });
    // every saved value, normalized, for a verbatim option match (min length 2
    // so a stray letter can't tick unrelated boxes)
    const storedNorms = new Set();
    Object.keys(values).forEach((k) => { const v = norm(values[k]); if (v && v.length >= 2) storedNorms.add(v); });
    const usedGroup = new Set();
    fields.forEach((f) => {
      if (f.type !== 'check' || skip.has(f.fieldKey)) return;
      const nlabel = norm(f.label);
      let hit = nlabel.length >= 2 && storedNorms.has(nlabel);
      if (!hit) {
        for (const cat of Object.keys(CHOICE_CATS)) {
          const ov = valInDict(f.label, CHOICE_CATS[cat]);
          if (ov && storedKey[cat] && ov === storedKey[cat]) { hit = true; break; }
        }
      }
      if (!hit) return;
      if (f.group) { if (usedGroup.has(f.group)) return; usedGroup.add(f.group); }
      out[f.fieldKey] = true;
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

  PFS.vault = { matchKey, matchValues, matchChecks, classifyChoice, parseAddress, extractFromText, recognizeImage, checkIsraeliId, norm };
})(window);
