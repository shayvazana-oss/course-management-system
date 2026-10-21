# Fillo — end-to-end smoke suites

Two Chromium suites (via `playwright-core`):

- **`test/e2e.mjs`** — serves the source tree over http and asserts the core
  flows: smart-vault auto-fill (incl. single-choice gender/marital/health
  auto-tick + learning), address/name derivation, amount-in-words (with
  agorot), ID & business-number checksums, email/phone validation, required
  fields, checkbox/radio detection + exclusivity, one-tap signature/stamp on
  detected lines, page rotation (export round-trip), quick-setup, handwriting
  number BiDi, dark theme, scan-enhance, help, load-error messages — plus "no
  uncaught JS errors".
- **`test/single-file.mjs`** — opens the inlined build
  (`dist/pdf-form-studio.html`) straight from `file://`, the way a published
  Artifact runs, and asserts every module inlined correctly, core APIs work, a
  PDF renders, and nothing throws. Catches build/inlining regressions the
  source suite can't see.

## Run

```bash
cd pdf-form-studio
npm install          # installs playwright-core
npm test             # build + e2e + single-file
npm run test:e2e     # source suite only
npm run test:single  # build + single-file suite only
```

The suite needs a Chromium/Chrome binary. It auto-detects common locations; set
`PW_CHROMIUM=/path/to/chrome` if yours isn't found:

```bash
PW_CHROMIUM="/usr/bin/google-chrome" npm test
```

Exit code is non-zero if any check fails. `test/fixtures/form.pdf` is the sample
Hebrew form used by the suite.
