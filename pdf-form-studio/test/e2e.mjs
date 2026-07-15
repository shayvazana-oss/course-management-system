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
    return Object.keys(cases).every((k) => w(+k) === cases[k]) && window.PFS.numwords.shekels(1) === 'שקל אחד';
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
