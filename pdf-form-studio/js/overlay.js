/* overlay.js — manages per-page overlay layers and the element collection.
 * pdf-view.js builds each page's DOM and registers it here; this module owns
 * placement, selection, re-layout on zoom, and (de)serialization.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  function createOverlayManager(opts = {}) {
    const pages = [];        // { index, wrapEl, overlayEl }
    const elements = [];     // element controllers
    let selected = null;
    let placing = null;      // { create: (pageIndex, fx, fy) => model|null }

    function registerPage(index, wrapEl, overlayEl) {
      pages[index] = { index, wrapEl, overlayEl };
      overlayEl.addEventListener('pointerdown', (e) => {
        if (e.target !== overlayEl) return; // clicked an element, not empty space
        if (placing) {
          const r = overlayEl.getBoundingClientRect();
          const fx = (e.clientX - r.left) / r.width;
          const fy = (e.clientY - r.top) / r.height;
          const model = placing.create(index, fx, fy);
          if (model) instantiate(model);
          if (!placing.sticky) setPlacing(null);
        } else {
          deselectAll();
        }
      });
    }

    function overlaySizeFor(pageIndex) {
      const p = pages[pageIndex];
      const r = p.overlayEl.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }

    function instantiate(model) {
      const page = pages[model.page];
      if (!page) return null;
      const ctrl = PFS.element.createElement(model, {
        overlayEl: page.overlayEl,
        getOverlaySize: () => overlaySizeFor(model.page),
        onSelect: (c) => selectCtrl(c),
        onChange: () => opts.onChange && opts.onChange(),
        onDelete: (c) => deleteCtrl(c)
      });
      page.overlayEl.appendChild(ctrl.node);
      ctrl.layout();
      elements.push(ctrl);
      selectCtrl(ctrl);
      opts.onChange && opts.onChange();
      return ctrl;
    }

    // create + place a model centered at (fx,fy), clamped so it stays on-page
    function addElementAt(type, pageIndex, fx, fy, extra) {
      const model = PFS.element.makeModel(type, pageIndex, extra);
      // center on the drop point
      model.fx = PFS.clamp(fx - model.fw / 2, 0, 1 - model.fw);
      model.fy = PFS.clamp(fy - model.fh / 2, 0, 1 - model.fh);
      const ctrl = instantiate(model);
      if (ctrl && ctrl.model.type === 'text' && !extra?.noEdit) {
        setTimeout(() => ctrl.focusText(), 0);
      }
      return ctrl;
    }

    function selectCtrl(ctrl) {
      if (selected && selected !== ctrl) selected.deselect();
      selected = ctrl;
      ctrl.select();
      opts.onSelect && opts.onSelect(ctrl);
    }
    function deselectAll() {
      if (selected) { selected.deselect(); selected = null; }
      opts.onSelect && opts.onSelect(null);
    }
    function deleteCtrl(ctrl) {
      const i = elements.indexOf(ctrl);
      if (i >= 0) elements.splice(i, 1);
      ctrl.remove();
      if (selected === ctrl) { selected = null; opts.onSelect && opts.onSelect(null); }
      opts.onChange && opts.onChange();
    }

    function setPlacing(p) {
      placing = p;
      pages.forEach((pg) => pg && pg.overlayEl.classList.toggle('placing', !!p));
      opts.onPlacingChange && opts.onPlacingChange(!!p);
    }

    function relayoutAll() { elements.forEach((c) => c.layout()); }
    function getSelected() { return selected; }
    function getElements() { return elements; }
    function elementsOnPage(i) { return elements.filter((c) => c.model.page === i); }
    function pageCount() { return pages.filter(Boolean).length; }

    function clearElements() {
      elements.splice(0).forEach((c) => c.remove());
      selected = null;
      opts.onSelect && opts.onSelect(null);
      opts.onChange && opts.onChange();
    }

    // ---- serialization (templates) ----
    function serialize() {
      return elements.map((c) => {
        const m = c.model;
        return {
          type: m.type, kind: m.kind, page: m.page,
          fx: round(m.fx), fy: round(m.fy), fw: round(m.fw), fh: round(m.fh),
          fontFrac: round(m.fontFrac), color: m.color, bold: m.bold, align: m.align,
          text: m.text, imgUrl: m.imgUrl, aspect: m.aspect
        };
      });
    }
    function applyModels(models, { keepImages = true } = {}) {
      (models || []).forEach((m) => {
        if (m.type === 'image' && !m.imgUrl && !keepImages) return;
        if (pages[m.page]) instantiate(Object.assign(PFS.element.makeModel(m.kind || m.type, m.page), m, { id: undefined }));
      });
      deselectAll();
    }
    const round = (n) => Math.round(n * 1e5) / 1e5;

    return {
      registerPage, addElementAt, instantiate, setPlacing,
      selectCtrl, deselectAll, deleteCtrl, getSelected, getElements,
      elementsOnPage, relayoutAll, clearElements, serialize, applyModels,
      overlaySizeFor, pageCount
    };
  }

  PFS.createOverlayManager = createOverlayManager;
})(window);
