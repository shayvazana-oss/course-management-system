/* fields-panel.js — the "detected fields" input rows.
 * Shows one labeled input per detected field; typing creates/updates a tagged
 * text element at the detected spot on the form (and clearing removes it).
 * Because fields carry a fieldKey, profiles and mail-merge work through them.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  function createFieldsPanel(opts = {}) {
    const overlay = opts.overlay;
    const panel = document.getElementById('fieldsPanel');
    const body = document.getElementById('fieldsBody');
    const ctrlByKey = {};

    function clear() {
      Object.keys(ctrlByKey).forEach((k) => delete ctrlByKey[k]);
      if (body) body.innerHTML = '';
      if (panel) panel.style.display = 'none';
    }

    function ensureCtrl(field, value) {
      let ctrl = ctrlByKey[field.fieldKey];
      value = value || '';
      if (!value.trim()) {
        if (ctrl) { overlay.deleteCtrl(ctrl); delete ctrlByKey[field.fieldKey]; }
        return null;
      }
      if (!ctrl) {
        const align = /[֐-׿]/.test(field.label) ? 'right' : 'left';
        const model = PFS.element.makeModel('text', field.page, {
          fx: field.fx, fy: field.fy, fw: field.fw || 0.2,
          fontFrac: field.fontFrac || 0.016, align,
          fieldKey: field.fieldKey, text: value
        });
        ctrl = overlay.instantiate(model);
        overlay.deselectAll();
        ctrlByKey[field.fieldKey] = ctrl;
      } else {
        ctrl.model.text = value;
        const inner = ctrl.node.querySelector('.txt');
        if (inner) inner.textContent = value;
        ctrl.layout();
      }
      return ctrl;
    }

    function show(det) {
      clear();
      if (!panel || !body) return;
      panel.style.display = '';
      if (!det || det.tier === 'scanned' || !det.fields || !det.fields.length) {
        const msg = document.createElement('div'); msg.className = 'hint';
        msg.innerHTML = (det && det.tier === 'scanned')
          ? '📷 נראה שזה טופס <b>סרוק</b> (תמונה בלי טקסט), ולכן אי-אפשר לזהות שדות אוטומטית. הוסיפו שדות עם כלי הטקסט, ושמרו כ<b>תבנית</b> — בפעם הבאה הטופס יתמלא בשנייה.'
          : 'לא זוהו שדות אוטומטית בטופס הזה. הוסיפו שדות ידנית, ושמרו כתבנית לשימוש חוזר.';
        body.appendChild(msg);
        return;
      }
      const head = document.createElement('div'); head.className = 'hint muted';
      head.style.marginBottom = '4px';
      head.textContent = det.tier === 'acroform'
        ? `זוהו ${det.fields.length} שדות טופס — הקלידו כאן והם ימולאו על הטופס.`
        : `זוהו ${det.fields.length} שדות (זיהוי חכם — ייתכנו אי-דיוקים; אפשר לגרור לתיקון). הקלידו למילוי.`;
      body.appendChild(head);

      det.fields.forEach((f) => {
        const row = document.createElement('div'); row.className = 'field';
        const lab = document.createElement('label'); lab.textContent = f.label; row.appendChild(lab);
        const inRow = document.createElement('div'); inRow.className = 'row';
        const inp = document.createElement('input'); inp.type = 'text'; inp.dir = 'auto';
        inp.placeholder = 'מלא/י…'; inp.style.flex = '1';
        inp.addEventListener('input', () => ensureCtrl(f, inp.value));
        const go = document.createElement('button'); go.className = 'btn sm ghost'; go.textContent = '⤓';
        go.title = 'סמן על הטופס';
        go.addEventListener('click', () => {
          const c = ctrlByKey[f.fieldKey];
          if (c) { overlay.selectCtrl(c); c.node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        });
        inRow.append(inp, go); row.appendChild(inRow);
        body.appendChild(row);
      });
    }

    return { show, clear };
  }

  PFS.createFieldsPanel = createFieldsPanel;
})(window);
