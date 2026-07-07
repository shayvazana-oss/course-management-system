# Third-party components (vendored, offline)

This folder contains unmodified redistributable builds of open-source libraries
and fonts so the app runs fully offline with no CDN. Each retains its own license.

| Component | Version | License | Files |
|-----------|---------|---------|-------|
| pdf-lib | 1.17.1 | MIT | `pdf-lib/pdf-lib.min.js` |
| pdf.js (pdfjs-dist) | 4.6.82 | Apache-2.0 | `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` |
| pdf.js standard fonts | 4.6.82 | Foxit / Liberation (see `pdfjs/standard_fonts/LICENSE_*`) | `pdfjs/standard_fonts/*` |
| Heebo (via @fontsource/heebo) | — | SIL OFL 1.1 | `fonts/Heebo-*.woff2` |

- pdf-lib — https://github.com/Hopding/pdf-lib (MIT)
- pdf.js — https://github.com/mozilla/pdf.js (Apache-2.0)
- Heebo — https://fonts.google.com/specimen/Heebo (SIL Open Font License 1.1)
