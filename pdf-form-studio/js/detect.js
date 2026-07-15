/* detect.js — find fillable spots in a PDF and describe them as fields.
 * Three honest tiers:
 *   A. AcroForm  → real form-field widgets (reliable).
 *   B. text      → digital PDF with a text layer: heuristic label→blank.
 *   C. scanned   → image only, no text: cannot auto-read (needs OCR).
 * Each field is expressed in the app's top-left page fractions so it plugs
 * straight into the element model.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const pdfjsLib = root.pdfjsLib;

  // RTL = Hebrew OR Arabic → blank sits to the LEFT of the label for both
  const hasHebrew = (s) => /[֐-׿؀-ۿ]/.test(s);
  const isLabel = (s) => {
    const t = (s || '').trim();
    return t.length > 0 && t.length < 40 && /[:：׃]\s*$/.test(t);
  };
  const isUnderscores = (s) => /_{3,}/.test(s || '');
  function slug(label, i) {
    let t = (label || '').replace(/[:：׃]\s*$/, '').trim();
    if (!t) return 'field_' + (i + 1);
    t = t.replace(/[^\w֐-׿]+/g, '_').replace(/^_+|_+$/g, '');
    return t.slice(0, 40) || ('field_' + (i + 1));
  }

  // px box of a text item in viewport (top-left origin), using the item matrix.
  function itemBox(item, vp) {
    const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fontH = Math.hypot(tx[2], tx[3]) || Math.abs(tx[3]) || 10;
    const x = tx[4];                 // left edge (baseline origin)
    const yBase = tx[5];             // baseline y (top-left origin)
    const w = (item.width != null ? item.width : 0) * Math.hypot(vp.transform[0], vp.transform[1]);
    return { x, yBase, top: yBase - fontH, w, fontH, str: item.str };
  }

  function heuristicForPage(items, W, H, vp, startIndex) {
    const boxes = items.filter((it) => it.str && it.str.trim()).map((it) => itemBox(it, vp));
    const out = [];
    boxes.forEach((b) => {
      const label = b.str.trim();
      if (!isLabel(label) && !isUnderscores(label)) return;
      const sameLine = boxes.filter((o) => o !== b && Math.abs(o.yBase - b.yBase) < b.fontH * 0.7);
      // For a bare underscore-blank, borrow the real label from the nearest
      // text on the same line (bidi sometimes splits "label: ____" into two
      // items — happens with Arabic and some Hebrew). Prefer the label to the
      // RIGHT (RTL) of the blank, else the nearest with letters.
      let displayLabel = label;
      const hasLetters = (s) => /[A-Za-z֐-׿؀-ۿ]/.test(s || '');
      if (isUnderscores(label)) {
        const cand = sameLine.filter((o) => hasLetters(o.str) && !isUnderscores(o.str.trim()));
        const right = cand.filter((o) => o.x > b.x).sort((a, c) => a.x - c.x)[0];
        const chosen = right || cand.sort((a, c) => c.x - a.x)[0];
        if (chosen) displayLabel = chosen.str.trim();
      }
      const rtl = hasHebrew(displayLabel);
      let fx, fw;
      const defW = Math.min(0.34 * W, W * 0.5);
      if (isUnderscores(label)) {
        fx = b.x / W; fw = Math.max(b.w, 0.15 * W) / W;
      } else if (rtl) {
        // blank is to the LEFT of the label
        const labelLeft = b.x;
        const leftItems = sameLine.filter((o) => (o.x + o.w) <= labelLeft + 2);
        const leftBound = leftItems.length ? Math.max(...leftItems.map((o) => o.x + o.w)) : Math.max(0, labelLeft - defW);
        fx = leftBound / W; fw = Math.max(20, labelLeft - leftBound) / W;
      } else {
        // blank is to the RIGHT of the label
        const labelRight = b.x + b.w;
        const rightItems = sameLine.filter((o) => o.x >= labelRight - 2);
        const rightBound = rightItems.length ? Math.min(...rightItems.map((o) => o.x)) : Math.min(W, labelRight + defW);
        fx = labelRight / W; fw = Math.max(20, rightBound - labelRight) / W;
      }
      const fontFrac = Math.min(0.03, (b.fontH * 0.95) / H);
      out.push({
        page: startIndex, fieldKey: slug(displayLabel, out.length),
        label: displayLabel.replace(/[:：׃]\s*$/, '').trim() || 'שדה',
        fx, fy: Math.max(0, b.top) / H, fw, fh: b.fontH / H, fontFrac, type: 'text', best: true
      });
    });
    return out;
  }

  // ensure every field has a distinct fieldKey (repeated labels like "תאריך:")
  function uniqueKeys(fields) {
    const seen = Object.create(null);
    fields.forEach((f) => {
      let k = f.fieldKey || 'field';
      if (seen[k]) { seen[k]++; f.fieldKey = k + '_' + seen[k]; }
      else seen[k] = 1;
    });
    return fields;
  }

  async function detectFields(pdfDoc) {
    const num = pdfDoc.numPages;
    let anyWidget = false, anyText = false;
    const widgetFields = [];
    const textPages = [];
    for (let i = 1; i <= num; i++) {
      const page = await pdfDoc.getPage(i);
      const vp = page.getViewport({ scale: 1, rotation: page.rotate });
      const W = vp.width, H = vp.height;
      // Tier A — form widgets
      let anns = [];
      try { anns = await page.getAnnotations(); } catch (e) {}
      anns.forEach((a) => {
        if (a.subtype === 'Widget' && a.rect && (a.fieldType === 'Tx' || a.fieldType === 'Btn' || a.fieldType === 'Ch')) {
          anyWidget = true;
          const r = vp.convertToViewportRectangle(a.rect);
          const x1 = Math.min(r[0], r[2]), y1 = Math.min(r[1], r[3]);
          const x2 = Math.max(r[0], r[2]), y2 = Math.max(r[1], r[3]);
          const fh = (y2 - y1) / H;
          const fontFrac = Math.min(0.03, fh * 0.6);
          widgetFields.push({
            page: i - 1,
            fieldKey: (a.fieldName || ('field_' + (widgetFields.length + 1))).replace(/[^\w֐-׿.]+/g, '_'),
            label: a.fieldName || ('שדה ' + (widgetFields.length + 1)),
            fx: x1 / W, fy: y1 / H + Math.max(0, (fh - fontFrac) / 2), // vertically center in the widget
            fw: (x2 - x1) / W, fh, fontFrac, type: a.fieldType === 'Btn' ? 'check' : 'text'
          });
        }
      });
      // text content
      let tc = { items: [] };
      try { tc = await page.getTextContent(); } catch (e) {}
      if (tc.items.some((it) => it.str && it.str.trim())) anyText = true;
      textPages.push({ items: tc.items, W, H, vp, index: i - 1 });
    }

    if (anyWidget) return { tier: 'acroform', fields: uniqueKeys(widgetFields) };
    if (anyText) {
      let fields = [];
      textPages.forEach((p) => { fields = fields.concat(heuristicForPage(p.items, p.W, p.H, p.vp, p.index)); });
      const seen = new Set(); const uniq = [];
      fields.forEach((f) => { const k = f.page + '|' + f.fieldKey + '|' + Math.round(f.fy * 100); if (!seen.has(k)) { seen.add(k); uniq.push(f); } });
      return { tier: 'text', fields: uniqueKeys(uniq.slice(0, 60)) };
    }
    return { tier: 'scanned', fields: [] };
  }

  PFS.detect = { detectFields };
})(window);
