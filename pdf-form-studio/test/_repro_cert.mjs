import { chromium } from 'playwright-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = process.argv[2];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.pdf': 'application/pdf' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); }); });
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
await page.addInitScript(() => { window.__PFS_NO_GATE = true; });
await page.goto(`http://localhost:${server.address().port}/index.html`, { waitUntil: 'load' }); await page.waitForTimeout(400);
await page.evaluate(() => { window.PFS.store.set('onboarded', true); window.PFS.store.set('tour_done', true); window.PFS.store.set('hint_clicktype', true); });
await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(900);
const res = await page.evaluate(async () => {
  const T = window.PFS.__test, M = window.PFS.merge; window.PFS.ui.confirm = async () => true;
  const { PDFDocument, rgb } = window.PDFLib; const d = await PDFDocument.create();
  const pg = d.addPage([842, 595]); pg.drawRectangle({ x: 0, y: 0, width: 842, height: 595, color: rgb(0.97, 0.97, 0.98) });
  pg.drawRectangle({ x: 24, y: 24, width: 794, height: 547, borderColor: rgb(0.1, 0.2, 0.45), borderWidth: 3 });
  await T.startCertFlow(new File([await d.save()], 'תעודה.pdf', { type: 'application/pdf' }));
  await new Promise((r) => setTimeout(r, 1800));
  T.overlay.clearElements();
  // the clerk's layout: name on the right, ID on the left, SAME line
  const nm = T.certPlace(0, 0.62, 0.42, 'שם מלא');
  const id = T.certPlace(0, 0.30, 0.42, 'תעודת זהות');
  T.certPlace(0, 0.5, 0.55, 'שם הקורס');
  T.certLoadList(M.parseCSV('שם מלא,תעודת זהות,שם הקורס\nאביטל מוזס חיים,059789826,חשמלאות מוסמכים\nאור בראל,033440124,חשמלאות מוסמכים\nאלכסנדרה בן-שושן אבוטבול,311862528,חשמלאות מוסמכים'), 'list.csv');
  const zip = await T.certProduce('zip', { noDownload: true });
  const files = window.fflate.unzipSync(zip.bytes);
  const out = {};
  for (const n of Object.keys(files)) {
    const doc = await window.pdfjsLib.getDocument({ data: files[n].slice(0) }).promise; const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1.6 }); const cv = document.createElement('canvas'); cv.width = vp.width; cv.height = vp.height;
    await p1.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    out[n] = cv.toDataURL('image/png');
  }
  return out;
});
let i = 0; for (const [n, u] of Object.entries(res)) fs.writeFileSync(path.join(OUT, 'after-' + (i++) + '.png'), Buffer.from(u.split(',')[1], 'base64'));
console.log(Object.keys(res)); await browser.close(); server.close();
