/* drag-resize.js — free-floating drag + corner-resize for overlay elements.
 * Adapted from the `.spill` pointer engine in image-slot.js, but rebased on
 * page FRACTIONS instead of a fixed slot: all deltas are converted to
 * fractions of the current overlay pixel size, so placement is correct at any
 * zoom. Geometry math uses getBoundingClientRect(), which already accounts for
 * any scaled ancestor.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* attachDragResize(node, opts)
   *  node        : the element DOM node (absolutely positioned in the overlay)
   *  opts.overlayEl : overlay <div> whose pixel size = current page display size
   *  opts.model  : { fx, fy, fw, fh }  (mutated in place)
   *  opts.handle : the resize handle node (optional)
   *  opts.aspect : w/h ratio to lock during resize (optional; e.g. images)
   *  opts.minFw  : min width fraction (default 0.01)
   *  opts.onResize(dxFrac, dyFrac, start): custom resize; return false to skip default
   *  opts.onChange(): called after any geometry change (re-layout + mark dirty)
   *  opts.onSelect(): called on pointerdown before drag
   */
  function attachDragResize(node, opts) {
    const { overlayEl, model } = opts;
    const minFw = opts.minFw ?? 0.01;
    const minFh = opts.minFh ?? 0.005;

    function overlaySize() {
      const r = overlayEl.getBoundingClientRect();
      return { w: r.width, h: r.height };
    }

    // ---- drag (move) ----
    function onBodyDown(e) {
      if (e.button != null && e.button !== 0) return;
      if (opts.handle && e.target === opts.handle) return; // handled by resize
      if (node.dataset.editing === '1') return;            // let text caret work
      e.preventDefault();
      opts.onSelect && opts.onSelect();
      const size = overlaySize();
      const start = { px: e.clientX, py: e.clientY, fx: model.fx, fy: model.fy };
      node.setPointerCapture(e.pointerId);

      const move = (ev) => {
        const dfx = (ev.clientX - start.px) / size.w;
        const dfy = (ev.clientY - start.py) / size.h;
        model.fx = clamp(start.fx + dfx, -model.fw * 0.5, 1 - model.fw * 0.5);
        model.fy = clamp(start.fy + dfy, -model.fh * 0.5, 1 - model.fh * 0.5);
        opts.onChange && opts.onChange();
      };
      const up = (ev) => {
        node.releasePointerCapture(ev.pointerId);
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
      node.addEventListener('pointercancel', up);
    }

    // ---- resize (bottom-right handle, top-left anchored) ----
    function onHandleDown(e) {
      e.preventDefault(); e.stopPropagation();
      opts.onSelect && opts.onSelect();
      const size = overlaySize();
      const start = {
        px: e.clientX, py: e.clientY,
        fw: model.fw, fh: model.fh, fx: model.fx, fy: model.fy,
        fontFrac: model.fontFrac
      };
      opts.handle.setPointerCapture(e.pointerId);

      const move = (ev) => {
        const dxFrac = (ev.clientX - start.px) / size.w;
        const dyFrac = (ev.clientY - start.py) / size.h;
        if (opts.onResize && opts.onResize(dxFrac, dyFrac, start) === false) {
          // custom handler did the work
        } else if (opts.aspect) {
          // aspect-locked: drive by the larger relative delta
          let fw = clamp(start.fw + dxFrac, minFw, 2);
          model.fw = fw;
          model.fh = fw / opts.aspect;
        } else {
          model.fw = clamp(start.fw + dxFrac, minFw, 2);
          model.fh = clamp(start.fh + dyFrac, minFh, 2);
        }
        opts.onChange && opts.onChange();
      };
      const up = (ev) => {
        opts.handle.releasePointerCapture(ev.pointerId);
        opts.handle.removeEventListener('pointermove', move);
        opts.handle.removeEventListener('pointerup', up);
        opts.handle.removeEventListener('pointercancel', up);
      };
      opts.handle.addEventListener('pointermove', move);
      opts.handle.addEventListener('pointerup', up);
      opts.handle.addEventListener('pointercancel', up);
    }

    node.addEventListener('pointerdown', onBodyDown);
    if (opts.handle) opts.handle.addEventListener('pointerdown', onHandleDown);
  }

  PFS.attachDragResize = attachDragResize;
  PFS.clamp = clamp;
})(window);
