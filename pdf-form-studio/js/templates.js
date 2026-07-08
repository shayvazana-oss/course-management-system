/* templates.js — save & reapply a form's field layout.
 * A template is the serialized set of placed elements (positions as fractions,
 * plus any signature/stamp image). Saving one lets you refill the same form in
 * seconds next time. Persisted in localStorage; exportable/importable as JSON.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  function createTemplates(opts = {}) {
    const store = PFS.store;
    const KEY = 'templates';
    const listEl = document.getElementById('tmplList');

    let SEQ = 1;
    const uid = () => 'tpl' + (SEQ++) + '_' + Math.floor(performance.now());

    const all = () => { const v = store.get(KEY, []); return Array.isArray(v) ? v : []; };
    const persist = (arr) => store.set(KEY, arr); // returns false on quota/serialize failure

    function save(name, fp) {
      const els = opts.getElements();
      if (!els.length) { PFS.toast('אין פריטים לשמירה', 'err'); return; }
      const arr = all();
      const tpl = { id: uid(), name: name || ('תבנית ' + (arr.length + 1)), ts: Date.now(), elements: els, fp: fp || null };
      arr.unshift(tpl);
      if (!persist(arr)) return; // store.set already toasted the quota error
      render();
      PFS.toast('התבנית נשמרה', 'ok');
    }
    function apply(id) {
      const tpl = all().find((t) => t.id === id);
      if (!tpl) return;
      opts.applyModels(tpl.elements);
      PFS.toast('התבנית הוחלה', 'ok');
      opts.afterApply && opts.afterApply();
    }
    function remove(id) { persist(all().filter((t) => t.id !== id)); render(); }

    function exportAll() {
      const data = JSON.stringify({ app: 'pdf-form-studio', version: 1, templates: all() }, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pdf-form-studio-templates.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    }
    async function importFile(file) {
      try {
        const txt = await file.text();
        const obj = JSON.parse(txt);
        const incoming = Array.isArray(obj) ? obj : (obj.templates || []);
        if (!incoming.length) throw new Error('empty');
        const arr = all();
        incoming.forEach((t) => arr.unshift(Object.assign({}, t, { id: uid() })));
        persist(arr);
        render();
        PFS.toast('התבניות יובאו', 'ok');
      } catch (e) {
        PFS.toast('קובץ תבניות לא תקין', 'err');
      }
    }

    // best template whose stored fingerprint matches the given form fingerprint
    function findMatch(fp) {
      if (!fp || !PFS.fingerprint) return null;
      let best = null, bestScore = 0;
      all().forEach((t) => { if (!t.fp) return; const sc = PFS.fingerprint.score(fp, t.fp); if (sc > bestScore) { bestScore = sc; best = t; } });
      return bestScore >= 0.9 ? { tpl: best, score: bestScore } : null;
    }

    function render() {
      if (!listEl) return;
      listEl.innerHTML = '';
      const arr = all();
      if (!arr.length) {
        const em = document.createElement('div');
        em.className = 'hint muted'; em.textContent = 'אין תבניות שמורות עדיין.';
        listEl.appendChild(em);
        return;
      }
      arr.forEach((t) => {
        const row = document.createElement('div'); row.className = 'tmpl-item';
        const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = t.name;
        const cnt = document.createElement('span'); cnt.className = 'pill'; cnt.textContent = (t.elements || []).length + ' שדות';
        const applyBtn = document.createElement('button'); applyBtn.className = 'btn sm primary'; applyBtn.textContent = 'החל';
        applyBtn.addEventListener('click', () => apply(t.id));
        const delBtn = document.createElement('button'); delBtn.className = 'btn sm ghost'; delBtn.textContent = '🗑';
        delBtn.addEventListener('click', () => remove(t.id));
        row.append(nm, cnt, applyBtn, delBtn);
        listEl.appendChild(row);
      });
    }

    render();
    return { save, apply, remove, exportAll, importFile, render, all, findMatch };
  }

  PFS.createTemplates = createTemplates;
})(window);
