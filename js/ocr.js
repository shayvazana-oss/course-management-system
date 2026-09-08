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
    const ctx = c.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    enhanceForOcr(c, ctx);   // grayscale + contrast stretch → better Hebrew OCR on faded scans
    return c;
  }

  // Lift faint/photographed scans before OCR: grayscale + gamma darkening
  // (γ≈1.6) that pulls faint gray ink toward black while leaving the near-white
  // background essentially white — without going fully binary, which can eat
  // thin Hebrew strokes. A small levels stretch cleans the paper.
  function enhanceForOcr(canvas, ctx) {
    try {
      const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = im.data;
      // precompute lookup: gamma-darken, then push the top end back to white
      const lut = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        let g = 255 * Math.pow(v / 255, 1.6);           // darken midtones/ink
        g = (g - 20) / (238 - 20) * 255;                // stretch: <20→black, >238→white
        lut[v] = g < 0 ? 0 : g > 255 ? 255 : g;
      }
      for (let i = 0; i < d.length; i += 4) {
        const y = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
        const v = lut[y];
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      ctx.putImageData(im, 0, 0);
    } catch (e) { /* tainted/oversized canvas — OCR still runs on the raw render */ }
  }

  const letters = (s) => (s.match(/[A-Za-z֐-׿]/g) || []).length;

  function fieldsFromWords(words, W, H, pageIndex) {
    // keep reasonably confident words that have a box
    const boxes = words
      .filter((w) => w.bbox && (w.confidence == null || w.confidence >= 55))
      .map((w) => ({ t: (w.text || '').trim(), bb: w.bbox, conf: w.confidence == null ? 60 : w.confidence }));

    const out = [];
    boxes.forEach((w) => {
      const t = w.t;
      if (!/[:：׃]$/.test(t)) return;                 // must look like a label "…:"
      const core = t.replace(/[:：׃]\s*$/, '').trim();
      if (core.length < 2 || letters(core) < 2) return; // drop punctuation/garbage tokens
      const bb = w.bb, rtl = hasHebrew(core);
      const h = bb.y1 - bb.y0, yc = (bb.y0 + bb.y1) / 2;
      const sameLine = boxes.filter((o) => o !== w && Math.abs((o.bb.y0 + o.bb.y1) / 2 - yc) < h * 0.6);

      // grow the label with tight same-line neighbours on the LABEL side
      // (RTL: to the right of the colon word; LTR: to the left). The blank is on
      // the opposite side, so this never eats into the fill area.
      const labelWords = [{ x: bb.x0, t: core }];
      const chain = rtl
        ? sameLine.filter((o) => o.bb.x0 >= bb.x1 - 2).sort((a, b) => a.bb.x0 - b.bb.x0)
        : sameLine.filter((o) => o.bb.x1 <= bb.x0 + 2).sort((a, b) => b.bb.x1 - a.bb.x1);
      let edge = rtl ? bb.x1 : bb.x0, added = 0;
      for (const o of chain) {
        if (added >= 2) break;
        const gap = rtl ? (o.bb.x0 - edge) : (edge - o.bb.x1);
        if (gap > h * 1.6) break;                 // a big gap = the blank / next field
        const ot = o.t.replace(/[:：׃]\s*$/, '').trim();
        if (letters(ot) < 1) break;
        labelWords.push({ x: o.bb.x0, t: ot });
        edge = rtl ? o.bb.x1 : o.bb.x0; added++;
      }
      const label = (rtl ? labelWords.sort((a, b) => b.x - a.x) : labelWords.sort((a, b) => a.x - b.x))
        .map((o) => o.t).join(' ');

      const defW = 0.30 * W;
      let fx, fw;
      if (rtl) {
        const left = sameLine.filter((o) => o.bb.x1 <= bb.x0 + 2);
        const lb = left.length ? Math.max(...left.map((o) => o.bb.x1)) : Math.max(0, bb.x0 - defW);
        fx = lb / W; fw = Math.max(24, bb.x0 - lb) / W;
      } else {
        const right = sameLine.filter((o) => o.bb.x0 >= bb.x1 - 2);
        const rb = right.length ? Math.min(...right.map((o) => o.bb.x0)) : Math.min(W, bb.x1 + defW);
        fx = bb.x1 / W; fw = Math.max(24, rb - bb.x1) / W;
      }
      out.push({
        page: pageIndex, fieldKey: slug(label, out.length), label: label,
        fx, fy: bb.y0 / H, fw, fh: h / H,
        fontFrac: Math.min(0.03, (h * 0.8) / H), type: 'text', best: true, ocr: true,
        conf: w.conf, _yc: yc
      });
    });

    // drop near-duplicate labels (same text, close vertically) keeping higher confidence
    out.sort((a, b) => b.conf - a.conf);
    const kept = [];
    out.forEach((f) => {
      const dup = kept.find((k) => k.label === f.label && k.page === f.page && Math.abs(k._yc - f._yc) < (f.fh * H) * 1.5);
      if (!dup) kept.push(f);
    });
    return kept;
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
