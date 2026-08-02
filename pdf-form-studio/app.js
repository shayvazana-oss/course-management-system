/* app.js — bootstrap & orchestration (classic script).
 * Uses global window.pdfjsLib (pdf.js v3 UMD) and configures its worker via a
 * flag set by the host page, then wires the toolbar, overlay manager, asset
 * library, templates, exporter, detection and fields panel (all on window.PFS).
 */
(function () {
'use strict';
const pdfjsLib = window.pdfjsLib;
const PFS = window.PFS;
// Served build sets PFS_WORKER_SRC → real Web Worker. Single-file build omits
// it and inlines the worker (window.pdfjsWorker) → main-thread, CSP-safe.
if (window.PFS_WORKER_SRC && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = window.PFS_WORKER_SRC;
}

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);
PFS.toast = function (msg, kind) {
  const wrap = $('toastWrap');
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  const ms = arguments.length > 2 && arguments[2] ? arguments[2] : 2200;
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, ms);
};

// ---------- state ----------
let dirty = false;
const markDirty = () => { dirty = true; scheduleAutoMemory(); };
// pwa.js asks before auto-reloading into a fresh deploy — unsaved work wins
PFS.isDirty = () => dirty;
// surface the deploy stamp so "which version am I running?" is answerable
try {
  const bt = document.getElementById('buildTag');
  if (bt) bt.textContent = 'גרסת אפליקציה: ' + (window.PFS_BUILD || 'dev');
  console.info('[fillo] build', window.PFS_BUILD || 'dev');
} catch (e) {}

// Automatic per-form memory: a short while after any edit, silently remember
// the current layout linked to this form's fingerprint. Next time the same
// form is opened it auto-applies (see openPdfFile) — no manual "save template".
let autoMemTimer = null;
function scheduleAutoMemory() {
  if (!currentFp || !templates) return;
  clearTimeout(autoMemTimer);
  autoMemTimer = setTimeout(() => {
    try {
      templates.autoSave(currentFp, currentFileName);
      const si = $('savedInd');
      if (si) { si.style.opacity = '1'; clearTimeout(si._t); si._t = setTimeout(() => { si.style.opacity = '0'; }, 1800); }
    } catch (e) {}
  }, 1500);
}

// ---------- undo / redo (snapshots of the overlay) ----------
let history = [], redo = [], restoring = false, snapT = null;
function snapState() {
  return JSON.stringify({ els: overlay.serialize(), pg: pdfView.getPageState ? pdfView.getPageState() : null });
}
function resetHistory() { history = [snapState()]; redo = []; updateUndoUI(); }
function scheduleSnap() { if (restoring) return; clearTimeout(snapT); snapT = setTimeout(snapshot, 300); }
function snapshot() {
  if (restoring) return;
  const s = snapState();
  if (history.length && history[history.length - 1] === s) return;
  history.push(s); if (history.length > 40) history.shift(); redo = [];
  updateUndoUI();
}
function restoreState(json) {
  restoring = true; clearTimeout(snapT);
  const st = JSON.parse(json);
  overlay.clearElements();
  overlay.applyModels(st.els || (Array.isArray(st) ? st : []));
  // restore page rotation/deletion/order too, so undo covers page operations
  if (st.pg && pdfView.setPageState) { pdfView.setPageState(st.pg); buildPageNav(); buildThumbnails(); }
  // The fields panel must SURVIVE an undo. It used to be cleared here and
  // never re-rendered — one Ctrl+Z wiped the whole "שדות שזוהו" workspace,
  // which is why undo felt broken. syncValues refreshes the rows from the
  // restored elements and re-links them (else the next keystroke duplicates).
  if (lastDet && lastDet.fields && lastDet.fields.length && fieldsPanel.syncValues) {
    fieldsPanel.syncValues(panelValueMap());
  } else {
    fieldsPanel.clear();
  }
  restoring = false; markDirty(); updateUndoUI();
}
function updateUndoUI() {
  const u = $('undoBtn'), r = $('redoBtn');
  if (u) u.disabled = history.length < 2;
  if (r) r.disabled = !redo.length;
}
function undo() {
  snapshot();   // flush any debounce-pending state so redo can bring it back
  if (history.length < 2) { PFS.toast('אין פעולה לביטול', 'ok', 1100); return; }
  redo.push(history.pop()); restoreState(history[history.length - 1]);
  PFS.toast('↩ הפעולה בוטלה', 'ok', 1100);
}
function redoAction() {
  if (!redo.length) return;
  const s = redo.pop(); history.push(s); restoreState(s);
  PFS.toast('↪ הפעולה שוחזרה', 'ok', 1100);
}

// ---------- calculated fields ----------
// Recompute every formula element from the current values of keyed fields.
// Guarded so setting a formula field's text can't re-enter and loop.
let computingFormulas = false;
function recomputeFormulas() {
  if (computingFormulas || !PFS.formula || !PFS.formula.resolve) return;
  const els = overlay.getElements();
  computingFormulas = true;
  try {
    // one shared resolver (also used by mail-merge); update the DOM per change
    const byModel = new Map(els.map((c) => [c.model, c]));
    PFS.formula.resolve(els.map((c) => c.model), (m) => {
      const c = byModel.get(m); if (!c) return;
      const inner = c.node.querySelector('.txt'); if (inner) inner.textContent = m.text;
      c.layout();
    });
  } finally { computingFormulas = false; }
}

// ---------- overlay manager ----------
const overlay = PFS.createOverlayManager({
  onChange: () => { recomputeFormulas(); markDirty(); scheduleSnap(); },
  // deleting from the canvas must clear the matching panel row too.
  // Deferred: radio exclusivity deletes a sibling MID-handler, and a sync at
  // that instant would see (and impose) a half-updated state.
  onDelete: () => { setTimeout(() => { try { fieldsPanel.syncValues(panelValueMap()); } catch (e) {} }, 0); },
  // click-to-fill: tapping an orange marker on the FORM jumps straight to its
  // input row — the form itself becomes the index, no hunting in a long list
  onMarkerClick: (f) => {
    activateTab('fill');
    if (isNarrow()) openPanel();
    fieldsPanel.focusField(f.fieldKey);
  },
  onSelect: (ctrl, count) => { renderProps(ctrl); updateAlignBar(count); },
  onPlacingChange: (on) => {
    // clear tool highlight when placement ends
    if (!on) document.querySelectorAll('.rail-btn.tool.active').forEach((b) => b.classList.remove('active'));
  }
});

// ---------- align / distribute bar (multi-select) ----------
function updateAlignBar(count) {
  const bar = $('alignBar'); if (!bar) return;
  const distributeReady = (overlay.getMulti && overlay.getMulti().length >= 3);
  bar.classList.toggle('hidden', !(count >= 2));
  if (count >= 2) $('alignCount').textContent = count + ' פריטים';
  bar.querySelectorAll('[data-align^="distribute"]').forEach((b) => { b.disabled = !distributeReady; b.style.opacity = distributeReady ? '' : '.4'; });
}
document.querySelectorAll('#alignBar .align-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const op = btn.dataset.align;
    const n = overlay.alignSelection(op);
    if (n) { markDirty(); updateAlignBar(overlay.getMulti().length); }
  });
});

// ---------- pdf view ----------
const pdfView = PFS.createPdfView({
  pdfjsLib,
  pagesEl: $('pages'),
  viewportEl: $('viewport'),
  overlay,
  standardFontDataUrl: window.PFS_STDFONTS || undefined,
  onZoom: (s) => { $('zoomLvl').textContent = Math.round(s * 100) + '%'; },
  onRotate: () => markDirty()
});

// ---------- assets & templates ----------
const assets = PFS.createAssetsLibrary({
  onPick: (kind, item) => armImagePlacement(kind, item)
});
const templates = PFS.createTemplates({
  getElements: () => overlay.serialize(),
  // applying a template replaces the current layout (avoids stacking duplicates)
  applyModels: (models) => { overlay.clearElements(); fieldsPanel.clear(); overlay.applyModels(models); },
  // page rotations & deletions travel with the template so a straightened/
  // trimmed form reopens the same way
  getRotations: () => pdfView.getRotations(),
  applyRotations: (r) => { if (r && Object.keys(r).length) pdfView.setRotations(r); },
  getRemovedPages: () => pdfView.getRemovedPages(),
  applyRemovedPages: (a) => { if (a && a.length) { pdfView.setRemovedPages(a); buildPageNav(); buildThumbnails(); } },
  getPageOrder: () => (pdfView.isReordered && pdfView.isReordered() ? pdfView.getPageOrder() : null),
  applyPageOrder: (o) => { if (o && o.length && pdfView.setPageOrder) { pdfView.setPageOrder(o); buildPageNav(); buildThumbnails(); } },
  afterApply: () => { markDirty(); closeModal('tmplModal'); }
});
const profiles = PFS.createDataProfiles();
const fieldsPanel = PFS.createFieldsPanel({
  overlay,
  ocrAvailable: () => !!(PFS.ocr && PFS.ocr.available()),
  onOcr: () => runOcr(),
  // learn choices the user makes by hand (gender, …) for future forms
  rememberChoice: (canon, value) => {
    try { const rc = PFS.store.get('remembered_choices', {}) || {}; rc[canon] = value; PFS.store.set('remembered_choices', rc); } catch (e) {}
  },
  // one-tap: drop the saved signature/stamp exactly on a detected line
  onPlaceSignature: (f) => placeAssetAtField('signature', f),
  onPlaceStamp: (f) => placeAssetAtField('stamp', f)
});
// test handle: the e2e suite drives these module-scoped singletons directly.
PFS.__test = { overlay, fieldsPanel, pdfView, fillAll, loadErrorMessage, setLastDet: (d) => { lastDet = d; }, snapshotNow: () => snapshot(), undo: () => undo(), redo: () => redoAction(), buildFlattenedBytes: () => buildFlattenedBytes(), rememberTextStyle: (m) => rememberTextStyle(m), getLastTextStyle: () => lastTextStyle, recomputeFormulas: () => recomputeFormulas(), resetForm: () => resetForm(), hasPageOps: () => hasPageOps(), placeReplacement: (p, fx, fy, fw, fh) => placeReplacement(p, fx, fy, fw, fh), renderBaseForFlatten: (i, s) => renderBaseForFlatten(i, s), openPdfFile: (f) => openPdfFile(f), openCompanion: (l) => openCompanion(l), getFp: () => currentFp, setCarry: (v) => { pendingCarry = v; }, clampDocScroll: () => clampDocScroll(), vaultPrefillFor: (d) => vaultPrefill(d), setStudent: (v) => { pendingStudent = v; }, snapFieldsToInk: (d) => snapFieldsToInk(d), normalizeFontSizes: (d) => normalizeFontSizes(d), uniformize: (t) => uniformizeHandwriting(t), produceCourseForm: (c, f, d) => produceCourseForm(c, f, d) };

async function runOcr() {
  if (!pdfView.hasDoc() || !(PFS.ocr && PFS.ocr.available())) return;
  const gen = loadGen;
  const body = document.getElementById('fieldsBody');
  PFS.toast('קורא את הטופס עם OCR… זה עלול לקחת כמה שניות', 'ok');
  try {
    const det = await PFS.ocr.runOcrDetect(pdfView.getDoc(), (done, total, stage) => {
      if (gen !== loadGen || !body) return;
      body.innerHTML = `<div class="hint">🔤 OCR — עמוד ${Math.min(done + 1, total)}/${total} (${stage === 'ocr' ? 'קורא' : 'מכין'})…</div>`;
    });
    if (gen !== loadGen) return;
    if (!det.fields.length) {
      fieldsPanel.show({ tier: 'scanned', fields: [] });
      PFS.toast('OCR לא זיהה שדות ברורים — נסו מילוי ידני', 'err');
      return;
    }
    lastDet = det;
    const nOcr = fieldsPanel.show(det, vaultPrefill(det));
    PFS.toast(nOcr ? `OCR זיהה ${det.fields.length} שדות — ${nOcr} מולאו אוטומטית מהפרטים שלך 🪄` : `OCR זיהה ${det.fields.length} שדות`, 'ok');
  } catch (e) {
    console.error('OCR failed', e);
    fieldsPanel.show({ tier: 'scanned', fields: [] });
    PFS.toast('OCR נכשל: ' + (e.message || e), 'err');
  }
}

// Smart-vault prefill: values for detected fields taken from the active
// profile, matched by meaning (vault.matchKey), skipping fieldKeys that
// already have elements on the form (e.g. restored by auto-memory).
let skipPrefillOnce = false;   // set by "clear form" — the user asked for empty
function vaultPrefill(det) {
  try {
    if (skipPrefillOnce) { skipPrefillOnce = false; return null; }
    if (!det || !det.fields) return null;
    const ap = profiles.active();
    // remembered choices (learned from manual ticks) fill gaps; an explicit
    // profile value always wins over a remembered one.
    const remembered = PFS.store.get('remembered_choices', {}) || {};
    const carry = pendingCarry; pendingCarry = null;   // one-shot
    const stu = pendingStudent; pendingStudent = null;   // one-shot
    // student values ride the same canon matching as the profile (a ת"ז column
    // fills every ת"ז-meaning field) and OUTRANK it — this form is THEIRS
    const base = Object.assign({}, remembered, ap && ap.values, stu || {});
    const skip = new Set(overlay.fieldKeys());
    // learned patterns: a value that keeps recurring fills itself (auto mode).
    // Lowest priority — an explicit profile value or carried value always wins.
    const patternAuto = {};
    if (PFS.patterns && PFS.patterns.suggest) {
      det.fields.forEach((f) => {
        if (f.type === 'check' || skip.has(f.fieldKey)) return;
        const sg = PFS.patterns.suggest(f);
        if (sg && sg.mode === 'auto') patternAuto[f.fieldKey] = sg.value;
      });
    }
    if (!Object.keys(base).length && !(carry && Object.keys(carry).length)
        && !Object.keys(patternAuto).length) return null;
    // profile/remembered fill first — then values carried from a linked form
    // (הצעת מחיר → נספח) override them: the appendix must mirror what was just
    // typed, not what the profile happens to say for the same meaning.
    const text = PFS.vault.matchValues(det.fields, base, skip);
    const checks = PFS.vault.matchChecks(det.fields, base, skip);
    // carry matches by exact wording only — synonym guessing across two
    // different forms produces confident-looking wrong fills (e.g. an
    // institution name landing in a person's "שם מלא")
    const carryText = (carry && Object.keys(carry).length) ? PFS.vault.matchValues(det.fields, carry, skip, { labelOnly: true }) : {};
    // bare dates are per-form variables — never carried; course-PERIOD dates
    // (תאריך תחילת/סיום הקורס) are deal facts and may flow
    det.fields.forEach((f) => {
      if (carryText[f.fieldKey] == null) return;
      if (PFS.vault.matchKey(f.label) !== 'date') return;
      if (/תחילת|התחלה|סיום/.test(f.label)) return;
      delete carryText[f.fieldKey];
    });
    return Object.assign({}, patternAuto, text, checks, carryText);
  } catch (e) { return null; }
}

/* snapFieldsToInk(det) — precision pass over detected TEXT fields.
 * Detection places values from text geometry alone; ruled forms disagree:
 * the answer belongs on its printed line, and in bordered tables it belongs
 * in the EMPTY cell — not on the header's text, and not above the cell's
 * top border. Per field this reads the page pixels and re-anchors:
 *   1. header glyphs at/under the field → first empty line-bounded gap BELOW
 *      those glyphs (the answer cell);
 *   2. otherwise a ruling line just below → text bottom rests on it;
 *   3. nothing found → geometry placement stands. */
function snapFieldsToInk(det) {
  if (!det || !det.fields || !det.fields.length) return 0;
  const views = pdfView.viewList ? pdfView.viewList() : [];
  let snapped = 0;
  det.fields.forEach((f) => {
    if (f.type !== 'text') return;
    const view = views[f.page];
    const canvas = view && view.canvas;
    if (!canvas || !canvas.width) return;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const W = canvas.width, H = canvas.height;
      const fw = f.fw || 0.2, fh = f.fh || 0.02;
      const fhPx = fh * H;
      const x0 = Math.max(0, Math.floor((f.fx + fw * 0.06) * W));
      const x1 = Math.min(W, Math.ceil((f.fx + fw * 0.94) * W));
      const yTop = Math.max(0, Math.floor((f.fy - fh * 0.5) * H));
      const yBot = Math.min(H, Math.ceil((f.fy + fh * 5.5) * H));
      const bw = x1 - x0, bh = yBot - yTop;
      if (bw < 12 || bh < 6) return;
      const img = ctx.getImageData(x0, yTop, bw, bh).data;
      // two thresholds: ruled lines are dark and dense; anti-aliased glyphs
      // live mostly in the mid-grays
      const cov = new Array(bh), inkCov = new Array(bh);
      for (let y = 0; y < bh; y++) {
        let dark = 0, ink = 0, n = 0;
        for (let x = 0; x < bw; x += 2) {
          const i = (y * bw + x) * 4;
          const lum = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
          if (lum < 130) dark++;
          if (lum < 185) ink++;
          n++;
        }
        cov[y] = dark / n; inkCov[y] = ink / n;
      }
      const isLine = (y) => cov[y] > 0.55;
      const isGlyph = (y) => !isLine(y) && inkCov[y] > 0.05;
      // glyph bands (>=2 consecutive glyph rows), line rows
      const glyphBands = [];
      for (let y = 0; y < bh; y++) {
        if (isGlyph(y)) {
          // merge ADJACENT rows only — a wider merge would absorb the 1px
          // anti-alias smears hugging a ruled line into a phantom "text" band
          if (glyphBands.length && y - glyphBands[glyphBands.length - 1].end <= 1) glyphBands[glyphBands.length - 1].end = y;
          else glyphBands.push({ start: y, end: y });
        }
      }
      // real text is at least a fifth of the text height tall
      const minBand = Math.max(2, Math.round(fhPx * 0.2));
      const fyRow = Math.round(fh * 0.5 * H);       // f.fy relative to yTop
      // printed GLYPHS inside the value's own render span? Ruled/underscore
      // lines don't count — a line inside the span is the anchor target, not
      // a collision (the blank's underline sits at the text's own baseline).
      const nearLineRow = (y) => isLine(y) || (y > 0 && isLine(y - 1)) || (y < bh - 1 && isLine(y + 1));
      // the span ENDS at the first ruled line below — text lives ABOVE its
      // underline, and on tightly-spaced forms the next line's ascenders
      // otherwise leak into the window and read as a collision
      let spanEnd = Math.min(bh, fyRow + Math.round(fhPx * 1.1));
      for (let y = Math.max(0, fyRow); y < spanEnd; y++) { if (isLine(y)) { spanEnd = y; break; } }
      let spanInk = false;
      for (let y = Math.max(0, fyRow); y < spanEnd; y++) {
        if (inkCov[y] > 0.05 && cov[y] <= 0.55 && !nearLineRow(y)) { spanInk = true; break; }
      }
      // UNDERLINE FIRST: a clean value span with a ruled line right below it
      // is an inline blank ("תפקיד: ____") — anchor to that line and stop.
      // An underscore run lives ONLY inside the blank; a table border runs on
      // far beyond it — so test whether the line continues outside the band.
      const lineExtends = (yRel) => {
        const yAbs = yTop + yRel;
        const probe = (px0, px1) => {
          if (px1 - px0 < 8) return false;
          try {
            const row = ctx.getImageData(px0, yAbs, px1 - px0, 1).data;
            let d = 0, n = 0;
            for (let i = 0; i < px1 - px0; i += 2) {
              const j = i * 4;
              if (0.299 * row[j] + 0.587 * row[j + 1] + 0.114 * row[j + 2] < 130) d++;
              n++;
            }
            return d / n > 0.6;
          } catch (e) { return false; }
        };
        const reach = Math.round(fhPx * 3);
        return probe(Math.max(0, x0 - reach), x0 - 4) || probe(x1 + 4, Math.min(W, x1 + reach));
      };
      let borderSeen = false;
      if (!spanInk) {
        for (let y = fyRow + Math.round(fhPx * 0.3); y < Math.min(bh, fyRow + Math.round(fhPx * 1.6)); y++) {
          if (!isLine(y)) continue;
          if (lineExtends(y)) { f.__snap = 'border@' + y; borderSeen = true; break; }   // table border
          const newFy = (yTop + y) / H - fh - 2 / H;
          f.__snap = 'underline@' + y;
          if (newFy > 0 && Math.abs(newFy - f.fy) <= fh * 1.6 && Math.abs(newFy - f.fy) > 0.5 / H) { f.fy = newFy; snapped++; }
          return;
        }
      }
      // obstructed (printed glyphs in the span) or sitting on a table border:
      // relocate to the FIRST white gap that can hold the text, searching from
      // the value's own position downward — deterministic regardless of how
      // the geometric guess drifted (glyph-band picking was one-row fragile)
      const nearGlyph = spanInk || borderSeen;

      const gapAt = (from) => {
        // first run of rows below `from` that is line-free, glyph-free and
        // tall enough to hold the text; bounded by lines/window
        let y = from;
        while (y < bh) {
          while (y < bh && (isLine(y) || inkCov[y] > 0.05)) y++;
          let g0 = y;
          while (y < bh && !isLine(y) && inkCov[y] <= 0.05) y++;
          if (y - g0 >= fhPx * 0.95) return { top: g0, bot: y - 1 };
        }
        return null;
      };

      if (nearGlyph) {
        const gap = gapAt(fyRow);
        f.__snap = (f.__snap || '') + '|cell gap' + (gap ? gap.top + '-' + gap.bot : 'none') + (spanInk ? ' spanInk' : '');
        if (!gap) return;
        const slack = (gap.bot - gap.top) - fhPx;
        const newFy = (yTop + gap.top + Math.max(1, Math.min(slack / 2, fhPx * 0.6))) / H;
        if (newFy > 0 && newFy + fh <= 1 && newFy > f.fy - fh) {
          f.fy = newFy; snapped++;
          // widen the field to the CELL's vertical borders: a long value gets
          // the whole cell instead of the guessed header-width (which forced
          // fitFont to shrink it — the "mismatched fonts" complaint)
          try {
            const gy0 = yTop + gap.top, gy1 = yTop + gap.bot;
            const rows = gy1 - gy0 + 1;
            const darkCol = (px) => {
              if (px < 0 || px >= W) return true;   // page edge counts as border
              const col = ctx.getImageData(px, gy0, 1, rows).data;
              let d = 0;
              for (let i = 0; i < rows; i++) {
                const j = i * 4;
                if (0.299 * col[j] + 0.587 * col[j + 1] + 0.114 * col[j + 2] < 130) d++;
              }
              return d / rows > 0.7;
            };
            const maxSpan = Math.round(W * 0.5);
            let L = Math.floor(f.fx * W), R = Math.ceil((f.fx + fw) * W);
            let steps = 0;
            // step 1px — a 2px stride jumps clean over 1px cell borders
            while (!darkCol(L - 1) && (R - L) < maxSpan && steps++ < 800) L -= 1;
            steps = 0;
            while (!darkCol(R + 1) && (R - L) < maxSpan && steps++ < 800) R += 1;
            const pad = 4;
            const nfx = (L + pad) / W, nfw = (R - L - pad * 2) / W;
            if (nfw > fw) { f.fx = nfx; f.fw = nfw; }
          } catch (e) { /* width stays as guessed */ }
        }
        return;
      }
      // classic underline: nearest line just below the text — but only when
      // it isn't a cell TOP border (no glyph band right beneath it)
      for (let y = fyRow + Math.round(fhPx * 0.35); y < Math.min(bh, fyRow + Math.round(fhPx * 2.3)); y++) {
        if (!isLine(y)) continue;
        const glyphBelow = glyphBands.some((g) => (g.end - g.start + 1) >= minBand && g.start > y && g.start - y <= fhPx * 2.2);
        if (glyphBelow) return;   // that's a table border with a header under it
        const newFy = (yTop + y) / H - fh - 2 / H;
        if (newFy > 0 && Math.abs(newFy - f.fy) <= fh * 1.6 && Math.abs(newFy - f.fy) > 0.5 / H) { f.fy = newFy; snapped++; }
        return;
      }
    } catch (e) { /* canvas read can fail — geometry placement stands */ }
  });
  return snapped;
}

/* one form = one handwriting: every detected text field gets the MEDIAN font
 * size. Per-field sizes (inherited from each header's glyph height) made
 * adjacent cells render at visibly different sizes. */
function normalizeFontSizes(det) {
  const txt = det.fields.filter((f) => f.type === 'text' && f.fontFrac);
  if (txt.length < 2) return;
  const sizes = txt.map((f) => f.fontFrac).sort((a, b) => a - b);
  const median = Math.min(0.022, Math.max(0.011, sizes[Math.floor(sizes.length / 2)]));
  // clamp to a ±15% band around the median: outliers get pulled into harmony
  // but each value still respects ITS line's local metrics (a hard flatten
  // rendered fills visibly larger than small-print sentences around them)
  const lo = median * 0.85, hi = median * 1.15;
  txt.forEach((f) => { f.fontFrac = Math.min(hi, Math.max(lo, f.fontFrac)); });
}

// ---- one handwriting across the whole document ----
// The uniform size lives in detection (normalizeFontSizes); this enforces it
// on the ELEMENTS too — fitFont shrinkage, manually-placed text, restored
// docs and per-element tweaks all drift, and a filled form with three text
// sizes reads sloppy. Comb-spaced text and ✓/✗ glyphs are exempt.
const isPlainTextEl = (c) => c.model && c.model.type === 'text' && !c.model.letterSpacing
  && c.model.kind !== 'check' && c.model.kind !== 'cross';
function docUniformSize() {
  if (lastDet && lastDet.fields) {
    const t = lastDet.fields.find((f) => f.type === 'text' && f.fontFrac);
    if (t) return t.fontFrac;             // detection already normalized these
  }
  const sizes = overlay.getElements().filter(isPlainTextEl).map((c) => c.model.fontFrac).sort((a, b) => a - b);
  return sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0.016;
}
function uniformizeHandwriting(taggedOnly) {
  const uni = docUniformSize();
  const lo = uni * 0.85, hi = uni * 1.15;
  let changed = 0;
  overlay.getElements().forEach((c) => {
    if (!isPlainTextEl(c)) return;
    if (taggedOnly && !c.model.fieldKey) return;
    const target = Math.min(hi, Math.max(lo, c.model.fontFrac || uni));
    if (Math.abs((c.model.fontFrac || 0) - target) < 0.0005) return;
    const oldW = c.model.fw;              // layout keeps this measured
    c.model.fontFrac = target;
    c.layout();
    // a right-aligned (Hebrew) value must keep its RIGHT edge planted
    if (c.model.align === 'right' && isFinite(oldW)) { c.model.fx += (oldW - c.model.fw); c.layout(); }
    changed++;
  });
  if (changed) { markDirty(); scheduleSnap(); }
  return changed;
}
PFS.uniformizeHandwriting = uniformizeHandwriting;
PFS.docUniformSize = docUniformSize;

// heal learning slots poisoned before the bare-'שם' guard existed
try { const n = PFS.patterns.purgePersonValues(); if (n) console.info('[patterns] purged', n, 'person-name values from learned slots'); } catch (e) {}

/* sweepNameLeaks() — heal DOCUMENTS saved with the historical leak: a text
 * element carrying a profile person-name while tagged to a field whose label
 * no longer maps to a person canon ('שם הקורס' etc.) is the leak restored
 * from auto-memory. Remove it (undo can bring it back). */
function sweepNameLeaks() {
  const profs = PFS.store.get('profiles', []) || [];
  const names = new Set();
  profs.forEach((p) => ['שם מלא', 'שם פרטי', 'שם משפחה'].forEach((k) => {
    const v = p.values && p.values[k];
    if (v && String(v).trim().length >= 2) names.add(PFS.vault.norm(v));
  }));
  if (!names.size) return 0;
  let removed = 0;
  overlay.getElements().slice().forEach((c) => {
    const m = c.model;
    if (m.type !== 'text' || !m.fieldKey || !m.text) return;
    if (!names.has(PFS.vault.norm(m.text))) return;
    const canon = PFS.vault.matchKey(m.fieldKey);
    // person canons legitimately hold a person's name; anything else is the leak
    if (canon === 'full_name' || canon === 'first_name' || canon === 'last_name') return;
    overlay.deleteCtrl(c);
    removed++;
  });
  if (removed) {
    PFS.toast(`🧹 הוסרו ${removed} שדות שמולאו בטעות בשם מהפרופיל (Ctrl+Z מחזיר)`, 'ok', 6000);
    markDirty();
  }
  return removed;
}

async function runDetection() {
  if (!pdfView.hasDoc()) return;
  const gen = loadGen;
  const btn = $('detectBtn'); const prev = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="ic">⏳</span> מזהה…';
  try {
    const det = await PFS.detect.detectFields(pdfView.getDoc());
    if (gen !== loadGen) return; // another PDF loaded meanwhile — drop stale result
    try { const n = snapFieldsToInk(det); if (n) console.info('[snap] aligned', n, 'fields to ruled lines'); } catch (e) {}
    normalizeFontSizes(det);
    lastDet = det;
    try { if (sweepNameLeaks()) fieldsPanel.syncValues(panelValueMap()); } catch (e) {}
    const nAuto = fieldsPanel.show(det, vaultPrefill(det));
    if (det.tier === 'scanned') PFS.toast('טופס סרוק — זיהוי אוטומטי לא זמין', 'err');
    else if (nAuto) PFS.toast(`🪄 ${nAuto} שדות מולאו אוטומטית מהפרטים שלך — בדקו ותקנו במידת הצורך`, 'ok');
    else if (det.fields.length) PFS.toast(`זוהו ${det.fields.length} שדות`, 'ok');
    else PFS.toast('לא זוהו שדות אוטומטית', 'err');
  } catch (e) {
    console.warn('detect failed', e); PFS.toast('זיהוי השדות נכשל', 'err');
  } finally { btn.disabled = false; btn.innerHTML = prev; }
}

// populate the suggested-keys datalist
(function fillDatalist() {
  const dl = $('fieldKeyList');
  PFS.SUGGESTED_FIELDS.forEach((s) => {
    const o = document.createElement('option'); o.value = s.key; o.label = s.label; dl.appendChild(o);
  });
})();

// =====================================================================
//  Loading a PDF
// =====================================================================
let loadGen = 0; // bumped on every load so in-flight detection can bail
let lastDet = null; // most recent detection result (for Fill-All signature/stamp lines)
let attachments = []; // extra pages (photos of ID etc.) appended on export
let currentFp = null; // fingerprint of the currently-loaded form
// fieldKey → value map of everything currently on the overlay (panel sync)
function panelValueMap() {
  const map = {};
  overlay.getElements().forEach((c) => {
    const m = c.model; if (!m.fieldKey) return;
    if (m.type === 'text') map[m.fieldKey] = m.text || '';
    else if (m.kind === 'check' || m.kind === 'cross') map[m.fieldKey] = true;
  });
  return map;
}

let pendingCarry = null; // values captured from a form before jumping to its linked companion
let pendingStudent = null; // one-shot student values (course binder "מלא עבור…")

// =====================================================================
//  Linked companions (נספחים) — quote → appendix chains
// =====================================================================
function renderCompanions() {
  const card = $('compCard'), list = $('compList');
  if (!card || !list) return;
  if (!pdfView.hasDoc()) { card.style.display = 'none'; return; }
  card.style.display = '';
  const links = (PFS.companions && currentFp) ? PFS.companions.listFor(currentFp) : [];
  list.innerHTML = '';
  links.forEach((ln) => {
    const row = document.createElement('div');
    row.className = 'row'; row.style.alignItems = 'center'; row.style.gap = '6px';
    const name = document.createElement('span');
    name.textContent = '📎 ' + ln.name;
    name.style.cssText = 'flex:1;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const fill = document.createElement('button');
    fill.className = 'btn sm'; fill.textContent = 'מלא עכשיו';
    fill.addEventListener('click', () => openCompanion(ln));
    const del = document.createElement('button');
    del.className = 'btn sm'; del.style.color = 'var(--danger)'; del.textContent = '✕'; del.title = 'הסר קישור';
    del.addEventListener('click', async () => { await PFS.companions.remove(ln.id); renderCompanions(); });
    row.append(name, fill, del);
    list.appendChild(row);
  });
}

// open a linked companion pre-filled with the CURRENT form's values
async function openCompanion(link) {
  try {
    const bytes = await PFS.companions.getBytes(link.id);
    if (!bytes) { PFS.toast('קובץ הנספח לא נמצא באחסון — קשרו אותו מחדש', 'err'); return; }
    // capture what was typed here BEFORE the document switches — and ALSO
    // read the document's PRINTED text: a price quote arrives with the deal
    // facts already in it (עבור פלוני ת"ז..., לקורס...), nothing typed
    const typed = overlay.currentValues();
    let extracted = {};
    try {
      const t = await readDocText();
      const ea = extractQuoteMap(t.a), eb = extractQuoteMap(t.b);
      extracted = Object.assign({}, eb, ea);   // content-order wins ties
    } catch (e) {}
    // the person rides canon matching (bridges any wording); the rest rides
    // exact-label carry; anything the user TYPED beats what was printed
    const person = {};
    ['שם מלא', 'תעודת זהות', 'טלפון'].forEach((k) => { if (extracted[k]) person[k] = extracted[k]; });
    pendingStudent = Object.keys(person).length ? person : null;
    pendingCarry = Object.assign({}, extracted, typed);
    const got = Object.keys(extracted);
    if (got.length) PFS.toast('📖 נשאבו מהמסמך: ' + [...new Set(got)].slice(0, 5).join(', '), 'ok', 5000);
    await openPdfFile(new File([bytes], link.name + '.pdf', { type: 'application/pdf' }));
  } catch (e) {
    pendingCarry = null;
    console.error(e); PFS.toast('פתיחת הנספח נכשלה: ' + (e.message || e), 'err');
  }
}

// after a successful export, offer the linked companion — the moment the data
// is complete is exactly when the appendix should be produced
async function offerCompanions() {
  if (!PFS.companions || !currentFp) return;
  const links = PFS.companions.listFor(currentFp);
  if (!links.length) return;
  const ln = links[0];
  if (await PFS.ui.confirm('נספח מקושר 🔗', 'לטופס הזה מקושר "' + ln.name + '".\nלמלא אותו עכשיו אוטומטית עם הנתונים שמילאת?')) {
    openCompanion(ln);
  }
}

$('compAddBtn') && $('compAddBtn').addEventListener('click', () => {
  if (!currentFp) { PFS.toast('פתח קודם את הטופס שאליו רוצים לקשר נספח', 'err'); return; }
  $('compInput').click();
});
$('compInput') && $('compInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.type !== 'application/pdf') { PFS.toast('בחר קובץ PDF', 'err'); return; }
  try {
    const rec = await PFS.companions.add({
      ownerFp: currentFp, ownerName: currentFileName,
      name: f.name, bytes: await f.arrayBuffer()
    });
    renderCompanions();
    renderExportCompanions();
    PFS.toast('"' + rec.name + '" קושר לטופס — יוצע אוטומטית בכל מילוי ✓', 'ok');
  } catch (err) { PFS.toast(err.message || 'קישור הנספח נכשל', 'err'); }
});

async function openPdfFile(file) {
  if (!file || file.type !== 'application/pdf') { PFS.toast('בחר קובץ PDF', 'err'); return; }
  const buf = await file.arrayBuffer();
  try {
    // start fresh: drop any elements/fields/merge state from a previous document
    loadGen++;
    const myGen = loadGen;
    lastDet = null;
    fieldsPanel.resetAutoFilled && fieldsPanel.resetAutoFilled();
    attachments = [];
    updateAttachBadge();
    overlay.clearElements();
    fieldsPanel.clear();
    resetHistory();
    mergeParsed = null;
    $('dropzone').style.display = 'none';
    await pdfView.load(buf);
    // a phone screen never fits an A4 at 100% — start fitted so the whole
    // page is visible and fingers pan less
    if (window.innerWidth < 720) { try { pdfView.fit(); } catch (e) {} }
    dirty = false;
    $('docbar').classList.remove('hidden');
    $('fname').textContent = file.name;
    $('exportBtn').disabled = false;
    $('tmplBtn').disabled = false;
    $('mergeBtn').disabled = false;
    $('detectBtn').disabled = false;
    $('clearBtn').disabled = false;
    $('enhanceBtn').disabled = false;
    $('rotateBtn').disabled = false;
    $('attachBtn').disabled = false;
    $('deleteBtn') && ($('deleteBtn').disabled = false);
    $('exportFlatBtn') && ($('exportFlatBtn').disabled = false);
    $('fillAllBtn').disabled = false;
    currentFileName = file.name.replace(/\.pdf$/i, '');
    PFS.recent && PFS.recent.save(file.name, buf.slice(0));
    PFS.toast('הטופס נטען — ' + pdfView.numPages() + ' עמודים', 'ok');
    // page navigator: only worth showing on multi-page docs
    buildPageNav();
    buildThumbnails();
    updateHwStatus();
    currentFp = null;
    try { currentFp = await PFS.fingerprint.compute(pdfView.getDoc()); } catch (e) {}
    renderCompanions();
    // a recognised form with a linked appendix announces itself right away
    if (loadGen === myGen && PFS.companions && currentFp) {
      const links = PFS.companions.listFor(currentFp);
      if (links.length) PFS.toast('🔗 מקושר לטופס זה: "' + links[0].name + '" — אציע למלא אותו אחרי הייצוא', 'ok', 5000);
    }
    const match = (loadGen === myGen) && currentFp && templates.findMatch(currentFp);
    if (match) {
      templates.apply(match.tpl.id);
      PFS.toast('כבר מילאת את הטופס הזה — שחזרתי את מה שמילאת ✓', 'ok');
      // one-click: also fill the active profile into the (now tagged) fields
      const ap = profiles.active();
      if (ap && ap.values && Object.keys(ap.values).length) {
        const n = smartFill(ap.values);
        if (n) PFS.toast(`מולאו אוטומטית ${n} שדות מהפרופיל`, 'ok');
      }
    }
    runDetection();
    // first-run guided tour — now that every zone on screen is alive
    PFS.tour && PFS.tour.maybeStart();
  } catch (e) {
    console.error(e);
    PFS.toast(loadErrorMessage(e), 'err', 5000);
    if (!pdfView.hasDoc()) { $('dropzone').style.display = ''; $('docbar').classList.add('hidden'); }
  }
}
// Turn a pdf.js load error into an actionable Hebrew message. Password-protected
// gov PDFs and corrupt files are common; a generic "failed" leaves users stuck.
function loadErrorMessage(e) {
  const name = (e && e.name) || '';
  const m = (e && e.message) || '';
  if (name === 'PasswordException' || /password/i.test(m)) {
    return 'הקובץ מוגן בסיסמה. הסירו את ההגנה (למשל פִּתחו והדפיסו ל-PDF חדש) ונסו שוב 🔒';
  }
  if (name === 'InvalidPDFException' || /invalid pdf|corrupt|structure|xref/i.test(m)) {
    return 'הקובץ פגום או אינו PDF תקין — נסו קובץ אחר';
  }
  return 'טעינת ה-PDF נכשלה — ודאו שזהו קובץ PDF תקין';
}
let currentFileName = 'filled';

// html/body are overflow:hidden by design — the app is a fixed 100vh shell.
// Browsers still let programmatic focus/scrollIntoView OFFSET them, and then
// the user can never scroll back: the toolbar sits clipped off-screen and the
// app looks "stuck". Clamp any such drift the moment it happens.
function clampDocScroll() {
  const d = document.scrollingElement || document.documentElement;
  if (d.scrollTop) d.scrollTop = 0;
  if (d.scrollLeft) d.scrollLeft = 0;
  if (document.body.scrollTop) document.body.scrollTop = 0;
  if (document.body.scrollLeft) document.body.scrollLeft = 0;
}
window.addEventListener('scroll', clampDocScroll, { passive: true });
document.addEventListener('focusin', () => setTimeout(clampDocScroll, 0));
clampDocScroll();

// =====================================================================
//  Tools
// =====================================================================
const TEXT_TOOLS = { text: 'text', check: 'check', cross: 'cross', date: 'date' };
// rect covers are drag-drawn (marquee), not click-placed like the text tools
const RECT_TOOLS = { whiteout: 1, redact: 1, highlight: 1 };
let stickyTools = false; // "repeat mode": keep a tool armed for multiple placements
// remember the last text style so filling a form stays visually consistent
let lastTextStyle = null;
function rememberTextStyle(m) { lastTextStyle = { fontFrac: m.fontFrac, color: m.color, bold: !!m.bold, align: m.align }; }
$('stickyBtn') && $('stickyBtn').addEventListener('click', () => {
  stickyTools = !stickyTools;
  $('stickyBtn').classList.toggle('active', stickyTools);
  PFS.toast(stickyTools ? 'מצב רצף פעיל — הכלי יישאר פעיל להנחה מרובה (Esc לעצירה)' : 'מצב רצף כבוי', 'ok', 1800);
});

function activateTool(btn, tool) {
  document.querySelectorAll('.rail-btn.tool').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  if (tool === 'handwriting') { btn.classList.remove('active'); startHandwritingFlow(); return; }
  if (tool === 'draw') {
    btn.classList.remove('active');
    if (!pdfView.hasDoc()) { PFS.toast('פתח קודם קובץ PDF', 'err'); return; }
    openSignaturePad('draw'); return;
  }
  if (tool === 'signature' || tool === 'stamp') {
    // handled by their own flows below
    btn.classList.remove('active');
    tool === 'signature' ? startSignatureFlow() : startStampFlow();
    return;
  }
  // rect covers + replace: drag over the page to draw the exact area. Whiteout
  // and replace auto-match the paper colour underneath so the cover is seamless;
  // replace also drops a fresh text box in place, ready to type the new value.
  if (RECT_TOOLS[tool] || tool === 'replace') {
    overlay.setPlacing({
      rect: true, sticky: stickyTools, defW: 0.2, defH: 0.03,
      createRect: (pageIndex, fx, fy, fw, fh) => {
        if (tool === 'replace') { placeReplacement(pageIndex, fx, fy, fw, fh); return; }
        const extra = { fx, fy, fw, fh };
        // whiteout is a background-matched erase: remember that, so the export
        // reconstructs the paper from its surroundings instead of stamping a
        // flat colour (which shows as a rectangle at full resolution)
        if (tool === 'whiteout') {
          extra.auto = true;
          const bg = pdfView.sampleBg(pageIndex, fx, fy, fw, fh); if (bg) extra.color = bg;
        }
        overlay.addModelAt(tool, pageIndex, extra);
      }
    });
    return;
  }
  // text-like: arm placement — click on a page to drop it. In "repeat mode" the
  // tool stays armed so you can place many (checkmarks, boxes) fast; Esc stops.
  overlay.setPlacing({
    sticky: stickyTools,
    create: (pageIndex, fx, fy) => {
      const extra = {};
      if (tool === 'date') extra.text = new Date().toLocaleDateString('he-IL');
      // new text/date inherits the last-used style so the form stays consistent
      if ((tool === 'text' || tool === 'date') && lastTextStyle) Object.assign(extra, lastTextStyle);
      else if (tool === 'text' || tool === 'date') extra.fontFrac = docUniformSize();
      const ctrl = overlay.addElementAt(TEXT_TOOLS[tool], pageIndex, fx, fy, extra);
      return null; // addElementAt already instantiated
    }
  });
}

// "Replace" — one gesture over existing content: cover it with a paper-matched
// box (seamless erase), then drop an empty text box in the same spot, focused so
// the new value can be typed immediately. The result reads like edited-in-place.
function placeReplacement(pageIndex, fx, fy, fw, fh) {
  const clamp = PFS.clamp;
  const bg = pdfView.sampleBg(pageIndex, fx, fy, fw, fh) || '#ffffff';
  overlay.addModelAt('whiteout', pageIndex, { fx, fy, fw, fh, color: bg, auto: true });
  // size the text to the covered box, vertically centred within it
  const fontFrac = clamp(fh * 0.62, 0.01, 0.06);
  const textH = fontFrac * 1.2;
  const extra = {
    fx, fy: clamp(fy + (fh - textH) / 2, 0, 1 - textH),
    fw, fh: textH, fontFrac, align: 'right'
  };
  if (lastTextStyle) { extra.color = lastTextStyle.color; extra.bold = !!lastTextStyle.bold; }
  overlay.addModelAt('text', pageIndex, extra, true);
}

function armImagePlacement(kind, item) {
  if (!pdfView.hasDoc()) { PFS.toast('פתח קודם קובץ PDF', 'err'); return; }
  overlay.setPlacing({
    sticky: false,
    create: (pageIndex, fx, fy) => {
      overlay.addElementAt('image', pageIndex, fx, fy, {
        imgUrl: item.url, aspect: item.aspect || (item.w / item.h) || 1,
        fw: 0.22, fh: 0.22 / (item.aspect || (item.w / item.h) || 1), kind
      });
      return null;
    }
  });
  PFS.toast('לחץ על הטופס כדי למקם', 'ok');
}

// =====================================================================
//  Signature & stamp flows
// =====================================================================
function startStampFlow() {
  // upload a new stamp, or if some exist just hint to pick from the library
  pendingImageKind = 'stamp';
  $('imgInput').click();
}
function startSignatureFlow() {
  // open the drawing pad (upload is available via the sidebar button too)
  openSignaturePad();
}

let pendingImageKind = 'stamp';
async function handleImageUpload(file) {
  try {
    const removeWhite = true;
    const res = await PFS.imageTools.processUpload(file, { removeWhite });
    const item = assets.add(pendingImageKind, { url: res.url, w: res.w, h: res.h });
    armImagePlacement(pendingImageKind, item);
    PFS.toast((pendingImageKind === 'stamp' ? 'החותמת' : 'החתימה') + ' נוספה לספרייה', 'ok');
  } catch (e) {
    PFS.toast(e.message || 'העלאת התמונה נכשלה', 'err');
  }
}

// ---- signature pad modal ----
let sigPad = null, sigMode = 'signature';
function openSignaturePad(mode) {
  sigMode = mode || 'signature';
  openModal('sigModal');
  const canvas = $('sigCanvas');
  if (!sigPad) {
    sigPad = PFS.imageTools.signaturePad(canvas);
    $('sigColor').addEventListener('input', (e) => sigPad.setColor(e.target.value));
    $('sigWidth').addEventListener('input', (e) => sigPad.setWidth(parseFloat(e.target.value)));
    $('sigClear').addEventListener('click', () => sigPad.clear());
  }
  requestAnimationFrame(() => { sigPad.resize(); sigPad.clear(); sigPad.setColor($('sigColor').value); });
}
$('sigSave').addEventListener('click', () => {
  if (!sigPad || sigPad.isEmpty()) { PFS.toast('צייר חתימה קודם', 'err'); return; }
  const { url, w, h } = sigPad.toDataUrl();
  closeModal('sigModal');
  if (sigMode === 'draw') {
    // freehand markup (circle/arrow/note) — placed as a one-off image,
    // NOT saved to the signature library
    armImagePlacement('drawing', { url, w, h });
    PFS.toast('לחץ על הטופס כדי למקם את הסימון', 'ok');
  } else {
    const item = assets.add('signature', { url, w, h });
    armImagePlacement('signature', item);
    PFS.toast('החתימה נשמרה', 'ok');
  }
});
$('sigCancel').addEventListener('click', () => closeModal('sigModal'));

// =====================================================================
//  Properties panel (edit selected element)
// =====================================================================
function renderProps(ctrl) {
  const panel = $('propsPanel'), body = $('propsBody');
  if (!ctrl) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  // reveal the selected element's editor: the fill tab holds the props card
  activateTab('fill');
  if (isNarrow()) openPanel();
  const m = ctrl.model;
  body.innerHTML = '';

  if (m.type === 'text') {
    // text content
    const f1 = field('טקסט');
    const input = document.createElement('input'); input.type = 'text'; input.value = m.text || '';
    input.addEventListener('input', () => { m.text = input.value; ctrl.layout(); markDirty(); });
    f1.appendChild(input); body.appendChild(f1);

    // field name (for auto-fill from profiles & mail-merge)
    const fKey = field('שם שדה (למילוי אוטומטי)');
    const keyIn = document.createElement('input'); keyIn.type = 'text'; keyIn.value = m.fieldKey || '';
    keyIn.placeholder = 'למשל: full_name, id, amount';
    keyIn.setAttribute('list', 'fieldKeyList');
    keyIn.addEventListener('input', () => { m.fieldKey = keyIn.value.trim(); markDirty(); });
    fKey.appendChild(keyIn); body.appendChild(fKey);

    // size + color row
    const rowSC = document.createElement('div'); rowSC.className = 'row';
    const fSize = field('גודל'); const size = document.createElement('input');
    size.type = 'range'; size.min = '6'; size.max = '80'; size.step = '1';
    size.value = Math.round(m.fontFrac * 1000);
    size.addEventListener('input', () => { m.fontFrac = parseInt(size.value, 10) / 1000; ctrl.layout(); markDirty(); rememberTextStyle(m); });
    fSize.appendChild(size); fSize.style.flex = '1';
    const fCol = field('צבע'); const col = document.createElement('input');
    col.type = 'color'; col.value = toHex(m.color);
    col.addEventListener('input', () => { m.color = col.value; ctrl.layout(); markDirty(); rememberTextStyle(m); });
    fCol.appendChild(col);
    rowSC.append(fSize, fCol); body.appendChild(rowSC);

    // letter-spacing — spread digits/letters to line up with per-character boxes
    const fLS = field('מרווח אותיות (ליישור לתאים)');
    const ls = document.createElement('input'); ls.type = 'range'; ls.min = '0'; ls.max = '250'; ls.step = '5';
    ls.value = Math.round((m.letterSpacing || 0) * 100);
    ls.addEventListener('input', () => { m.letterSpacing = parseInt(ls.value, 10) / 100; ctrl.layout(); markDirty(); });
    fLS.appendChild(ls); body.appendChild(fLS);

    // bold + align
    const rowBA = document.createElement('div'); rowBA.className = 'row';
    const bold = document.createElement('button'); bold.className = 'btn sm' + (m.bold ? ' active tool' : '');
    bold.textContent = 'מודגש'; bold.style.fontWeight = '700';
    bold.addEventListener('click', () => { m.bold = !m.bold; ctrl.layout(); markDirty(); rememberTextStyle(m); renderProps(ctrl); });
    const seg = document.createElement('div'); seg.className = 'seg';
    [['right', '⇥'], ['center', '≡'], ['left', '⇤']].forEach(([a, label]) => {
      const b = document.createElement('button'); b.textContent = label; b.title = a;
      if (m.align === a) b.classList.add('on');
      b.addEventListener('click', () => { m.align = a; ctrl.layout(); markDirty(); rememberTextStyle(m); renderProps(ctrl); });
      seg.appendChild(b);
    });
    rowBA.append(bold, seg); body.appendChild(rowBA);

    // calculated field: a formula over other tagged fields (=[qty]*[price])
    const fForm = field('נוסחה (חישוב אוטומטי) — למשל ‎=[qty]*[price]‎ או ‎=sum([a],[b])');
    const fin = document.createElement('input'); fin.type = 'text'; fin.dir = 'ltr';
    fin.value = m.formula || ''; fin.placeholder = '=… (רשות)';
    fin.addEventListener('input', () => {
      m.formula = fin.value.trim();
      if (PFS.formula.isFormula(m.formula)) { input.disabled = true; input.value = ''; } else { input.disabled = false; }
      recomputeFormulas(); markDirty();
    });
    if (PFS.formula && PFS.formula.isFormula(m.formula)) input.disabled = true;
    fForm.appendChild(fin); body.appendChild(fForm);
    // number format for a computed value (₪ / thousands / %)
    const fFmt = field('תבנית מספר (לשדה מחושב)');
    const sel = document.createElement('select');
    [['none', 'ללא'], ['number', '1,234.5'], ['currency', '₪1,234.50'], ['percent', '12.5%']].forEach(([v, lbl]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = lbl; if ((m.format || 'none') === v) o.selected = true; sel.appendChild(o);
    });
    sel.addEventListener('change', () => { m.format = sel.value === 'none' ? '' : sel.value; recomputeFormulas(); markDirty(); });
    fFmt.appendChild(sel); body.appendChild(fFmt);
  } else if (m.kind === 'handwriting') {
    const regen = () => {
      const r = PFS.handwriting.renderText(m.text || '', { fontPx: 72, color: m.color || '#000000', tracking: m.tracking });
      m.imgUrl = r.url; m.aspect = r.w / r.h; m.fh = m.fw / m.aspect;
      const img = ctrl.node.querySelector('img'); if (img) img.src = r.url;
      ctrl.layout(); markDirty();
    };
    // edit / delete / replace letters live — typing here rewrites the text
    const f1 = field('טקסט (כתב יד) — ערכו, מחקו או החליפו אותיות/מספרים');
    const inp = document.createElement('input'); inp.type = 'text'; inp.dir = 'auto'; inp.value = m.text || '';
    let t = null;
    inp.addEventListener('input', () => { m.text = inp.value; clearTimeout(t); t = setTimeout(regen, 120); });
    f1.appendChild(inp); body.appendChild(f1);
    const rowSC = document.createElement('div'); rowSC.className = 'row';
    const fSize = field('גודל'); fSize.style.flex = '1'; const size = document.createElement('input');
    size.type = 'range'; size.min = '3'; size.max = '80'; size.step = '1'; size.value = Math.round(m.fw * 100);
    size.addEventListener('input', () => { m.fw = parseInt(size.value, 10) / 100; m.fh = m.fw / (m.aspect || 1); ctrl.layout(); markDirty(); });
    fSize.appendChild(size);
    const fCol = field('צבע'); const col = document.createElement('input'); col.type = 'color'; col.value = toHex(m.color || '#000000');
    col.addEventListener('input', () => { m.color = col.value; regen(); }); fCol.appendChild(col);
    rowSC.append(fSize, fCol); body.appendChild(rowSC);
    const fTr = field('מרווח בין אותיות'); const tr = document.createElement('input');
    tr.type = 'range'; tr.min = '0.5'; tr.max = '1.8'; tr.step = '0.05';
    tr.value = m.tracking != null ? m.tracking : PFS.handwriting.getTracking();
    tr.addEventListener('input', () => { m.tracking = parseFloat(tr.value); regen(); });
    fTr.appendChild(tr); body.appendChild(fTr);
  } else if (m.type === 'rect') {
    // whiteout / redact box — independent width & height, and cover color
    const rowWH = document.createElement('div'); rowWH.className = 'row';
    const fW = field('רוחב'); fW.style.flex = '1'; const sw = document.createElement('input');
    sw.type = 'range'; sw.min = '2'; sw.max = '95'; sw.step = '1'; sw.value = Math.round(m.fw * 100);
    sw.addEventListener('input', () => { m.fw = parseInt(sw.value, 10) / 100; ctrl.layout(); markDirty(); });
    fW.appendChild(sw);
    const fH = field('גובה'); fH.style.flex = '1'; const sh = document.createElement('input');
    sh.type = 'range'; sh.min = '1'; sh.max = '40'; sh.step = '1'; sh.value = Math.round(m.fh * 100);
    sh.addEventListener('input', () => { m.fh = parseInt(sh.value, 10) / 100; ctrl.layout(); markDirty(); });
    fH.appendChild(sh);
    rowWH.append(fW, fH); body.appendChild(rowWH);
    const fCol = field('צבע כיסוי'); const col = document.createElement('input');
    col.type = 'color'; col.value = toHex(m.color || '#ffffff');
    col.addEventListener('input', () => { m.color = col.value; ctrl.layout(); markDirty(); });
    fCol.appendChild(col);
    // sample the paper colour under the box so the cover blends in perfectly
    if (m.kind === 'whiteout') {
      const matchBtn = document.createElement('button');
      matchBtn.className = 'btn sm'; matchBtn.type = 'button';
      matchBtn.style.marginInlineStart = '8px'; matchBtn.textContent = '🎯 התאם לרקע';
      matchBtn.title = 'דגום את צבע הרקע מתחת לתיבה כדי שהכיסוי יתמזג';
      matchBtn.addEventListener('click', () => {
        const bg = pdfView.sampleBg(m.page, m.fx, m.fy, m.fw, m.fh);
        if (bg) { m.color = bg; col.value = toHex(bg); ctrl.layout(); markDirty(); PFS.toast('הכיסוי הותאם לרקע ✓', 'ok', 1400); }
        else PFS.toast('לא ניתן לדגום כאן', 'err');
      });
      fCol.appendChild(matchBtn);
    }
    body.appendChild(fCol);
    // opacity — for a see-through highlight (or a softer cover)
    const fOp = field('שקיפות'); const op = document.createElement('input');
    op.type = 'range'; op.min = '10'; op.max = '100'; op.step = '5';
    op.value = Math.round((m.opacity != null ? m.opacity : 1) * 100);
    op.addEventListener('input', () => { m.opacity = parseInt(op.value, 10) / 100; ctrl.layout(); markDirty(); });
    fOp.appendChild(op); body.appendChild(fOp);
  } else {
    const f = field('גודל'); const size = document.createElement('input');
    size.type = 'range'; size.min = '3'; size.max = '80'; size.step = '1';
    size.value = Math.round(m.fw * 100);
    size.addEventListener('input', () => {
      m.fw = parseInt(size.value, 10) / 100; m.fh = m.fw / (m.aspect || 1); ctrl.layout(); markDirty();
    });
    f.appendChild(size); body.appendChild(f);
  }

  // delete
  const del = document.createElement('button'); del.className = 'btn sm';
  del.style.color = 'var(--danger)'; del.textContent = '🗑 מחק פריט';
  del.addEventListener('click', () => overlay.deleteCtrl(ctrl));
  body.appendChild(del);
}
function field(labelText) {
  const f = document.createElement('div'); f.className = 'field';
  const l = document.createElement('label'); l.textContent = labelText; f.appendChild(l);
  return f;
}
function toHex(c) {
  if (!c) return '#111111';
  if (c[0] === '#') return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c;
  const m = c.match(/\d+/g); if (!m) return '#111111';
  return '#' + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, '0')).join('');
}

// =====================================================================
//  Export
// =====================================================================
/* Export review — instead of firing off a chain of blocking confirm() dialogs
 * and downloading blind, opening the export shows the REAL output: the bytes
 * are built, rendered back with pdf.js and paged through, with the pre-flight
 * checks and options (quality / secure) beside them. Changing an option
 * rebuilds the preview, so what you see is exactly what gets downloaded. */
const exState = { bytes: null, doc: null, page: 1, pages: 1, token: 0, busy: false, checks: null };

function exSetBusy(on, txt) {
  exState.busy = on;
  const b = $('exBusy'); if (!b) return;
  b.classList.toggle('on', !!on);
  if (txt) $('exBusyTxt').textContent = txt;
  ['exDownload', 'exShare'].forEach((id) => { const el = $(id); if (el) el.disabled = !!on; });
}
const fmtSize = (n) => (n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

// Pre-flight: the same guards as before, but shown together as a checklist
// instead of interrupting one modal at a time.
function exBuildChecks(models) {
  const out = [];
  const reqBlanks = (fieldsPanel.requiredEmpty && fieldsPanel.requiredEmpty()) || 0;
  const blanks = (fieldsPanel.emptyCount && fieldsPanel.emptyCount()) || 0;
  let suspects = [];
  if (PFS.validate && PFS.validate.scan) {
    suspects = PFS.validate.scan(
      models.filter((m) => m.type === 'text' && m.fieldKey).map((m) => ({ key: m.fieldKey, value: m.text }))
    ) || [];
  }
  if (reqBlanks > 0) out.push({ t: 'err', i: '⚠️', h: reqBlanks + ' שדות חובה (*) ריקים', s: 'טופס עם שדות חובה חסרים עלול להידחות' });
  if (blanks > 0) out.push({ t: 'warn', i: '◻️', h: blanks + ' שדות ריקים', s: 'אפשר לייצא כך — רק ודאו שזו הכוונה' });
  if (suspects.length) {
    const list = suspects.slice(0, 4).map((s) => (s.value || '') + ' — ' + s.msg).join(' · ');
    out.push({ t: 'warn', i: '🔍', h: suspects.length + ' ערכים שכדאי לבדוק', s: list + (suspects.length > 4 ? ' …' : '') });
  }
  if (!out.length) out.push({ t: 'ok', i: '✓', h: 'הכול נראה תקין', s: 'לא נמצאו שדות חובה ריקים או ערכים חשודים' });
  return out;
}
function exRenderChecks(checks) {
  const wrap = $('exChecks'); if (!wrap) return;
  wrap.innerHTML = '';
  checks.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'ex-chk ' + c.t;
    d.innerHTML = '<span class="i"></span><span><b></b><span class="sub"></span></span>';
    d.querySelector('.i').textContent = c.i;
    d.querySelector('b').textContent = c.h;
    d.querySelector('.sub').textContent = c.s;
    wrap.appendChild(d);
  });
}

// Build the export bytes for the CURRENT options and render page 1.
// Each call takes a token so a slow older build can't overwrite a newer one.
async function exBuild() {
  const my = ++exState.token;
  exSetBusy(true, 'מכין תצוגה מקדימה…');
  try {
    const models = overlay.getElements().map((c) => c.model);
    const secure = $('exSecure') && $('exSecure').checked;
    const onProgress = (d, t) => { if (my === exState.token) $('exBusyTxt').textContent = `מעבד עמוד ${d} מתוך ${t}…`; };
    const bytes = secure
      ? await buildFlattenedBytes(onProgress)
      : await PFS.exporter.exportPdf(pdfView.getBytes(), models, {
        quality: exportQuality(),
        rotations: pdfView.getRotations(),
        ...(pdfView.isReordered && pdfView.isReordered() ? { pageOrder: pdfView.getPageOrder() } : { removePages: pdfView.getRemovedPages() }),
        attachments, onProgress,
        // lets background-matched covers rebuild the paper at export resolution
        renderBase: (idx, s) => renderBaseForFlatten(idx, s)
      });
    if (my !== exState.token) return;                 // superseded by a newer build
    exState.bytes = bytes;
    exState.doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    if (my !== exState.token) return;
    exState.pages = exState.doc.numPages;
    exState.page = Math.min(exState.page, exState.pages);
    await exDrawPage();
    exUpdateMeta();
  } catch (e) {
    console.error(e);
    if (my === exState.token) PFS.toast('בניית התצוגה נכשלה: ' + (e.message || e), 'err');
  } finally {
    if (my === exState.token) exSetBusy(false);
  }
}
async function exDrawPage() {
  if (!exState.doc) return;
  const page = await exState.doc.getPage(exState.page);
  const view = $('exView'), canvas = $('exCanvas');
  const base = page.getViewport({ scale: 1 });
  // fit the page into the stage, capped so a huge page doesn't blow up memory
  const availW = Math.max(220, (view.clientWidth || 620) - 40);
  const availH = Math.max(220, (view.clientHeight || 460) - 40);
  const scale = Math.min(availW / base.width, availH / base.height, 2.2);
  const vp = page.getViewport({ scale: scale * Math.min(window.devicePixelRatio || 1, 2) });
  canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
  canvas.style.width = Math.round(base.width * scale) + 'px';
  canvas.style.height = Math.round(base.height * scale) + 'px';
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  $('exPage').textContent = exState.page + ' / ' + exState.pages;
  $('exPrev').disabled = exState.page <= 1;
  $('exNext').disabled = exState.page >= exState.pages;
}
function exUpdateMeta() {
  const m = $('exMeta'); if (!m) return;
  const q = { draft: 'טיוטה', standard: 'רגילה', high: 'להדפסה' }[exportQuality()] || 'רגילה';
  const secure = $('exSecure') && $('exSecure').checked;
  const pills = [
    '<span class="ex-pill">גודל: <b>' + fmtSize(exState.bytes ? exState.bytes.length : 0) + '</b></span>',
    '<span class="ex-pill">עמודים: <b>' + exState.pages + '</b></span>',
    '<span class="ex-pill">איכות: <b>' + q + '</b></span>'
  ];
  if (secure) pills.push('<span class="ex-pill">🔒 <b>מאובטח</b></span>');
  m.innerHTML = pills.join('');
}
// "What's in this file" — makes the export self-explanatory: how many items
// were added, attachments, and any page operations that are about to be baked.
function exRenderSummary(models) {
  const el = $('exSummary'); if (!el) return;
  const n = (p) => models.filter(p).length;
  const rows = [];
  const texts = n((m) => m.type === 'text' && (m.text || '').trim());
  const marks = n((m) => m.kind === 'check' || m.kind === 'cross');
  const covers = n((m) => m.type === 'rect');
  const imgs = n((m) => m.type === 'image');
  if (texts) rows.push(['✍️', 'שדות שמולאו', texts]);
  if (marks) rows.push(['✔️', 'סימוני וי / איקס', marks]);
  if (covers) rows.push(['🩹', 'כיסוי · השחרה · הדגשה', covers]);
  if (imgs) rows.push(['🖊️', 'חתימות וחותמות', imgs]);
  if (attachments && attachments.length) rows.push(['📎', 'עמודים מצורפים', attachments.length]);
  const removed = (pdfView.getRemovedPages && pdfView.getRemovedPages()) || [];
  if (removed.length) rows.push(['🗑️', 'עמודים שיוסרו', removed.length]);
  const rots = Object.keys((pdfView.getRotations && pdfView.getRotations()) || {}).length;
  if (rots) rows.push(['🔄', 'עמודים שסובבו', rots]);
  if (pdfView.isReordered && pdfView.isReordered()) rows.push(['↕️', 'סדר העמודים', 'שונה']);

  el.innerHTML = '';
  if (!rows.length) {
    const d = document.createElement('div');
    d.className = 'ex-sum-empty'; d.textContent = 'הקובץ המקורי בלבד — לא נוספו שינויים';
    el.appendChild(d); return;
  }
  rows.forEach(([ic, k, v]) => {
    const r = document.createElement('div'); r.className = 'ex-sum-row';
    r.innerHTML = '<span class="ic"></span><span class="k"></span><span class="v"></span>';
    r.querySelector('.ic').textContent = ic;
    r.querySelector('.k').textContent = k;
    r.querySelector('.v').textContent = v;
    el.appendChild(r);
  });
}
function exFileName() {
  const secure = $('exSecure') && $('exSecure').checked;
  return currentFileName + (secure ? '-secure' : '-filled') + '.pdf';
}

// Export-review companions row — the moment the quote is done is exactly when
// the appendix matters, so the LINKING step lives here too (the panel card
// alone was buried under a long field list and nobody found it).
function renderExportCompanions() {
  const body = $('exCompBody'); if (!body) return;
  body.innerHTML = '';
  const links = (PFS.companions && currentFp) ? PFS.companions.listFor(currentFp) : [];
  if (links.length) {
    links.forEach((ln) => {
      const row = document.createElement('div');
      row.className = 'ex-chk ok';
      row.innerHTML = '<span class="i">📎</span><span><b></b><span class="sub">אחרי ההורדה אשאל אם למלא אותו אוטומטית מהנתונים שמילאת</span></span>';
      row.querySelector('b').textContent = ln.name;
      body.appendChild(row);
    });
  } else {
    const btn = document.createElement('button');
    btn.className = 'btn sm block'; btn.type = 'button';
    btn.textContent = '🔗 קשר נספח שימולא אוטומטית אחרי הייצוא';
    btn.title = 'למשל: נספח ה3 להצעת מחיר — קישור חד-פעמי, ומאז יוצע בכל מילוי';
    btn.addEventListener('click', () => $('compInput').click());
    body.appendChild(btn);
  }
}

async function doExport(opts) {
  // exported forms always leave with ONE handwriting — quietly normalize the
  // machine-placed fills (manually styled free text is left alone)
  try { uniformizeHandwriting(true); } catch (e) {}
  if (!pdfView.hasDoc()) return;
  const models = overlay.getElements().map((c) => c.model);
  if (!models.length && !attachments.length) { PFS.toast('לא נוספו שדות לטופס', 'err'); return; }
  // reflect saved prefs into the controls, then open and build the preview
  const q = exportQuality();
  document.querySelectorAll('#exQual button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
  if ($('exSecure')) $('exSecure').checked = !!(opts && opts.secure);
  $('exName').textContent = exFileName();
  exState.page = 1; exState.bytes = null; exState.doc = null;
  exRenderChecks(exBuildChecks(models));
  exRenderSummary(models);
  renderExportCompanions();
  if (navigator.canShare) $('exShare').hidden = false;
  openModal('exportModal');
  await exBuild();
}

// Deliver the already-built bytes (no rebuild — the preview IS the output).
async function exDeliver(preferShare) {
  if (!exState.bytes) return;
  const outName = exFileName();
  const bytes = exState.bytes;
  let shared = false;
  if (preferShare) {
    try {
      const f = new File([bytes], outName, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], title: outName });
        shared = true;
      }
    } catch (e) { /* cancelled / unsupported → fall through to download */ }
  }
  if (!shared) PFS.exporter.downloadBytes(bytes, outName);
  closeModal('exportModal');
  PFS.toast(shared ? 'הטופס שותף ✓' : 'ה-PDF יוצא בהצלחה', 'ok');
  dirty = false;
  try { templates.autoSave(currentFp, currentFileName); } catch (e) {}
  // a successful export confirms the filled values — feed the learning engine
  // (skipping values that were auto-filled and never touched, so learning
  // can't amplify itself)
  try {
    if (lastDet && lastDet.fields && lastDet.fields.length && PFS.patterns) {
      const n = PFS.patterns.learnFrom(lastDet.fields, overlay.currentValues(),
        fieldsPanel.autoFilledKeys ? fieldsPanel.autoFilledKeys() : []);
      if (n) console.info('[patterns] learned from export:', n, 'fields');
    }
  } catch (e) { console.warn('[patterns] learn failed', e); }
  // course binder: this export may BE a registered student's submission
  try {
    if (PFS.courses && currentFp) {
      const marks = PFS.courses.recordExport(currentFp, overlay.currentValues());
      marks.forEach((m) => PFS.toast(`🗂 סומן: ${m.student.name} הגיש/ה "${m.form.name}" (${m.course.name})`, 'ok', 5000));
    }
  } catch (e) { console.warn('[courses] mark failed', e); }
  offerCompanions();
}

// ---- export modal wiring ----
$('exClose') && $('exClose').addEventListener('click', () => closeModal('exportModal'));
$('exCancel') && $('exCancel').addEventListener('click', () => closeModal('exportModal'));
$('exPrev') && $('exPrev').addEventListener('click', () => { if (exState.page > 1) { exState.page--; exDrawPage(); } });
$('exNext') && $('exNext').addEventListener('click', () => { if (exState.page < exState.pages) { exState.page++; exDrawPage(); } });
$('exDownload') && $('exDownload').addEventListener('click', () => exDeliver(false));
$('exShare') && $('exShare').addEventListener('click', () => exDeliver(true));
document.querySelectorAll('#exQual button').forEach((b) => {
  b.addEventListener('click', () => {
    if (exState.busy) return;
    document.querySelectorAll('#exQual button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    PFS.store.set('export_quality', b.dataset.q);
    const sel = $('exportQuality'); if (sel) sel.value = b.dataset.q;   // keep Settings in sync
    exBuild();
  });
});
$('exSecure') && $('exSecure').addEventListener('change', () => {
  $('exName').textContent = exFileName();
  exBuild();
});
// keep the preview filling the stage when the window (or orientation) changes
let exRz = null;
window.addEventListener('resize', () => {
  if (!$('exportModal') || !$('exportModal').classList.contains('show') || !exState.doc) return;
  clearTimeout(exRz); exRz = setTimeout(() => exDrawPage(), 180);
});

// the user's chosen export quality → DPI multiplier (shared by both paths)
function exportQuality() { return PFS.store.get('export_quality', 'standard'); }
function qualityScale() { const q = PFS.exporter.QUALITY || {}; return q[exportQuality()] || 2.6; }

// Render one base page to a high-DPI canvas (already rotated), white-backed so
// the flattened image isn't transparent. Returns the page size in points too.
async function renderBaseForFlatten(idx, scale = qualityScale()) {
  const doc = pdfView.getDoc();
  const page = await doc.getPage(idx + 1);
  const userR = (pdfView.getRotations && pdfView.getRotations()[idx]) || 0;
  const rot = (((page.rotate || 0) + userR) % 360 + 360) % 360;
  const vp = page.getViewport({ scale, rotation: rot });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(vp.width));
  canvas.height = Math.max(1, Math.round(vp.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const vp1 = page.getViewport({ scale: 1, rotation: rot });
  return { canvas, wPt: vp1.width, hPt: vp1.height };
}
// Secure/flat export: everything rasterized → no extractable text (true
// redaction), tamper-resistant. Returns bytes (the UI wrapper downloads/shares).
async function buildFlattenedBytes(onProgress) {
  const models = overlay.getElements().map((c) => c.model);
  const order = pdfView.getPageOrder ? pdfView.getPageOrder() : null;
  return PFS.exporter.exportFlattenedPdf({
    order: (order && order.length) ? order : undefined,
    models, attachments,
    renderBase: (idx) => renderBaseForFlatten(idx),
    quality: exportQuality(),
    onProgress
  });
}
// Secure export goes through the same review modal, with the toggle pre-set —
// one export surface, so the flattened output is previewed before it downloads.
async function doExportFlattened() { return doExport({ secure: true }); }
$('exportFlatBtn') && $('exportFlatBtn').addEventListener('click', doExportFlattened);

$('tourBtn') && $('tourBtn').addEventListener('click', () => {
  closeModal('helpModal');
  PFS.store.remove('tour_done');
  PFS.tour && PFS.tour.start();
});

// =====================================================================
//  Modals
// =====================================================================
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
document.querySelectorAll('.modal-back').forEach((mb) => {
  mb.addEventListener('pointerdown', (e) => { if (e.target === mb) mb.classList.remove('show'); });
});

// =====================================================================
//  Wire up DOM
// =====================================================================
// open buttons
$('openBtn').addEventListener('click', () => $('pdfInput').click());
$('openBtn2').addEventListener('click', () => $('pdfInput').click());
$('pdfInput').addEventListener('change', (e) => { if (e.target.files[0]) openPdfFile(e.target.files[0]); e.target.value = ''; });

// right-panel tabs
function activateTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  if (name === 'settings') renderLearned();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));

// mobile: right panel is a slide-in drawer
const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;
function openPanel() { $('rightpanel').classList.add('open'); }
function closePanel() { $('rightpanel').classList.remove('open'); }
$('panelToggle').addEventListener('click', () => $('rightpanel').classList.toggle('open'));

// install-as-app: real prompt where the browser offers one; instructions
// where it doesn't (iOS installs only via Share → הוסף למסך הבית)
$('installBtn') && $('installBtn').addEventListener('click', async () => {
  const res = await PFS.pwa.promptInstall();
  if (res === 'accepted') PFS.toast('🎉 Fillo מותקן — חפשו את האייקון במסך הבית', 'ok', 6000);
  else if (res === 'ios') {
    await PFS.ui.confirm('התקנה באייפון', 'בספארי: לחצו על כפתור השיתוף (הריבוע עם החץ למעלה) ואז "הוסף למסך הבית". זהו — Fillo יופיע כאפליקציה.');
  } else if (res === 'unsupported') {
    await PFS.ui.confirm('התקנה', 'בתפריט הדפדפן (⋮) בחרו "התקנת אפליקציה" או "הוספה למסך הבית".');
  }
});
// hide the card when already running as the installed app
if (PFS.pwa && PFS.pwa.isStandalone && PFS.pwa.isStandalone()) {
  const card = $('installBtn') && $('installBtn').closest('.card');
  if (card) card.style.display = 'none';
} else if (window.innerWidth < 720 && !PFS.store.get('install_nudged', false)) {
  // one-time phone nudge — the whole point of the card is being discovered
  setTimeout(() => {
    PFS.toast('📱 טיפ: אפשר להתקין את Fillo כאפליקציה — הגדרות ← התקנה', 'ok', 7000);
    PFS.store.set('install_nudged', true);
  }, 4000);
}

// "מה נלמד" — transparency + control over the learning store. Automatic
// learning is only trustworthy when it's inspectable and erasable.
function renderLearned() {
  const body = $('learnedBody'); if (!body) return;
  const data = PFS.patterns ? PFS.patterns.all() : {};
  body.innerHTML = '';
  const slots = Object.keys(data);
  if (!slots.length) {
    body.innerHTML = '<div class="hint muted" style="padding:6px 0">עוד לא נלמד כלום — מלאו וייצאו טופס, והדפוסים יופיעו כאן.</div>';
    return;
  }
  slots.forEach((slot) => {
    const e = data[slot];
    const wrap = document.createElement('div'); wrap.style.margin = '0 0 10px';
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:700;font-size:12.5px;margin-bottom:4px;color:var(--ink-2)';
    h.textContent = e.label || slot;
    wrap.appendChild(h);
    const chips = document.createElement('div'); chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
    (e.values || []).forEach((r) => {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:var(--surface-2);border:1px solid var(--line);border-radius:999px;padding:3px 8px;font-size:11.5px;max-width:100%';
      const v = document.createElement('span');
      v.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px';
      v.textContent = r.v; v.title = r.v;
      const tag = document.createElement('span');
      tag.style.cssText = 'color:var(--ink-4);font-weight:700;flex:none';
      tag.textContent = r.pinned ? '📌' : ('×' + r.n);
      const x = document.createElement('button');
      x.style.cssText = 'border:0;background:none;color:var(--danger);cursor:pointer;padding:0;font-size:11px;flex:none';
      x.textContent = '✕'; x.title = 'שכח את הערך הזה';
      x.addEventListener('click', () => { PFS.patterns.removeAt(slot, r.v); renderLearned(); });
      chip.append(v, tag, x);
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    body.appendChild(wrap);
  });
}
$('learnedClearBtn') && $('learnedClearBtn').addEventListener('click', async () => {
  if (await PFS.ui.confirm('שכחת כל הלמידה', 'למחוק את כל הערכים שנלמדו? המילוי האוטומטי מהלמידה יתאפס (הפרופיל לא נמחק).')) {
    PFS.patterns.clear(); renderLearned();
    PFS.toast('הלמידה אופסה', 'ok');
  }
});

// undo / redo — visible, always in reach (were keyboard-only before)
$('undoBtn') && $('undoBtn').addEventListener('click', () => undo());
$('redoBtn') && $('redoBtn').addEventListener('click', () => redoAction());
updateUndoUI();

// tool rail
document.querySelectorAll('.rail-btn.tool').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!pdfView.hasDoc()) { PFS.toast('פתח קודם קובץ PDF', 'err'); return; }
    if (isNarrow()) closePanel(); // reveal the page so the placement click lands on it
    activateTool(btn, btn.dataset.tool);
  });
});

// zoom
$('zoomctl').addEventListener('click', (e) => {
  const z = e.target.dataset.z; if (!z) return;
  if (z === 'in') pdfView.zoomIn(); else if (z === 'out') pdfView.zoomOut(); else pdfView.fit();
});

// image inputs
$('imgInput').addEventListener('change', (e) => { if (e.target.files[0]) handleImageUpload(e.target.files[0]); e.target.value = ''; });
$('upStampBtn').addEventListener('click', () => { pendingImageKind = 'stamp'; $('imgInput').click(); });
$('upSigBtn').addEventListener('click', () => { pendingImageKind = 'signature'; $('imgInput').click(); });
$('drawSigBtn').addEventListener('click', openSignaturePad);

// export
$('exportBtn').addEventListener('click', doExport);

// templates
$('tmplBtn').addEventListener('click', () => { templates.render(); openModal('tmplModal'); });
$('tmplClose').addEventListener('click', () => closeModal('tmplModal'));
$('tmplSearch').addEventListener('input', (e) => templates.setFilter(e.target.value));
$('tmplSave').addEventListener('click', () => { templates.save($('tmplName').value.trim(), currentFp); $('tmplName').value = ''; });
$('tmplExport').addEventListener('click', () => templates.exportAll());
$('tmplImport').addEventListener('click', () => $('tmplFile').click());
$('tmplFile').addEventListener('change', (e) => { if (e.target.files[0]) templates.importFile(e.target.files[0]); e.target.value = ''; });

// drag & drop PDF onto the viewport
const vp = $('viewport'), dz = $('dropzone');
let dragDepth = 0;
['dragenter', 'dragover'].forEach((ev) => vp.addEventListener(ev, (e) => {
  e.preventDefault(); if (ev === 'dragenter') dragDepth++;
  if (!pdfView.hasDoc()) dz.classList.add('hot');
}));
['dragleave', 'drop'].forEach((ev) => vp.addEventListener(ev, (e) => {
  e.preventDefault(); if (ev === 'dragleave') { if (--dragDepth > 0) return; }
  dz.classList.remove('hot');
}));
vp.addEventListener('drop', (e) => {
  dragDepth = 0;
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type === 'application/pdf');
  if (file) openPdfFile(file);
});

$('pageJump') && $('pageJump').addEventListener('change', (e) => {
  // value is the stable original page index — find the wrap by data attr so it
  // works after a reorder (DOM position no longer equals original index)
  const w = document.querySelector('.page-wrap[data-page-idx="' + CSS.escape(e.target.value) + '"]');
  if (w) PFS.scrollToEl(w, 'start');
});

// ---- page thumbnails (rail toggle → slide-in strip) --------------------
function buildThumbnails() {
  const strip = $('thumbs'), btn = $('thumbsBtn');
  if (!strip || !pdfView.viewList) return;
  const byIdx = new Map(pdfView.viewList().map((v) => [v.idx, v]));
  const orderArr = (pdfView.getPageOrder && pdfView.getPageOrder()) || [];
  // show thumbnails in the current display order (reflects reorder + deletion)
  const views = (orderArr.length ? orderArr.map((i) => byIdx.get(i)).filter(Boolean) : [...byIdx.values()].filter((v) => !v.deleted))
    .map((v, i) => Object.assign({}, v, { n: i + 1 }));   // renumber to display position
  strip.innerHTML = '';
  const multi = views.length > 1;
  btn.hidden = !multi;
  if (!multi) { strip.hidden = true; strip.classList.remove('open'); return; }
  strip.hidden = false;
  views.forEach((v) => {
    const cell = document.createElement('div'); cell.className = 'thumb'; cell.dataset.n = v.n;
    const tc = document.createElement('canvas');
    const tw = 108, th = Math.round(tw * (v.canvas.height / v.canvas.width || 1.414));
    tc.width = tw; tc.height = th;
    try { tc.getContext('2d').drawImage(v.canvas, 0, 0, tw, th); } catch (e) {}
    const tag = document.createElement('span'); tag.className = 'tn'; tag.textContent = v.n;
    // reorder controls: move this page earlier / later
    const mv = document.createElement('div'); mv.className = 'thumb-move';
    const up = document.createElement('button'); up.type = 'button'; up.title = 'הזז מוקדם יותר'; up.textContent = '▲';
    const dn = document.createElement('button'); dn.type = 'button'; dn.title = 'הזז מאוחר יותר'; dn.textContent = '▼';
    up.addEventListener('click', (e) => { e.stopPropagation(); if (pdfView.movePage(v.idx, -1)) { buildThumbnails(); buildPageNav(); markDirty(); scheduleSnap(); } });
    dn.addEventListener('click', (e) => { e.stopPropagation(); if (pdfView.movePage(v.idx, 1)) { buildThumbnails(); buildPageNav(); markDirty(); scheduleSnap(); } });
    mv.append(up, dn);
    cell.append(tc, tag, mv);
    cell.addEventListener('click', () => { PFS.scrollToEl(v.wrap, 'start'); });
    strip.appendChild(cell);
  });
}
function applyEnhance(on) {
  $('pages').classList.toggle('enhance', on);
  $('enhanceBtn') && $('enhanceBtn').classList.toggle('active', on);
}
// export-quality selector: restore the saved choice + persist on change
(function () {
  const q = $('exportQuality'); if (!q) return;
  q.value = exportQuality();
  q.addEventListener('change', () => {
    const v = PFS.exporter.QUALITY && PFS.exporter.QUALITY[q.value] ? q.value : 'standard';
    PFS.store.set('export_quality', v);
    PFS.toast('איכות הייצוא נשמרה', 'ok', 1400);
  });
})();

applyEnhance(PFS.store.get('enhance_scan', false));   // restore preference
$('enhanceBtn') && $('enhanceBtn').addEventListener('click', () => {
  const on = !$('pages').classList.contains('enhance');
  applyEnhance(on);
  PFS.store.set('enhance_scan', on);
  PFS.toast(on ? 'חידוד סריקה: פעיל — קריא יותר (לא משפיע על הקובץ המיוצא)' : 'חידוד סריקה: כבוי', 'ok', 1600);
});
// rotate the page currently centered in the viewport (90° CW per click)
function currentPageIndex() {
  const list = pdfView.viewList().filter((v) => !v.deleted); if (!list.length) return 0;
  const vpRect = $('viewport').getBoundingClientRect();
  const cy = vpRect.top + vpRect.height / 2;
  let best = list[0].idx, bestDist = Infinity;
  list.forEach((v) => {
    const r = v.wrap.getBoundingClientRect();
    const d = Math.abs((r.top + r.height / 2) - cy);
    if (d < bestDist) { bestDist = d; best = v.idx; }
  });
  return best;
}
// rebuild the page-jump dropdown from the currently visible (non-deleted) pages
function buildPageNav() {
  const pj = $('pageJump'); if (!pj) return;
  const byIdx = new Map(pdfView.viewList().map((v) => [v.idx, v]));
  const orderArr = (pdfView.getPageOrder && pdfView.getPageOrder()) || [];
  const vis = orderArr.length ? orderArr.map((i) => byIdx.get(i)).filter(Boolean) : [...byIdx.values()].filter((v) => !v.deleted);
  pj.classList.toggle('hidden', vis.length < 2);
  pj.innerHTML = '';
  vis.forEach((v, i) => { const o = document.createElement('option'); o.value = v.idx; o.textContent = 'עמ׳ ' + (i + 1) + '/' + vis.length; pj.appendChild(o); });
}
$('rotateBtn') && $('rotateBtn').addEventListener('click', async () => {
  if (!pdfView.hasDoc()) return;
  const idx = currentPageIndex();
  await pdfView.rotatePage(idx, 90);
  scheduleSnap();
  PFS.toast('עמוד ' + (idx + 1) + ' סובב — יישמר מסובב בייצוא', 'ok', 1600);
});
$('deleteBtn') && $('deleteBtn').addEventListener('click', async () => {
  if (!pdfView.hasDoc()) return;
  if (pdfView.visiblePageCount() <= 1) { PFS.toast('לא ניתן למחוק את העמוד היחיד', 'err'); return; }
  const idx = currentPageIndex();
  if (!(await PFS.ui.confirm('מחיקת עמוד', 'למחוק את עמוד ' + (idx + 1) + '? הוא לא ייכלל בקובץ המיוצא.'))) return;
  if (pdfView.deletePage(idx)) {
    buildPageNav(); buildThumbnails(); markDirty(); scheduleSnap();
    PFS.toast('העמוד נמחק — לא ייכלל בייצוא', 'ok', 1600);
  }
});
// attach supporting pages (photo of ID etc.) — appended to the exported PDF
function updateAttachBadge() {
  const b = $('attachBtn'); if (!b) return;
  const lbl = b.querySelector('.lbl');
  if (lbl) lbl.textContent = attachments.length ? `צרף עמוד (${attachments.length})` : 'צרף עמוד';
  b.classList.toggle('active', attachments.length > 0);
}
$('attachBtn') && $('attachBtn').addEventListener('click', () => { if (pdfView.hasDoc()) $('attachInput').click(); });
$('attachInput') && $('attachInput').addEventListener('change', async (e) => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  for (const f of files) {
    try {
      if (f.type === 'application/pdf') {
        const buf = await f.arrayBuffer();
        attachments.push({ kind: 'pdf', bytes: new Uint8Array(buf), name: f.name });
      } else if (/^image\/(png|jpeg|webp)$/.test(f.type)) {
        // downscale + JPEG so a big phone photo doesn't bloat the shared PDF
        const img = await PFS.imageTools.fileToImage(f);
        const conv = PFS.imageTools.downscaleToJpeg(img, 1800, 0.85);
        attachments.push({ url: conv.url, type: 'image/jpeg', name: f.name });
      }
    } catch (err) { console.warn('attach failed', err); }
  }
  updateAttachBadge();
  markDirty();
  if (attachments.length) PFS.toast(`צורפו ${attachments.length} עמודים — יתווספו לקובץ בייצוא`, 'ok');
});
$('thumbsBtn') && $('thumbsBtn').addEventListener('click', () => {
  const strip = $('thumbs'); strip.classList.toggle('open');
  $('thumbsBtn').classList.toggle('active', strip.classList.contains('open'));
});
// highlight the page currently in view
(function () {
  const vp = $('viewport'); if (!vp) return;
  let raf = 0;
  vp.addEventListener('scroll', () => {
    if (raf) return; raf = requestAnimationFrame(() => {
      raf = 0;
      const strip = $('thumbs'); if (!strip || strip.hidden) return;
      const wraps = [...document.querySelectorAll('.page-wrap')];
      const mid = vp.scrollTop + vp.clientHeight / 2;
      let cur = 0; wraps.forEach((w, i) => { if (w.offsetTop <= mid) cur = i; });
      strip.querySelectorAll('.thumb').forEach((t, i) => t.classList.toggle('current', i === cur));
    });
  }, { passive: true });
})();

// keyboard: delete selected, escape cancels placement
document.addEventListener('keydown', (e) => {
  const sel = overlay.getSelected();
  const editing = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('contenteditable') === 'true';
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape') { overlay.setPlacing(null); overlay.deselectAll(); document.querySelectorAll('.modal-back.show').forEach((m) => m.classList.remove('show')); }
  if (e.key === '?' && !editing && !inField) { e.preventDefault(); openModal('helpModal'); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !editing && !inField) {
    e.preventDefault();
    const many = overlay.getMulti();
    (many.length > 1 ? many : [sel]).forEach((c) => overlay.deleteCtrl(c));
  }
  // arrow-key nudging: pixel-precise placement for lining a value up on a
  // ruled form. Shift = bigger step. Fractions, so it survives zoom + export.
  if (sel && !editing && !inField && !e.ctrlKey && !e.metaKey && /^Arrow/.test(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 0.01 : 0.002;
    const m = sel.model;
    if (e.key === 'ArrowLeft') m.fx = PFS.clamp(m.fx - step, 0, 1 - (m.fw || 0));
    else if (e.key === 'ArrowRight') m.fx = PFS.clamp(m.fx + step, 0, 1 - (m.fw || 0));
    else if (e.key === 'ArrowUp') m.fy = PFS.clamp(m.fy - step, 0, 1 - (m.fh || 0));
    else if (e.key === 'ArrowDown') m.fy = PFS.clamp(m.fy + step, 0, 1 - (m.fh || 0));
    sel.layout(); markDirty();
  }
  if (e.ctrlKey || e.metaKey) {
    const k0 = (e.key || '').toLowerCase();
    const code = e.code || '';
    // undo/redo are GLOBAL — filling happens inside inputs, and that is
    // exactly where a mistake needs Ctrl+Z to work. Matched by PHYSICAL key
    // (e.code): on a Hebrew layout Ctrl+Z arrives as e.key='ז', and matching
    // the letter alone made undo silently dead for Hebrew typists.
    const isZ = code === 'KeyZ' || k0 === 'z';
    const isY = code === 'KeyY' || k0 === 'y';
    if (isZ && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((isZ && e.shiftKey) || isY) { e.preventDefault(); redoAction(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && !editing && !inField) {
    const k = (e.key || '').toLowerCase();
    const code2 = e.code || '';
    const is = (letter, keycode) => code2 === keycode || k === letter;
    if (is('d', 'KeyD')) {
      // duplicate the selected element slightly offset — great for repeated
      // checks/labels down a table
      if (sel) {
        e.preventDefault();
        const m = JSON.parse(JSON.stringify(sel.model)); delete m.id;
        m.fx = Math.min(0.95, m.fx + 0.02); m.fy = Math.min(0.95, m.fy + 0.02);
        const model = PFS.element.makeModel(m.kind || m.type, m.page, m);
        const c = overlay.instantiate(model); if (c) overlay.selectCtrl(c);
        markDirty();
      }
    }
    else if (is('s', 'KeyS')) { e.preventDefault(); if (!$('exportBtn').disabled) doExport(); }
    else if (is('o', 'KeyO')) { e.preventDefault(); $('pdfInput').click(); }
  }
});

// warn before leaving with unsaved work
window.addEventListener('beforeunload', (e) => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// =====================================================================
//  Data profiles ("My details")
// =====================================================================
function renderProfileSelect() {
  const sel = $('profileSel'); sel.innerHTML = '';
  const arr = profiles.all();
  if (!arr.length) { const o = document.createElement('option'); o.value=''; o.textContent='(אין פרופיל — צור חדש)'; sel.appendChild(o); }
  arr.forEach((p) => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
  if (profiles.activeId()) sel.value = profiles.activeId();
  renderProfileRows();
}
function renderProfileRows() {
  const wrap = $('profileRows'); wrap.innerHTML = '';
  const p = profiles.all().find((x) => x.id === $('profileSel').value);
  if (!p) return;
  const vals = p.values || {};
  Object.keys(vals).forEach((k) => wrap.appendChild(profileRow(p.id, k, vals[k])));
}
function profileRow(pid, key, val) {
  const row = document.createElement('div'); row.className = 'row';
  const k = document.createElement('input'); k.type='text'; k.value=key; k.placeholder='שם שדה'; k.style.flex='0 0 40%'; k.setAttribute('list','fieldKeyList');
  const v = document.createElement('input'); v.type='text'; v.value=val; v.placeholder='ערך'; v.style.flex='1';
  const del = document.createElement('button'); del.className='btn sm ghost'; del.textContent='✕';
  const commit = () => {
    const p = profiles.all().find((x) => x.id === pid); if (!p) return;
    p.values = {}; [...$('profileRows').children].forEach((r) => {
      const ins = r.querySelectorAll('input'); const kk = ins[0].value.trim(); if (kk) p.values[kk] = ins[1].value;
    });
    profiles.saveProfile(p.name, p.values);
  };
  k.addEventListener('change', commit); v.addEventListener('change', commit);
  del.addEventListener('click', () => { row.remove(); commit(); });
  row.append(k, v, del); return row;
}
$('profileSel').addEventListener('change', (e) => { profiles.setActive(e.target.value); renderProfileRows(); });
$('profileNew').addEventListener('click', async () => {
  const name = await PFS.ui.prompt('שם הפרופיל', { value: 'פרופיל חדש', placeholder: 'למשל: אישי / העסק' });
  if (name == null) return;
  profiles.saveProfile(name.trim() || 'פרופיל חדש', {}); renderProfileSelect();
});
$('profileAddRow').addEventListener('click', () => {
  let p = profiles.all().find((x) => x.id === $('profileSel').value);
  if (!p) { profiles.saveProfile('פרופיל חדש', {}); renderProfileSelect(); p = profiles.active(); }
  $('profileRows').appendChild(profileRow(p.id, '', ''));
});
// Fill tagged elements by MEANING (+ address/name/amount-in-words derivation),
// so the profile button & Fill-All are as smart as the detected-fields panel.
function smartFill(map) {
  if (!map) return 0;
  try {
    const keys = overlay.fieldKeys ? overlay.fieldKeys() : [];
    const fields = keys.map((k) => ({ fieldKey: k, label: k, type: 'text' }));
    const resolved = PFS.vault && PFS.vault.matchValues ? PFS.vault.matchValues(fields, map, []) : {};
    return overlay.fillByKeys(Object.assign({}, map, resolved));
  } catch (e) { return overlay.fillByKeys(map); }
}
$('profileFill').addEventListener('click', () => {
  const p = profiles.all().find((x) => x.id === $('profileSel').value);
  if (!p || !p.values) { PFS.toast('אין נתונים בפרופיל', 'err'); return; }
  const n = smartFill(p.values);
  PFS.toast(n ? `מולאו ${n} שדות` : 'לא נמצאו שדות מתויגים תואמים', n ? 'ok' : 'err');
});
$('profileGrab').addEventListener('click', async () => {
  const vals = overlay.currentValues();
  if (!Object.keys(vals).length) { PFS.toast('אין שדות מתויגים בטופס', 'err'); return; }
  let p = profiles.all().find((x) => x.id === $('profileSel').value);
  let name = p ? p.name : await PFS.ui.prompt('שם הפרופיל', { value: 'פרופיל חדש' });
  if (name == null) return;
  name = name.trim() || 'פרופיל חדש';
  const merged = Object.assign({}, p?.values || {}, vals);
  profiles.saveProfile(name, merged); renderProfileSelect();
  PFS.toast('הפרטים נשמרו לפרופיל', 'ok');
});
renderProfileSelect();

// ---- quick personal-details setup: fill the whole vault in one screen ----
// canonical key → the Hebrew profile-field name it's stored under + input id
const QUICK_FIELDS = [
  { canon: 'full_name', key: 'שם מלא', id: 'qsFullName' },
  { canon: 'id', key: 'תעודת זהות', id: 'qsId' },
  { canon: 'birth_date', key: 'תאריך לידה', id: 'qsBirth' },
  { canon: 'phone', key: 'טלפון', id: 'qsPhone' },
  { canon: 'email', key: 'דוא״ל', id: 'qsEmail' },
  { canon: 'address', key: 'כתובת', id: 'qsAddress' }
];
function quickCanonVals() {
  // resolve the active profile's values to canonical keys for prefill
  const ap = profiles.active(); const out = {};
  if (ap && ap.values) Object.keys(ap.values).forEach((k) => {
    const c = PFS.vault.matchKey(k);
    if (c && out[c] === undefined && String(ap.values[k]).trim()) out[c] = ap.values[k];
  });
  return out;
}
function openQuickSetup() {
  const cv = quickCanonVals();
  QUICK_FIELDS.forEach((f) => { const el = $(f.id); if (el) el.value = cv[f.canon] || ''; });
  const g = cv.gender || '';
  document.querySelectorAll('input[name="qsGender"]').forEach((r) => { r.checked = (r.value === g); });
  const ms = cv.marital_status || '';
  document.querySelectorAll('input[name="qsMarital"]').forEach((r) => { r.checked = (r.value === ms); });
  const hf = cv.health_fund || '';
  document.querySelectorAll('input[name="qsHealth"]').forEach((r) => { r.checked = (r.value === hf); });
  openModal('quickModal');
}
$('quickSetupBtn').addEventListener('click', openQuickSetup);
$('qsCancel').addEventListener('click', () => closeModal('quickModal'));
$('qsSave').addEventListener('click', () => {
  const ap = profiles.active();
  const merged = Object.assign({}, ap && ap.values);
  QUICK_FIELDS.forEach((f) => { const v = ($(f.id).value || '').trim(); if (v) merged[f.key] = v; else delete merged[f.key]; });
  const gEl = document.querySelector('input[name="qsGender"]:checked');
  if (gEl) merged['מין'] = gEl.value; else delete merged['מין'];
  const mEl = document.querySelector('input[name="qsMarital"]:checked');
  if (mEl) merged['מצב משפחתי'] = mEl.value; else delete merged['מצב משפחתי'];
  const hEl = document.querySelector('input[name="qsHealth"]:checked');
  if (hEl) merged['קופת חולים'] = hEl.value; else delete merged['קופת חולים'];
  profiles.saveProfile(ap ? ap.name : 'אני', merged);
  renderProfileSelect();
  closeModal('quickModal');
  // re-apply to the open form so the effect is immediate: fill tagged elements
  // AND re-prefill the detected-fields panel (text + gender/marital/health tick)
  let n = 0;
  if (pdfView.hasDoc()) {
    n += smartFill(merged);
    if (lastDet && lastDet.fields && lastDet.fields.length) n += fieldsPanel.show(lastDet, vaultPrefill(lastDet));
  }
  PFS.toast(n ? `נשמר ✓ — ${n} שדות מולאו בטופס` : 'הפרטים נשמרו ✓', 'ok');
});

// ---- smart vault: build the profile from a photo of an ID / license ----
const HEB_KEY_LABEL = { last_name: 'שם משפחה', first_name: 'שם פרטי', full_name: 'שם מלא', id: 'תעודת זהות', birth_date: 'תאריך לידה', phone: 'טלפון' };
function vaultScanStatus(t) { const el = $('vaultScanStatus'); if (el) { el.style.display = t ? '' : 'none'; el.textContent = t || ''; } }
$('vaultScanBtn').addEventListener('click', () => {
  if (!(window.Tesseract && window.PFS_TESS)) { PFS.toast('קריאת תעודות אינה זמינה בגרסה זו (אין OCR)', 'err'); return; }
  $('vaultInput').click();
});
/* scanIdPhoto(file, onStatus) → vals ({full_name, id, phone, …} canon keys)
 * The one OCR pipeline, shared by profile quick-setup AND the course binder's
 * "add student from an ID photo". All local, nothing leaves the device. */
async function scanIdPhoto(file, onStatus) {
  const status = onStatus || (() => {});
  // downscale big photos for OCR speed
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
  const maxW = 1600, sc = Math.min(1, maxW / img.naturalWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  const text = await PFS.vault.recognizeImage(c, (p) => status(`קורא את התעודה… ${Math.round(p * 100)}%`));
  return PFS.vault.extractFromText(text);
}
$('vaultInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  const btn = $('vaultScanBtn'); btn.disabled = true;
  vaultScanStatus('קורא את התעודה… זה לוקח עד חצי דקה, הכול מקומי במכשיר 🔒');
  try {
    const vals = await scanIdPhoto(file, vaultScanStatus);
    const found = Object.keys(vals);
    if (!found.length) { vaultScanStatus(''); PFS.toast('לא הצלחתי לחלץ פרטים מהתמונה — נסו צילום ישר, מואר וחד', 'err'); return; }
    // merge into the active profile (create one on first use), Hebrew keys so
    // they match form labels naturally
    let p = profiles.active();
    const merged = Object.assign({}, p ? p.values : {});
    found.forEach((k) => { merged[HEB_KEY_LABEL[k] || k] = vals[k]; });
    profiles.saveProfile(p ? p.name : 'אני', merged);
    renderProfileSelect();
    vaultScanStatus('');
    PFS.toast(`✓ חולצו ${found.length} פרטים (${found.map((k) => HEB_KEY_LABEL[k] || k).join(', ')}) — בדקו ותקנו למטה`, 'ok', 6000);
  } catch (err) {
    console.error(err);
    vaultScanStatus('');
    PFS.toast('קריאת התעודה נכשלה — נסו תמונה אחרת', 'err');
  } finally { btn.disabled = false; }
});

// =====================================================================
//  Course binder — "מי הגיש מה" without the side spreadsheet
// =====================================================================
let coursesView = null; // null = course list; courseId = that course's grid
function renderCourses() {
  const body = $('coursesBody'); body.innerHTML = '';
  const C = PFS.courses;
  if (coursesView) { renderCourseGrid(C.get(coursesView)); return; }
  const list = C.all();
  const top = document.createElement('div');
  top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px';
  top.innerHTML = '<span class="hint muted">קורס = רשימת תלמידים + הטפסים שכל אחד צריך להגיש. כל ייצוא מסמן ✓ אוטומטית.</span>';
  const add = document.createElement('button'); add.className = 'btn sm primary'; add.textContent = '+ קורס חדש';
  add.addEventListener('click', async () => {
    const name = await PFS.ui.prompt('קורס חדש', { placeholder: 'למשל: אילוף כלבים — מחזור ג׳' });
    if (name && name.trim()) { const c = PFS.courses.create(name.trim()); coursesView = c.id; renderCourses(); }
  });
  top.appendChild(add); body.appendChild(top);
  if (!list.length) {
    body.insertAdjacentHTML('beforeend', '<div class="hint muted" style="text-align:center;padding:24px">עוד אין קורסים — צרו את הראשון ותפסיקו לנהל מעקב באקסל צדדי.</div>');
    return;
  }
  list.forEach((c) => {
    const miss = PFS.courses.missingCount(c);
    const row = document.createElement('div');
    row.className = 'card'; row.style.cssText = 'margin-bottom:8px;cursor:pointer';
    row.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px">
      <div style="flex:1;min-width:0"><b>${c.name}</b>
        <div class="hint muted">${c.students.length} תלמידים · ${c.forms.length} טפסים</div></div>
      ${miss ? `<span style="background:var(--danger-soft);color:var(--danger);font-weight:800;font-size:12px;border-radius:999px;padding:4px 10px;flex:none">חסרים ${miss}</span>`
             : (c.students.length && c.forms.length ? '<span style="color:var(--ok);font-weight:800;font-size:12px;flex:none">✓ הכול הוגש</span>' : '')}
      <button class="btn sm cs-del" style="color:var(--danger);flex:none">✕</button></div>`;
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('cs-del')) return;
      coursesView = c.id; renderCourses();
    });
    row.querySelector('.cs-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (await PFS.ui.confirm('מחיקת קורס', `למחוק את "${c.name}" כולל המעקב?`)) { PFS.courses.remove(c.id); renderCourses(); }
    });
    body.appendChild(row);
  });
}
function renderCourseGrid(c) {
  const body = $('coursesBody');
  if (!c) { coursesView = null; renderCourses(); return; }
  const C = PFS.courses;
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap';
  head.innerHTML = `<button class="btn sm" id="csBack">→ חזרה</button><b style="flex:1;font-size:15px">${c.name}</b>`;
  const pasteB = document.createElement('button'); pasteB.className = 'btn sm'; pasteB.textContent = '📋 הדבק רשימת תלמידים';
  const photoB = document.createElement('button'); photoB.className = 'btn sm'; photoB.textContent = '📸 תלמיד מצילום ת״ז';
  const formB = document.createElement('button'); formB.className = 'btn sm'; formB.textContent = '➕ הוסף את הטופס הפתוח';
  formB.disabled = !pdfView.hasDoc();
  head.append(pasteB, photoB, formB);
  body.appendChild(head);
  head.querySelector('#csBack').addEventListener('click', () => { coursesView = null; renderCourses(); });

  // paste area (hidden until asked)
  const pasteWrap = document.createElement('div');
  pasteWrap.className = 'hidden'; pasteWrap.style.marginBottom = '10px';
  pasteWrap.innerHTML = `<textarea id="csPaste" rows="4" placeholder="הדביקו מאקסל/וואטסאפ — שם, ת״ז, טלפון (עם או בלי שורת כותרת)" style="width:100%;font-size:12.5px;padding:8px;border:1px solid var(--line);border-radius:8px"></textarea>
    <button class="btn sm primary" id="csPasteGo" style="margin-top:4px">הוסף תלמידים</button>`;
  body.appendChild(pasteWrap);
  pasteB.addEventListener('click', () => pasteWrap.classList.toggle('hidden'));
  pasteWrap.querySelector('#csPasteGo').addEventListener('click', () => {
    const rows = C.parseStudentRows(pasteWrap.querySelector('#csPaste').value);
    const n = C.addStudents(c.id, rows);
    PFS.toast(n ? `נוספו ${n} תלמידים` : 'לא זוהו תלמידים חדשים ברשימה', n ? 'ok' : 'err');
    renderCourses();
  });
  photoB.addEventListener('click', () => addStudentFromPhoto(c.id));
  formB.addEventListener('click', async () => {
    if (!pdfView.hasDoc() || !currentFp) return;
    // the form must live in the library so a missing cell can reopen it
    let libId = null;
    try {
      const docs = await PFS.library.list();
      const clean = String(currentFileName || '').replace(/\.pdf$/i, '').trim();
      const hit = docs.find((d) => d.name === clean);
      if (!hit) {
        const b = pdfView.getBytes();
        const copy = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        libId = (await PFS.library.add(currentFileName, copy)).id;
      } else libId = hit.id;
    } catch (e) { console.warn(e); }
    const ok = C.addForm(c.id, { name: currentFileName, fp: currentFp, libId });
    PFS.toast(ok ? `"${currentFileName}" נוסף לקורס` : 'הטופס כבר בקורס', ok ? 'ok' : 'err');
    renderCourses();
  });

  if (!c.students.length && !c.forms.length) {
    body.insertAdjacentHTML('beforeend', '<div class="hint muted" style="text-align:center;padding:18px">התחילו: הדביקו רשימת תלמידים, פתחו טופס והוסיפו אותו לקורס.</div>');
    return;
  }
  const miss = C.missingCount(c);
  body.insertAdjacentHTML('beforeend', `<div style="margin:0 0 8px;font-weight:700;font-size:13px">${miss ? `⏳ חסרים ${miss} טפסים` : '✅ כל הטפסים הוגשו'}</div>`);

  // the grid: students × forms
  const wrap = document.createElement('div'); wrap.style.overflowX = 'auto';
  const tbl = document.createElement('table');
  tbl.style.cssText = 'border-collapse:collapse;width:100%;font-size:12.5px';
  let h = '<tr><th style="border:1px solid var(--line);padding:6px 8px;background:var(--surface-2);text-align:right">תלמיד/ה</th>';
  c.forms.forEach((f) => {
    const missN = c.students.filter((st) => !C.isSubmitted(c, C.studentKey(st), f.name)).length;
    h += `<th style="border:1px solid var(--line);padding:6px 8px;background:var(--surface-2);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${f.name}">${f.name}
      ${missN && f.libId ? `<button class="btn sm cs-produce" data-form="${f.name}" style="border:0;background:none;color:var(--accent-600);padding:0 2px;cursor:pointer;font-weight:800" title="⚡ הפק PDF מוכן לכל ${missN} החסרים — בלי לפתוח את הטופס">⚡${missN}</button>` : ''}
      <button class="btn sm cs-form-del" data-form="${f.name}" style="border:0;background:none;color:var(--ink-4);padding:0 2px;cursor:pointer">✕</button></th>`;
  });
  h += '<th style="border:1px solid var(--line);padding:6px;background:var(--surface-2)"></th></tr>';
  c.students.forEach((st) => {
    const k = C.studentKey(st);
    h += `<tr><td style="border:1px solid var(--line);padding:6px 8px;white-space:nowrap"><b>${st.name}</b>${st.tz ? ` <span class="hint muted">${st.tz}</span>` : ''}</td>`;
    c.forms.forEach((f) => {
      const done = C.isSubmitted(c, k, f.name);
      h += `<td style="border:1px solid var(--line);padding:3px;text-align:center">
        <button class="cs-cell" data-key="${k}" data-form="${f.name}" data-lib="${f.libId || ''}"
          title="${done ? 'הוגש — קליק לביטול הסימון' : 'קליק: פתח ומלא עבור התלמיד/ה · Shift+קליק: סמן שהוגש'}"
          style="border:0;background:${done ? 'var(--ok-soft)' : 'transparent'};color:${done ? 'var(--ok)' : 'var(--ink-4)'};font-weight:800;cursor:pointer;border-radius:6px;padding:4px 12px">${done ? '✓' : '—'}</button></td>`;
    });
    h += `<td style="border:1px solid var(--line);padding:3px;text-align:center"><button class="cs-st-del" data-key="${k}" style="border:0;background:none;color:var(--danger);cursor:pointer;font-size:11px">✕</button></td></tr>`;
  });
  tbl.innerHTML = h; wrap.appendChild(tbl); body.appendChild(wrap);

  tbl.querySelectorAll('.cs-cell').forEach((btn) => btn.addEventListener('click', async (e) => {
    const key = btn.dataset.key, formName = btn.dataset.form;
    const done = C.isSubmitted(C.get(c.id), key, formName);
    if (done) { C.setSubmitted(c.id, key, formName, false); renderCourses(); return; }
    if (e.shiftKey || !btn.dataset.lib) { C.setSubmitted(c.id, key, formName, true); renderCourses(); return; }
    // open the form from the library, pre-filled for THIS student
    const st = C.get(c.id).students.find((x) => C.studentKey(x) === key);
    if (st) pendingStudent = { 'שם מלא': st.name, 'תעודת זהות': st.tz || '', 'טלפון': st.phone || '' };
    closeModal('coursesModal');
    openFromLibrary(btn.dataset.lib);
  }));
  tbl.querySelectorAll('.cs-produce').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true; const prev = b.textContent; b.textContent = '⏳';
    PFS.toast('⚡ מפיק טפסים… זה לוקח כמה שניות', 'ok', 4000);
    try {
      const res = await produceCourseForm(c.id, b.dataset.form);
      if (res.error) PFS.toast(res.error, 'err');
      else {
        PFS.toast(`⚡ הופקו ${res.count} טפסים מוכנים (${res.students.join(', ')}) — כולם סומנו ✓`, 'ok', 7000);
        renderCourses();
      }
    } catch (err) { console.error(err); PFS.toast('ההפקה נכשלה: ' + (err.message || err), 'err'); }
    finally { b.disabled = false; b.textContent = prev; }
  }));
  tbl.querySelectorAll('.cs-form-del').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await PFS.ui.confirm('הסרת טופס', `להסיר את "${b.dataset.form}" מהקורס?`)) { C.removeForm(c.id, b.dataset.form); renderCourses(); }
  }));
  tbl.querySelectorAll('.cs-st-del').forEach((b) => b.addEventListener('click', async () => {
    if (await PFS.ui.confirm('הסרת תלמיד/ה', 'להסיר מהקורס כולל המעקב?')) { C.removeStudent(c.id, b.dataset.key); renderCourses(); }
  }));
}
/* extractPersonMap(text) — turn ANY pasted text (a WhatsApp message, a line
 * from a list, free text) into Hebrew-keyed person values, ready to ride the
 * same one-shot canon prefill students use. Combines the vault extractor
 * (checksummed ת"ז, phones, names, emails) with the free-line heuristic. */
const PASTE_KEY_LABEL = Object.assign({}, HEB_KEY_LABEL, {
  email: 'דוא״ל', address: 'כתובת', city: 'עיר', gender: 'מין'
});
function extractPersonMap(text) {
  const map = {};
  try {
    const vals = PFS.vault.extractFromText(text) || {};
    Object.keys(vals).forEach((k) => { map[PASTE_KEY_LABEL[k] || k] = vals[k]; });
  } catch (e) {}
  // first+last without a full name → compose one (forms mostly ask שם מלא)
  if (!map['שם מלא'] && (map['שם פרטי'] || map['שם משפחה'])) {
    map['שם מלא'] = [map['שם פרטי'], map['שם משפחה']].filter(Boolean).join(' ');
  }
  // the row heuristic catches what the extractor missed (bare "שם 123456789")
  try {
    const rows = PFS.courses.parseStudentRows(text);
    if (rows.length === 1) {
      if (rows[0].name && !map['שם מלא']) map['שם מלא'] = rows[0].name;
      if (rows[0].tz && !map['תעודת זהות']) map['תעודת זהות'] = rows[0].tz;
      if (rows[0].phone && !map['טלפון']) map['טלפון'] = rows[0].phone;
    }
  } catch (e) {}
  // the extractor's name heuristic can swallow the whole line — a NAME has
  // no long digit runs, so strip numeric tokens (ת"ז, phones) out of it
  ['שם מלא', 'שם פרטי', 'שם משפחה'].forEach((k) => {
    if (!map[k]) return;
    map[k] = String(map[k]).split(/\s+/)
      .filter((t) => (t.replace(/\D/g, '').length < 3))
      .join(' ').replace(/\s+/g, ' ').trim();
    if (!map[k]) delete map[k];
  });
  Object.keys(map).forEach((k) => { if (!String(map[k] || '').trim()) delete map[k]; });
  return map;
}
/* fillPersonMap(map) — one-shot fill of the OPEN form with a person's values
 * (outranks the profile: this form is about THEM). Returns filled count. */
function fillPersonMap(map) {
  if (!lastDet || !lastDet.fields || !Object.keys(map).length) return 0;
  pendingStudent = map;
  const pre = vaultPrefill(lastDet);
  pendingStudent = null;
  if (!pre) return 0;
  return fieldsPanel.show(lastDet, pre);
}
PFS.extractPersonMap = extractPersonMap;
PFS.fillPersonMap = fillPersonMap;
PFS.scanPersonPhoto = async (file) => {
  const vals = await scanIdPhoto(file, () => {});
  const map = {};
  Object.keys(vals).forEach((k) => { map[PASTE_KEY_LABEL[k] || k] = vals[k]; });
  return map;
};

/* readDocText() — the printed text of the open PDF, in two assemblies:
 * content order (usually logical) and per-line visual RTL order. Extraction
 * runs on both — whichever reads coherently wins. */
async function readDocText() {
  const doc = pdfView.getDoc(); if (!doc) return { a: '', b: '' };
  let a = '', b = '';
  const n = Math.min(doc.numPages, 4);
  for (let i = 1; i <= n; i++) {
    const pg = await doc.getPage(i);
    const tc = await pg.getTextContent();
    a += tc.items.map((it) => it.str).join(' ') + '\n';
    // group into lines by baseline, order each line right-to-left
    const lines = [];
    tc.items.forEach((it) => {
      if (!it.str || !it.str.trim()) return;
      const y = Math.round(it.transform[5]);
      let ln = lines.find((L) => Math.abs(L.y - y) < 4);
      if (!ln) { ln = { y, items: [] }; lines.push(ln); }
      ln.items.push(it);
    });
    lines.sort((x, y2) => y2.y - x.y);
    lines.forEach((ln) => {
      ln.items.sort((x, y2) => (y2.transform[4] - x.transform[4]));
      b += ln.items.map((it) => it.str).join('') + '\n';
    });
  }
  return { a, b };
}

/* extractQuoteMap(text) — pull the DEAL facts out of a letter-style document
 * (a price quote): person (via the vault extractor), course name, branch and
 * course period dates. Values are keyed under the common label wordings so
 * exact-label carry bridges the appendix's phrasing. */
function extractQuoteMap(text) {
  const map = extractPersonMap(text);
  const grab = (rx) => { const m = text.match(rx); return m ? m[1].replace(/\s+/g, ' ').trim() : null; };
  const course = grab(/לקורס\s+([א-ת][א-ת"'\s]{1,30}?)(?=\s+(?:עבור|ת\.?["']?ז|בתאריך|החל|מס)|[\n,.:]|$)/)
    || grab(/(?:^|\n)\s*קורס\s*[:：]\s*([א-ת][א-ת"'\s]{1,30}?)(?=[\n,.]|$)/);
  if (course) { map['שם הקורס'] = course; map['שם הקורס המבוקש'] = course; map['הקורס המבוקש'] = course; }
  const forName = grab(/עבור\s+([א-ת][א-ת'\-\s]{1,25}?)(?=\s+ת\.?["']?\s*ז|\s+\d|[\n,.:]|$)/);
  if (forName && !map['שם מלא']) map['שם מלא'] = forName;
  const branch = grab(/סניף\s*[:：]?\s+([א-ת][א-ת\s]{1,20}?)(?=[\n,.]|$)/);
  if (branch) map['סניף'] = branch;
  const d1 = grab(/תאריך\s+התחלה\s*[:：]?\s*([\d./-]{6,10})/) || grab(/החל\s+מ?[־-]?\s*([\d./-]{6,10})/);
  if (d1) { map['תאריך תחילת הקורס'] = d1; map['תאריך התחלה'] = d1; }
  const d2 = grab(/תאריך\s+סיום(?:\s+משוער)?\s*[:：]?\s*([\d./-]{6,10})/);
  if (d2) { map['תאריך סיום הקורס'] = d2; map['תאריך סיום'] = d2; }
  Object.keys(map).forEach((k) => { if (!String(map[k] || '').trim()) delete map[k]; });
  return map;
}
PFS.extractQuoteMap = extractQuoteMap;

/* Zero-form: produce finished PDFs for every student still missing a form —
 * no viewing, no per-student filling. Reuses the whole battle-tested stack:
 * library bytes → open+detect+ink-snap → per-student vaultPrefill (student
 * outranks profile, patterns fill the org constants) → the mail-merge engine
 * renders one PDF per student → ZIP named per student → cells auto-mark ✓. */
async function produceCourseForm(courseId, formName, deliver = true) {
  const C = PFS.courses;
  const c = C.get(courseId); if (!c) return { error: 'קורס לא נמצא' };
  const form = c.forms.find((f) => f.name === formName);
  if (!form) return { error: 'טופס לא נמצא' };
  if (!form.libId) return { error: 'הטופס לא שמור במאגר — פתחו אותו והוסיפו לקורס מחדש' };
  const missing = c.students.filter((s) => !C.isSubmitted(c, C.studentKey(s), formName));
  if (!missing.length) return { error: 'כולם כבר הגישו את הטופס הזה ✓' };
  await openFromLibrary(form.libId);
  const t0 = Date.now();
  while ((!lastDet || !lastDet.fields || !lastDet.fields.length) && Date.now() - t0 < 12000) {
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!lastDet || !lastDet.fields || !lastDet.fields.length) return { error: 'זיהוי השדות נכשל' };
  // start from a clean sheet: restored auto-memory must not leak stale values
  overlay.clearElements(); fieldsPanel.clear();
  // one value-map per student, through the full prefill stack
  const maps = missing.map((st) => {
    pendingStudent = { 'שם מלא': st.name, 'תעודת זהות': st.tz || '', 'טלפון': st.phone || '' };
    const pre = vaultPrefill(lastDet) || {};
    pendingStudent = null;
    const txt = {};
    Object.keys(pre).forEach((k) => { if (typeof pre[k] === 'string' && pre[k].trim()) txt[k] = pre[k]; });
    return txt;
  });
  const keys = [...new Set(maps.flatMap((m) => Object.keys(m)))];
  if (!keys.length) return { error: 'אין נתונים למילוי — מלאו את פרטי המכללה ופרטי התלמידים' };
  // materialize placement ONCE (ensureCtrl does ink-snapped geometry, font
  // fitting and right-edge anchoring); merge then swaps text per student
  const unionMap = {};
  keys.forEach((k) => { const src = maps.find((m) => m[k]); if (src) unionMap[k] = src[k]; });
  fieldsPanel.show(lastDet, unionMap);
  const baseModels = overlay.getElements().map((el) => el.model);
  if (!baseModels.length) return { error: 'אין שדות למילוי' };
  const records = maps.map((m, i) => {
    const r = {}; keys.forEach((k) => { r[k] = m[k] || ''; });
    r.__name = missing[i].name; return r;
  });
  const { zip, count } = await PFS.merge.runBatch({
    originalBytes: pdfView.getBytes(), baseModels, records, nameField: '__name'
  });
  missing.forEach((st) => C.setSubmitted(c.id, C.studentKey(st), formName, true));
  if (deliver) PFS.merge.downloadZip(zip, `${formName} - ${c.name}.zip`);
  return { count, zip, students: missing.map((s) => s.name) };
}

// course binder: photograph an ID → a student row (confirmed before saving)
let csPhotoInput = null;
function addStudentFromPhoto(courseId) {
  if (!csPhotoInput) {
    csPhotoInput = document.createElement('input');
    csPhotoInput.type = 'file'; csPhotoInput.accept = 'image/*';
    document.body.appendChild(csPhotoInput);
    csPhotoInput.style.display = 'none';
  }
  csPhotoInput.onchange = async () => {
    const file = csPhotoInput.files[0]; csPhotoInput.value = '';
    if (!file) return;
    PFS.toast('קורא את התעודה… הכול מקומי במכשיר 🔒', 'ok', 3000);
    try {
      const vals = await scanIdPhoto(file, () => {});
      const name = [vals.first_name, vals.last_name].filter(Boolean).join(' ') || vals.full_name || '';
      if (!name && !vals.id) { PFS.toast('לא זוהו פרטים — נסו צילום ישר ומואר', 'err'); return; }
      const conf = await PFS.ui.prompt('אישור פרטי תלמיד/ה', {
        value: `${name || ''}${vals.id ? ', ' + vals.id : ''}${vals.phone ? ', ' + vals.phone : ''}`,
        message: 'זה מה שחולץ מהצילום (שם, ת״ז, טלפון) — תקנו אם צריך ואשרו'
      });
      if (conf == null) return;
      const rows = PFS.courses.parseStudentRows(conf);
      const n = rows.length ? PFS.courses.addStudents(courseId, rows) : 0;
      PFS.toast(n ? `✓ ${rows[0].name} נוסף/ה לקורס` : 'לא נוסף — בדקו את הפורמט', n ? 'ok' : 'err');
      renderCourses();
    } catch (e) { console.error(e); PFS.toast('קריאת הצילום נכשלה', 'err'); }
  };
  csPhotoInput.click();
}
$('coursesBtn') && $('coursesBtn').addEventListener('click', () => { coursesView = null; renderCourses(); openModal('coursesModal'); });
$('coursesClose') && $('coursesClose').addEventListener('click', () => closeModal('coursesModal'));

// =====================================================================
//  Mail-merge (batch)
// =====================================================================
let mergeParsed = null; // { headers, records }
function openMerge() {
  const keys = overlay.fieldKeys();
  $('mergeKeys').innerHTML = keys.length
    ? keys.map((k) => `<span class="pill" style="margin:2px">${k}</span>`).join('')
    : '<span class="muted">אין שדות מתויגים — הוסיפו “שם שדה” לשדות טקסט תחילה.</span>';
  // seed CSV textarea with a header row of the field keys if empty
  if (keys.length && !$('mergeCsv').value.trim()) $('mergeCsv').value = keys.join(',') + '\n';
  mergeParsed = null; mergeMapping = null; $('mergeRun').disabled = true; $('mergeStatus').textContent = ''; $('mergeProg').textContent = '';
  $('mergeMapWrap').classList.add('hidden'); $('mergePreviewWrap').classList.add('hidden');
  openModal('mergeModal');
}
let mergeMapping = null; // header → fieldKey|null (auto + manual overrides)
function renderMergeMapUI(parsed, keys) {
  const wrap = $('mergeMap'); wrap.innerHTML = '';
  parsed.headers.forEach((h) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px';
    const lab = document.createElement('span');
    lab.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600';
    lab.textContent = h; lab.title = h;
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1.2;min-width:0;padding:4px 6px;font-size:12px;border:1px solid var(--line);border-radius:7px;background:var(--surface)';
    const none = document.createElement('option'); none.value = ''; none.textContent = '(דלג על העמודה)'; sel.appendChild(none);
    keys.forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });
    sel.value = mergeMapping[h] || '';
    if (mergeMapping[h]) sel.style.borderColor = 'var(--ok)';
    sel.addEventListener('change', () => {
      mergeMapping[h] = sel.value || null;
      sel.style.borderColor = sel.value ? 'var(--ok)' : 'var(--line)';
      renderMergePreview(parsed);
    });
    row.append(lab, sel);
    wrap.appendChild(row);
  });
  $('mergeMapWrap').classList.remove('hidden');
}
function renderMergePreview(parsed) {
  const mapped = parsed.headers.filter((h) => mergeMapping[h]);
  const pv = $('mergePreview');
  if (!mapped.length) { pv.innerHTML = '<span class="muted">אין עמודות ממופות</span>'; return; }
  const rows = parsed.records.slice(0, 3);
  let html = '<table style="border-collapse:collapse;width:100%"><tr>' +
    mapped.map((h) => `<th style="border:1px solid var(--line);padding:3px 6px;background:var(--surface-2);white-space:nowrap">${mergeMapping[h]}</th>`).join('') + '</tr>';
  rows.forEach((r) => {
    html += '<tr>' + mapped.map((h) => `<td style="border:1px solid var(--line);padding:3px 6px;white-space:nowrap">${(r[h] || '')}</td>`).join('') + '</tr>';
  });
  pv.innerHTML = html + '</table>' + (parsed.records.length > 3 ? `<div class="hint muted">…ועוד ${parsed.records.length - 3} שורות</div>` : '');
  $('mergePreviewWrap').classList.remove('hidden');
}
function doParseMerge() {
  const txt = $('mergeCsv').value;
  const parsed = PFS.merge.parseCSV(txt);
  if (!parsed.records.length) { $('mergeStatus').textContent = 'לא נמצאו רשומות'; $('mergeRun').disabled = true; mergeParsed = null; return; }
  mergeParsed = parsed;
  const keys = overlay.fieldKeys();
  // smart mapping: exact-normalized then shared-canon ('שם התלמיד' ↔ 'שם מלא')
  mergeMapping = PFS.merge.mapHeaders(parsed.headers, keys);
  const mappedCount = parsed.headers.filter((h) => mergeMapping[h]).length;
  $('mergeStatus').textContent = `${parsed.records.length} רשומות · ${mappedCount}/${parsed.headers.length} עמודות מופו`;
  renderMergeMapUI(parsed, keys);
  renderMergePreview(parsed);
  const nf = $('mergeNameField'); nf.innerHTML = '<option value="">(מספר רץ)</option>';
  parsed.headers.forEach((h) => { const o = document.createElement('option'); o.value=h; o.textContent=h; nf.appendChild(o); });
  // default file naming: the column that means "person name"
  const nameCol = parsed.headers.find((h) => mergeMapping[h] && PFS.vault.matchKey(mergeMapping[h]) === 'full_name')
    || parsed.headers.find((h) => PFS.vault.matchKey(h) === 'full_name');
  if (nameCol) nf.value = nameCol;
  $('mergeRun').disabled = mappedCount === 0;
}
$('mergeParse').addEventListener('click', doParseMerge);
$('mergeCsv').addEventListener('input', () => { $('mergeRun').disabled = true; });
$('mergeLoadFile').addEventListener('click', () => $('mergeFile').click());
$('mergeFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return; e.target.value='';
  $('mergeCsv').value = await f.text(); doParseMerge();
});
$('mergeClose').addEventListener('click', () => closeModal('mergeModal'));
$('mergeRun').addEventListener('click', async () => {
  if (!mergeParsed) doParseMerge();
  if (!mergeParsed) return;
  const baseModels = overlay.getElements().map((c) => c.model);
  if (!baseModels.length) { PFS.toast('הטופס ריק', 'err'); return; }
  const btn = $('mergeRun'); btn.disabled = true; const prev = btn.textContent;
  try {
    // records arrive keyed by spreadsheet headers — rekey them to fieldKeys
    // via the mapping; the naming column stays a header, so stash its raw
    // value under a reserved key that can never collide with a fieldKey.
    const nameHeader = $('mergeNameField').value;
    const records = PFS.merge.remapRecords(mergeParsed.records, mergeMapping || {}).map((r, i) => {
      if (nameHeader) r.__name = mergeParsed.records[i][nameHeader];
      return r;
    });
    const { zip, count } = await PFS.merge.runBatch({
      originalBytes: pdfView.getBytes(),
      baseModels,
      records,
      nameField: nameHeader ? '__name' : '',
      onProgress: (d, t) => { $('mergeProg').textContent = `מפיק ${d}/${t}…`; }
    });
    PFS.merge.downloadZip(zip, currentFileName + '-batch.zip');
    PFS.toast(`הופקו ${count} קבצים ל-ZIP`, 'ok');
  } catch (e) {
    console.error(e); PFS.toast('המיזוג נכשל: ' + (e.message || e), 'err');
  } finally { btn.disabled = false; btn.textContent = prev; $('mergeProg').textContent=''; }
});
$('mergeBtn').addEventListener('click', () => { if (pdfView.hasDoc()) openMerge(); });
$('detectBtn').addEventListener('click', runDetection);
// is any page rotated / deleted / reordered away from the loaded original?
function hasPageOps() {
  try {
    const rot = pdfView.getRotations ? pdfView.getRotations() : {};
    const rotated = Object.values(rot).some((v) => ((((v || 0) % 360) + 360) % 360) !== 0);
    const deleted = pdfView.getRemovedPages ? pdfView.getRemovedPages().length > 0 : false;
    const reordered = pdfView.isReordered ? pdfView.isReordered() : false;
    return rotated || deleted || reordered;
  } catch (e) { return false; }
}
// return the form to its just-loaded state: remove every placed field AND undo
// page rotations/deletions/reordering (undo still offers finer-grained steps).
async function resetForm() {
  overlay.clearElements(); fieldsPanel.clear();
  try { if (pdfView.setPageState) await pdfView.setPageState({ rotations: {}, removed: [], order: null }); } catch (e) {}
  markDirty();
  skipPrefillOnce = true;
  try { await runDetection(); } catch (e) {}
}
$('clearBtn').addEventListener('click', async () => {
  if (!overlay.getElements().length && !hasPageOps()) { PFS.toast('הטופס כבר ריק', 'ok'); return; }
  if (!(await PFS.ui.confirm('ניקוי הטופס', 'למחוק את כל מה שמולא ולבטל שינויי עמודים (סיבוב/מחיקה/סדר)? הטופס יחזור למצבו המקורי.'))) return;
  await resetForm();
  PFS.toast('הטופס נוקה', 'ok');
});

// =====================================================================
//  Handwriting ("כתב היד שלי")
// =====================================================================
const HW = () => PFS.handwriting;
let hwPad = null, hwIndex = 0;
function hwInk() { return ($('hwInk') && $('hwInk').value) || '#000000'; }
function updateHwStatus() {
  const el = $('hwStatus');
  if (!el) return;
  const n = HW().count(), total = HW().GLYPHS.length;
  const base = n ? `אומנו ${n}/${total} תווים — מוכן לכתיבה.` : 'עדיין לא אימנת כתב יד.';
  if (n && !PFS.store.persistent) {
    // Volatile host (sandboxed artifact): the trained glyphs live only in this
    // window and vanish on reload. Say so plainly so the user isn't surprised
    // when it "forgets" next login, and point at the durable options.
    el.innerHTML = base + ' <span style="color:var(--warn)">⚠️ בסביבה זו כתב־היד לא יישמר לפעם הבאה — פתחו את האפליקציה דרך הקישור באתר (github.io), או גבו לקובץ ב⚙️ הגדרות.</span>';
  } else if (n) {
    el.innerHTML = base + ' <span style="color:var(--ok,#1a7f4b)">✓ נשמר במכשיר.</span>';
  } else {
    el.textContent = base;
  }
}
function startHandwritingFlow() {
  if (!pdfView.hasDoc()) { PFS.toast('פתח קודם קובץ PDF', 'err'); return; }
  if (!HW().hasGlyphs()) { PFS.toast('קודם אמן/י כתב יד', 'ok'); openHwTrainer(); return; }
  writeHandwriting();
}
/* In-app write modal with live preview (window.prompt is blocked in
   sandboxed hosts like the published artifact). */
let hwWriteWired = false;
function writeHandwriting() {
  openModal('hwWriteModal');
  if (!hwWriteWired) {
    hwWriteWired = true;
    const inp = $('hwWriteText'), prev = $('hwWritePreview'), place = $('hwWritePlace');
    const upd = () => {
      const t = inp.value.trim();
      if (!t) { place.disabled = true; prev.innerHTML = '<span class="hint muted">הקלידו טקסט כדי לראות אותו בכתב ידכם…</span>'; return; }
      const r = HW().renderText(t, { fontPx: 56, color: $('hwWriteInk').value, weight: HW().getWeight() });
      // Nothing was inked → every character is untrained. Don't show an empty
      // frame (looks broken) and don't let the user place an invisible box.
      if (!r.drawn) {
        place.disabled = true;
        const miss = (r.missing || []).join(' ');
        prev.innerHTML = '<span class="hint" style="color:var(--warn)">⚠️ אין אותיות מאומנות לטקסט הזה' + (miss ? ' (חסרות: ' + miss + ')' : '') + '. לחצו “✍️ אמן / עדכן אותיות”.</span>';
        return;
      }
      place.disabled = false;
      prev.innerHTML = '';
      const img = new Image(); img.src = r.url; img.alt = t;
      prev.appendChild(img);
      if (r.missing && r.missing.length) {
        const note = document.createElement('div');
        note.className = 'hint'; note.style.color = 'var(--warn)'; note.style.marginTop = '4px';
        note.textContent = 'שים לב: אותיות שלא אומנו יופיעו כרווח ריק (' + r.missing.join(' ') + ').';
        prev.appendChild(note);
      }
    };
    inp.addEventListener('input', upd);
    $('hwWriteInk').addEventListener('input', upd);
    $('hwBeautify').checked = HW().getBeautify();
    $('hwBeautify').addEventListener('change', () => { HW().setBeautify($('hwBeautify').checked); upd(); });
    $('hwTracking').addEventListener('input', () => { HW().setTracking(parseFloat($('hwTracking').value)); upd(); });
    $('hwWeight').addEventListener('input', () => { HW().setWeight(parseFloat($('hwWeight').value)); upd(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !place.disabled) { e.preventDefault(); place.click(); } });
    $('hwWriteCancel').addEventListener('click', () => closeModal('hwWriteModal'));
    $('hwWriteTrain').addEventListener('click', () => { closeModal('hwWriteModal'); openHwTrainer(); });
    place.addEventListener('click', () => {
      const text = inp.value.trim(); if (!text) return;
      closeModal('hwWriteModal');
      placeHandwriting(text, $('hwWriteInk').value);
    });
  }
  $('hwWriteInk').value = hwInk();
  $('hwBeautify').checked = HW().getBeautify();
  $('hwTracking').value = HW().getTracking();
  $('hwWeight').value = HW().getWeight();
  const inp = $('hwWriteText');
  requestAnimationFrame(() => { inp.focus({ preventScroll: true }); inp.select(); inp.dispatchEvent(new Event('input')); });
}
function placeHandwriting(text, color) {
  const tracking = HW().getTracking();
  const res = HW().renderText(text, { fontPx: 72, color, tracking });
  // Guard: if none of the typed characters are trained, the image is blank —
  // placing it would drop an invisible empty box on the form (the bug users
  // hit after their handwriting model was wiped). Refuse and say what's missing.
  if (!res.drawn) {
    const miss = (res.missing || []).join(' ');
    PFS.toast(miss ? `אין אותיות מאומנות לטקסט הזה (חסרות: ${miss}). אמן/י אותן קודם ב✍️.` : 'אין כתב יד מאומן — אמן/י אותיות קודם.', 'err', 6000);
    openHwTrainer();
    return;
  }
  const aspect = res.w / res.h;
  const fw = Math.max(0.08, Math.min(0.6, 0.028 * text.length + 0.08));
  overlay.setPlacing({
    sticky: false,
    create: (page, fx, fy) => {
      overlay.addElementAt('image', page, fx, fy, {
        imgUrl: res.url, aspect, fw, fh: fw / aspect, kind: 'handwriting', text, color, tracking
      });
      return null;
    }
  });
  PFS.toast('לחץ על הטופס כדי למקם', 'ok');
}
function hwCurrent() { return HW().GLYPHS[hwIndex]; }
function hwRenderTrainer() {
  const ch = hwCurrent();
  $('hwGlyph').textContent = ch;
  $('hwProg').textContent = `תו ${hwIndex + 1} מתוך ${HW().GLYPHS.length}`;
  $('hwCount').textContent = `${HW().count()}/${HW().GLYPHS.length} אומנו`;
  if (hwPad) hwPad.clear();
  const grid = $('hwGrid'); grid.innerHTML = '';
  HW().GLYPHS.forEach((c, i) => {
    const cell = document.createElement('div');
    cell.className = 'g' + (HW().hasGlyph(c) ? ' done' : '') + (i === hwIndex ? ' cur' : '');
    cell.textContent = c;
    cell.addEventListener('click', () => { hwIndex = i; hwRenderTrainer(); });
    grid.appendChild(cell);
  });
}
function hwGo(d) { const n = HW().GLYPHS.length; hwIndex = (hwIndex + d + n) % n; hwRenderTrainer(); }
function hwSaveNext() {
  if (!hwPad || hwPad.isEmpty()) { PFS.toast('צייר את התו קודם', 'err'); return; }
  // the CSS guidelines sit at 20% / 80% of the pad height — pass them as the
  // measurement reference so the glyph's true size & position are captured
  const r = $('hwCanvas').getBoundingClientRect();
  HW().setGlyph(hwCurrent(), hwPad.getStrokes(), { top: r.height * 0.20, base: r.height * 0.80 });
  updateHwStatus(); hwGo(1);
}
function openHwTrainer() {
  openModal('hwModal');
  if (!hwPad) {
    hwPad = PFS.imageTools.strokePad($('hwCanvas'));
    hwPad.setColor('#111827'); hwPad.setWidth(3);
    $('hwClear').addEventListener('click', () => hwPad.clear());
    $('hwSave').addEventListener('click', hwSaveNext);
    $('hwSkip').addEventListener('click', () => hwGo(1));
    $('hwPrev').addEventListener('click', () => hwGo(-1));
    $('hwNext').addEventListener('click', () => hwGo(1));
    $('hwClose').addEventListener('click', () => { closeModal('hwModal'); updateHwStatus(); });
    $('hwReset').addEventListener('click', async () => {
      if (await PFS.ui.confirm('מחיקת כתב היד', 'למחוק את כל התווים שאימנת?')) { HW().clearAll(); updateHwStatus(); hwRenderTrainer(); }
    });
  }
  const g = HW().GLYPHS; let idx = g.findIndex((ch) => !HW().hasGlyph(ch));
  hwIndex = idx < 0 ? 0 : idx;
  requestAnimationFrame(() => { hwPad.resize(); hwRenderTrainer(); });
}
$('hwTrainBtn').addEventListener('click', openHwTrainer);
$('hwWriteBtn').addEventListener('click', startHandwritingFlow);
updateHwStatus();

// =====================================================================
//  Fill-All (one click) + Backup / Restore
// =====================================================================
// Place the saved signature/stamp on a detected line (fields panel ✍️ / ⬤).
// Falls back to the draw/upload flow if nothing is saved yet.
function placeAssetAtField(kind, f, { silent = false } = {}) {
  const item = assets.getDefault(kind) || assets.list(kind)[0];
  if (!item) {
    if (silent) return false;
    PFS.toast(kind === 'stamp' ? 'אין חותמת שמורה — העלו חותמת קודם' : 'אין חתימה שמורה — ציירו חתימה קודם', 'err');
    (kind === 'stamp' ? startStampFlow : startSignatureFlow)();
    return false;
  }
  const aspect = item.aspect || (item.w / item.h) || (kind === 'stamp' ? 1 : 3);
  const fw = Math.min(Math.max(f.fw || 0.2, 0.14), 0.32);
  const fh = fw / aspect;
  // center on the blank and sit it a touch above the baseline
  const fx = Math.max(0, Math.min(1 - fw, (f.fx != null ? f.fx : 0.5) + ((f.fw || 0) - fw) / 2));
  const fy = Math.max(0, (f.fy != null ? f.fy : 0.82) - fh * 0.35);
  const c = overlay.instantiate(PFS.element.makeModel('image', f.page || 0, { imgUrl: item.url, aspect, fx, fy, fw, fh, kind }));
  if (c && !silent) { overlay.selectCtrl(c); PFS.scrollToEl(c.node, 'center'); }
  markDirty();
  if (!silent) PFS.toast((kind === 'stamp' ? 'החותמת הונחה' : 'החתימה הונחה') + ' על השורה — אפשר לגרור לכוונון', 'ok');
  return !!c;
}
// A detected signature/stamp line from the last detection, if any.
function detectedLine(kind) {
  if (!lastDet || !lastDet.fields) return null;
  const re = kind === 'stamp' ? /חותמת|חתמת|stamp|seal|ختم/i : /חתימ|signature|توقيع/i;
  return lastDet.fields.find((f) => f.type !== 'check' && re.test(f.label || '')) || null;
}
function placeSignatureAtField(f) { return placeAssetAtField('signature', f); }
function placeDefaultAsset(kind) {
  const item = assets.getDefault(kind);
  if (!item) return false;
  const aspect = item.aspect || (item.w / item.h) || 1;
  const fw = 0.22, fh = fw / aspect;
  const fx = kind === 'signature' ? 0.60 : 0.12, fy = 0.82;
  overlay.instantiate(PFS.element.makeModel('image', 0, { imgUrl: item.url, aspect, fx, fy, fw, fh, kind }));
  overlay.deselectAll();
  return true;
}
function fillAll() {
  if (!pdfView.hasDoc()) { PFS.toast('פתח קודם קובץ PDF', 'err'); return; }
  const did = [];
  const match = currentFp && templates.findMatch(currentFp);
  if (match) { templates.apply(match.tpl.id); did.push('תבנית'); }
  const ap = profiles.active();
  if (ap && ap.values && Object.keys(ap.values).length) { const n = smartFill(ap.values); if (n) did.push(n + ' שדות'); }
  const kinds = overlay.getElements().map((c) => c.model.kind);
  // signature/stamp: land on a detected line when one exists, else a corner
  ['signature', 'stamp'].forEach((kind) => {
    if (kinds.includes(kind)) return;
    const line = detectedLine(kind);
    const placed = line ? placeAssetAtField(kind, line, { silent: true }) : placeDefaultAsset(kind);
    if (placed) did.push(kind === 'stamp' ? 'חותמת' : 'חתימה');
  });
  PFS.toast(did.length ? ('מולא: ' + did.join(' + ')) : 'אין תבנית/פרופיל/חתימה תואמים', did.length ? 'ok' : 'err');
}
function backupExport() {
  const data = { app: 'pdf-form-studio', type: 'backup', version: 1, ts: new Date().toISOString(), data: PFS.store.dump() };
  PFS.deliver.file(JSON.stringify(data), 'pdf-form-studio-backup.json', 'application/json');
  PFS.toast('הגיבוי נוצר', 'ok');
}
async function backupImport(file) {
  try {
    const obj = JSON.parse(await file.text());
    const d = obj && obj.data ? obj.data : obj;
    if (!d || typeof d !== 'object' || !PFS.store.restore(d)) throw new Error('bad');
    assets.renderAll(); templates.render(); renderProfileSelect(); updateHwStatus();
    PFS.toast('השחזור הושלם', 'ok');
  } catch (e) { PFS.toast('קובץ גיבוי לא תקין', 'err'); }
}

// ---- cross-device sync (E2E encrypted; see js/sync.js) ------------------
function refreshAllFromStore() { assets.renderAll(); templates.render(); renderProfileSelect(); updateHwStatus(); }
const SYNC_ERR = {
  NOT_CONFIGURED: 'מלאו Project ID, API Key וקוד סנכרון.',
  WRONG_CODE: 'קוד הסנכרון שגוי — לא ניתן לפענח את הנתונים.',
  EMPTY: 'אין עדיין נתונים בענן — העלו קודם ממכשיר אחר.',
  TOO_BIG: 'יותר מדי נתונים לסנכרון (הקטינו חתימות/חותמות).'
};
function syncMsg(e) { const k = (e && e.message) || ''; return SYNC_ERR[k] || (k.indexOf('HTTP_') === 0 ? ('שגיאת שרת (' + k.slice(5) + ') — בדקו Project ID / API Key / הרשאות Firestore.') : 'הסנכרון נכשל — בדקו חיבור ופרטים.'); }
function syncSetStatus(t, kind) { const el = $('syncStatus'); if (el) { el.textContent = t; el.style.color = kind === 'err' ? 'var(--warn)' : (kind === 'ok' ? 'var(--ok,#1a7f4b)' : 'var(--ink-3)'); } }
function syncSaveCfgFromUI() {
  return PFS.sync.setCfg({
    projectId: $('syncProject').value.trim(), apiKey: $('syncKey').value.trim(),
    code: $('syncCode').value.trim(), auto: $('syncAuto').checked
  });
}
let syncPushTimer = null;
function syncAutoPush() {
  if (!PFS.sync.getCfg().auto || !PFS.sync.configured()) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(async () => {
    try { await PFS.sync.push(); syncSetStatus('נשמר בענן ✓ ' + new Date().toLocaleTimeString('he-IL'), 'ok'); }
    catch (e) { syncSetStatus(syncMsg(e), 'err'); }
  }, 2500);
}
function wireSync() {
  const c = PFS.sync.getCfg();
  if ($('syncProject')) $('syncProject').value = c.projectId || '';
  if ($('syncKey')) $('syncKey').value = c.apiKey || '';
  if ($('syncCode')) $('syncCode').value = c.code || '';
  if ($('syncAuto')) $('syncAuto').checked = !!c.auto;
  $('syncHelp') && $('syncHelp').addEventListener('click', (e) => { e.preventDefault(); const b = $('syncHelpBox'); b.style.display = b.style.display === 'none' ? 'block' : 'none'; });
  ['syncProject', 'syncKey', 'syncCode', 'syncAuto'].forEach((id) => $(id) && $(id).addEventListener('change', syncSaveCfgFromUI));
  $('syncPush') && $('syncPush').addEventListener('click', async () => {
    syncSaveCfgFromUI();
    if (!PFS.sync.configured()) { syncSetStatus(SYNC_ERR.NOT_CONFIGURED, 'err'); return; }
    syncSetStatus('מעלה…');
    try { await PFS.sync.push(); syncSetStatus('הכול הועלה לענן ✓', 'ok'); }
    catch (e) { syncSetStatus(syncMsg(e), 'err'); }
  });
  $('syncPull') && $('syncPull').addEventListener('click', async () => {
    syncSaveCfgFromUI();
    if (!PFS.sync.configured()) { syncSetStatus(SYNC_ERR.NOT_CONFIGURED, 'err'); return; }
    if (!(await PFS.ui.confirm('משיכת נתונים', 'הנתונים מהענן יחליפו את מה שקיים במכשיר זה. להמשיך?'))) return;
    syncSetStatus('מושך…');
    try { await PFS.sync.pull(); refreshAllFromStore(); syncSetStatus('הנתונים נמשכו ופוענחו ✓', 'ok'); PFS.toast('הסנכרון הושלם', 'ok'); }
    catch (e) { syncSetStatus(syncMsg(e), 'err'); }
  });
}
async function syncAutoPullOnLoad() {
  const c = PFS.sync.getCfg();
  if (!c.auto || !PFS.sync.configured()) return;
  try { await PFS.sync.pull(); refreshAllFromStore(); syncSetStatus('סונכרן מהענן ✓', 'ok'); }
  catch (e) { if ((e && e.message) !== 'EMPTY') syncSetStatus(syncMsg(e), 'err'); }
}
wireSync();
syncAutoPullOnLoad();

// ---- accounts + automatic cloud save (js/account.js) -------------------
const ACCT = () => PFS.account;
let acctSaveTimer = null, acctBusy = false;
function acctStatus(t, kind) { const el = $('acctStatus'); if (el) { el.textContent = t || ''; el.style.color = kind === 'err' ? 'var(--warn)' : (kind === 'ok' ? 'var(--ok,#1a7f4b)' : 'var(--ink-3)'); } }
function scheduleAccountSave() {
  if (!ACCT().authed()) return;
  clearTimeout(acctSaveTimer);
  acctSaveTimer = setTimeout(async () => {
    try { await ACCT().saveVault(); acctStatus('נשמר בענן ✓ ' + new Date().toLocaleTimeString('he-IL'), 'ok'); }
    catch (e) { acctStatus('שמירה בענן נכשלה — בדקו חיבור', 'err'); }
  }, 2000);
}
function renderAccount() {
  const body = $('acctBody'); if (!body) return;
  if (!ACCT().configured()) {
    body.innerHTML = '<div class="hint muted">סנכרון חשבונות בענן עדיין לא הופעל למוצר. כשתחברו Supabase — כל משתמש יתחבר עם אימייל וסיסמה, והכול יישמר וייטען אוטומטית בכל מכשיר.</div>' +
      '<details style="margin-top:6px"><summary class="hint" style="cursor:pointer">הפעלה (למפעיל) ⓘ</summary>' +
      '<div class="field" style="margin-top:6px"><label>Supabase URL</label><input id="acctCfgUrl" dir="ltr" placeholder="https://xxxx.supabase.co" /></div>' +
      '<div class="field"><label>anon key</label><input id="acctCfgKey" dir="ltr" placeholder="eyJ…" /></div>' +
      '<button class="btn sm" id="acctCfgSave">שמור פרטי חיבור</button></details>';
    $('acctCfgSave') && $('acctCfgSave').addEventListener('click', () => {
      ACCT()._saveSessionCfg({ url: $('acctCfgUrl').value.trim(), anonKey: $('acctCfgKey').value.trim() });
      renderAccount();
    });
    return;
  }
  if (ACCT().authed()) {
    const u = ACCT().user() || {};
    body.innerHTML = '<div class="hint">מחובר/ת כ־<b dir="ltr">' + (u.email || '—') + '</b></div>' +
      '<div class="hint muted">הכול נשמר בענן אוטומטית וייטען בכל מכשיר שתתחברו בו.</div>' +
      '<div class="row" style="margin-top:6px"><button class="btn sm" id="acctSaveNow" style="flex:1">שמור עכשיו</button><button class="btn sm ghost" id="acctOut" style="flex:1">התנתק</button></div>' +
      '<div class="hint" id="acctStatus" style="margin-top:6px"></div>';
    $('acctSaveNow').addEventListener('click', async () => { acctStatus('שומר…'); try { await ACCT().saveVault(); acctStatus('נשמר בענן ✓', 'ok'); } catch (e) { acctStatus('השמירה נכשלה', 'err'); } });
    $('acctOut').addEventListener('click', () => { ACCT().signOut(); renderAccount(); PFS.toast('התנתקת', 'ok'); });
    return;
  }
  body.innerHTML = '<div class="field"><label>אימייל</label><input id="acctEmail" type="email" dir="ltr" placeholder="you@email.com" /></div>' +
    '<div class="field"><label>סיסמה</label><input id="acctPass" type="password" dir="ltr" placeholder="לפחות 6 תווים" /></div>' +
    '<div class="row"><button class="btn sm primary" id="acctIn" style="flex:1">התחבר</button><button class="btn sm" id="acctUp" style="flex:1">הרשמה</button></div>' +
    '<div class="hint" id="acctStatus" style="margin-top:6px"></div>';
  const email = () => $('acctEmail').value.trim(), pass = () => $('acctPass').value;
  async function afterAuth() {
    acctStatus('טוען את הנתונים שלך…');
    try { const had = await ACCT().loadVault(); if (had) { refreshAllFromStore(); } else { await ACCT().saveVault(); } }
    catch (e) { /* keep local data; will auto-save */ }
    renderAccount(); acctStatus('מחובר ✓', 'ok'); PFS.toast('מחובר — הנתונים שלך מסונכרנים', 'ok');
  }
  $('acctIn').addEventListener('click', async () => {
    if (acctBusy) return; acctBusy = true; acctStatus('מתחבר…');
    try { await ACCT().signIn(email(), pass()); await afterAuth(); }
    catch (e) { acctStatus((e.message === 'BAD_CREDENTIALS') ? 'אימייל או סיסמה שגויים' : 'ההתחברות נכשלה', 'err'); }
    finally { acctBusy = false; }
  });
  $('acctUp').addEventListener('click', async () => {
    if (acctBusy) return; acctBusy = true; acctStatus('יוצר חשבון…');
    try { const r = await ACCT().signUp(email(), pass()); if (r.needsConfirm) { acctStatus('נשלח אליך מייל אימות — אשרו ואז התחברו.', 'ok'); } else { await afterAuth(); } }
    catch (e) { acctStatus(/already/i.test(e.message) ? 'האימייל כבר רשום — התחברו' : ('ההרשמה נכשלה: ' + e.message), 'err'); }
    finally { acctBusy = false; }
  });
}
async function acctAutoLoadOnStart() {
  if (!ACCT().configured() || !ACCT().authed()) { renderAccount(); return; }
  try { if (await ACCT().loadVault()) refreshAllFromStore(); } catch (e) {}
  renderAccount();
}
acctAutoLoadOnStart();

// After any local data change: encrypted auto-push for the personal sync path,
// and an automatic cloud save for logged-in accounts. Excludes config/session
// keys to avoid save loops.
(function () {
  const _set = PFS.store.set.bind(PFS.store);
  PFS.store.set = function (k, v) {
    const r = _set(k, v);
    if (k !== 'sync:cfg') { try { syncAutoPush(); } catch (e) {} }
    if (k.indexOf('acct:') !== 0) { try { scheduleAccountSave(); } catch (e) {} }
    return r;
  };
})();
$('fillAllBtn').addEventListener('click', fillAll);
$('backupExportBtn').addEventListener('click', backupExport);
$('backupImportBtn').addEventListener('click', () => $('backupFile').click());
$('backupFile').addEventListener('change', (e) => { if (e.target.files[0]) backupImport(e.target.files[0]); e.target.value = ''; });

// Sandboxed host (e.g. the published artifact) blocks persistent storage —
// everything still works, but only for this window. Tell the user clearly
// and point them at backup/restore, which covers moving between sessions.
if (!PFS.store.persistent) {
  const note = document.createElement('div');
  note.className = 'hint';
  note.style.color = 'var(--warn)';
  note.textContent = '⚠️ בסביבה זו הדפדפן חוסם אחסון קבוע: חתימות, תבניות וכתב־יד נשמרים רק לחלון הנוכחי. לחצו "גבה הכל" לקובץ — ו"שחזר מקובץ" בפעם הבאה.';
  const backupCard = $('backupExportBtn') && $('backupExportBtn').closest('.body-p');
  if (backupCard) backupCard.prepend(note);
  PFS.toast('שימו לב: ההגדרות נשמרות רק לחלון הזה — גבו לקובץ דרך ⚙️ הגדרות', 'err', 6000);
}

// ---- help & shortcuts ---------------------------------------------------
$('helpBtn') && $('helpBtn').addEventListener('click', () => openModal('helpModal'));
$('helpClose') && $('helpClose').addEventListener('click', () => closeModal('helpModal'));

// ---- theme (auto / light / dark) ---------------------------------------
const THEMES = ['auto', 'light', 'dark'];
const THEME_IC = { auto: '🌗', light: '☀️', dark: '🌙' };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  const ic = $('themeIc'); if (ic) ic.textContent = THEME_IC[t] || '🌗';
  const btn = $('themeBtn'); if (btn) btn.title = 'מצב תצוגה: ' + ({ auto: 'אוטומטי', light: 'בהיר', dark: 'כהה' }[t]);
}
applyTheme(PFS.store.get('theme', 'auto'));
$('themeBtn') && $('themeBtn').addEventListener('click', () => {
  const cur = PFS.store.get('theme', 'auto');
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  PFS.store.set('theme', next); applyTheme(next);
  PFS.toast('מצב תצוגה: ' + ({ auto: 'אוטומטי 🌗', light: 'בהיר ☀️', dark: 'כהה 🌙' }[next]), 'ok', 1400);
});

// ---- first-run onboarding: two taps and the magic works forever --------
function showOnboarding() {
  if (PFS.store.get('onboarded', false)) return;
  const back = document.createElement('div');
  back.className = 'modal-back show';
  back.innerHTML = '<div class="modal" style="max-width:430px;text-align:center">' +
    '<div class="m-body" style="gap:14px;padding:26px 22px">' +
    '<div style="font-size:40px">👋</div>' +
    '<h2 style="margin:0;font-size:21px;font-weight:900">ברוכים הבאים ל-Fillo</h2>' +
    '<div class="hint" style="font-size:13px">שתי פעולות של דקה — ומעכשיו כל טופס יתמלא ויחתם כמעט לבד:</div>' +
    '<button class="btn primary block" id="obScan" style="padding:13px">📷 סרקו תעודת זהות — הפרטים יישמרו</button>' +
    '<button class="btn block" id="obSig" style="padding:13px">✍️ ציירו חתימה — תשב על כל טופס בקליק</button>' +
    '<button class="btn ghost sm" id="obSkip">דלגו — אסתדר לבד</button>' +
    '</div></div>';
  document.body.appendChild(back);
  const done = () => { PFS.store.set('onboarded', true); back.remove(); };
  back.querySelector('#obScan').addEventListener('click', () => { done(); $('vaultInput').click(); });
  back.querySelector('#obSig').addEventListener('click', () => { done(); $('drawSigBtn').click(); });
  back.querySelector('#obSkip').addEventListener('click', done);
}
showOnboarding();

// =====================================================================
//  Document library ("המאגר") — the office's permanent forms, one click away
// =====================================================================
async function renderLibrary() {
  if (!PFS.library) return;
  const docs = await PFS.library.list();
  // empty-state strip
  const wrap = $('libWrap'), strip = $('libStrip');
  if (wrap && strip) {
    wrap.style.display = docs.length ? '' : 'none';
    strip.innerHTML = '';
    docs.slice(0, 6).forEach((d) => {
      const row = document.createElement('div'); row.className = 'tmpl-item'; row.style.cursor = 'pointer';
      row.innerHTML = '<div class="nm">📚 ' + d.name + '</div><span class="pill">פתח</span>';
      row.addEventListener('click', () => openFromLibrary(d.id));
      strip.appendChild(row);
    });
  }
  // modal list
  const list = $('libList');
  if (list) {
    list.innerHTML = '';
    if (!docs.length) {
      const empty = document.createElement('div');
      empty.className = 'hint muted'; empty.style.padding = '10px 4px';
      empty.textContent = 'המאגר ריק — שמרו את הטופס הפתוח או העלו קובץ.';
      list.appendChild(empty);
    }
    docs.forEach((d) => {
      const row = document.createElement('div'); row.className = 'tmpl-item';
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = '📄 ' + d.name;
      const openB = document.createElement('button'); openB.className = 'btn sm primary'; openB.textContent = 'פתח';
      openB.addEventListener('click', () => { closeModal('libModal'); openFromLibrary(d.id); });
      const renB = document.createElement('button'); renB.className = 'btn sm'; renB.textContent = '✎'; renB.title = 'שנה שם';
      renB.addEventListener('click', async () => {
        const name = await PFS.ui.prompt('שם המסמך במאגר', { value: d.name });
        if (name && name.trim()) { await PFS.library.rename(d.id, name); renderLibrary(); }
      });
      const delB = document.createElement('button'); delB.className = 'btn sm'; delB.style.color = 'var(--danger)'; delB.textContent = '🗑'; delB.title = 'הסר מהמאגר';
      delB.addEventListener('click', async () => {
        if (await PFS.ui.confirm('הסרה מהמאגר', 'להסיר את "' + d.name + '" מהמאגר?')) { await PFS.library.remove(d.id); renderLibrary(); }
      });
      row.append(nm, openB, renB, delB);
      list.appendChild(row);
    });
  }
  if ($('libAddOpenBtn')) $('libAddOpenBtn').disabled = !pdfView.hasDoc();
}
async function openFromLibrary(id) {
  try {
    const rec = await PFS.library.get(id);
    if (!rec || !rec.bytes) { PFS.toast('המסמך לא נמצא במאגר', 'err'); return; }
    await openPdfFile(new File([rec.bytes], rec.name + '.pdf', { type: 'application/pdf' }));
  } catch (e) { PFS.toast('פתיחה מהמאגר נכשלה: ' + (e.message || e), 'err'); }
}
$('libBtn') && $('libBtn').addEventListener('click', () => { renderLibrary(); openModal('libModal'); });
$('libClose') && $('libClose').addEventListener('click', () => closeModal('libModal'));
$('libUploadBtn') && $('libUploadBtn').addEventListener('click', () => $('libInput').click());
$('libInput') && $('libInput').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.type !== 'application/pdf') { PFS.toast('בחר קובץ PDF', 'err'); return; }
  try {
    const rec = await PFS.library.add(f.name, await f.arrayBuffer());
    renderLibrary();
    PFS.toast('"' + rec.name + '" נשמר במאגר ✓', 'ok');
  } catch (err) { PFS.toast(err.message || 'השמירה נכשלה', 'err'); }
});
$('libAddOpenBtn') && $('libAddOpenBtn').addEventListener('click', async () => {
  if (!pdfView.hasDoc()) return;
  try {
    const name = await PFS.ui.prompt('שם המסמך במאגר', { value: currentFileName });
    if (!name || !name.trim()) return;
    const rec = await PFS.library.add(name, pdfView.getBytes().slice(0));
    renderLibrary();
    PFS.toast('"' + rec.name + '" נשמר במאגר ✓ — יופיע גם במסך הפתיחה', 'ok');
  } catch (err) { PFS.toast(err.message || 'השמירה נכשלה', 'err'); }
});
renderLibrary();

// ---- organization details ("פרטי המכללה") — fixed org fields that fill
// themselves on every form via the institution canons in vault.js ----
const ORG_FIELDS = [
  { id: 'orgName', key: 'שם מוסד ההכשרה' },
  { id: 'orgPhone', key: 'טלפון מוסד ההכשרה' },
  { id: 'orgContact', key: 'איש קשר' },
  { id: 'orgBizId', key: 'ח.פ' }
];
// campuses: name+address rows. The FIRST one is the primary (written to the
// profile exactly like the old single address, so profile-beats-patterns and
// the existing org auto-fill keep working); ALL of them go into the learning
// store as pinned choices under institution_address — the campus picker.
function campusRows() {
  return [...document.querySelectorAll('#orgCampuses .org-campus')].map((r) => ({
    name: r.querySelector('.cname').value.trim(),
    address: r.querySelector('.caddr').value.trim()
  })).filter((c) => c.address);
}
function addCampusRow(c) {
  const row = document.createElement('div');
  row.className = 'org-campus'; row.style.cssText = 'display:flex;gap:6px;align-items:center';
  row.innerHTML = '<input class="cname" type="text" dir="auto" placeholder="שם (קמפוס ת״א)" style="flex:1;min-width:0">' +
    '<input class="caddr" type="text" dir="auto" placeholder="כתובת מלאה" style="flex:2;min-width:0">' +
    '<button type="button" class="btn sm" style="color:var(--danger)">✕</button>';
  if (c) { row.querySelector('.cname').value = c.name || ''; row.querySelector('.caddr').value = c.address || ''; }
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('orgCampuses').appendChild(row);
}
$('orgAddCampus') && $('orgAddCampus').addEventListener('click', () => addCampusRow());
$('orgSetupBtn') && $('orgSetupBtn').addEventListener('click', () => {
  const ap = profiles.active();
  const vals = (ap && ap.values) || {};
  ORG_FIELDS.forEach((f) => { $(f.id).value = vals[f.key] || ''; });
  $('orgCampuses').innerHTML = '';
  const saved = PFS.store.get('org_campuses', []) || [];
  if (saved.length) saved.forEach(addCampusRow);
  else addCampusRow(vals['כתובת מוסד ההכשרה'] ? { name: 'ראשי', address: vals['כתובת מוסד ההכשרה'] } : undefined);
  openModal('orgModal');
});
$('orgCancel') && $('orgCancel').addEventListener('click', () => closeModal('orgModal'));
$('orgSave') && $('orgSave').addEventListener('click', () => {
  const ap = profiles.active();
  const merged = Object.assign({}, ap && ap.values);
  ORG_FIELDS.forEach((f) => { const v = ($(f.id).value || '').trim(); if (v) merged[f.key] = v; else delete merged[f.key]; });
  const campuses = campusRows();
  if (campuses.length) merged['כתובת מוסד ההכשרה'] = campuses[0].address;
  else delete merged['כתובת מוסד ההכשרה'];
  if (PFS.patterns) {
    // forget campuses that were removed in this edit, pin the current set
    const prev = PFS.store.get('org_campuses', []) || [];
    prev.forEach((c) => { if (!campuses.some((n) => n.address === c.address)) PFS.patterns.removeValue('כתובת מוסד ההכשרה', c.address); });
    campuses.forEach((c) => { PFS.patterns.touch('כתובת מוסד ההכשרה', c.address); PFS.patterns.pin('כתובת מוסד ההכשרה', c.address, true); });
  }
  PFS.store.set('org_campuses', campuses);
  profiles.saveProfile(ap ? ap.name : 'אני', merged);
  closeModal('orgModal');
  let n = 0;
  if (pdfView.hasDoc()) {
    n += smartFill(merged);
    if (lastDet && lastDet.fields && lastDet.fields.length) n += fieldsPanel.show(lastDet, vaultPrefill(lastDet));
  }
  PFS.toast(n ? `פרטי הארגון נשמרו ✓ — ${n} שדות מולאו בטופס` : 'פרטי הארגון נשמרו ✓', 'ok');
});

// recent-documents strip on the empty state: one click reopens (auto-memory
// then restores everything that was filled)
async function renderRecent() {
  if (!PFS.recent) return;
  const wrap = $('recentWrap'), list = $('recentList');
  if (!wrap || !list) return;
  const docs = await PFS.recent.list();
  if (!docs.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  list.innerHTML = '';
  docs.slice(0, 5).forEach((d) => {
    const row = document.createElement('div'); row.className = 'tmpl-item'; row.style.cursor = 'pointer';
    row.innerHTML = '<div class="nm">📄 ' + d.name + '</div><span class="pill">' + new Date(d.ts).toLocaleDateString('he-IL') + '</span>';
    row.addEventListener('click', async () => {
      const doc = await PFS.recent.get(d.id);
      if (doc && doc.bytes) openPdfFile(new File([doc.bytes], doc.name, { type: 'application/pdf' }));
    });
    list.appendChild(row);
  });
}
renderRecent();

// A PDF shared into the app (WhatsApp → share → Fillo): sw.js stashed it,
// pick it up and open like a normal file — the whole smart pipeline
// (detection, vault fill, per-form memory) runs on it.
(async () => {
  try {
    const shared = PFS.pwa && await PFS.pwa.takeSharedPdf();
    if (shared) {
      PFS.toast('📥 התקבל טופס משיתוף — פותח…', 'ok');
      await openPdfFile(new File([shared.bytes], shared.name, { type: 'application/pdf' }));
    }
  } catch (e) { console.warn('shared pdf pickup failed', e); }
})();

// sanity log
console.log('[Fillo] ready. pdf.js', pdfjsLib.version, '· pdf-lib', !!window.PDFLib, '· fflate', !!window.fflate);
})();
