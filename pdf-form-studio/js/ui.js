/* ui.js — in-app replacements for window.prompt / window.confirm.
 * Browser-native dialogs are blocked inside sandboxed iframes (hosted
 * artifact), so every "ask the user" flow goes through this promise-based
 * modal instead. Reuses the app's .modal styles.
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  let back = null, els = null, resolveFn = null;

  function build() {
    if (back) return;
    back = document.createElement('div');
    back.className = 'modal-back';
    back.id = 'uiDialog';
    back.innerHTML =
      '<div class="modal" style="max-width:400px">' +
      '  <header id="uiDlgTitle"></header>' +
      '  <div class="m-body">' +
      '    <div class="hint" id="uiDlgMsg" style="display:none"></div>' +
      '    <input type="text" id="uiDlgInput" style="display:none" />' +
      '  </div>' +
      '  <footer>' +
      '    <button class="btn primary" id="uiDlgOk">אישור</button>' +
      '    <button class="btn ghost" id="uiDlgCancel">ביטול</button>' +
      '  </footer>' +
      '</div>';
    document.body.appendChild(back);
    els = {
      title: back.querySelector('#uiDlgTitle'),
      msg: back.querySelector('#uiDlgMsg'),
      input: back.querySelector('#uiDlgInput'),
      ok: back.querySelector('#uiDlgOk'),
      cancel: back.querySelector('#uiDlgCancel')
    };
    els.ok.addEventListener('click', () => finish(true));
    els.cancel.addEventListener('click', () => finish(false));
    back.addEventListener('pointerdown', (e) => { if (e.target === back) finish(false); });
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  function finish(ok) {
    if (!resolveFn) return;
    const r = resolveFn; resolveFn = null;
    back.classList.remove('show');
    const isPrompt = els.input.style.display !== 'none';
    r(ok ? (isPrompt ? els.input.value : true) : (isPrompt ? null : false));
  }

  /* prompt(title, {value, placeholder, message, okText}) → Promise<string|null> */
  function promptDialog(title, opts) {
    opts = opts || {};
    build();
    if (resolveFn) finish(false); // close a stale dialog
    els.title.textContent = title || '';
    els.msg.textContent = opts.message || '';
    els.msg.style.display = opts.message ? '' : 'none';
    els.input.style.display = '';
    els.input.value = opts.value || '';
    els.input.placeholder = opts.placeholder || '';
    els.ok.textContent = opts.okText || 'אישור';
    back.classList.add('show');
    setTimeout(() => { els.input.focus(); els.input.select(); }, 30);
    return new Promise((res) => { resolveFn = res; });
  }

  /* confirm(title, message?) → Promise<boolean> */
  function confirmDialog(title, message) {
    build();
    if (resolveFn) finish(false);
    els.title.textContent = title || '';
    els.msg.textContent = message || '';
    els.msg.style.display = message ? '' : 'none';
    els.input.style.display = 'none';
    els.ok.textContent = 'אישור';
    back.classList.add('show');
    setTimeout(() => els.ok.focus(), 30);
    return new Promise((res) => { resolveFn = res; });
  }

  PFS.ui = { prompt: promptDialog, confirm: confirmDialog };
})(window);
