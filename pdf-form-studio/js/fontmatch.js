/* fontmatch.js — write in the document's own typeface.
 *
 * Everything Fillo places is drawn in Heebo. On a form printed in David or
 * Arial that reads as a patch: right size, right line, wrong letterforms. This
 * module reads which font the PDF actually uses and hands back a CSS stack to
 * match it, so filled values look like part of the page.
 *
 * Two levels of knowledge, both honest about their limits:
 *   - the embedded font's NAME (ABCDEF+ArialMT → Arial) when pdf.js has
 *     resolved the font object; the subset prefix is stripped first.
 *   - failing that, pdf.js's own serif/sans/mono classification.
 * Neither can conjure a font the viewer doesn't have, so every mapping is a
 * STACK ending in Heebo: an exact match where the system has one, a close
 * relative otherwise, never a missing-glyph box.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const HEEBO = "Heebo, 'Segoe UI', Arial, sans-serif";

  // family id → CSS stack. Hebrew faces first, then their closest Latin
  // relatives, then Heebo — so a Hebrew string always finds a real glyph.
  const FAMILIES = {
    david:   { css: "David, 'David Libre', 'Frank Ruehl CLM', 'Times New Roman', " + HEEBO, label: 'דויד' },
    frank:   { css: "'Frank Ruehl CLM', 'Frank Ruehl', David, 'Times New Roman', " + HEEBO, label: 'פרנק-ריהל' },
    times:   { css: "'Times New Roman', Times, David, 'Frank Ruehl CLM', serif, " + HEEBO, label: 'Times' },
    arial:   { css: "Arial, Helvetica, 'Liberation Sans', 'Nimbus Sans', " + HEEBO, label: 'אריאל' },
    tahoma:  { css: "Tahoma, Verdana, 'Segoe UI', " + HEEBO, label: 'תהומה' },
    narkis:  { css: "Narkisim, 'Narkis Tam', Arial, " + HEEBO, label: 'נרקיסים' },
    miriam:  { css: "Miriam, 'Miriam Libre', Arial, " + HEEBO, label: 'מרים' },
    mono:    { css: "'Courier New', Courier, ui-monospace, monospace", label: 'רוחב קבוע' }
  };

  // name → family. Ordered: the first hit wins, so specific names (Arimo, a
  // metric clone of Arial) are tested before the generic words they contain.
  const NAME_RULES = [
    [/frank\s*ru|frankruehl|frank_ru/i, 'frank'],
    [/david/i, 'david'],
    [/narkis/i, 'narkis'],
    [/miriam/i, 'miriam'],
    [/courier|mono(space)?$|consolas/i, 'mono'],
    [/times|timesnewroman|tinos|liberationserif|nimbusroman|georgia|garamond|serif$/i, 'times'],
    [/tahoma|verdana|segoe|dejavusans/i, 'tahoma'],
    [/arial|helvetica|arimo|liberationsans|nimbussans|calibri|opensans|roboto|guttman/i, 'arial']
  ];

  /* pdf.js's generic classification, when the real name is unavailable.
   * Order matters and 'sans-serif' must be ruled out BEFORE 'serif' — it
   * contains it as a substring, and sans is the app font's own category
   * (nothing to change), while serif means the page is set in David/Times. */
  function genericFamily(g) {
    if (/mono/.test(g)) return 'mono';
    if (/sans/.test(g)) return null;
    if (/serif/.test(g)) return 'times';
    return null;
  }

  /* familyOf(rawFontName, genericFamily) → family id | null (= keep Heebo) */
  function familyOf(rawName, generic) {
    const n = String(rawName || '').replace(/^[A-Z]{6}\+/, '').replace(/[\s_-]+/g, '');
    for (const [re, id] of NAME_RULES) if (re.test(n)) return id;
    return genericFamily(String(generic || '').toLowerCase());
  }
  const cssOf = (id) => (id && FAMILIES[id]) ? FAMILIES[id].css : null;
  const labelOf = (id) => (id && FAMILIES[id]) ? FAMILIES[id].label : 'ברירת מחדל';

  /* resolverFor(page, textContent) → (fontName) => { family, css, bold }
   * pdf.js hands text items an internal font id; the real name lives in the
   * page's common objects once that font has loaded (our pages are all
   * rendered, so it usually has). styles[] is the always-available fallback. */
  function resolverFor(page, tc) {
    const cache = new Map();
    const styles = (tc && tc.styles) || {};
    return function (fontName) {
      if (!fontName) return null;
      if (cache.has(fontName)) return cache.get(fontName);
      let raw = '', generic = '';
      try {
        const co = page && page.commonObjs;
        if (co && (!co.has || co.has(fontName))) {
          const obj = co.get(fontName);
          if (obj) { raw = obj.name || obj.loadedName || ''; }
        }
      } catch (e) { /* font object not resolved — fall back to styles */ }
      const st = styles[fontName];
      if (st) { generic = st.fontFamily || ''; if (!raw && st.fontFamily) raw = st.fontFamily; }
      const family = familyOf(raw, generic);
      const out = family ? { family, css: cssOf(family), bold: /bold|black|heavy|[-_]b$/i.test(raw) } : null;
      cache.set(fontName, out);
      return out;
    };
  }

  // ---- document-level: which face is this form actually printed in? ----
  let docFamily = null;   // family id of the dominant body font

  /* scanDoc(pdfDoc) — weigh every text run by how many characters it sets;
   * the heaviest family is the document's voice. Headings and page numbers
   * lose to body text by construction. Scans the first pages only: forms are
   * typographically uniform, and a full scan on a 40-page PDF is wasted work. */
  async function scanDoc(pdfDoc, maxPages = 3) {
    docFamily = null;
    if (!pdfDoc) return null;
    const weight = Object.create(null);
    const n = Math.min(pdfDoc.numPages, maxPages);
    for (let i = 1; i <= n; i++) {
      try {
        const page = await pdfDoc.getPage(i);
        const tc = await page.getTextContent();
        const resolve = resolverFor(page, tc);
        tc.items.forEach((it) => {
          const s = (it.str || '').trim();
          if (!s) return;
          const f = resolve(it.fontName);
          if (!f) return;
          weight[f.family] = (weight[f.family] || 0) + s.length;
        });
      } catch (e) { /* skip unreadable page */ }
    }
    const best = Object.keys(weight).sort((a, b) => weight[b] - weight[a])[0];
    docFamily = best || null;
    return docFamily;
  }

  const docCss = () => cssOf(docFamily);
  const docLabel = () => labelOf(docFamily);
  const docId = () => docFamily;
  function setDoc(id) { docFamily = FAMILIES[id] ? id : null; return docFamily; }
  function reset() { docFamily = null; }

  PFS.fontmatch = {
    FAMILIES, familyOf, cssOf, labelOf, resolverFor,
    scanDoc, docCss, docLabel, docId, setDoc, reset, HEEBO
  };
})(window);
