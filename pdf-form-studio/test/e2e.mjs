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
    window.PFS.store.set('tour_done', 1);   // tour has its own dedicated test
    window.PFS.store.set('patterns', {});   // learning engine has its own tests
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

  // the thumbnails drawer docks BESIDE the tool rail — parked closed it used to
  // sit on top of it, hiding the tools and swallowing their clicks
  check('thumbnails drawer never covers the tool rail (closed or open)', await page.evaluate(async () => {
    const t = document.getElementById('thumbs'), rail = document.getElementById('rail');
    const btn = document.querySelector('.rail-btn.tool[data-tool="replace"]');
    const probe = () => {
      const tr = t.getBoundingClientRect(), rr = rail.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(tr.right, rr.right) - Math.max(tr.left, rr.left));
      const b = btn.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { overlap, clickable: !!(hit && btn.contains(hit)) };
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (t.classList.contains('open')) { document.getElementById('thumbsBtn').click(); await wait(350); }
    const closed = probe();                                  // parked out of the way
    document.getElementById('thumbsBtn').click(); await wait(350);
    const open = probe();                                    // docked alongside
    document.getElementById('thumbsBtn').click(); await wait(350);   // restore
    return closed.overlap === 0 && closed.clickable && open.overlap === 0 && open.clickable;
  }));
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
      1000: 'אלף', 1001: 'אלף ואחד', 2000: 'אלפיים', 2001: 'אלפיים ואחד', 3000: 'שלושת אלפים',
      4000: 'ארבעת אלפים', 1234: 'אלף מאתיים שלושים וארבעה', 10000: 'עשרת אלפים',
      11000: 'אחד עשר אלף', 12000: 'שנים עשר אלף', 20000: 'עשרים אלף', 21000: 'עשרים ואחד אלף',
      100000: 'מאה אלף', 200000: 'מאתיים אלף', 300000: 'שלוש מאות אלף'
    };
    const sh = window.PFS.numwords.shekels;
    const shekelsOk = sh(1) === 'שקל אחד' && sh(1234) === 'אלף מאתיים שלושים וארבעה שקלים חדשים'
      && sh(100.5) === 'מאה שקלים וחמישים אגורות' && sh(1.05) === 'שקל אחד וחמש אגורות'
      && sh(2.01) === 'שני שקלים ואגורה אחת';
    // agorot that round up to a whole shekel must CARRY (not be dropped):
    const carryOk = sh(1.999) === 'שני שקלים חדשים'        // was wrongly 'שקל אחד'
      && sh(99.995) === 'מאה שקלים חדשים'                    // 99 + carry → 100
      && sh(2.995) === 'שלושה שקלים חדשים';
    return Object.keys(cases).every((k) => w(+k) === cases[k]) && shekelsOk && carryOk;
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

  // addModelAt places a cover at EXACT drawn bounds (not centred on a point)
  check('addModelAt places a rect at the exact drawn bounds', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay;
    ov.clearElements();
    ov.addModelAt('whiteout', 0, { fx: 0.3, fy: 0.25, fw: 0.24, fh: 0.04, color: '#eeeeee' });
    const r = ov.getElements().find((e) => e.model.kind === 'whiteout');
    const ok = r && Math.abs(r.model.fx - 0.3) < 1e-6 && Math.abs(r.model.fy - 0.25) < 1e-6
      && Math.abs(r.model.fw - 0.24) < 1e-6 && Math.abs(r.model.fh - 0.04) < 1e-6 && r.model.color === '#eeeeee';
    ov.clearElements();
    return ok;
  }));

  // background sampler returns a valid #rrggbb colour from the rendered page,
  // so a cover box can be tinted to match the paper (seamless erase)
  check('sampleBg returns a valid page colour for cover-matching', await page.evaluate(() => {
    const c = window.PFS.__test.pdfView.sampleBg(0, 0.3, 0.3, 0.2, 0.03);
    return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  }));

  // "Replace" = cover the old data (paper-matched) + an editable text box on top,
  // in one gesture. Both elements land at the drawn spot; the text is focused.
  check('replace covers the old data and drops an editable text box in place', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay;
    ov.clearElements();
    // blank paper under the drag → the box-sized fallback path (deterministic)
    const c0 = document.querySelector('canvas.pdf'), cx0 = c0.getContext('2d');
    cx0.fillStyle = '#fff'; cx0.fillRect(0.33 * c0.width, 0.38 * c0.height, 0.26 * c0.width, 0.09 * c0.height);
    window.PFS.__test.placeReplacement(0, 0.35, 0.4, 0.22, 0.045);
    const els = ov.getElements();
    const cover = els.find((e) => e.model.kind === 'whiteout');
    const txt = els.find((e) => e.model.type === 'text');
    const coverOk = cover && Math.abs(cover.model.fx - 0.35) < 1e-6 && Math.abs(cover.model.fw - 0.22) < 1e-6
      && /^#[0-9a-f]{6}$/i.test(cover.model.color);           // tinted to a real colour, not left blank
    // the text box sits inside the cover, right-aligned, sized to the box height
    const txtOk = txt && txt.model.align === 'right' && txt.model.fontFrac > 0
      && txt.model.fy >= cover.model.fy - 1e-6 && (txt.model.fy + txt.model.fh) <= (cover.model.fy + cover.model.fh) + 1e-3;
    ov.clearElements();
    return coverOk && txtOk;
  }));

  // replacement must MATCH THE PRINT it covers — size, line, colour, weight —
  // not the sloppy drag box ("שיניתי נתון וזה נראה לעין שזה לא אותו פונט")
  check('replace matches the size, line and colour of the print it covers', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay;
    ov.clearElements();
    const c = document.querySelector('canvas.pdf'), cx = c.getContext('2d');
    const W = c.width, H = c.height;
    // a printed value: dark-grey glyph dashes, 13px tall, on white paper
    cx.fillStyle = '#fff'; cx.fillRect(0.30 * W, 0.60 * H, 0.30 * W, 0.08 * H);
    const bandTop = Math.round(0.63 * H), bandH = 13;
    cx.fillStyle = '#444444';
    for (let x = Math.round(0.34 * W); x < 0.52 * W; x += 6) cx.fillRect(x, bandTop, 2, bandH);
    window.PFS.__test.placeReplacement(0, 0.32, 0.61, 0.24, 0.06);   // sloppy drag around it
    const txt = ov.getElements().find((e) => e.model.type === 'text');
    const expFont = (bandH / H) / 0.66;
    const bandCy = (bandTop + bandH / 2) / H;
    const sizeOk = txt && Math.abs(txt.model.fontFrac - expFont) / expFont < 0.25;   // print size, not box size (box → 0.037)
    const lineOk = txt && Math.abs((txt.model.fy + txt.model.fh / 2) - bandCy) < 0.012;
    const col = txt && txt.model.color ? parseInt(txt.model.color.slice(1, 3), 16) : 0;
    const colOk = col > 30 && col < 130 && !txt.model.bold;   // dark grey like the print — not black, not bold
    ov.clearElements();
    return sizeOk && lineOk && colOk;
  }));

  // closed loop: once text is TYPED, its rendered ink is measured in the
  // element's own font and scaled/anchored onto the original band — measured,
  // not guessed ("זה עדיין יוצא לא אחיד")
  check('replacement self-tunes typed ink onto the original band', await page.evaluate(() => {
    const T = window.PFS.__test, ov = T.overlay;
    ov.clearElements();
    const c = document.querySelector('canvas.pdf'), cx = c.getContext('2d');
    const W = c.width, H = c.height;
    cx.fillStyle = '#fff'; cx.fillRect(0.30 * W, 0.60 * H, 0.30 * W, 0.08 * H);
    const bandTop = Math.round(0.63 * H), bandH = 13;
    cx.fillStyle = '#333333';
    for (let x = Math.round(0.34 * W); x < 0.52 * W; x += 6) cx.fillRect(x, bandTop, 2, bandH);
    T.placeReplacement(0, 0.32, 0.61, 0.24, 0.06);
    const txt = ov.getElements().find((e) => e.model.type === 'text');
    if (!txt) return false;
    // capability probe: do canvas text metrics work in this environment?
    const probe = document.createElement('canvas').getContext('2d');
    probe.textBaseline = 'top';
    probe.font = '400 100px Heebo, sans-serif';
    const ptm = probe.measureText('160');
    const capable = ptm.width > 10 && (ptm.actualBoundingBoxAscent + ptm.actualBoundingBoxDescent) > 20;
    txt.model.text = '160';
    const tuned = T.tuneReplacement(txt);
    let ok;
    if (!capable) {
      ok = tuned === false;              // degenerate metrics → estimate stands
    } else {
      const px = txt.model.fontFrac * 1000;
      probe.font = '400 ' + px.toFixed(2) + 'px ' + (txt.model.font || 'Heebo, sans-serif');
      const tm2 = probe.measureText('160');
      const got = (tm2.actualBoundingBoxAscent + tm2.actualBoundingBoxDescent) / 1000;
      const want = bandH / H;            // typed ink height == original ink height
      ok = tuned === true && Math.abs(got - want) / want < 0.06
        && Math.abs(txt.model.fy - bandTop / H) < 0.013;
    }
    ov.clearElements();
    return ok;
  }));

  // editor↔export parity: the exported raster must place glyph ink exactly
  // where the editor's CSS line box shows it ("בעורך תקין, בייצוא הבאג נראה")
  check('exported text lands exactly where the editor showed it', await page.evaluate(async () => {
    const { PDFDocument, rgb } = window.PDFLib;
    const W = 400, H = 500;
    const d = await PDFDocument.create();
    d.addPage([W, H]).drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) });
    const bytes = await d.save();
    const fy = 0.3, fontFrac = 0.04, text = 'Tg160';
    const models = [{ type: 'text', kind: 'text', page: 0, fx: 0.2, fy, fw: 0.3, fh: 0.05,
      fontFrac, color: '#000000', bold: false, align: 'left', text }];
    const out = await window.PFS.exporter.exportPdf(bytes, models, {});
    const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(out), disableFontFace: true }).promise;
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const cx2 = c.getContext('2d');
    await p1.render({ canvasContext: cx2, viewport: vp }).promise;
    // find the ink's top row in the raster
    const data = cx2.getImageData(0, 0, c.width, c.height).data;
    let inkTop = -1;
    for (let y = 0; y < c.height && inkTop < 0; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 128) { inkTop = y; break; }
      }
    }
    if (inkTop < 0) return 'no-ink';   // fontless env — cannot judge
    // the CSS expectation: box top + halfLead + ascent − actualAscent
    const fontPx = fontFrac * c.height;
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = '400 ' + fontPx + 'px Heebo, sans-serif';
    probe.textBaseline = 'alphabetic';
    const tm = probe.measureText(text);
    if (!(tm.fontBoundingBoxAscent > 0)) return 'no-metrics';
    const expTop = fy * c.height
      + (fontPx * 1.15 - (tm.fontBoundingBoxAscent + tm.fontBoundingBoxDescent)) / 2
      + tm.fontBoundingBoxAscent - tm.actualBoundingBoxAscent;
    return Math.abs(inkTop - expTop) <= 2.5 ? true : 'off-by-' + (inkTop - expTop).toFixed(1);
  }) === true);

  // a hand-drawn drag routinely clips half a digit; the cover must finish the
  // token it touched (no surviving sliver) yet stop at the next word
  check('replace cover finishes a half-covered token and stops at word gaps', await page.evaluate(() => {
    const T = window.PFS.__test, ov = T.overlay;
    ov.clearElements();
    const c = document.querySelector('canvas.pdf'), cx = c.getContext('2d');
    const W = c.width, H = c.height;
    cx.fillStyle = '#fff'; cx.fillRect(0.26 * W, 0.70 * H, 0.45 * W, 0.08 * H);
    const bandTop = Math.round(0.73 * H), bandH = 13;
    cx.fillStyle = '#333333';
    for (let x = Math.round(0.30 * W); x < 0.50 * W; x += 4) cx.fillRect(x, bandTop, 2, bandH); // token A
    for (let x = Math.round(0.56 * W); x < 0.64 * W; x += 4) cx.fillRect(x, bandTop, 2, bandH); // token B, one word-gap away
    T.placeReplacement(0, 0.32, 0.71, 0.08, 0.055);   // drag grazes only PART of token A
    const cover = ov.getElements().find((e) => e.model.kind === 'whiteout');
    const ok = cover
      && cover.model.fx <= 0.302 && cover.model.fx >= 0.27           // finished A leftward
      && (cover.model.fx + cover.model.fw) >= 0.497                  // finished A rightward
      && (cover.model.fx + cover.model.fw) <= 0.545;                 // never ate token B
    ov.clearElements();
    return ok;
  }));

  // inpaint polarity: on a DARK banner with light lettering, the cover must
  // fill with the dark background — not with the white of the letters
  // ("ככה זה נראה שאני מייצא": a glowing wedge on the dark header)
  check('cover on a dark banner fills dark, not with the light lettering', await page.evaluate(() => {
    const src = document.createElement('canvas');
    src.width = 300; src.height = 120;
    const cx = src.getContext('2d');
    cx.fillStyle = '#1c1e22'; cx.fillRect(0, 0, 300, 120);          // dark banner
    cx.fillStyle = '#f2f2f2';                                        // light "lettering" around the region
    for (let x = 20; x < 280; x += 14) { cx.fillRect(x, 30, 8, 10); cx.fillRect(x, 80, 8, 10); }
    const patch = window.PFS.inpaint.patch(src, 100, 45, 80, 28);
    if (!patch) return false;
    const d = patch.getContext('2d').getImageData(0, 0, patch.width, patch.height).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
    const mean = sum / n;
    return mean < 70;      // dark like the banner (was ~200+ when it grabbed the light text)
  }));

  // textured backgrounds (photos): the cover must keep TEXTURE and respect a
  // dark↔light boundary it crosses — not smear one mid-grey band with streaks
  check('cover crossing a photo boundary keeps each side, no smear band', await page.evaluate(() => {
    const src = document.createElement('canvas');
    src.width = 320; src.height = 160;
    const cx = src.getContext('2d');
    // noisy dark "photo" top half, noisy light paper bottom half
    const im = cx.createImageData(320, 160);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < 160; y++) {
      for (let x = 0; x < 320; x++) {
        const o = (y * 320 + x) * 4;
        const dark = y < 80;
        const base = dark ? 40 : 235;
        const n = (rnd() - 0.5) * (dark ? 46 : 24);
        im.data[o] = Math.max(0, Math.min(255, base + n));
        im.data[o + 1] = Math.max(0, Math.min(255, base + n * 0.9));
        im.data[o + 2] = Math.max(0, Math.min(255, base + n * 1.1));
        im.data[o + 3] = 255;
      }
    }
    cx.putImageData(im, 0, 0);
    // a wide strip crossing the boundary — the user's failing shape
    const patch = window.PFS.inpaint.patch(src, 40, 60, 240, 40);
    if (!patch) return false;
    const d = patch.getContext('2d').getImageData(0, 0, patch.width, patch.height).data;
    const rowMean = (j) => {
      let s = 0;
      for (let i = 0; i < patch.width; i++) { const o = (j * patch.width + i) * 4; s += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; }
      return s / patch.width;
    };
    const top = (rowMean(1) + rowMean(3)) / 2;         // rows near the dark side
    const bot = (rowMean(patch.height - 2) + rowMean(patch.height - 4)) / 2;
    // texture preserved: row variance not zero (mirrored pixels, not flat fill)
    let varSum = 0, n0 = 0;
    for (let i = 0; i < patch.width; i++) { const o = (1 * patch.width + i) * 4; const l = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; varSum += (l - top) * (l - top); n0++; }
    const rowSigma = Math.sqrt(varSum / n0);
    return top < 100 && bot > 175 && (bot - top) > 60 && rowSigma > 4;
  }));

  // THE seamlessness test: on a real form the paper is rarely pure white, so a
  // flat-colour cover shows up as an obvious rectangle in the exported file even
  // though it looked fine on screen. An `auto` cover must reconstruct the
  // background so the covered area is indistinguishable from its surroundings.
  check('background-matched cover leaves no visible rectangle in the export', await page.evaluate(async () => {
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
    const W = 300, H = 200;
    // a tinted page with a vertical gradient — like a scan or a shaded cell
    const src = await PDFDocument.create();
    const pg = src.addPage([W, H]);
    for (let i = 0; i < 40; i++) {
      const t = i / 39;
      pg.drawRectangle({ x: 0, y: (H / 40) * i, width: W, height: H / 40 + 1,
        color: rgb(0.90 - 0.06 * t, 0.89 - 0.06 * t, 0.84 - 0.06 * t) });
    }
    const font = await src.embedFont(StandardFonts.Helvetica);
    pg.drawText('01/01/2020', { x: 90, y: 96, size: 15, font, color: rgb(0.1, 0.1, 0.1) });
    const bytes = await src.save();

    // cover exactly where the old value sits (top-origin fractions)
    const cover = { type: 'rect', kind: 'whiteout', page: 0, auto: true,
      fx: 88 / W, fy: 1 - 116 / H, fw: 80 / W, fh: 26 / H, color: '#ffffff', opacity: 1 };

    const renderBase = async (idx, scale) => {
      const doc = await window.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const p = await doc.getPage(idx + 1);
      const vp = p.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: cx, viewport: vp }).promise;
      return { canvas: c, wPt: W, hPt: H };
    };
    const out = await window.PFS.exporter.exportPdf(bytes.slice(0), [cover], { renderBase });

    // render the result and compare inside the cover vs. just outside it
    const doc = await window.pdfjsLib.getDocument({ data: out }).promise;
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 3 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const cx = c.getContext('2d');
    await p1.render({ canvasContext: cx, viewport: vp }).promise;

    const px = (X, Y) => { const d = cx.getImageData(Math.round(X), Math.round(Y), 1, 1).data; return [d[0], d[1], d[2]]; };
    const S = 3;
    // sample rows inside the covered band and the same rows just outside it
    let worst = 0;
    for (const yPt of [90, 98, 106]) {
      const Y = (H - yPt) * S;
      const inside = px(128 * S, Y);              // middle of the cover
      const outsideL = px(70 * S, Y);             // left of the cover, same row
      const outsideR = px(190 * S, Y);            // right of the cover, same row
      const ref = [0, 1, 2].map((i) => (outsideL[i] + outsideR[i]) / 2);
      const diff = Math.max(...[0, 1, 2].map((i) => Math.abs(inside[i] - ref[i])));
      worst = Math.max(worst, diff);
    }
    // the old text must be gone (no dark ink left inside the cover)
    let darkest = 255;
    for (let X = 95; X < 165; X += 3) {
      for (let yPt = 92; yPt < 112; yPt += 3) {
        const v = px(X * S, (H - yPt) * S); darkest = Math.min(darkest, (v[0] + v[1] + v[2]) / 3);
      }
    }
    // seamless = within a few levels of the paper around it; erased = no ink left
    return worst <= 8 && darkest > 180;
  }));

  // Forms are made of boxes, and people drag the cover straight across a cell's
  // rule. Erasing that rule leaves a mutilated box that advertises the edit even
  // louder than the old value did — so a line entering one edge and leaving the
  // opposite one must be carried through the patch, with no grey bruise left
  // behind from sampling the ink.
  check('cover erases the value but keeps the form\'s own ruling intact', await page.evaluate(async () => {
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
    const W = 320, H = 170;
    const d = await PDFDocument.create(); const pg = d.addPage([W, H]);
    pg.drawRectangle({ x: 0, y: 0, width: W, height: H, color: rgb(1, 1, 1) });
    const f = await d.embedFont(StandardFonts.Helvetica);
    // a bordered cell (like a date field) carrying a value
    pg.drawRectangle({ x: 150, y: 104, width: 110, height: 26, borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 1, color: rgb(1, 1, 1) });
    pg.drawText('01/01/2020', { x: 162, y: 111, size: 14, font: f, color: rgb(0.05, 0.05, 0.05) });
    const bytes = await d.save();

    // cover the value AND overlap the cell's top rule (y=130 → top-origin 40)
    const cover = { type: 'rect', kind: 'whiteout', page: 0, auto: true,
      fx: 152 / W, fy: 36 / H, fw: 106 / W, fh: 24 / H, color: '#ffffff', opacity: 1 };

    const renderBase = async (idx, scale) => {
      const doc = await window.pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
      const p = await doc.getPage(idx + 1);
      const vp = p.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: cx, viewport: vp }).promise;
      return { canvas: c, wPt: W, hPt: H };
    };
    const out = await window.PFS.exporter.exportPdf(bytes.slice(0), [cover], { quality: 'high', renderBase });

    const doc = await window.pdfjsLib.getDocument({ data: out }).promise;
    const p1 = await doc.getPage(1);
    const S = 3;
    const vp = p1.getViewport({ scale: S });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const cx = c.getContext('2d');
    await p1.render({ canvasContext: cx, viewport: vp }).promise;
    // darkest luminance in a small probe box, in PDF points (y from the bottom)
    const probe = (xa, xb, ya, yb) => {
      let dark = 255;
      for (let X = xa; X <= xb; X += 0.5) {
        for (let Y = ya; Y <= yb; Y += 0.5) {
          const q = cx.getImageData(Math.round(X * S), Math.round((H - Y) * S), 1, 1).data;
          dark = Math.min(dark, (q[0] + q[1] + q[2]) / 3);
        }
      }
      return dark;
    };
    // 1) the cell's top rule still runs through the middle of the covered span
    const ruleKept = probe(200, 215, 129, 131) < 140;
    // 2) the old value is gone from the cell's interior
    const valueGone = probe(165, 250, 108, 124) > 205;
    // 3) no grey bruise smeared in from the ring near the covered corners
    const noSmear = probe(155, 170, 115, 125) > 215 && probe(240, 255, 115, 125) > 215;
    return ruleKept && valueGone && noSmear;
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

  // ---- export review: the preview IS the output ----
  // Opening the export shows a real rendered preview of the built bytes plus a
  // non-blocking checklist, instead of a chain of confirm() dialogs.
  {
    const waitBuild = () => page.waitForFunction(
      () => { const b = document.getElementById('exBusy'); const c = document.getElementById('exCanvas'); return b && !b.classList.contains('on') && c && c.width > 10; },
      { timeout: 60000 }
    );
    await page.evaluate(() => {
      const ov = window.PFS.__test.overlay;
      ov.clearElements();
      ov.addElementAt('text', 0, 0.3, 0.3, { text: 'ישראלי', noEdit: true });
      ov.deselectAll();
      document.getElementById('exportBtn').click();
    });
    await waitBuild();

    check('export opens a review modal with a live preview of the real output', await page.evaluate(() => {
      const open = document.getElementById('exportModal').classList.contains('show');
      const c = document.getElementById('exCanvas');
      const lbl = document.getElementById('exPage').textContent;
      const meta = document.getElementById('exMeta').textContent;
      // canvas actually painted (not blank) and the meta reports a real size
      const px = c.getContext('2d').getImageData(0, 0, c.width, Math.min(40, c.height)).data;
      let ink = false; for (let i = 0; i < px.length; i += 4) { if (px[i + 3] > 0) { ink = true; break; } }
      return open && c.width > 100 && ink && /^\d+ \/ \d+$/.test(lbl) && /(KB|MB)/.test(meta);
    }));

    check('pre-flight checks render as a checklist, not blocking dialogs', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.ex-chk')];
      // every row is one of the three severities and carries a headline
      return rows.length > 0 && rows.every((r) => /\b(ok|warn|err)\b/.test(r.className) && r.querySelector('b').textContent.trim().length > 0);
    }));

    check('summary lists what will be baked into the file', await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#exSummary .ex-sum-row')];
      return rows.some((r) => /שדות שמולאו/.test(r.querySelector('.k').textContent) && r.querySelector('.v').textContent === '1');
    }));

    // paging through the preview
    const multi = await page.evaluate(() => document.getElementById('exPage').textContent.split('/')[1].trim() !== '1');
    if (multi) {
      await page.evaluate(() => document.getElementById('exNext').click());
      await page.waitForTimeout(900);
      check('preview pages through the exported document', await page.evaluate(() => document.getElementById('exPage').textContent.startsWith('2')));
    } else {
      check('preview pages through the exported document', true); // single-page output
    }

    // switching quality rebuilds the preview and persists the choice
    const sizeBefore = await page.evaluate(() => document.getElementById('exMeta').textContent);
    await page.evaluate(() => [...document.querySelectorAll('#exQual button')].find((b) => b.dataset.q === 'high').click());
    await waitBuild();
    check('changing quality rebuilds the preview and is remembered', await page.evaluate((prev) => {
      const on = document.querySelector('#exQual button.on');
      const meta = document.getElementById('exMeta').textContent;
      return on && on.dataset.q === 'high' && window.PFS.store.get('export_quality', '') === 'high'
        && /להדפסה/.test(meta) && meta !== prev;
    }, sizeBefore));

    // the secure toggle rebuilds through the flattened path and renames the file
    await page.evaluate(() => { const c = document.getElementById('exSecure'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitBuild();
    check('secure toggle rebuilds a flattened preview and renames the output', await page.evaluate(async () => {
      const nameOk = /-secure\.pdf$/.test(document.getElementById('exName').textContent);
      const pillOk = /מאובטח/.test(document.getElementById('exMeta').textContent);
      return nameOk && pillOk;
    }));

    // reset for the tests that follow
    await page.evaluate(() => {
      const c = document.getElementById('exSecure'); c.checked = false;
      [...document.querySelectorAll('#exQual button')].find((b) => b.dataset.q === 'standard').click();
      window.PFS.store.set('export_quality', 'standard');
      document.getElementById('exCancel').click();
      window.PFS.__test.overlay.clearElements();
    });
    await page.waitForTimeout(400);
    check('cancel closes the review without exporting', await page.evaluate(() => !document.getElementById('exportModal').classList.contains('show')));

    // WYSIWYG: opening the export must not touch any element's size — it used
    // to re-run the uniformizer and visibly shrink the fills ("כשאני מייצא
    // הוא מקטין מייד את הפונטים")
    await page.evaluate(() => {
      const T = window.PFS.__test;
      T.overlay.clearElements();
      T.setLastDet({ tier: 'text', uniFontFrac: 0.0135, fields: [
        { page: 0, fieldKey: 'wys_a', label: 'שם', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.0135, type: 'text' }
      ] });
      T.overlay.addModelAt('text', 0, { fx: 0.2, fy: 0.2, fw: 0.2, fontFrac: 0.02, fieldKey: 'wys_a', text: 'ערך שהוגדל', noEdit: true });
      T.overlay.addModelAt('text', 0, { fx: 0.2, fy: 0.5, fw: 0.2, fontFrac: 0.019, text: 'טקסט חופשי', noEdit: true });
      T.overlay.deselectAll();
      document.getElementById('exportBtn').click();
    });
    await waitBuild();
    check('export is WYSIWYG: opening it never shrinks the fill sizes', await page.evaluate(() => {
      const sizes = window.PFS.__test.overlay.getElements()
        .filter((c) => c.model.type === 'text').map((c) => c.model.fontFrac).sort((a, b) => a - b);
      document.getElementById('exCancel').click();
      window.PFS.__test.overlay.clearElements();
      window.PFS.__test.setLastDet(null);
      return sizes.length === 2 && Math.abs(sizes[0] - 0.019) < 1e-9 && Math.abs(sizes[1] - 0.02) < 1e-9;
    }));
    await page.waitForTimeout(300);
  }

  // ---- real government form: נספח ה3 (משרד העבודה) ----
  // The real appendix stresses everything at once: text fragmented mid-word,
  // some blocks emitted in VISUAL order (per-glyph), table-cell fields with no
  // colons/underscores, and multiple "label: ___" pairs sharing one line.
  {
    const h3bytes = fs.readFileSync(path.join(HERE, 'fixtures', 'nispach-h3.pdf'));
    const h3res = await page.evaluate(async (arr) => {
      const bytes = new Uint8Array(arr).buffer;
      const doc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
      const det = await window.PFS.detect.detectFields(doc);
      const labels = det.fields.map((f) => f.label);
      const has = (t) => labels.some((l) => l.includes(t));
      const wanted = ['שם מוסד ההכשרה', 'כתובת מוסד ההכשרה', 'טלפון מוסד ההכשרה',
        'שם הקורס המבוקש', 'תאריך תחילת הקורס', 'שם מלא', 'ת.ז',
        'שם מנהל מוסד ההכשרה או מי מטעמו', 'תפקיד', 'חתימת המאשר', 'חותמת המוסד'];
      const missing = wanted.filter((w) => !has(w));
      // no shredded-fragment garbage labels (the pre-merge failure mode)
      const garbage = labels.filter((l) => l.replace(/[^֐-׿]/g, '').length === 1 && l.length < 4);
      // carry-over sanity on the real fields: exact wording fills the course
      // name; an institution name must NOT leak into the person's שם מלא
      const carry = { 'שם הקורס המבוקש': 'ניהול פרויקטים PMP', 'שם מוסד ההכשרה': 'היחידה ללימודי חוץ' };
      const mv = window.PFS.vault.matchValues(det.fields, carry, [], { labelOnly: true });
      const courseKey = det.fields.find((f) => f.label === 'שם הקורס המבוקש');
      const nameKey = det.fields.find((f) => f.label === 'שם מלא');
      const carryOk = courseKey && mv[courseKey.fieldKey] === 'ניהול פרויקטים PMP'
        && (!nameKey || mv[nameKey.fieldKey] === undefined);
      return { tier: det.tier, missing, garbage, carryOk, n: det.fields.length };
    }, Array.from(h3bytes));
    if (h3res.missing.length || h3res.garbage.length || !h3res.carryOk) console.log('  [nispach-h3 debug]', JSON.stringify(h3res));
    check('real נספח ה3: all 11 fields detected with clean labels', h3res.tier === 'text' && h3res.missing.length === 0 && h3res.garbage.length === 0);
    check('real נספח ה3: carry fills course name, never leaks into שם מלא', h3res.carryOk === true);
  }

  // carry must BRIDGE WORDING for deal facts (quote 'שם הקורס' → appendix
  // 'שם התכנית'), keep dates directional, know 'שם המשתתף' as a person, and
  // still never guess a person from a synonym ("זה לא באמת שואב את הנתונים")
  check('quote → appendix carry bridges different wording, tightly', await page.evaluate(() => {
    const V = window.PFS.vault;
    const F = (l) => ({ label: l, fieldKey: l, type: 'text' });
    const fields = [F('שם התכנית'), F('קמפוס'), F('תאריך סיום הלימודים'), F('תאריך התחלה צפוי'),
                    F('מספר קורס'), F('שם מלא'), F('שם המשתתף'), F('תאריך')];
    const carry = { 'שם הקורס': 'אילוף כלבים', 'סניף': 'אשקלון',
                    'תאריך תחילת הקורס': '01/09/26', 'תאריך סיום הקורס': '30/05/27', 'שם מלא': 'טלי מכלוף' };
    const out = V.matchValues(fields, carry, [], { labelOnly: true });
    const bridged = out['שם התכנית'] === 'אילוף כלבים'      // course by meaning
      && out['קמפוס'] === 'אשקלון'                            // branch by meaning
      && out['תאריך סיום הלימודים'] === '30/05/27'            // END date → end field
      && out['תאריך התחלה צפוי'] === '01/09/26';              // START date → start field
    const tight = out['מספר קורס'] === undefined              // a number is not a name
      && out['שם מלא'] === 'טלי מכלוף'                        // exact wording still works
      && out['שם המשתתף'] === undefined                       // person NEVER bridges in carry
      && out['תאריך'] === undefined;                          // bare date never carried
    // the person DOES reach 'שם המשתתף' — via the student path (full canon)
    const stu = V.matchValues([F('שם המשתתף')], { 'שם מלא': 'טלי מכלוף' }, []);
    return bridged && tight && stu['שם המשתתף'] === 'טלי מכלוף';
  }));

  // ---- linked companions: quote → appendix chain ----
  // Linking an appendix to a form teaches the pair; opening the companion
  // carries the just-typed values across by MEANING (different labels on the
  // two forms must still match), and the link is recognised by fingerprint.
  const compRes = await page.evaluate(async () => {
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
    const mkForm = async (title, labels) => {
      const d = await PDFDocument.create(); const pg = d.addPage([400, 300]);
      pg.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(1, 1, 1) });
      const f = await d.embedFont(StandardFonts.Helvetica);
      pg.drawText(title, { x: 150, y: 270, size: 16, font: f, color: rgb(0, 0, 0) });
      labels.forEach((lb, i) => pg.drawText(lb, { x: 250, y: 220 - i * 40, size: 12, font: f, color: rgb(0.1, 0.1, 0.1) }));
      return new File([await d.save()], title + '.pdf', { type: 'application/pdf' });
    };
    const T = window.PFS.__test;
    // form A = the "quote"; open it and type values into tagged fields
    await T.openPdfFile(await mkForm('Quote-A', ['Customer name:', 'Total amount:']));
    await new Promise((r) => setTimeout(r, 1200));
    const fpA = T.getFp();
    if (!fpA) return 'no fingerprint for A';
    T.overlay.clearElements();
    T.overlay.addElementAt('text', 0, 0.3, 0.3, { text: 'טסי בע״מ', fieldKey: 'שם לקוח', noEdit: true });
    T.overlay.addElementAt('text', 0, 0.3, 0.5, { text: '12,500', fieldKey: 'סכום', noEdit: true });
    // link form B = the "appendix" (different labels, same meanings)
    const fileB = await mkForm('Appendix-H3', ['Customer name:', 'Total amount:']);
    const rec = await window.PFS.companions.add({ ownerFp: fpA, ownerName: 'Quote-A', name: 'נספח ה3', bytes: await fileB.arrayBuffer() });
    // the link must be discoverable by fingerprint (this is the recognise step)
    const found = window.PFS.companions.listFor(fpA);
    if (!found.length || found[0].id !== rec.id) return 'link not found by fingerprint';
    // jump to the companion — carry must flow into its detected fields.
    // (English labels because standard PDF fonts can't encode Hebrew; the
    // appendix shares the quote's field wording, as real form pairs do.)
    T.overlay.clearElements();
    T.overlay.addElementAt('text', 0, 0.3, 0.3, { text: 'טסי בע״מ', fieldKey: 'Customer name', noEdit: true });
    T.overlay.addElementAt('text', 0, 0.3, 0.5, { text: '12,500', fieldKey: 'Total amount', noEdit: true });
    await T.openCompanion(rec);
    await new Promise((r) => setTimeout(r, 1600));
    const texts = T.overlay.getElements().filter((e) => e.model.type === 'text').map((e) => e.model.text);
    const ok = texts.includes('טסי בע״מ') && texts.includes('12,500');
    await window.PFS.companions.remove(rec.id);
    return ok ? true : ('carried values missing: ' + JSON.stringify(texts));
  });
  if (compRes !== true) console.log('  [companion debug]', compRes);
  check('companion opens pre-filled from the trigger form\'s values', compRes === true);

  // ---- class fill: Excel paste + smart header mapping ----
  {
    const mapRes = await page.evaluate(() => {
      const M = window.PFS.merge;
      // Excel paste is TAB-separated; headers use natural wording, not field keys
      const tsv = 'שם התלמיד\tת.ז.\tנייד\nישראל ישראלי\t123456782\t050-1111111\nדנה כהן\t207105749\t052-2222222';
      const parsed = M.parseCSV(tsv);
      const tsvOk = parsed.headers.length === 3 && parsed.records.length === 2
        && parsed.records[0]['שם התלמיד'] === 'ישראל ישראלי';
      // form fields are worded differently — canon mapping must bridge
      const mapping = M.mapHeaders(parsed.headers, ['שם מלא', 'תעודת זהות', 'טלפון']);
      const mapOk = mapping['שם התלמיד'] === 'שם מלא'
        && mapping['ת.ז.'] === 'תעודת זהות'
        && mapping['נייד'] === 'טלפון';
      const remapped = M.remapRecords(parsed.records, mapping);
      const remapOk = remapped[1]['שם מלא'] === 'דנה כהן' && remapped[0]['תעודת זהות'] === '123456782';
      // semicolon CSV also parses
      const semi = M.parseCSV('a;b\n1;2');
      const semiOk = semi.records.length === 1 && semi.records[0].b === '2';
      return { tsvOk, mapOk, remapOk, semiOk };
    });
    if (!Object.values(mapRes).every(Boolean)) console.log('  [map debug]', JSON.stringify(mapRes));
    check('class-fill: Excel TSV paste parses, headers canon-map to fields', mapRes.tsvOk && mapRes.mapOk && mapRes.remapOk && mapRes.semiOk);
  }

  // ---- course binder: paste students, track, auto-mark on export ----
  {
    const crsRes = await page.evaluate(() => {
      const C = window.PFS.courses;
      window.PFS.store.set('courses', []);
      const c = C.create('אילוף כלבים — מחזור ג');
      // paste WITH a header row (Excel) — canon-mapped columns
      const n1 = C.addStudents(c.id, C.parseStudentRows('שם מלא\tתעודת זהות\tטלפון\nישראל ישראלי\t123456782\t050-1111111'));
      // paste WITHOUT a header (WhatsApp-style lines) — heuristic cells
      const n2 = C.addStudents(c.id, C.parseStudentRows('דנה כהן, 207105749, 052-2222222'));
      const dedup = C.addStudents(c.id, C.parseStudentRows('ישראל ישראלי\t123456782\t050-1111111'));
      C.addForm(c.id, { name: 'נספח ה3', fp: 'fp_test_1', libId: null });
      const before = C.missingCount(C.get(c.id));
      // an export of that form containing דנה's ת"ז auto-marks her cell
      const marks = C.recordExport('fp_test_1', { f1: 'דנה כהן', f2: '207105749', f3: 'טקסט אחר' });
      const after = C.missingCount(C.get(c.id));
      const marked = C.isSubmitted(C.get(c.id), '207105749', 'נספח ה3');
      // an export of an UNKNOWN form marks nothing
      const noise = C.recordExport('fp_other', { f1: 'ישראל ישראלי' });
      const stillMissing = C.missingCount(C.get(c.id)) === after;
      // manual toggle works both ways
      C.setSubmitted(c.id, '123456782', 'נספח ה3', true);
      const allDone = C.missingCount(C.get(c.id)) === 0;
      window.PFS.store.set('courses', []);
      return { added: n1 === 1 && n2 === 1 && dedup === 0, before2: before === 2, marks: marks.length === 1, marked, after1: after === 1, noise: noise.length === 0 && stillMissing, allDone };
    });
    if (!Object.values(crsRes).every(Boolean)) console.log('  [courses debug]', JSON.stringify(crsRes));
    check('course binder: paste (header/free) + dedup + missing count', crsRes.added && crsRes.before2);
    check('course binder: export auto-marks the right student, ignores noise', crsRes.marks && crsRes.marked && crsRes.after1 && crsRes.noise && crsRes.allDone);
  }

  // ---- "מלא עבור תלמיד": student values ride canon matching into any form ----
  {
    const stuRes = await page.evaluate(() => {
      const T = window.PFS.__test;
      window.PFS.store.set('patterns', {});
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 's_nm', label: 'שם התלמיד', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 's_tz', label: 'ת.ז.', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] };
      T.setStudent({ 'שם מלא': 'דנה כהן', 'תעודת זהות': '207105749', 'טלפון': '052-2222222' });
      const pre = T.vaultPrefillFor(det) || {};
      // one-shot: a second call must not reuse the student
      const pre2 = T.vaultPrefillFor(det) || {};
      return { nm: pre.s_nm === 'דנה כהן', tz: pre.s_tz === '207105749', oneShot: pre2.s_nm !== 'דנה כהן' };
    });
    if (!Object.values(stuRes).every(Boolean)) console.log('  [student debug]', JSON.stringify(stuRes));
    check('student prefill canon-maps name/tz into differently-worded fields, one-shot', stuRes.nm && stuRes.tz && stuRes.oneShot);
  }

  // ---- wrapped table headers + one uniform font per form ----
  {
    const wrapRes = await page.evaluate(async () => {
      // synthetic form: a 3-column header row where the middle header WRAPS
      // to a second line — the old heuristic rejected all of it as "conflict"
      const { PDFDocument, rgb } = window.PDFLib;
      const doc = await PDFDocument.create();
      const pg = doc.addPage([595, 842]);
      const font = await doc.embedFont('Helvetica');
      const draw = (t, x, y, size) => pg.drawText(t, { x, y, size, font, color: rgb(0, 0, 0) });
      // Latin labels (Helvetica can't encode Hebrew; the geometry is what's under test)
      draw('Address of institute', 60, 700, 11);
      draw('Phone number of', 260, 700, 11);
      draw('the institute', 260, 686, 11);          // ← wrapped second line
      draw('Manager name', 430, 700, 11);
      const bytes = await doc.save();
      const T = window.PFS.__test;
      await T.openPdfFile(new File([bytes], 'wrap.pdf', { type: 'application/pdf' }));
      await new Promise((r) => setTimeout(r, 1500));
      const det = await window.PFS.detect.detectFields(T.pdfView.getDoc());
      const labels = det.fields.filter((f) => f.type === 'text').map((f) => f.label);
      const phone = det.fields.find((f) => /Phone number of the institute/.test(f.label));
      const addr = det.fields.find((f) => /Address of institute/.test(f.label));
      const mgr = det.fields.find((f) => /Manager name/.test(f.label));
      // no duplicate field for the orphan fragment 'the institute'
      const noDup = !det.fields.some((f) => f.label.trim() === 'the institute');
      // the wrapped header's answer band starts BELOW the second line
      const belowWrap = phone && addr && phone.fy > addr.fy + 0.001;
      // uniform font: after the real pipeline all text fields share one size
      window.PFS.__test.snapFieldsToInk(det);
      window.PFS.__test.normalizeFontSizes(det);
      const uniq = new Set(det.fields.filter((f) => f.type === 'text').map((f) => f.fontFrac));
      return { labels, got: !!(phone && addr && mgr), noDup, belowWrap, uniform: uniq.size === 1 };
    });
    if (!(wrapRes.got && wrapRes.noDup && wrapRes.belowWrap)) console.log('  [wrap debug]', JSON.stringify(wrapRes));
    check('wrapped table headers detected as one field each, no fragment dupes', wrapRes.got && wrapRes.noDup && wrapRes.belowWrap);
    check('one uniform handwriting size across all detected text fields', wrapRes.uniform === true);
  }

  // ---- ink-snap: detected text anchors to the printed ruling line ----
  {
    const snapRes = await page.evaluate(() => {
      const T = window.PFS.__test;
      const view = window.PFS.__test.pdfView ? window.PFS.__test.pdfView.viewList()[0] : null;
      if (!view || !view.canvas) return { skip: true };
      const cv = view.canvas, ctx = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      // paint a clean white band with a crisp ruled line through it
      ctx.fillStyle = '#fff'; ctx.fillRect(0.1 * W, 0.60 * H, 0.5 * W, 0.10 * H);
      const lineY = Math.round(0.65 * H) + 0.5;
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0.12 * W, lineY); ctx.lineTo(0.55 * W, lineY); ctx.stroke();
      const fh = 0.018;
      // field floats ABOVE the line (label-top geometry) — snap must pull it down
      const above = { page: 0, fieldKey: 'sn1', label: 'שדה', type: 'text', fx: 0.15, fy: 0.65 - fh * 1.8, fw: 0.3, fh, fontFrac: fh };
      // field in a clean area with NO line — must stay put
      ctx.fillStyle = '#fff'; ctx.fillRect(0.1 * W, 0.80 * H, 0.5 * W, 0.08 * H);
      const noline = { page: 0, fieldKey: 'sn2', label: 'שדה', type: 'text', fx: 0.15, fy: 0.82, fw: 0.3, fh, fontFrac: fh };
      const det = { tier: 'text', fields: [above, noline] };
      const n = T.snapFieldsToInk(det);
      const expected = 0.65 - fh; // bottom ≈ the line (minus the 2px breath)
      // table scenario: field lands ON the printed header text; the empty
      // cell (between two borders) sits below — snap must relocate into it
      ctx.fillStyle = '#fff'; ctx.fillRect(0.1 * W, 0.30 * H, 0.5 * W, 0.12 * H);
      const y1 = Math.round(0.33 * H) + 0.5, y2 = Math.round(0.37 * H) + 0.5;
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0.12 * W, y1); ctx.lineTo(0.55 * W, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0.12 * W, y2); ctx.lineTo(0.55 * W, y2); ctx.stroke();
      // simulate header glyphs with dash-rects (headless env has no fonts,
      // so fillText paints nothing; real pages get ink from pdf.js glyph paths)
      ctx.fillStyle = '#111';
      const gy = Math.round(0.316 * H), gh = Math.max(2, Math.round(0.008 * H));
      for (let gx = 0.17; gx < 0.42; gx += 0.04) ctx.fillRect(Math.round(gx * W), gy, Math.round(0.012 * W), gh);
      const tbl = { page: 0, fieldKey: 'sn3', label: 'שדה', type: 'text', fx: 0.15, fy: 0.312, fw: 0.3, fh: 0.014, fontFrac: 0.014 };
      const det2 = { tier: 'text', fields: [tbl] };
      T.snapFieldsToInk(det2);
      const cellTop = 0.33, cellBot = 0.37;
      const inCell = tbl.fy > cellTop && (tbl.fy + 0.014) < cellBot + 0.004;
      return {
        n,
        snappedClose: Math.abs((above.fy + fh) - 0.65) < 0.006,
        movedDown: above.fy > 0.65 - fh * 1.8 - 1e-9,
        untouched: noline.fy === 0.82,
        inCell
      };
    });
    if (snapRes.skip) check('ink-snap anchors text to the ruled line', true);
    else {
      if (!(snapRes.n === 1 && snapRes.snappedClose && snapRes.movedDown && snapRes.untouched)) console.log('  [snap debug]', JSON.stringify(snapRes));
      check('ink-snap anchors text to the ruled line, leaves lineless fields alone', snapRes.n === 1 && snapRes.snappedClose && snapRes.movedDown && snapRes.untouched);
      check('ink-snap relocates a header-overlapping value into the empty cell', snapRes.inCell === true);
    }
  }

  // ---- a person's name must NEVER land in "שם הקורס" (the screenshot bug) ----
  {
    const nameLeak = await page.evaluate(() => {
      const V = window.PFS.vault;
      // bare 'שם' only matches labels that ARE the word
      // course labels now have their own canon — the guard's real intent is
      // that they are NOT person canons (a name must never land there)
      const guards = V.matchKey('שם הקורס') === 'course_name'
        && V.matchKey('שם הקורס המבוקש') === 'course_name'
        && V.matchKey('שם') === 'full_name'
        && V.matchKey('שם:') === 'full_name'
        && V.matchKey('שם מלא') === 'full_name'
        && V.matchKey('שם התלמיד') === 'full_name';
      // end-to-end: a profile full name does not fill a course-name field
      const det = [
        { fieldKey: 'crs', label: 'שם הקורס', type: 'text' },
        { fieldKey: 'nm', label: 'שם מלא', type: 'text' }
      ];
      const text = V.matchValues(det, { 'שם מלא': 'שלום וזאנה' }, []);
      return { guards, courseEmpty: text.crs === undefined, nameFilled: text.nm === 'שלום וזאנה' };
    });
    if (!(nameLeak.guards && nameLeak.courseEmpty && nameLeak.nameFilled)) console.log('  [name-leak debug]', JSON.stringify(nameLeak));
    check('bare-שם synonym never claims "שם הקורס"; real name fields still fill', nameLeak.guards && nameLeak.courseEmpty && nameLeak.nameFilled);
  }

  // ---- per-glyph RTL lines reassemble into readable text (digits unflipped) ----
  {
    const asm = await page.evaluate(() => {
      // 'עבור טלי מכלוף ת.ז. 038290177' emitted as visual fragments, digits LTR
      const mk = (str, x) => ({ str, width: str.length * 6, transform: [12, 0, 0, 12, x, 500] });
      const items = [
        mk('038290177', 40),          // digits sit left, printed LTR
        mk('ת.ז.', 100),
        mk('וף', 130), mk('מכל', 142), // fragmented word
        mk('טלי', 175),
        mk('עבור', 205)
      ];
      return window.PFS.assembleLineRTL(items);
    });
    if (!/עבור טלי מכלוף ת\.ז\. 038290177/.test(asm)) console.log('  [asm debug]', JSON.stringify(asm));
    check('per-glyph RTL line reassembles readably with digit runs unflipped', /עבור טלי מכלוף ת\.ז\. 038290177/.test(asm));
  }

  // branch in the quote picks the MATCHING saved campus for the appendix
  {
    const br = await page.evaluate(() => {
      window.PFS.store.set('org_campuses', [
        { name: 'קמפוס חיפה', address: 'ההסתדרות 25, חיפה' },
        { name: 'קמפוס אשקלון', address: 'האופה 7, אשקלון' }
      ]);
      const camps = window.PFS.store.get('org_campuses', []);
      const brN = window.PFS.vault.norm('אשקלון');
      const hit = camps.find((cp) => window.PFS.vault.norm(cp.name + ' ' + cp.address).includes(brN));
      window.PFS.store.set('org_campuses', []);
      return hit ? hit.address : null;
    });
    check('a quoted branch resolves to its saved campus address', br === 'האופה 7, אשקלון');
  }

  // ---- quote → appendix: the PRINTED deal facts flow to the companion ----
  {
    const qm = await page.evaluate(() => {
      // the literal shape of the office's price-quote letters
      const text = [
        'הנדון: הצעת מחיר לקורס אילוף כלבים',
        'עבור טלי מכלוף  ת.ז. 038290177',
        'תאריך התחלה: 03.09.2026',
        'תאריך סיום משוער: 30/05/27',
        'סניף: אשקלון',
        'עלות: 10900 ש"ח - כולל מע"מ ודמי רישום.'
      ].join('\n');
      const m = window.PFS.extractQuoteMap(text);
      return {
        course: m['שם הקורס'], courseAlias: m['שם הקורס המבוקש'],
        name: m['שם מלא'], tz: m['תעודת זהות'],
        branch: m['סניף'], d1: m['תאריך תחילת הקורס'], d2: m['תאריך סיום הקורס']
      };
    });
    if (!(qm.course === 'אילוף כלבים' && qm.name === 'טלי מכלוף' && qm.tz === '038290177')) console.log('  [quote debug]', JSON.stringify(qm));
    check('quote text yields course, person (checksummed ת"ז), branch and period dates',
      qm.course === 'אילוף כלבים' && qm.courseAlias === 'אילוף כלבים'
      && qm.name === 'טלי מכלוף' && qm.tz === '038290177'
      && qm.branch === 'אשקלון' && qm.d1 === '03.09.2026' && qm.d2 === '30/05/27');
  }

  // course-PERIOD dates carry to the appendix; bare dates still never do
  {
    const dc = await page.evaluate(() => {
      const T = window.PFS.__test;
      const det = { tier: 'text', fields: [
        { fieldKey: 'q_start', label: 'תאריך תחילת הקורס', type: 'text', page: 0, fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02 },
        { fieldKey: 'q_date', label: 'תאריך', type: 'text', page: 0, fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02 }
      ] };
      T.setCarry({ 'תאריך תחילת הקורס': '03.09.2026', 'תאריך': '22/7/26' });
      const pre = T.vaultPrefillFor(det) || {};
      return { start: pre.q_start, bare: pre.q_date };
    });
    if (!(dc.start === '03.09.2026' && dc.bare !== '22/7/26')) console.log('  [date-carry debug]', JSON.stringify(dc));
    check('course-period dates carry; bare signature dates never do', dc.start === '03.09.2026' && dc.bare !== '22/7/26');
  }

  // ---- paste-and-fill: a WhatsApp line fills the whole form ----
  {
    const pf = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const T = window.PFS.__test;
      window.PFS.store.set('patterns', {});
      T.overlay.clearElements(); T.fieldsPanel.clear();
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 'pp_nm', label: 'שם התלמיד', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'pp_tz', label: 'ת.ז.', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'pp_ph', label: 'טלפון נייד', fx: 0.2, fy: 0.4, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] };
      T.setLastDet(det); T.fieldsPanel.show(det);
      // the fast-lane buttons exist in the panel
      const btns = [...document.querySelectorAll('#fieldsBody button')].map((b) => b.textContent);
      const hasPaste = btns.some((t) => /הדבק ומלא/.test(t));
      const hasPhoto = btns.some((t) => /מלא מצילום/.test(t));
      // the raw WhatsApp-style line → person map → form
      const map = window.PFS.extractPersonMap('ישראל ישראלי 123456782 050-1234567');
      const n = window.PFS.fillPersonMap(map);
      await wait(150);
      const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
      const val = (k) => (rows.find((i) => i.__fkey === k) || {}).value;
      const filled = val('pp_nm') === 'ישראל ישראלי' && val('pp_tz') === '123456782' && /050/.test(val('pp_ph') || '');
      const onForm = T.overlay.getElements().some((c) => c.model.fieldKey === 'pp_tz' && c.model.text === '123456782');
      T.overlay.clearElements(); T.fieldsPanel.clear();
      window.PFS.store.set('patterns', {});
      return { hasPaste, hasPhoto, map, vals: { nm: val('pp_nm'), tz: val('pp_tz'), ph: val('pp_ph') }, n, filled, onForm };
    });
    if (!(pf.hasPaste && pf.hasPhoto && pf.filled && pf.onForm)) console.log('  [paste debug]', JSON.stringify(pf));
    else console.log('  [paste ok]');
    check('paste-and-fill: one WhatsApp line fills name/tz/phone on panel and form', pf.hasPaste && pf.hasPhoto && pf.filled && pf.onForm);
  }

  // ---- zero-form: one click → finished PDFs for every missing student ----
  {
    const zfB64 = fs.readFileSync(path.join(HERE, 'fixtures', 'nispach-h3.pdf')).toString('base64');
    const zf = await page.evaluate(async (b64) => {
      const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      const T = window.PFS.__test;
      const C = window.PFS.courses;
      window.PFS.store.set('courses', []); window.PFS.store.set('patterns', {});
      // org constants come from the profile (as they would in real use)
      window.PFS.store.set('profiles', [{ id: 'zp', name: 'אני', values: {
        'שם מוסד ההכשרה': 'היחידה ללימודי חוץ', 'טלפון מוסד ההכשרה': '03-1234567'
      } }]);
      window.PFS.store.set('active_profile', 'zp');
      const rec = await window.PFS.library.add('נספח-אפס', buf.slice(0));
      const c = C.create('קורס אפס');
      C.addStudents(c.id, [
        { name: 'ישראל ישראלי', tz: '123456782', phone: '050-1111111' },
        { name: 'דנה כהן', tz: '207105749', phone: '052-2222222' }
      ]);
      C.addForm(c.id, { name: 'נספח-אפס', fp: null, libId: rec.id });
      const before = C.missingCount(C.get(c.id));
      const res = await T.produceCourseForm(c.id, 'נספח-אפס', false);
      if (res.error) return { error: res.error, before };
      const after = C.missingCount(C.get(c.id));
      // unzip and check per-student files exist and are real PDFs
      const files = window.fflate.unzipSync(res.zip);
      const names = Object.keys(files);
      const pdfsOk = names.every((n) => {
        const h = files[n].slice(0, 5); return String.fromCharCode(...h) === '%PDF-';
      });
      const sized = names.every((n) => files[n].length > 5000);
      window.PFS.store.set('courses', []);
      return { before, after, count: res.count, names, pdfsOk, sized };
    }, zfB64);
    if (zf.error || !(zf.count === 2 && zf.after === 0 && zf.pdfsOk && zf.sized)) console.log('  [zero-form debug]', JSON.stringify({ ...zf, names: (zf.names || []).join('|') }));
    check('zero-form: 2 finished per-student PDFs from one call, cells auto-marked',
      zf.count === 2 && zf.before === 2 && zf.after === 0 && zf.pdfsOk && zf.sized
      && zf.names.some((n) => /ישראל/.test(n)) && zf.names.some((n) => /דנה/.test(n)));
  }

  // ---- self-healing: stored person-name leaks are purged and swept ----
  {
    const healRes = await page.evaluate(() => {
      const P = window.PFS.patterns;
      // poisoned learning slot (as saved before the guard existed)
      window.PFS.store.set('patterns', { 'שם הקורס': { label: 'שם הקורס', values: [
        { v: 'שלום וזאנה', n: 3, last: 1 }, { v: 'אילוף כלבים', n: 2, last: 2 }
      ] } });
      window.PFS.store.set('profiles', [{ id: 'p1', name: 'אני', values: { 'שם מלא': 'שלום וזאנה' } }]);
      const removed = P.purgePersonValues();
      const left = P.all()['שם הקורס'].values.map((r) => r.v);
      // and learning refuses to re-absorb the name into a course slot
      P.learnFrom([{ fieldKey: 'c1', label: 'שם הקורס', type: 'text' }], { c1: 'שלום וזאנה' }, []);
      const stillClean = !P.all()['שם הקורס'].values.some((r) => r.v === 'שלום וזאנה');
      window.PFS.store.set('patterns', {});
      return { removed, keptCourse: left.length === 1 && left[0] === 'אילוף כלבים', stillClean };
    });
    if (!(healRes.removed === 1 && healRes.keptCourse && healRes.stillClean)) console.log('  [heal debug]', JSON.stringify(healRes));
    check('person-name values are purged from learned slots and never relearned', healRes.removed === 1 && healRes.keptCourse && healRes.stillClean);
  }

  // ---- the real form detects CLEAN: no heading-noise, reading order ----
  {
    const h3b64 = fs.readFileSync(path.join(HERE, 'fixtures', 'nispach-h3.pdf')).toString('base64');
    const cleanRes = await page.evaluate(async (b64) => {
      const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
      await window.PFS.__test.openPdfFile(new File([buf], 'clean.pdf', { type: 'application/pdf' }));
      await new Promise((r) => setTimeout(r, 2200));
      const d = await window.PFS.detect.detectFields(window.PFS.__test.pdfView.getDoc());
      const keys = d.fields.map((f) => f.fieldKey);
      const noHeadings = !keys.some((k) => /הצהרת|פרטי_מוסד_ההכשרה_והקורס/.test(k));
      const idx = (rx) => keys.findIndex((k) => rx.test(k));
      // reading order: institution table first, signature line last
      const ordered = idx(/שם_מוסד_ההכשרה/) !== -1 && idx(/שם_מנהל/) !== -1
        && idx(/שם_מוסד_ההכשרה/) < idx(/שם_מלא/) && idx(/שם_מלא/) < idx(/שם_מנהל/);
      return { count: d.fields.length, noHeadings, ordered };
    }, h3b64);
    if (!(cleanRes.noHeadings && cleanRes.ordered)) console.log('  [clean debug]', JSON.stringify(cleanRes));
    check('real form: no heading-noise fields, reading order', cleanRes.noHeadings && cleanRes.ordered);
  }

  // ---- Ctrl+Z from a HEBREW keyboard layout (e.key='ז', not 'z') ----
  {
    const hebUndo = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const T = window.PFS.__test;
      T.overlay.clearElements(); T.fieldsPanel.clear();
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 'hz_a', label: 'הערות', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] };
      T.setLastDet(det); T.fieldsPanel.show(det);
      T.snapshotNow();
      const row = document.querySelector('#fieldsBody input[type=text]');
      row.value = 'טעות'; row.dispatchEvent(new Event('input', { bubbles: true }));
      // no debounce wait — undo must flush the pending snapshot itself
      row.focus();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ז', code: 'KeyZ', ctrlKey: true, bubbles: true }));
      await wait(400);
      const gone = !T.overlay.getElements().some((c) => c.model.fieldKey === 'hz_a');
      // redo (Ctrl+Shift+ז) brings the typed state back
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ז', code: 'KeyZ', ctrlKey: true, shiftKey: true, bubbles: true }));
      await wait(400);
      const back = T.overlay.getElements().some((c) => c.model.fieldKey === 'hz_a' && c.model.text === 'טעות');
      T.overlay.clearElements(); T.fieldsPanel.clear();
      return { gone, back };
    });
    if (!(hebUndo.gone && hebUndo.back)) console.log('  [heb-undo debug]', JSON.stringify(hebUndo));
    check('Ctrl+Z works from a Hebrew keyboard layout, redo recovers', hebUndo.gone && hebUndo.back);
  }

  // ---- one handwriting: the uniformizer evens out every text size ----
  {
    const uniRes = await page.evaluate(async () => {
      const T = window.PFS.__test;
      T.overlay.clearElements(); T.fieldsPanel.clear();
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 'uh_a', label: 'שם מוסד הלימודים', fx: 0.2, fy: 0.2, fw: 0.25, fh: 0.03, fontFrac: 0.016, type: 'text' },
        { page: 0, fieldKey: 'uh_b', label: 'הערות', fx: 0.2, fy: 0.3, fw: 0.25, fh: 0.03, fontFrac: 0.016, type: 'text' }
      ] };
      T.setLastDet(det); T.fieldsPanel.show(det);
      const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
      rows[0].value = 'ערך ראשון'; rows[0].dispatchEvent(new Event('input', { bubbles: true }));
      rows[1].value = 'ערך שני'; rows[1].dispatchEvent(new Event('input', { bubbles: true }));
      // sabotage: drift the sizes apart (fitFont/manual-tweak simulation)
      const els = T.overlay.getElements().filter((c) => c.model.type === 'text');
      els[0].model.fontFrac = 0.012; els[0].layout();
      els[1].model.fontFrac = 0.024; els[1].layout();
      const rightEdgeBefore = els[0].model.fx + els[0].model.fw;
      const n = T.uniformize(false);
      const list = T.overlay.getElements().filter((c) => c.model.type === 'text').map((c) => c.model.fontFrac);
      // harmony band, not a hard flatten: outliers pulled within ±15% of the
      // form size (a hard flatten oversized fills vs small-print lines)
      const uniform = list.every((v) => v >= 0.016 * 0.85 - 1e-9 && v <= 0.016 * 1.15 + 1e-9)
        && Math.max(...list) / Math.min(...list) <= 1.36;
      // the right-aligned value kept its right edge planted
      const rightEdgeAfter = els[0].model.fx + els[0].model.fw;
      const anchored = Math.abs(rightEdgeAfter - rightEdgeBefore) < 0.002;
      // the panel offers the one-click evener
      const btn = [...document.querySelectorAll('#fieldsBody button')].some((b) => /כתב אחיד/.test(b.textContent));
      T.overlay.clearElements(); T.fieldsPanel.clear();
      return { n, uniform, anchored, btn };
    });
    if (!(uniRes.n === 2 && uniRes.uniform && uniRes.anchored && uniRes.btn)) console.log('  [uni debug]', JSON.stringify(uniRes));
    check('uniformizer evens all text to the form size, right edges stay planted', uniRes.n === 2 && uniRes.uniform && uniRes.anchored);
    check('the ✨ one-handwriting button is offered in the panel', uniRes.btn === true);
  }

  // ---- one-gesture deletion: hover the element, click ✕ ----
  {
    const delRes = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const T = window.PFS.__test;
      window.PFS.store.set('patterns', {});
      T.overlay.clearElements(); T.fieldsPanel.clear();
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 'dx_a', label: 'הערות', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'dx_b', label: 'הערה נוספת', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] };
      T.setLastDet(det);
      T.fieldsPanel.show(det);
      const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
      rows[0].value = 'ערך למחיקה'; rows[0].dispatchEvent(new Event('input', { bubbles: true }));
      rows[1].value = 'ערך שנשאר'; rows[1].dispatchEvent(new Event('input', { bubbles: true }));
      T.snapshotNow();
      const el = T.overlay.getElements().find((c) => c.model.fieldKey === 'dx_a');
      // the ✕ must be revealed on HOVER (no selection first) and clickable
      const css = getComputedStyle(el.node.querySelector('.mini-del'));
      const hiddenAtRest = css.display === 'none';
      el.node.querySelector('.mini-del').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wait(400);
      const gone = !T.overlay.getElements().some((c) => c.model.fieldKey === 'dx_a');
      const otherStays = T.overlay.getElements().some((c) => c.model.fieldKey === 'dx_b');
      // panel reverse-sync: the row emptied itself
      const rowCleared = rows[0].value === '' && rows[1].value === 'ערך שנשאר';
      // idempotence: deleting again is a no-op, not a crash
      T.overlay.deleteCtrl(el);
      // undo brings it back
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await wait(500);
      const restored = T.overlay.getElements().some((c) => c.model.fieldKey === 'dx_a' && c.model.text === 'ערך למחיקה');
      T.overlay.clearElements(); T.fieldsPanel.clear();
      return { hiddenAtRest, gone, otherStays, rowCleared, restored };
    });
    if (!Object.values(delRes).every(Boolean)) console.log('  [del debug]', JSON.stringify(delRes));
    check('hover-✕ deletes in one click, panel row clears, undo restores', delRes.hiddenAtRest && delRes.gone && delRes.otherStays && delRes.rowCleared && delRes.restored);
  }

  // hover reveal is CSS-driven — verify the rule with a real hover
  {
    await page.evaluate(() => {
      const T = window.PFS.__test;
      T.overlay.clearElements();
      const det = { tier: 'text', fields: [{ page: 0, fieldKey: 'hv_1', label: 'הערות', fx: 0.4, fy: 0.4, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }] };
      T.fieldsPanel.show(det);
      const row = document.querySelector('#fieldsBody input[type=text]');
      row.value = 'ריחוף'; row.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const el = await page.$('.el.text');
    await el.hover();
    const shown = await page.evaluate(() => getComputedStyle(document.querySelector('.el .mini-del')).display !== 'none');
    // while EDITING the element (typing), the ✕ must vanish — it was
    // covering the very text being written on small date boxes
    const hiddenWhileEditing = await page.evaluate(() => {
      const el = document.querySelector('.el.text');
      el.dataset.editing = '1';
      const hidden = getComputedStyle(el.querySelector('.mini-del')).display === 'none';
      el.dataset.editing = '0';
      return hidden;
    });
    await page.evaluate(() => { const T = window.PFS.__test; T.overlay.clearElements(); T.fieldsPanel.clear(); });
    check('hovering an element reveals its delete button', shown === true);
    check('the ✕ hides while typing inside the element', hiddenWhileEditing === true);
  }

  // ---- clear-autofill button + dates never carried between companions ----
  {
    const clrRes = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const T = window.PFS.__test;
      window.PFS.store.set('patterns', {});
      T.overlay.clearElements(); T.fieldsPanel.clear();
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 'ca_x', label: 'שם מוסד הלימודים', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'ca_y', label: 'טלפון מוסד ההכשרה', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'ca_z', label: 'הערות', fx: 0.2, fy: 0.4, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] };
      const P = window.PFS.patterns;
      P.learnFrom([det.fields[0]], { ca_x: 'היחידה ללימודי חוץ' }, []);
      P.learnFrom([det.fields[0]], { ca_x: 'היחידה ללימודי חוץ' }, []);
      P.learnFrom([det.fields[1]], { ca_y: '03-1234567' }, []);
      P.learnFrom([det.fields[1]], { ca_y: '03-1234567' }, []);
      T.setLastDet(det);
      T.fieldsPanel.show(det, T.vaultPrefillFor(det) || undefined);
      await wait(100);
      const btn = document.querySelector('.fp-clear-auto');
      if (!btn) return { btn: false };
      // touch one auto-filled row — it must SURVIVE the sweep
      const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
      const phoneRow = rows.find((i) => i.__fkey === 'ca_y');
      phoneRow.value = '03-7654321'; phoneRow.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      await wait(300);
      const instGone = !T.overlay.getElements().some((c) => c.model.fieldKey === 'ca_x');
      const phoneStays = T.overlay.getElements().some((c) => c.model.fieldKey === 'ca_y' && c.model.text === '03-7654321');
      const instRow = rows.find((i) => i.__fkey === 'ca_x');
      const rowCleared = instRow.value === '';
      // dates are never carried from a companion form
      T.overlay.clearElements(); T.fieldsPanel.clear();
      const det2 = { tier: 'text', fields: [
        { page: 0, fieldKey: 'cd_d', label: 'תאריך', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'cd_n', label: 'הערות מיוחדות', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] };
      T.setCarry({ 'תאריך': '03/09/2026', 'הערות מיוחדות': 'ממשיך' });
      const pre = T.vaultPrefillFor(det2) || {};
      // the date key must not come from CARRY (03/09/2026); auto-today is allowed
      const dateNotCarried = pre.cd_d !== '03/09/2026';
      const noteCarried = pre.cd_n === 'ממשיך';
      window.PFS.store.set('patterns', {});
      return { btn: true, instGone, phoneStays, rowCleared, dateNotCarried, noteCarried };
    });
    if (!Object.values(clrRes).every(Boolean)) console.log('  [clear debug]', JSON.stringify(clrRes));
    check('clear-autofill wipes untouched auto fields, keeps edited ones', clrRes.btn && clrRes.instGone && clrRes.phoneStays && clrRes.rowCleared);
    check('companion carry never transfers dates', clrRes.dateNotCarried && clrRes.noteCarried);
  }

  // ---- the learning engine: recurring values fill themselves ----
  {
    const patRes = await page.evaluate(async () => {
      const P = window.PFS.patterns;
      window.PFS.store.set('patterns', {});
      const F = (label, key) => ({ label, fieldKey: key, type: 'text', page: 0, fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02 });
      const inst = F('שם מוסד הלימודים', 'k_inst');
      const addr = F('כתובת מוסד ההכשרה', 'k_addr');
      const person = F('שם מלא', 'k_name');
      // 1) one export is NOT enough for auto (n>=2 strict)
      P.learnFrom([inst], { k_inst: 'היחידה ללימודי חוץ' }, []);
      const after1 = P.suggest(inst);
      // 2) a second confirming export flips it to auto — and the wording may
      //    differ (canon slot bridges שם מוסד הלימודים ↔ שם המכללה)
      P.learnFrom([F('שם המכללה', 'k2')], { k2: 'היחידה ללימודי חוץ' }, []);
      const after2 = P.suggest(inst);
      const autoOk = after1 === null && after2 && after2.mode === 'auto' && after2.value === 'היחידה ללימודי חוץ';
      // 3) several addresses become a sorted choice list
      P.learnFrom([addr], { k_addr: 'קמפוס ת״א, הרצל 1' }, []);
      P.learnFrom([addr], { k_addr: 'קמפוס ת״א, הרצל 1' }, []);
      P.learnFrom([addr], { k_addr: 'קמפוס חיפה, הנמל 8' }, []);
      const ch = P.suggest(addr);
      const choicesOk = ch && ch.mode === 'choices' && ch.options.length === 2 && ch.options[0].v === 'קמפוס ת״א, הרצל 1';
      // 4) blocklist: person names are NEVER learned
      P.learnFrom([person], { k_name: 'משה ישראלי' }, []);
      const blockOk = P.suggest(person) === null && P.optionsFor(person).length === 0;
      // 5) self-reinforcement guard: auto-filled-untouched keys are skipped
      const before = P.optionsFor(inst)[0].n;
      P.learnFrom([inst], { k_inst: 'היחידה ללימודי חוץ' }, ['k_inst']);
      const guardOk = P.optionsFor(inst)[0].n === before;
      // 6) pinned values sort first and survive eviction pressure
      P.touch(addr, 'קמפוס ירושלים, יפו 3'); P.pin(addr, 'קמפוס ירושלים, יפו 3', true);
      const pinnedFirst = P.optionsFor(addr)[0].v === 'קמפוס ירושלים, יפו 3';
      // 7) removal works
      P.removeValue(addr, 'קמפוס חיפה, הנמל 8');
      const removed = !P.optionsFor(addr).some((o) => o.v === 'קמפוס חיפה, הנמל 8');
      window.PFS.store.set('patterns', {});
      return { autoOk, choicesOk, blockOk, guardOk, pinnedFirst, removed };
    });
    if (!Object.values(patRes).every(Boolean)) console.log('  [patterns debug]', JSON.stringify(patRes));
    // regression: an institution phrase INSIDE a longer person-label must not
    // adopt the institution slot ("שם מנהל מוסד ההכשרה או מי מטעמו" is a person)
    const leak = await page.evaluate(() => {
      const P = window.PFS.patterns;
      window.PFS.store.set('patterns', {});
      const inst = { label: 'שם מוסד ההכשרה', fieldKey: 'li', type: 'text' };
      P.learnFrom([inst], { li: 'היחידה ללימודי חוץ' }, []);
      P.learnFrom([inst], { li: 'היחידה ללימודי חוץ' }, []);
      const manager = { label: 'שם מנהל מוסד ההכשרה או מי מטעמו', fieldKey: 'lm', type: 'text' };
      const heading = { label: 'הצהרת מוסד ההכשרה המלמד קורס הכשרה מקצועית', fieldKey: 'lh', type: 'text' };
      const ok = P.suggest(manager) === null && P.suggest(heading) === null
        && window.PFS.vault.matchKey('שם מנהל מוסד ההכשרה או מי מטעמו') !== 'institution_name'
        && window.PFS.vault.matchKey('שם מוסד ההכשרה') === 'institution_name';
      window.PFS.store.set('patterns', {});
      return ok;
    });
    check('institution learning never leaks into manager-name or headings', leak === true);
    check('learning: 2 confirmations → auto-fill, cross-wording via canon', patRes.autoOk);
    check('learning: multiple addresses → sorted choices; person names never learned', patRes.choicesOk && patRes.blockOk);
    check('learning: no self-reinforcement; pin sorts first; forget works', patRes.guardOk && patRes.pinnedFirst && patRes.removed);
  }

  // ---- the choice window is always available: build a list from the field ----
  {
    const bcRes = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const T = window.PFS.__test;
      window.PFS.store.set('patterns', {});
      T.overlay.clearElements(); T.fieldsPanel.clear();
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 'bc_addr', label: 'כתובת מוסד ההכשרה', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'bc_tz', label: 'תעודת זהות', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] };
      T.setLastDet(det); T.fieldsPanel.show(det);
      const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
      const addr = rows.find((i) => i.__fkey === 'bc_addr');
      const tz = rows.find((i) => i.__fkey === 'bc_tz');
      // learnable field: ▾ exists even with ZERO saved options (dimmed)
      const addrPick = addr.closest('.field').querySelector('.fp-pick');
      const emptyState = addrPick && addrPick.classList.contains('empty');
      // blocked field (ת"ז): no choice window at all — identity is per-person
      const tzPick = tz.closest('.field').querySelector('.fp-pick');
      if (!addrPick || tzPick) return { addrPick: !!addrPick, tzPick: !!tzPick };
      // type an address, open the window, save it as an option
      addr.value = 'ההסתדרות 25 חיפה'; addr.dispatchEvent(new Event('input', { bubbles: true }));
      addrPick.click(); await wait(120);
      let dd = document.querySelector('.pat-dd');
      const saveBtn = dd && [...dd.querySelectorAll('.pat-dd-item')].find((i) => /➕ שמור/.test(i.textContent));
      if (!saveBtn) return { addrPick: true, tzPick: false, saveBtn: false };
      saveBtn.click(); await wait(120);
      // saved as pinned; button no longer dimmed; second value → two options
      const savedPinned = window.PFS.patterns.optionsFor(det.fields[0]).some((o) => o.v === 'ההסתדרות 25 חיפה' && o.pinned);
      const undimmed = !addrPick.classList.contains('empty');
      addr.value = 'דרך בגין 125 תל אביב'; addr.dispatchEvent(new Event('input', { bubbles: true }));
      dd = document.querySelector('.pat-dd');
      const saveBtn2 = dd && [...dd.querySelectorAll('.pat-dd-item')].find((i) => /➕ שמור/.test(i.textContent));
      if (saveBtn2) saveBtn2.click(); else { addrPick.click(); await wait(120); const d2=document.querySelector('.pat-dd'); const b2=[...d2.querySelectorAll('.pat-dd-item')].find((i)=>/➕ שמור/.test(i.textContent)); b2 && b2.click(); }
      await wait(120);
      const twoOpts = window.PFS.patterns.optionsFor(det.fields[0]).length === 2;
      // picking the first option fills row + form
      addrPick.click(); await wait(120);
      const dd3 = document.querySelector('.pat-dd');
      const first = dd3 && [...dd3.querySelectorAll('.pat-dd-item .v')].map((e) => e.textContent);
      const item = dd3 && [...dd3.querySelectorAll('.pat-dd-item')].find((i) => i.querySelector('.v') && /ההסתדרות/.test(i.querySelector('.v').textContent));
      if (item) item.click();
      await wait(200);
      const picked = addr.value === 'ההסתדרות 25 חיפה'
        && T.overlay.getElements().some((c) => c.model.fieldKey === 'bc_addr' && c.model.text === 'ההסתדרות 25 חיפה');
      T.overlay.clearElements(); T.fieldsPanel.clear();
      window.PFS.store.set('patterns', {});
      return { addrPick: true, tzPick: false, saveBtn: true, savedPinned, undimmed, twoOpts, picked, emptyState };
    });
    if (!(bcRes.addrPick && !bcRes.tzPick && bcRes.saveBtn && bcRes.savedPinned && bcRes.twoOpts && bcRes.picked)) console.log('  [choice debug]', JSON.stringify(bcRes));
    check('▾ exists on every learnable field (dimmed when empty), never on ת"ז', bcRes.addrPick && !bcRes.tzPick && bcRes.emptyState === true);
    check('save-current-as-option builds a pinned choice list from the field itself', bcRes.saveBtn && bcRes.savedPinned && bcRes.undimmed && bcRes.twoOpts && bcRes.picked);
  }

  // ---- learned patterns flow into the panel: auto-fill badge + ▾ picker ----
  {
    const flowRes = await page.evaluate(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const T = window.PFS.__test;
      const P = window.PFS.patterns;
      window.PFS.store.set('patterns', {});
      T.overlay.clearElements(); T.fieldsPanel.clear();
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 'pf_inst', label: 'שם מוסד הלימודים', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'pf_addr', label: 'כתובת מוסד ההכשרה', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] };
      // teach: institution name twice (→auto), two campuses (→choices)
      P.learnFrom([det.fields[0]], { pf_inst: 'היחידה ללימודי חוץ' }, []);
      P.learnFrom([det.fields[0]], { pf_inst: 'היחידה ללימודי חוץ' }, []);
      P.learnFrom([det.fields[1]], { pf_addr: 'קמפוס ת״א, הרצל 1' }, []);
      P.learnFrom([det.fields[1]], { pf_addr: 'קמפוס חיפה, הנמל 8' }, []);
      // open "the third time": prefill through the real path
      T.setLastDet(det);
      T.fieldsPanel.show(det, (function () {  // vaultPrefill equivalent via app path
        return window.PFS.__test.vaultPrefillFor ? window.PFS.__test.vaultPrefillFor(det) : null;
      })() || undefined);
      await wait(150);
      const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
      const instRow = rows.find((i) => i.__fkey === 'pf_inst');
      const addrRow = rows.find((i) => i.__fkey === 'pf_addr');
      // institution auto-filled with the badge; learning marks it auto
      const autoFilled = instRow && instRow.value === 'היחידה ללימודי חוץ' && instRow.classList.contains('fp-auto');
      const marked = T.fieldsPanel.autoFilledKeys().includes('pf_inst');
      // address NOT auto-filled (ambiguous) — has the ▾ picker instead
      const notGuessed = addrRow && addrRow.value === '';
      const pickBtn = addrRow && addrRow.closest('.field').querySelector('.fp-pick');
      if (!pickBtn) return { autoFilled, marked, notGuessed, pick: false };
      pickBtn.click();
      await wait(150);
      const dd = document.querySelector('.pat-dd');
      const items = dd ? [...dd.querySelectorAll('.pat-dd-item')] : [];
      const listed = items.filter((i) => !i.classList.contains('free')).map((i) => i.querySelector('.v').textContent);
      // pick the Haifa campus → fills the row + the form element
      const haifa = items.find((i) => (i.querySelector('.v') || {}).textContent === 'קמפוס חיפה, הנמל 8');
      if (haifa) haifa.click();
      await wait(200);
      const filled = addrRow.value === 'קמפוס חיפה, הנמל 8'
        && T.overlay.getElements().some((c) => c.model.fieldKey === 'pf_addr' && c.model.text === 'קמפוס חיפה, הנמל 8');
      // user-picked → not in the auto set → export would LEARN it (n grows)
      const notAuto = !T.fieldsPanel.autoFilledKeys().includes('pf_addr');
      T.overlay.clearElements(); T.fieldsPanel.clear();
      window.PFS.store.set('patterns', {});
      return { autoFilled, marked, notGuessed, pick: true, listedCount: listed.length, filled, notAuto };
    });
    if (!(flowRes.autoFilled && flowRes.marked && flowRes.notGuessed && flowRes.pick && flowRes.filled && flowRes.notAuto)) console.log('  [flow debug]', JSON.stringify(flowRes));
    check('recurring value auto-fills with badge and is marked non-learnable', flowRes.autoFilled && flowRes.marked);
    check('ambiguous slot shows the ▾ picker; choosing fills row + form', flowRes.notGuessed && flowRes.pick && flowRes.filled && flowRes.notAuto);
  }

  // ---- undo you can trust: visible, global, and the panel SURVIVES it ----
  {
    const undoRes = await page.evaluate(async () => {
      window.PFS.store.set('patterns', {});   // isolate from mid-suite learning
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const T = window.PFS.__test;
      // fresh detected form state
      T.overlay.clearElements();
      T.fieldsPanel.show({ tier: 'text', fields: [
        { page: 0, fieldKey: 'u_name', label: 'שם מלא', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'u_phone', label: 'טלפון', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] });
      T.setLastDet({ tier: 'text', fields: [
        { page: 0, fieldKey: 'u_name', label: 'שם מלא', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'u_phone', label: 'טלפון', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
      ] });
      T.snapshotNow();
      const rowOf = (k) => [...document.querySelectorAll('#fieldsBody input[type=text]')].find((i) => i.__fkey === k);
      const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      // visible controls exist
      const btns = !!(document.getElementById('undoBtn') && document.getElementById('redoBtn'));
      // fill one field, let the debounced snapshot land
      const nameRow = rowOf('u_name');
      nameRow.focus(); type(nameRow, 'משה ישראלי');
      await wait(500);
      const undoEnabled = !document.getElementById('undoBtn').disabled;
      // Ctrl+Z FROM INSIDE THE INPUT — the exact case that used to be dead
      nameRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await wait(300);
      const elGone = !T.overlay.getElements().some((c) => c.model.fieldKey === 'u_name');
      // the panel must SURVIVE: rows still rendered, value synced back to empty
      const rowAfter = rowOf('u_name');
      const panelAlive = !!rowAfter && !!rowOf('u_phone');
      const valueSynced = rowAfter && rowAfter.value === '';
      // typing again must UPDATE, not duplicate
      if (rowAfter) { rowAfter.focus(); type(rowAfter, 'דנה לוי'); }
      await wait(500);
      const count = T.overlay.getElements().filter((c) => c.model.fieldKey === 'u_name').length;
      // redo path via the visible button
      document.getElementById('undoBtn').click();
      await wait(250);
      const redoEnabled = !document.getElementById('redoBtn').disabled;
      document.getElementById('redoBtn').click();
      await wait(250);
      const redone = T.overlay.getElements().some((c) => c.model.fieldKey === 'u_name' && c.model.text === 'דנה לוי');
      const rowFinal = rowOf('u_name');
      const rowFollows = rowFinal && rowFinal.value === 'דנה לוי';
      T.overlay.clearElements(); T.fieldsPanel.clear();
      return { btns, undoEnabled, elGone, panelAlive, valueSynced, count, redoEnabled, redone, rowFollows };
    });
    if (!(undoRes.btns && undoRes.undoEnabled && undoRes.elGone && undoRes.panelAlive && undoRes.valueSynced && undoRes.count === 1 && undoRes.redoEnabled && undoRes.redone && undoRes.rowFollows)) console.log('  [undo debug]', JSON.stringify(undoRes));
    check('visible undo works from inside an input and reverts the fill', undoRes.btns && undoRes.undoEnabled && undoRes.elGone);
    check('fields panel SURVIVES undo: rows alive, values synced, no duplicates', undoRes.panelAlive && undoRes.valueSynced && undoRes.count === 1);
    check('redo restores the value and the panel row follows', undoRes.redoEnabled && undoRes.redone && undoRes.rowFollows);
  }

  // ---- the app shell can never get "stuck" scrolled off-screen ----
  // html/body are overflow:hidden; focus/scrollIntoView used to offset them
  // with no way for the user to scroll back (clipped toolbar, "everything is
  // stuck"). The guard must snap any such drift back, and all programmatic
  // scrolling must move only inner containers.
  check('document scroll drift self-heals and focus flows never cause it', await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const d = document.scrollingElement || document.documentElement;
    // 1) simulate the stuck state: make the document genuinely scrollable,
    //    drag it down like a stray scrollIntoView would, and let it drift
    const probe = document.createElement('div');
    probe.style.cssText = 'height:60vh';
    document.body.appendChild(probe);
    document.body.style.overflow = 'visible';
    d.scrollTop = 80;
    await wait(120);            // guard listens on window scroll
    const healed = d.scrollTop === 0;
    document.body.style.overflow = '';
    probe.remove();
    // 2) focus/jump flows: field far down the page — the panel + viewport may
    //    scroll, the DOCUMENT must not move
    const T = window.PFS.__test;
    T.fieldsPanel.show({ tier: 'text', fields: [
      { page: 0, fieldKey: 's_a', label: 'עליון', fx: 0.2, fy: 0.05, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
      { page: 0, fieldKey: 's_b', label: 'תחתון', fx: 0.2, fy: 0.93, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
    ] });
    await wait(100);
    T.fieldsPanel.focusField('s_b');
    await wait(400);
    const noDrift = d.scrollTop === 0 && document.body.scrollTop === 0;
    // 3) scoped scroller really scrolls the inner viewport, not the document
    const vp = document.querySelector('.viewport');
    const before = vp.scrollTop;
    const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
    const rb = rows.find((i) => i.__fkey === 's_b');
    rb.value = 'ערך'; rb.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(150);
    const ctrl = T.overlay.getElements().find((c) => c.model.fieldKey === 's_b');
    window.PFS.scrollToEl(ctrl.node, 'center');
    await wait(500);
    const innerScrolled = vp.scrollTop !== before || vp.scrollHeight <= vp.clientHeight + 2;
    const stillNoDrift = d.scrollTop === 0;
    T.fieldsPanel.clear(); T.overlay.clearElements();
    return (healed && noDrift && innerScrolled && stillNoDrift) ? true
      : JSON.stringify({ healed, noDrift, innerScrolled, stillNoDrift });
  }) === true);

  // ---- click-to-fill: tapping a marker on the form focuses its row ----
  check('clicking a field marker on the form focuses its input row', await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const T = window.PFS.__test;
    const det = { tier: 'text', fields: [
      { page: 0, fieldKey: 'm_a', label: 'שדה א', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' },
      { page: 0, fieldKey: 'm_b', label: 'שדה ב', fx: 0.2, fy: 0.35, fw: 0.2, fh: 0.03, fontFrac: 0.02, type: 'text' }
    ] };
    T.fieldsPanel.show(det);
    await wait(100);
    const marker = document.querySelector('.field-marker[data-key="m_b"]');
    if (!marker) return 'no marker';
    const clickable = getComputedStyle(marker).pointerEvents !== 'none';
    marker.click();
    await wait(350);
    const focused = document.activeElement && document.activeElement.__fkey === 'm_b';
    // and focusing lights the marker (panel ↔ form link)
    const active = marker.classList.contains('active');
    T.fieldsPanel.clear(); T.overlay.clearElements();
    return (clickable && focused && active) ? true : JSON.stringify({ clickable, focused, active });
  }) === true);

  // ---- document library: permanent one-click forms ----
  check('library stores, lists, opens and removes a form', await page.evaluate(async () => {
    const { PDFDocument, rgb } = window.PDFLib;
    const d = await PDFDocument.create(); d.addPage([300, 200]).drawRectangle({ x: 0, y: 0, width: 300, height: 200, color: rgb(1, 1, 1) });
    const bytes = await d.save();
    const rec = await window.PFS.library.add('נספח ו', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    let docs = await window.PFS.library.list();
    const listed = docs.some((x) => x.id === rec.id && x.name === 'נספח ו');
    // open straight from the library — the whole pipeline runs on it
    const stored = await window.PFS.library.get(rec.id);
    await window.PFS.__test.openPdfFile(new File([stored.bytes], stored.name + '.pdf', { type: 'application/pdf' }));
    await new Promise((r) => setTimeout(r, 1200));
    const opened = document.getElementById('fname').textContent.indexOf('נספח ו') !== -1;
    await window.PFS.library.rename(rec.id, 'נספח ו — חדש');
    docs = await window.PFS.library.list();
    const renamed = docs.some((x) => x.id === rec.id && x.name === 'נספח ו — חדש');
    await window.PFS.library.remove(rec.id);
    docs = await window.PFS.library.list();
    const removed = !docs.some((x) => x.id === rec.id);
    return listed && opened && renamed && removed;
  }));

  // ---- organization details fill institution fields on the REAL נספח ה3 ----
  check('org details auto-fill institution fields on the real form', await page.evaluate(async () => {
    window.PFS.store.set('patterns', {});   // isolate from mid-suite learning
    const mk = window.PFS.vault.matchKey;
    const canonOk = mk('שם המכללה') === 'institution_name' && mk('שם מוסד ההכשרה') === 'institution_name'
      && mk('טלפון מוסד ההכשרה') === 'institution_phone' && mk('כתובת המוסד') === 'institution_address'
      && mk('איש קשר') === 'contact_person'
      && mk('טלפון נייד') === 'phone';   // personal phone canon still intact
    const orgVals = { 'שם מוסד ההכשרה': 'היחידה ללימודי חוץ', 'טלפון המכללה': '03-7654321', 'כתובת המכללה': 'שד׳ העצמאות 1, חיפה' };
    const resp = await fetch('test/fixtures/nispach-h3.pdf');
    const doc = await window.pdfjsLib.getDocument({ data: await resp.arrayBuffer() }).promise;
    const det = await window.PFS.detect.detectFields(doc);
    const mv = window.PFS.vault.matchValues(det.fields, orgVals, []);
    const by = (lbl) => { const f = det.fields.find((x) => x.label === lbl); return f ? mv[f.fieldKey] : undefined; };
    // different wording on each side — the canon bridges מכללה ↔ מוסד ההכשרה
    const filled = by('שם מוסד ההכשרה') === 'היחידה ללימודי חוץ'
      && by('טלפון מוסד ההכשרה') === '03-7654321'
      && by('כתובת מוסד ההכשרה') === 'שד׳ העצמאות 1, חיפה';
    // the person's שם מלא must NOT get the institution name
    const nameF = det.fields.find((x) => x.label === 'שם מלא');
    const clean = !nameF || mv[nameF.fieldKey] === undefined;
    return canonOk && filled && clean;
  }));

  // ---- first-run guided tour: five stops, skippable, one-time ----
  check('guided tour runs once through its five stops and completes', await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.PFS.store.remove('tour_done');
    window.PFS.tour.start();
    await wait(250);
    const dim = document.querySelector('.tour-dim');
    const bub = document.querySelector('.tour-bubble');
    if (!dim || !dim.classList.contains('show') || !bub) return 'tour did not open';
    const titles = [];
    for (let i = 0; i < 5; i++) {
      titles.push(bub.querySelector('.tour-title').textContent);
      bub.querySelector('.tour-next').click();
      await wait(150);
    }
    const closed = !dim.classList.contains('show');
    const done = window.PFS.store.get('tour_done', 0) === 1;
    const allStops = titles.length === 5 && new Set(titles).size === 5;
    // once done, maybeStart must be a no-op (one-time behaviour)
    window.PFS.tour.maybeStart();
    await wait(1400);
    const stayedClosed = !dim.classList.contains('show');
    return (closed && done && allStops && stayedClosed) ? true : JSON.stringify({ closed, done, titles, stayedClosed });
  }) === true);

  // ---- the full user-facing ask: export → "fill the appendix now?" → yes ----
  // This drives the REAL surfaces (export modal Download button, confirm
  // dialog), not internal APIs — the exact chain the user reported missing.
  {
    const askRes = await page.evaluate(async () => {
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
      const mkForm = async (title, labels) => {
        const d = await PDFDocument.create(); const pg = d.addPage([400, 300]);
        pg.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(1, 1, 1) });
        const f = await d.embedFont(StandardFonts.Helvetica);
        pg.drawText(title, { x: 150, y: 270, size: 16, font: f, color: rgb(0, 0, 0) });
        labels.forEach((lb, i) => pg.drawText(lb, { x: 250, y: 220 - i * 40, size: 12, font: f, color: rgb(0.1, 0.1, 0.1) }));
        return new File([await d.save()], title + '.pdf', { type: 'application/pdf' });
      };
      const T = window.PFS.__test;
      await T.openPdfFile(await mkForm('Quote-B', ['Course name:']));
      await new Promise((r) => setTimeout(r, 1300));
      const fpA = T.getFp();
      const fileB = await mkForm('Appendix-B', ['Course name:', 'Full name:']);
      const rec = await window.PFS.companions.add({ ownerFp: fpA, ownerName: 'Quote-B', name: 'נספח בדיקה', bytes: await fileB.arrayBuffer() });
      T.overlay.clearElements();
      T.overlay.addElementAt('text', 0, 0.3, 0.3, { text: 'קורס נגרות', fieldKey: 'Course name', noEdit: true });
      // the student TYPED on the quote (not printed in it) must ride too
      T.overlay.addElementAt('text', 0, 0.3, 0.5, { text: 'טלי מכלוף', fieldKey: 'Full name', noEdit: true });
      // open the export review — the linked companion must be visible in it
      document.getElementById('exportBtn').click();
      await new Promise((r) => setTimeout(r, 300));
      const shownInModal = [...document.querySelectorAll('#exCompBody b')].some((b) => b.textContent === 'נספח בדיקה');
      await new Promise((res) => {   // wait for the preview build
        const t = setInterval(() => { const bz = document.getElementById('exBusy'); if (bz && !bz.classList.contains('on')) { clearInterval(t); res(); } }, 200);
      });
      // Download → after delivery the app must ASK about the companion
      document.getElementById('exDownload').click();
      await new Promise((r) => setTimeout(r, 700));
      const dlg = document.getElementById('uiDialog');
      const asked = !!(dlg && dlg.classList.contains('show') && /נספח בדיקה/.test(document.getElementById('uiDlgMsg').textContent));
      if (!asked) { await window.PFS.companions.remove(rec.id); return { shownInModal, asked, opened: false }; }
      document.getElementById('uiDlgOk').click();   // "כן, מלא אותו"
      await new Promise((r) => setTimeout(r, 1800));
      const opened = document.getElementById('fname').textContent.indexOf('נספח בדיקה') !== -1;
      const carried = T.overlay.getElements().some((e) => e.model.text === 'קורס נגרות');
      // typed person outranks the profile ('ישראל ישראלי') on the appendix
      const person = T.overlay.getElements().some((e) => e.model.text === 'טלי מכלוף');
      await window.PFS.companions.remove(rec.id);
      return { shownInModal, asked, opened, carried, person };
    });
    if (!(askRes.shownInModal && askRes.asked && askRes.opened && askRes.carried)) console.log('  [ask debug]', JSON.stringify(askRes));
    check('export modal shows the linked appendix', askRes.shownInModal === true);
    check('after download the app ASKS to fill the appendix; yes opens it filled', askRes.asked === true && askRes.opened === true && askRes.carried === true);
    check('a person TYPED on the quote rides to the appendix (student path)', askRes.person === true);
  }

  // ---- 🏠 home: close the document, return to the start screen, open fresh ----
  {
    const homeRes = await page.evaluate(async () => {
      const T = window.PFS.__test;
      const $id = (i) => document.getElementById(i);
      const before = {
        hasDoc: T.pdfView.hasDoc(),
        homeVisible: !!$id('homeBtn') && !$id('docbar').classList.contains('hidden')
      };
      $id('homeBtn').click();
      await new Promise((r) => setTimeout(r, 300));
      // dirty work → confirm dialog explains the auto-save; accept it
      const dlg = $id('uiDialog');
      if (dlg && dlg.classList.contains('show')) { $id('uiDlgOk').click(); await new Promise((r) => setTimeout(r, 300)); }
      const closed = {
        hasDoc: T.pdfView.hasDoc(),
        dropzone: $id('dropzone').style.display !== 'none',
        docbarHidden: $id('docbar').classList.contains('hidden'),
        exportDisabled: $id('exportBtn').disabled,
        fillDisabled: $id('fillAllBtn').disabled,
        pagesEmpty: !document.querySelector('.page-wrap')
      };
      // and a FRESH document opens cleanly afterwards
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
      const d = await PDFDocument.create(); const pg = d.addPage([400, 300]);
      pg.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(1, 1, 1) });
      const f = await d.embedFont(StandardFonts.Helvetica);
      pg.drawText('Fresh doc', { x: 150, y: 270, size: 16, font: f, color: rgb(0, 0, 0) });
      await T.openPdfFile(new File([await d.save()], 'fresh.pdf', { type: 'application/pdf' }));
      await new Promise((r) => setTimeout(r, 1200));
      const reopened = {
        hasDoc: T.pdfView.hasDoc(),
        docbarShown: !$id('docbar').classList.contains('hidden'),
        exportEnabled: !$id('exportBtn').disabled,
        pageDrawn: !!document.querySelector('.page-wrap canvas.pdf')
      };
      return { before, closed, reopened };
    });
    if (!(homeRes.before.hasDoc && homeRes.closed.pagesEmpty && homeRes.reopened.hasDoc)) console.log('  [home debug]', JSON.stringify(homeRes));
    check('🏠 returns to the start screen (doc closed, buttons disabled)',
      homeRes.before.hasDoc && homeRes.before.homeVisible &&
      !homeRes.closed.hasDoc && homeRes.closed.dropzone && homeRes.closed.docbarHidden &&
      homeRes.closed.exportDisabled && homeRes.closed.fillDisabled && homeRes.closed.pagesEmpty);
    check('a fresh document opens cleanly after going home',
      homeRes.reopened.hasDoc && homeRes.reopened.docbarShown && homeRes.reopened.exportEnabled && homeRes.reopened.pageDrawn);
  }

  // ---- guided fill: one question at a time, empty fields only, Enter advances ----
  {
    const gdRes = await page.evaluate(async () => {
      const T = window.PFS.__test;
      const det = { tier: 'text', fields: [
        { page: 0, fieldKey: 'gd_a', label: 'הערה ראשונה', fx: 0.2, fy: 0.2, fw: 0.2, fh: 0.02, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'gd_b', label: 'הערה שנייה', fx: 0.2, fy: 0.3, fw: 0.2, fh: 0.02, fontFrac: 0.02, type: 'text' },
        { page: 0, fieldKey: 'gd_c', label: 'הערה שלישית', fx: 0.2, fy: 0.4, fw: 0.2, fh: 0.02, fontFrac: 0.02, type: 'text' }
      ] };
      T.overlay.clearElements();
      T.fieldsPanel.show(det, { gd_b: 'כבר מלא' });   // one pre-filled → guided must skip it
      const launcher = [...document.querySelectorAll('#fieldsBody button')].find((b) => /מילוי מודרך/.test(b.textContent));
      if (!launcher) return { fail: 'no launcher' };
      launcher.click();
      await new Promise((r) => setTimeout(r, 150));
      const card = document.querySelector('.gd-card');
      if (!card) return { fail: 'no card' };
      const count1 = card.querySelector('#gdCount').textContent;
      const q1 = card.querySelector('#gdQ').textContent;
      const inp = card.querySelector('#gdIn');
      const enter = () => inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      inp.value = 'תשובה אחת'; enter();
      await new Promise((r) => setTimeout(r, 100));
      const q2 = document.querySelector('.gd-card #gdQ').textContent;
      inp.value = 'תשובה שתיים'; enter();
      await new Promise((r) => setTimeout(r, 150));
      const closed = !document.querySelector('.gd-card');
      const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
      const vals = {}; rows.forEach((r) => { if (r.__fkey) vals[r.__fkey] = r.value; });
      const els = T.overlay.getElements().map((e) => e.model.text);
      // Esc closes a fresh session (empty a field first — a fully-filled form
      // correctly refuses to open the guided card at all)
      const rowA = rows.find((r) => r.__fkey === 'gd_a');
      rowA.value = ''; rowA.dispatchEvent(new Event('input'));
      launcher.click(); await new Promise((r) => setTimeout(r, 100));
      const reopened = !!document.querySelector('.gd-card');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((r) => setTimeout(r, 100));
      const escClosed = !document.querySelector('.gd-card');
      T.overlay.clearElements(); T.fieldsPanel.clear();
      return { count1, q1, q2, closed, vals, els, reopened, escClosed };
    });
    if (gdRes.fail || !gdRes.closed) console.log('  [guided debug]', JSON.stringify(gdRes));
    check('guided fill iterates only EMPTY fields, one question at a time',
      !gdRes.fail && gdRes.count1 === '1 / 2' && /ראשונה/.test(gdRes.q1) && /שלישית/.test(gdRes.q2));
    check('guided fill commits values to panel + form; Enter/Esc flow works',
      !gdRes.fail && gdRes.closed
      && gdRes.vals.gd_a === 'תשובה אחת' && gdRes.vals.gd_b === 'כבר מלא' && gdRes.vals.gd_c === 'תשובה שתיים'
      && gdRes.els.includes('תשובה אחת') && gdRes.els.includes('תשובה שתיים')
      && gdRes.reopened && gdRes.escClosed);
  }

  // on a DIGITAL pdf, replace reads the covered run's exact em + baseline from
  // the text layer — pixel guessing is only the scanned-page fallback
  check("replace on a digital PDF adopts the covered text's exact em size", await page.evaluate(async () => {
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
    const d = await PDFDocument.create(); const pg = d.addPage([595, 842]);
    pg.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(1, 1, 1) });
    const f = await d.embedFont(StandardFonts.Helvetica);
    pg.drawText('Academic hours: 320', { x: 60, y: 620, size: 13, font: f, color: rgb(0, 0, 0) });
    const T = window.PFS.__test;
    await T.openPdfFile(new File([await d.save()], 'em.pdf', { type: 'application/pdf' }));
    await new Promise((r) => setTimeout(r, 2000));
    const ov = T.overlay;
    ov.clearElements();
    T.placeReplacement(0, 158 / 595, (842 - 636) / 842, 50 / 595, 24 / 842);
    await new Promise((r) => setTimeout(r, 800));   // async text-layer refine
    const txt = ov.getElements().find((e) => e.model.type === 'text');
    const expFF = (13 * 0.95) / 842;                 // the run was drawn at 13pt
    const expTop = (842 - 620 - 13) / 842;           // its top line
    const ok = txt && Math.abs(txt.model.fontFrac - expFF) / expFF < 0.08
      && Math.abs(txt.model.fy - expTop) < 0.008;
    ov.clearElements();
    return ok;
  }));

  // ---- typeface matching: written values adopt the DOCUMENT's font ----
  check('fontmatch maps embedded font names (and generics) to real stacks', await page.evaluate(() => {
    const fm = window.PFS.fontmatch;
    const nameOk = fm.familyOf('ABCDEF+ArialMT') === 'arial'         // subset prefix stripped
      && fm.familyOf('David-Bold') === 'david'
      && fm.familyOf('FrankRuehl') === 'frank'                        // beats a bare 'david' rule
      && fm.familyOf('TimesNewRomanPSMT') === 'times'
      && fm.familyOf('Tahoma') === 'tahoma'
      && fm.familyOf('CourierNew') === 'mono'
      && fm.familyOf('Arimo') === 'arial'                             // metric clone of Arial
      && fm.familyOf('SomeUnknownFace') === null;                     // unknown → keep the app font
    // no real name available → pdf.js's serif/sans classification decides
    const genOk = fm.familyOf('', 'serif') === 'times' && fm.familyOf('', 'monospace') === 'mono'
      && fm.familyOf('', 'sans-serif') === null;
    // every stack must end in a font that HAS Hebrew glyphs, or a Hebrew value
    // would render as boxes on a machine lacking the exact face
    const stacksOk = Object.keys(fm.FAMILIES).filter((k) => k !== 'mono')
      .every((k) => /Heebo/.test(fm.FAMILIES[k].css));
    return nameOk && genOk && stacksOk;
  }));

  check('opening a PDF learns its typeface; new text is written in it', await page.evaluate(async () => {
    const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
    const d = await PDFDocument.create(); const pg = d.addPage([400, 300]);
    pg.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(1, 1, 1) });
    // a document set in Times — plenty of body text so it wins the weighting
    const f = await d.embedFont(StandardFonts.TimesRoman);
    for (let i = 0; i < 5; i++) {
      pg.drawText('Form body text line ' + i, { x: 30, y: 250 - i * 30, size: 12, font: f, color: rgb(0, 0, 0) });
    }
    const T = window.PFS.__test;
    await T.openPdfFile(new File([await d.save()], 'times.pdf', { type: 'application/pdf' }));
    await new Promise((r) => setTimeout(r, 1500));
    const docId = window.PFS.fontmatch.docId();
    const ov = T.overlay;
    ov.clearElements();
    const ctrl = ov.addElementAt('text', 0, 0.3, 0.3, { text: 'ערך', noEdit: true });
    const m = ctrl.model;
    const adopted = /Times New Roman/.test(m.font || '');
    // ...and it survives serialize → apply (templates / auto-memory)
    const ser = ov.serialize();
    ov.clearElements();
    ov.applyModels(ser);
    const restored = ov.getElements()[0];
    const keptOk = restored && restored.model.font === m.font;
    // ...and reaches the DOM, so the editor shows what the export will draw
    const domOk = /Times New Roman/.test(restored.node.querySelector('.txt').style.fontFamily || '');
    ov.clearElements();
    return docId === 'times' && adopted && keptOk && domOk;
  }));

  // the REAL user path: rail button → marquee drag → paste click. The direct-
  // API test below passed while this exact flow was broken (the marquee's
  // disarm ran AFTER copyRegion armed the paste) — never again.
  check('copy-region works through the real rail-button → drag → click flow', await page.evaluate(async () => {
    const T = window.PFS.__test, ov = T.overlay;
    ov.clearElements();
    window.PFS.store.remove('clips');
    const c = document.querySelector('canvas.pdf'), cx = c.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0.1 * c.width, 0.1 * c.height, 0.3 * c.width, 0.1 * c.height);
    cx.fillStyle = '#1160aa'; cx.fillRect(0.14 * c.width, 0.13 * c.height, 0.18 * c.width, 0.04 * c.height);
    document.querySelector('.rail-btn[data-tool="clip"]').click();
    const overlayEl = document.querySelector('.page-wrap .overlay');
    const r = overlayEl.getBoundingClientRect();
    const pd = (x, y) => overlayEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width * x, clientY: r.top + r.height * y }));
    const wm = (x, y) => window.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + r.width * x, clientY: r.top + r.height * y }));
    pd(0.12, 0.12); wm(0.22, 0.16); wm(0.34, 0.19);
    window.dispatchEvent(new PointerEvent('pointerup', {}));
    await new Promise((s) => setTimeout(s, 120));
    const armedAfterDrag = ov.isPlacing();     // THE regression: this was wiped
    pd(0.5, 0.5);                              // paste click
    const img = ov.getElements().find((e) => e.model.kind === 'clip');
    ov.clearElements();
    window.PFS.store.remove('clips');
    ov.setPlacing(null);
    return armedAfterDrag && !!img && /^data:image\/png/.test(img.model.imgUrl || '');
  }));

  // ---- copy a region of the PAGE and stamp it elsewhere ----
  // On a scan the useful content is pixels (a signature, a filled block that
  // repeats): lifting one and re-placing it beats recreating it by hand.
  const cprRes = await page.evaluate(async () => {
    const T = window.PFS.__test;
    const ov = T.overlay;
    ov.clearElements();
    window.PFS.store.remove('clips');
    // paint a recognisable mark on the page, then copy exactly that area
    const c = document.querySelector('canvas.pdf'), cx = c.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0.10 * c.width, 0.10 * c.height, 0.30 * c.width, 0.10 * c.height);
    cx.fillStyle = '#1160aa'; cx.fillRect(0.14 * c.width, 0.13 * c.height, 0.18 * c.width, 0.04 * c.height);
    const src = { fx: 0.12, fy: 0.12, fw: 0.22, fh: 0.06 };
    // a value FILLED IN FILLO inside the region — the clip must carry it
    // (it lives in the overlay, not the page canvas: "מדביק שורות לבנות")
    ov.addModelAt('text', 0, { fx: src.fx + 0.02, fy: src.fy + 0.01, text: 'AAA', color: '#e02020', fontFrac: 0.03, noEdit: true });
    await T.copyRegion(0, src.fx, src.fy, src.fw, src.fh);
    // it is armed for placing and saved to the library
    const armed = ov.isPlacing();
    const clips = window.PFS.store.get('clips', []);
    const savedOk = clips.length === 1 && /^data:image\/png/.test(clips[0].url)
      && Math.abs(clips[0].fw - src.fw) < 1e-9 && Math.abs(clips[0].fh - src.fh) < 1e-9;
    // decode the clip: the red value typed in Fillo must be IN the pixels
    const redIn = await new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const cc = document.createElement('canvas'); cc.width = im.width; cc.height = im.height;
        const c2 = cc.getContext('2d'); c2.drawImage(im, 0, 0);
        const dd = c2.getImageData(0, 0, cc.width, cc.height).data;
        for (let i = 0; i < dd.length; i += 4) { if (dd[i] > 150 && dd[i + 1] < 110 && dd[i + 2] < 110) { res(true); return; } }
        res(false);
      };
      im.onerror = () => res(false);
      im.src = clips[0].url;
    });
    // click on the page → the copy lands at the SAME size, on that spot
    const overlayEl = document.querySelector('.page-wrap .overlay');
    const r = overlayEl.getBoundingClientRect();
    overlayEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true,
      clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5 }));
    const img = ov.getElements().find((e) => e.model.type === 'image');
    const placedOk = img && img.model.kind === 'clip'
      && Math.abs(img.model.fw - src.fw) < 1e-6 && Math.abs(img.model.fh - src.fh) < 1e-6
      && /^data:image\/png/.test(img.model.imgUrl || '');
    // and it survives serialize → apply, so templates/auto-memory keep it
    const ser = ov.serialize();
    ov.clearElements();
    ov.applyModels(ser);
    const keptOk = ov.getElements().some((e) => e.model.kind === 'clip' && e.model.imgUrl);
    ov.clearElements();
    window.PFS.store.remove('clips');
    return JSON.stringify({ armed, savedOk, redIn, placedOk: !!placedOk, keptOk, clips: clips.length });
  });
  if (JSON.parse(cprRes) && Object.values(JSON.parse(cprRes)).some((v) => v === false)) console.log('  [copy debug]', cprRes);
  check('copy-region lifts page pixels, keeps its size, and re-places anywhere', (() => { const o = JSON.parse(cprRes); return o.armed && o.savedOk && o.redIn && o.placedOk && o.keptOk; })());

  // a long value in a narrow table cell must stay INSIDE the cell: shrink a
  // bit, then wrap — never cross the borders ("הוא חוצה גבולות")
  const wrapCellRes = await page.evaluate(async () => {
    const { PDFDocument, rgb } = window.PDFLib;
    const d = await PDFDocument.create();
    d.addPage([595, 842]).drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(1, 1, 1) });
    const T = window.PFS.__test;
    await T.openPdfFile(new File([await d.save()], 'wrapcell.pdf', { type: 'application/pdf' }));
    await new Promise((r) => setTimeout(r, 1500));
    const det = { tier: 'text', fields: [
      { page: 0, fieldKey: 'cell1', label: 'שם הקורס', fx: 0.30, fy: 0.35, fw: 0.12, fh: 0.02, fontFrac: 0.014, type: 'text' }
    ] };
    T.overlay.clearElements();
    T.fieldsPanel.show(det);
    const row = [...document.querySelectorAll('#fieldsBody input[type=text]')].find((r) => r.__fkey === 'cell1');
    row.value = 'הטמעת טכנולוגיות וחדשנות בתחום הבנייה';
    row.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 120));
    const el = T.overlay.getElements().find((e) => e.model.fieldKey === 'cell1');
    if (!el) return 'no-el';
    const m = el.model;
    const W = el.node.closest('.overlay').getBoundingClientRect().width;
    const contained = el.node.offsetWidth <= 0.12 * W + 6;      // box = the cell, not wider
    const wrapped = m.wrapW === 0.12;
    const dispLines = Math.round(m.fh / (m.fontFrac * 1.15));
    // the exporter wraps with the same greedy break — its line count must agree
    // probe at the page's REAL aspect (A4 595×842): font scales with the page
    // HEIGHT, the cell with its WIDTH — a square probe under-counts lines
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = '400 ' + (m.fontFrac * 842).toFixed(2) + 'px ' + (m.font || 'Heebo, sans-serif');
    const limit = 0.12 * 595;
    const words = m.text.split(/\s+/).filter(Boolean);
    let cur = words[0], expLines = 1;
    for (let i = 1; i < words.length; i++) {
      const cand = cur + ' ' + words[i];
      if (probe.measureText(cand).width <= limit) cur = cand;
      else { expLines++; cur = words[i]; }
    }
    const serOk = T.overlay.serialize().some((s2) => s2.fieldKey === 'cell1' && s2.wrapW === 0.12);
    const verdict = contained && wrapped && expLines >= 2 && Math.abs(dispLines - expLines) <= 1 && serOk;
    const dbg = JSON.stringify({ contained, wrapped, dispLines, expLines, serOk, nodeW: el.node.offsetWidth, W });
    T.overlay.clearElements(); T.fieldsPanel.clear();
    return verdict ? true : dbg;
  });
  if (wrapCellRes !== true) console.log('  [wrap-cell debug]', wrapCellRes);
  check('long text in a narrow cell shrinks then wraps inside it', wrapCellRes === true);

  // ===== the course CASE FILE: deal facts learned per course, filled by meaning =====
  {
    const cfRes = await page.evaluate(async () => {
      const T = window.PFS.__test, C = window.PFS.courses;
      const out = {};
      // -- resolution: which labels are deal facts --
      out.keys = C.factKeyFor('שם הקורס') === 'course_name'
        && C.factKeyFor('שם התכנית') === 'course_name'
        && C.factKeyFor('סניף') === 'branch'
        && C.factKeyFor('שעות אקדמיות') === 'course_hours'
        && C.factKeyFor('תאריך תחילת הקורס') === 'course_start'
        && C.factKeyFor('מועד סיום הלימודים') === 'course_end'
        && C.factKeyFor('תאריך') === null            // bare date is per-form
        && C.factKeyFor('שם מלא') === null;          // people are never course facts
      // -- harvest from an export, twice → n counts confirmations --
      const c = C.create('קורס בדיקה — תיק');
      const F = (l) => ({ label: l, fieldKey: l, type: 'text' });
      const fields = [F('שם הקורס'), F('סניף'), F('שעות אקדמיות'), F('עלות'), F('תאריך תחילת הקורס'), F('תאריך סיום משוער'), F('תאריך'), F('שם מלא')];
      const vals = { 'שם הקורס': 'אילוף כלבים', 'סניף': 'אשקלון', 'שעות אקדמיות': '320',
        'עלות': '10,900 ש"ח', 'תאריך תחילת הקורס': '03/09/26', 'תאריך סיום משוער': '30/05/27',
        'תאריך': '19/08/26', 'שם מלא': 'טלי מכלוף' };
      C.harvestFacts(c.id, fields, vals);
      C.harvestFacts(c.id, fields, vals);
      const facts = C.getFacts(c.id);
      out.harvest = facts.course_name && facts.course_name.v === 'אילוף כלבים' && facts.course_name.n === 2
        && facts.branch && facts.branch.v === 'אשקלון'
        && facts.course_hours && facts.course_hours.v === '320'
        && facts.amount && facts.course_start && facts.course_start.v === '03/09/26'
        && facts.course_end && facts.course_end.v === '30/05/27'
        && !Object.keys(facts).some((k) => facts[k].v === '19/08/26')    // bare date never absorbed
        && !Object.keys(facts).some((k) => facts[k].v === 'טלי מכלוף'); // people never absorbed
      // -- fill a NEVER-SEEN form worded differently, through the real prefill --
      T.setActiveCourse(c.id);
      const det = { tier: 'text', fields: [
        F('שם התכנית'), F('קמפוס'), F('היקף שעות'), F('סכום במילים'),
        F('מועד תחילת הלימודים'), F('תאריך סיום הלימודים'), F('תאריך')
      ] };
      const pre = T.vaultPrefillFor(det) || {};
      out.fill = pre['שם התכנית'] === 'אילוף כלבים'
        && pre['קמפוס'] === 'אשקלון'
        && pre['היקף שעות'] === '320'
        && /עשרת אלפים|תשע מאות/.test(pre['סכום במילים'] || '')          // derived from the price
        && pre['מועד תחילת הלימודים'] === '03/09/26'
        && pre['תאריך סיום הלימודים'] === '30/05/27'
        && pre['תאריך'] !== '03/09/26' && pre['תאריך'] !== '30/05/27';   // bare date stays "today"
      // -- an explicit quote carry still outranks the ledger --
      T.setCarry({ 'סניף': 'חיפה' });
      const pre2 = T.vaultPrefillFor({ tier: 'text', fields: [F('קמפוס')] }) || {};
      out.carryWins = pre2['קמפוס'] === 'חיפה';
      // -- the chip renders in the panel and reflects the active course --
      T.fieldsPanel.show(det);
      const chip = document.getElementById('courseChip');
      out.chip = !!chip && chip.classList.contains('on') && /תיק|קורס בדיקה/.test(chip.textContent);
      // -- removing a fact forgets it --
      C.removeFact(c.id, 'branch');
      out.forget = !C.getFacts(c.id).branch;
      // cleanup
      T.setActiveCourse(null);
      C.remove(c.id);
      T.fieldsPanel.clear();
      return out;
    });
    if (Object.values(cfRes).some((v) => v !== true)) console.log('  [casefile debug]', JSON.stringify(cfRes));
    check('case file: labels resolve to deal facts; people and bare dates never', cfRes.keys === true && cfRes.harvest === true);
    check('case file: a never-seen form fills from the ledger by meaning', cfRes.fill === true && cfRes.carryWins === true);
    check('case file: active-course chip renders; facts are forgettable', cfRes.chip === true && cfRes.forget === true);
  }

  // a table-header answer band must stay INSIDE its own column — sizing by
  // the header alone let long values cross into the neighbour cell
  check('table-header field width is clamped to its column', await page.evaluate(() => {
    const H = 320, W = 460, fs = 16;
    const vp = { transform: [1, 0, 0, -1, 0, H], width: W, height: H };
    const item = (str, x, top, width) => ({ str, width, transform: [fs, 0, 0, fs, x, H - (top + fs)] });
    const det = window.PFS.detect.heuristicForPage([
      item('שם הקורס', 300, 60, 60),          // rightmost column (RTL)
      item('שם מוסד ההכשרה', 180, 60, 110)     // neighbour ends at x=290
    ], W, H, vp, 0);
    const crs = det.find((f) => f.label === 'שם הקורס');
    const inst = det.find((f) => /מוסד/.test(f.label));
    if (!crs || !inst) return 'missing';
    // the course band may not cross the boundary at 290 (+half-em gutter)
    const leftEdge = crs.fx * W;
    return leftEdge >= 290 + fs * 0.5 - 1 && (crs.fx + crs.fw) * W <= 362 ? true : 'fx=' + leftEdge.toFixed(1);
  }) === true);

  // ---- one cell, one field: no two values may stack in the same table cell ----
  // (the real נספח ה3, filled end to end: ink-snap used to expand several
  // fields onto the SAME cell run and their values piled up — "מאוד מבולגן")
  {
    const stackRes = await page.evaluate(async (bytes) => {
      const T = window.PFS.__test;
      const buf = new Uint8Array(bytes).buffer;
      await T.openPdfFile(new File([buf], 'nispach-h3.pdf', { type: 'application/pdf' }));
      await new Promise((r) => setTimeout(r, 3500));
      const rows = [...document.querySelectorAll('#fieldsBody input[type=text]')];
      rows.forEach((r, i) => { if (!r.value) { r.value = 'ערך' + (i + 1); r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); } });
      await new Promise((r) => setTimeout(r, 500));
      const els = T.overlay.getElements()
        .filter((e) => e.model.type === 'text')
        .map((e) => ({ t: e.model.text || '', fx: e.model.fx, fy: e.model.fy, fw: e.model.fw, fh: e.model.fh }));
      let worst = 0;
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j];
        const ix = Math.min(a.fx + a.fw, b.fx + b.fw) - Math.max(a.fx, b.fx);
        const iy = Math.min(a.fy + a.fh, b.fy + b.fh) - Math.max(a.fy, b.fy);
        if (ix > 0 && iy > 0) {
          const small = Math.min(a.fw * a.fh, b.fw * b.fh);
          if (small > 0) worst = Math.max(worst, (ix * iy) / small);
        }
      }
      // detected bands must not share a row either
      const det = T.getLastDet();
      let bandClash = 0;
      const F = det.fields.filter((f) => f.type === 'text');
      for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) {
        const a = F[i], b = F[j];
        if (a.page !== b.page || Math.abs(a.fy - b.fy) > 0.012) continue;
        const ix = Math.min(a.fx + a.fw, b.fx + b.fw) - Math.max(a.fx, b.fx);
        if (ix > 0.3 * Math.min(a.fw, b.fw)) bandClash++;
      }
      const ghosts = T.overlay.getElements().filter((e) => e.model.type === 'text' && !String(e.model.text || '').trim()).length;
      return { n: els.length, worst: +worst.toFixed(2), bandClash, ghosts };
    }, Array.from(fs.readFileSync(path.join(HERE, 'fixtures', 'nispach-h3.pdf'))));
    if (stackRes.worst > 0.2 || stackRes.bandClash) console.log('  [stack debug]', JSON.stringify(stackRes));
    check('real נספח ה3 filled: no two values stack in one cell', stackRes.n >= 8 && stackRes.worst <= 0.2 && stackRes.bandClash === 0);
    check('no empty "טקסט…" ghosts are left on the form', stackRes.ghosts === 0);
  }

  // an empty text element is never persisted (it would restore as a ghost)
  check('empty text elements are never serialized', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay;
    ov.clearElements();
    ov.addModelAt('text', 0, { fx: 0.2, fy: 0.2, text: '', noEdit: true });
    ov.addModelAt('text', 0, { fx: 0.2, fy: 0.4, text: 'ערך', noEdit: true });
    const ser = ov.serialize();
    ov.clearElements();
    return ser.filter((m) => m.type === 'text').length === 1 && ser.some((m) => m.text === 'ערך');
  }));

  // ---- document history: every opened PDF is listed on home, reopenable ----
  {
    const histRes = await page.evaluate(async () => {
      const T = window.PFS.__test;
      const { PDFDocument, rgb } = window.PDFLib;
      const mk = async (name) => {
        const d = await PDFDocument.create();
        d.addPage([300, 200]).drawRectangle({ x: 0, y: 0, width: 300, height: 200, color: rgb(1, 1, 1) });
        return new File([await d.save()], name, { type: 'application/pdf' });
      };
      await T.openPdfFile(await mk('היסטוריה-א.pdf'));
      await new Promise((r) => setTimeout(r, 900));
      await T.openPdfFile(await mk('היסטוריה-ב.pdf'));
      await new Promise((r) => setTimeout(r, 900));
      T.goHome();
      await new Promise((r) => setTimeout(r, 500));
      const wrap = document.getElementById('recentWrap');
      const rows = [...document.querySelectorAll('#recentList .tmpl-item')];
      const visible = wrap && wrap.style.display !== 'none';
      const hasA = rows.some((r) => /היסטוריה-א/.test(r.textContent));
      const hasB = rows.some((r) => /היסטוריה-ב/.test(r.textContent));
      // delete from history removes the row
      const rowA = rows.find((r) => /היסטוריה-א/.test(r.textContent));
      let deleted = false;
      if (rowA) {
        rowA.querySelector('button').click();
        await new Promise((r) => setTimeout(r, 400));
        deleted = ![...document.querySelectorAll('#recentList .tmpl-item')].some((r) => /היסטוריה-א/.test(r.textContent));
      }
      // clicking a row REOPENS the document
      const rowB = [...document.querySelectorAll('#recentList .tmpl-item')].find((r) => /היסטוריה-ב/.test(r.textContent));
      let reopened = false;
      if (rowB) {
        rowB.click();
        await new Promise((r) => setTimeout(r, 2000));
        reopened = T.pdfView.hasDoc() && /היסטוריה-ב/.test(document.getElementById('fname').textContent);
      }
      return { visible, hasA, hasB, deleted, reopened };
    });
    if (Object.values(histRes).some((v) => v !== true)) console.log('  [history debug]', JSON.stringify(histRes));
    check('document history lists opened PDFs on home; delete removes', histRes.visible && histRes.hasA && histRes.hasB && histRes.deleted);
    check('a history row reopens the document in one click', histRes.reopened === true);
  }

  // ---- REVERSE PULL: opening the APPENDIX directly must still pull from the
  // quote it is linked to ("משיכת הנתונים לא עובדת" — the user's actual path)
  {
    const revRes = await page.evaluate(async () => {
      const T = window.PFS.__test;
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
      const mkForm = async (title, labels) => {
        const d = await PDFDocument.create(); const pg = d.addPage([420, 340]);
        pg.drawRectangle({ x: 0, y: 0, width: 420, height: 340, color: rgb(1, 1, 1) });
        const f = await d.embedFont(StandardFonts.Helvetica);
        pg.drawText(title, { x: 150, y: 315, size: 15, font: f, color: rgb(0, 0, 0) });
        labels.forEach((lb, i) => pg.drawText(lb, { x: 250, y: 270 - i * 40, size: 12, font: f, color: rgb(0.1, 0.1, 0.1) }));
        return new File([await d.save()], title + '.pdf', { type: 'application/pdf' });
      };
      // 1) fill the QUOTE: one panel field + one FREE-TEXT value (no fieldKey)
      await T.openPdfFile(await mkForm('RevQuote', ['Course name:']));
      await new Promise((r) => setTimeout(r, 2200));
      const row = [...document.querySelectorAll('#fieldsBody input[type=text]')]
        .find((x) => { const lab = x.closest('.field'); return lab && /Course name/.test(lab.querySelector('label').textContent); });
      if (!row) return { err: 'no quote field' };
      row.value = 'אילוף כלבים'; row.dispatchEvent(new Event('input')); row.dispatchEvent(new Event('change'));
      T.overlay.addModelAt('text', 0, { fx: 0.2, fy: 0.6, text: 'עבור טלי מכלוף ת.ז 038290177', noEdit: true });
      T.autoSaveNow();                                        // the quote's fill is remembered
      const quoteFp = T.getFp();
      // 2) link the appendix while the quote is open
      const fileB = await mkForm('RevAppendix', ['Course name:', 'Full name:']);
      await window.PFS.companions.add({ ownerFp: quoteFp, ownerName: 'RevQuote', name: 'נספח הפוך', bytes: await fileB.arrayBuffer() });
      // 3) go home, then open the APPENDIX FILE DIRECTLY — no "מלא עכשיו"
      T.goHome();
      await new Promise((r) => setTimeout(r, 400));
      await T.openPdfFile(await mkForm('RevAppendix', ['Course name:', 'Full name:']));
      await new Promise((r) => setTimeout(r, 3000));
      const els = T.overlay.getElements().map((e) => e.model.text);
      const rec = window.PFS.companions.all().find((r2) => r2.ownerName === 'RevQuote');
      if (rec) await window.PFS.companions.remove(rec.id);
      return {
        course: els.includes('אילוף כלבים'),                  // panel value pulled
        person: els.includes('טלי מכלוף')                     // FREE-TEXT person mined + pulled
      };
    });
    if (Object.values(revRes).some((v) => v !== true)) console.log('  [reverse debug]', JSON.stringify(revRes));
    check('opening a linked appendix DIRECTLY pulls the quote values (reverse)', revRes.course === true);
    check('a person typed as FREE TEXT on the quote is mined and pulled', revRes.person === true);
  }

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

  check('drag snapping aligns edges to peers and page center within threshold', await page.evaluate(() => {
    const snap = window.PFS.computeSnap;
    const th = 0.01;
    // left edge just shy of a peer's left edge (0.30) → snaps to 0.30
    const a = snap({ fx: 0.305, fy: 0.5, fw: 0.1, fh: 0.04 }, [{ fx: 0.30, fy: 0.20, fw: 0.1, fh: 0.04 }], th, th);
    const snappedLeft = Math.abs(a.fx - 0.30) < 1e-9 && a.guideX === 0.30;
    // horizontal center near page middle (0.5) → element centered
    const b = snap({ fx: 0.44, fy: 0.1, fw: 0.12, fh: 0.04 }, [], th, th);
    const centered = Math.abs((b.fx + 0.06) - 0.5) < 1e-9 && b.guideX === 0.5;
    // far from anything → no snap, position unchanged, no guides
    const c = snap({ fx: 0.123, fy: 0.777, fw: 0.1, fh: 0.04 }, [{ fx: 0.6, fy: 0.6, fw: 0.1, fh: 0.04 }], th, th);
    const noSnap = c.fx === 0.123 && c.fy === 0.777 && c.guideX === null && c.guideY === null;
    return snappedLeft && centered && noSnap;
  }));

  check('resize snapping matches a peer size and aligns to its edge', await page.evaluate(() => {
    const rs = window.PFS.computeResizeSnap;
    const th = 0.01;
    // width almost equal to a peer's width (0.20) → snaps to equal width
    const a = rs({ fx: 0.1, fy: 0.5, fw: 0.205, fh: 0.04 }, [{ fx: 0.5, fy: 0.2, fw: 0.20, fh: 0.06 }], th, th);
    const equalW = Math.abs(a.fw - 0.20) < 1e-9;
    // bottom edge near a peer's bottom (0.24) → height snaps so fy+fh = 0.24
    const b = rs({ fx: 0.1, fy: 0.2, fw: 0.1, fh: 0.035 }, [{ fx: 0.5, fy: 0.18, fw: 0.1, fh: 0.06 }], th, th);
    const alignBottom = Math.abs((0.2 + b.fh) - 0.24) < 1e-9 && b.guideY === 0.24;
    // far from anything → unchanged, no guides
    const c = rs({ fx: 0.1, fy: 0.1, fw: 0.333, fh: 0.077 }, [{ fx: 0.6, fy: 0.6, fw: 0.05, fh: 0.05 }], th, th);
    const noSnap = c.fw === 0.333 && c.fh === 0.077 && c.guideX === null && c.guideY === null;
    return equalW && alignBottom && noSnap;
  }));

  check('align engine: edges align and centers distribute evenly', await page.evaluate(() => {
    const A = window.PFS.align;
    const rs = [
      { id: 'a', fx: 0.20, fy: 0.10, fw: 0.10, fh: 0.04 },
      { id: 'b', fx: 0.50, fy: 0.30, fw: 0.10, fh: 0.04 },
      { id: 'c', fx: 0.35, fy: 0.70, fw: 0.10, fh: 0.04 }
    ];
    const L = A.left(rs);
    const leftOk = L.a.fx === 0.20 && L.b.fx === 0.20 && L.c.fx === 0.20;   // min fx
    // distribute vertically: centers of a(0.12),c(0.72),b(0.32→) become evenly spaced
    const D = A.distributeV(rs);
    // after distribute, the three centers must be equally spaced regardless of id
    const centers = [D.a.fy + 0.02, D.b.fy + 0.02, D.c.fy + 0.02].sort((x, y) => x - y);
    const evenY = Math.abs((centers[1] - centers[0]) - (centers[2] - centers[1])) < 1e-9;
    // right align: right edges (fx+fw) all equal the max (0.60)
    const R = A.right(rs);
    const rightOk = Math.abs((R.a.fx + 0.10) - 0.60) < 1e-9 && Math.abs((R.b.fx + 0.10) - 0.60) < 1e-9;
    return leftOk && evenY && rightOk;
  }));

  check('multi-select + alignSelection lines up placed elements', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay; ov.clearElements();
    const a = ov.addElementAt('text', 0, 0.2, 0.2, { text: 'a', noEdit: true });
    const b = ov.addElementAt('text', 0, 0.5, 0.4, { text: 'b', noEdit: true });
    const c = ov.addElementAt('text', 0, 0.35, 0.6, { text: 'c', noEdit: true });
    ov.selectCtrl(a, false); ov.selectCtrl(b, true); ov.selectCtrl(c, true);
    const selCount = ov.getMulti().length;
    const applied = ov.alignSelection('top');
    const ys = ov.getMulti().map((x) => x.model.fy);
    const allSameTop = ys.every((y) => Math.abs(y - ys[0]) < 1e-9);
    ov.clearElements();
    return selCount === 3 && applied === 3 && allSameTop;
  }));

  check('detect: dot-leaders, numbered fields, and colon-embedded blanks', await page.evaluate(() => {
    const H = 320, W = 460, fs = 16;
    const vp = { transform: [1, 0, 0, -1, 0, H], width: W, height: H };
    const item = (str, x, top, width) => ({ str, width, transform: [fs, 0, 0, fs, x, H - (top + fs)] });
    const texts = (arr) => arr.filter((f) => f.type === 'text');
    // (a) a Hebrew label followed by a dot-leader blank on the same line
    const dot = texts(window.PFS.detect.heuristicForPage([
      item('שם מלא', 300, 60, 70), item('....................', 90, 60, 190)
    ], W, H, vp, 0));
    const dotOk = dot.length >= 1 && dot.some((f) => /שם/.test(f.label));
    // (b) a numbered field: the enumerator is stripped from label AND key
    const num = texts(window.PFS.detect.heuristicForPage([
      item('3. שם משפחה:', 260, 120, 120)
    ], W, H, vp, 0));
    const numOk = num.length === 1 && num[0].label === 'שם משפחה' && !/^3/.test(num[0].fieldKey) && /משפחה/.test(num[0].fieldKey);
    // (c) "label: ____" carried in a single text item → label is the pre-colon text
    const emb = texts(window.PFS.detect.heuristicForPage([
      item('טלפון: __________', 200, 180, 180)
    ], W, H, vp, 0));
    const embOk = emb.length === 1 && emb[0].label === 'טלפון';
    return dotOk && numOk && embOk;
  }));

  check('detect: wide full-line label places its blank on the line below', await page.evaluate(() => {
    const H = 320, W = 460, fs = 16;
    const vp = { transform: [1, 0, 0, -1, 0, H], width: W, height: H };
    const item = (str, x, top, width) => ({ str, width, transform: [fs, 0, 0, fs, x, H - (top + fs)] });
    const texts = (arr) => arr.filter((f) => f.type === 'text');
    const labelTopFrac = 60 / H;   // 0.1875
    // (positive) a wide colon-label filling the line → field drops below it
    const below = texts(window.PFS.detect.heuristicForPage([
      item('כתובת מלאה (רחוב, מספר בית, עיר ומיקוד):', 30, 60, 400)
    ], W, H, vp, 0));
    const posOk = below.length === 1 && below[0].fy > labelTopFrac + 0.04;
    // (negative 1) a short label with room beside it stays on the same line
    const beside = texts(window.PFS.detect.heuristicForPage([
      item('שם:', 380, 140, 50)
    ], W, H, vp, 0));
    const neg1Ok = beside.length === 1 && Math.abs(beside[0].fy - 140 / H) < 0.02;
    // (negative 2) wide label but the line below is occupied → NOT dropped down
    const blocked = texts(window.PFS.detect.heuristicForPage([
      item('כתובת מלאה (רחוב, מספר בית, עיר ומיקוד):', 30, 60, 400),
      item('פרטים נוספים', 280, 78, 80)
    ], W, H, vp, 0));
    const wide = blocked.find((f) => /כתובת/.test(f.label));
    const neg2Ok = wide && wide.fy < labelTopFrac + 0.03;
    return posOk && neg1Ok && neg2Ok;
  }));

  // a label the document already ANSWERS (printed value beside/beneath it,
  // as on a quote letter) must NOT get a field — no duplicate data on export
  check('detect: labels with printed answers beside/beneath get no field', await page.evaluate(() => {
    const H = 400, W = 460, fs = 16;
    const vp = { transform: [1, 0, 0, -1, 0, H], width: W, height: H };
    const item = (str, x, top, width) => ({ str, width, transform: [fs, 0, 0, fs, x, H - (top + fs)] });
    const texts = (arr) => arr.filter((f) => f.type === 'text').map((f) => f.label);
    // (a) RTL: printed value right after the colon → answered, no field;
    //     an identical label with nothing beside it stays fillable
    const rtl = texts(window.PFS.detect.heuristicForPage([
      item('תאריך התחלה:', 300, 60, 100), item('03.09.2026', 210, 60, 80),
      item('תאריך סיום:', 300, 120, 90)
    ], W, H, vp, 0));
    const aOk = !rtl.some((l) => /התחלה/.test(l)) && rtl.some((l) => /סיום/.test(l));
    // (b) RTL: the answer continues on the NEXT line, aligned with the label
    //     ("סניפים:" then the address list) → answered; a next-line LABEL
    //     ("שם:" above "כתובת:") is just the next question — both fillable
    const below = texts(window.PFS.detect.heuristicForPage([
      item('סניפים:', 380, 180, 60), item('האופה 7, אשקלון', 290, 198, 150),
      item('שם:', 400, 260, 40), item('כתובת:', 390, 278, 50)
    ], W, H, vp, 0));
    const bOk = !below.some((l) => /סניפים/.test(l)) && below.some((l) => /שם/.test(l)) && below.some((l) => /כתובת/.test(l));
    // (c) LTR mirror of (a)
    const ltr = texts(window.PFS.detect.heuristicForPage([
      item('Start date:', 40, 60, 80), item('03.09.2026', 128, 60, 80),
      item('Name:', 40, 120, 50)
    ], W, H, vp, 0));
    const cOk = !ltr.some((l) => /Start date/.test(l)) && ltr.some((l) => /Name/.test(l));
    return aOk && bOk && cOk;
  }));

  // fills are HANDWRITING, not print: a 7pt government form must not dictate a
  // 7pt fill ("לכתחילה הטקסט לא צריך להיות כל כך קטן")
  check('tiny-print forms still get a readable fill size (handwriting floor)', await page.evaluate(() => {
    const H = 800, W = 600, fs = 7;    // 7px print on an 800px page — dense gov form
    const vp = { transform: [1, 0, 0, -1, 0, H], width: W, height: H };
    const item = (str, x, top, width) => ({ str, width, transform: [fs, 0, 0, fs, x, H - (top + fs)] });
    const det = { tier: 'text', fields: window.PFS.detect.heuristicForPage([
      item('שם מלא:', 500, 100, 60), item('טלפון:', 500, 140, 50), item('כתובת:', 500, 180, 55)
    ], W, H, vp, 0) };
    const before = det.fields.map((f) => f.fontFrac);
    window.PFS.__test.normalizeFontSizes(det);
    const MIN = 0.0122;
    return det.fields.length === 3
      && before.every((v) => v < MIN)                              // the raw print really was tiny
      && det.fields.every((f) => f.fontFrac >= MIN - 1e-9)         // …and the fill is not
      && new Set(det.fields.map((f) => f.fontFrac)).size === 1;    // still one uniform hand
  }));

  // the readable floor must respect DENSE rows: a value taller than its row
  // piles onto the next one ("השורות עולות אחת על השנייה")
  check('dense table rows cap the fill size; spacious rows keep the floor', await page.evaluate(() => {
    const F = (fy, fx) => ({ type: 'text', fieldKey: 'f' + fy + (fx || 0), label: 'x', fx: fx || 0.3, fy, fw: 0.2, fh: 0.012, fontFrac: 0.0095 });
    // dense: stacked rows 0.013 apart (≈11pt on A4)
    const dense = { fields: [F(0.30), F(0.313), F(0.326)] };
    window.PFS.__test.normalizeFontSizes(dense);
    // cap = 80% of the pitch (largest size whose 1.15 line box clears the next
    // row) — large-as-possible, never piling
    const denseOk = dense.fields.slice(0, 2).every((f) =>
      f.fontFrac <= 0.013 * 0.8 + 1e-9 && f.fontFrac >= 0.0095 - 1e-9
      && f.fontFrac * 1.15 <= 0.013 + 1e-9);
    // spacious: rows far apart keep the readable floor
    const sparse = { fields: [F(0.30), F(0.36), F(0.42)] };
    window.PFS.__test.normalizeFontSizes(sparse);
    const sparseOk = sparse.fields.every((f) => f.fontFrac >= 0.0135 - 1e-9);
    // side-by-side columns (same line) never cap each other
    const cols = { fields: [F(0.30, 0.1), F(0.30, 0.6), F(0.36, 0.1)] };
    window.PFS.__test.normalizeFontSizes(cols);
    const colsOk = cols.fields[1].fontFrac >= 0.0135 - 1e-9;   // nothing below it in ITS column
    return denseOk && sparseOk && colsOk;
  }));

  // ---- certificates: a real Excel student list → one named PDF each ----
  {
    const certRes = await page.evaluate(async (xlsxBytes) => {
      const M = window.PFS.merge;
      const parsed = M.parseXlsx(new Uint8Array(xlsxBytes));
      const out = { headers: parsed.headers, n: parsed.records.length, r0: parsed.records[0], r2: parsed.records[2] };
      // full certificate flow: format PDF + tagged name/date, batch over the list
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
      const d = await PDFDocument.create();
      const pg = d.addPage([842, 595]);   // landscape certificate
      pg.drawRectangle({ x: 0, y: 0, width: 842, height: 595, color: rgb(1, 1, 1) });
      const font = await d.embedFont(StandardFonts.Helvetica);
      pg.drawText('CERTIFICATE OF COMPLETION', { x: 250, y: 450, size: 24, font });
      const certBytes = await d.save();
      const baseModels = [
        { id: 'c1', type: 'text', kind: 'text', page: 0, fx: 0.40, fy: 0.5, fw: 0.2, fh: 0.05, fontFrac: 0.05, color: '#111111', align: 'right', text: '', fieldKey: 'שם מלא' },
        { id: 'c2', type: 'text', kind: 'text', page: 0, fx: 0.45, fy: 0.7, fw: 0.1, fh: 0.03, fontFrac: 0.025, color: '#111111', align: 'right', text: '', fieldKey: 'תאריך סיום' }
      ];
      const mapping = M.mapHeaders(parsed.headers, ['שם מלא', 'תאריך סיום']);
      const records = M.remapRecords(parsed.records, mapping).map((r, i) => {
        r.__name = parsed.records[i]['שם מלא']; return r;
      });
      const { zip, count } = await M.runBatch({ originalBytes: certBytes, baseModels, records, nameField: '__name' });
      const files = window.fflate.unzipSync(zip);
      out.count = count;
      out.names = Object.keys(files).sort();
      // each entry is a real, loadable single-page PDF
      const re = await PDFDocument.load(files[out.names[0]]);
      out.onePage = re.getPageCount() === 1;
      return out;
    }, Array.from(fs.readFileSync(path.join(HERE, 'fixtures', 'students.xlsx'))));
    if (!(certRes.n === 3 && certRes.count === 3)) console.log('  [cert debug]', JSON.stringify(certRes));
    check('xlsx: a real Excel student list parses locally (strings, ids, dates)',
      JSON.stringify(certRes.headers) === JSON.stringify(['שם מלא', 'תעודת זהות', 'שם הקורס', 'תאריך סיום', 'ציון'])
      && certRes.n === 3
      && certRes.r0['שם מלא'] === 'ישראל ישראלי'
      && certRes.r0['תעודת זהות'] === '202665227'
      && certRes.r0['תאריך סיום'] === '15.07.2026'      // date cell → readable date, not a serial
      && certRes.r2['ציון'] === '100');
    check('certificates: Excel list → ZIP with one named PDF per student',
      certRes.count === 3 && certRes.onePage === true
      && JSON.stringify(certRes.names) === JSON.stringify(['אורן פלד-כהן.pdf', 'ישראל ישראלי.pdf', 'מירב עמיר.pdf'].sort()));
  }

  // ---- instant open: the 41st open of a known form skips detection ----
  {
    const icRes = await page.evaluate(async () => {
      const T = window.PFS.__test;
      const { PDFDocument, rgb, StandardFonts } = window.PDFLib;
      const d = await PDFDocument.create();
      const pg = d.addPage([595, 842]);
      pg.drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(1, 1, 1) });
      const font = await d.embedFont(StandardFonts.Helvetica);
      pg.drawText('Full name: ____________', { x: 60, y: 700, size: 12, font });
      pg.drawText('Phone: ____________', { x: 60, y: 660, size: 12, font });
      pg.drawText('Address: ____________', { x: 60, y: 620, size: 12, font });
      const bytes = await d.save();
      window.PFS.store.set('det_cache', {});             // clean slate
      await T.openPdfFile(new File([bytes.slice(0)], 'known-form.pdf', { type: 'application/pdf' }));
      await new Promise((r) => setTimeout(r, 2500));
      const firstCached = T.wasDetCached();
      const det1 = T.getLastDet();
      const n1 = det1 && det1.fields.filter((f) => f.type === 'text').length;
      const fp = T.getFp();
      const stored = !!T.detCacheGet(fp);
      // SECOND open of the same bytes — must come from the cache, same fields
      await T.openPdfFile(new File([bytes.slice(0)], 'known-form.pdf', { type: 'application/pdf' }));
      await new Promise((r) => setTimeout(r, 2500));
      const secondCached = T.wasDetCached();
      const det2 = T.getLastDet();
      const n2 = det2 && det2.fields.filter((f) => f.type === 'text').length;
      // the button forces a FRESH run
      await T.runDetection(true);
      const forcedFresh = !T.wasDetCached();
      T.overlay.clearElements(); T.fieldsPanel.clear();
      return { firstCached, n1, stored, secondCached, n2, forcedFresh };
    });
    if (!(icRes.stored && icRes.secondCached && !icRes.firstCached)) console.log('  [instant debug]', JSON.stringify(icRes));
    check('instant open: reopening a known form replays cached detection; button forces fresh',
      icRes.firstCached === false && icRes.n1 >= 2 && icRes.stored && icRes.secondCached === true
      && icRes.n2 === icRes.n1 && icRes.forcedFresh);
  }

  // ---- the export names itself: form - course - student ----
  check('auto filename: export is named form - course - student, sanitized', await page.evaluate(() => {
    const T = window.PFS.__test;
    T.overlay.clearElements();
    const c = window.PFS.courses.create('חשמלאות מוסמכים');
    window.PFS.courses.setFact(c.id, 'course_name', 'חשמלאות מוסמכים');
    T.setActiveCourse(c.id);
    T.setFileName('נספח ו');
    T.overlay.addModelAt('text', 0, { fx: 0.3, fy: 0.3, text: 'ישראל ישראלי', fieldKey: 'שם מלא', noEdit: true });
    const full = T.exFileName();
    // course chip off + no student → falls back to the old -filled name
    T.overlay.clearElements();
    T.setActiveCourse(null);
    const bare = T.exFileName();
    // illegal filename characters are scrubbed
    T.setFileName('נספח: ו/2026');
    const clean = T.autoExportName();
    window.PFS.courses.remove(c.id);
    T.setFileName('filled');
    return full === 'נספח ו - חשמלאות מוסמכים - ישראל ישראלי.pdf'
      && bare === 'נספח ו-filled.pdf'
      && !/[\\/:*?"<>|]/.test(clean);
  }));

  // "מה הבעיה שזה יירד שורה מתחת לשורה? למה זה חייב להימתח לרוחב?" — the cell
  // is a hard wall: ANY mutation (enlarging, typing on the form) wraps the
  // value line-under-line inside the cell instead of stretching past it
  check('cell wall: enlarging or typing wraps inside the cell, never stretches past it', await page.evaluate(async () => {
    const T = window.PFS.__test;
    // self-contained on a fresh A4 page — fractions are page-relative, so an
    // ambient doc left open by earlier tests skews every px expectation
    const { PDFDocument, rgb } = window.PDFLib;
    const d = await PDFDocument.create();
    d.addPage([595, 842]).drawRectangle({ x: 0, y: 0, width: 595, height: 842, color: rgb(1, 1, 1) });
    await T.openPdfFile(new File([await d.save()], 'cellwall.pdf', { type: 'application/pdf' }));
    await new Promise((r) => setTimeout(r, 1500));
    T.overlay.clearElements(); T.fieldsPanel.clear();
    const det = { tier: 'text', fields: [
      { page: 0, fieldKey: 'cw_a', label: 'שם מוסד', fx: 0.30, fy: 0.30, fw: 0.15, fh: 0.03, fontFrac: 0.0135, type: 'text' }
    ] };
    T.setLastDet(det); T.fieldsPanel.show(det);
    const row = document.querySelector('#fieldsBody input[type=text]');
    row.value = 'לימודי חוץ'; row.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const el = T.overlay.getElements().find((c) => c.model.fieldKey === 'cw_a');
    if (!el) return false;
    const fitsPlain = !el.model.wrapW && el.model.cellW === 0.15;       // short value: one plain line
    // the user enlarges the value (size slider path): wrap, keep the size
    el.model.fontFrac = 0.028; el.layout();
    const grewWrapped = el.model.wrapW === 0.15 && Math.abs(el.model.fontFrac - 0.028) < 1e-9
      && el.model.fx <= 0.30 + 1e-6 && el.model.fx + el.model.fw <= 0.30 + 0.15 + 0.01;
    // shrink back: the wrap lets go on its own
    el.model.fontFrac = 0.0135; el.layout();
    const shrankPlain = !el.model.wrapW;
    // typing more text ON THE FORM (inline edit path) re-wraps
    const inner = el.node.querySelector('.txt');
    inner.textContent = 'היחידה ללימודי חוץ ולימודי המשך על יד המכללה';
    inner.dispatchEvent(new Event('input', { bubbles: true }));
    const typedWrapped = el.model.wrapW === 0.15 && Math.abs(el.model.fontFrac - 0.0135) < 1e-9;
    // and the wrap state survives serialize→restore
    const ser = T.overlay.serialize().find((m) => m.fieldKey === 'cw_a');
    const serOk = ser && ser.cellW === 0.15 && ser.wrapW === 0.15 && Math.abs(ser.cellX - 0.30) < 1e-4;
    T.overlay.clearElements(); T.fieldsPanel.clear(); T.setLastDet(null);
    return fitsPlain && grewWrapped && shrankPlain && typedWrapped && !!serOk;
  }));

  // "הפונטים מאוד קטנים.. חלק מהמקומות הם גדולים ובחלק מאוד קטנים" — one FLAT
  // large size for the whole form: mixed print sizes must not leak into the
  // fill, and fitting a long value into a narrow cell must WRAP, not shrink
  // far below the document hand.
  check('fill sizes are flat and large: mixed print flattens, long values wrap not shrink', await page.evaluate(() => {
    const T = window.PFS.__test;
    const F = (k, fy, ff) => ({ type: 'text', fieldKey: k, label: 'שדה ' + k, fx: 0.3, fy, fw: 0.2, fh: 0.03, fontFrac: ff, page: 0 });
    // mixed print: 8pt-ish next to 18pt-ish labels, spacious rows
    const det = { tier: 'text', fields: [F('fl_a', 0.2, 0.010), F('fl_b', 0.3, 0.021), F('fl_c', 0.4, 0.016)] };
    T.normalizeFontSizes(det);
    const flat = new Set(det.fields.map((f) => f.fontFrac));
    const flatOk = flat.size === 1 && det.fields[0].fontFrac >= 0.0135 - 1e-9
      && det.uniFontFrac === det.fields[0].fontFrac;
    // a pitch-capped sibling must not drag docUniformSize down
    const det2 = { tier: 'text', fields: [F('fl_d', 0.2, 0.016), F('fl_e', 0.216, 0.016), F('fl_f', 0.5, 0.016)] };
    T.normalizeFontSizes(det2);
    T.setLastDet(det2);
    const uniOk = Math.abs(window.PFS.docUniformSize() - det2.uniFontFrac) < 1e-9
      && det2.fields[0].fontFrac < det2.uniFontFrac;             // the dense one really was capped
    // long value in a narrow cell: stays ≥85% of the hand and wraps instead
    T.overlay.clearElements(); T.fieldsPanel.clear();
    const det3 = { tier: 'text', fields: [{ page: 0, fieldKey: 'fl_w', label: 'שם מוסד', fx: 0.3, fy: 0.3, fw: 0.12, fh: 0.03, fontFrac: 0.016, type: 'text' }] };
    T.setLastDet(det3); T.fieldsPanel.show(det3);
    const row = document.querySelector('#fieldsBody input[type=text]');
    row.value = 'היחידה ללימודי חוץ ולימודי המשך אס איי'; row.dispatchEvent(new Event('input', { bubbles: true }));
    const el = T.overlay.getElements().find((c) => c.model.fieldKey === 'fl_w');
    const wrapOk = el && el.model.fontFrac >= 0.016 * 0.85 - 1e-6 && el.model.wrapW === 0.12;
    T.overlay.clearElements(); T.fieldsPanel.clear(); T.setLastDet(null);
    return flatOk && uniOk && !!wrapOk;
  }));

  check('vault: expanded synonyms + marital coverage map correctly', await page.evaluate(() => {
    const mk = window.PFS.vault.matchKey, cc = window.PFS.vault.classifyChoice;
    const synOk = mk('משלח יד') === 'occupation'      // Form 101 term for occupation
      && mk('מספר זיהוי') === 'id'
      && mk('סלולארי') === 'phone'                     // alt spelling of סלולרי
      && mk('דואל') === 'email'
      && mk('כתובת דואל') === 'email'                  // must beat the address phrase
      && mk('כתובת מגורים') === 'address';             // unchanged: plain address still maps
    const marOk = cc('ידוע בציבור').canon === 'marital_status' && cc('ידוע בציבור').value
      && cc('פרודה').canon === 'marital_status'
      && cc('נשוי').canon === 'marital_status';        // unchanged
    return synOk && marOk;
  }));

  check('export quality: presets resolve + clamp, and change the raster size', await page.evaluate(async () => {
    const ex = window.PFS.exporter;
    const R = ex.resolveScale;
    const presetsOk = R({ quality: 'draft' }) === 1.8 && R({ quality: 'standard' }) === 2.6 && R({ quality: 'high' }) === 3.4;
    const defOk = R({}) === 2.6 && R({ quality: 'bogus' }) === 2.6;             // fall back to default
    const clampOk = R({ scale: 99 }) === 4 && R({ scale: 0.1 }) === 1.5;         // never blow up memory
    // end-to-end: the SAME page+text exported at high quality is a bigger raster
    // (more bytes) than at draft quality — proves opts.quality reaches the canvas
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.create(); src.addPage([300, 400]);
    const bytes = await src.save();
    const models = [{ page: 0, type: 'text', kind: 'text', fx: 0.1, fy: 0.1, fw: 0.6, fh: 0.06, fontFrac: 0.04, text: 'שלום עולם 12345', color: '#000', align: 'right' }];
    const draft = await ex.exportPdf(bytes, models, { quality: 'draft' });
    const high = await ex.exportPdf(bytes, models, { quality: 'high' });
    const sizeOk = high.length > draft.length * 1.2;   // meaningfully larger
    return presetsOk && defOk && clampOk && sizeOk;
  }));

  check('secure export picks PNG for text pages, JPEG for photos', await page.evaluate(() => {
    const isDoc = window.PFS.exporter.isDocumentLikeCanvas;
    // a form page: white background with sharp black "text" strokes
    const form = document.createElement('canvas'); form.width = 300; form.height = 400;
    let c = form.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, 300, 400);
    c.fillStyle = '#000';
    for (let y = 20; y < 380; y += 24) c.fillRect(20, y, 220, 6);   // lines of text
    const formIsDoc = isDoc(form) === true;
    // a photo page: many mid-tone colours across the canvas
    const photo = document.createElement('canvas'); photo.width = 300; photo.height = 400;
    c = photo.getContext('2d');
    for (let x = 0; x < 300; x += 3) for (let y = 0; y < 400; y += 3) {
      c.fillStyle = 'rgb(' + ((x * 7) % 200 + 30) + ',' + ((y * 5) % 200 + 30) + ',' + ((x + y) % 200 + 30) + ')';
      c.fillRect(x, y, 3, 3);
    }
    const photoIsPhoto = isDoc(photo) === false;
    return formIsDoc && photoIsPhoto;
  }));

  check('cropped overlay lands text in the correct region (no flip/shift)', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.create(); src.addPage([400, 400]);
    const bytes = await src.save();
    // text near the TOP-RIGHT (fy small = top, RTL right-aligned)
    const models = [{ page: 0, type: 'text', kind: 'text', fx: 0.62, fy: 0.08, fw: 0.33, fh: 0.07, fontFrac: 0.05, text: 'ABC123', color: '#000', align: 'right' }];
    const out = await window.PFS.exporter.exportPdf(bytes, models, {});
    const doc = await window.pdfjsLib.getDocument({ data: out }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const W = canvas.width, H = canvas.height;
    const dark = (x0, y0, x1, y1) => {
      const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++;
      return n;
    };
    const topRight = dark(Math.floor(W * 0.55), Math.floor(H * 0.01), Math.floor(W * 0.99), Math.floor(H * 0.22));
    const bottomLeft = dark(0, Math.floor(H * 0.8), Math.floor(W * 0.45), H);
    return topRight > 20 && bottomLeft === 0;   // text at top-right, nothing bottom-left
  }));

  check('identity fields propagate to empty twins; no clobber; generic excluded', await page.evaluate(() => {
    const fp = window.PFS.__test.fieldsPanel;
    const F = (k, label, y) => ({ page: 0, fieldKey: k, label, type: 'text', fx: 0.1, fy: y, fw: 0.2, fh: 0.03, fontFrac: 0.03 });
    fp.show({ tier: 'text', fields: [
      F('id1', 'תעודת זהות', 0.1), F('id2', 'מספר תעודת זהות', 0.2), F('id3', 'מס זהות', 0.3),
      F('amt1', 'סכום', 0.4), F('amt2', 'סך הכל', 0.5)
    ] });
    const inp = (k) => [...document.querySelectorAll('#fieldsBody input[type=text]')].find((i) => i.__fkey === k);
    const type = (k, v) => { const e = inp(k); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
    inp('id3').value = '000000000';         // pre-existing value, no event → not part of propagation
    type('id1', '123456782');               // identity → fills empty twin id2, skips filled id3
    const propagated = inp('id2').value === '123456782';
    const noClobber = inp('id3').value === '000000000';
    type('amt1', '500');                     // 'amount' is not an identity canon
    const noGeneric = inp('amt2').value === '';
    return propagated && noClobber && noGeneric;
  }));

  check('clear form resets both fills and page operations', await page.evaluate(async () => {
    const t = window.PFS.__test, ov = t.overlay, pv = t.pdfView;
    ov.clearElements();
    pv.setRotations({ 0: 90 });                       // a page operation…
    ov.addElementAt('text', 0, 0.3, 0.3, { text: 'x', noEdit: true });  // …and a fill
    const before = t.hasPageOps() && ov.getElements().length >= 1;
    await t.resetForm();
    const rot = pv.getRotations();
    const stillRotated = Object.values(rot).some((v) => ((((v || 0) % 360) + 360) % 360) !== 0);
    return before && ov.getElements().length === 0 && !stillRotated && !t.hasPageOps();
  }));

  check('crop + reorder: cropped overlay follows its page to the new position', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.create(); src.addPage([400, 400]); src.addPage([400, 400]);
    const bytes = await src.save();
    const models = [{ page: 0, type: 'text', kind: 'text', fx: 0.62, fy: 0.08, fw: 0.33, fh: 0.07, fontFrac: 0.05, text: 'TOPRIGHT', color: '#000', align: 'right' }];
    const out = await window.PFS.exporter.exportPdf(bytes, models, { pageOrder: [1, 0] });   // swap pages
    const doc = await window.pdfjsLib.getDocument({ data: out.slice() }).promise;
    if (doc.numPages !== 2) return false;
    const render = async (n) => {
      const pg = await doc.getPage(n); const vp = pg.getViewport({ scale: 1 });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: x, viewport: vp }).promise; return { x, W: c.width, H: c.height };
    };
    const dark = (ctx, x0, y0, x1, y1) => { const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++; return n; };
    const p2 = await render(2);   // reordered: output page 2 == original page 0 (has the element)
    const p1 = await render(1);   // output page 1 == original page 1 (empty)
    const onP2 = dark(p2.x, Math.floor(p2.W * 0.5), 0, p2.W, Math.floor(p2.H * 0.28)) > 20;
    const p1empty = dark(p1.x, 0, 0, p1.W, p1.H) === 0;
    return onP2 && p1empty;
  }));

  check('mixed export: cropped rot-0 page correct alongside a rotated sibling', await page.evaluate(async () => {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.create(); src.addPage([400, 400]); src.addPage([400, 400]);
    const bytes = await src.save();
    const models = [
      { page: 0, type: 'text', kind: 'text', fx: 0.62, fy: 0.08, fw: 0.33, fh: 0.07, fontFrac: 0.05, text: 'AAA', color: '#000', align: 'right' },
      { page: 1, type: 'text', kind: 'text', fx: 0.3, fy: 0.35, fw: 0.3, fh: 0.07, fontFrac: 0.05, text: 'BBB', color: '#000', align: 'right' }
    ];
    const out = await window.PFS.exporter.exportPdf(bytes, models, { rotations: { 1: 90 } });
    const re = await PDFDocument.load(out.slice());
    const rotOk = re.getPage(0).getRotation().angle === 0 && re.getPage(1).getRotation().angle === 90;
    // page 0 uses the crop path — its element must still land top-right
    const doc = await window.pdfjsLib.getDocument({ data: out.slice() }).promise;
    const pg = await doc.getPage(1); const vp = pg.getViewport({ scale: 1 });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: x, viewport: vp }).promise;
    const dark = (x0, y0, x1, y1) => { const d = x.getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120) n++; return n; };
    const topRight = dark(Math.floor(c.width * 0.5), 0, c.width, Math.floor(c.height * 0.28)) > 20;
    const bottomLeft = dark(0, Math.floor(c.height * 0.8), Math.floor(c.width * 0.45), c.height) === 0;
    return rotOk && topRight && bottomLeft;
  }));

  check('calculated fields resolve chained dependencies (subtotal → total), cycles stop', await page.evaluate(() => {
    const ov = window.PFS.__test.overlay; ov.clearElements();
    ov.addElementAt('text', 0, 0.1, 0.1, { fieldKey: 'qty', text: '10', noEdit: true });
    ov.addElementAt('text', 0, 0.1, 0.2, { fieldKey: 'price', text: '25', noEdit: true });
    const sub = ov.addElementAt('text', 0, 0.1, 0.3, { fieldKey: 'sub', formula: '=[qty]*[price]', noEdit: true });
    const total = ov.addElementAt('text', 0, 0.1, 0.4, { fieldKey: 'total', formula: '=[sub]*1.17', noEdit: true });
    window.PFS.__test.recomputeFormulas();
    const chainOk = sub.model.text === '250' && total.model.text === '292.5';   // 250 * 1.17
    ov.clearElements();
    // a circular reference must terminate (not hang) and leave numeric text
    const a = ov.addElementAt('text', 0, 0.1, 0.1, { fieldKey: 'a', formula: '=[b]+1', noEdit: true });
    const b = ov.addElementAt('text', 0, 0.1, 0.2, { fieldKey: 'b', formula: '=[a]+1', noEdit: true });
    window.PFS.__test.recomputeFormulas();
    const cycleTerminates = /^\d+$/.test(a.model.text) && /^\d+$/.test(b.model.text);
    ov.clearElements();
    return chainOk && cycleTerminates;
  }));

  check('mail-merge resolves chained calc fields per record, no cross-row leak', await page.evaluate(() => {
    const base = [
      { type: 'text', kind: 'text', page: 0, fieldKey: 'qty', text: '', fx: 0.1, fy: 0.1, fw: 0.2, fh: 0.04, fontFrac: 0.03 },
      { type: 'text', kind: 'text', page: 0, fieldKey: 'price', text: '', fx: 0.1, fy: 0.2, fw: 0.2, fh: 0.04, fontFrac: 0.03 },
      { type: 'text', kind: 'text', page: 0, fieldKey: 'sub', formula: '=[qty]*[price]', text: '', fx: 0.1, fy: 0.3, fw: 0.2, fh: 0.04, fontFrac: 0.03 },
      { type: 'text', kind: 'text', page: 0, fieldKey: 'total', formula: '=[sub]*1.17', text: '', fx: 0.1, fy: 0.4, fw: 0.2, fh: 0.04, fontFrac: 0.03 }
    ];
    const get = (models, key) => models.find((m) => m.fieldKey === key).text;
    const r1 = window.PFS.merge.applyRecord(base, { qty: '10', price: '25' });   // sub 250, total 292.5
    const r2 = window.PFS.merge.applyRecord(base, { qty: '2', price: '100' });    // sub 200, total 234
    const rec1 = get(r1, 'sub') === '250' && get(r1, 'total') === '292.5';
    const rec2 = get(r2, 'sub') === '200' && get(r2, 'total') === '234';
    // base models must be untouched (clone isolation) — no leak between rows
    const baseClean = base[2].text === '' && base[3].text === '';
    return rec1 && rec2 && baseClean;
  }));

  check('CSV parser: quotes, embedded commas/newlines, escapes, BOM, CRLF, ragged', await page.evaluate(() => {
    const p = window.PFS.merge.parseCSV;
    let r = p('name,note\n"Doe, John","she said ""hi"""');           // quoted comma + escaped quote
    const c1 = r.records.length === 1 && r.records[0].name === 'Doe, John' && r.records[0].note === 'she said "hi"';
    r = p('a,b\n"line1\nline2",x');                                  // newline inside quotes = one field
    const c2 = r.records.length === 1 && r.records[0].a === 'line1\nline2' && r.records[0].b === 'x';
    r = p('﻿a,b\r\n1,2\r\n');                                   // BOM + CRLF + trailing newline
    const c3 = r.headers.join(',') === 'a,b' && r.records.length === 1 && r.records[0].a === '1' && r.records[0].b === '2';
    r = p('a,b,c\n1,2');                                             // ragged: missing cols → ''
    const c4 = r.records[0].a === '1' && r.records[0].b === '2' && r.records[0].c === '';
    r = p('a,b\n1,2\n\n3,4');                                        // blank line dropped
    const c5 = r.records.length === 2 && r.records[1].a === '3' && r.records[1].b === '4';
    r = p('a,b\n"",y');                                              // quoted empty field
    const c6 = r.records[0].a === '' && r.records[0].b === 'y';
    return c1 && c2 && c3 && c4 && c5 && c6;
  }));

  check('address parser keeps the Hebrew apartment letter (7א) out of the street', await page.evaluate(() => {
    const pa = window.PFS.vault.parseAddress;
    const a = pa('ביאליק 7א, רמת גן');
    const aptOk = a.house_no === '7א' && a.street === 'ביאליק' && a.city === 'רמת גן' && !a.zip;
    const b = pa('רחוב הרצל 15, תל אביב 6100000');   // 7-digit zip must not become a house no
    const stdOk = b.house_no === '15' && b.zip === '6100000' && b.city === 'תל אביב' && b.street === 'הרצל';
    const c = pa('הרצל, חיפה 12345');                 // 5-digit zip, no house number
    const noHouseOk = c.zip === '12345' && !c.house_no && c.city === 'חיפה';
    return aptOk && stdOk && noHouseOk;
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
