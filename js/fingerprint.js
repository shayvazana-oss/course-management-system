/* fingerprint.js — recognise a form so its saved template can auto-apply.
 * Digital PDFs: hash of page-1 text. Scanned PDFs (no text): a small average
 * hash (aHash) of page 1. Match = same page count AND (equal text hash, or
 * close aHash). Fully local.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h >>> 0); }
  function hamming(a, b) { if (!a || !b || a.length !== b.length) return 999; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }

  async function compute(pdfDoc) {
    const pages = pdfDoc.numPages;
    const page = await pdfDoc.getPage(1);
    const vp = page.getViewport({ scale: 1, rotation: page.rotate });
    const w = Math.round(vp.width), h = Math.round(vp.height);
    let text = '';
    try { const tc = await page.getTextContent(); text = tc.items.map((i) => i.str).join('').replace(/\s+/g, '').slice(0, 500); } catch (e) {}
    const textHash = text.length >= 12 ? hashStr(text) : null;
    // aHash (8x8) of page 1
    let ahash = '';
    try {
      const s = Math.min(1, 256 / vp.width);
      const rv = page.getViewport({ scale: s, rotation: page.rotate });
      const c = document.createElement('canvas'); c.width = Math.round(rv.width); c.height = Math.round(rv.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: rv }).promise;
      const N = 8; const small = document.createElement('canvas'); small.width = N; small.height = N;
      const sctx = small.getContext('2d', { willReadFrequently: true }); sctx.drawImage(c, 0, 0, N, N);
      const d = sctx.getImageData(0, 0, N, N).data; const g = [];
      for (let i = 0; i < N * N; i++) g.push((d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3);
      const avg = g.reduce((a, b) => a + b, 0) / g.length;
      g.forEach((v) => (ahash += v > avg ? '1' : '0'));
      c.width = 0; c.height = 0;
    } catch (e) {}
    return { pages, w, h, textHash, ahash };
  }

  // similarity score 0..1 (0 = no match)
  function score(a, b) {
    if (!a || !b || a.pages !== b.pages) return 0;
    if (a.textHash && b.textHash) return a.textHash === b.textHash ? 1 : 0;
    const d = hamming(a.ahash, b.ahash);
    return d <= 10 ? 1 - d / 64 : 0;
  }

  PFS.fingerprint = { compute, score };
})(window);
