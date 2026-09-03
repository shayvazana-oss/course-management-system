/* merge.js — mail-merge: fill one form from many records at once.
 * Parse a CSV/table (header row = field keys), then for each row substitute
 * values into the form's tagged fields, export a PDF, and bundle all PDFs into
 * a single ZIP (fflate). Signatures/stamps stay identical across records.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  // Which delimiter does this table use? Excel paste is TAB-separated, exports
  // are comma or semicolon — pick whichever splits the first line the most.
  function detectDelim(text) {
    const line = String(text || '').replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
    const counts = [['\t', (line.match(/\t/g) || []).length],
                    [',', (line.match(/,/g) || []).length],
                    [';', (line.match(/;/g) || []).length]];
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ',';
  }

  // Minimal RFC-4180-ish parser (quotes, CRLF, escaped "") with auto delimiter
  // so a straight Excel copy-paste just works.
  function parseCSV(text) {
    const delim = detectDelim(text);
    const rows = [];
    let row = [], field = '', i = 0, inQ = false;
    text = text.replace(/^﻿/, ''); // strip BOM
    while (i < text.length) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQ = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQ = true; i++; continue; }
      if (c === delim) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    // drop trailing empty rows
    const clean = rows.filter((r) => r.some((x) => String(x).trim() !== ''));
    if (!clean.length) return { headers: [], records: [] };
    const headers = clean[0].map((h) => h.trim());
    const records = clean.slice(1).map((r) => {
      const o = {}; headers.forEach((h, j) => { o[h] = (r[j] ?? '').trim(); }); return o;
    });
    return { headers, records };
  }

  /* parseXlsx(bytes) → { headers, records } — read a real Excel file locally.
   * An .xlsx is a ZIP of XML parts; fflate (already loaded for the batch ZIP)
   * unzips it and DOMParser reads the parts: no library, no upload, the
   * student list never leaves the browser. Strings resolve via sharedStrings;
   * a serial number in a date-formatted cell becomes dd.mm.yyyy. */
  function parseXlsx(bytes) {
    if (!root.fflate) throw new Error('fflate not loaded');
    const parts = root.fflate.unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const dec = new TextDecoder('utf-8');
    const xml = (p) => { const b = parts[p]; return b ? new DOMParser().parseFromString(dec.decode(b), 'application/xml') : null; };
    // FIRST sheet: workbook.xml orders them, the rels map its rId to a path
    let sheetPath = 'xl/worksheets/sheet1.xml';
    try {
      const wb = xml('xl/workbook.xml'), rels = xml('xl/_rels/workbook.xml.rels');
      const sh = wb && wb.querySelector('sheet');
      const rid = sh && (sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
      const rel = rid && rels && [...rels.querySelectorAll('Relationship')].find((r) => r.getAttribute('Id') === rid);
      if (rel) sheetPath = 'xl/' + rel.getAttribute('Target').replace(/^\//, '').replace(/^xl\//, '');
    } catch (e) {}
    const shared = [];
    const ss = xml('xl/sharedStrings.xml');
    if (ss) ss.querySelectorAll('si').forEach((si) => {
      shared.push([...si.querySelectorAll('t')].map((t) => t.textContent).join(''));
    });
    // which cell-style indices mean DATE? (builtin date formats + custom
    // codes that spell day/month/year and are not plain number masks)
    const dateStyle = [];
    try {
      const st = xml('xl/styles.xml');
      const custom = {};
      st && st.querySelectorAll('numFmts > numFmt').forEach((n) => { custom[n.getAttribute('numFmtId')] = n.getAttribute('formatCode') || ''; });
      const builtin = new Set(['14', '15', '16', '17', '22']);
      st && st.querySelectorAll('cellXfs > xf').forEach((xf, i) => {
        const id = xf.getAttribute('numFmtId') || '0';
        const code = custom[id];
        dateStyle[i] = builtin.has(id) || !!(code && /[dy]/i.test(code) && /m/i.test(code) && !/[#0]/.test(code));
      });
    } catch (e) {}
    const serialDate = (n) => {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);   // Excel epoch
      return String(d.getUTCDate()).padStart(2, '0') + '.' + String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + d.getUTCFullYear();
    };
    const sheet = xml(sheetPath);
    if (!sheet) return { headers: [], records: [] };
    const colIdx = (ref) => { let n = 0; for (const ch of ref) { if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64); else break; } return n - 1; };
    const rows = [];
    sheet.querySelectorAll('sheetData > row').forEach((rowEl) => {
      const row = [];
      rowEl.querySelectorAll('c').forEach((c) => {
        const ref = c.getAttribute('r') || '', t = c.getAttribute('t') || 'n';
        const sI = parseInt(c.getAttribute('s') || '-1', 10);
        let v = '';
        if (t === 'inlineStr') v = [...c.querySelectorAll('t')].map((x) => x.textContent).join('');
        else {
          const vEl = c.querySelector('v'), raw = vEl ? vEl.textContent : '';
          if (t === 's') v = shared[parseInt(raw, 10)] ?? '';
          else if (t === 'b') v = raw === '1' ? 'כן' : 'לא';
          else if (raw !== '' && dateStyle[sI] && isFinite(+raw) && +raw > 20000 && +raw < 80000) v = serialDate(+raw);
          else v = raw;
        }
        const ci = ref ? colIdx(ref) : row.length;
        row[ci] = String(v).trim();
      });
      rows.push(row);
    });
    const clean = rows.filter((r) => r && r.some((x) => x != null && String(x).trim() !== ''));
    if (!clean.length) return { headers: [], records: [] };
    const headers = clean[0].map((h) => String(h ?? '').trim());
    const records = clean.slice(1).map((r) => {
      const o = {}; headers.forEach((h, j) => { if (h) o[h] = String(r[j] ?? '').trim(); }); return o;
    });
    return { headers, records };
  }

  function cloneModels(models) { return models.map((m) => Object.assign({}, m)); }

  /* mapHeaders(headers, fieldKeys) → { header: fieldKey|null }
   * Spreadsheet headers rarely match field names letter-for-letter; map them
   * the way the vault maps labels: exact normalized equality first, then
   * shared canonical meaning ('שם התלמיד' ↔ 'שם מלא' both → full_name).
   * A field key is used at most once; ambiguity leaves the header unmapped. */
  function mapHeaders(headers, fieldKeys) {
    const V = PFS.vault;
    const map = {};
    const taken = new Set();
    // pass 1: exact normalized equality
    headers.forEach((h) => {
      const hit = fieldKeys.find((k) => !taken.has(k) && V.norm(k) === V.norm(h));
      if (hit) { map[h] = hit; taken.add(hit); }
    });
    // pass 2: same canonical meaning. Several fields can share a canon
    // ('שם מלא' and 'שם מנהל מוסד ההכשרה' are both person-names) — prefer the
    // SHORTEST normalized key: the purest expression of the meaning.
    headers.forEach((h) => {
      if (map[h]) return;
      const canon = V.matchKey(h);
      if (!canon) { map[h] = null; return; }
      const hits = fieldKeys.filter((k) => !taken.has(k) && V.matchKey(k) === canon)
        .sort((a, b) => V.norm(a).length - V.norm(b).length);
      if (hits.length) { map[h] = hits[0]; taken.add(hits[0]); }
      else map[h] = null;
    });
    return map;
  }

  /* remapRecords(records, mapping) → records keyed by fieldKey */
  function remapRecords(records, mapping) {
    return records.map((r) => {
      const o = {};
      Object.keys(r).forEach((h) => { const k = mapping[h]; if (k) o[k] = r[h]; });
      return o;
    });
  }

  // Enrich a CSV record with meaning-matched + derived values for the tagged
  // fields, so batch fill is as smart as interactive fill: an "address" column
  // fills separate city/house/zip fields, "full_name" fills first/last, and a
  // "סכום" column fills a "סכום במילים" field. Falls back to the raw record.
  function enrichRecord(models, record) {
    if (!(PFS.vault && PFS.vault.matchValues)) return record;
    const keys = [...new Set(models.filter((m) => m.type === 'text' && m.fieldKey).map((m) => m.fieldKey))];
    const fields = keys.map((k) => ({ fieldKey: k, label: k, type: 'text' }));
    const out = Object.assign({}, record, PFS.vault.matchValues(fields, record, []));
    if (PFS.numwords) {
      keys.forEach((k) => {
        if (PFS.vault.matchKey(k) === 'amount_words' && out[k] === undefined) {
          const amtKey = keys.find((x) => PFS.vault.matchKey(x) === 'amount');
          const num = parseFloat(String((amtKey && out[amtKey]) || '').replace(/[^\d.]/g, ''));
          if (isFinite(num)) out[k] = PFS.numwords.shekels(num);
        }
      });
    }
    return out;
  }
  function applyRecord(models, record) {
    const rec = enrichRecord(models, record);
    const out = cloneModels(models).map((m) => {
      if (m.type === 'text' && m.fieldKey && Object.prototype.hasOwnProperty.call(rec, m.fieldKey)) {
        m = Object.assign({}, m, { text: String(rec[m.fieldKey] ?? '') });
      }
      return m;
    });
    // recompute calculated fields per record with the SAME resolver the
    // interactive path uses (chained subtotal → total, fixed-point iteration).
    if (PFS.formula && PFS.formula.resolve) PFS.formula.resolve(out);
    return out;
  }

  const safe = (s) => String(s || '').replace(/[^\w֐-׿ .\-]+/g, '_').slice(0, 60) || 'record';

  /* runBatch({ originalBytes, baseModels, records, nameField, onProgress })
   * → returns { zip: Uint8Array, count }  (caller downloads it) */
  async function runBatch({ originalBytes, baseModels, records, nameField, onProgress }) {
    if (!root.fflate) throw new Error('fflate (zip) not loaded');
    const files = {};
    const used = {};
    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      const models = applyRecord(baseModels, rec);
      const bytes = await PFS.exporter.exportPdf(originalBytes, models, {});
      let base = safe(nameField && rec[nameField] ? rec[nameField] : 'record-' + (idx + 1));
      used[base] = (used[base] || 0) + 1;
      const fname = (used[base] > 1 ? `${base}-${used[base]}` : base) + '.pdf';
      files[fname] = new Uint8Array(bytes);
      onProgress && onProgress(idx + 1, records.length);
    }
    const zip = root.fflate.zipSync(files, { level: 6 });
    return { zip, count: records.length };
  }

  function downloadZip(zipBytes, filename) {
    PFS.deliver.file(zipBytes, filename || 'filled-forms.zip', 'application/zip');
  }

  PFS.merge = { parseCSV, parseXlsx, detectDelim, mapHeaders, remapRecords, applyRecord, enrichRecord, runBatch, downloadZip };
})(window);
