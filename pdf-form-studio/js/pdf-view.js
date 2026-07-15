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
    function getBytes() { return bytes; }
    function getDoc() { return pdfDoc; }
    function hasDoc() { return !!pdfDoc; }
    function numPages() { return pdfDoc ? pdfDoc.numPages : 0; }

    // page canvases + wraps, for building the thumbnail rail
    function viewList() { return views.map((v, i) => ({ n: i + 1, canvas: v.canvas, wrap: v.wrap })); }

    return { load, setScale, zoomIn, zoomOut, fit, getScale, rotatePage, getRotations, setRotations, getBytes, getDoc, hasDoc, numPages, viewList };
  }

  PFS.createPdfView = createPdfView;
})(window);
