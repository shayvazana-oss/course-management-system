/* acroform.js — fillable PDFs ("AcroForm") opened as ordinary paper.
 *
 * Many appendices (נספח ה3, נספח ו…) are fillable PDFs. Once someone filled
 * one and saved it, its field VALUES live inside the file: the page drew
 * them, grey field backgrounds and all, Fillo's own values landed beside
 * them, and nothing could change or remove them; the export then baked the
 * old values in under the new ones ("נפתח עם נתונים קיימים ולא מאפשר לשנות").
 *
 * prepare(bytes) turns such a file into plain paper Fillo can fill:
 *   - fields a person fills (text, choice, tick boxes, radios) are emptied:
 *     text/choice → an empty appearance (their border kept, the grey
 *     background dropped); tick boxes / radios → their own "Off" picture;
 *   - read-only fields are KEPT exactly as drawn — Israeli government forms
 *     print their LABELS as read-only fields;
 *   - the form is then flattened WITHOUT regenerating any appearance (pdf-lib
 *     would redraw Hebrew with a Latin font — scrambled).
 * The old values are returned, so the app can offer them back as ordinary,
 * editable values. Encrypted or unreadable files are left alone (null).
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  function emptyAppearance(doc, widget) {
    const L = root.PDFLib;
    const r = widget.getRectangle();
    const W = Math.max(1, r.width), H = Math.max(1, r.height);
    let ops = '';
    try {
      const mk = widget.getAppearanceCharacteristics && widget.getAppearanceCharacteristics();
      const bc = mk && mk.getBorderColor && mk.getBorderColor();
      const bs = widget.getBorderStyle && widget.getBorderStyle();
      const bw = bs && bs.getWidth ? bs.getWidth() : (bc ? 1 : 0);
      if (bc && bc.length && bw > 0) {
        const op = bc.length === 1 ? 'G' : (bc.length === 4 ? 'K' : 'RG');
        ops = 'q ' + bc.join(' ') + ' ' + op + ' ' + bw + ' w ' + (bw / 2) + ' ' + (bw / 2) + ' ' + (W - bw) + ' ' + (H - bw) + ' re S Q';
      }
    } catch (e) {}
    const dict = doc.context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, W, H] });
    const stream = doc.context.stream(ops, dict);
    return doc.context.register(stream);
  }

  // → null (not a fillable form, or not safely editable) |
  //   { bytes, values: {name: text}, checked: {name: true|exportValue} }
  async function prepare(bytes) {
    const L = root.PDFLib;
    if (!L || !L.PDFDocument) return null;
    let doc;
    try { doc = await L.PDFDocument.load(bytes, { updateMetadata: false }); } catch (e) { return null; }
    if (doc.isEncrypted) return null;
    let form, fields;
    try { form = doc.getForm(); fields = form.getFields(); } catch (e) { return null; }
    if (!fields || !fields.length) return null;
    const values = {}, checked = {};
    let emptied = 0;
    fields.forEach((f) => {
      try {
        if (f.isReadOnly && f.isReadOnly()) return;          // a printed label, as authored
        const name = f.getName();
        const widgets = f.acroField.getWidgets();
        if (f instanceof L.PDFTextField) {
          const v = f.getText(); if (v && String(v).trim()) values[name] = String(v);
          widgets.forEach((w) => w.setNormalAppearance(emptyAppearance(doc, w)));
          emptied++;
        } else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) {
          const sel = f.getSelected(); if (sel && sel.length && String(sel[0]).trim()) values[name] = sel.join(', ');
          widgets.forEach((w) => w.setNormalAppearance(emptyAppearance(doc, w)));
          emptied++;
        } else if (f instanceof L.PDFCheckBox) {
          if (f.isChecked()) checked[name] = true;
          f.uncheck();
          emptied++;
        } else if (f instanceof L.PDFRadioGroup) {
          const sel = f.getSelected(); if (sel) checked[name] = sel;
          f.clear();
          emptied++;
        }
      } catch (e) { /* one odd field never stops the rest */ }
    });
    if (!emptied) return null;
    try { form.deleteXFA && form.deleteXFA(); } catch (e) {}
    try { form.flatten({ updateFieldAppearances: false }); } catch (e) { return null; }
    let out;
    try { out = await doc.save({ updateFieldAppearances: false }); } catch (e) { return null; }
    return { bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), values, checked };
  }

  PFS.acro = { prepare };
})(window);
