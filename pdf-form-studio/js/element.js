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
    date:  { fontFrac: 0.016, color: '#111111', bold: false, align: 'center', text: '' }
  };

  function makeModel(type, page, partial) {
    const base = {
      id: uid(), type: type === 'image' ? 'image' : 'text',
      kind: type, page,
      fx: 0.4, fy: 0.4, fw: 0.16, fh: 0.05,
      fontFrac: 0.018, color: '#111111', bold: false, align: 'right',
      text: '', imgUrl: null, aspect: 1, fieldKey: ''
    };
    if (DEFAULTS[type]) Object.assign(base, DEFAULTS[type]);
    return Object.assign(base, partial || {});
  }

  /* createElement(model, ctx)
   *  ctx.overlayEl, ctx.getOverlaySize(), ctx.onSelect(ctrl),
   *  ctx.onChange(), ctx.onDelete(ctrl)
   */
  function createElement(model, ctx) {
    const isImage = model.type === 'image';
    const node = document.createElement('div');
    node.className = 'el ' + (isImage ? 'image' : 'text');
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
      if (isImage) {
        node.style.width = (model.fw * W) + 'px';
        node.style.height = (model.fh * H) + 'px';
      } else {
        inner.style.fontSize = (model.fontFrac * H) + 'px';
        inner.style.color = model.color;
        inner.style.fontWeight = model.bold ? '700' : '400';
        inner.style.textAlign = model.align;
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
      if (!isImage) {
        // blur first so the empty-text auto-remove handler can fire
        if (node.dataset.editing === '1' && document.activeElement === inner) inner.blur();
        inner.contentEditable = 'false'; node.dataset.editing = '0';
      }
    }
    function remove() { node.remove(); }

    function focusText() {
      if (isImage) return;
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

    if (!isImage) {
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
      onSelect: () => ctx.onSelect(ctrl),
      onResize: isImage ? null : (dx, dy, start) => {
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
