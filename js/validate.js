/* validate.js — one place that judges whether a field value looks right.
 * The fields panel uses it for live per-field feedback (red border + tooltip),
 * and the exporter uses it for a last-mile sweep over every placed value, so a
 * mistyped ID / phone / e-mail gets caught before it lands on an official form
 * — the single most common and costly bureaucratic error. Purely local, no I/O.
 *
 * field(canon, value) → { ok: boolean, msg: string }
 *   `canon` is a vault canonical key (id, business_id, email, phone, date,
 *   birth_date). Unknown canons and empty values are always ok — this only
 *   flags a value that is present AND clearly malformed, never nags mid-typing.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  // dd/mm/yyyy → {y,mo,d,valid} (calendar-correct, leap-year aware) or null.
  function parseDmy(v) {
    const m = String(v).trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (!m) return null;
    const d = +m[1], mo = +m[2], y = +m[3];
    const leap = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const valid = mo >= 1 && mo <= 12 && d >= 1 && d <= dim[mo - 1] && y >= 1900 && y <= 2100;
    return { y, mo, d, valid };
  }

  function field(canon, value) {
    const v = String(value == null ? '' : value).trim();
    if (!v) return { ok: true, msg: '' };
    const idCheck = (PFS.vault && PFS.vault.checkIsraeliId) || (() => true);

    if (canon === 'id' || canon === 'business_id') {
      const digits = v.replace(/\D/g, '');
      // don't judge until enough digits are typed to be a real attempt
      if (digits.length >= 5 && !idCheck(digits)) {
        return { ok: false, msg: canon === 'business_id'
          ? 'מספר העוסק / ח.פ לא עובר ביקורת ספרת ביקורת — בדקו הקלדה'
          : 'מספר תעודת הזהות לא עובר ביקורת ספרת ביקורת — בדקו הקלדה' };
      }
      return { ok: true, msg: '' };
    }
    if (canon === 'email') {
      const bad = !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
      return { ok: !bad, msg: bad ? 'כתובת אימייל לא תקינה — בדקו הקלדה' : '' };
    }
    if (canon === 'phone') {
      const digits = v.replace(/\D/g, '');
      // Israeli mobile/landline: 9–10 digits with a leading 0
      const bad = digits.length >= 6 && !/^0\d{8,9}$/.test(digits);
      return { ok: !bad, msg: bad ? 'מספר טלפון לא תקין — בדקו הקלדה' : '' };
    }
    if (canon === 'birth_date' || canon === 'date') {
      const p = parseDmy(v);
      if (p) {
        const future = canon === 'birth_date' && p.valid && new Date(p.y, p.mo - 1, p.d) > new Date();
        const bad = !p.valid || future;
        return { ok: !bad, msg: bad ? (future ? 'תאריך לידה עתידי — בדקו' : 'תאריך לא תקין — בדקו יום/חודש/שנה') : '' };
      }
      // a long digit run that isn't a proper dd/mm/yyyy is a format mistake
      if (v.replace(/\D/g, '').length >= 8) return { ok: false, msg: 'פורמט תאריך: יום/חודש/שנה (למשל 15/03/1990)' };
      return { ok: true, msg: '' };
    }
    return { ok: true, msg: '' };
  }

  // Sweep placed values → the fields that look malformed. `items` is an array
  // of { key, value, label } (label defaults to key for the warning text).
  // Uses vault.matchKey to turn a free fieldKey into a canonical category.
  function scan(items) {
    const out = [];
    const mk = (PFS.vault && PFS.vault.matchKey) || (() => null);
    (items || []).forEach((it) => {
      if (!it || !it.value) return;
      const canon = mk(it.key) || it.key;
      const r = field(canon, it.value);
      if (!r.ok) out.push({ key: it.key, label: it.label || it.key, value: it.value, msg: r.msg });
    });
    return out;
  }

  PFS.validate = { field, scan, parseDmy };
})(window);
