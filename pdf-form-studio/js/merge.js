/* merge.js — mail-merge: fill one form from many records at once.
 * Parse a CSV/table (header row = field keys), then for each row substitute
 * values into the form's tagged fields, export a PDF, and bundle all PDFs into
 * a single ZIP (fflate). Signatures/stamps stay identical across records.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  // Minimal RFC-4180-ish CSV parser (quotes, commas, CRLF, escaped "").
  function parseCSV(text) {
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
      if (c === ',') { row.push(field); field = ''; i++; continue; }
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

  function cloneModels(models) { return models.map((m) => Object.assign({}, m)); }

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

  PFS.merge = { parseCSV, applyRecord, enrichRecord, runBatch, downloadZip };
})(window);
