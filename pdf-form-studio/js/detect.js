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
    // a label ends with a colon, optionally followed by a required marker ("*").
    // up to 64 chars so full-line labels ("כתובת מלאה (רחוב, עיר, מיקוד):") count.
    return t.length > 0 && t.length < 64 && /[:：׃]\s*[*＊]?\s*$/.test(t);
  };
  const isUnderscores = (s) => /_{3,}/.test(s || '');
  // dot leaders ("שם מלא ........") are as common as underscores on official
  // Israeli forms; a run of ≥4 dots or an ellipsis run marks a fill-in blank.
  const isDotLeader = (s) => /\.{4,}|…{1,}/.test(s || '');
  const isBlankRun = (s) => isUnderscores(s) || isDotLeader(s);
  // strip a leading field number ("3." / "3)" / "3．") so numbered forms yield
  // clean labels and keys ("3. שם משפחה" → "שם משפחה").
  const stripEnum = (s) => (s || '').replace(/^\s*\d{1,3}\s*[.)．]\s*/, '');
  function slug(label, i) {
    let t = stripEnum((label || '')).replace(/[:：׃]\s*$/, '').trim();
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

  // Merge fragmented text runs. Word/Office exporters often split one visual
  // word across items mid-word ("תפ"+"קיד"), which turns labels into garbage
  // ("קיד") and hides colon-endings from the label detector. Consecutive items
  // on the same baseline with (almost) no horizontal gap are one logical run —
  // pdf.js yields them in content order, so plain concatenation keeps the
  // logical text right for RTL too.
  function mergeFragments(raw) {
    const out = [];
    for (const b of raw) {
      const prev = out[out.length - 1];
      if (prev) {
        const fh = Math.max(prev.fontH, b.fontH);
        if (Math.abs(b.yBase - prev.yBase) < fh * 0.4) {
          // disjoint distance between the two spans (negative = bidi overlap)
          const gap = Math.max(b.x - (prev.x + prev.w), prev.x - (b.x + b.w));
          // a run that already reads "label: ____" is a COMPLETE unit; a NEW
          // blank-run arriving then belongs to the NEXT label on the line
          // ("חתימת המאשר: ___ חותמת המוסד: ___" must stay two fields). Letter
          // fragments still merge — they are the same label's continuation
          // (visual-order emitters deliver label pieces after its blank).
          const complete = /[:：׃]\s*[_.．…]{3,}\s*$/.test(prev.str) && isBlankRun(b.str);
          // blank runs are STRUCTURAL (they mark where the answer goes) —
          // never glue them onto letter fragments: '____'+'מו:' used to melt
          // into one giant box and the blank's geometry was lost to the
          // field-band logic. Blank↔blank still merges (dashed runs).
          const mixed = isBlankRun(prev.str.trim()) !== isBlankRun(b.str.trim());
          if (!complete && !mixed && gap < fh * 0.3 && gap > -fh * 1.2) {
            // Concatenation order is decided by GEOMETRY, not array order:
            // some exporters emit fragments logically, others visually
            // (left→right) — same document, different blocks. For Hebrew the
            // fragment further RIGHT is logically earlier; for Latin, further
            // LEFT. This reassembles both emission styles correctly.
            const nextIsLeft = (b.x + b.w / 2) < (prev.x + prev.w / 2);
            const rtlPair = hasHebrew(prev.str) || hasHebrew(b.str);
            const append = rtlPair ? nextIsLeft : !nextIsLeft;
            // a visible gap between fragments is a space the splitter ate
            const sp = gap > fh * 0.12 ? ' ' : '';
            prev.str = append ? prev.str + sp + b.str : b.str + sp + prev.str;
            const x0 = Math.min(prev.x, b.x), x1 = Math.max(prev.x + prev.w, b.x + b.w);
            prev.x = x0; prev.w = x1 - x0;
            prev.top = Math.min(prev.top, b.top);
            prev.fontH = fh;
            continue;
          }
        }
      }
      out.push(Object.assign({}, b));
    }
    return out;
  }

  function heuristicForPage(items, W, H, vp, startIndex) {
    const boxes = mergeFragments(items.filter((it) => it.str && it.str.trim()).map((it) => itemBox(it, vp)));
    const out = [];
    // empty tick targets: square checkboxes AND round radio bullets — Israeli
    // forms use both (☐ תושב / ○ זכר ○ נקבה). Filled variants (☑ ●) are skipped.
    // Round bullets denote single-choice (radio) options; squares are often
    // genuine multi-select, so only round ones are grouped as mutually exclusive.
    const SQUARE = /[☐□◻◼⬜❏❑]/;
    const ROUND = /[○◯⚪◦〇]/;
    const CHECKBOX = /[☐□◻◼⬜❏❑○◯⚪◦〇]/;
    // blank runs adjacent to a label get ADOPTED as that label's band; mark
    // them so they don't also emit their own (duplicate) borrowed-label field
    const adoptedBlanks = new Set();
    boxes.forEach((b) => {
      const label = b.str.trim();
      if (!isLabel(label) || isBlankRun(label)) return;
      const line = boxes.filter((o) => o !== b && Math.abs(o.yBase - b.yBase) < b.fontH * 0.7);
      if (hasHebrew(label)) {
        const left = line.filter((o) => (o.x + o.w) <= b.x + 2);
        const nearest = left.length ? left.reduce((a, c) => ((a.x + a.w) > (c.x + c.w) ? a : c)) : null;
        if (nearest && isBlankRun(nearest.str) && (b.x - (nearest.x + nearest.w)) < b.fontH * 3) adoptedBlanks.add(nearest);
      } else {
        const right = line.filter((o) => o.x >= b.x + b.w - 2);
        const nearest = right.length ? right.reduce((a, c) => (a.x < c.x ? a : c)) : null;
        if (nearest && isBlankRun(nearest.str) && (nearest.x - (b.x + b.w)) < b.fontH * 3) adoptedBlanks.add(nearest);
      }
    });
    boxes.forEach((b) => {
      const label = b.str.trim();
      if (adoptedBlanks.has(b)) return;   // its label already owns this band
      // an empty checkbox glyph → a tickable field, labelled by the rest of
      // its text (or the nearest word on the same line). Common on Israeli
      // digital forms ("☐ תושב ישראל").
      if (CHECKBOX.test(label)) {
        const rtl = hasHebrew(label);
        let text = label.replace(CHECKBOX, '').trim();
        if (!text) {
          const cy = b.top + b.fontH / 2;
          const line = boxes.filter((o) => o !== b && !CHECKBOX.test(o.str) && /[֐-׿؀-ۿA-Za-z]/.test(o.str) && Math.abs((o.top + o.fontH / 2) - cy) < b.fontH);
          const side = rtl ? line.filter((o) => o.x < b.x + 2) : line.filter((o) => o.x > b.x - 2);
          const pool = side.length ? side : line;
          const near = pool.sort((a, c) => Math.abs(a.x - b.x) - Math.abs(c.x - b.x))[0];
          if (near) text = near.str.trim();
        }
        const bx = rtl ? (b.x + b.w - b.fontH) : b.x;   // box sits at the reading start
        out.push({
          page: startIndex, fieldKey: slug('check_' + text, out.length),
          label: (text || 'סימון').replace(/[:：׃]\s*$/, '').trim(),
          fx: Math.max(0, bx) / W, fy: Math.max(0, b.top) / H,
          fw: b.fontH / W, fh: b.fontH / H, fontFrac: Math.max(0.02, b.fontH / H), type: 'check',
          radio: ROUND.test(label), _cy: b.top + b.fontH / 2, _rowH: b.fontH
        });
        return;
      }
      if (!isLabel(label) && !isBlankRun(label)) return;
      const sameLine = boxes.filter((o) => o !== b && Math.abs(o.yBase - b.yBase) < b.fontH * 0.7);
      // For a bare blank run, borrow the real label from the nearest text on
      // the same line (bidi sometimes splits "label: ____" into two items —
      // happens with Arabic and some Hebrew). Prefer the label to the RIGHT
      // (RTL) of the blank, else the nearest with letters.
      let displayLabel = label;
      const hasLetters = (s) => /[A-Za-z֐-׿؀-ۿ]/.test(s || '');
      if (isBlankRun(label)) {
        // "label: ____" carried in ONE item → take the pre-colon text as label
        const embedded = label.match(/^(.*?[:：׃])\s*[_.．…]{2,}\s*$/);
        if (embedded && hasLetters(embedded[1])) {
          displayLabel = embedded[1].trim();
        } else {
          const cand = sameLine.filter((o) => hasLetters(o.str) && !isBlankRun(o.str.trim()));
          const right = cand.filter((o) => o.x > b.x).sort((a, c) => a.x - c.x)[0];
          const chosen = right || cand.sort((a, c) => c.x - a.x)[0];
          if (chosen) displayLabel = chosen.str.trim();
        }
      }
      const rtl = hasHebrew(displayLabel);
      let fx, fw;
      let drawnBlank = false;   // the form drew its own answer line (____/....)
      const defW = Math.min(0.34 * W, W * 0.5);
      // real printed content (letters or digits) — as opposed to a blank run,
      // a lone required-asterisk, or a checkbox glyph
      const answerish = (s) => {
        const t = (s || '').trim();
        return (/[A-Za-z֐-׿؀-ۿ]|\d/.test(t)) && !/^[*＊]+$/.test(t) && !CHECKBOX.test(t) && !isBlankRun(t);
      };
      if (isBlankRun(label)) {
        drawnBlank = true;
        fx = b.x / W; fw = Math.max(b.w, 0.15 * W) / W;
      } else if (rtl) {
        // blank is to the LEFT of the label
        const labelLeft = b.x;
        const leftItems = sameLine.filter((o) => (o.x + o.w) <= labelLeft + 2);
        // the form drew the answer line itself? an adjacent underscore run IS
        // the field — adopt its exact extent (its own rect, not the gap to it)
        const nearest = leftItems.length ? leftItems.reduce((a, c) => ((a.x + a.w) > (c.x + c.w) ? a : c)) : null;
        if (nearest && isBlankRun(nearest.str) && (labelLeft - (nearest.x + nearest.w)) < b.fontH * 3) {
          drawnBlank = true;
          fx = nearest.x / W; fw = Math.max(20, nearest.w) / W;
        } else {
          // ALREADY ANSWERED: printed text right after the colon ("תאריך
          // התחלה: 03.09.2026" on a quote letter) — the document filled this
          // in itself; a field here would duplicate the printed data
          if (nearest && answerish(nearest.str) && (labelLeft - (nearest.x + nearest.w)) < b.fontH * 2) return;
          const leftBound = leftItems.length ? Math.max(...leftItems.map((o) => o.x + o.w)) : Math.max(0, labelLeft - defW);
          fx = leftBound / W; fw = Math.max(20, labelLeft - leftBound) / W;
        }
      } else {
        // blank is to the RIGHT of the label
        const labelRight = b.x + b.w;
        const rightItems = sameLine.filter((o) => o.x >= labelRight - 2);
        const nearest = rightItems.length ? rightItems.reduce((a, c) => (a.x < c.x ? a : c)) : null;
        if (nearest && isBlankRun(nearest.str) && (nearest.x - labelRight) < b.fontH * 3) {
          drawnBlank = true;
          fx = nearest.x / W; fw = Math.max(20, nearest.w) / W;
        } else {
          if (nearest && answerish(nearest.str) && (nearest.x - labelRight) < b.fontH * 2) return;
          const rightBound = rightItems.length ? Math.min(...rightItems.map((o) => o.x)) : Math.min(W, labelRight + defW);
          fx = labelRight / W; fw = Math.max(20, rightBound - labelRight) / W;
        }
      }
      // ANSWERED BELOW: a colon-label whose printed answer continues on the
      // next line ("סניפים:" then the address list). Only prose ALIGNED with
      // the label's reading edge counts — an answer continuation starts where
      // the label starts; unrelated text elsewhere on the next line doesn't.
      // Labels below are just the next question, drawn blanks stay fillable.
      if (!drawnBlank) {
        const alignedBelow = boxes.some((o) => {
          if (o === b || !answerish(o.str) || isLabel(o.str.trim())) return false;
          const dy = o.top - b.top;
          if (dy < b.fontH * 0.7 || dy > b.fontH * 2.0) return false;
          return rtl ? Math.abs((o.x + o.w) - (b.x + b.w)) < b.fontH * 1.5
                     : Math.abs(o.x - b.x) < b.fontH * 1.5;
        });
        if (alignedBelow) return;
      }
      const fontFrac = Math.min(0.03, (b.fontH * 0.95) / H);
      let fy = Math.max(0, b.top) / H;
      // "label above, blank below": a WIDE full-line colon-label leaves no room
      // for a same-line answer, so the value goes on the line beneath it. Gated
      // hard to avoid false positives — a plain colon-label with a normal blank
      // beside it keeps the same-line behaviour above.
      //   (1) real colon-label (not a bare blank run)
      //   (2) the computed same-line blank is tiny (< 8% width)
      //   (3) the label itself is wide (spans > 42% of the page)
      //   (4) the line directly below is CLEAR in the field's horizontal band
      if (!isBlankRun(label) && fw < 0.08 && (b.w / W) > 0.42) {
        const width = Math.min(defW, rtl ? (b.x + b.w) : (W - b.x));
        const bxPx = rtl ? (b.x + b.w - width) : b.x;
        const belowTop = b.top + b.fontH * 1.15;
        const belowMid = belowTop + b.fontH / 2;
        const conflict = boxes.some((o) => o !== b && hasLetters(o.str)
          && Math.abs((o.top + o.fontH / 2) - belowMid) < b.fontH * 0.8
          && o.x < bxPx + width && (o.x + o.w) > bxPx);
        if (!conflict && (belowTop + b.fontH) / H <= 1) {
          fx = bxPx / W; fw = width / W; fy = belowTop / H;
        }
      }
      // required marker: a '*' or "חובה" in/next to the label — a missing
      // required field is the usual reason a government form is bounced back
      // NUMBERED long "labels" are section HEADINGS ("3. הצהרת מוסד ההכשרה
      // המלמד קורס..."), not fields — a heading happily has empty space
      // beside it, so band width can't tell them apart; the number + a
      // sentence-length label can. RTL emitters write the number as '.3'
      // (dot first) or as a SEPARATE same-line item — cover all three.
      const numInLabel = /^\s*(?:\d+\s*[.)]|[.)]\s*\d+)/.test(displayLabel);
      const numBeside = sameLine.some((o) => /^\s*[.)]?\s*\d+\s*[.)]?\s*$/.test(o.str)
        && o.x >= b.x + b.w - b.fontH && (o.x - (b.x + b.w)) < b.fontH * 4);
      if ((numInLabel || numBeside) && stripEnum(displayLabel).replace(/\s+/g, ' ').length >= 20) return;
      const reqMark = /[*＊]|\(?\s*חובה\s*\)?|required/i;
      const required = reqMark.test(displayLabel) || sameLine.some((o) => /^[*＊]$/.test((o.str || '').trim()));
      const cleanLabel = stripEnum(displayLabel).replace(/[*＊]/g, '').replace(/\(?\s*חובה\s*\)?/g, '').replace(/[:：׃]\s*$/, '').replace(/\s+/g, ' ').trim();
      out.push({
        page: startIndex, fieldKey: slug(cleanLabel || displayLabel, out.length),
        label: cleanLabel || 'שדה',
        fx, fy, fw, fh: b.fontH / H, fontFrac, type: 'text', best: true, required
      });
    });
    // ---- table cells: header row above an empty input row ----
    // Government forms (משרד העבודה et al) lay fields out as tables: the label
    // sits in a header cell and the answer goes in the EMPTY cell beneath it —
    // no colon, no underscores, so the rules above never fire. Heuristic, gated
    // hard: a line made ONLY of 2+ short bare labels, where the band directly
    // below a label is clear of text, yields one field under each label.
    const headerish = (b) => {
      const t = b.str.trim();
      if (!t || t.length < 2 || t.length > 60) return false;
      if (isBlankRun(t) || CHECKBOX.test(t)) return false;
      if (/[:：׃]/.test(t)) return false;             // colon labels handled above
      if (!/[A-Za-z֐-׿؀-ۿ]/.test(t)) return false;
      if (t.split(/\s+/).length > 8) return false;     // sentences aren't headers
      if (/[.?!,;]$/.test(t)) return false;
      return true;
    };
    const lines = [];
    boxes.forEach((b) => {
      const ln = lines.find((L) => Math.abs(L.y - b.yBase) < b.fontH * 0.6);
      if (ln) { ln.items.push(b); } else lines.push({ y: b.yBase, items: [b] });
    });
    // tall header cells WRAP ("שם מנהל מוסד / ההכשרה"): the second line is a
    // continuation of the header, not a conflict and not its own header row
    lines.sort((a, b) => a.y - b.y);   // header line must precede its wrap line
    const consumedWraps = new Set();
    const findWrap = (b) => boxes.find((o) => o !== b && headerish(o) && !consumedWraps.has(o)
      && o.top > b.top && (o.top - (b.top + b.fontH)) < b.fontH * 0.9
      && o.x >= b.x - b.fontH && (o.x + o.w) <= b.x + b.w + b.fontH);
    lines.forEach((L) => {
      const own = L.items.filter((it) => !consumedWraps.has(it));
      if (!own.length) return;                       // a fully-consumed wrap line
      const heads = own.filter(headerish);
      if (heads.length < 2 || heads.length !== own.length) return; // pure header rows only
      heads.forEach((b) => {
        // absorb up to two wrapped continuation lines into the header
        let label = stripEnum(b.str).replace(/\s+/g, ' ').trim();
        let anchor = b;
        for (let w = 0; w < 2; w++) {
          const cont = findWrap(anchor);
          if (!cont) break;
          consumedWraps.add(cont);
          label = (label + ' ' + stripEnum(cont.str)).replace(/\s+/g, ' ').trim();
          anchor = cont;
        }
        const belowTop = anchor.top + anchor.fontH * 1.35;
        const belowMid = belowTop + anchor.fontH * 0.7;
        // the input band under the (full, unwrapped) label must be empty
        const conflict = boxes.some((o) => o !== b && o !== anchor && !consumedWraps.has(o) && o.str.trim()
          && Math.abs((o.top + o.fontH / 2) - belowMid) < anchor.fontH * 0.9
          && o.x < b.x + b.w + b.fontH && (o.x + o.w) > b.x - b.fontH);
        if (conflict || (belowTop + anchor.fontH * 1.2) / H > 1) return;
        const fw = Math.min((b.w * 1.5 + b.fontH) / W, 0.45);
        const rtl = hasHebrew(b.str);
        // RTL: the answer grows leftward from the label's right edge
        const fx = rtl ? Math.max(0, (b.x + b.w) / W - fw) : b.x / W;
        out.push({
          page: startIndex, fieldKey: slug(label, out.length), label,
          fx, fy: belowTop / H, fw, fh: (b.fontH * 1.1) / H,
          fontFrac: Math.min(0.03, (b.fontH * 0.95) / H), type: 'text'
        });
      });
    });

    // the reading order of the FORM is the filling order of the panel:
    // top-to-bottom, and within a line right-to-left (RTL forms)
    out.sort((a, c) => (a.page - c.page) || ((Math.abs(a.fy - c.fy) > 0.008) ? (a.fy - c.fy) : (c.fx - a.fx)));

    // radio grouping: round-bullet options sharing a line belong to one
    // question (e.g. "○ זכר   ○ נקבה") → mark them one mutually-exclusive group
    // so ticking one clears its siblings. Squares stay independent; a lone
    // radio gets no group (nothing to be exclusive with).
    const radios = out.filter((f) => f.radio);
    let gid = 0;
    radios.forEach((f) => {
      if (f.group) return;
      const line = radios.filter((o) => Math.abs(o._cy - f._cy) < (f._rowH || 10) * 0.8);
      if (line.length >= 2) { gid++; const g = startIndex + '_r' + gid; line.forEach((o) => { o.group = g; }); }
    });
    out.forEach((f) => { delete f._cy; delete f._rowH; });
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

  // heuristicForPage is exposed for the e2e suite (synthetic text items →
  // fields) so checkbox/label heuristics can be tested without a real PDF whose
  // embedded font carries glyphs the standard PDF fonts can't encode (e.g. ○).
  PFS.detect = { detectFields, heuristicForPage };
})(window);
