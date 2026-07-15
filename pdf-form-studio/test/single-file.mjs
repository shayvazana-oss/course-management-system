/* single-file.mjs — smoke test for the built single-file app (the Artifact).
 *
 * The main e2e suite serves the source tree over http; this one opens the
 * INLINED build (dist/pdf-form-studio.html) straight from file:// — the way a
 * published Artifact runs — and asserts every module inlined correctly, core
 * APIs work, and nothing throws. Catches build/inlining regressions the source
 * suite can't see. Run: `node build.mjs && node test/single-file.mjs`.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist', 'pdf-form-studio.html');

function findChromium() {
  const cands = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return null;
}

const results = [];
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? '✓' : '✗'} ${name}`); };

async function main() {
  if (!fs.existsSync(DIST)) { console.error('dist not built — run `node build.mjs` first'); process.exit(2); }
  const exe = findChromium();
  if (!exe) { console.error('No Chromium found. Set PW_CHROMIUM=/path/to/chrome'); process.exit(2); }

  const browser = await chromium.launch({ executablePath: exe });
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 800 } })).newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await page.goto('file://' + DIST, { waitUntil: 'load' });
  await page.waitForTimeout(1400);

  check('single-file: libraries + PFS inlined and loaded', await page.evaluate(() => !!(window.PFS && window.pdfjsLib && window.PDFLib)));
  check('single-file: flagged as single-file (no SW/manifest)', await page.evaluate(() => window.PFS_SINGLE_FILE === true));
  check('single-file: no external resource references', !/(src|href)=["']https?:\/\//i.test(fs.readFileSync(DIST, 'utf8')));
  check('single-file: vault categories present (health_fund)', await page.evaluate(() => window.PFS.vault.matchKey('קופת חולים') === 'health_fund'));
  check('single-file: amount-in-words works', await page.evaluate(() => window.PFS.numwords.shekels(100.5) === 'מאה שקלים וחמישים אגורות'));
  check('single-file: detect + exporter present', await page.evaluate(() => !!(window.PFS.detect.heuristicForPage && window.PFS.exporter.exportPdf)));
  check('single-file: quick-setup + rotate + attach controls present', await page.evaluate(() => !!(document.getElementById('quickSetupBtn') && document.getElementById('rotateBtn') && document.getElementById('attachBtn'))));

  // build a tiny PDF in-page with the inlined PDFLib and render it — exercises
  // pdf.js main-thread worker + canvas render end to end from file://
  check('single-file: renders a PDF from file://', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const doc = await PDFDocument.create(); doc.addPage([300, 400]);
    const b64 = btoa(String.fromCharCode(...await doc.save()));
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], 't.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.getElementById('pdfInput');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1600));
    return document.querySelectorAll('canvas.pdf').length > 0;
  }));

  check('single-file: no uncaught JS errors', errs.length === 0);
  errs.forEach((e) => console.log('    ! ' + e));

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} single-file checks passed`);
  process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
