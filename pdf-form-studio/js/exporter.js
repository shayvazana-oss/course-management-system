/* exporter.js — flatten overlays into the PDF with pdf-lib.
 * For each page that has elements we rasterize them onto ONE high-DPI
 * transparent canvas (the browser does Hebrew shaping + RTL correctly), then
 * embed that PNG over the page. Pages without elements are left untouched, so
 * their original text stays selectable. One image per page ⇒ no per-element
 * y-flip; page /Rotate is handled by a 4-case anchor+rotate switch.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const EXPORT_SCALE = 2.6; // raster DPI multiplier (sharpness vs memory)

  function preloadImages(urls) {
    const uniq = [...new Set(urls.filter(Boolean))];
    return Promise.all(uniq.map((u) =>
      PFS.imageTools.loadImage(u).then((img) => [u, img]).catch(() => [u, null])
    )).then((pairs) => new Map(pairs));
  }

  async function ensureFonts() {
    try {
      await Promise.all([
        document.fonts.load('16px Heebo'),
        document.fonts.load('bold 16px Heebo'),
        document.fonts.load('700 16px Heebo')
      ]);
      await document.fonts.ready;
    } catch (e) { /* fall back to system font */ }
  }

  function drawElement(ctx, m, cw, ch, imgMap) {
    const x = m.fx * cw, y = m.fy * ch;
    if (m.type === 'image') {
      const img = imgMap.get(m.imgUrl);
      if (img) ctx.drawImage(img, x, y, m.fw * cw, m.fh * ch);
      return;
    }
    if (m.type === 'rect') {   // whiteout / redact / highlight — a filled box
      const a = m.opacity != null ? m.opacity : 1;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.fillStyle = m.color || '#ffffff';
      ctx.fillRect(x, y, m.fw * cw, m.fh * ch);
      ctx.restore();
      return;
    }
    // text
    const fontPx = m.fontFrac * ch;
    const boxW = m.fw * cw;
    ctx.direction = 'rtl';
    ctx.textBaseline = 'top';
    ctx.fillStyle = m.color || '#111';
    ctx.font = (m.bold ? '700 ' : '400 ') + fontPx + 'px Heebo, sans-serif';
    let anchorX, align;
    if (m.align === 'center') { anchorX = x + boxW / 2; align = 'center'; }
    else if (m.align === 'left') { anchorX = x; align = 'left'; }
    else { anchorX = x + boxW; align = 'right'; }   // default RTL: right edge
    ctx.textAlign = align;
    const lines = String(m.text ?? '').split('\n');
    const lineH = fontPx * 1.15;
    lines.forEach((ln, i) => ctx.fillText(ln, anchorX, y + i * lineH));
  }

  // Build the display-oriented overlay canvas for one page's elements.
  function rasterizePage(models, displayWpt, displayHpt, imgMap) {
    const cw = Math.max(1, Math.round(displayWpt * EXPORT_SCALE));
    const ch = Math.max(1, Math.round(displayHpt * EXPORT_SCALE));
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    models.forEach((m) => drawElement(ctx, m, cw, ch, imgMap));
    return canvas;
  }

  /* exportPdf(originalBytes, models, opts)
   *   originalBytes : ArrayBuffer/Uint8Array of the source PDF
   *   models        : array of element models (page + fractions)
   *   opts.filename, opts.onProgress(done,total)
   */
  async function exportPdf(originalBytes, models, opts = {}) {
    if (!root.PDFLib) throw new Error('pdf-lib not loaded');
    const { PDFDocument, degrees } = root.PDFLib;
    await ensureFonts();

    const imgMap = await preloadImages(models.map((m) => m.imgUrl));
    const pdfDoc = await PDFDocument.load(originalBytes);

    // If the PDF is a fillable form, flatten it first: interactive field widgets
    // otherwise render ABOVE page content and would hide our overlay text.
    // Flattening turns them into static content so overlays sit on top.
    //
    // CRITICAL: flatten with updateFieldAppearances=false. pdf-lib's default
    // (true) REGENERATES every field's appearance stream using its Latin
    // fallback font (Helvetica/WinAnsi) with no RTL/BiDi — which scrambles and
    // spaces out all Hebrew (Israeli gov forms are AcroForms where even labels
    // are fields), while digits survive. Keeping the ORIGINAL appearance
    // streams bakes the Hebrew in exactly as the form authored it.
    try {
      const form = pdfDoc.getForm();
      if (form && form.getFields().length) form.flatten({ updateFieldAppearances: false });
    } catch (e) { console.warn('[export] form flatten skipped:', e && e.message); }

    const pages = pdfDoc.getPages();

    // group models by page
    const byPage = new Map();
    models.forEach((m) => {
      if (!byPage.has(m.page)) byPage.set(m.page, []);
      byPage.get(m.page).push(m);
    });

    // per-page user rotation (0/90/180/270) added on top of the intrinsic
    // /Rotate — for straightening sideways scans. Pages that were rotated but
    // carry no overlay still need their /Rotate updated, so process the union.
    const rotations = opts.rotations || {};
    const removeSet = new Set((opts.removePages || []).map(Number));
    const userR = (idx) => (((Number(rotations[idx]) || 0) % 360) + 360) % 360;
    const pageSet = new Set([...byPage.keys(), ...Object.keys(rotations).map(Number).filter((k) => userR(k))]);
    // don't draw overlays on pages that are being removed
    const pageIdxs = [...pageSet].filter((i) => !removeSet.has(i)).sort((a, b) => a - b);
    let done = 0;
    for (const idx of pageIdxs) {
      const page = pages[idx];
      if (!page) continue;
      const { width: Wpt, height: Hpt } = page.getSize();
      const intrinsic = ((page.getRotation().angle % 360) + 360) % 360;
      const rot = (intrinsic + userR(idx)) % 360;
      if (userR(idx)) page.setRotation(degrees(rot)); // straighten the page itself
      const swap = (rot === 90 || rot === 270);
      const displayWpt = swap ? Hpt : Wpt;
      const displayHpt = swap ? Wpt : Hpt;

      const models = byPage.get(idx);
      if (!models || !models.length) { done++; opts.onProgress && opts.onProgress(done, pageIdxs.length); continue; }
      const canvas = rasterizePage(models, displayWpt, displayHpt, imgMap);
      const png = await pdfDoc.embedPng(canvas.toDataURL('image/png'));

      switch (rot) {
        case 90:
          page.drawImage(png, { x: Wpt, y: 0, width: displayWpt, height: displayHpt, rotate: degrees(90) });
          break;
        case 180:
          page.drawImage(png, { x: Wpt, y: Hpt, width: Wpt, height: Hpt, rotate: degrees(180) });
          break;
        case 270:
          page.drawImage(png, { x: 0, y: Hpt, width: displayWpt, height: displayHpt, rotate: degrees(270) });
          break;
        default:
          page.drawImage(png, { x: 0, y: 0, width: Wpt, height: Hpt });
      }
      // free memory
      canvas.width = 0; canvas.height = 0;
      done++;
      opts.onProgress && opts.onProgress(done, pageIdxs.length);
    }

    // Decide the output document. Overlays/rotations were already baked onto the
    // source pages above (copyPages/removePage preserve both).
    //  - pageOrder present → reassemble a fresh doc with pages in that order
    //    (this alone encodes reordering AND deletion — omitted indices drop out).
    //  - else → the tested in-place path: drop deleted pages, keep source doc.
    let target = pdfDoc;
    const order = Array.isArray(opts.pageOrder) ? opts.pageOrder.filter((i) => i >= 0 && i < pages.length) : null;
    if (order && order.length) {
      target = await PDFDocument.create();
      const copied = await target.copyPages(pdfDoc, order);
      copied.forEach((p) => target.addPage(p));
    } else if (removeSet.size) {
      // remove user-deleted pages (descending so indices stay valid). Never
      // leave an empty document: keep one page if there are no attachments.
      let toRemove = [...removeSet].filter((i) => i >= 0 && i < pages.length).sort((a, b) => b - a);
      const attachCount = (opts.attachments || []).length;
      if (!attachCount && toRemove.length >= pdfDoc.getPageCount()) toRemove = toRemove.slice(0, pdfDoc.getPageCount() - 1);
      toRemove.forEach((i) => { try { pdfDoc.removePage(i); } catch (e) {} });
    }

    // append supporting attachments (e.g. a photo of an ID) as their own pages,
    // each scaled to fit an A4 portrait — so form + attachments submit as one PDF
    const attachments = opts.attachments || [];
    for (const att of attachments) {
      // a PDF attachment → copy all its pages through unchanged
      if (att && att.kind === 'pdf' && att.bytes) {
        try {
          const donor = await PDFDocument.load(att.bytes);
          const copied = await target.copyPages(donor, donor.getPageIndices());
          copied.forEach((p) => target.addPage(p));
        } catch (e) { console.warn('[export] pdf attachment skipped:', e && e.message); }
        continue;
      }
      const src = att && (att.url || att);
      if (!src) continue;
      let emb;
      try { emb = /jpe?g|jfif/i.test(att.type || src) ? await target.embedJpg(src) : await target.embedPng(src); }
      catch (e) { console.warn('[export] attachment skipped:', e && e.message); continue; }
      const maxW = 595, maxH = 842; // A4 in pt
      const s = Math.min(maxW / emb.width, maxH / emb.height, 1);
      const w = Math.max(1, emb.width * s), h = Math.max(1, emb.height * s);
      const p = target.addPage([w, h]);
      p.drawImage(emb, { x: 0, y: 0, width: w, height: h });
    }

    const bytes = await target.save();
    return bytes;
  }

  // Append attachments (images / whole PDFs) to a target pdf-lib doc.
  async function appendAttachments(target, attachments) {
    for (const att of (attachments || [])) {
      if (att && att.kind === 'pdf' && att.bytes) {
        try { const donor = await root.PDFLib.PDFDocument.load(att.bytes); (await target.copyPages(donor, donor.getPageIndices())).forEach((p) => target.addPage(p)); }
        catch (e) { console.warn('[export] pdf attachment skipped:', e && e.message); }
        continue;
      }
      const src = att && (att.url || att);
      if (!src) continue;
      let emb;
      try { emb = /jpe?g|jfif/i.test(att.type || src) ? await target.embedJpg(src) : await target.embedPng(src); }
      catch (e) { console.warn('[export] attachment skipped:', e && e.message); continue; }
      const s = Math.min(595 / emb.width, 842 / emb.height, 1);
      const w = Math.max(1, emb.width * s), h = Math.max(1, emb.height * s);
      target.addPage([w, h]).drawImage(emb, { x: 0, y: 0, width: w, height: h });
    }
  }

  /* exportFlattenedPdf — a SECURE, image-only export: every page is rasterized
   * (base content + overlay burned in), so nothing is selectable or extractable
   * and redactions truly remove the text underneath. Also tamper-resistant.
   *   renderBase(pageIndex) → { canvas, wPt, hPt } — base page drawn at high DPI
   *                           (already rotated), plus its size in points.
   */
  async function exportFlattenedPdf({ order, models, attachments, renderBase, onProgress }) {
    const { PDFDocument } = root.PDFLib;
    await ensureFonts();
    const imgMap = await preloadImages((models || []).map((m) => m.imgUrl));
    const byPage = new Map();
    (models || []).forEach((m) => { if (!byPage.has(m.page)) byPage.set(m.page, []); byPage.get(m.page).push(m); });
    const out = await PDFDocument.create();
    const idxs = (order && order.length) ? order : [...new Set((models || []).map((m) => m.page))].sort((a, b) => a - b);
    let done = 0;
    for (const idx of idxs) {
      const { canvas, wPt, hPt } = await renderBase(idx);
      const ctx = canvas.getContext('2d');
      (byPage.get(idx) || []).forEach((m) => drawElement(ctx, m, canvas.width, canvas.height, imgMap));
      const png = await out.embedPng(canvas.toDataURL('image/png'));
      out.addPage([wPt, hPt]).drawImage(png, { x: 0, y: 0, width: wPt, height: hPt });
      canvas.width = 0; canvas.height = 0;
      done++; onProgress && onProgress(done, idxs.length);
    }
    await appendAttachments(out, attachments);
    return out.save();
  }

  function downloadBytes(bytes, filename) {
    PFS.deliver.file(bytes, filename || 'filled.pdf', 'application/pdf');
  }

  PFS.exporter = { exportPdf, exportFlattenedPdf, downloadBytes };
})(window);
