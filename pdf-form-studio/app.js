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

// Automatic per-form memory: a short while after any edit, silently remember
// the current layout linked to this form's fingerprint. Next time the same
// form is opened it auto-applies (see openPdfFile) — no manual "save template".
let autoMemTimer = null;
function scheduleAutoMemory() {
  if (!currentFp || !templates) return;
  clearTimeout(autoMemTimer);
  autoMemTimer = setTimeout(() => { try { templates.autoSave(currentFp, currentFileName); } catch (e) {} }, 1500);
}

// ---------- undo / redo (snapshots of the overlay) ----------
let history = [], redo = [], restoring = false, snapT = null;
function resetHistory() { history = [JSON.stringify([])]; redo = []; }
function scheduleSnap() { if (restoring) return; clearTimeout(snapT); snapT = setTimeout(snapshot, 300); }
function snapshot() {
  if (restoring) return;
  const s = JSON.stringify(overlay.serialize());
  if (history.length && history[history.length - 1] === s) return;
  history.push(s); if (history.length > 40) history.shift(); redo = [];
}
function restoreState(json) {
  restoring = true; clearTimeout(snapT);
  overlay.clearElements(); fieldsPanel.clear(); overlay.applyModels(JSON.parse(json));
  restoring = false; markDirty();
}
function undo() { if (history.length < 2) return; redo.push(history.pop()); restoreState(history[history.length - 1]); }
function redoAction() { if (!redo.length) return; const s = redo.pop(); history.push(s); restoreState(s); }

// ---------- overlay manager ----------
const overlay = PFS.createOverlayManager({
  onChange: () => { markDirty(); scheduleSnap(); },
  onSelect: (ctrl) => renderProps(ctrl),
  onPlacingChange: (on) => {
    // clear tool highlight when placement ends
    if (!on) document.querySelectorAll('.rail-btn.tool.active').forEach((b) => b.classList.remove('active'));
  }
});

// ---------- pdf view ----------
const pdfView = PFS.createPdfView({
  pdfjsLib,
  pagesEl: $('pages'),
  viewportEl: $('viewport'),
  overlay,
  standardFontDataUrl: window.PFS_STDFONTS || undefined,
  onZoom: (s) => { $('zoomLvl').textContent = Math.round(s * 100) + '%'; }
});

// ---------- assets & templates ----------
const assets = PFS.createAssetsLibrary({
  onPick: (kind, item) => armImagePlacement(kind, item)
});
const templates = PFS.createTemplates({
  getElements: () => overlay.serialize(),
  // applying a template replaces the current layout (avoids stacking duplicates)
  applyModels: (models) => { overlay.clearElements(); fieldsPanel.clear(); overlay.applyModels(models); },
  afterApply: () => { markDirty(); closeModal('tmplModal'); }
});
const profiles = PFS.createDataProfiles();
const fieldsPanel = PFS.createFieldsPanel({
  overlay,
  ocrAvailable: () => !!(PFS.ocr && PFS.ocr.available()),
  onOcr: () => runOcr()
});

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
    fieldsPanel.show(det);
    PFS.toast(`OCR זיהה ${det.fields.length} שדות`, 'ok');
  } catch (e) {
    console.error('OCR failed', e);
    fieldsPanel.show({ tier: 'scanned', fields: [] });
    PFS.toast('OCR נכשל: ' + (e.message || e), 'err');
  }
}

async function runDetection() {
  if (!pdfView.hasDoc()) return;
  const gen = loadGen;
  const btn = $('detectBtn'); const prev = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="ic">⏳</span> מזהה…';
  try {
    const det = await PFS.detect.detectFields(pdfView.getDoc());
    if (gen !== loadGen) return; // another PDF loaded meanwhile — drop stale result
    fieldsPanel.show(det);
    if (det.tier === 'scanned') PFS.toast('טופס סרוק — זיהוי אוטומטי לא זמין', 'err');
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
let currentFp = null; // fingerprint of the currently-loaded form
async function openPdfFile(file) {
  if (!file || file.type !== 'application/pdf') { PFS.toast('בחר קובץ PDF', 'err'); return; }
  const buf = await file.arrayBuffer();
  try {
    // start fresh: drop any elements/fields/merge state from a previous document
    loadGen++;
    const myGen = loadGen;
    overlay.clearElements();
    fieldsPanel.clear();
    resetHistory();
    mergeParsed = null;
    $('dropzone').style.display = 'none';
    await pdfView.load(buf);
    dirty = false;
    $('docbar').classList.remove('hidden');
    $('fname').textContent = file.name;
    $('exportBtn').disabled = false;
    $('tmplBtn').disabled = false;
    $('mergeBtn').disabled = false;
    $('detectBtn').disabled = false;
    $('fillAllBtn').disabled = false;
    currentFileName = file.name.replace(/\.pdf$/i, '');
    PFS.toast('הטופס נטען — ' + pdfView.numPages() + ' עמודים', 'ok');
    updateHwStatus();
    currentFp = null;
    try { currentFp = await PFS.fingerprint.compute(pdfView.getDoc()); } catch (e) {}
    const match = (loadGen === myGen) && currentFp && templates.findMatch(currentFp);
    if (match) {
      templates.apply(match.tpl.id);
      PFS.toast('כבר מילאת את הטופס הזה — שחזרתי את מה שמילאת ✓', 'ok');
      // one-click: also fill the active profile into the (now tagged) fields
      const ap = profiles.active();
      if (ap && ap.values && Object.keys(ap.values).length) {
        const n = overlay.fillByKeys(ap.values);
        if (n) PFS.toast(`מולאו אוטומטית ${n} שדות מהפרופיל`, 'ok');
      }
    }
    runDetection();
  } catch (e) {
    console.error(e);
    PFS.toast('טעינת ה-PDF נכשלה', 'err');
    if (!pdfView.hasDoc()) { $('dropzone').style.display = ''; $('docbar').classList.add('hidden'); }
  }
}
let currentFileName = 'filled';

// =====================================================================
//  Tools
// =====================================================================
const TEXT_TOOLS = { text: 'text', check: 'check', cross: 'cross', date: 'date' };

function activateTool(btn, tool) {
  document.querySelectorAll('.rail-btn.tool').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  if (tool === 'handwriting') { btn.classList.remove('active'); startHandwritingFlow(); return; }
  if (tool === 'signature' || tool === 'stamp') {
    // handled by their own flows below
    btn.classList.remove('active');
    tool === 'signature' ? startSignatureFlow() : startStampFlow();
    return;
  }
  // text-like: arm placement — click on a page to drop it
  overlay.setPlacing({
    sticky: false,
    create: (pageIndex, fx, fy) => {
      const extra = {};
      if (tool === 'date') extra.text = new Date().toLocaleDateString('he-IL');
      const ctrl = overlay.addElementAt(TEXT_TOOLS[tool], pageIndex, fx, fy, extra);
      return null; // addElementAt already instantiated
    }
  });
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
let sigPad = null;
function openSignaturePad() {
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
  const item = assets.add('signature', { url, w, h });
  closeModal('sigModal');
  armImagePlacement('signature', item);
  PFS.toast('החתימה נשמרה', 'ok');
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
    size.addEventListener('input', () => { m.fontFrac = parseInt(size.value, 10) / 1000; ctrl.layout(); markDirty(); });
    fSize.appendChild(size); fSize.style.flex = '1';
    const fCol = field('צבע'); const col = document.createElement('input');
    col.type = 'color'; col.value = toHex(m.color);
    col.addEventListener('input', () => { m.color = col.value; ctrl.layout(); markDirty(); });
    fCol.appendChild(col);
    rowSC.append(fSize, fCol); body.appendChild(rowSC);

    // bold + align
    const rowBA = document.createElement('div'); rowBA.className = 'row';
    const bold = document.createElement('button'); bold.className = 'btn sm' + (m.bold ? ' active tool' : '');
    bold.textContent = 'מודגש'; bold.style.fontWeight = '700';
    bold.addEventListener('click', () => { m.bold = !m.bold; ctrl.layout(); markDirty(); renderProps(ctrl); });
    const seg = document.createElement('div'); seg.className = 'seg';
    [['right', '⇥'], ['center', '≡'], ['left', '⇤']].forEach(([a, label]) => {
      const b = document.createElement('button'); b.textContent = label; b.title = a;
      if (m.align === a) b.classList.add('on');
      b.addEventListener('click', () => { m.align = a; ctrl.layout(); markDirty(); renderProps(ctrl); });
      seg.appendChild(b);
    });
    rowBA.append(bold, seg); body.appendChild(rowBA);
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
async function doExport() {
  if (!pdfView.hasDoc()) return;
  const models = overlay.getElements().map((c) => c.model);
  if (!models.length) { PFS.toast('לא נוספו שדות לטופס', 'err'); return; }
  const btn = $('exportBtn'); const prev = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = '<span class="ic">⏳</span> מייצא…';
  try {
    const bytes = await PFS.exporter.exportPdf(pdfView.getBytes(), models, {
      onProgress: (d, t) => { btn.innerHTML = `<span class="ic">⏳</span> ${d}/${t}`; }
    });
    PFS.exporter.downloadBytes(bytes, currentFileName + '-filled.pdf');
    PFS.toast('ה-PDF יוצא בהצלחה', 'ok');
    dirty = false;
    // Commit this layout to memory now, so re-opening the same form restores it.
    try { templates.autoSave(currentFp, currentFileName); } catch (e) {}
  } catch (e) {
    console.error(e);
    PFS.toast('הייצוא נכשל: ' + (e.message || e), 'err');
  } finally {
    btn.disabled = false; btn.innerHTML = prev;
  }
}

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
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => activateTab(t.dataset.tab)));

// mobile: right panel is a slide-in drawer
const isNarrow = () => window.matchMedia('(max-width: 900px)').matches;
function openPanel() { $('rightpanel').classList.add('open'); }
function closePanel() { $('rightpanel').classList.remove('open'); }
$('panelToggle').addEventListener('click', () => $('rightpanel').classList.toggle('open'));

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

// keyboard: delete selected, escape cancels placement
document.addEventListener('keydown', (e) => {
  const sel = overlay.getSelected();
  const editing = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('contenteditable') === 'true';
  const inField = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if (e.key === 'Escape') { overlay.setPlacing(null); overlay.deselectAll(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !editing && !inField) {
    e.preventDefault(); overlay.deleteCtrl(sel);
  }
  if ((e.ctrlKey || e.metaKey) && !editing && !inField) {
    const k = (e.key || '').toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redoAction(); }
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
$('profileFill').addEventListener('click', () => {
  const p = profiles.all().find((x) => x.id === $('profileSel').value);
  if (!p || !p.values) { PFS.toast('אין נתונים בפרופיל', 'err'); return; }
  const n = overlay.fillByKeys(p.values);
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
  mergeParsed = null; $('mergeRun').disabled = true; $('mergeStatus').textContent = ''; $('mergeProg').textContent = '';
  openModal('mergeModal');
}
function doParseMerge() {
  const txt = $('mergeCsv').value;
  const parsed = PFS.merge.parseCSV(txt);
  if (!parsed.records.length) { $('mergeStatus').textContent = 'לא נמצאו רשומות'; $('mergeRun').disabled = true; mergeParsed = null; return; }
  mergeParsed = parsed;
  const keys = overlay.fieldKeys();
  const matched = parsed.headers.filter((h) => keys.includes(h));
  $('mergeStatus').textContent = `${parsed.records.length} רשומות · ${matched.length}/${keys.length} שדות תואמים`;
  const nf = $('mergeNameField'); nf.innerHTML = '<option value="">(מספר רץ)</option>';
  parsed.headers.forEach((h) => { const o = document.createElement('option'); o.value=h; o.textContent=h; nf.appendChild(o); });
  $('mergeRun').disabled = false;
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
    const { zip, count } = await PFS.merge.runBatch({
      originalBytes: pdfView.getBytes(),
      baseModels,
      records: mergeParsed.records,
      nameField: $('mergeNameField').value,
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
      const r = HW().renderText(t, { fontPx: 56, color: $('hwWriteInk').value });
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
  const inp = $('hwWriteText');
  requestAnimationFrame(() => { inp.focus(); inp.select(); inp.dispatchEvent(new Event('input')); });
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
  if (ap && ap.values && Object.keys(ap.values).length) { const n = overlay.fillByKeys(ap.values); if (n) did.push(n + ' שדות'); }
  const kinds = overlay.getElements().map((c) => c.model.kind);
  if (!kinds.includes('signature') && placeDefaultAsset('signature')) did.push('חתימה');
  if (!kinds.includes('stamp') && placeDefaultAsset('stamp')) did.push('חותמת');
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

// sanity log
console.log('[Fillo] ready. pdf.js', pdfjsLib.version, '· pdf-lib', !!window.PDFLib, '· fflate', !!window.fflate);
})();
