/* numwords.js — Hebrew number-to-words for the "סכום במילים" field.
 * Israeli cheques/official forms want the amount written out in words; doing
 * it by hand is slow and error-prone. Supports 0..999,999 (covers realistic
 * shekel amounts); larger values fall back to digits. Masculine forms, since
 * "שקל" is masculine. Formal joining: a "ו" precedes the final component.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const ONES = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה'];
  const TEENS = ['', 'אחד עשר', 'שנים עשר', 'שלושה עשר', 'ארבעה עשר', 'חמישה עשר', 'שישה עשר', 'שבעה עשר', 'שמונה עשר', 'תשעה עשר'];
  const TENS = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים'];
  // feminine forms for agorot (אגורה is feminine): 1..99
  const ONES_F = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע'];
  const TEENS_F = ['', 'אחת עשרה', 'שתים עשרה', 'שלוש עשרה', 'ארבע עשרה', 'חמש עשרה', 'שש עשרה', 'שבע עשרה', 'שמונה עשרה', 'תשע עשרה'];
  const HUNDREDS = ['', 'מאה', 'מאתיים', 'שלוש מאות', 'ארבע מאות', 'חמש מאות', 'שש מאות', 'שבע מאות', 'שמונה מאות', 'תשע מאות'];
  const CONSTRUCT = ['', '', '', 'שלושת', 'ארבעת', 'חמשת', 'ששת', 'שבעת', 'שמונת', 'תשעת', 'עשרת'];

  // atoms (component words) for 1..999
  function under1000(n) {
    const parts = [];
    const h = Math.floor(n / 100), rem = n % 100;
    if (h) parts.push(HUNDREDS[h]);
    if (rem) {
      if (rem < 10) parts.push(ONES[rem]);
      else if (rem === 10) parts.push('עשרה');
      else if (rem < 20) parts.push(TEENS[rem - 10]);
      else {
        parts.push(TENS[Math.floor(rem / 10)]);
        if (rem % 10) parts.push(ONES[rem % 10]);
      }
    }
    return parts;
  }

  // space-join, with a "ו" fused onto the final component (formal Hebrew)
  function joinVav(comps) {
    if (!comps.length) return '';
    if (comps.length === 1) return comps[0];
    return comps.slice(0, -1).join(' ') + ' ו' + comps[comps.length - 1];
  }

  // the thousands part as ONE component (so the vav lands on the final unit)
  function thousandsComp(th) {
    if (th === 1) return 'אלף';
    if (th === 2) return 'אלפיים';
    if (th <= 10) return CONSTRUCT[th] + ' אלפים';
    return joinVav(under1000(th)) + ' אלף';
  }

  function words(n) {
    n = Math.floor(Math.abs(Number(n) || 0));
    if (n === 0) return 'אפס';
    if (n > 999999) return String(n); // beyond supported range
    const comps = [];
    const th = Math.floor(n / 1000);
    if (th) comps.push(thousandsComp(th));
    comps.push(...under1000(n % 1000));
    return joinVav(comps);
  }

  // feminine words for agorot (1..99)
  function agorotWords(a) {
    const parts = [];
    if (a < 10) parts.push(ONES_F[a]);
    else if (a === 10) parts.push('עשר');
    else if (a < 20) parts.push(TEENS_F[a - 10]);
    else { parts.push(TENS[Math.floor(a / 10)]); if (a % 10) parts.push(ONES_F[a % 10]); }
    return joinVav(parts);
  }

  // amount as shekels, incl. agorot when the value has a fraction:
  //   1 → "שקל אחד"; 1234 → "…שקלים חדשים"; 100.5 → "מאה שקלים וחמישים אגורות"
  function shekels(n) {
    n = Math.abs(Number(n) || 0);
    let shk = Math.floor(n);
    let ag = Math.round((n - shk) * 100);
    if (ag === 100) { shk += 1; ag = 0; }   // agorot rounded up to a whole shekel → carry
    if (ag > 0 && ag < 100) {
      const sw = shk === 1 ? 'שקל אחד' : shk === 2 ? 'שני שקלים' : (shk === 0 ? 'אפס שקלים' : words(shk) + ' שקלים');
      const aw = ag === 1 ? 'אגורה אחת' : ag === 2 ? 'שתי אגורות' : agorotWords(ag) + ' אגורות';
      return sw + ' ו' + aw;
    }
    if (shk === 1) return 'שקל אחד';
    if (shk === 2) return 'שני שקלים חדשים';
    return words(shk) + ' שקלים חדשים';
  }

  PFS.numwords = { words, shekels };
})(window);
