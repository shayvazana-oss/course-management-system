/* element.js — a single free-floating overlay item (text or image).
 * Geometry is stored as page fractions (fx,fy,fw,fh,fontFrac); the same
 * fractions drive both on-screen layout and the exported raster, so what you
 * see is what you get at any zoom.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});
  const clamp = PFS.clamp;

  let SEQ = 1;
  const uid = () => 'el' + (SEQ++) + '_' + Math.floor(performance.now());

  const DEFAULTS = {
    text:  { fontFrac: 0.018, color: '#111111', bold: false, align: 'right', text: '' },
    check: { fontFrac: 0.026, color: '#0f5132', bold: true,  align: 'center', text: '✓' },
    cross: { fontFrac: 0.026, color: '#842029', bold: true,  align: 'center', text: '✗' },
    date:  { fontFrac: 0.016, color: '#111111', bold: false, align: 'center', text: '' },
    // filled rectangles: cover a pre-printed error (white) / redact info (black)
    // / highlight text (semi-transparent yellow, so the text shows through)
    whiteout:  { color: '#ffffff', fw: 0.22, fh: 0.035, opacity: 1 },
    redact:    { color: '#111111', fw: 0.22, fh: 0.035, opacity: 1 },
    highlight: { color: '#ffe600', fw: 0.22, fh: 0.03,  opacity: 0.35 }
  };
  // element render type from the tool kind
  const RECT_KINDS = { whiteout: 1, redact: 1, highlight: 1 };
  function typeOf(kind) { return kind === 'image' ? 'image' : (RECT_KINDS[kind] ? 'rect' : 'text'); }

  function makeModel(type, page, partial) {
    const base = {
      id: uid(), type: typeOf(type),
      kind: type, page,
      fx: 0.4, fy: 0.4, fw: 0.16, fh: 0.05,
      fontFrac: 0.018, color: '#111111', bold: false, align: 'right',
      text: '', imgUrl: null, aspect: 1, fieldKey: ''
    };
    if (DEFAULTS[type]) Object.assign(base, DEFAULTS[type]);
    const model = Object.assign(base, partial || {});
    // written text defaults to the DOCUMENT's typeface, not the app's — a value
    // set in the form's own font stops reading as a patch (resolved at creation
    // time: fontmatch learns the face only after the PDF loads)
    if (model.type === 'text' && model.font === undefined && PFS.fontmatch) {
      const css = PFS.fontmatch.docCss();
      if (css) model.font = css;
    }
    return model;
  }

  /* createElement(model, ctx)
   *  ctx.overlayEl, ctx.getOverlaySize(), ctx.onSelect(ctrl),
   *  ctx.onChange(), ctx.onDelete(ctrl)
   */
  function createElement(model, ctx) {
    const isImage = model.type === 'image';
    const isRect = model.type === 'rect';
    const isBox = isImage || isRect;   // box-resized (vs text auto-size)
    const node = document.createElement('div');
    node.className = 'el ' + (isImage ? 'image' : (isRect ? 'rect' : 'text'));
    node.dataset.id = model.id;

    // delete button + resize handle
    const del = document.createElement('div');
    del.className = 'mini-del'; del.textContent = '✕';
    const handle = document.createElement('div'); handle.className = 'handle';

    let inner;
    if (isImage) {
      inner = document.createElement('img');
      inner.src = model.imgUrl;
      inner.alt = model.kind || 'image';
      node.appendChild(inner);
    } else if (isRect) {
      inner = document.createElement('div');
      inner.className = 'fill';
      inner.style.cssText = 'width:100%;height:100%;background:' + (model.color || '#fff') + ';opacity:' + (model.opacity != null ? model.opacity : 1);
      node.appendChild(inner);
    } else {
      inner = document.createElement('div');
      inner.className = 'txt';
      inner.textContent = model.text || '';
      node.appendChild(inner);
    }
    node.appendChild(del);
    node.appendChild(handle);

    const ctrl = { model, node, layout, select, deselect, remove, focusText };

    function layout() {
      const { w: W, h: H } = ctx.getOverlaySize();
      node.style.left = (model.fx * W) + 'px';
      node.style.top = (model.fy * H) + 'px';
      if (isBox) {
        node.style.width = (model.fw * W) + 'px';
        node.style.height = (model.fh * H) + 'px';
        if (isRect && inner) { inner.style.background = model.color || '#fff'; inner.style.opacity = (model.opacity != null ? model.opacity : 1); }
      } else {
        const fontPx = model.fontFrac * H;
        inner.style.fontSize = fontPx + 'px';
        inner.style.color = model.color;
        inner.style.fontFamily = model.font || '';   // '' = inherit the app font
        inner.style.fontWeight = model.bold ? '700' : '400';
        inner.style.textAlign = model.align;
        // letter-spacing lets typed text line up with per-character boxes
        inner.style.letterSpacing = model.letterSpacing ? (model.letterSpacing * fontPx) + 'px' : '';
        node.style.width = 'auto';
        node.style.height = 'auto';
        // reflect measured size back into fractions (for drag clamp + templates)
        model.fw = node.offsetWidth / W;
        model.fh = node.offsetHeight / H;
      }
    }

    function select() { node.classList.add('selected'); }
    function deselect() {
      node.classList.remove('selected');
      if (!isBox) {
        // blur first so the empty-text auto-remove handler can fire
        if (node.dataset.editing === '1' && document.activeElement === inner) inner.blur();
        inner.contentEditable = 'false'; node.dataset.editing = '0';
      }
    }
    function remove() { node.remove(); }

    function focusText() {
      if (isBox) return;
      inner.contentEditable = 'true';
      node.dataset.editing = '1';
      inner.focus({ preventScroll: true });
      // place caret at end
      const r = document.createRange(); r.selectNodeContents(inner); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }

    // ---- events ----
    del.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
    del.addEventListener('click', (e) => { e.stopPropagation(); ctx.onDelete(ctrl); });

    if (!isBox) {
      inner.addEventListener('input', () => {
        model.text = inner.innerText.replace(/\n$/, '');
        layout();
        ctx.onChange && ctx.onChange();
      });
      inner.addEventListener('blur', () => {
        inner.contentEditable = 'false'; node.dataset.editing = '0';
        // auto-remove an empty text box so no stray elements linger
        if (!model.text.trim()) ctx.onDelete(ctrl);
      });
      // double-click / second click enters edit mode
      node.addEventListener('dblclick', (e) => { e.preventDefault(); focusText(); });
    }

    // drag + resize
    PFS.attachDragResize(node, {
      overlayEl: ctx.overlayEl,
      model,
      handle,
      aspect: isImage ? (model.aspect || 1) : null,
      // peers on the same page → alignment snapping while dragging
      getSnapTargets: () => (ctx.getPeers ? ctx.getPeers() : []).map((m) => ({ fx: m.fx, fy: m.fy, fw: m.fw, fh: m.fh })),
      onSelect: (additive) => ctx.onSelect(ctrl, additive),
      onResize: isBox ? null : (dx, dy, start) => {
        // text: vertical drag scales font size (gentle; fine control in panel)
        model.fontFrac = clamp(start.fontFrac + dy * 0.35, 0.006, 0.2);
        return false; // handled → skip default box resize
      },
      onChange: () => { layout(); ctx.onChange && ctx.onChange(); }
    });

    return ctrl;
  }

  PFS.element = { createElement, makeModel };
})(window);
