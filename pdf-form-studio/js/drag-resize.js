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

  /* computeSnap(rect, targets, thx, thy) — pure alignment math.
   * Given the dragged rect {fx,fy,fw,fh} and peer rects (all page fractions),
   * find the nearest left/center/right (and top/middle/bottom) alignment within
   * the pixel-derived thresholds thx/thy, plus the page's own 0/½/1 guides.
   * Returns the snapped {fx,fy} and the guide lines that fired (or null).
   */
  function computeSnap(rect, targets, thx, thy) {
    const { fx, fy, fw, fh } = rect;
    const xs = [0, 0.5, 1], ys = [0, 0.5, 1];   // page edges + center
    (targets || []).forEach((t) => {
      xs.push(t.fx, t.fx + t.fw / 2, t.fx + t.fw);
      ys.push(t.fy, t.fy + t.fh / 2, t.fy + t.fh);
    });
    const offX = { left: 0, center: fw / 2, right: fw };
    const offY = { top: 0, mid: fh / 2, bottom: fh };
    let bx = thx, nfx = fx, gx = null;
    for (const k in offX) { const line = fx + offX[k]; for (const tx of xs) { const d = Math.abs(line - tx); if (d < bx) { bx = d; nfx = tx - offX[k]; gx = tx; } } }
    let by = thy, nfy = fy, gy = null;
    for (const k in offY) { const line = fy + offY[k]; for (const ty of ys) { const d = Math.abs(line - ty); if (d < by) { by = d; nfy = ty - offY[k]; gy = ty; } } }
    return { fx: nfx, fy: nfy, guideX: gx, guideY: gy };
  }
  const SNAP_PX = 6;   // snap when an edge is within this many screen pixels

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

    // ---- alignment guides (thin accent lines while a snap is active) ----
    let guideEls = [];
    function clearGuides() { guideEls.forEach((el) => el.remove()); guideEls = []; }
    function drawGuides(gx, gy) {
      clearGuides();
      const mk = (css) => { const el = document.createElement('div'); el.className = 'snap-guide'; el.style.cssText = 'position:absolute;background:var(--accent,#e8a33d);pointer-events:none;z-index:60;' + css; overlayEl.appendChild(el); guideEls.push(el); };
      if (gx != null) mk('top:0;bottom:0;width:1px;left:' + (gx * 100) + '%;');
      if (gy != null) mk('left:0;right:0;height:1px;top:' + (gy * 100) + '%;');
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
        // alignment snapping (hold Alt to drag freely). Guides show what lined up.
        if (opts.getSnapTargets && !ev.altKey) {
          const s = computeSnap(model, opts.getSnapTargets(), SNAP_PX / size.w, SNAP_PX / size.h);
          model.fx = clamp(s.fx, -model.fw * 0.5, 1 - model.fw * 0.5);
          model.fy = clamp(s.fy, -model.fh * 0.5, 1 - model.fh * 0.5);
          drawGuides(s.guideX, s.guideY);
        }
        opts.onChange && opts.onChange();
      };
      const up = (ev) => {
        clearGuides();
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
  PFS.computeSnap = computeSnap;
  PFS.clamp = clamp;
})(window);
