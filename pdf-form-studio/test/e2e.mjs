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
    const checks = (arr) => arr.filter((f) => f.type === 'check');
    const joined = checks(window.PFS.detect.heuristicForPage([
      item('○ male', 40, 90, 60), item('○ female', 160, 90, 70), item('☐ agree', 40, 140, 90)
    ], W, H, vp, 0));
    const split = checks(window.PFS.detect.heuristicForPage([
      item('○', 40, 200, 12), item('male', 58, 200, 40), item('○', 160, 200, 12), item('female', 178, 200, 48)
    ], W, H, vp, 0));
    const L = (a) => a.map((f) => f.label);
    const labelsOk = L(joined).length === 3 && L(joined).some((l) => /male/i.test(l)) && L(joined).some((l) => /female/i.test(l)) && L(joined).some((l) => /agree/i.test(l))
      && split.length === 2 && L(split).some((l) => /male/i.test(l)) && L(split).some((l) => /female/i.test(l));
    // the two same-line round bullets share one radio group; the square doesn't
    const maleG = joined.find((f) => /male/i.test(f.label)).group;
    const femaleG = joined.find((f) => /female/i.test(f.label)).group;
    const squareG = joined.find((f) => /agree/i.test(f.label)).group;
    const groupOk = maleG && maleG === femaleG && !squareG;
    return labelsOk && groupOk;
  }));

  // radio semantics in the panel: picking one same-group option clears the other
  check('same-line radio options are mutually exclusive on the form', await page.evaluate(() => {
    const det = { tier: 'text', fields: [
      { page: 0, fieldKey: 'check_male', label: 'male', fx: 0.1, fy: 0.2, fw: 0.03, fh: 0.03, fontFrac: 0.03, type: 'check', radio: true, group: '0_r1' },
      { page: 0, fieldKey: 'check_female', label: 'female', fx: 0.4, fy: 0.2, fw: 0.03, fh: 0.03, fontFrac: 0.03, type: 'check', radio: true, group: '0_r1' }
    ] };
    window.PFS.__test.fieldsPanel.show(det);
    const radios = [...document.querySelectorAll('#fieldsBody input[type=radio]')];
    if (radios.length !== 2) return false;
    radios[0].checked = true; radios[0].dispatchEvent(new Event('change', { bubbles: true }));
    radios[1].checked = true; radios[1].dispatchEvent(new Event('change', { bubbles: true }));
    // after picking the 2nd, the 1st must have been cleared, and exactly one
    // check element sits on the form (not two).
    const marks = window.PFS.__test.overlay.getElements().filter((e) => e.model.kind === 'check').length;
    return radios[0].checked === false && radios[1].checked === true && marks === 1;
  }));

  // selection memory: a saved gender auto-ticks the matching radio option and
  // never the opposite one — memory extends to choices, not just text.
  check('saved gender auto-selects the matching radio option', await page.evaluate(() => {
    const det = { tier: 'text', fields: [
      { page: 0, fieldKey: 'check_zachar', label: 'זכר', fx: 0.1, fy: 0.3, fw: 0.03, fh: 0.03, fontFrac: 0.03, type: 'check', radio: true, group: '0_g1' },
      { page: 0, fieldKey: 'check_nekeva', label: 'נקבה', fx: 0.4, fy: 0.3, fw: 0.03, fh: 0.03, fontFrac: 0.03, type: 'check', radio: true, group: '0_g1' }
    ] };
    const sel = window.PFS.vault.matchChecks(det.fields, { 'מין': 'זכר' }, []);
    window.PFS.__test.fieldsPanel.show(det, sel);
    const byLabel = {};
    [...document.querySelectorAll('#fieldsBody .field')].forEach((row) => {
      const lab = row.querySelector('label')?.textContent; const inp = row.querySelector('input[type=radio]');
      if (lab && inp) byLabel[lab] = inp.checked;
    });
    // a form mark exists for the chosen option, none for the rejected one
    const keys = window.PFS.__test.overlay.getElements().filter((e) => e.model.kind === 'check').map((e) => e.model.fieldKey);
    const markOk = keys.includes('check_zachar') && !keys.includes('check_nekeva');
    return sel.check_zachar === true && !sel.check_nekeva && byLabel['זכר'] === true && byLabel['נקבה'] === false && markOk;
  }));

  // learn-from-hand: manually ticking a gender option is remembered, so the
  // NEXT form auto-selects it without any typing or profile setup.
  check('manually picked gender is learned and reused on the next form', await page.evaluate(() => {
    window.PFS.store.set('remembered_choices', {});   // start clean
    const det = { tier: 'text', fields: [
      { page: 0, fieldKey: 'g_m', label: 'זכר', fx: 0.1, fy: 0.5, fw: 0.03, fh: 0.03, fontFrac: 0.03, type: 'check', radio: true, group: '0_m1' },
      { page: 0, fieldKey: 'g_f', label: 'נקבה', fx: 0.4, fy: 0.5, fw: 0.03, fh: 0.03, fontFrac: 0.03, type: 'check', radio: true, group: '0_m1' }
    ] };
    window.PFS.__test.fieldsPanel.show(det);
    const male = document.querySelectorAll('#fieldsBody input[type=radio]')[0];
    male.checked = true; male.dispatchEvent(new Event('change', { bubbles: true }));
    const rc = window.PFS.store.get('remembered_choices', {});
    // a different form later — matchChecks with the learned choice ticks זכר
    const later = [{ fieldKey: 'x_m', label: 'זכר', type: 'check', radio: true, group: 'p_1' },
                   { fieldKey: 'x_f', label: 'נקבה', type: 'check', radio: true, group: 'p_1' }];
    const sel = window.PFS.vault.matchChecks(later, rc, []);
    return !!rc.gender && sel.x_m === true && !sel.x_f;
  }));

  // signature line → one-tap places the saved signature right on that line
  check('detected signature line offers one-tap signature placement', await page.evaluate(() => {
    // a saved signature to place (1x1 transparent PNG is enough for the model)
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    window.PFS.store.set('signatures', [{ id: 's1', url: png, w: 300, h: 100, aspect: 3 }]);
    const det = { tier: 'text', fields: [
      { page: 0, fieldKey: 'sig', label: 'חתימה', fx: 0.55, fy: 0.8, fw: 0.3, fh: 0.04, fontFrac: 0.03, type: 'text' }
    ] };
    window.PFS.__test.fieldsPanel.show(det);
    const btn = [...document.querySelectorAll('#fieldsBody button')].find((b) => b.textContent === '✍️');
    if (!btn) return false;
    const before = window.PFS.__test.overlay.getElements().filter((e) => e.model.kind === 'signature').length;
    btn.click();
    const after = window.PFS.__test.overlay.getElements().filter((e) => e.model.kind === 'signature');
    const placed = after.length === before + 1;
    // it landed near the detected signature line, not a guessed corner
    const near = placed && Math.abs(after[after.length - 1].model.fy - 0.8) < 0.1;
    return placed && near;
  }));

  // stamp / seal line → one-tap places the saved stamp on it (mirrors ✍️)
  check('detected stamp line offers one-tap stamp placement', await page.evaluate(() => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    window.PFS.store.set('stamps', [{ id: 't1', url: png, w: 200, h: 200, aspect: 1 }]);
    const det = { tier: 'text', fields: [
      { page: 0, fieldKey: 'stamp', label: 'חותמת', fx: 0.15, fy: 0.75, fw: 0.25, fh: 0.06, fontFrac: 0.03, type: 'text' }
    ] };
    window.PFS.__test.fieldsPanel.show(det);
    const btn = [...document.querySelectorAll('#fieldsBody button')].find((b) => b.textContent === '⬤');
    if (!btn) return false;
    const before = window.PFS.__test.overlay.getElements().filter((e) => e.model.kind === 'stamp').length;
    btn.click();
    const after = window.PFS.__test.overlay.getElements().filter((e) => e.model.kind === 'stamp');
    return after.length === before + 1 && Math.abs(after[after.length - 1].model.fy - 0.75) < 0.12;
  }));

  // Fill-All lands the signature on the detected signature line (fy≈0.62),
  // not the guessed corner (fy 0.82), when detection found one.
  check('Fill-All places signature on the detected line, not a corner', await page.evaluate(() => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    window.PFS.store.set('signatures', [{ id: 's9', url: png, w: 300, h: 100, aspect: 3 }]);
    window.PFS.__test.overlay.clearElements();
    // seed the app's last-detection with a signature line partway up the page
    window.PFS.__test.setLastDet({ tier: 'text', fields: [
      { page: 0, fieldKey: 'sg', label: 'חתימת המבקש', fx: 0.5, fy: 0.62, fw: 0.3, fh: 0.04, fontFrac: 0.03, type: 'text' }
    ] });
    window.PFS.__test.fillAll();
    const sig = window.PFS.__test.overlay.getElements().filter((e) => e.model.kind === 'signature');
    return sig.length === 1 && Math.abs(sig[0].model.fy - 0.62) < 0.12;
  }));

  // one combined address fills separate city / house-no / zip fields
  check('combined address auto-splits into עיר / מספר בית / מיקוד', await page.evaluate(() => {
    const pa = window.PFS.vault.parseAddress('רחוב הרצל 15, תל אביב 6100000');
    const parseOk = pa.house_no === '15' && pa.zip === '6100000' && /תל אביב/.test(pa.city) && /הרצל/.test(pa.street);
    // and it flows through matchValues into the separate detected fields
    const fields = [
      { fieldKey: 'a', label: 'כתובת', type: 'text' },
      { fieldKey: 'c', label: 'עיר', type: 'text' },
      { fieldKey: 'h', label: 'מספר בית', type: 'text' },
      { fieldKey: 'z', label: 'מיקוד', type: 'text' }
    ];
    const out = window.PFS.vault.matchValues(fields, { 'כתובת': 'רחוב הרצל 15, תל אביב 6100000' }, []);
    const fillOk = /הרצל/.test(out.a) && /תל אביב/.test(out.c) && out.h === '15' && out.z === '6100000';
    return parseOk && fillOk;
  }));

  // a saved full name fills separate first/last fields (and vice-versa)
  check('full name splits into first / last name fields', await page.evaluate(() => {
    const fields = [{ fieldKey: 'f', label: 'שם פרטי', type: 'text' }, { fieldKey: 'l', label: 'שם משפחה', type: 'text' }];
    const out = window.PFS.vault.matchValues(fields, { 'שם מלא': 'משה בן ישראל' }, []);
    return out.f === 'משה' && out.l === 'בן ישראל';
  }));

  // profile field suggestions surface the new canonical keys, and each maps
  // to a canon so it actually auto-fills once set
  check('profile suggestions expose gender / name / address parts', await page.evaluate(() => {
    const opts = [...document.querySelectorAll('#fieldKeyList option')].map((o) => o.value);
    const has = ['gender', 'first_name', 'last_name', 'house_no', 'zip', 'birth_date'].every((k) => opts.includes(k));
    const resolves = ['gender', 'first_name', 'last_name', 'house_no', 'zip', 'birth_date'].every((k) => !!window.PFS.vault.matchKey(k));
    return has && resolves;
  }));

  // live validation flags a bad email / phone and clears once corrected
  check('email & phone typos are flagged live, cleared when fixed', await page.evaluate(() => {
    const det = { tier: 'text', fields: [
      { fieldKey: 'em', label: 'דוא״ל', type: 'text' }, { fieldKey: 'ph', label: 'טלפון', type: 'text' }
    ] };
    window.PFS.__test.fieldsPanel.show(det);
    const inputs = [...document.querySelectorAll('#fieldsBody input[type=text]')];
    const em = inputs.find((i) => i.__fkey === 'em'), ph = inputs.find((i) => i.__fkey === 'ph');
    if (!em || !ph) return false;
    const type = (el, val) => { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); };
    // a flagged field gets a non-empty warning title + danger border; a valid
    // one clears both
    type(em, 'not-an-email'); const emBad = em.title !== '' && em.style.borderColor !== '';
    type(em, 'me@example.com'); const emOk = em.title === '' && em.style.borderColor === '';
    type(ph, '1234567'); const phBad = ph.title !== '';      // 7 digits, no leading 0
    type(ph, '0501234567'); const phOk = ph.title === '';
    return emBad && emOk && phBad && phOk;
  }));

  // quick personal-details setup writes canonical values that drive auto-fill
  check('quick setup saves details that then auto-fill a form', await page.evaluate(() => {
    document.getElementById('quickSetupBtn').click();     // opens + prefills
    const set = (id, v) => { document.getElementById(id).value = v; };
    set('qsFullName', 'משה ישראלי'); set('qsId', '123456782'); set('qsPhone', '0501234567');
    set('qsEmail', 'me@example.com'); set('qsAddress', 'רחוב הרצל 15, תל אביב 6100000');
    document.querySelector('input[name="qsGender"][value="זכר"]').checked = true;
    document.getElementById('qsSave').click();
    const profs = window.PFS.store.get('profiles', []);
    const active = profs.find((p) => p.id === window.PFS.store.get('active_profile', null)) || profs[0];
    const vals = (active && active.values) || {};
    const saved = vals['שם מלא'] === 'משה ישראלי' && vals['תעודת זהות'] === '123456782'
      && vals['מין'] === 'זכר' && vals['טלפון'] === '0501234567' && vals['דוא״ל'] === 'me@example.com';
    // the saved details drive both text auto-fill and gender auto-tick
    const det = { fields: [{ fieldKey: 'nm', label: 'שם מלא', type: 'text' }, { fieldKey: 'gm', label: 'זכר', type: 'check', radio: true, group: 'g' }] };
    const text = window.PFS.vault.matchValues(det.fields, vals, []);
    const checks = window.PFS.vault.matchChecks(det.fields, vals, []);
    return saved && text.nm === 'משה ישראלי' && checks.gm === true;
  }));

  // required-field detection: "* " / "חובה" marks a field required, the label
  // is cleaned, a red * shows, and requiredEmpty() counts only blank requireds
  check('required (*) fields are detected, marked and counted', await page.evaluate(() => {
    const H = 300, W = 420, fs = 16;
    const vp = { transform: [1, 0, 0, -1, 0, H], width: W, height: H };
    const item = (str, x, top, width) => ({ str, width, transform: [fs, 0, 0, fs, x, H - (top + fs)] });
    // "שם מלא: *" on one line (label + blank), and an optional "הערות:" line
    const fields = window.PFS.detect.heuristicForPage([
      item('שם מלא: *', 250, 60, 90), item('הערות:', 250, 110, 70)
    ], W, H, vp, 0);
    const req = fields.find((f) => /שם מלא/.test(f.label));
    const opt = fields.find((f) => /הערות/.test(f.label));
    const detOk = req && req.required === true && !/[*＊]/.test(req.label) && opt && !opt.required;
    if (!detOk) return false;
    // render and check the marker + requiredEmpty count (both blank → 1 required)
    window.PFS.__test.fieldsPanel.show({ tier: 'text', fields });
    const hasStar = [...document.querySelectorAll('#fieldsBody label span')].some((s) => s.textContent.trim() === '*');
    const reqEmpty = window.PFS.__test.fieldsPanel.requiredEmpty();
    return hasStar && reqEmpty === 1;
  }));

  // per-page rotation is baked into the exported PDF's /Rotate, for both a page
  // that has overlay elements and one that doesn't — round-tripped via pdf-lib
  check('page rotation is written into the exported PDF', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.create(); src.addPage([300, 400]); src.addPage([300, 400]);
    const bytes = await src.save();
    const models = [{ page: 0, type: 'text', kind: 'text', fx: 0.1, fy: 0.1, fw: 0.4, fh: 0.05, fontFrac: 0.03, text: 'שלום', color: '#000', align: 'right' }];
    const out = await window.PFS.exporter.exportPdf(bytes, models, { rotations: { 0: 90, 1: 180 } });
    const re = await PDFDocument.load(out);
    return re.getPage(0).getRotation().angle === 90 && re.getPage(1).getRotation().angle === 180;
  }));

  // rotating in the viewer swaps the page canvas dims and records the angle
  check('rotate turns the page in the viewer and records it for export', await page.evaluate(async () => {
    const c = document.querySelector('canvas.pdf');
    const w0 = parseInt(c.style.width, 10), h0 = parseInt(c.style.height, 10);
    if (w0 === h0) return true; // square page — swap not observable, skip
    await window.PFS.__test.pdfView.rotatePage(0, 90);
    const c2 = document.querySelector('canvas.pdf');
    const swapped = parseInt(c2.style.width, 10) === h0 && parseInt(c2.style.height, 10) === w0;
    const recorded = window.PFS.__test.pdfView.getRotations()[0] === 90;
    await window.PFS.__test.pdfView.rotatePage(0, 270); // restore to 0 for later tests
    return swapped && recorded;
  }));

  // Hebrew number-to-words correctness across the tricky cases
  check('Hebrew amount-in-words is correct', await page.evaluate(() => {
    const w = window.PFS.numwords.words;
    const cases = {
      0: 'אפס', 1: 'אחד', 2: 'שניים', 10: 'עשרה', 11: 'אחד עשר', 15: 'חמישה עשר',
      20: 'עשרים', 21: 'עשרים ואחד', 23: 'עשרים ושלושה', 100: 'מאה', 101: 'מאה ואחד',
      123: 'מאה עשרים ושלושה', 200: 'מאתיים', 300: 'שלוש מאות', 999: 'תשע מאות תשעים ותשעה',
      1000: 'אלף', 1001: 'אלף ואחד', 2000: 'אלפיים', 3000: 'שלושת אלפים',
      1234: 'אלף מאתיים שלושים וארבעה', 10000: 'עשרת אלפים', 21000: 'עשרים ואחד אלף', 100000: 'מאה אלף'
    };
    const sh = window.PFS.numwords.shekels;
    const shekelsOk = sh(1) === 'שקל אחד' && sh(1234) === 'אלף מאתיים שלושים וארבעה שקלים חדשים'
      && sh(100.5) === 'מאה שקלים וחמישים אגורות' && sh(1.05) === 'שקל אחד וחמש אגורות'
      && sh(2.01) === 'שני שקלים ואגורה אחת';
    return Object.keys(cases).every((k) => w(+k) === cases[k]) && shekelsOk;
  }));

  // typing an amount auto-fills the "סכום במילים" field with the words
  check('amount auto-fills the amount-in-words field', await page.evaluate(() => {
    const det = { tier: 'text', fields: [
      { fieldKey: 'amt', label: 'סכום', type: 'text' }, { fieldKey: 'amtw', label: 'סכום במילים', type: 'text' }
    ] };
    window.PFS.__test.fieldsPanel.show(det);
    const inputs = [...document.querySelectorAll('#fieldsBody input[type=text]')];
    const amt = inputs.find((i) => i.__fkey === 'amt'), amtw = inputs.find((i) => i.__fkey === 'amtw');
    if (!amt || !amtw) return false;
    amt.value = '1234'; amt.dispatchEvent(new Event('input', { bubbles: true }));
    return amtw.value === 'אלף מאתיים שלושים וארבעה שקלים חדשים';
  }));

  // business numbers (ח.פ / עוסק) resolve and validate with the ID checksum
  check('business number (ח.פ / עוסק) is validated like an ID', await page.evaluate(() => {
    const mk = window.PFS.vault.matchKey;
    const resolves = mk('עוסק מורשה') === 'business_id' && mk('ח.פ') === 'business_id' && mk('שם העסק') === 'business_name';
    window.PFS.__test.fieldsPanel.show({ tier: 'text', fields: [{ fieldKey: 'hp', label: 'ח.פ', type: 'text' }] });
    const inp = [...document.querySelectorAll('#fieldsBody input[type=text]')].find((i) => i.__fkey === 'hp');
    if (!inp) return false;
    const type = (v) => { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); };
    type('123456789'); const bad = inp.title !== '' && inp.style.borderColor !== '';   // fails checksum
    type('123456782'); const ok = inp.title === '' && inp.style.borderColor === '';    // valid checksum
    return resolves && bad && ok;
  }));

  // marital status is a single-choice like gender: saved value auto-ticks the
  // matching option and never the others; a manual pick is classified/learned
  check('saved marital status auto-selects the matching option', await page.evaluate(() => {
    const later = [
      { fieldKey: 'm1', label: 'רווק', type: 'check', radio: true, group: 'ms' },
      { fieldKey: 'm2', label: 'נשוי', type: 'check', radio: true, group: 'ms' },
      { fieldKey: 'm3', label: 'גרוש', type: 'check', radio: true, group: 'ms' }
    ];
    const sel = window.PFS.vault.matchChecks(later, { 'מצב משפחתי': 'נשוי' }, []);
    const cls = window.PFS.vault.classifyChoice('נשואה'); // cross-form / different spelling
    return sel.m2 === true && !sel.m1 && !sel.m3 && cls && cls.canon === 'marital_status'
      && window.PFS.vault.matchKey('מצב משפחתי') === 'marital_status';
  }));

  // load failures get specific, actionable messages (password / corrupt / other)
  check('PDF load errors give specific, actionable messages', await page.evaluate(() => {
    const lm = window.PFS.__test.loadErrorMessage;
    const pw = lm({ name: 'PasswordException' });
    const bad = lm({ name: 'InvalidPDFException' });
    const other = lm({ message: 'boom' });
    return /סיסמה/.test(pw) && /פגום/.test(bad) && /נכשלה/.test(other) && pw !== bad && bad !== other;
  }));

  // health fund (קופת חולים) is another learned single-choice (Form 101)
  check('saved health fund auto-selects the matching option', await page.evaluate(() => {
    const opts = [
      { fieldKey: 'h1', label: 'כללית', type: 'check', radio: true, group: 'hf' },
      { fieldKey: 'h2', label: 'מכבי', type: 'check', radio: true, group: 'hf' },
      { fieldKey: 'h3', label: 'מאוחדת', type: 'check', radio: true, group: 'hf' },
      { fieldKey: 'h4', label: 'לאומית', type: 'check', radio: true, group: 'hf' }
    ];
    const sel = window.PFS.vault.matchChecks(opts, { 'קופת חולים': 'מכבי' }, []);
    const cls = window.PFS.vault.classifyChoice('כללית');
    return sel.h2 === true && !sel.h1 && !sel.h3 && !sel.h4
      && cls && cls.canon === 'health_fund' && window.PFS.vault.matchKey('קופת חולים') === 'health_fund';
  }));

  // saving quick-setup re-applies to the OPEN form's detected fields at once
  check('quick-setup save instantly ticks a detected gender option', await page.evaluate(() => {
    window.PFS.store.set('remembered_choices', {}); // isolate: only the saved profile drives it
    window.PFS.__test.setLastDet({ tier: 'text', fields: [
      { page: 0, fieldKey: 'qg_m', label: 'זכר', fx: 0.1, fy: 0.3, fw: 0.03, fh: 0.03, fontFrac: 0.03, type: 'check', radio: true, group: '0_qg' },
      { page: 0, fieldKey: 'qg_f', label: 'נקבה', fx: 0.4, fy: 0.3, fw: 0.03, fh: 0.03, fontFrac: 0.03, type: 'check', radio: true, group: '0_qg' }
    ] });
    document.getElementById('quickSetupBtn').click();
    document.querySelector('input[name="qsGender"][value="זכר"]').checked = true;
    document.getElementById('qsSave').click();
    const byLabel = {};
    [...document.querySelectorAll('#fieldsBody .field')].forEach((r) => {
      const l = r.querySelector('label') && r.querySelector('label').textContent.trim();
      const i = r.querySelector('input[type=radio]');
      if (l && i) byLabel[l] = i.checked;
    });
    return byLabel['זכר'] === true && byLabel['נקבה'] === false;
  }));

  // attachments (e.g. a photo of an ID) are appended as extra pages on export
  check('attachments are appended as pages in the exported PDF', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.create(); src.addPage([300, 400]); src.addPage([300, 400]);
    const bytes = await src.save();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const out = await window.PFS.exporter.exportPdf(bytes, [], { attachments: [{ url: png, type: 'image/png' }, { url: png, type: 'image/png' }] });
    return (await PDFDocument.load(out)).getPageCount() === 4; // 2 original + 2 attachments
  }));

  // a PDF attachment appends ALL its pages (supporting docs are often PDFs)
  check('PDF attachments append all their pages on export', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const base = await PDFDocument.create(); base.addPage([300, 400]);
    const baseBytes = await base.save();
    const donor = await PDFDocument.create(); donor.addPage([200, 200]); donor.addPage([200, 200]); donor.addPage([200, 200]);
    const donorBytes = await donor.save();
    const out = await window.PFS.exporter.exportPdf(baseBytes, [], { attachments: [{ kind: 'pdf', bytes: donorBytes }] });
    return (await PDFDocument.load(out)).getPageCount() === 4; // 1 base + 3 donor pages
  }));

  // removePages drops pages from the export, but never leaves an empty document
  check('removePages drops pages on export (keeps at least one)', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const d = await PDFDocument.create(); d.addPage([200, 200]); d.addPage([200, 200]); d.addPage([200, 200]);
    const bytes = await d.save();
    const c1 = (await PDFDocument.load(await window.PFS.exporter.exportPdf(bytes, [], { removePages: [1] }))).getPageCount();
    const c2 = (await PDFDocument.load(await window.PFS.exporter.exportPdf(bytes, [], { removePages: [0, 1, 2] }))).getPageCount();
    return c1 === 2 && c2 === 1; // one removed → 2; all removed → clamped to 1
  }));

  // deleting a page in the viewer hides it and records it for export exclusion
  check('deleting a page hides it and marks it for export exclusion', await page.evaluate(() => {
    const pv = window.PFS.__test.pdfView;
    const before = pv.visiblePageCount();
    if (before < 2) return true; // single-page fixture — nothing to delete
    const last = before - 1;      // delete the LAST page so page 0 stays for later tests
    const ok = pv.deletePage(last);
    return ok && pv.visiblePageCount() === before - 1 && pv.getRemovedPages().includes(last);
  }));

  // per-form memory remembers page rotation + deletion, so a straightened/
  // trimmed form reopens the same way
  check('templates remember and restore page rotation + deletion', await page.evaluate(() => {
    let appliedRot = null, appliedRemoved = null, appliedOrder = null;
    const t = window.PFS.createTemplates({
      getElements: () => [{ type: 'text', kind: 'text', page: 0, fx: 0.1, fy: 0.1, fw: 0.2, fh: 0.05, fontFrac: 0.03, text: 'x' }],
      getRotations: () => ({ 0: 90 }),
      getRemovedPages: () => [2],
      getPageOrder: () => [1, 0],
      applyModels: () => {},
      applyRotations: (r) => { appliedRot = r; },
      applyRemovedPages: (a) => { appliedRemoved = a; },
      applyPageOrder: (o) => { appliedOrder = o; },
      afterApply: () => {}
    });
    t.save('__pageops_test__', null);
    const saved = window.PFS.store.get('templates', []).find((x) => x.name === '__pageops_test__');
    const savedOk = saved && saved.rotations && saved.rotations[0] === 90 && Array.isArray(saved.removePages) && saved.removePages[0] === 2
      && Array.isArray(saved.pageOrder) && saved.pageOrder.join(',') === '1,0';
    if (savedOk) t.apply(saved.id);
    if (saved) t.remove(saved.id);
    return savedOk && appliedRot && appliedRot[0] === 90 && appliedRemoved && appliedRemoved[0] === 2 && appliedOrder && appliedOrder.join(',') === '1,0';
  }));

  // reordering pages updates the display order, flags isReordered, and reverses
  check('reordering pages updates order and is reversible', await page.evaluate(() => {
    const pv = window.PFS.__test.pdfView;
    if (pv.visiblePageCount() < 2) return true; // single visible page — nothing to reorder
    const before = pv.getPageOrder().join(',');
    const moved = pv.movePage(pv.getPageOrder()[0], 1);   // send the first page later
    const reordered = pv.isReordered() && pv.getPageOrder().join(',') !== before;
    pv.movePage(pv.getPageOrder()[1], -1);                // move it back to restore
    const restored = pv.getPageOrder().join(',') === before && !pv.isReordered();
    return moved && reordered && restored;
  }));

  // undo now covers page operations, not just overlay edits
  check('undo reverts a page rotation', await page.evaluate(async () => {
    const pv = window.PFS.__test.pdfView, T = window.PFS.__test;
    T.snapshotNow();                                   // clean checkpoint of the current state
    const before = JSON.stringify(pv.getPageState());
    await pv.rotatePage(0, 90);
    T.snapshotNow();
    const rotated = pv.getPageState().rotations[0] === 90;
    T.undo();                                           // back to the checkpoint
    const undone = JSON.stringify(pv.getPageState());
    return rotated && undone === before;
  }));

  // impossible dates (day 32, month 13, non-leap 29 Feb) are flagged live
  check('invalid dates are flagged, valid ones cleared', await page.evaluate(() => {
    window.PFS.__test.fieldsPanel.show({ tier: 'text', fields: [{ fieldKey: 'bd', label: 'תאריך לידה', type: 'text' }] });
    const inp = [...document.querySelectorAll('#fieldsBody input[type=text]')].find((i) => i.__fkey === 'bd');
    if (!inp) return false;
    const type = (v) => { inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); };
    type('32/01/1990'); const b1 = inp.title !== '';   // day 32
    type('29/02/2021'); const b2 = inp.title !== '';   // 2021 not a leap year
    type('15/13/1990'); const b3 = inp.title !== '';   // month 13
    type('15/03/1990'); const ok = inp.title === '';   // valid
    return b1 && b2 && b3 && ok;
  }));

  // pageOrder reorders (and can drop) pages in the exported PDF — proven by the
  // per-page widths landing in the requested order
  check('pageOrder reorders pages in the exported PDF', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const d = await PDFDocument.create();
    d.addPage([300, 400]); d.addPage([310, 400]); d.addPage([320, 400]);
    const bytes = await d.save();
    const re = await PDFDocument.load(await window.PFS.exporter.exportPdf(bytes, [], { pageOrder: [2, 0, 1] }));
    const w = [0, 1, 2].map((i) => Math.round(re.getPage(i).getSize().width));
    const reordered = re.getPageCount() === 3 && w[0] === 320 && w[1] === 300 && w[2] === 310;
    // pageOrder also drops omitted pages (reorder + delete in one)
    const re2 = await PDFDocument.load(await window.PFS.exporter.exportPdf(bytes, [], { pageOrder: [2, 0] }));
    const dropped = re2.getPageCount() === 2 && Math.round(re2.getPage(0).getSize().width) === 320;
    return reordered && dropped;
  }));

  // reorder + rotation together: a page's rotation survives the reorder copy path
  check('reorder preserves page rotation in the export', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const d = await PDFDocument.create(); d.addPage([300, 400]); d.addPage([310, 400]);
    const bytes = await d.save();
    // rotate original page 0 by 90 and reorder to [1,0]
    const re = await PDFDocument.load(await window.PFS.exporter.exportPdf(bytes, [], { rotations: { 0: 90 }, pageOrder: [1, 0] }));
    // output index 1 is original page 0 → must still carry the 90° rotation
    return re.getPageCount() === 2 && Math.round(re.getPage(0).getSize().width) === 310 && re.getPage(1).getRotation().angle === 90;
  }));

  // mail-merge is now as smart as interactive fill: an address column fills
  // split city/zip fields, and a סכום column fills a סכום-במילים field per record
  check('mail-merge derives split + amount-in-words fields per record', await page.evaluate(() => {
    const models = [
      { type: 'text', fieldKey: 'כתובת' }, { type: 'text', fieldKey: 'עיר' }, { type: 'text', fieldKey: 'מיקוד' },
      { type: 'text', fieldKey: 'סכום' }, { type: 'text', fieldKey: 'סכום במילים' }
    ];
    const out = window.PFS.merge.applyRecord(models, { 'כתובת': 'רחוב הרצל 15, תל אביב 6100000', 'סכום': '1234' });
    const b = {}; out.forEach((m) => { b[m.fieldKey] = m.text; });
    return /תל אביב/.test(b['עיר']) && b['מיקוד'] === '6100000' && /הרצל/.test(b['כתובת']) && /אלף מאתיים/.test(b['סכום במילים']);
  }));

  // whiteout/redact places a filled-rectangle element
  check('whiteout tool places a filled rectangle element', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay;
    const before = ov.getElements().length;
    ov.addElementAt('whiteout', 0, 0.2, 0.2, {});
    const rect = ov.getElements().find((e) => e.model.kind === 'whiteout');
    return ov.getElements().length === before + 1 && rect && rect.model.type === 'rect' && rect.model.color === '#ffffff';
  }));

  // a redact rectangle is actually painted into the exported PDF (center → black)
  check('redact rectangle is drawn into the exported PDF', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const d = await PDFDocument.create(); d.addPage([200, 200]);
    const bytes = await d.save();
    const models = [{ type: 'rect', kind: 'redact', page: 0, fx: 0.25, fy: 0.25, fw: 0.5, fh: 0.5, color: '#000000' }];
    const out = await window.PFS.exporter.exportPdf(bytes, models, {});
    const doc = await window.pdfjsLib.getDocument({ data: out }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const px = c.getContext('2d').getImageData(Math.floor(vp.width / 2), Math.floor(vp.height / 2), 1, 1).data;
    return px[0] < 60 && px[1] < 60 && px[2] < 60; // center pixel is black → redacted
  }));

  // a highlight is a semi-transparent yellow box — the content shows through
  check('highlight is semi-transparent yellow in the export', await page.evaluate(async () => {
    const { PDFDocument, rgb } = window.PDFLib;
    const d = await PDFDocument.create(); const pg0 = d.addPage([200, 200]);
    pg0.drawRectangle({ x: 0, y: 0, width: 200, height: 200, color: rgb(1, 1, 1) }); // white bg
    const bytes = await d.save();
    const hl = { type: 'rect', kind: 'highlight', page: 0, fx: 0.25, fy: 0.25, fw: 0.5, fh: 0.5, color: '#ffe600', opacity: 0.35 };
    const out = await window.PFS.exporter.exportPdf(bytes, [hl], {});
    const doc = await window.pdfjsLib.getDocument({ data: out }).promise;
    const p = await doc.getPage(1); const vp = p.getViewport({ scale: 1 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    const px = c.getContext('2d').getImageData(Math.floor(vp.width / 2), Math.floor(vp.height / 2), 1, 1).data;
    // yellow-ish (R,G high, B low) AND lighter than pure yellow (semi-transparent over white)
    return px[0] > 200 && px[1] > 200 && px[2] < 220 && px[2] > 120;
  }));

  // secure/flat export rasterizes every page → no extractable text (true redaction)
  check('secure export produces an image-only PDF (no extractable text)', await page.evaluate(async () => {
    // the fixture (already loaded) has a real text layer; flatten it and confirm
    // the output has no selectable text
    const bytes = await window.PFS.__test.buildFlattenedBytes();
    if (!bytes || !bytes.length) return false;
    const doc = await window.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      text += tc.items.map((it) => it.str).join('');
    }
    // pages still render (image), but there is zero extractable text
    return doc.numPages >= 1 && text.trim().length === 0;
  }));

  // image attachments are downscaled + JPEG so a big photo doesn't bloat the PDF
  check('large image attachments are downscaled to a shareable JPEG', await page.evaluate(() => {
    const big = document.createElement('canvas'); big.width = 4000; big.height = 3000;
    const ctx = big.getContext('2d'); ctx.fillStyle = '#3366cc'; ctx.fillRect(0, 0, 4000, 3000);
    const out = window.PFS.imageTools.downscaleToJpeg(big, 1800, 0.85);
    return out.w <= 1800 && out.h <= 1800 && /^data:image\/jpeg/.test(out.url) && out.url.length < big.toDataURL('image/png').length;
  }));

  // secure export composes with page order/deletion (via `order`) + attachments
  check('secure export respects page order and appends attachments', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    // synthetic base renderer: page idx → a white canvas of height 100+idx*20
    const renderBase = async (idx) => {
      const c = document.createElement('canvas'); c.width = 100; c.height = 100 + idx * 20;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      return { canvas: c, wPt: 100, hPt: 100 + idx * 20 };
    };
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const out = await window.PFS.exporter.exportFlattenedPdf({
      order: [2, 0], models: [], attachments: [{ url: png, type: 'image/png' }], renderBase
    });
    const re = await PDFDocument.load(out);
    // order [2,0] → 2 rendered pages (first is idx 2 → height 140) + 1 attachment
    return re.getPageCount() === 3 && Math.round(re.getPage(0).getSize().height) === 140;
  }));

  // repeat mode: a sticky tool stays armed across placements; non-sticky disarms
  check('repeat mode keeps a tool armed for multiple placements', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay;
    const overlayEl = document.querySelector('.page-wrap .overlay');
    if (!overlayEl || !ov.isPlacing) return false;
    const place = () => overlayEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    ov.setPlacing({ sticky: false, create: () => null });
    place();
    const disarmed = ov.isPlacing() === false;         // one shot → disarmed
    ov.setPlacing({ sticky: true, create: () => null });
    place(); place();
    const stillArmed = ov.isPlacing() === true;         // stays armed
    ov.setPlacing(null);                                // cleanup
    return disarmed && stillArmed;
  }));

  // rect elements (highlight) survive serialize→apply (templates/backup) with
  // their color AND opacity intact — else a saved highlight would turn opaque
  check('highlight rect round-trips through serialize/apply with opacity', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay;
    ov.clearElements();
    ov.addElementAt('highlight', 0, 0.3, 0.3, {});
    const ser = ov.serialize();
    const hl = ser.find((m) => m.kind === 'highlight');
    const serOk = hl && hl.type === 'rect' && Math.abs(hl.opacity - 0.35) < 0.01 && hl.color === '#ffe600';
    ov.clearElements();
    ov.applyModels(ser);
    const el = ov.getElements().find((e) => e.model.kind === 'highlight');
    const restoredOk = el && el.model.type === 'rect' && Math.abs(el.model.opacity - 0.35) < 0.01 && el.model.color === '#ffe600';
    ov.clearElements();
    return serOk && restoredOk;
  }));

  // text style memory: styling one field is remembered and applied to the next
  check('text style is remembered and applied to new text', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay, T = window.PFS.__test;
    ov.clearElements();
    T.rememberTextStyle({ fontFrac: 0.05, color: '#ff0000', bold: true, align: 'left' });
    const ls = T.getLastTextStyle();
    ov.addElementAt('text', 0, 0.2, 0.2, Object.assign({ text: 'x' }, ls));
    const el = ov.getElements().find((e) => e.model.text === 'x');
    ov.clearElements();
    return ls && ls.color === '#ff0000' && el && el.model.color === '#ff0000'
      && Math.abs(el.model.fontFrac - 0.05) < 0.001 && el.model.bold === true && el.model.align === 'left';
  }));

  // calculated fields: the safe formula evaluator over other fields' values
  check('formula evaluator computes over field references (safe)', await page.evaluate(() => {
    const F = window.PFS.formula;
    const v = { qty: '3', price: '10.5', a: '100', b: '50', c: '25', amount: '1,200' };
    return F.isFormula('=[qty]*[price]') && !F.isFormula('nope')
      && F.evaluate('=[qty]*[price]', v) === '31.5'
      && F.evaluate('=sum([a],[b],[c])', v) === '175'
      && F.evaluate('=[a]-[b]', v) === '50'
      && F.evaluate('=([a]+[b])/2', v) === '75'
      && F.evaluate('=[amount]*2', v) === '2400'   // strips the comma
      && F.evaluate('=max([a],[b],[c])', v) === '100'
      && F.evaluate('=min([b],[c])', v) === '25'
      && F.evaluate('=avg([b],[c])', v) === '37.5'   // (50+25)/2
      && F.evaluate('=round([price])', v) === '11'    // round(10.5)
      && F.evaluate('=[a]+xyz', v) === ''             // stray identifiers can't resolve → safe
      && F.evaluate('=[a]', {}) === '0';
  }));

  // a calculated field auto-updates from the fields it references
  check('a calculated field auto-updates from other fields', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay;
    ov.clearElements();
    ov.addElementAt('text', 0, 0.1, 0.1, { text: '100', fieldKey: 'a' });
    ov.addElementAt('text', 0, 0.2, 0.2, { text: '50', fieldKey: 'b' });
    ov.addElementAt('text', 0, 0.3, 0.3, { text: '', fieldKey: 'total', formula: '=sum([a],[b])' });
    const totalText = () => { const e = ov.getElements().find((x) => x.model.fieldKey === 'total'); return e ? e.model.text : null; };
    window.PFS.__test.recomputeFormulas();
    const t1 = totalText();                       // snapshot: 150
    ov.getElements().find((e) => e.model.fieldKey === 'a').model.text = '200'; // change an input
    window.PFS.__test.recomputeFormulas();
    const t2 = totalText();                       // follows: 250
    ov.clearElements();
    return t1 === '150' && t2 === '250';
  }));

  // number/currency formatting for a computed value (₪ / thousands / %)
  check('calculated field can format as currency / number / percent', await page.evaluate(() => {
    const F = window.PFS.formula;
    const currencyOk = F.format('1234.5', 'currency') === '₪1,234.50';
    const numberOk = F.format('1234.5', 'number') === '1,234.5';
    const pctOk = F.format('12.5', 'percent') === '12.5%';
    // end to end: a formatted computed total
    const ov = window.PFS.__test.overlay; ov.clearElements();
    ov.addElementAt('text', 0, 0.1, 0.1, { text: '1000', fieldKey: 'x' });
    ov.addElementAt('text', 0, 0.2, 0.2, { text: '234.5', fieldKey: 'y' });
    ov.addElementAt('text', 0, 0.3, 0.3, { text: '', fieldKey: 'tot', formula: '=sum([x],[y])', format: 'currency' });
    window.PFS.__test.recomputeFormulas();
    const tot = ov.getElements().find((e) => e.model.fieldKey === 'tot');
    const liveOk = tot && tot.model.text === '₪1,234.50';
    ov.clearElements();
    return currencyOk && numberOk && pctOk && liveOk;
  }));

  // mail-merge computes calculated fields per record (batch invoices etc.)
  check('mail-merge computes calculated fields per record', await page.evaluate(() => {
    const models = [
      { type: 'text', fieldKey: 'qty' }, { type: 'text', fieldKey: 'price' },
      { type: 'text', fieldKey: 'total', formula: '=[qty]*[price]', format: 'currency' }
    ];
    const r1 = window.PFS.merge.applyRecord(models, { qty: '3', price: '10' });
    const r2 = window.PFS.merge.applyRecord(models, { qty: '5', price: '4.5' });
    const t1 = r1.find((m) => m.fieldKey === 'total').text;
    const t2 = r2.find((m) => m.fieldKey === 'total').text;
    return t1 === '₪30.00' && t2 === '₪22.50';
  }));

  // letter-spacing (align typed text to per-character boxes): canvas supports it,
  // it's applied in display, and it round-trips through serialize
  check('letter-spacing for boxed fields — canvas + display + serialize', await page.evaluate(() => {
    const x = document.createElement('canvas').getContext('2d');
    const canvasSupport = ('letterSpacing' in x);        // needed for the export
    const ov = window.PFS.__test.overlay; ov.clearElements();
    ov.addElementAt('text', 0, 0.1, 0.1, { text: '123456789', letterSpacing: 0.8, fieldKey: 'idbox' });
    const ser = ov.serialize().find((m) => m.fieldKey === 'idbox');
    const el = ov.getElements().find((e) => e.model.fieldKey === 'idbox');
    const applied = el && el.node.querySelector('.txt').style.letterSpacing;
    ov.clearElements();
    return canvasSupport && ser && Math.abs(ser.letterSpacing - 0.8) < 0.01 && applied && applied !== '' && applied !== '0px';
  }));

  check('validate flags malformed id/phone/email/date, accepts valid', await page.evaluate(() => {
    const V = window.PFS.validate;
    const badId = !V.field('id', '123456789').ok;          // fails checksum
    const goodId = V.field('id', '000000018').ok;           // passes checksum
    const badMail = !V.field('email', 'foo@bar').ok;
    const goodMail = V.field('email', 'a@b.co').ok;
    const badPhone = !V.field('phone', '1234567').ok;   // 7 digits, no leading 0
    const goodPhone = V.field('phone', '0501234567').ok;
    const badDate = !V.field('birth_date', '31/02/1990').ok; // no Feb 31
    const goodDate = V.field('date', '15/03/2020').ok;
    const empty = V.field('id', '').ok && V.field('phone', '').ok; // never nag on empty
    // sweep maps free fieldKeys → canon and collects only the bad ones
    const sweep = V.scan([
      { key: 'תעודת זהות', value: '123456789' },
      { key: 'email', value: 'a@b.co' },
      { key: 'טלפון', value: '999' }
    ]);
    const sweepOk = sweep.length === 1 && sweep[0].key === 'תעודת זהות';
    return badId && goodId && badMail && goodMail && badPhone && goodPhone && badDate && goodDate && empty && sweepOk;
  }));

  check('arrow keys nudge the selected element (shift = bigger step)', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay; ov.clearElements();
    const c = ov.addElementAt('text', 0, 0.4, 0.4, { text: 'x', fieldKey: 'nudge', noEdit: true });
    ov.selectCtrl(c);
    document.body.focus();
    const fire = (key, shift) => document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: !!shift, bubbles: true }));
    const x0 = c.model.fx, y0 = c.model.fy;
    fire('ArrowRight'); const dx = c.model.fx - x0;               // ~+0.002
    fire('ArrowDown', true); const dy = c.model.fy - y0;          // ~+0.01 (shift)
    ov.clearElements();
    return Math.abs(dx - 0.002) < 1e-6 && Math.abs(dy - 0.01) < 1e-6;
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
