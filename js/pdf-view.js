/* pdf-view.js — render PDF pages to canvases with pdf.js and build the
 * per-page DOM (canvas + overlay). pdf.js itself is ESM and imported by app.js;
 * it is handed in via opts.pdfjsLib so this classic script stays dependency-free.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  function createPdfView(opts) {
    const pdfjsLib = opts.pdfjsLib;
    const pagesEl = opts.pagesEl;
    const overlay = opts.overlay;

    let pdfDoc = null;
    let bytes = null;          // original bytes for export
    let scale = 1.2;
    let views = [];            // { wrap, canvas, overlayEl, pageProxy, baseW, baseH }
    let order = [];            // display order as original page indices (excludes deleted)
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    async function load(arrayBuffer) {
      bytes = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer; // keep a copy for export
      // pdf.js transfers/detaches the buffer it renders from, so give it its own copy
      const renderCopy = new Uint8Array(arrayBuffer.slice(0));
      pdfDoc = await pdfjsLib.getDocument({
        data: renderCopy,
        standardFontDataUrl: opts.standardFontDataUrl,
        // disableFontFace:true makes pdf.js draw glyph OUTLINES itself instead
        // of routing text through browser @font-face + fillText. That browser
        // path collides with this page's own web font (Heebo) and mis-shapes
        // Hebrew — letters spaced out / reordered, the "uploaded doc is
        // scrambled and unreadable" bug. Drawing outlines is immune to page
        // fonts and renders Hebrew (and other complex scripts) correctly.
        disableFontFace: true
      }).promise;
      pagesEl.innerHTML = '';
      views = [];
      for (let n = 1; n <= pdfDoc.numPages; n++) {
        const pageProxy = await pdfDoc.getPage(n);
        const base = pageProxy.getViewport({ scale: 1, rotation: pageProxy.rotate });
        const wrap = document.createElement('div');
        wrap.className = 'page-wrap';
        wrap.dataset.pageIdx = n - 1;   // stable original index (survives reorder)
        const pageno = document.createElement('div');
        pageno.className = 'pageno'; pageno.textContent = 'עמוד ' + n;
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf';
        const overlayEl = document.createElement('div');
        overlayEl.className = 'overlay';
        wrap.append(pageno, canvas, overlayEl);
        pagesEl.appendChild(wrap);
        const view = { wrap, canvas, overlayEl, pageProxy, baseW: base.width, baseH: base.height };
        views.push(view);
        overlay.registerPage(n - 1, wrap, overlayEl);
        await renderView(view);
      }
      order = views.map((_, i) => i);   // display order as original indices
      return pdfDoc.numPages;
    }

    async function renderView(view) {
      // intrinsic /Rotate + any user rotation (straightening a sideways scan)
      const rotation = ((view.pageProxy.rotate + (view.userRot || 0)) % 360 + 360) % 360;
      const vp = view.pageProxy.getViewport({ scale, rotation });
      const cssW = Math.round(vp.width), cssH = Math.round(vp.height);
      view.canvas.width = Math.round(vp.width * DPR);
      view.canvas.height = Math.round(vp.height * DPR);
      view.canvas.style.width = cssW + 'px';
      view.canvas.style.height = cssH + 'px';
      view.wrap.style.width = cssW + 'px';
      view.wrap.style.height = cssH + 'px';
      view.overlayEl.style.width = cssW + 'px';
      view.overlayEl.style.height = cssH + 'px';
      const ctx = view.canvas.getContext('2d');
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      await view.pageProxy.render({ canvasContext: ctx, viewport: vp }).promise;
    }

    async function rerenderAll() {
      for (const v of views) await renderView(v);
      overlay.relayoutAll();
      opts.onZoom && opts.onZoom(scale);
    }

    function setScale(s) {
      scale = Math.max(0.25, Math.min(5, s));
      return rerenderAll();
    }
    function zoomIn() { return setScale(scale * 1.15); }
    function zoomOut() { return setScale(scale / 1.15); }
    function fit() {
      if (!views.length) return;
      const avail = (opts.viewportEl.clientWidth || 800) - 60;
      const s = avail / views[0].baseW;
      return setScale(s);
    }
    function getScale() { return scale; }
    // rotate one page by delta degrees (default 90 CW); re-render + relayout
    async function rotatePage(index, delta = 90) {
      const v = views[index]; if (!v) return;
      v.userRot = (((v.userRot || 0) + delta) % 360 + 360) % 360;
      await renderView(v);
      overlay.relayoutAll();
      opts.onRotate && opts.onRotate();
    }
    // { pageIndex: degrees } for every page the user turned — for the exporter
    function getRotations() {
      const out = {};
      views.forEach((v, i) => { if (v.userRot) out[i] = v.userRot; });
      return out;
    }
    function setRotations(map) {
      if (!map) return;
      views.forEach((v, i) => { v.userRot = (((Number(map[i]) || 0) % 360) + 360) % 360; });
      return rerenderAll();
    }
    // mark a page removed (hidden now, dropped on export). Refuses to remove the
    // last remaining visible page. Returns true if it removed one.
    function deletePage(index) {
      const v = views[index]; if (!v || v.deleted) return false;
      if (views.filter((x) => !x.deleted).length <= 1) return false; // keep at least one
      v.deleted = true; v.wrap.style.display = 'none';
      order = order.filter((i) => i !== index);
      return true;
    }
    // re-lay the DOM: visible pages in `order`, then any deleted pages at the
    // end (so a hidden page never strands at the front, breaking "first page")
    function relayDom() {
      const deleted = views.map((_, i) => i).filter((i) => order.indexOf(i) === -1);
      order.concat(deleted).forEach((i) => pagesEl.appendChild(views[i].wrap));
    }
    // move a page one step earlier/later in the display order (dir -1 / +1)
    function movePage(index, dir) {
      const pos = order.indexOf(index);
      const to = pos + (dir < 0 ? -1 : 1);
      if (pos < 0 || to < 0 || to >= order.length) return false;
      const tmp = order[pos]; order[pos] = order[to]; order[to] = tmp;
      relayDom();
      return true;
    }
    function getPageOrder() { return order.slice(); }
    // full page state for undo/redo snapshots
    function getPageState() { return { rotations: getRotations(), removed: getRemovedPages(), order: getPageOrder() }; }
    // restore a snapshot exactly (un-deletes, resets rotations, re-lays order)
    function setPageState(st) {
      st = st || {};
      const removed = new Set((st.removed || []).map(Number));
      views.forEach((v, i) => {
        v.deleted = removed.has(i);
        v.wrap.style.display = v.deleted ? 'none' : '';
        v.userRot = ((((st.rotations || {})[i] || 0) % 360) + 360) % 360;
      });
      order = (Array.isArray(st.order) && st.order.length)
        ? st.order.filter((i) => views[i] && !views[i].deleted)
        : views.map((_, i) => i).filter((i) => !views[i].deleted);
      relayDom();
      return rerenderAll();
    }
    // a real reorder (order not simply ascending) vs. plain deletion (gaps only)
    function isReordered() { return order.some((v, i) => i > 0 && v < order[i - 1]); }
    function setPageOrder(arr) {
      if (!Array.isArray(arr) || !arr.length) return;
      const valid = arr.filter((i) => views[i] && !views[i].deleted);
      if (valid.length !== order.length) return; // stale/mismatched memory — ignore
      order = valid;
      relayDom();
    }
    function getRemovedPages() { return views.map((v, i) => (v.deleted ? i : -1)).filter((i) => i >= 0); }
    // restore deletions from memory — but never hide every page
    function setRemovedPages(arr) {
      const want = new Set((arr || []).map(Number));
      if (!want.size) return;
      if (want.size >= views.length) [...want].sort((a, b) => b - a).slice(0, views.length - 1).forEach((i) => want.add(i)); // keep ≥1 (no-op guard)
      views.forEach((v, i) => { if (want.has(i) && views.filter((x) => !x.deleted).length > 1) { v.deleted = true; v.wrap.style.display = 'none'; } });
      order = order.filter((i) => !views[i].deleted);
    }
    function visiblePageCount() { return views.filter((v) => !v.deleted).length; }
    // close the current document: free pdf.js resources, drop page DOM and all
    // per-doc state, so the app can return to the start screen (or load fresh)
    function unload() {
      try { if (pdfDoc && pdfDoc.destroy) pdfDoc.destroy(); } catch (e) {}
      pdfDoc = null;
      bytes = null;
      views = [];
      order = [];
      pagesEl.innerHTML = '';
    }
    function getBytes() { return bytes; }
    function getDoc() { return pdfDoc; }
    function hasDoc() { return !!pdfDoc; }
    function numPages() { return pdfDoc ? pdfDoc.numPages : 0; }

    // page canvases + wraps, for building the thumbnail rail
    function viewList() { return views.map((v, i) => ({ n: i + 1, idx: i, canvas: v.canvas, wrap: v.wrap, deleted: !!v.deleted })); }

    // Sample the dominant background colour in a thin band just OUTSIDE the given
    // rect (page fractions), so a cover box can be tinted to match the paper and
    // blend in seamlessly — invisible even over off-white scans or coloured cells.
    // Returns a #rrggbb string, or null if the page isn't ready / nothing sampled.
    function sampleBg(pageIndex, fx, fy, fw, fh) {
      const v = views[pageIndex]; if (!v || !v.canvas) return null;
      const cw = v.canvas.width, ch = v.canvas.height;
      let ctx; try { ctx = v.canvas.getContext('2d'); } catch (e) { return null; }
      const x0 = Math.round(fx * cw), y0 = Math.round(fy * ch);
      const w = Math.round(fw * cw), h = Math.round(fh * ch);
      const pad = Math.max(3, Math.round(Math.min(w, h) * 0.4));
      // bucket coarsely to find the dominant tone, but keep the exact pixel sums
      // per bucket so the final colour is their true average — rounding to the
      // bucket centre alone leaves a few levels of error, which is enough to
      // show as a faint rectangle on a large flat area.
      const counts = new Map();
      const sums = new Map();
      const tally = (rx, ry, rw, rh) => {
        rx = Math.max(0, Math.round(rx)); ry = Math.max(0, Math.round(ry));
        rw = Math.min(cw - rx, Math.round(rw)); rh = Math.min(ch - ry, Math.round(rh));
        if (rw < 1 || rh < 1) return;
        let data; try { data = ctx.getImageData(rx, ry, rw, rh).data; } catch (e) { return; }
        const step = 4 * Math.max(1, Math.round(data.length / 4 / 400)); // ≤~400 samples/band
        for (let i = 0; i < data.length; i += step) {
          if (data[i + 3] < 200) continue; // skip transparent
          const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
          counts.set(key, (counts.get(key) || 0) + 1);
          const s = sums.get(key) || [0, 0, 0];
          s[0] += data[i]; s[1] += data[i + 1]; s[2] += data[i + 2];
          sums.set(key, s);
        }
      };
      tally(x0 - pad, y0 - pad, w + 2 * pad, pad); // top band
      tally(x0 - pad, y0 + h, w + 2 * pad, pad);   // bottom band
      tally(x0 - pad, y0, pad, h);                 // left band
      tally(x0 + w, y0, pad, h);                   // right band
      if (!counts.size) return null;
      let best = -1, bkey = 0;
      counts.forEach((c, k) => { if (c > best) { best = c; bkey = k; } });
      const s = sums.get(bkey);
      const r = Math.round(s[0] / best), g = Math.round(s[1] / best), b = Math.round(s[2] / best);
      return '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
    }

    return { load, unload, setScale, zoomIn, zoomOut, fit, getScale, rotatePage, getRotations, setRotations, deletePage, getRemovedPages, setRemovedPages, movePage, getPageOrder, isReordered, setPageOrder, getPageState, setPageState, visiblePageCount, getBytes, getDoc, hasDoc, numPages, viewList, sampleBg };
  }

  PFS.createPdfView = createPdfView;
})(window);
