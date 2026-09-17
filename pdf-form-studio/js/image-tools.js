/* image-tools.js — client-side image processing for signatures & stamps.
 * Adapted from the canvas downscale idea in image-slot.js, plus
 * white-background removal, auto-trim, and a signature drawing pad.
 * No network, no dependencies.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
  const MAX_DIM = 1400; // cap stored image dimension

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // Read a File into an <img>, honoring the type allowlist.
  async function fileToImage(file) {
    if (!file || !ACCEPT.includes(file.type)) {
      throw new Error('סוג קובץ לא נתמך (PNG / JPG / WEBP בלבד)');
    }
    const url = URL.createObjectURL(file);
    try { return await loadImage(url); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 4000); }
  }

  // Draw an image/canvas onto a fresh canvas, downscaled to MAX_DIM.
  function toCanvas(img, maxDim = MAX_DIM) {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, cw, ch);
    return c;
  }

  /* Knock out near-white pixels → transparent, so a scanned stamp/signature
   * sits cleanly on the form. Only near-pure white is removed (threshold),
   * with a soft feather band to avoid a hard halo. Operates in place. */
  function whiteToTransparent(canvas, opts = {}) {
    const threshold = opts.threshold ?? 240;
    const feather = opts.feather ?? 18; // luminance band above which we start fading
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = id.data;
    const lo = threshold - feather;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const m = Math.min(r, g, b);      // how "white" (all channels high)
      if (m >= threshold) {
        d[i + 3] = 0;                    // fully transparent
      } else if (m > lo) {
        // fade alpha across the feather band
        const t = (m - lo) / (threshold - lo);
        d[i + 3] = Math.round(d[i + 3] * (1 - t));
      }
    }
    ctx.putImageData(id, 0, 0);
    return canvas;
  }

  /* Crop away fully transparent margins so the element box hugs the ink. */
  function autoTrim(canvas, pad = 2) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { width: w, height: h } = canvas;
    if (!w || !h) return canvas;
    const d = ctx.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return canvas; // fully transparent — leave as-is
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return out;
  }

  function canvasToPngUrl(canvas) { return canvas.toDataURL('image/png'); }

  /* Downscale an image/canvas and encode as JPEG on a white background — for
   * attachments (a phone photo of an ID can be 4000px/5MB; this keeps the
   * exported PDF small enough to share on WhatsApp/email). */
  function downscaleToJpeg(src, maxDim = 1800, quality = 0.85) {
    const scaled = toCanvas(src, maxDim);
    const c = document.createElement('canvas');
    c.width = scaled.width; c.height = scaled.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); // JPEG has no alpha
    ctx.drawImage(scaled, 0, 0);
    return { url: c.toDataURL('image/jpeg', quality), w: c.width, h: c.height };
  }

  /* Full pipeline for an uploaded stamp/signature photo:
   * downscale → optional white removal → trim → PNG data URL (keeps alpha). */
  async function processUpload(file, { removeWhite = true } = {}) {
    const img = await fileToImage(file);
    let canvas = toCanvas(img);
    if (removeWhite) canvas = whiteToTransparent(canvas);
    canvas = autoTrim(canvas);
    return { url: canvasToPngUrl(canvas), w: canvas.width, h: canvas.height };
  }

  /* ---- Signature drawing pad ---- */
  function signaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    let drawing = false, dirty = false, p0 = null, p1 = null;
    let color = '#000000', width = 2.5;

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    }
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function down(e) {
      drawing = true; dirty = true; p0 = p1 = pos(e);
      // a dot so a single tap registers
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p0.x, p0.y, width / 2, 0, Math.PI * 2); ctx.fill();
      canvas.setPointerCapture(e.pointerId);
    }
    function move(e) {
      if (!drawing) return;
      const q = pos(e);
      // quadratic curve from the midpoint(p0,p1) through control p1 to
      // midpoint(p1,q) → the ink flows smoothly instead of faceting.
      const m1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const m2 = { x: (p1.x + q.x) / 2, y: (p1.y + q.y) / 2 };
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(m1.x, m1.y); ctx.quadraticCurveTo(p1.x, p1.y, m2.x, m2.y); ctx.stroke();
      p0 = p1; p1 = q;
    }
    function up() { drawing = false; p0 = p1 = null; }

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    return {
      resize,
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; },
      setColor(c) { color = c; },
      setWidth(w) { width = w; },
      isEmpty() { return !dirty; },
      // Returns trimmed, transparent-bg PNG of the strokes.
      toDataUrl() {
        const trimmed = autoTrim(canvas, 6);
        return { url: trimmed.toDataURL('image/png'), w: trimmed.width, h: trimmed.height };
      }
    };
  }

  /* strokePad — like signaturePad but records raw polyline strokes (in CSS px),
   * used to capture individual handwriting glyphs for later synthesis. */
  function strokePad(canvas) {
    const ctx = canvas.getContext('2d');
    let drawing = false, strokes = [], cur = null, color = '#111827', width = 3;

    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      redraw();
    }
    function pos(e) { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    function redraw() {
      const r = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, r.width, r.height);
      ctx.strokeStyle = color; ctx.lineWidth = width;
      strokes.forEach((st) => { ctx.beginPath(); st.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke(); });
    }
    function down(e) { drawing = true; cur = [pos(e)]; strokes.push(cur); canvas.setPointerCapture(e.pointerId); }
    function move(e) {
      if (!drawing) return;
      const q = pos(e); const a = cur[cur.length - 1]; cur.push(q);
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
    function up() { drawing = false; }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    return {
      resize,
      clear() { strokes = []; cur = null; redraw(); },
      isEmpty() { return !strokes.some((s) => s.length >= 2); },
      getStrokes() { return strokes.map((s) => s.map((q) => ({ x: q.x, y: q.y }))); },
      setStrokes(s) { strokes = s ? s.map((x) => x.map((q) => ({ x: q.x, y: q.y }))) : []; redraw(); },
      setColor(c) { color = c; redraw(); },
      setWidth(w) { width = w; }
    };
  }

  PFS.imageTools = {
    ACCEPT, loadImage, fileToImage, toCanvas,
    whiteToTransparent, autoTrim, canvasToPngUrl, downscaleToJpeg, processUpload, signaturePad, strokePad
  };
})(window);
