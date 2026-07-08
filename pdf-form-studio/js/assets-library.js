/* assets-library.js — reusable signatures & stamps, persisted in localStorage.
 * Renders the two grids in the sidebar; clicking an asset arms placement.
 * One asset per kind can be marked ⭐ default (used by the Fill-All action).
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  function createAssetsLibrary(opts = {}) {
    const store = PFS.store;
    const grids = {
      signature: document.getElementById('sigGrid'),
      stamp: document.getElementById('stampGrid')
    };
    const KEY = { signature: 'signatures', stamp: 'stamps' };
    const DEF = { signature: 'default_signature', stamp: 'default_stamp' };

    let SEQ = 1;
    const uid = () => 'as' + (SEQ++) + '_' + Math.floor(performance.now());

    function list(kind) { const v = store.get(KEY[kind], []); return Array.isArray(v) ? v : []; }
    function save(kind, arr) { store.set(KEY[kind], arr); }
    function defaultId(kind) { return store.get(DEF[kind], null); }
    function setDefault(kind, id) { store.set(DEF[kind], id); render(kind); }
    function getDefault(kind) {
      const arr = list(kind); if (!arr.length) return null;
      const id = defaultId(kind);
      return arr.find((x) => x.id === id) || arr[0];
    }

    function add(kind, obj) {
      const arr = list(kind);
      const item = { id: uid(), url: obj.url, w: obj.w, h: obj.h, aspect: (obj.w && obj.h) ? obj.w / obj.h : 1, ts: Date.now() };
      arr.unshift(item);
      save(kind, arr.slice(0, 24)); // cap
      if (!defaultId(kind)) store.set(DEF[kind], item.id); // first one becomes default
      render(kind);
      return item;
    }
    function remove(kind, id) {
      save(kind, list(kind).filter((x) => x.id !== id));
      if (defaultId(kind) === id) store.set(DEF[kind], null);
      render(kind);
    }

    function render(kind) {
      const grid = grids[kind];
      if (!grid) return;
      grid.innerHTML = '';
      const arr = list(kind);
      if (!arr.length) {
        const empty = document.createElement('div');
        empty.className = 'asset empty';
        empty.textContent = kind === 'signature'
          ? 'אין חתימות שמורות — צייר או העלה כדי להוסיף.'
          : 'אין חותמות שמורות — העלה כדי להוסיף.';
        grid.appendChild(empty);
        return;
      }
      const def = defaultId(kind) || arr[0].id;
      arr.forEach((item) => {
        const cell = document.createElement('div');
        cell.className = 'asset' + (item.id === def ? ' is-default' : '');
        cell.title = 'לחץ כדי למקם על הטופס';
        const img = document.createElement('img'); img.src = item.url; cell.appendChild(img);
        const del = document.createElement('button');
        del.className = 'del'; del.textContent = '✕'; del.title = 'מחק';
        del.addEventListener('click', function (e) { e.stopPropagation(); remove(kind, item.id); });
        cell.appendChild(del);
        const star = document.createElement('button');
        star.className = 'star'; star.textContent = item.id === def ? '★' : '☆';
        star.title = 'קבע כברירת מחדל';
        star.addEventListener('click', function (e) { e.stopPropagation(); setDefault(kind, item.id); });
        cell.appendChild(star);
        cell.addEventListener('click', function () { opts.onPick && opts.onPick(kind, item); });
        grid.appendChild(cell);
      });
    }

    function renderAll() { render('signature'); render('stamp'); }
    renderAll();

    return { add, remove, list, render, renderAll, getDefault, setDefault };
  }

  PFS.createAssetsLibrary = createAssetsLibrary;
})(window);
