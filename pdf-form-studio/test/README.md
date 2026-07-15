# Fillo — end-to-end smoke suite

Drives the real app in Chromium (via `playwright-core`) and asserts the core
flows: smart-vault auto-fill, empty-field markers, completeness meter, date
picker, keyboard field-nav, page thumbnails, ☐ checkbox detection, handwriting
number BiDi (no mirroring), dark theme, scan-enhance, help panel, and signature
placement — plus "no uncaught JS errors" across the run.

## Run

```bash
cd pdf-form-studio
npm install          # installs playwright-core
npm test             # → node test/e2e.mjs
```

The suite needs a Chromium/Chrome binary. It auto-detects common locations; set
`PW_CHROMIUM=/path/to/chrome` if yours isn't found:

```bash
PW_CHROMIUM="/usr/bin/google-chrome" npm test
```

Exit code is non-zero if any check fails. `test/fixtures/form.pdf` is the sample
Hebrew form used by the suite.
