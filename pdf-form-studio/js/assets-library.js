/* assets-library.js — reusable signatures & stamps, persisted in localStorage.
 * Renders the two grids in the sidebar; clicking an asset arms placement.
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

    let SEQ = 1;
    const uid = () => 'as' + (SEQ++) + '_' + Math.floor(performance.now());

    function list(kind) { return store.get(KEY[kind], []); }
    function save(kind, arr) { store.set(KEY[kind], arr); }

    function add(kind, { url, w, h }) {
      const arr = list(kind);
      const item = { id: uid(), url, w, h, aspect: (w && h) ? w / h : 1, ts: Date.now() };
      arr.unshift(item);
      save(kind, arr.slice(0, 24)); // cap
      render(kind);
      return item;
    }
    function remove(kind, id) {
      save(kind, list(kind).filter((x) => x.id !== id));
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
      arr.forEach((item) => {
        const cell = document.createElement('div');
        cell.className = 'asset';
        cell.title = 'לחץ כדי למקם על הטופס';
        const img = document.createElement('img'); img.src = item.url; cell.appendChild(img);
        const del = document.createElement('button');
        del.className = 'del'; del.textContent = '✕'; del.title = 'מחק';
        del.addEventListener('click', (e) => { e.stopPropagation(); remove(kind, item.id); });
        cell.appendChild(del);
        cell.addEventListener('click', () => opts.onPick && opts.onPick(kind, item));
        grid.appendChild(cell);
      });
    }

    function renderAll() { render('signature'); render('stamp'); }
    renderAll();

    return { add, remove, list, render, renderAll };
  }

  PFS.createAssetsLibrary = createAssetsLibrary;
})(window);
