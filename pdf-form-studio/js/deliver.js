/* deliver.js — hand a generated file to the user, everywhere.
 * Normally a programmatic <a download> click just works. Inside a sandboxed
 * iframe (the hosted artifact) downloads can be silently blocked, so there we
 * also show a "הקובץ מוכן" dialog with manual fallbacks: a direct download
 * link (works when the host allows downloads) and open-in-new-tab (works when
 * the host allows popups — the new tab can then save/print the file).
 */
(function (root) {
  'use strict';
  const PFS = (root.PFS = root.PFS || {});

  // sandboxed iframes without allow-same-origin get an opaque ("null") origin
  const SANDBOXED = (function () { try { return window.origin === 'null'; } catch (e) { return true; } })();

  let back = null, els = null, curUrl = null;
  function build() {
    if (back) return;
    back = document.createElement('div');
    back.className = 'modal-back';
    back.id = 'dlvModal';
    back.innerHTML =
      '<div class="modal" style="max-width:420px">' +
      '  <header>📄 הקובץ מוכן</header>' +
      '  <div class="m-body">' +
      '    <div class="row" style="justify-content:space-between">' +
      '      <b id="dlvName" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr"></b>' +
      '      <span class="hint muted" id="dlvSize"></span>' +
      '    </div>' +
      '    <a class="btn primary block" id="dlvGo" style="text-decoration:none">⬇️ הורדה</a>' +
      '    <a class="btn block" id="dlvOpen" target="_blank" rel="noopener" style="text-decoration:none">🔗 פתח בכרטיסייה חדשה</a>' +
      '    <div class="hint muted">אם ההורדה לא מתחילה — לחצו "פתח בכרטיסייה חדשה" ושמרו משם (סמל ההורדה/שיתוף של הדפדפן).</div>' +
      '  </div>' +
      '  <footer><button class="btn ghost" id="dlvClose">סגור</button></footer>' +
      '</div>';
    document.body.appendChild(back);
    els = {
      name: back.querySelector('#dlvName'),
      size: back.querySelector('#dlvSize'),
      go: back.querySelector('#dlvGo'),
      open: back.querySelector('#dlvOpen')
    };
    const close = () => {
      back.classList.remove('show');
      if (curUrl) { const u = curUrl; curUrl = null; setTimeout(() => URL.revokeObjectURL(u), 4000); }
    };
    back.querySelector('#dlvClose').addEventListener('click', close);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  }

  function human(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  /* file(data: Uint8Array|ArrayBuffer|string|Blob, filename, mime) */
  function file(data, filename, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    // the normal path — succeeds anywhere downloads are permitted
    try {
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'file';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { /* fall through to the dialog */ }
    if (!SANDBOXED) { setTimeout(() => URL.revokeObjectURL(url), 8000); return; }
    // sandboxed host: keep the URL alive and give manual fallbacks
    build();
    if (curUrl) URL.revokeObjectURL(curUrl);
    curUrl = url;
    els.name.textContent = filename || 'file';
    els.size.textContent = human(blob.size);
    els.go.href = url; els.go.setAttribute('download', filename || 'file');
    els.open.href = url;
    back.classList.add('show');
  }

  PFS.deliver = { file, SANDBOXED };
})(window);
