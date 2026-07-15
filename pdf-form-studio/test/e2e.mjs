/* e2e.mjs — Fillo end-to-end smoke suite.
 *
 * Serves the app over http and drives it in a real Chromium (playwright-core),
 * asserting the core user flows. No test framework — plain assertions with a
 * pass/fail summary and a non-zero exit on failure, so it runs anywhere:
 *
 *     npm test                 # from pdf-form-studio/
 *     PW_CHROMIUM=/path node test/e2e.mjs
 *
 * Set PW_CHROMIUM to a Chromium/Chrome binary if it isn't auto-found.
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixtures', 'form.pdf');

function findChromium() {
  const cands = [
    process.env.PW_CHROMIUM,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.traineddata': 'application/octet-stream', '.pdf': 'application/pdf' };

const results = [];
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

async function main() {
  const exe = findChromium();
  if (!exe) { console.error('No Chromium found. Set PW_CHROMIUM=/path/to/chrome'); process.exit(2); }

  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    fs.readFile(path.join(ROOT, p), (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}/index.html`;

  const browser = await chromium.launch({ executablePath: exe });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('CONSOLE: ' + m.text()); });

  await page.goto(base, { waitUntil: 'load' }); await page.waitForTimeout(700);
  check('app + libraries load', await page.evaluate(() => !!(window.PFS && window.pdfjsLib && window.PDFLib)));

  await page.evaluate(() => {
    window.PFS.store.set('onboarded', true);
    window.PFS.store.set('profiles', [{ id: 'p', name: 'me', values: { 'שם משפחה': 'ישראלי', 'תעודת זהות': '123456782', 'טלפון': '0501234567' } }]);
    window.PFS.store.set('active_profile', 'p');
  });
  await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(500);

  await (await page.$('#pdfInput')).setInputFiles(FIXTURE);
  await page.waitForTimeout(3400);
  const els = await page.evaluate(() => [...document.querySelectorAll('.el.text .txt')].map((e) => e.textContent));
  check('auto-fills last name by meaning', els.includes('ישראלי'));
  check('auto-fills checksum-valid ID', els.includes('123456782'));
  check('auto-fills phone', els.includes('0501234567'));
  check('auto-inserts today for plain date field', els.some((t) => /\d{1,2}[./]\d{1,2}[./]\d{4}/.test(t)));
  check('empty-field markers rendered', await page.evaluate(() => document.querySelectorAll('.field-marker').length > 0));
  check('completeness meter shown', await page.evaluate(() => /מולאו/.test(document.getElementById('fpMeterTxt')?.textContent || '')));
  check('date picker on a date field', await page.evaluate(() => [...document.querySelectorAll('#fieldsBody button')].some((b) => b.textContent === '📅')));
  check('keyboard field-nav wired', await page.evaluate(() => typeof document.querySelector('#fieldsBody input[type=text]').__fkey === 'string'));
  check('page thumbnails available (multi-page)', await page.evaluate(() => !document.getElementById('thumbsBtn').hidden));
  check('checkbox (☐) detected as tickable field', await page.evaluate(() => document.querySelectorAll('#fieldsBody input[type=checkbox]').length > 0));

  // round radio bullets (○ זכר / ○ נקבה) → one tickable field per option, each
  // labelled by its own word — whether the bullet shares a text run with its
  // label or the text layer splits them apart. Driven through the detection
  // heuristic with synthetic pdf.js items (standard PDF fonts can't encode ○).
  check('radio bullets (○) become individually labelled tickable fields', await page.evaluate(() => {
    const H = 320, W = 420, fs = 16;
    const vp = { transform: [1, 0, 0, -1, 0, H], width: W, height: H };
    const item = (str, x, top, width) => ({ str, width, transform: [fs, 0, 0, fs, x, H - (top + fs)] });
    const labels = (arr) => arr.filter((f) => f.type === 'check').map((f) => f.label);
    const joined = labels(window.PFS.detect.heuristicForPage([
      item('○ male', 40, 90, 60), item('○ female', 160, 90, 70), item('○ resident', 40, 140, 90)
    ], W, H, vp, 0));
    const split = labels(window.PFS.detect.heuristicForPage([
      item('○', 40, 200, 12), item('male', 58, 200, 40), item('○', 160, 200, 12), item('female', 178, 200, 48)
    ], W, H, vp, 0));
    return joined.length === 3 && joined.some((l) => /male/i.test(l)) && joined.some((l) => /female/i.test(l)) && joined.some((l) => /resident/i.test(l))
      && split.length === 2 && split.some((l) => /male/i.test(l)) && split.some((l) => /female/i.test(l));
  }));

  // handwriting BiDi: digits render left-to-right (0,5,4), not mirrored
  check('handwriting keeps numbers un-mirrored', await page.evaluate(async () => {
    const hw = window.PFS.handwriting, p = hw.getProfile();
    const bar = (a, b) => [[{ x: 0.5, y: a }, { x: 0.5, y: b }]];
    p.glyphs = { '0': { s: bar(.1, .9), y: 0, h: 1, a: .6, top: 0 }, '5': { s: bar(.3, .7), y: 0, h: 1, a: .6, top: 0 }, '4': { s: bar(.45, .55), y: 0, h: 1, a: .6, top: 0 } };
    hw.saveProfile(p);
    const url = hw.renderText('054', { fontPx: 80, color: '#000', beautify: false }).url;
    const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = url; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; const cols = [];
    for (let xx = 0; xx < c.width; xx++) { let n = 0; for (let y = 0; y < c.height; y++) { const i = (y * c.width + xx) * 4; if (d[i + 3] > 40 && d[i] < 128) n++; } cols.push(n); }
    const bars = []; let i = 0; while (i < cols.length) { if (cols[i] > 2) { let m = 0; while (i < cols.length && cols[i] > 2) { m = Math.max(m, cols[i]); i++; } bars.push(m); } else i++; }
    return bars.length === 3 && bars[0] > bars[1] && bars[1] > bars[2]; // tall,med,short = 0,5,4
  }));

  // theme + enhance + help
  await page.evaluate(() => { document.getElementById('themeBtn').click(); document.getElementById('themeBtn').click(); });
  check('dark theme; document pages stay white', await page.evaluate(() => document.documentElement.getAttribute('data-theme') === 'dark' && getComputedStyle(document.querySelector('.page-wrap')).backgroundColor === 'rgb(255, 255, 255)'));
  await page.evaluate(() => document.getElementById('enhanceBtn').click());
  check('scan-enhance filter applies', await page.evaluate(() => getComputedStyle(document.querySelector('canvas.pdf')).filter.includes('contrast')));
  await page.keyboard.press('?'); await page.waitForTimeout(250);
  check('help panel opens on "?"', await page.evaluate(() => document.getElementById('helpModal').classList.contains('show')));
  await page.keyboard.press('Escape');

  // signature: draw + place
  await page.evaluate(() => document.querySelectorAll('.modal-back.show').forEach((m) => m.classList.remove('show')));
  await page.evaluate(() => document.querySelector('[data-tab="assets"]').click());
  await page.evaluate(() => document.getElementById('drawSigBtn').click()); await page.waitForTimeout(400);
  const cb = await (await page.$('#sigCanvas')).boundingBox();
  await page.mouse.move(cb.x + 40, cb.y + 90); await page.mouse.down();
  await page.mouse.move(cb.x + 160, cb.y + 50, { steps: 8 }); await page.mouse.move(cb.x + 280, cb.y + 100, { steps: 8 }); await page.mouse.up();
  await page.click('#sigSave'); await page.waitForTimeout(400);
  const pb = await (await page.$('canvas.pdf')).boundingBox();
  await page.mouse.click(pb.x + pb.width * 0.4, pb.y + pb.height * 0.7); await page.waitForTimeout(500);
  check('signature places an image element', await page.evaluate(() => document.querySelectorAll('.el.image').length > 0));

  check('exporter library present', await page.evaluate(() => !!(window.PFS.exporter && window.PFS.exporter.exportPdf)));
  check('no uncaught JS errors during run', jsErrors.length === 0);
  jsErrors.forEach((e) => console.log('    ! ' + e));

  await browser.close(); server.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
