/* inpaint.js — content-aware fill for "erase this bit of the form" covers.
 *
 * A flat colour never truly disappears on a real document: scans have grain and
 * a slight tone, table cells are tinted, and backgrounds drift across the page.
 * At screen zoom a flat patch looks fine, but at export resolution it reads as
 * an obvious rectangle — the "you can see this was edited" giveaway.
 *
 * Reconstructing the paper needs two things that a naive blur gets wrong:
 *
 *  1. PAPER ONLY. The ring we sample from usually clips the ink we are trying
 *     to erase, or the cell border the box was dragged across. Averaging that
 *     in smears grey bruises into the patch. So the ring is split into paper
 *     and ink by a luminance threshold derived from the ring itself, and only
 *     paper pixels feed the interpolation.
 *
 *  2. STRUCTURE SURVIVES. Forms are made of boxes and rule lines, and people
 *     drag the cover straight across them. Erasing a cell border leaves a
 *     mutilated box, which advertises the edit louder than the original value
 *     did. A line that enters one edge of the region and leaves the opposite
 *     edge at the same offset is continued across the patch, so the form's own
 *     ruling stays intact while its contents disappear.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const clampi = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
  const lumOf = (r, g, b) => (r * 0.299 + g * 0.587 + b * 0.114);

  // median along a line of RGB triples — smooths sensor noise without blurring
  // a genuine gradient
  function medianSmooth(arr, len, win) {
    if (win < 3) return arr;
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

    const ring = Math.max(3, Math.min(10, opts.ring || Math.round(Math.min(w, h) * 0.3) || 3));
    const grab = (gx, gy, gw, gh) => {
      const cx = clampi(gx, 0, src.width - 1), cy = clampi(gy, 0, src.height - 1);
      const cw = clampi(gw - (cx - gx), 1, src.width - cx);
      const chh = clampi(gh - (cy - gy), 1, src.height - cy);
      try { return { d: sctx.getImageData(cx, cy, cw, chh).data, gw: cw, gh: chh, ox: cx - gx, oy: cy - gy }; } catch (e) { return null; }
    };

    const tBand = grab(x, y - ring, w, ring);
    const bBand = grab(x, y + h, w, ring);
    const lBand = grab(x - ring, y, ring, h);
    const rBand = grab(x + w, y, ring, h);
    if (!tBand && !bBand && !lBand && !rBand) return null;

    // ---- pass 1: what is paper here, and what is ink? ----
    const allLum = [];
    const scan = (band) => {
      if (!band) return;
      const { d } = band;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        allLum.push(lumOf(d[i], d[i + 1], d[i + 2]));
      }
    };
    scan(tBand); scan(bBand); scan(lBand); scan(rBand);
    if (!allLum.length) return null;
    allLum.sort((a, b) => a - b);
    const q = (p) => allLum[clampi(Math.floor(allLum.length * p), 0, allLum.length - 1)];
    const paperLum = q(0.75);                 // paper dominates the light end
    const darkLum = q(0.02);
    // anything this much darker than paper is ink (a glyph or a rule line)
    const inkCut = paperLum - Math.max(26, (paperLum - darkLum) * 0.35);

    // per-position: the average of PAPER pixels, and the darkest pixel (ink probe)
    const mkArrays = (len) => ({
      paper: new Float32Array(len * 3),
      hasPaper: new Uint8Array(len),
      inkLum: new Float32Array(len),
      ink: new Float32Array(len * 3)
    });
    const T = mkArrays(w), B = mkArrays(w), L = mkArrays(h), R = mkArrays(h);

    let gpr = 0, gpg = 0, gpb = 0, gpn = 0, gsum = 0, gsum2 = 0;
    // Walk a band. `axis` 0 → positions run along x (top/bottom), 1 → along y.
    // `innerLast` says which end of the ring's thickness touches the region.
    //
    // Paper tone is averaged over the WHOLE ring (more samples, less noise), but
    // the ink probe that detects crossing rules only looks at the few pixels
    // immediately adjacent. Probing the full ring would catch the cell's OTHER
    // borders running parallel a few pixels away, making every row look like a
    // line — the whole span then reads as a block and no rule is restored.
    const probeDepth = 3;
    const walk = (band, out, len, axis, innerLast) => {
      if (!band) return;
      const { d, gw, gh, ox, oy } = band;
      const steps = axis ? gw : gh;           // thickness of the ring
      for (let p = 0; p < len; p++) {
        let r = 0, g = 0, b = 0, n = 0, minL = 1e9, mr = 0, mg = 0, mb = 0;
        for (let k = 0; k < steps; k++) {
          const px = axis ? k : (p - ox), py = axis ? (p - oy) : k;
          if (px < 0 || py < 0 || px >= gw || py >= gh) continue;
          const o = (py * gw + px) * 4;
          if (d[o + 3] < 8) continue;
          const lu = lumOf(d[o], d[o + 1], d[o + 2]);
          const depth = innerLast ? (steps - 1 - k) : k;   // distance from the region
          if (depth < probeDepth && lu < minL) { minL = lu; mr = d[o]; mg = d[o + 1]; mb = d[o + 2]; }
          if (lu > inkCut) {                  // paper — feeds the interpolation
            r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
            gpr += d[o]; gpg += d[o + 1]; gpb += d[o + 2]; gpn++;
            gsum += lu; gsum2 += lu * lu;
          }
        }
        if (n) { out.paper[p * 3] = r / n; out.paper[p * 3 + 1] = g / n; out.paper[p * 3 + 2] = b / n; out.hasPaper[p] = 1; }
        out.inkLum[p] = minL === 1e9 ? 255 : minL;
        out.ink[p * 3] = mr; out.ink[p * 3 + 1] = mg; out.ink[p * 3 + 2] = mb;
      }
    };
    // top/left bands run up to the region (inner edge last); bottom/right start at it
    walk(tBand, T, w, 0, true); walk(bBand, B, w, 0, false);
    walk(lBand, L, h, 1, true); walk(rBand, R, h, 1, false);

    if (!gpn) return null;                    // nothing but ink around — bail out
    const paperRGB = [gpr / gpn, gpg / gpn, gpb / gpn];

    // positions whose whole ring was ink (e.g. a thick rule) borrow the global
    // paper tone, so a line never drags the fill dark
    const fillGaps = (o, len) => {
      for (let p = 0; p < len; p++) {
        if (o.hasPaper[p]) continue;
        o.paper[p * 3] = paperRGB[0]; o.paper[p * 3 + 1] = paperRGB[1]; o.paper[p * 3 + 2] = paperRGB[2];
      }
    };
    fillGaps(T, w); fillGaps(B, w); fillGaps(L, h); fillGaps(R, h);

    // a side that fell outside the canvas mirrors its opposite
    const copyInto = (from, to, len) => { for (let i = 0; i < len * 3; i++) to.paper[i] = from.paper[i]; };
    if (!tBand && bBand) copyInto(B, T, w); if (!bBand && tBand) copyInto(T, B, w);
    if (!lBand && rBand) copyInto(R, L, h); if (!rBand && lBand) copyInto(L, R, h);
    if (!tBand && !bBand) for (let i = 0; i < w; i++) for (let c = 0; c < 3; c++) { T.paper[i * 3 + c] = paperRGB[c]; B.paper[i * 3 + c] = paperRGB[c]; }
    if (!lBand && !rBand) for (let j = 0; j < h; j++) for (let c = 0; c < 3; c++) { L.paper[j * 3 + c] = paperRGB[c]; R.paper[j * 3 + c] = paperRGB[c]; }

    const Tp = medianSmooth(T.paper, w, Math.min(9, Math.max(3, ((w >> 3) | 1))));
    const Bp = medianSmooth(B.paper, w, Math.min(9, Math.max(3, ((w >> 3) | 1))));
    const Lp = medianSmooth(L.paper, h, Math.min(9, Math.max(3, ((h >> 3) | 1))));
    const Rp = medianSmooth(R.paper, h, Math.min(9, Math.max(3, ((h >> 3) | 1))));

    // ---- pass 2: paper fill, interpolated from all four sides ----
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d');
    const img = octx.createImageData(w, h);

    let sigma = 0;
    if (gpn > 8) {
      const mean = gsum / gpn;
      sigma = Math.sqrt(Math.max(0, gsum2 / gpn - mean * mean));
    }
    const grain = Math.min(sigma, 7) * (opts.grain != null ? opts.grain : 1);
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
          const v = (Tp[i * 3 + c] * wT + Bp[i * 3 + c] * wB + Lp[j * 3 + c] * wL + Rp[j * 3 + c] * wR) / wsum;
          img.data[o + c] = clampi(Math.round(v + n), 0, 255);
        }
        img.data[o + 3] = 255;
      }
    }

    // ---- pass 3: carry structural lines straight through the patch ----
    // A rule that enters one side and leaves the opposite side at the same
    // offset is part of the form, not the value being erased — redraw it so the
    // cell/underline stays whole.
    const runsOf = (mask, len) => {                // contiguous line bands
      const runs = []; let s = -1;
      for (let p = 0; p <= len; p++) {
        if (p < len && mask[p]) { if (s < 0) s = p; }
        else if (s >= 0) { runs.push([s, p - 1]); s = -1; }
      }
      return runs;
    };
    const maxBand = (n) => Math.max(3, Math.round(n * 0.22));  // a rule, not a block

    // horizontal rules: dark on the left AND right edge at the same row
    const rowMask = new Uint8Array(h);
    for (let j = 0; j < h; j++) rowMask[j] = (L.inkLum[j] < inkCut && R.inkLum[j] < inkCut) ? 1 : 0;
    runsOf(rowMask, h).forEach(([a, b]) => {
      if (b - a + 1 > maxBand(h)) return;
      for (let j = a; j <= b; j++) {
        for (let i = 0; i < w; i++) {
          const o = (j * w + i) * 4;
          // blend the two ends across the span so a slightly uneven scan matches
          const t = w > 1 ? i / (w - 1) : 0;
          for (let c = 0; c < 3; c++) {
            img.data[o + c] = clampi(Math.round(L.ink[j * 3 + c] * (1 - t) + R.ink[j * 3 + c] * t), 0, 255);
          }
        }
      }
    });
    // vertical rules: dark on the top AND bottom edge at the same column
    const colMask = new Uint8Array(w);
    for (let i = 0; i < w; i++) colMask[i] = (T.inkLum[i] < inkCut && B.inkLum[i] < inkCut) ? 1 : 0;
    runsOf(colMask, w).forEach(([a, b]) => {
      if (b - a + 1 > maxBand(w)) return;
      for (let i = a; i <= b; i++) {
        for (let j = 0; j < h; j++) {
          const o = (j * w + i) * 4;
          const t = h > 1 ? j / (h - 1) : 0;
          for (let c = 0; c < 3; c++) {
            img.data[o + c] = clampi(Math.round(T.ink[i * 3 + c] * (1 - t) + B.ink[i * 3 + c] * t), 0, 255);
          }
        }
      }
    });

    octx.putImageData(img, 0, 0);
    return out;
  }

  PFS.inpaint = { patch };
})(window);
