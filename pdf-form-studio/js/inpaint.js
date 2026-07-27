/* inpaint.js — content-aware fill for "erase this bit of the form" covers.
 *
 * A flat colour never truly disappears on a real document: scans have grain and
 * a slight tone, table cells are tinted, and backgrounds drift across the page.
 * At screen zoom a flat patch looks fine, but at export resolution it reads as
 * an obvious white rectangle — the "you can see this was edited" giveaway.
 *
 * So instead of painting a colour, reconstruct what the paper looked like:
 * sample a ring of pixels just OUTSIDE the region and interpolate them inward
 * (inverse-distance from all four sides — a Coons-style fill), which reproduces
 * the surrounding tone, colour and any gradient. Ink strokes that happen to
 * cross the ring are suppressed with a median filter along each edge, and the
 * grain of the surroundings is re-applied so the patch doesn't read as a
 * suspiciously smooth blank against a noisy scan.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const clampi = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));

  // median of a small window along a border line — kills thin ink strokes that
  // cross the sampling ring without flattening a real gradient
  function medianSmooth(arr, len, win) {
    const out = new Float32Array(len * 3);
    const half = win >> 1;
    const bucket = [];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < len; i++) {
        bucket.length = 0;
        for (let k = -half; k <= half; k++) bucket.push(arr[clampi(i + k, 0, len - 1) * 3 + c]);
        bucket.sort((a, b) => a - b);
        out[i * 3 + c] = bucket[half];
      }
    }
    return out;
  }

  /* patch(src, x, y, w, h, opts) → canvas (w×h) reconstructing the background.
   *   src : source canvas (the page rendered at the SAME scale as the caller's
   *         coordinate space), x/y/w/h in that canvas's pixels.
   *   opts.ring  : how far outside to sample (px, default scales with size)
   *   opts.grain : 0..1 amount of surrounding noise to re-apply (default 1)
   * Returns null when the region is degenerate or nothing can be sampled.
   */
  function patch(src, x, y, w, h, opts) {
    opts = opts || {};
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    x = Math.round(x); y = Math.round(y);
    if (!src || !src.width || !src.height) return null;

    let sctx;
    try { sctx = src.getContext('2d'); } catch (e) { return null; }
    if (!sctx) return null;

    // thickness of the band we average per side — a few px so grain averages out
    const ring = Math.max(2, Math.min(8, opts.ring || Math.round(Math.min(w, h) * 0.25) || 2));
    const grab = (gx, gy, gw, gh) => {
      gx = clampi(gx, 0, src.width - 1); gy = clampi(gy, 0, src.height - 1);
      gw = clampi(gw, 1, src.width - gx); gh = clampi(gh, 1, src.height - gy);
      try { return { d: sctx.getImageData(gx, gy, gw, gh), gw, gh }; } catch (e) { return null; }
    };

    // ---- collect the four border lines (averaged across the ring thickness) ----
    const top = new Float32Array(w * 3), bot = new Float32Array(w * 3);
    const left = new Float32Array(h * 3), right = new Float32Array(h * 3);
    const stats = { n: 0, sum: 0, sum2: 0 };

    const tBand = grab(x, y - ring, w, ring);
    const bBand = grab(x, y + h, w, ring);
    const lBand = grab(x - ring, y, ring, h);
    const rBand = grab(x + w, y, ring, h);
    if (!tBand && !bBand && !lBand && !rBand) return null;

    // vertical bands (top/bottom): average down each column
    const fillH = (band, out, len) => {
      if (!band) return false;
      const { d, gw, gh } = band;
      for (let i = 0; i < len; i++) {
        const col = clampi(i, 0, gw - 1);
        let r = 0, g = 0, b = 0, n = 0;
        for (let j = 0; j < gh; j++) {
          const o = (j * gw + col) * 4;
          if (d.data[o + 3] < 8) continue;
          r += d.data[o]; g += d.data[o + 1]; b += d.data[o + 2]; n++;
          const lum = (d.data[o] + d.data[o + 1] + d.data[o + 2]) / 3;
          stats.n++; stats.sum += lum; stats.sum2 += lum * lum;
        }
        if (!n) { n = 1; r = g = b = 255; }
        out[i * 3] = r / n; out[i * 3 + 1] = g / n; out[i * 3 + 2] = b / n;
      }
      return true;
    };
    // horizontal bands (left/right): average across each row
    const fillV = (band, out, len) => {
      if (!band) return false;
      const { d, gw, gh } = band;
      for (let j = 0; j < len; j++) {
        const row = clampi(j, 0, gh - 1);
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < gw; i++) {
          const o = (row * gw + i) * 4;
          if (d.data[o + 3] < 8) continue;
          r += d.data[o]; g += d.data[o + 1]; b += d.data[o + 2]; n++;
          const lum = (d.data[o] + d.data[o + 1] + d.data[o + 2]) / 3;
          stats.n++; stats.sum += lum; stats.sum2 += lum * lum;
        }
        if (!n) { n = 1; r = g = b = 255; }
        out[j * 3] = r / n; out[j * 3 + 1] = g / n; out[j * 3 + 2] = b / n;
      }
      return true;
    };

    const hasT = fillH(tBand, top, w), hasB = fillH(bBand, bot, w);
    const hasL = fillV(lBand, left, h), hasR = fillV(rBand, right, h);

    // a side that fell outside the canvas mirrors its opposite, so the blend
    // stays balanced instead of dragging toward an arbitrary default
    const mirrorH = (src2, dst) => { for (let i = 0; i < w * 3; i++) dst[i] = src2[i]; };
    const mirrorV = (src2, dst) => { for (let i = 0; i < h * 3; i++) dst[i] = src2[i]; };
    if (!hasT && hasB) mirrorH(bot, top); if (!hasB && hasT) mirrorH(top, bot);
    if (!hasL && hasR) mirrorV(right, left); if (!hasR && hasL) mirrorV(left, right);
    if (!hasT && !hasB) {
      // no horizontal bands at all — derive them from the vertical ones
      for (let i = 0; i < w; i++) for (let c = 0; c < 3; c++) { top[i * 3 + c] = left[c]; bot[i * 3 + c] = left[c]; }
    }
    if (!hasL && !hasR) {
      for (let j = 0; j < h; j++) for (let c = 0; c < 3; c++) { left[j * 3 + c] = top[c]; right[j * 3 + c] = top[c]; }
    }

    const mw = Math.min(9, Math.max(3, (w >> 3) | 1));
    const mh = Math.min(9, Math.max(3, (h >> 3) | 1));
    const T = medianSmooth(top, w, mw), B = medianSmooth(bot, w, mw);
    const L = medianSmooth(left, h, mh), R = medianSmooth(right, h, mh);

    // ---- inverse-distance blend of the four edges ----
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const img = octx.createImageData(w, h);

    // grain: re-apply the surroundings' noise so the patch isn't unnaturally flat
    let sigma = 0;
    if (stats.n > 8) {
      const mean = stats.sum / stats.n;
      sigma = Math.sqrt(Math.max(0, stats.sum2 / stats.n - mean * mean));
    }
    const grain = Math.min(sigma, 9) * (opts.grain != null ? opts.grain : 1);
    // deterministic pseudo-noise — same input always yields the same patch, so
    // a re-export is byte-comparable and tests stay stable
    let seed = 0x2f6e2b1 ^ (w * 73856093) ^ (h * 19349663);
    const rnd = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

    for (let j = 0; j < h; j++) {
      const dT = j + 1, dB = h - j;
      for (let i = 0; i < w; i++) {
        const dL = i + 1, dR = w - i;
        const wT = 1 / (dT * dT), wB = 1 / (dB * dB), wL = 1 / (dL * dL), wR = 1 / (dR * dR);
        const wsum = wT + wB + wL + wR;
        const o = (j * w + i) * 4;
        const n = grain ? rnd() * grain : 0;
        for (let c = 0; c < 3; c++) {
          const v = (T[i * 3 + c] * wT + B[i * 3 + c] * wB + L[j * 3 + c] * wL + R[j * 3 + c] * wR) / wsum;
          img.data[o + c] = clampi(Math.round(v + n), 0, 255);
        }
        img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  PFS.inpaint = { patch };
})(window);
