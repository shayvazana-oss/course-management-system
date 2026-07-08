/* handwriting.js — "כתב היד שלי": compose typed text from the user's own
 * hand-drawn glyphs. The user trains once (draws each letter/digit); we store
 * each glyph as normalized vector strokes, then render typed text by drawing
 * those strokes right-to-left with small natural jitter. Fully local.
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

  function getProfile() {
    const p = store.get(KEY, null);
    if (!p || typeof p !== 'object' || !p.glyphs) return { glyphs: {}, space: 0.35 };
    return p;
  }
  function saveProfile(p) { return store.set(KEY, p); }
  function count() { return Object.keys(getProfile().glyphs).length; }
  function hasGlyphs() { return count() > 0; }
  function hasGlyph(ch) { return !!getProfile().glyphs[ch]; }
  function clearAll() { store.remove(KEY); }

  /* store a glyph from raw strokes (canvas px). Normalizes to its bbox. */
  function setGlyph(ch, strokes) {
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
    p.glyphs[ch] = { s: norm, a: Math.round((w / h) * 100) / 100 };
    return saveProfile(p);
  }
  function removeGlyph(ch) { const p = getProfile(); delete p.glyphs[ch]; saveProfile(p); }

  /* renderText(text, {fontPx, color}) → { url, w, h } trimmed transparent PNG */
  function renderText(text, opts) {
    opts = opts || {};
    const p = getProfile();
    const fontPx = opts.fontPx || 64;
    const color = opts.color || '#1a1a2e';
    const lw = Math.max(1.4, fontPx * 0.05);
    const gap = fontPx * 0.06;
    const spaceW = fontPx * (p.space || 0.35);
    const chars = String(text || '').split('');

    // build advance list
    const items = []; let totalW = 0;
    chars.forEach((ch) => {
      if (ch === ' ' || ch === '\t' || ch === '\n') { items.push({ space: true, w: spaceW }); totalW += spaceW + gap; return; }
      const g = p.glyphs[ch];
      if (!g) { items.push({ space: true, w: spaceW }); totalW += spaceW + gap; return; }
      const gw = fontPx * g.a;
      items.push({ g: g, w: gw }); totalW += gw + gap;
    });
    totalW = Math.max(1, totalW - gap);

    const pad = Math.round(fontPx * 0.35);
    const Wc = Math.round(totalW + pad * 2);
    const H = Math.round(fontPx * 1.6 + pad * 2);
    const c = document.createElement('canvas'); c.width = Wc; c.height = H;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    const topY = pad + fontPx * 0.3;       // glyph box top
    let x = Wc - pad;                        // RTL: start at the right
    items.forEach((it) => {
      x -= it.w;
      if (it.g) {
        const g = it.g;
        const jr = (Math.random() - 0.5) * 0.07;         // ±~2°
        const jy = (Math.random() - 0.5) * fontPx * 0.07;
        const sw = 1 + (Math.random() - 0.5) * 0.08;
        const cx = x + it.w / 2, cy = topY + fontPx / 2;
        ctx.save();
        ctx.translate(cx, cy + jy); ctx.rotate(jr); ctx.scale(sw, 1); ctx.translate(-cx, -cy);
        g.s.forEach((st) => {
          ctx.beginPath();
          st.forEach((q, j) => {
            const px = x + q.x * it.w;
            const py = topY + q.y * fontPx;
            if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          });
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
    GLYPHS, HEB, FINALS, DIGITS, PUNCT,
    getProfile, saveProfile, count, hasGlyphs, hasGlyph, clearAll,
    setGlyph, removeGlyph, renderText
  };
})(window);
