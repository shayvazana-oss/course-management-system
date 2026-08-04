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
      if (!band) return null;
      const { d } = band;
      const own = [];
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        const lu = lumOf(d[i], d[i + 1], d[i + 2]);
        allLum.push(lu); own.push(lu);
      }
      if (!own.length) return null;
      own.sort((a, b) => a - b);
      return own[own.length >> 1];              // this band's median tone
    };
    const medT = scan(tBand), medB = scan(bBand), medL = scan(lBand), medR = scan(rBand);
    if (!allLum.length) return null;
    allLum.sort((a, b) => a - b);
    const q = (p) => allLum[clampi(Math.floor(allLum.length * p), 0, allLum.length - 1)];
    // The background is the MAJORITY tone, not the light tone. Classic paper is
    // light-with-dark-ink, but a dark banner carries LIGHT text — assuming
    // "paper is bright" filled those covers with the white of the letters and
    // stamped a glowing patch on the dark area. Median = background either way;
    // content is whatever sits far from it, in either direction.
    const bgLum = q(0.5);
    const spread = Math.max(1, q(0.9) - q(0.1));
    const tol = Math.max(26, spread * 0.35);
    const isBg = (lu) => Math.abs(lu - bgLum) < tol;

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
        let r = 0, g = 0, b = 0, n = 0, bestD = -1, mr = 0, mg = 0, mb = 0;
        for (let k = 0; k < steps; k++) {
          const px = axis ? k : (p - ox), py = axis ? (p - oy) : k;
          if (px < 0 || py < 0 || px >= gw || py >= gh) continue;
          const o = (py * gw + px) * 4;
          if (d[o + 3] < 8) continue;
          const lu = lumOf(d[o], d[o + 1], d[o + 2]);
          const depth = innerLast ? (steps - 1 - k) : k;   // distance from the region
          // content probe: the pixel most DISTANT from the background tone —
          // dark ink on paper, light lettering on a dark banner, either way
          const dist = Math.abs(lu - bgLum);
          if (depth < probeDepth && dist > bestD) { bestD = dist; mr = d[o]; mg = d[o + 1]; mb = d[o + 2]; }
          if (isBg(lu)) {                     // background — feeds the interpolation
            r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
            gpr += d[o]; gpg += d[o + 1]; gpb += d[o + 2]; gpn++;
            gsum += lu; gsum2 += lu * lu;
          }
        }
        if (n) { out.paper[p * 3] = r / n; out.paper[p * 3 + 1] = g / n; out.paper[p * 3 + 2] = b / n; out.hasPaper[p] = 1; }
        out.inkLum[p] = bestD < 0 ? 0 : bestD;   // now a DISTANCE from background
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

    // ---- textured background (photo, artwork): reconstruct TEXTURE ----
    // Two triggers, two failure modes of a smooth fill:
    //  - CROSSING: opposite edge bands disagree strongly (the cover straddles a
    //    photo↔paper boundary). One whole side then classifies as "content",
    //    and the smooth fill flooded the strip with the other side's tone —
    //    the grey smear band on the exported flyer.
    //  - TEXTURE: sigma (spread of background pixels alone) is high — a photo,
    //    where an interpolated fill reads as a plastic smudge and the rule
    //    carrier streaks the patch.
    // Both fill by mirroring real pixel strips inward instead. A crossing keeps
    // each side pure and confines the blend to the middle third.
    const dV = (medT != null && medB != null) ? Math.abs(medT - medB) : 0;
    const dH = (medL != null && medR != null) ? Math.abs(medL - medR) : 0;
    const crossing = Math.max(dV, dH) > 45;
    if (opts.debug) Object.assign(opts.debug, { medT, medB, medL, medR, dV, dH, crossing, sigma, bgLum, tol, w, h });
    if (crossing || sigma > 10) {
      const vertical = crossing ? dV >= dH : w >= h;
      const nearBand = vertical ? tBand : lBand;
      const farBand = vertical ? bBand : rBand;
      if (nearBand || farBand) {
        const thick = (band) => band ? (vertical ? band.gh : band.gw) : 0;
        const reflect = (k, n) => {
          if (n <= 1) return 0;
          const m = k % (2 * n);
          return m < n ? m : (2 * n - 1 - m);
        };
        const px = (band, alongPos, depth) => {   // depth 0 = touching the region
          const n = thick(band);
          const dpt = reflect(depth, n);
          let bx, by;
          if (vertical) {
            bx = clampi(alongPos - band.ox, 0, band.gw - 1);
            by = band === tBand ? clampi(band.gh - 1 - dpt, 0, band.gh - 1) : clampi(dpt, 0, band.gh - 1);
          } else {
            by = clampi(alongPos - band.oy, 0, band.gh - 1);
            bx = band === lBand ? clampi(band.gw - 1 - dpt, 0, band.gw - 1) : clampi(dpt, 0, band.gw - 1);
          }
          return (by * band.gw + bx) * 4;
        };
        const span = vertical ? h : w, breadth = vertical ? w : h;
        // Across a boundary, find the ACTUAL boundary offset from the side
        // bands (they cross the same edge) and cut there, sharp with a 2px
        // feather — a centred blend leaves a soft smoke edge the eye catches.
        let boundary = -1;
        if (crossing) {
          const mid = vertical ? (medT + medB) / 2 : (medL + medR) / 2;
          const firstIsDark = (vertical ? medT : medL) < mid;
          const prof = new Float32Array(span), cnt = new Float32Array(span);
          const addProf = (band) => {
            if (!band) return;
            const { d, gw, gh } = band;
            for (let yy = 0; yy < gh; yy++) for (let xx = 0; xx < gw; xx++) {
              const o = (yy * gw + xx) * 4;
              if (d[o + 3] < 8) continue;
              const pos = vertical ? (yy + band.oy) : (xx + band.ox);
              if (pos < 0 || pos >= span) continue;
              prof[pos] += lumOf(d[o], d[o + 1], d[o + 2]); cnt[pos]++;
            }
          };
          addProf(vertical ? lBand : tBand); addProf(vertical ? rBand : bBand);
          // best step split: maximise (first-tone before b) + (second-tone after b)
          const preF = new Int32Array(span + 1), preS = new Int32Array(span + 1);
          for (let s2 = 0; s2 < span; s2++) {
            let f = 0, sec = 0;
            if (cnt[s2]) {
              const lu = prof[s2] / cnt[s2];
              const isFirst = firstIsDark ? (lu < mid) : (lu > mid);
              if (isFirst) f = 1; else sec = 1;
            }
            preF[s2 + 1] = preF[s2] + f; preS[s2 + 1] = preS[s2] + sec;
          }
          let best = -1;
          for (let b2 = 0; b2 <= span; b2++) {
            const score = preF[b2] + (preS[span] - preS[b2]);
            if (score > best) { best = score; boundary = b2; }
          }
        }
        for (let s = 0; s < span; s++) {
          let t = (s + 0.5) / span;             // blend factor near→far
          if (crossing) {
            t = boundary >= 0
              ? (s < boundary - 1 ? 0 : s > boundary ? 1 : 0.5)   // sharp cut + 2px feather
              : (t < 0.35 ? 0 : t > 0.65 ? 1 : (t - 0.35) / 0.3); // sides unreadable → middle hand-off
          }
          const jitterN = nearBand ? Math.round(rnd() * 4) : 0;
          const jitterF = farBand ? Math.round(rnd() * 4) : 0;
          for (let p = 0; p < breadth; p++) {
            const o = vertical ? ((s * w + p) * 4) : ((p * w + s) * 4);
            for (let c = 0; c < 3; c++) {
              let vNear = null, vFar = null;
              if (nearBand) vNear = nearBand.d[px(nearBand, p + jitterN, s) + c];
              if (farBand) vFar = farBand.d[px(farBand, p + jitterF, span - 1 - s) + c];
              const v = vNear == null ? vFar : vFar == null ? vNear : vNear * (1 - t) + vFar * t;
              img.data[o + c] = clampi(Math.round(v), 0, 255);
            }
            img.data[o + 3] = 255;
          }
        }
        octx.putImageData(img, 0, 0);
        return out;                              // no rule-carrying on texture
      }
    }

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

    // horizontal rules: strong content on the left AND right edge at the same
    // row (inkLum now measures distance from the background tone). A genuine
    // rule shows the SAME colour at both ends; and if half the rows look like
    // "lines", that's texture bleeding through the detector — carry nothing.
    const sameInk = (A, B, p) => (Math.abs(A.ink[p * 3] - B.ink[p * 3]) + Math.abs(A.ink[p * 3 + 1] - B.ink[p * 3 + 1]) + Math.abs(A.ink[p * 3 + 2] - B.ink[p * 3 + 2])) < 160;
    const rowMask = new Uint8Array(h);
    let rowsOn = 0;
    for (let j = 0; j < h; j++) { rowMask[j] = (L.inkLum[j] > tol && R.inkLum[j] > tol && sameInk(L, R, j)) ? 1 : 0; rowsOn += rowMask[j]; }
    if (rowsOn > h * 0.5) rowMask.fill(0);
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
    // vertical rules: strong content on the top AND bottom edge at the same column
    const colMask = new Uint8Array(w);
    let colsOn = 0;
    for (let i = 0; i < w; i++) { colMask[i] = (T.inkLum[i] > tol && B.inkLum[i] > tol && sameInk(T, B, i)) ? 1 : 0; colsOn += colMask[i]; }
    if (colsOn > w * 0.5) colMask.fill(0);
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
