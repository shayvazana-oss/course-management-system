/* certmatch.js — print a certificate's name and ID in the certificate's OWN typeface.
 *
 * A certificate designed in Canva or Word arrives with its own lettering
 * ("וזאת לתעודה", "סיימה בהצלחה"). A name printed beside it in some other
 * face reads as a sticker. This module finds out which face the format was
 * set in and returns it as a CSS family plus weight.
 *
 * It tries three sources, from the cheapest to the most general:
 *   1. the embedded font NAME in the PDF ("ABCDEF+SuezOne-Regular"). This is
 *      exact whenever the face is one Fillo carries.
 *   2. the PDF's text layer, used for its strings and positions: each run is
 *      cropped from the rendered page and compared by SHAPE with the same
 *      string drawn in every candidate face and weight.
 *   3. OCR words (served build), for formats that are flat images, with the
 *      same shape comparison.
 *
 * The shape score is a Pearson correlation of the two blurred ink maps,
 * both normalised to the sample's box, discounted by how far the
 * candidate's natural aspect ratio is from the sample's. Width and stroke
 * weight separate the faces even before the letterforms do.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  // every face Fillo carries (vendor/fonts), with the weights it really has
  const CANDIDATES = [
    { family: 'Frank Ruhl Libre', weights: [300, 400, 500, 700, 900], generic: 'serif' },
    { family: 'David Libre', weights: [400, 700], generic: 'serif' },
    { family: 'Noto Serif Hebrew', weights: [300, 400, 600, 800], generic: 'serif' },
    { family: 'Suez One', weights: [400], generic: 'serif' },
    { family: 'Bellefair', weights: [400], generic: 'serif' },
    { family: 'Bona Nova', weights: [400, 700], generic: 'serif' },
    { family: 'Tinos', weights: [400, 700], generic: 'serif' },
    { family: 'Heebo', weights: [400, 700], generic: 'sans-serif' },
    { family: 'Rubik', weights: [300, 400, 500, 700, 900], generic: 'sans-serif' },
    { family: 'Assistant', weights: [300, 400, 600, 800], generic: 'sans-serif' },
    { family: 'Secular One', weights: [400], generic: 'sans-serif' },
    { family: 'Alef', weights: [400, 700], generic: 'sans-serif' },
    { family: 'Miriam Libre', weights: [400, 700], generic: 'sans-serif' },
    { family: 'Arimo', weights: [400, 700], generic: 'sans-serif' },
    { family: 'Varela Round', weights: [400], generic: 'sans-serif' },
    { family: 'IBM Plex Sans Hebrew', weights: [400, 700], generic: 'sans-serif' },
    { family: 'Noto Sans Hebrew', weights: [300, 400, 600, 800], generic: 'sans-serif' },
    { family: 'Karantina', weights: [400, 700], generic: 'sans-serif' },
    { family: 'Amatic SC', weights: [400, 700], generic: 'cursive' }
  ];
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byFamily = (f) => CANDIDATES.find((c) => c.family === f);

  // a family as the CSS stack every field gets: the face, then a relative
  function cssFor(family) {
    const c = byFamily(family);
    const backup = c && c.generic === 'serif' ? "'Frank Ruhl Libre', serif" : "'Heebo', sans-serif";
    return "'" + family + "', " + backup;
  }
  // the weight the face really has that is closest to the one asked for
  function nearestWeight(family, w) {
    const c = byFamily(family);
    if (!c) return w;
    return c.weights.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a), c.weights[0]);
  }

  // ---- 1. embedded font names ----
  // system faces a certificate may name that Fillo prints with a near twin
  const ALIASES = [
    [/frankru(e)?hl/, 'Frank Ruhl Libre'], [/^david/, 'David Libre'],
    [/^miriam/, 'Miriam Libre'], [/^timesnewroman|^times/, 'Tinos'],
    [/^arial|^helvetica|^liberationsans/, 'Arimo'], [/^ibmplexsanshebrew/, 'IBM Plex Sans Hebrew']
  ];
  function weightFromName(n) {
    if (/extrabold|ultrabold|heavy|black/.test(n)) return /black|heavy/.test(n) ? 900 : 800;
    if (/semibold|demibold/.test(n)) return 600;
    if (/bold/.test(n)) return 700;
    if (/medium/.test(n)) return 500;
    if (/extralight|ultralight|thin/.test(n)) return 200;
    if (/light/.test(n)) return 300;
    return 400;
  }
  function familyFromName(raw) {
    const n = norm(String(raw || '').replace(/^[A-Z]{6}\+/, ''));
    if (!n) return null;
    // longest family name first, so "notoserifhebrew" never reads as "noto…"
    const sorted = CANDIDATES.slice().sort((a, b) => norm(b.family).length - norm(a.family).length);
    for (const c of sorted) if (n.startsWith(norm(c.family))) return { family: c.family, weight: nearestWeight(c.family, weightFromName(n.slice(norm(c.family).length))) };
    for (const [re, fam] of ALIASES) if (re.test(n)) return { family: fam, weight: nearestWeight(fam, weightFromName(n)) };
    return null;
  }

  // ---- ink maps ----
  const NH = 32;                       // feature height; width follows the aspect
  const HEB = /[א-ת]/g;
  const hebCount = (s) => (String(s).match(HEB) || []).length;

  // a coverage map NH × nw of the ink inside bbox, area-averaged, then blurred
  function featureOf(mask, mw, bb, nw) {
    const out = new Float32Array(NH * nw);
    const bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
    for (let y = bb.y0; y < bb.y1; y++) {
      const fy = Math.min(NH - 1, Math.floor((y - bb.y0) * NH / bh));
      for (let x = bb.x0; x < bb.x1; x++) {
        if (!mask[y * mw + x]) continue;
        out[fy * nw + Math.min(nw - 1, Math.floor((x - bb.x0) * nw / bw))] += 1;
      }
    }
    const cell = (bw / nw) * (bh / NH);
    for (let i = 0; i < out.length; i++) out[i] /= cell;
    return blur(out, nw, NH);
  }
  function blur(a, w, h) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let d = -1; d <= 1; d++) { const xx = x + d; if (xx >= 0 && xx < w) { s += a[y * w + xx]; n++; } }
      t[y * w + x] = s / n;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let d = -1; d <= 1; d++) { const yy = y + d; if (yy >= 0 && yy < h) { s += t[yy * w + x]; n++; } }
      o[y * w + x] = s / n;
    }
    return o;
  }
  function pearson(a, b) {
    const n = a.length; let sa = 0, sb = 0;
    for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
    const ma = sa / n, mb = sb / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }
  // tight bbox of a mask; columns/rows with a sliver of noise are trimmed
  function inkBox(mask, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return n ? { x0, y0, x1: x1 + 1, y1: y1 + 1, n } : null;
  }

  // ink of a crop of the page: whatever differs from the crop's own paper
  // colour (gold on cream and white on navy work the same as black on white)
  function sampleFromCanvas(canvas, r) {
    const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
    const w = Math.min(canvas.width - x, Math.ceil(r.w)), h = Math.min(canvas.height - y, Math.ceil(r.h));
    if (w < 8 || h < 8) return null;
    const d = canvas.getContext('2d').getImageData(x, y, w, h).data;
    const border = [[], [], []];
    const push = (i) => { border[0].push(d[i]); border[1].push(d[i + 1]); border[2].push(d[i + 2]); };
    for (let xx = 0; xx < w; xx++) { push(xx * 4); push(((h - 1) * w + xx) * 4); }
    for (let yy = 0; yy < h; yy++) { push(yy * w * 4); push((yy * w + w - 1) * 4); }
    const med = border.map((ch) => ch.sort((a, b) => a - b)[ch.length >> 1]);
    const dist = new Uint8Array(w * h), hist = new Float64Array(256);
    for (let i = 0; i < w * h; i++) {
      const v = Math.max(Math.abs(d[i * 4] - med[0]), Math.abs(d[i * 4 + 1] - med[1]), Math.abs(d[i * 4 + 2] - med[2]));
      dist[i] = v; hist[v]++;
    }
    const t = Math.max(48, otsu(hist, w * h));
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = dist[i] > t ? 1 : 0;
    const bb = inkBox(mask, w, h);
    if (!bb || bb.y1 - bb.y0 < 8 || bb.x1 - bb.x0 < 12) return null;
    return { mask, w, h, bb };
  }
  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, th = 0;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; th = i; }
    }
    return th;
  }

  // the same string set in one candidate face, as an ink mask
  let cv = null;
  function renderCandidate(text, family, weight) {
    cv = cv || document.createElement('canvas');
    const px = 64;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.font = weight + ' ' + px + "px '" + family + "'";
    const tw = Math.ceil(cx.measureText(text).width) + px;
    const W = Math.min(4000, Math.max(32, tw)), H = Math.ceil(px * 1.8);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; } else cx.clearRect(0, 0, W, H);
    cx.font = weight + ' ' + px + "px '" + family + "'";
    cx.direction = 'rtl'; cx.textAlign = 'right'; cx.textBaseline = 'alphabetic';
    cx.fillStyle = '#000';
    cx.fillText(text, W - px / 2, Math.round(px * 1.25));
    const d = cx.getImageData(0, 0, W, H).data, mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = d[i * 4 + 3] > 110 ? 1 : 0;
    const bb = inkBox(mask, W, H);
    return bb ? { mask, w: W, h: H, bb } : null;
  }

  // how well one face draws one sample: best over its weights and both
  // string orders (a text layer may hold Hebrew in visual order)
  function scoreSample(s, cand) {
    const aspect = (s.bb.x1 - s.bb.x0) / (s.bb.y1 - s.bb.y0);
    const nw = Math.max(8, Math.min(320, Math.round(NH * aspect)));
    const sf = s.feat && s.feat.nw === nw ? s.feat.f : (s.feat = { nw, f: featureOf(s.mask, s.w, s.bb, nw) }).f;
    let best = { score: -1, weight: cand.weights[0] };
    const orders = s.orders || [s.text];
    for (const w of cand.weights) {
      for (const t of orders) {
        const r = renderCandidate(t, cand.family, w);
        if (!r) continue;
        const ca = (r.bb.x1 - r.bb.x0) / (r.bb.y1 - r.bb.y0);
        const shape = pearson(sf, featureOf(r.mask, r.w, r.bb, nw));
        const score = shape * Math.exp(-2.2 * Math.abs(Math.log(ca / aspect)));
        if (score > best.score) best = { score, weight: w };
      }
    }
    return best;
  }

  async function loadFaces(text) {
    const sample = (text || '') + 'אבגדהוזחטיכלמנסעפצקרשת';
    await Promise.all(CANDIDATES.flatMap((c) => c.weights.map((w) =>
      document.fonts.load(w + " 40px '" + c.family + "'", sample).catch(() => null))));
  }

  /* match(samples) → { family, weight, css, score, margin, ranked:[{family,score,share}] }
   * samples: [{ text, mask, w, h, bb }] — the decision is a weighted vote:
   * long, confident samples count more than a stray two-letter word. */
  async function matchSamples(samples, only) {
    const usable = samples.filter(Boolean).slice(0, 10);
    const cands = only ? CANDIDATES.filter((c) => only.includes(c.family)) : CANDIDATES;
    if (!usable.length) return null;
    await loadFaces(usable.map((s) => s.text).join(''));
    usable.forEach((s) => {
      const rev = Array.from(s.text).reverse().join('');
      s.orders = rev !== s.text ? [s.text, rev] : [s.text];
    });
    const fam = {};
    let totalW = 0;
    const perSample = usable.map((s) => {
      const wt = Math.sqrt(hebCount(s.text)) * (s.conf || 1);
      totalW += wt;
      const res = cands.map((c) => Object.assign({ family: c.family }, scoreSample(s, c)));
      res.sort((a, b) => b.score - a.score);
      res.forEach((r) => {
        const f = (fam[r.family] = fam[r.family] || { family: r.family, sum: 0, wins: 0, weights: {} });
        f.sum += wt * r.score;
        f.weights[r.weight] = (f.weights[r.weight] || 0) + wt * Math.max(0, r.score);
      });
      fam[res[0].family].wins += wt;
      return res;
    });
    const ranked = Object.values(fam).map((f) => ({
      family: f.family, score: f.sum / totalW, share: f.wins / totalW,
      weight: +Object.keys(f.weights).sort((a, b) => f.weights[b] - f.weights[a])[0]
    })).sort((a, b) => b.score - a.score);
    const top = ranked[0];
    return {
      family: top.family, weight: top.weight, css: cssFor(top.family),
      score: top.score, margin: top.score - (ranked[1] ? ranked[1].score : 0),
      ranked: ranked.slice(0, 5), source: 'shape', samples: perSample.length
    };
  }

  // ---- reading the page ----
  async function renderPage(pdfDoc, n, targetW) {
    const page = await pdfDoc.getPage(n);
    const base = page.getViewport({ scale: 1, rotation: page.rotate });
    const scale = Math.min(4, Math.max(1, targetW / base.width));
    const vp = page.getViewport({ scale, rotation: page.rotate });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { page, vp, canvas: c };
  }

  const pureHebrew = (s) => /^[א-ת׳״'"׳״\s.,:־-]+$/.test(s) && hebCount(s) >= 3;

  // text runs → cropped samples, the largest first (titles and body lines)
  async function textLayerSamples(page, vp, canvas) {
    let tc;
    try { tc = await page.getTextContent(); } catch (e) { return { names: [], samples: [] }; }
    try { await page.getOperatorList(); } catch (e) {}   // resolves the embedded font objects
    const names = [];
    const runs = [];
    tc.items.forEach((it) => {
      const s = String(it.str || '').trim();
      if (!s || !hebCount(s)) return;
      try {
        const obj = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null;
        if (obj && obj.name) names.push({ raw: obj.name, n: hebCount(s) });
      } catch (e) {}
      if (!pureHebrew(s) || s.length > 28) return;
      const tx = root.pdfjsLib.Util.transform(vp.transform, it.transform);
      const fh = Math.hypot(tx[2], tx[3]);
      const w = (it.width || 0) * vp.scale;
      if (fh < 10 || w < fh) return;
      runs.push({ text: s, fh, r: { x: tx[4] - fh * 0.25, y: tx[5] - fh * 1.15, w: w + fh * 0.5, h: fh * 1.55 } });
    });
    runs.sort((a, b) => b.fh * hebCount(b.text) - a.fh * hebCount(a.text));
    const samples = [];
    for (const run of runs) {
      if (samples.length >= 8) break;
      const s = sampleFromCanvas(canvas, run.r);
      if (s) samples.push(Object.assign(s, { text: run.text.replace(/\s+/g, ' ') }));
    }
    return { names, samples };
  }

  // words the OCR read with confidence → cropped samples
  async function ocrSamples(canvas) {
    if (!(PFS.ocr && PFS.ocr.available && PFS.ocr.available() && PFS.ocr.recognizeWords)) return [];
    let words = [];
    try { words = await PFS.ocr.recognizeWords(canvas); } catch (e) { return []; }
    const good = words.filter((w) => w.bbox && (w.confidence == null || w.confidence >= 72) && pureHebrew((w.text || '').trim()));
    good.sort((a, b) => (b.bbox.y1 - b.bbox.y0) * hebCount(b.text) - (a.bbox.y1 - a.bbox.y0) * hebCount(a.text));
    const samples = [];
    for (const w of good) {
      if (samples.length >= 10) break;
      const bh = w.bbox.y1 - w.bbox.y0, pad = bh * 0.3;
      const s = sampleFromCanvas(canvas, { x: w.bbox.x0 - pad, y: w.bbox.y0 - pad, w: w.bbox.x1 - w.bbox.x0 + 2 * pad, h: bh + 2 * pad });
      if (s) samples.push(Object.assign(s, { text: w.text.trim(), conf: (w.confidence || 80) / 100 }));
    }
    return samples;
  }

  /* detect(pdfDoc, {page}) → result | null. Never throws. */
  async function detect(pdfDoc, opts) {
    opts = opts || {};
    try {
      const { page, vp, canvas } = await renderPage(pdfDoc, (opts.page || 0) + 1, opts.width || 2000);
      const tl = await textLayerSamples(page, vp, canvas);
      // 1. a name we know outright
      const tally = {};
      tl.names.forEach((n) => {
        const f = familyFromName(n.raw);
        if (!f) return;
        const k = f.family + '|' + f.weight;
        tally[k] = (tally[k] || 0) + n.n;
      });
      const named = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      if (named) {
        const [family, w] = named.split('|');
        let weight = +w;
        // a variable font is embedded under its default instance's name
        // ("Rubik-Light" for any weight): the strokes tell the real weight
        if (byFamily(family).weights.length > 1 && tl.samples.length) {
          const r = await matchSamples(tl.samples, [family]);
          if (r) weight = r.weight;
        }
        canvas.width = 0;
        return { family, weight, css: cssFor(family), score: 1, margin: 1, ranked: [{ family, score: 1, share: 1, weight }], source: 'name' };
      }
      // 2. shapes from the text layer, 3. or from OCR words
      let samples = tl.samples;
      let res = samples.length ? await matchSamples(samples) : null;
      if ((!res || res.score < 0.6) && opts.ocr !== false) {
        const oc = await ocrSamples(canvas);
        if (oc.length) {
          const r2 = await matchSamples(oc);
          if (r2 && (!res || r2.score > res.score)) res = Object.assign(r2, { source: 'ocr' });
        }
      }
      canvas.width = 0;
      return res;
    } catch (e) {
      return null;
    }
  }

  PFS.certmatch = { CANDIDATES, detect, matchSamples, familyFromName, cssFor, nearestWeight, sampleFromCanvas, renderCandidate };
})(window);
