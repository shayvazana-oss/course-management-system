/* handwriting.js — "כתב היד שלי": compose typed text from the user's own
 * hand-drawn glyphs. The user trains once (draws each letter/digit); we store
 * each glyph as normalized vector strokes, then render typed text by drawing
 * those strokes right-to-left with small natural jitter. Fully local.
 *
 * v2 — typographic metrics model: each glyph knows its TRUE size and vertical
 * position inside the em box (י is small and hangs high, ל ascends, ך ן ף ץ ק
 * descend below the baseline). Metrics come from a canonical Hebrew table
 * blended with what was measured against the trainer guidelines, so letters
 * keep their identity (י no longer stretches into ו/ן) while staying personal.
 * A "beautify" pass (Chaikin smoothing + regularized jitter + subtle width
 * variation) makes the result cleaner but still authentically hand-written.
 *
 * Honest scope: per-glyph personal handwriting with variation — not connected
 * cursive and not AI synthesis (unavailable offline for Hebrew).
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const store = PFS.store;
  const KEY = 'handwriting';

  const HEB = 'אבגדהוזחטיכלמנסעפצקרשת'.split('');
  const FINALS = 'ךםןףץ'.split('');
  const DIGITS = '0123456789'.split('');
  const PUNCT = ['.', ',', '/', ':', '-', '(', ')', '"', "'"];
  const GLYPHS = [].concat(HEB, FINALS, DIGITS, PUNCT);

  /* Canonical em-box metrics per glyph: y = top offset, h = height, both in
   * em units. The x-height band runs 0.06→0.78 (baseline at 0.78). */
  const XH = { y: 0.06, h: 0.72 };                    // regular letters & digits
  const DESC = { y: 0.06, h: 1.02 };                  // descend below baseline
  const METRICS = {
    'י': { y: 0.06, h: 0.30 },                        // small, hangs from the top
    'ל': { y: -0.17, h: 0.95 },                       // ascends above the line
    'ך': DESC, 'ן': DESC, 'ף': DESC, 'ץ': DESC, 'ק': DESC,
    '.': { y: 0.68, h: 0.10 }, ',': { y: 0.66, h: 0.20 },
    '/': { y: 0.02, h: 0.80 }, ':': { y: 0.25, h: 0.45 },
    '-': { y: 0.38, h: 0.07 }, '(': { y: -0.02, h: 0.90 }, ')': { y: -0.02, h: 0.90 },
    '"': { y: 0.06, h: 0.22 }, "'": { y: 0.06, h: 0.22 }
  };
  const metricsOf = (ch) => METRICS[ch] || XH;

  function getProfile() {
    const p = store.get(KEY, null);
    if (!p || typeof p !== 'object' || !p.glyphs) return { glyphs: {}, space: 0.35, beautify: true };
    if (p.beautify === undefined) p.beautify = true;
    return p;
  }
  function saveProfile(p) { return store.set(KEY, p); }
  function count() { return Object.keys(getProfile().glyphs).length; }
  function hasGlyphs() { return count() > 0; }
  function hasGlyph(ch) { return !!getProfile().glyphs[ch]; }
  function clearAll() { store.remove(KEY); }
  function getBeautify() { return getProfile().beautify !== false; }
  function setBeautify(on) { const p = getProfile(); p.beautify = !!on; saveProfile(p); }

  /* store a glyph from raw strokes (canvas px). Normalizes to its bbox.
   * ref (optional) = {top, base} — the trainer guideline lines in the same px
   * space; when present we also record measured em metrics, so the size and
   * position the user actually drew carry into the synthesis. */
  function setGlyph(ch, strokes, ref) {
    const p = getProfile();
    const pts = [].concat.apply([], strokes || []);
    if (pts.length < 2) { delete p.glyphs[ch]; saveProfile(p); return false; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach((q) => { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; });
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const norm = strokes.map((st) => st.map((q) => ({
      x: Math.round(((q.x - minX) / w) * 1000) / 1000,
      y: Math.round(((q.y - minY) / h) * 1000) / 1000
    })));
    const g = { s: norm, a: Math.round((w / h) * 100) / 100 };
    if (ref && ref.base - ref.top > 4) {
      const span = ref.base - ref.top; // the guides mark the x-height band (=0.72em)
      g.m = {
        h: Math.round(Math.max(0.05, Math.min(1.4, (h / span) * XH.h)) * 1000) / 1000,
        y: Math.round(Math.max(-0.3, Math.min(1.0, XH.y + ((minY - ref.top) / span) * XH.h)) * 1000) / 1000
      };
    }
    p.glyphs[ch] = g;
    return saveProfile(p);
  }
  function removeGlyph(ch) { const p = getProfile(); delete p.glyphs[ch]; saveProfile(p); }

  /* final metrics = canonical blended with what the user actually drew,
   * clamped near canonical so a sloppy capture can't break letter identity. */
  function blendMetrics(ch, g) {
    const c = metricsOf(ch);
    if (!g || !g.m) return c;
    const W = 0.6;
    const clamp = (v, base, r) => Math.min(base + r, Math.max(base - r, v));
    return {
      h: clamp(c.h * (1 - W) + g.m.h * W, c.h, 0.25),
      y: clamp(c.y * (1 - W) + g.m.y * W, c.y, 0.20)
    };
  }

  /* Chaikin corner-cutting (keeps endpoints) — removes hand/pointer jitter
   * while preserving the letterform. */
  function smoothStroke(st, iters) {
    let p = st;
    for (let k = 0; k < iters; k++) {
      if (p.length < 3) break;
      const out = [p[0]];
      for (let i = 0; i < p.length - 1; i++) {
        const a = p[i], b = p[i + 1];
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      out.push(p[p.length - 1]);
      p = out;
    }
    return p;
  }

  /* renderText(text, {fontPx, color, beautify}) → { url, w, h } trimmed PNG */
  function renderText(text, opts) {
    opts = opts || {};
    const p = getProfile();
    const fontPx = opts.fontPx || 64;
    const color = opts.color || '#111111';
    const beautify = opts.beautify !== undefined ? !!opts.beautify : (p.beautify !== false);
    const lw = Math.max(1.4, fontPx * 0.05);
    const gap = fontPx * 0.06;
    const spaceW = fontPx * (p.space || 0.35);
    const chars = String(text || '').split('');

    // layout: every glyph at its TRUE size — advance width follows the metrics
    const items = []; let totalW = 0;
    chars.forEach((ch) => {
      const g = p.glyphs[ch];
      if (ch === ' ' || ch === '\t' || ch === '\n' || !g) { items.push({ space: true, w: spaceW }); totalW += spaceW + gap; return; }
      const m = blendMetrics(ch, g);
      const gh = fontPx * m.h;
      const gw = Math.max(fontPx * 0.06, gh * g.a);
      items.push({ g, m, w: gw, h: gh });
      totalW += gw + gap;
    });
    totalW = Math.max(1, totalW - gap);

    const pad = Math.round(fontPx * 0.35);
    const Wc = Math.round(totalW + pad * 2);
    const H = Math.round(fontPx * 1.5 + pad * 2);
    const c = document.createElement('canvas'); c.width = Wc; c.height = H;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    const topY = pad + fontPx * 0.25;        // em-box top (leaves room for ל)
    // beautify → gentler, more regular variation; raw → looser, more casual
    const jRot = beautify ? 0.02 : 0.07;     // ±~0.6° vs ±2°
    const jY = beautify ? 0.03 : 0.07;
    const jW = beautify ? 0.04 : 0.08;
    let x = Wc - pad;                        // RTL: start at the right
    items.forEach((it) => {
      x -= it.w;
      if (it.g) {
        const gTop = topY + fontPx * it.m.y;
        const jr = (Math.random() - 0.5) * jRot;
        const jy = (Math.random() - 0.5) * fontPx * jY;
        const sw = 1 + (Math.random() - 0.5) * jW;
        const cx = x + it.w / 2, cy = gTop + it.h / 2;
        ctx.save();
        ctx.translate(cx, cy + jy); ctx.rotate(jr); ctx.scale(sw, 1); ctx.translate(-cx, -cy);
        it.g.s.forEach((st) => {
          let pts = st.map((q) => ({ x: x + q.x * it.w, y: gTop + q.y * it.h }));
          if (beautify) pts = smoothStroke(pts, 2);
          ctx.lineWidth = lw * (0.92 + Math.random() * 0.16); // subtle ink variation
          ctx.beginPath();
          pts.forEach((q, j) => (j === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y)));
          ctx.stroke();
        });
        ctx.restore();
      }
      x -= gap;
    });

    const trimmed = PFS.imageTools.autoTrim(c, 6);
    return { url: trimmed.toDataURL('image/png'), w: trimmed.width, h: trimmed.height };
  }

  PFS.handwriting = {
    GLYPHS, HEB, FINALS, DIGITS, PUNCT, METRICS, metricsOf,
    getProfile, saveProfile, count, hasGlyphs, hasGlyph, clearAll,
    getBeautify, setBeautify,
    setGlyph, removeGlyph, renderText
  };
})(window);
