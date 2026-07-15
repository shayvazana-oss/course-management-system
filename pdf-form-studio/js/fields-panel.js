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
    let emptyCount = () => 0;   // rebound by show(); how many text fields are still blank

    function clear() {
      Object.keys(ctrlByKey).forEach((k) => delete ctrlByKey[k]);
      if (overlay.clearFieldMarkers) overlay.clearFieldMarkers();
      if (body) body.innerHTML = '';
      if (panel) panel.style.display = 'none';
    }

    function ensureCtrl(field, value) {
      let ctrl = ctrlByKey[field.fieldKey];
      // drop a cached controller that was deleted elsewhere (mini-✕, Delete key, empty-blur…)
      if (ctrl && overlay.getElements().indexOf(ctrl) === -1) { ctrl = null; delete ctrlByKey[field.fieldKey]; }
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

    function ensureCheck(field, on) {
      let ctrl = ctrlByKey[field.fieldKey];
      if (ctrl && overlay.getElements().indexOf(ctrl) === -1) { ctrl = null; delete ctrlByKey[field.fieldKey]; }
      if (!on) { if (ctrl) { overlay.deleteCtrl(ctrl); delete ctrlByKey[field.fieldKey]; } return; }
      if (!ctrl) {
        const model = PFS.element.makeModel('check', field.page, {
          fx: field.fx, fy: field.fy, fontFrac: Math.max(field.fontFrac || 0.02, 0.02),
          fieldKey: field.fieldKey
        });
        ctrl = overlay.instantiate(model); overlay.deselectAll();
        ctrlByKey[field.fieldKey] = ctrl;
      }
    }

    // show(det, prefill): prefill is an optional {fieldKey: value} map — those
    // text fields are filled ON THE FORM immediately (the smart-vault path).
    // Returns how many fields were auto-filled.
    function show(det, prefill) {
      clear();
      if (!panel || !body) return 0;
      panel.style.display = '';
      if (!det || det.tier === 'scanned' || !det.fields || !det.fields.length) {
        const msg = document.createElement('div'); msg.className = 'hint';
        msg.innerHTML = (det && det.tier === 'scanned')
          ? '📷 נראה שזה טופס <b>סרוק</b> (תמונה בלי טקסט), ולכן אי-אפשר לזהות שדות אוטומטית. הוסיפו שדות עם כלי הטקסט, ושמרו כ<b>תבנית</b> — בפעם הבאה הטופס יתמלא בשנייה.'
          : 'לא זוהו שדות אוטומטית בטופס הזה. הוסיפו שדות ידנית, ושמרו כתבנית לשימוש חוזר.';
        body.appendChild(msg);
        if (det && det.tier === 'scanned' && opts.ocrAvailable && opts.ocrAvailable()) {
          const btn = document.createElement('button');
          btn.className = 'btn sm primary'; btn.style.marginTop = '8px';
          btn.innerHTML = '\ud83d\udd24 \u05e7\u05e8\u05d0 \u05e2\u05dd OCR (\u05e2\u05d1\u05e8\u05d9\u05ea)';
          btn.title = '\u05e7\u05e8\u05d9\u05d0\u05d4 \u05d0\u05d5\u05d8\u05d5\u05de\u05d8\u05d9\u05ea \u05e9\u05dc \u05d8\u05d5\u05e4\u05e1 \u05e1\u05e8\u05d5\u05e7 (\u05d0\u05d9\u05d8\u05d9 \u05d5\u05de\u05d9\u05d8\u05d1\u05d9)';
          btn.addEventListener('click', () => opts.onOcr && opts.onOcr());
          body.appendChild(btn);
        }
        return 0;
      }
      const head = document.createElement('div'); head.className = 'hint muted';
      head.style.marginBottom = '4px';
      head.textContent = det.tier === 'acroform'
        ? `זוהו ${det.fields.length} שדות טופס — הקלידו כאן והם ימולאו על הטופס.`
        : det.tier === 'ocr'
        ? `OCR זיהה ${det.fields.length} שדות (טיוטה — בדקו ותקנו; אפשר לגרור). הקלידו למילוי.`
        : `זוהו ${det.fields.length} שדות (זיהוי חכם — ייתכנו אי-דיוקים; אפשר לגרור לתיקון). הקלידו למילוי.`;
      body.appendChild(head);

      // completeness meter: "מולאו X/Y" + bar, live-updated on every input
      const meter = document.createElement('div');
      meter.style.cssText = 'margin:2px 0 8px';
      meter.innerHTML = '<div class="hint" style="display:flex;justify-content:space-between"><span id="fpMeterTxt"></span></div><div style="height:6px;border-radius:99px;background:var(--surface-3);overflow:hidden;margin-top:4px"><div id="fpMeterBar" style="height:100%;width:0;background:linear-gradient(90deg,var(--brand),#2E6DB4);border-radius:99px;transition:width .25s"></div></div>';
      body.appendChild(meter);
      // amber hints over empty detected fields (cleared as they fill)
      if (overlay.setFieldMarkers) overlay.setFieldMarkers(det.fields);
      const controls = []; const fieldMeta = [];
      function recount() {
        const total = controls.length;
        const done = controls.filter((c) => c.type === 'checkbox' ? c.checked : c.value.trim()).length;
        const t = meter.querySelector('#fpMeterTxt'), bar = meter.querySelector('#fpMeterBar');
        if (t) t.textContent = 'מולאו ' + done + ' מתוך ' + total + ' שדות';
        if (bar) bar.style.width = total ? Math.round(done / total * 100) + '%' : '0';
        // sync empty-field markers
        if (overlay.setFieldFilled) controls.forEach((c, i) => {
          const f = fieldMeta[i]; if (f) overlay.setFieldFilled(f.fieldKey, c.type === 'checkbox' ? c.checked : !!c.value.trim());
        });
      }

      let autoFilled = 0;
      det.fields.forEach((f) => {
        const row = document.createElement('div'); row.className = 'field';
        const lab = document.createElement('label'); lab.textContent = f.label; row.appendChild(lab);
        const inRow = document.createElement('div'); inRow.className = 'row';
        let control;
        if (f.type === 'check') {
          control = document.createElement('input'); control.type = 'checkbox';
          control.style.width = '20px'; control.style.height = '20px'; control.style.accentColor = 'var(--brand)';
          control.title = 'סמן וי על הטופס';
          control.addEventListener('change', () => { ensureCheck(f, control.checked); recount(); });
        } else {
          control = document.createElement('input'); control.type = 'text'; control.dir = 'auto';
          control.placeholder = 'מלא/י…'; control.style.flex = '1';
          const canon = PFS.vault && (PFS.vault.matchKey(f.label) || PFS.vault.matchKey(f.fieldKey));
          const validate = () => {
            // live Israeli-ID checksum: catch typos before they land on paper
            if (canon !== 'id') return;
            const digits = control.value.replace(/\D/g, '');
            const bad = digits.length >= 5 && !PFS.vault.checkIsraeliId(digits);
            control.style.borderColor = bad ? 'var(--danger)' : '';
            control.title = bad ? 'מספר תעודת הזהות לא עובר ביקורת ספרת ביקורת — בדקו הקלדה' : '';
          };
          control.addEventListener('input', () => { ensureCtrl(f, control.value); validate(); recount(); });
          const pv = prefill && prefill[f.fieldKey];
          if (pv != null && String(pv).trim()) {
            control.value = pv;
            if (ensureCtrl(f, String(pv))) autoFilled++;
            validate();
          }
        }
        const go = document.createElement('button'); go.className = 'btn sm ghost'; go.textContent = '⤓';
        go.title = 'סמן על הטופס';
        go.addEventListener('click', () => {
          const c = ctrlByKey[f.fieldKey];
          if (c) { overlay.selectCtrl(c); c.node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
        });
        // voice fill (Chrome/Edge; he-IL). Feature-detected — absent elsewhere.
        const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
        if (SR && f.type !== 'check') {
          const mic = document.createElement('button'); mic.className = 'btn sm ghost'; mic.textContent = '🎤';
          mic.title = 'מלא/י בדיבור';
          mic.addEventListener('click', () => {
            const rec = new SR(); rec.lang = 'he-IL'; rec.interimResults = false; rec.maxAlternatives = 1;
            mic.textContent = '🔴';
            rec.onresult = (ev) => { const t = ev.results[0][0].transcript.trim(); control.value = t; ensureCtrl(f, t); };
            rec.onend = () => { mic.textContent = '🎤'; };
            rec.onerror = () => { mic.textContent = '🎤'; };
            try { rec.start(); } catch (e) { mic.textContent = '🎤'; }
          });
          inRow.append(control, mic, go);
        } else {
          inRow.append(control, go);
        }
        row.appendChild(inRow);
        body.appendChild(row);
        controls.push(control); fieldMeta.push(f);
      });
      // interview mode: one question at a time, Enter advances — fastest way
      // to sweep a long form, especially on a phone
      const ivBtn = document.createElement('button');
      ivBtn.className = 'btn sm primary block'; ivBtn.style.marginTop = '8px';
      ivBtn.textContent = '🎯 מלאו בראיון — שדה אחרי שדה';
      ivBtn.addEventListener('click', () => startInterview(fieldMeta, controls));
      body.appendChild(ivBtn);
      recount();
      emptyCount = () => controls.filter((c) => c.type !== 'checkbox' && !c.value.trim()).length;
      return autoFilled;
    }

    let ivBar = null;
    function startInterview(fields, controls) {
      let i = 0;
      if (!ivBar) {
        ivBar = document.createElement('div');
        ivBar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:80;background:var(--surface);border-top:2px solid var(--brand);box-shadow:0 -6px 24px rgba(19,28,43,.18);padding:12px 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
        ivBar.innerHTML = '<div style="flex:1;min-width:180px"><div id="ivLbl" style="font-weight:800;font-size:14px"></div><div class="hint muted" id="ivProg"></div></div><input id="ivIn" type="text" dir="auto" style="flex:2;min-width:160px;padding:10px;font-size:15px" placeholder="הקלידו ו-Enter…"/><button class="btn sm" id="ivSkip">דלג</button><button class="btn sm primary" id="ivNext">הבא ⏎</button><button class="btn sm ghost" id="ivEnd">סיום</button>';
        document.body.appendChild(ivBar);
      }
      ivBar.style.display = 'flex';
      const lbl = ivBar.querySelector('#ivLbl'), prog = ivBar.querySelector('#ivProg'), inp = ivBar.querySelector('#ivIn');
      const textIdx = fields.map((f, j) => f.type !== 'check' ? j : -1).filter((j) => j >= 0);
      let pos = 0;
      function showCur() {
        if (pos >= textIdx.length) { end(); PFS.toast('🎉 סיימתם את כל השדות!', 'ok'); return; }
        const j = textIdx[pos]; const f = fields[j];
        lbl.textContent = f.label; prog.textContent = 'שדה ' + (pos + 1) + ' מתוך ' + textIdx.length;
        inp.value = controls[j].value || '';
        const c = ctrlByKey[f.fieldKey]; if (c) c.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        inp.focus();
      }
      function commit() { const j = textIdx[pos]; controls[j].value = inp.value; controls[j].dispatchEvent(new Event('input')); }
      function end() { ivBar.style.display = 'none'; }
      ivBar.querySelector('#ivNext').onclick = () => { commit(); pos++; showCur(); };
      ivBar.querySelector('#ivSkip').onclick = () => { pos++; showCur(); };
      ivBar.querySelector('#ivEnd').onclick = () => { commit(); end(); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); pos++; showCur(); } if (e.key === 'Escape') end(); };
      showCur();
    }

    return { show, clear, emptyCount: () => emptyCount() };
  }

  PFS.createFieldsPanel = createFieldsPanel;
})(window);
