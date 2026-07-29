/* fields-panel.js — the "detected fields" input rows.
 * Shows one labeled input per detected field; typing creates/updates a tagged
 * text element at the detected spot on the form (and clearing removes it).
 * Because fields carry a fieldKey, profiles and mail-merge work through them.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  // tick-style controls (checkbox or radio) count by .checked, not text value.
  const isTick = (c) => c.type === 'checkbox' || c.type === 'radio';
  // identity fields a multi-page form repeats verbatim — filling one fills the
  // rest. Deliberately NOT generic canons (amount, date, occupation…) so a value
  // is only ever auto-copied where it's unambiguously the same datum.
  const IDENTITY = new Set(['id', 'full_name', 'first_name', 'last_name', 'phone', 'email', 'birth_date', 'address', 'city', 'zip', 'business_id', 'business_name']);
  // a field whose label asks for a signature (not a stamp — "חותמת" excluded)
  const isSignatureLabel = (s) => /חתימ|signature|sign here|توقيع/i.test(String(s || ''));
  // a field whose label asks for a stamp / seal
  const isStampLabel = (s) => /חותמת|חתמת|stamp|seal|ختم/i.test(String(s || ''));

  function createFieldsPanel(opts = {}) {
    const overlay = opts.overlay;
    const panel = document.getElementById('fieldsPanel');
    const body = document.getElementById('fieldsBody');
    const ctrlByKey = {};
    let emptyCount = () => 0;   // rebound by show(); how many text fields are still blank
    let requiredEmpty = () => 0; // rebound by show(); blank text fields marked required (*)

    // value memory lives in the patterns engine (single memory — the datalist,
    // the choice dropdown and the learning counters must never disagree).
    function optionsOf(f) { return (PFS.patterns && PFS.patterns.optionsFor) ? PFS.patterns.optionsFor(f) : []; }
    function rememberVal(f, val) {
      val = String(val || '').trim(); if (val.length < 2) return;
      if (PFS.patterns && PFS.patterns.touch) PFS.patterns.touch(f, val);
    }
    // fieldKeys whose value came from prefill and was never touched by the
    // user — the learning loop must skip them (self-reinforcement guard).
    // Closure-scoped: show() re-runs (org-save, profile apply) and a per-show
    // set would forget marks for fields already sitting on the overlay.
    const autoKeys = new Set();

    // floating learned-values picker (the "חלון בחירה" for campuses etc.)
    let ddEl = null;
    function closeChoices() { if (ddEl) { ddEl.remove(); ddEl = null; document.removeEventListener('pointerdown', onDDOutside, true); } }
    function onDDOutside(e) { if (ddEl && !ddEl.contains(e.target)) closeChoices(); }
    function openChoices(f, control, anchor) {
      closeChoices();
      const opts = optionsOf(f);
      if (!opts.length) return;
      ddEl = document.createElement('div');
      ddEl.className = 'pat-dd';
      const r = anchor.getBoundingClientRect();
      ddEl.style.top = (r.bottom + 4) + 'px';
      // RTL: align the list's RIGHT edge near the anchor, clamped to viewport
      ddEl.style.right = Math.max(8, window.innerWidth - r.right - 4) + 'px';
      // campus addresses get their campus name as a bold prefix in the list
      const camps = PFS.store.get('org_campuses', []) || [];
      const nameOf = (v) => { const c = camps.find((x) => x.address === v); return (c && c.name) ? c.name : null; };
      opts.forEach((o) => {
        const item = document.createElement('div');
        item.className = 'pat-dd-item';
        const txt = document.createElement('span'); txt.className = 'v';
        const nm = nameOf(o.v);
        if (nm) { const b = document.createElement('b'); b.textContent = nm + ' · '; txt.appendChild(b); }
        txt.appendChild(document.createTextNode(o.v));
        const tag = document.createElement('span'); tag.className = 'tag';
        tag.textContent = o.pinned ? '📌 ידני' : ('×' + o.n);
        const del = document.createElement('button'); del.className = 'x'; del.textContent = '✕';
        del.title = 'שכח את הערך הזה';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          PFS.patterns.removeValue(f, o.v);
          openChoices(f, control, anchor);   // re-render (or close if emptied)
        });
        item.append(txt, tag, del);
        item.addEventListener('click', () => {
          control.value = o.v;
          control.dispatchEvent(new Event('input', { bubbles: true }));
          control.dispatchEvent(new Event('change', { bubbles: true }));
          closeChoices();
          control.focus({ preventScroll: true });
        });
        ddEl.appendChild(item);
      });
      const free = document.createElement('div');
      free.className = 'pat-dd-item free';
      free.textContent = '✎ ערך אחר…';
      free.addEventListener('click', () => { closeChoices(); control.focus({ preventScroll: true }); control.select && control.select(); });
      ddEl.appendChild(free);
      document.body.appendChild(ddEl);
      setTimeout(() => document.addEventListener('pointerdown', onDDOutside, true), 0);
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChoices(); });

    let syncValuesImpl = null, focusFieldImpl = null;
    function clear() {
      Object.keys(ctrlByKey).forEach((k) => delete ctrlByKey[k]);
      syncValuesImpl = null; focusFieldImpl = null;
      closeChoices();
      if (overlay.clearFieldMarkers) overlay.clearFieldMarkers();
      if (body) body.innerHTML = '';
      if (panel) panel.style.display = 'none';
    }
    /* syncValues(map): refresh every row from {fieldKey: value|true} WITHOUT
     * re-rendering the panel — undo/redo restores elements and the rows must
     * follow, not vanish. Also re-links ctrlByKey to the restored controllers,
     * else the next keystroke would create a DUPLICATE element. */
    function syncValues(map) { if (syncValuesImpl) syncValuesImpl(map || {}); }
    /* focusField(fieldKey): jump the user to a row (click-to-fill on the form) */
    function focusField(key) { return focusFieldImpl ? focusFieldImpl(key) : false; }

    function ensureCtrl(field, value) {
      let ctrl = ctrlByKey[field.fieldKey];
      // drop a cached controller that was deleted elsewhere (mini-✕, Delete key, empty-blur…)
      if (ctrl && overlay.getElements().indexOf(ctrl) === -1) { ctrl = null; delete ctrlByKey[field.fieldKey]; }
      value = value || '';
      if (!value.trim()) {
        if (ctrl) { overlay.deleteCtrl(ctrl); delete ctrlByKey[field.fieldKey]; }
        return null;
      }
      const baseFont = field.fontFrac || 0.016;
      if (!ctrl) {
        const align = /[֐-׿؀-ۿ]/.test(field.label) ? 'right' : 'left';   // Hebrew or Arabic → right-align
        const model = PFS.element.makeModel('text', field.page, {
          fx: field.fx, fy: field.fy, fw: field.fw || 0.2,
          fontFrac: baseFont, align,
          fieldKey: field.fieldKey, text: value
        });
        ctrl = overlay.instantiate(model);
        overlay.deselectAll();
        ctrlByKey[field.fieldKey] = ctrl;
      } else {
        ctrl.model.text = value;
        ctrl.model.fontFrac = baseFont;   // reset before re-fitting for the new value
        const inner = ctrl.node.querySelector('.txt');
        if (inner) inner.textContent = value;
        ctrl.layout();
      }
      fitFont(ctrl, field);
      // text elements are content-sized and LEFT-anchored at fx; a Hebrew
      // answer belongs at the RIGHT edge of its band (beside the label / at
      // the cell's right). Re-anchor using the measured width.
      if (ctrl && ctrl.model.align === 'right' && field.fw) {
        const fx2 = field.fx + field.fw - ctrl.model.fw;
        if (isFinite(fx2) && fx2 > field.fx - 0.001) { ctrl.model.fx = fx2; ctrl.layout(); }
      }
      return ctrl;
    }

    // Shrink the font just enough for a long value to sit within the detected
    // blank's width — no overflow past the line. Only shrinks (never grows past
    // the detected size), and only when the field's width is known.
    function fitFont(ctrl, field) {
      if (!field || !field.fw || !overlay.overlaySizeFor) return;
      let W;
      try { W = overlay.overlaySizeFor(field.page).w; } catch (e) { return; }
      if (!W) return;
      const maxW = field.fw * W * 1.02;
      let guard = 0;
      while (ctrl.node.offsetWidth > maxW && ctrl.model.fontFrac > 0.008 && guard++ < 14) {
        ctrl.model.fontFrac *= 0.9;
        ctrl.layout();
      }
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
      const detKeys = new Set(det.fields.map((f) => f.fieldKey));
      [...autoKeys].forEach((k) => { if (!detKeys.has(k)) autoKeys.delete(k); });
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
      // interview mode entry — at the TOP where it's seen, it's the fast path
      if (det.fields.some((f) => f.type !== 'check')) {
        const ivTop = document.createElement('button');
        ivTop.className = 'btn sm primary block'; ivTop.style.marginBottom = '8px';
        ivTop.textContent = '🎯 מילוי מהיר — שדה אחרי שדה (Enter מתקדם)';
        ivTop.addEventListener('click', () => startInterview(fieldMeta, controls));
        body.appendChild(ivTop);
      }
      // amber hints over empty detected fields (cleared as they fill)
      if (overlay.setFieldMarkers) overlay.setFieldMarkers(det.fields);
      const controls = []; const fieldMeta = [];
      function recount() {
        const total = controls.length;
        const done = controls.filter((c) => isTick(c) ? c.checked : c.value.trim()).length;
        const t = meter.querySelector('#fpMeterTxt'), bar = meter.querySelector('#fpMeterBar');
        if (t) t.textContent = 'מולאו ' + done + ' מתוך ' + total + ' שדות';
        if (bar) bar.style.width = total ? Math.round(done / total * 100) + '%' : '0';
        // sync empty-field markers
        if (overlay.setFieldFilled) controls.forEach((c, i) => {
          const f = fieldMeta[i]; if (f) overlay.setFieldFilled(f.fieldKey, isTick(c) ? c.checked : !!c.value.trim());
        });
      }

      // when an identity field is filled, copy the value into every other EMPTY
      // field of the same meaning (ID/name/phone… repeated across pages). Never
      // overwrites a value the user already typed, and is re-entrancy guarded.
      let propagating = false;
      function propagateIdentity(src) {
        if (propagating) return;
        const canon = src.__canon, val = (src.value || '').trim();
        if (!IDENTITY.has(canon) || !val) return;
        propagating = true;
        try {
          controls.forEach((c) => {
            if (c === src || isTick(c) || c.__canon !== canon || (c.value || '').trim()) return;
            c.value = src.value;
            c.dispatchEvent(new Event('input'));   // runs its own ensureCtrl/validate/recount
          });
        } finally { propagating = false; }
      }

      let autoFilled = 0;
      const groups = Object.create(null);   // radio group id → [{f, control}]
      det.fields.forEach((f) => {
        const row = document.createElement('div'); row.className = 'field';
        const lab = document.createElement('label'); lab.textContent = f.label;
        if (f.required) { const star = document.createElement('span'); star.textContent = ' *'; star.style.color = 'var(--danger)'; star.title = 'שדה חובה'; lab.appendChild(star); }
        row.appendChild(lab);
        const inRow = document.createElement('div'); inRow.className = 'row';
        const canon = PFS.vault && (PFS.vault.matchKey(f.label) || PFS.vault.matchKey(f.fieldKey));
        let control;
        if (f.type === 'check') {
          control = document.createElement('input');
          // round-bullet options that share a line are a single-choice group →
          // render as radios so only one can be picked; squares stay checkboxes.
          const grouped = f.group && det.fields.filter((o) => o.group === f.group).length >= 2;
          control.type = grouped ? 'radio' : 'checkbox';
          if (grouped) { control.name = 'fpg_' + f.group; (groups[f.group] = groups[f.group] || []).push({ f, control }); }
          control.style.width = '20px'; control.style.height = '20px'; control.style.accentColor = 'var(--brand)';
          control.title = grouped ? 'בחר/י אפשרות אחת' : 'סמן וי על הטופס';
          control.addEventListener('change', () => {
            // picking one radio clears the mark of its siblings on the form
            if (grouped && control.checked) groups[f.group].forEach((m) => { if (m.control !== control) { m.control.checked = false; ensureCheck(m.f, false); } });
            ensureCheck(f, control.checked); recount();
            // remember a recognised choice (e.g. gender) so the next form
            // auto-ticks it — memory that learns from what you pick by hand
            if (control.checked && opts.rememberChoice && PFS.vault && PFS.vault.classifyChoice) {
              const cl = PFS.vault.classifyChoice(f.label);
              if (cl) opts.rememberChoice(cl.canon, cl.value);
            }
          });
          // selection memory: auto-tick the option the saved details point to
          // (gender, verbatim matches). matchChecks already picks ≤1 per group.
          if (prefill && prefill[f.fieldKey] === true) { control.checked = true; ensureCheck(f, true); autoFilled++; }
        } else {
          control = document.createElement('input'); control.type = 'text'; control.dir = 'auto';
          control.placeholder = 'מלא/י…'; control.style.flex = '1';
          const validate = () => {
            // live format checks — catch typos before they land on paper.
            // shared with the pre-export sweep so both judge values identically.
            const r = PFS.validate.field(canon, control.value);
            control.style.borderColor = r.ok ? '' : 'var(--danger)';
            control.title = r.msg;
          };
          control.__fkey = f.fieldKey; control.__canon = canon || '';
          const patOpts = optionsOf(f);
          if (patOpts.length >= 2) {
            // learned CHOICES (campus addresses etc.) → a real, visible picker.
            // No datalist here — one memory, one surface.
            const pick = document.createElement('button');
            pick.type = 'button'; pick.className = 'btn sm ghost fp-pick'; pick.textContent = '▾';
            pick.title = 'בחירה מערכים שנלמדו (' + patOpts.length + ')';
            pick.addEventListener('click', (e) => { e.preventDefault(); openChoices(f, control, pick); });
            control.addEventListener('keydown', (e) => {
              if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); openChoices(f, control, pick); }
            });
            inRow.appendChild(pick);
            if (!control.value) {
              const top = patOpts[0];
              control.placeholder = '▾ לבחירה: ' + (top.v.length > 28 ? top.v.slice(0, 28) + '…' : top.v);
            }
          } else if (patOpts.length === 1) {
            const dl = document.createElement('datalist'); dl.id = 'dl_' + Math.random().toString(36).slice(2, 8);
            const o = document.createElement('option'); o.value = patOpts[0].v; dl.appendChild(o);
            row.appendChild(dl); control.setAttribute('list', dl.id);
          }
          control.addEventListener('change', () => rememberVal(f, control.value));
          control.addEventListener('input', () => {
            autoKeys.delete(f.fieldKey); control.classList.remove('fp-auto');
            ensureCtrl(f, control.value); validate(); recount(); propagateIdentity(control);
          });
          // panel ↔ form visual link: focusing a row lights its marker on the
          // form and brings the spot into view — you always see WHERE you type
          control.addEventListener('focus', () => {
            if (overlay.setFieldActive) overlay.setFieldActive(f.fieldKey);
            if (opts.onFieldFocus) opts.onFieldFocus(f);
          });
          control.addEventListener('blur', () => { if (overlay.setFieldActive) overlay.setFieldActive(null); });
          control.addEventListener('keydown', (e) => {
            // keyboard field-wizard: Enter / ArrowDown → next field, ArrowUp → previous
            if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const texts = controls.filter((c) => !isTick(c));
            const i = texts.indexOf(control);
            const next = (e.key === 'ArrowUp') ? texts[i - 1] : texts[i + 1];
            e.preventDefault();
            if (next) { next.focus({ preventScroll: true }); next.select && next.select(); PFS.scrollToEl(next, 'center'); const ct = ctrlByKey[next.__fkey]; if (ct) PFS.scrollToEl(ct.node, 'center'); }
            else control.blur();
          });
          const pv = prefill && prefill[f.fieldKey];
          if (pv != null && String(pv).trim()) {
            control.value = pv;
            if (ensureCtrl(f, String(pv))) autoFilled++;
            validate();
            autoKeys.add(f.fieldKey);
            control.classList.add('fp-auto');
            control.title = control.title || 'מולא אוטומטית — ערכו אם צריך';
          }
        }
        // date picker for date-type fields — no fumbling with formats
        if (f.type !== 'check' && (canon === 'date' || canon === 'birth_date')) {
          const dbtn = document.createElement('button'); dbtn.className = 'btn sm ghost'; dbtn.textContent = '📅';
          dbtn.title = 'בחירת תאריך מלוח שנה';
          const dp = document.createElement('input'); dp.type = 'date';
          dp.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
          dbtn.addEventListener('click', () => { dp.showPicker ? dp.showPicker() : dp.click(); });
          dp.addEventListener('change', () => {
            if (!dp.value) return;
            const [y, m, d] = dp.value.split('-');
            control.value = d + '/' + m + '/' + y;   // Israeli dd/mm/yyyy
            control.dispatchEvent(new Event('input')); control.dispatchEvent(new Event('change'));
          });
          inRow.appendChild(dp); inRow.appendChild(dbtn);
        }
        // signature line → one tap drops the saved signature right on it,
        // instead of guessing a corner. Keeps the text input too (harmless).
        if (f.type !== 'check' && isSignatureLabel(f.label) && opts.onPlaceSignature) {
          const sbtn = document.createElement('button'); sbtn.className = 'btn sm primary'; sbtn.textContent = '✍️';
          sbtn.title = 'הנח/י את החתימה השמורה על השורה הזו';
          sbtn.addEventListener('click', () => opts.onPlaceSignature(f));
          inRow.appendChild(sbtn);
        }
        // stamp / seal line → one tap drops the saved stamp on it
        if (f.type !== 'check' && isStampLabel(f.label) && opts.onPlaceStamp) {
          const tbtn = document.createElement('button'); tbtn.className = 'btn sm primary'; tbtn.textContent = '⬤';
          tbtn.title = 'הנח/י את החותמת השמורה על השורה הזו';
          tbtn.addEventListener('click', () => opts.onPlaceStamp(f));
          inRow.appendChild(tbtn);
        }
        const go = document.createElement('button'); go.className = 'btn sm ghost'; go.textContent = '⤓';
        go.title = 'סמן על הטופס';
        go.addEventListener('click', () => {
          const c = ctrlByKey[f.fieldKey];
          if (c) { overlay.selectCtrl(c); PFS.scrollToEl(c.node, 'center'); }
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
      // amount → amount-in-words: typing the number fills the "סכום במילים"
      // field automatically (Hebrew words), the way cheques/official forms want
      (function wireAmountWords() {
        if (!PFS.numwords || !PFS.vault) return;
        const canonOf = (f) => PFS.vault.matchKey(f.label) || PFS.vault.matchKey(f.fieldKey);
        let amtIdx = -1, wordsIdx = -1;
        fieldMeta.forEach((f, i) => {
          if (isTick(controls[i])) return;
          const c = canonOf(f);
          if (c === 'amount' && amtIdx < 0) amtIdx = i;
          if (c === 'amount_words' && wordsIdx < 0) wordsIdx = i;
        });
        if (amtIdx < 0 || wordsIdx < 0) return;
        const amt = controls[amtIdx], wc = controls[wordsIdx], wf = fieldMeta[wordsIdx];
        const sync = () => {
          const num = parseFloat((amt.value || '').replace(/[^\d.]/g, ''));
          if (!isFinite(num)) return;
          wc.value = PFS.numwords.shekels(num);
          ensureCtrl(wf, wc.value); recount();
        };
        amt.addEventListener('input', sync);
        if ((amt.value || '').trim()) sync(); // prefilled amount
      })();
      recount();
      syncValuesImpl = (map) => {
        // re-link row→element controllers to the CURRENT overlay elements
        Object.keys(ctrlByKey).forEach((k) => delete ctrlByKey[k]);
        overlay.getElements().forEach((c) => { if (c.model.fieldKey) ctrlByKey[c.model.fieldKey] = c; });
        propagating = true;   // identity copy must not fire during a sync
        try {
          controls.forEach((c, i) => {
            const f = fieldMeta[i]; if (!f) return;
            if (isTick(c)) { c.checked = map[f.fieldKey] === true; }
            else {
              const v = map[f.fieldKey] != null && map[f.fieldKey] !== true ? String(map[f.fieldKey]) : '';
              if (c.value !== v) c.value = v;
            }
          });
        } finally { propagating = false; }
        recount();
      };
      focusFieldImpl = (key) => {
        const i = fieldMeta.findIndex((f) => f && f.fieldKey === key);
        if (i < 0 || !controls[i]) return false;
        const c = controls[i];
        PFS.scrollToEl(c, 'center');
        c.focus({ preventScroll: true });
        c.select && c.select();
        return true;
      };
      emptyCount = () => controls.filter((c) => !isTick(c) && !c.value.trim()).length;
      requiredEmpty = () => controls.filter((c, i) => !isTick(c) && !c.value.trim() && fieldMeta[i] && fieldMeta[i].required).length;

      // one-click escape hatch for over-eager auto-fill: wipe every field that
      // was filled automatically and never touched (typed/edited fields stay)
      if (autoKeys.size) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn sm block fp-clear-auto';
        clearBtn.textContent = '🧹 נקה מילוי אוטומטי (' + autoKeys.size + ')';
        clearBtn.title = 'מחיקת כל השדות שמולאו אוטומטית ולא נגעתם בהם — Ctrl+Z מחזיר';
        clearBtn.addEventListener('click', () => {
          const keys = [...autoKeys];
          keys.forEach((k) => {
            const ctrl = overlay.getElements().find((c) => c.model.fieldKey === k);
            if (ctrl) overlay.deleteCtrl(ctrl);
            const cIdx = fieldMeta.findIndex((m) => m && m.fieldKey === k);
            if (cIdx >= 0 && controls[cIdx] && !isTick(controls[cIdx])) {
              controls[cIdx].value = '';
              controls[cIdx].classList.remove('fp-auto');
            }
            delete ctrlByKey[k];
            autoKeys.delete(k);
          });
          clearBtn.remove();
          if (PFS.toast) PFS.toast('המילוי האוטומטי נוקה — Ctrl+Z מחזיר', 'ok');
        });
        // right under the interview button, before the field rows
        const firstRow = body.querySelector('.field');
        body.insertBefore(clearBtn, firstRow || null);
      }
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
        const c = ctrlByKey[f.fieldKey]; if (c) PFS.scrollToEl(c.node, 'center');
        inp.focus({ preventScroll: true });
      }
      function commit() { const j = textIdx[pos]; controls[j].value = inp.value; controls[j].dispatchEvent(new Event('input')); }
      function end() { ivBar.style.display = 'none'; }
      ivBar.querySelector('#ivNext').onclick = () => { commit(); pos++; showCur(); };
      ivBar.querySelector('#ivSkip').onclick = () => { pos++; showCur(); };
      ivBar.querySelector('#ivEnd').onclick = () => { commit(); end(); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); pos++; showCur(); } if (e.key === 'Escape') end(); };
      showCur();
    }

    return {
      show, clear, syncValues, focusField,
      emptyCount: () => emptyCount(), requiredEmpty: () => requiredEmpty(),
      autoFilledKeys: () => [...autoKeys],
      resetAutoFilled: () => autoKeys.clear()
    };
  }

  PFS.createFieldsPanel = createFieldsPanel;
})(window);
