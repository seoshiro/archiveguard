# Third-party packages

Versions are pinned in `package.json` and `package-lock.json`. Every locked tarball uses `registry.npmjs.org`. The dependency validation script compares direct-package versions, licenses, tarball URLs, and SHA-512 integrity values with official registry metadata; it writes a local ignored evidence file.

| Runtime package | Version | License | Role |
|---|---|---|---|
| React / React DOM | 19.3.0 | MIT | Browser interface |
| piexifjs | 1.0.6 | MIT | JPEG EXIF read/write behind validation |
| exifr | 7.1.3 | MIT | Independent capture-field readback |
| fflate | 0.8.3 | MIT | ZIP output |
| lucide-react | 1.49.0 | ISC | Interface icons |

Unmodified runtime copyright/license notices and related bundled-package notices ship in [THIRD_PARTY_NOTICES.txt](public/THIRD_PARTY_NOTICES.txt). `scripts/third-party-notices.mjs` regenerates that file from installed packages.

IBM Plex Sans regular, medium and semibold WOFF2 files are vendored from the official [`@ibm/plex-sans` 1.1.0 package](https://www.npmjs.com/package/@ibm/plex-sans), published by the [IBM Plex project](https://github.com/IBM/plex). The original [SIL Open Font License 1.1](public/fonts/IBMPlexSans-LICENSE.txt) ships beside the fonts and is included in the combined notices. These files are unmodified. Redistribution and commercial use are permitted under the license conditions; retain copyright/license notices and observe reserved font name rules for modifications. See [design provenance](docs/DESIGN.md) for the package integrity and verified Kazakh character coverage.

Only functional [Lucide icons](https://lucide.dev/license) are included through the pinned ISC-licensed package. Icons and fonts are bundled locally; no asset provider receives a visitor or archive request.

TypeScript and Playwright use Apache-2.0; jpeg-js uses BSD-3-Clause; Vite, Vitest, ESLint, their direct plugins, and types use MIT. Installed packages retain their license files. jpeg-js is used only for synthetic fixture generation and tests; the repair path never recompresses images. No unknown metadata executable, paid service, or third-party photo asset is used.
