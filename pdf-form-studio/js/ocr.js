/* ocr.js — read SCANNED forms with Hebrew OCR (Tesseract.js) and propose
 * fillable fields. Best-effort: renders each page, recognizes Hebrew text with
 * word boxes, and turns label-like words (ending in ':') into fields anchored
 * in the blank next to them. Served-build only (needs the vendored worker +
 * wasm + traineddata); the single-file build sets PFS_TESS = null.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const pdfjsLib = root.pdfjsLib;

  const cfg = () => root.PFS_TESS;
  const available = () => !!(root.Tesseract && cfg());
  const hasHebrew = (s) => /[֐-׿]/.test(s);
  function slug(label, i) {
    let t = (label || '').replace(/[:：׃]\s*$/, '').trim().replace(/[^\w֐-׿]+/g, '_').replace(/^_+|_+$/g, '');
    return t.slice(0, 40) || ('ocr_' + (i + 1));
  }

  async function renderPageCanvas(pdfDoc, n, targetW) {
    const page = await pdfDoc.getPage(n);
    const base = page.getViewport({ scale: 1, rotation: page.rotate });
    const scale = Math.min(3, Math.max(1, targetW / base.width));
    const vp = page.getViewport({ scale, rotation: page.rotate });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  }

  function fieldsFromWords(words, W, H, pageIndex) {
    const out = [];
    words.forEach((w) => {
      const t = (w.text || '').trim();
      if (!/[:：׃]$/.test(t) || t.length < 2) return;   // only label-like words
      const bb = w.bbox; if (!bb) return;
      const rtl = hasHebrew(t);
      const defW = 0.32 * W;
      let fx, fw;
      if (rtl) { const lb = Math.max(0, bb.x0 - defW); fx = lb / W; fw = (bb.x0 - lb) / W; }
      else { const rb = Math.min(W, bb.x1 + defW); fx = bb.x1 / W; fw = (rb - bb.x1) / W; }
      const h = (bb.y1 - bb.y0);
      out.push({
        page: pageIndex, fieldKey: slug(t, out.length),
        label: t.replace(/[:：׃]$/, '').trim() || 'שדה',
        fx, fy: bb.y0 / H, fw, fh: h / H,
        fontFrac: Math.min(0.03, (h * 0.8) / H), type: 'text', best: true, ocr: true
      });
    });
    return out;
  }

  async function runOcrDetect(pdfDoc, onProgress) {
    if (!available()) throw new Error('OCR not available in this build');
    const c = cfg();
    const worker = await root.Tesseract.createWorker('heb', 1, {
      workerPath: c.worker, corePath: c.core, langPath: c.lang, gzip: false, logger: () => {}
    });
    let fields = [];
    try {
      const num = pdfDoc.numPages;
      for (let n = 1; n <= num; n++) {
        onProgress && onProgress(n - 1, num, 'render');
        const canvas = await renderPageCanvas(pdfDoc, n, 1600);
        onProgress && onProgress(n - 1, num, 'ocr');
        const { data } = await worker.recognize(canvas);
        const words = (data.words || []).filter((w) => w.text && w.text.trim());
        fields = fields.concat(fieldsFromWords(words, canvas.width, canvas.height, n - 1));
        canvas.width = 0; canvas.height = 0;
        onProgress && onProgress(n, num, 'done');
      }
    } finally { try { await worker.terminate(); } catch (e) {} }
    const seen = Object.create(null);
    fields.forEach((f) => { let k = f.fieldKey; if (seen[k]) { seen[k]++; f.fieldKey = k + '_' + seen[k]; } else seen[k] = 1; });
    return { tier: 'ocr', fields };
  }

  PFS.ocr = { available, runOcrDetect };
})(window);
