/* align.js — pure alignment + distribution math for a set of overlay elements.
 * Every function takes an array of rects { id, fx, fy, fw, fh } (page fractions)
 * and returns a map id → { fx, fy } with the new top-left for each rect. Only
 * positions change (never sizes), so callers just assign fx/fy and re-layout.
 * No DOM, no state — trivially testable and reused by the overlay's toolbar.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const move = (rects, fn) => {
    const out = {};
    rects.forEach((r) => { out[r.id] = fn(r); });
    return out;
  };

  function left(rects)   { const v = Math.min(...rects.map((r) => r.fx));                 return move(rects, (r) => ({ fx: v, fy: r.fy })); }
  function right(rects)  { const v = Math.max(...rects.map((r) => r.fx + r.fw));           return move(rects, (r) => ({ fx: v - r.fw, fy: r.fy })); }
  function top(rects)    { const v = Math.min(...rects.map((r) => r.fy));                 return move(rects, (r) => ({ fx: r.fx, fy: v })); }
  function bottom(rects) { const v = Math.max(...rects.map((r) => r.fy + r.fh));           return move(rects, (r) => ({ fx: r.fx, fy: v - r.fh })); }
  // center on the average center, so the group stays put overall
  function centerX(rects) { const c = avg(rects.map((r) => r.fx + r.fw / 2)); return move(rects, (r) => ({ fx: c - r.fw / 2, fy: r.fy })); }
  function centerY(rects) { const c = avg(rects.map((r) => r.fy + r.fh / 2)); return move(rects, (r) => ({ fx: r.fx, fy: c - r.fh / 2 })); }
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

  // distribute: keep the two extreme elements, space the rest so centers are
  // evenly spread. <3 elements → nothing to distribute (returns them unchanged).
  function distributeH(rects) { return distribute(rects, 'fx', 'fw'); }
  function distributeV(rects) { return distribute(rects, 'fy', 'fh'); }
  function distribute(rects, p, s) {
    const out = {}; rects.forEach((r) => { out[r.id] = { fx: r.fx, fy: r.fy }; });
    if (rects.length < 3) return out;
    const sorted = [...rects].sort((a, b) => (a[p] + a[s] / 2) - (b[p] + b[s] / 2));
    const first = sorted[0], last = sorted[sorted.length - 1];
    const c0 = first[p] + first[s] / 2, c1 = last[p] + last[s] / 2;
    const step = (c1 - c0) / (sorted.length - 1);
    sorted.forEach((r, i) => {
      const center = c0 + step * i;
      const np = center - r[s] / 2;
      out[r.id] = p === 'fx' ? { fx: np, fy: r.fy } : { fx: r.fx, fy: np };
    });
    return out;
  }

  PFS.align = { left, right, top, bottom, centerX, centerY, distributeH, distributeV };
})(window);
