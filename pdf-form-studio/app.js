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
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 250); }, 2200);
};

// ---------- state ----------
let dirty = false;
const markDirty = () => { dirty = true; };

// ---------- overlay manager ----------
const overlay = PFS.createOverlayManager({
  onChange: markDirty,
  onSelect: (ctrl) => renderProps(ctrl),
  onPlacingChange: (on) => {
    // clear tool highlight when placement ends
    if (!on) document.querySelectorAll('.btn.tool.active').forEach((b) => b.classList.remove('active'));
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
const fieldsPanel = PFS.createFieldsPanel({ overlay });

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
async function openPdfFile(file) {
  if (!file || file.type !== 'application/pdf') { PFS.toast('בחר קובץ PDF', 'err'); return; }
  const buf = await file.arrayBuffer();
  try {
    // start fresh: drop any elements/fields/merge state from a previous document
    loadGen++;
    overlay.clearElements();
    fieldsPanel.clear();
    mergeParsed = null;
    $('dropzone').style.display = 'none';
    await pdfView.load(buf);
    dirty = false;
    $('exportBtn').disabled = false;
    $('tmplBtn').disabled = false;
    $('mergeBtn').disabled = false;
    $('detectBtn').disabled = false;
    currentFileName = file.name.replace(/\.pdf$/i, '');
    PFS.toast('הטופס נטען — ' + pdfView.numPages() + ' עמודים', 'ok');
    runDetection();
  } catch (e) {
    console.error(e);
    PFS.toast('טעינת ה-PDF נכשלה', 'err');
    if (!pdfView.hasDoc()) $('dropzone').style.display = '';
  }
}
let currentFileName = 'filled';

// =====================================================================
//  Tools
// =====================================================================
const TEXT_TOOLS = { text: 'text', check: 'check', cross: 'cross', date: 'date' };

function activateTool(btn, tool) {
  document.querySelectorAll('.btn.tool').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
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
$('pdfInput').addEventListener('change', (e) => { if (e.target.files[0]) openPdfFile(e.target.files[0]); e.target.value = ''; });

// toolbar tools
document.querySelectorAll('.btn.tool').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!pdfView.hasDoc()) { PFS.toast('פתח קודם קובץ PDF', 'err'); return; }
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
$('tmplSave').addEventListener('click', () => { templates.save($('tmplName').value.trim()); $('tmplName').value = ''; });
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
$('profileNew').addEventListener('click', () => {
  const name = prompt('שם הפרופיל (למשל: אישי / העסק):', 'פרופיל חדש'); if (name == null) return;
  profiles.saveProfile(name, {}); renderProfileSelect();
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
$('profileGrab').addEventListener('click', () => {
  const vals = overlay.currentValues();
  if (!Object.keys(vals).length) { PFS.toast('אין שדות מתויגים בטופס', 'err'); return; }
  let p = profiles.all().find((x) => x.id === $('profileSel').value);
  const name = p ? p.name : (prompt('שם הפרופיל:', 'פרופיל חדש') || 'פרופיל חדש');
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

// sanity log
console.log('[PDF Form Studio] ready. pdf.js', pdfjsLib.version, '· pdf-lib', !!window.PDFLib, '· fflate', !!window.fflate);
})();
