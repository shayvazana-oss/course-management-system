/* build.mjs — generate a single self-contained HTML from the served app.
 * Inlines CSS (fonts as base64 data: URIs), pdf-lib, pdf.js + its worker,
 * fflate, and every PFS module + app.js as plain inline scripts. The result
 * runs with NO external requests (CSP-safe) and works from file:// or hosted.
 * pdf.js runs on the MAIN THREAD (the worker is inlined → window.pdfjsWorker),
 * avoiding any blob:/worker CSP issues.
 *
 * Usage: node build.mjs   → writes dist/pdf-form-studio.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const rd = (p) => fs.readFileSync(path.join(DIR, p), 'utf8');
const b64 = (p) => fs.readFileSync(path.join(DIR, p)).toString('base64');
const escScript = (s) => s.replace(/<\/script>/gi, '<\\/script>');

// 1) CSS with fonts inlined as data: URIs (replaces the @import in styles.css)
let heebo = rd('vendor/fonts/heebo.css').replace(
  /url\('\.\/([^']+\.woff2)'\)/g,
  (_m, f) => `url('data:font/woff2;base64,${b64('vendor/fonts/' + f)}')`
);
const styles = rd('styles.css').replace(/@import\s+url\('\.\/vendor\/fonts\/heebo\.css'\);?\s*/, '');
const css = `/* Heebo (inlined) */\n${heebo}\n/* app styles */\n${styles}`;

// 2) Start from index.html
let html = rd('index.html');

// inline the stylesheet
html = html.replace(/<link rel="stylesheet" href="styles\.css"\s*\/>/, `<style>\n${css}\n</style>`);

// single-file runtime config: main-thread pdf.js, no external standard fonts
html = html.replace(
  /window\.PFS_WORKER_SRC\s*=\s*'[^']*';\s*[\r\n]+\s*window\.PFS_STDFONTS\s*=\s*'[^']*';/,
  "window.PFS_WORKER_SRC = null; /* single-file: pdf.js runs main-thread */\n  window.PFS_STDFONTS = null;"
);

// 3) inline every <script src="..."> ; after pdf.min.js also inline the worker
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_m, src) => {
  const rel = src.replace(/^\.\//, '');
  let out = `<script>\n${escScript(rd(rel))}\n</script>`;
  if (rel.endsWith('vendor/pdfjs/pdf.min.js')) {
    out += `\n<script>/* pdf.js worker (main-thread) */\n${escScript(rd('vendor/pdfjs/pdf.worker.min.js'))}\n</script>`;
  }
  return out;
});

// sanity: no leftover external refs
const leftover = [...html.matchAll(/(src|href)="(\.\/|vendor\/|js\/)[^"]+"/g)].map((m) => m[0]);
if (leftover.length) console.warn('WARNING leftover external refs:', leftover.slice(0, 8));

fs.mkdirSync(path.join(DIR, 'dist'), { recursive: true });
const outPath = path.join(DIR, 'dist', 'pdf-form-studio.html');
fs.writeFileSync(outPath, html);
console.log(`built ${outPath}  (${(html.length / 1048576).toFixed(2)} MB, ${leftover.length} external refs)`);

// Also emit a body-only variant for the Artifact host (which injects its own
// <!doctype>/<head>/<body>). Keep the <style> (valid in body) + inner markup + scripts.
const style = (html.match(/<style>[\s\S]*?<\/style>/) || [''])[0];
const title = (html.match(/<title>[\s\S]*?<\/title>/) || [''])[0];
const bodyInner = (html.match(/<body>([\s\S]*?)<\/body>/) || [null, ''])[1];
const artifact = `${title}\n${style}\n${bodyInner}`;
const artPath = path.join(DIR, 'dist', 'pdf-form-studio.artifact.html');
fs.writeFileSync(artPath, artifact);
console.log(`built ${artPath}  (${(artifact.length / 1048576).toFixed(2)} MB)`);
