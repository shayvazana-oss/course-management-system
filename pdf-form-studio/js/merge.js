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

  PFS.merge = { parseCSV, detectDelim, mapHeaders, remapRecords, applyRecord, enrichRecord, runBatch, downloadZip };
})(window);
