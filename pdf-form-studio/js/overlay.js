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
    const multi = new Set(); // multi-selection for align/distribute commands
    let placing = null;      // { create: (pageIndex, fx, fy) => model|null }

    function registerPage(index, wrapEl, overlayEl) {
      pages[index] = { index, wrapEl, overlayEl };
      overlayEl.addEventListener('pointerdown', (e) => {
        if (e.target !== overlayEl) return; // clicked an element, not empty space
        if (!placing) { deselectAll(); return; }
        const r = overlayEl.getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width;
        const fy = (e.clientY - r.top) / r.height;
        // rect tools (whiteout / redact / highlight / replace): drag to draw the
        // exact area to cover; a plain click drops a sensible default-sized box.
        if (placing.rect) { startMarquee(index, overlayEl, fx, fy); return; }
        const model = placing.create(index, fx, fy);
        if (model) instantiate(model);
        if (!placing.sticky) setPlacing(null);
      });
    }

    // Drag a marquee over the page to define a rect cover's exact bounds. The
    // active placing.createRect(pageIndex, fx, fy, fw, fh) receives page fractions.
    function startMarquee(index, overlayEl, sfx, sfy) {
      const cb = placing.createRect, sticky = !!placing.sticky;
      const defW = placing.defW || 0.2, defH = placing.defH || 0.03;
      const box = document.createElement('div');
      box.className = 'pfs-marquee';
      box.style.cssText = 'position:absolute;border:1.5px dashed var(--brand,#0E6E78);' +
        'background:rgba(14,110,120,.12);pointer-events:none;z-index:9999;border-radius:2px;';
      overlayEl.appendChild(box);
      let cfx = sfx, cfy = sfy;
      const draw = () => {
        const r = overlayEl.getBoundingClientRect();
        box.style.left = (Math.min(sfx, cfx) * r.width) + 'px';
        box.style.top = (Math.min(sfy, cfy) * r.height) + 'px';
        box.style.width = (Math.abs(cfx - sfx) * r.width) + 'px';
        box.style.height = (Math.abs(cfy - sfy) * r.height) + 'px';
      };
      draw();
      const move = (e) => {
        const r = overlayEl.getBoundingClientRect();
        cfx = PFS.clamp((e.clientX - r.left) / r.width, 0, 1);
        cfy = PFS.clamp((e.clientY - r.top) / r.height, 0, 1);
        draw();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        box.remove();
        let fx = Math.min(sfx, cfx), fy = Math.min(sfy, cfy);
        let fw = Math.abs(cfx - sfx), fh = Math.abs(cfy - sfy);
        if (fw < 0.02 || fh < 0.008) {            // treated as a click → default box
          fw = defW; fh = defH;
          fx = PFS.clamp(sfx - fw / 2, 0, 1 - fw); fy = PFS.clamp(sfy - fh / 2, 0, 1 - fh);
        } else {
          fx = PFS.clamp(fx, 0, 1 - fw); fy = PFS.clamp(fy, 0, 1 - fh);
        }
        if (cb) cb(index, fx, fy, fw, fh);
        if (!sticky) setPlacing(null);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
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
        onSelect: (c, additive) => selectCtrl(c, additive),
        onChange: () => opts.onChange && opts.onChange(),
        onDelete: (c) => deleteCtrl(c),
        // peer geometries on this page (excluding self) for drag snapping
        getPeers: () => elements.filter((c) => c.model !== model && c.model.page === model.page).map((c) => c.model)
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

    // place a model at exact bounds (fx/fy/fw/fh supplied in `extra`), clamped
    // to stay on-page. Used by the drag-drawn rect covers and the replace flow.
    function addModelAt(type, pageIndex, extra, focus) {
      if (!pages[pageIndex]) return null;
      const model = PFS.element.makeModel(type, pageIndex, extra);
      model.fx = PFS.clamp(model.fx, 0, 1 - model.fw);
      model.fy = PFS.clamp(model.fy, 0, 1 - model.fh);
      const ctrl = instantiate(model);
      if (ctrl && focus && ctrl.model.type === 'text') setTimeout(() => ctrl.focusText(), 0);
      return ctrl;
    }

    // additive (Shift-click) toggles membership for align/distribute; a plain
    // click resets to a single selection. `selected` stays the primary member.
    function selectCtrl(ctrl, additive) {
      if (additive) {
        if (multi.has(ctrl)) {
          multi.delete(ctrl); ctrl.deselect();
          if (selected === ctrl) selected = [...multi][multi.size - 1] || null;
        } else {
          multi.add(ctrl); ctrl.select(); selected = ctrl;
        }
      } else {
        multi.forEach((c) => { if (c !== ctrl) c.deselect(); });
        multi.clear();
        if (selected && selected !== ctrl) selected.deselect();
        selected = ctrl; multi.add(ctrl); ctrl.select();
      }
      opts.onSelect && opts.onSelect(selected, multi.size);
    }
    function deselectAll() {
      multi.forEach((c) => c.deselect()); multi.clear();
      if (selected) { selected.deselect(); selected = null; }
      opts.onSelect && opts.onSelect(null, 0);
    }
    function deleteCtrl(ctrl) {
      const i = elements.indexOf(ctrl);
      if (i >= 0) elements.splice(i, 1);
      multi.delete(ctrl);
      ctrl.remove();
      if (selected === ctrl) { selected = [...multi][0] || null; opts.onSelect && opts.onSelect(selected, multi.size); }
      opts.onChange && opts.onChange();
    }
    function getMulti() { return [...multi]; }
    // apply a pure PFS.align op to the multi-selection (positions only)
    function alignSelection(op) {
      const ctrls = [...multi];
      if (ctrls.length < 2 || !PFS.align || !PFS.align[op]) return 0;
      const rects = ctrls.map((c) => ({ id: c.model.id, fx: c.model.fx, fy: c.model.fy, fw: c.model.fw, fh: c.model.fh }));
      const res = PFS.align[op](rects);
      ctrls.forEach((c) => { const r = res[c.model.id]; if (r) { c.model.fx = PFS.clamp(r.fx, 0, 1 - c.model.fw); c.model.fy = PFS.clamp(r.fy, 0, 1 - c.model.fh); c.layout(); } });
      opts.onChange && opts.onChange();
      return ctrls.length;
    }

    function isPlacing() { return !!placing; }
    function setPlacing(p) {
      placing = p;
      pages.forEach((pg) => pg && pg.overlayEl.classList.toggle('placing', !!p));
      opts.onPlacingChange && opts.onPlacingChange(!!p);
    }

    // ---- empty-field markers: subtle amber hints over detected-but-unfilled
    // spots, so a dense form shows at a glance what's left. Live in the page
    // overlays, reposition with zoom, and vanish as fields get filled. ----
    let markers = [];
    function clearFieldMarkers() { markers.splice(0).forEach((m) => m.el.remove()); }
    function layoutMarkers() {
      markers.forEach((m) => {
        const p = pages[m.field.page]; if (!p) return;
        const { w, h } = overlaySizeFor(m.field.page); const f = m.field;
        m.el.style.left = (f.fx * w) + 'px';
        m.el.style.top = (f.fy * h - 2) + 'px';
        m.el.style.width = Math.max(26, (f.fw || 0.14) * w) + 'px';
        m.el.style.height = Math.max(15, (f.fh || 0.02) * h + 4) + 'px';
      });
    }
    function setFieldMarkers(fields) {
      clearFieldMarkers();
      (fields || []).forEach((f) => {
        if (f.type === 'check') return;
        const p = pages[f.page]; if (!p) return;
        const el = document.createElement('div');
        el.className = 'field-marker'; el.dataset.key = f.fieldKey;
        // click-to-fill: the form itself is the fastest index into the field
        // list — tapping a marker jumps straight to its input row
        el.title = 'לחצו למילוי: ' + (f.label || 'שדה');
        el.addEventListener('click', (e) => { e.stopPropagation(); opts.onMarkerClick && opts.onMarkerClick(f); });
        p.overlayEl.appendChild(el);
        markers.push({ field: f, el });
      });
      layoutMarkers();
    }
    // highlight the marker of the field being typed right now (panel ↔ form link)
    function setFieldActive(key) {
      markers.forEach((m) => m.el.classList.toggle('active', !!key && m.field.fieldKey === key));
    }
    function setFieldFilled(key, filled) {
      markers.forEach((m) => { if (m.field.fieldKey === key) m.el.style.display = filled ? 'none' : ''; });
    }
    function relayoutAll() { elements.forEach((c) => c.layout()); layoutMarkers(); }
    function getSelected() { return selected; }
    function getElements() { return elements; }
    function elementsOnPage(i) { return elements.filter((c) => c.model.page === i); }
    function pageCount() { return pages.filter(Boolean).length; }

    function clearElements() {
      elements.splice(0).forEach((c) => c.remove());
      clearFieldMarkers();
      multi.clear();
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
          text: m.text, imgUrl: m.imgUrl, aspect: m.aspect, fieldKey: m.fieldKey || '',
          opacity: m.opacity, auto: m.auto || undefined, formula: m.formula || '', format: m.format || '', letterSpacing: m.letterSpacing || 0
        };
      });
    }
    function applyModels(models, { keepImages = true } = {}) {
      (models || []).forEach((m) => {
        if (m.type === 'image' && !m.imgUrl && !keepImages) return;
        if (pages[m.page]) instantiate(Object.assign(PFS.element.makeModel(m.kind || m.type, m.page), m));
      });
      deselectAll();
    }
    const round = (n) => Math.round(n * 1e5) / 1e5;

    // ---- field keys (for data profiles & mail-merge) ----
    function fieldKeys() {
      const set = new Set();
      elements.forEach((c) => { if (c.model.type === 'text' && c.model.fieldKey) set.add(c.model.fieldKey); });
      return [...set];
    }
    function currentValues() {
      const map = {};
      elements.forEach((c) => { if (c.model.type === 'text' && c.model.fieldKey) map[c.model.fieldKey] = c.model.text || ''; });
      return map;
    }
    function fillByKeys(map) {
      let n = 0;
      elements.forEach((c) => {
        const k = c.model.fieldKey;
        if (c.model.type === 'text' && k && Object.prototype.hasOwnProperty.call(map, k)) {
          c.model.text = String(map[k] ?? '');
          const inner = c.node.querySelector('.txt'); if (inner) inner.textContent = c.model.text;
          c.layout(); n++;
        }
      });
      if (n) opts.onChange && opts.onChange();
      return n;
    }

    return {
      registerPage, addElementAt, addModelAt, instantiate, setPlacing, isPlacing,
      selectCtrl, deselectAll, deleteCtrl, getSelected, getElements,
      getMulti, alignSelection,
      elementsOnPage, relayoutAll, clearElements, serialize, applyModels,
      overlaySizeFor, pageCount, fieldKeys, currentValues, fillByKeys,
      setFieldMarkers, setFieldFilled, setFieldActive, clearFieldMarkers
    };
  }

  PFS.createOverlayManager = createOverlayManager;
})(window);
