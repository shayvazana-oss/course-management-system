/* assets-library.js — reusable signatures & stamps, persisted in localStorage.
 * Renders the two grids in the sidebar; clicking an asset arms placement.
 * One asset per kind can be marked ⭐ default (used by the Fill-All action).
 *
 * The team's assets (shared by a colleague in the department, see
 * app.js teamRefresh) sit beside one's own, tagged "צוות", and work the same
 * way — placed, starred, reached by Fill-All. They are never written into
 * one's own lists; only the person who shared one (or the department's
 * admin) can take it off the team.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  function createAssetsLibrary(opts = {}) {
    const store = PFS.store;
    const grids = {
      signature: document.getElementById('sigGrid'),
      stamp: document.getElementById('stampGrid'),
      // 'clip' = a piece lifted off a scanned page (a filled block, a wet
      // signature, a stamp impression) — reusable like any other asset
      clip: document.getElementById('clipGrid')
    };
    const KEY = { signature: 'signatures', stamp: 'stamps', clip: 'clips' };
    const DEF = { signature: 'default_signature', stamp: 'default_stamp', clip: 'default_clip' };

    let SEQ = 1;
    const uid = () => 'as' + (SEQ++) + '_' + Math.floor(performance.now());

    // the team's shared assets: kept in memory, cached on this computer while
    // small (offline starts keep them; never in the personal cloud copy)
    const TEAM = 'acct:team_assets';
    let team = store.get(TEAM, null);
    // (the app's account state may not exist yet at the first render)
    const ctx = () => { try { return (opts.teamCtx && opts.teamCtx()) || {}; } catch (e) { return {}; } };
    function setTeam(doc) {
      team = doc && Array.isArray(doc.items) ? doc : null;
      try {
        const raw = team ? JSON.stringify(team) : '';
        if (team && raw.length < 1500000) store.set(TEAM, team); else store.remove(TEAM);
      } catch (e) {}
      renderAll();
    }
    // a colleague's ids are not unique across people: the team's copy is
    // named by who shared it
    const teamId = (x) => 'team:' + x.by + ':' + x.id;
    function teamItems(kind) { return team ? team.items.filter((x) => x && x.kind === kind && x.url) : []; }
    function own(kind) { const v = store.get(KEY[kind], []); return Array.isArray(v) ? v : []; }
    function sharedIds() { const me = ctx().me; return new Set(teamItems('signature').concat(teamItems('stamp'), teamItems('clip')).filter((x) => me && x.by === me).map((x) => x.id)); }
    function list(kind) {
      const mine = own(kind), shared = sharedIds(), me = ctx().me;
      const out = mine.map((x) => (shared.has(x.id) ? Object.assign({}, x, { shared: true }) : x));
      teamItems(kind).forEach((x) => {
        if (me && x.by === me && mine.some((m) => m.id === x.id)) return;   // my own, already listed
        out.push(Object.assign({}, x, { id: teamId(x), srcId: x.id, team: true }));
      });
      return out;
    }
    function save(kind, arr) { store.set(KEY[kind], arr.filter((x) => !x.team).map((x) => { if (!x.shared) return x; const c = Object.assign({}, x); delete c.shared; return c; })); }
    function defaultId(kind) { return store.get(DEF[kind], null); }
    function setDefault(kind, id) { store.set(DEF[kind], id); render(kind); }
    function getDefault(kind) {
      const arr = list(kind); if (!arr.length) return null;
      const id = defaultId(kind);
      // nothing starred here: the one its sharer starred (the office's own signature)
      return arr.find((x) => x.id === id) || arr.find((x) => x.team && x.def) || arr[0];
    }

    function add(kind, obj) {
      const arr = own(kind);
      // fw/fh (page fractions) are kept when the caller knows the real size the
      // asset occupied — a clip re-placed later then matches its original
      const item = { id: uid(), url: obj.url, w: obj.w, h: obj.h, aspect: (obj.w && obj.h) ? obj.w / obj.h : 1, ts: Date.now() };
      if (obj.fw && obj.fh) { item.fw = obj.fw; item.fh = obj.fh; }
      arr.unshift(item);
      // clips are full-resolution page crops — far heavier than a signature,
      // so they get a tighter cap to stay inside the localStorage budget
      save(kind, arr.slice(0, kind === 'clip' ? 8 : 24));
      if (!defaultId(kind)) store.set(DEF[kind], item.id); // first one becomes default
      render(kind);
      return item;
    }
    function remove(kind, id) {
      save(kind, own(kind).filter((x) => x.id !== id));
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
          : kind === 'clip'
          ? 'אין קטעים שמורים — בחרו "העתק אזור" בסרגל וגררו מעל חלק במסמך.'
          : 'אין חותמות שמורות — העלה כדי להוסיף.';
        grid.appendChild(empty);
        return;
      }
      const def = getDefault(kind).id;
      const c = ctx();
      arr.forEach((item) => {
        const cell = document.createElement('div');
        cell.className = 'asset' + (item.id === def ? ' is-default' : '') + (item.team ? ' team' : '') + (item.shared ? ' shared' : '');
        cell.title = item.team ? 'של הצוות (שיתף/ה: ' + item.by + ') — לחץ כדי למקם על הטופס' : 'לחץ כדי למקם על הטופס';
        const img = document.createElement('img'); img.src = item.url; cell.appendChild(img);
        if (item.team || item.shared) {
          const tag = document.createElement('span');
          tag.className = 'team-tag'; tag.textContent = item.team ? 'צוות' : 'משותף';
          cell.appendChild(tag);
        }
        // a team asset comes off the team only by whoever shared it, or the admin
        const canDel = !item.team || (c.me && item.by === c.me) || c.admin;
        if (canDel) {
          const del = document.createElement('button');
          del.className = 'del'; del.textContent = '✕';
          del.title = item.team ? 'הסר מהצוות' : 'מחק';
          del.addEventListener('click', function (e) {
            e.stopPropagation();
            if ((item.team || item.shared) && opts.onRemoveShared) opts.onRemoveShared(kind, item);
            else remove(kind, item.id);
          });
          cell.appendChild(del);
        }
        // ⭐ marks what Fill-All reaches for; clips are placed by hand, so the
        // star would be a control with nothing to control
        if (kind !== 'clip') {
          const star = document.createElement('button');
          star.className = 'star'; star.textContent = item.id === def ? '★' : '☆';
          star.title = 'קבע כברירת מחדל';
          star.addEventListener('click', function (e) { e.stopPropagation(); setDefault(kind, item.id); });
          cell.appendChild(star);
        }
        cell.addEventListener('click', function () { opts.onPick && opts.onPick(kind, item); });
        grid.appendChild(cell);
      });
    }

    /* Handing assets to a colleague WITHOUT an account: a small file holding
     * only signatures and stamps (never the profile, the session or anything
     * else). Importing ADDS to the receiver's own — duplicates (same image)
     * are skipped, nothing of theirs is replaced, their ⭐ stays; a ⭐ comes
     * along only when they have none. */
    const CAP = { signature: 24, stamp: 24, clip: 8 };
    const IMG = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
    function exportable() {
      const out = [];
      ['signature', 'stamp'].forEach((kind) => {
        const def = defaultId(kind);
        own(kind).forEach((x) => {
          if (!x || typeof x.url !== 'string' || x.url.indexOf('data:image/') !== 0) return;
          const it = { kind, url: x.url, w: x.w, h: x.h, aspect: x.aspect };
          if (x.fw && x.fh) { it.fw = x.fw; it.fh = x.fh; }
          if (x.id === def) it.def = true;
          out.push(it);
        });
      });
      return out;
    }
    // → {added, duplicate, invalid, full}
    function importItems(items) {
      const r = { added: 0, duplicate: 0, invalid: 0, full: 0 };
      if (!Array.isArray(items)) { r.invalid = 1; return r; }
      ['signature', 'stamp'].forEach((kind) => {
        const arr = own(kind).slice();
        let newDef = null;
        items.filter((x) => x && x.kind === kind).forEach((x) => {
          if (typeof x.url !== 'string' || !IMG.test(x.url) || x.url.length > 4000000) { r.invalid++; return; }
          if (arr.some((a) => a.url === x.url)) { r.duplicate++; return; }
          if (arr.length >= CAP[kind]) { r.full++; return; }
          const w = +x.w > 0 ? +x.w : 0, h = +x.h > 0 ? +x.h : 0;
          const item = { id: uid(), url: x.url, w, h, aspect: (w && h) ? w / h : (+x.aspect > 0 ? +x.aspect : 1), ts: Date.now() };
          if (+x.fw > 0 && +x.fh > 0) { item.fw = +x.fw; item.fh = +x.fh; }
          arr.push(item);                      // after the receiver's own
          if (x.def && !newDef) newDef = item.id;
          r.added++;
        });
        save(kind, arr);
        // the receiver's own ⭐ stays; only with none (or a dangling one) does the sender's come along
        const cur = defaultId(kind);
        if (arr.length && !(cur && arr.some((x) => x.id === cur))) store.set(DEF[kind], newDef || arr[0].id);
      });
      // items of an unknown kind are not assets
      items.forEach((x) => { if (!x || (x.kind !== 'signature' && x.kind !== 'stamp')) r.invalid++; });
      renderAll();
      return r;
    }

    function renderAll() { render('signature'); render('stamp'); render('clip'); }
    renderAll();

    return { add, remove, list, own, render, renderAll, getDefault, setDefault, setTeam, team: () => team, exportable, importItems };
  }

  PFS.createAssetsLibrary = createAssetsLibrary;
})(window);
