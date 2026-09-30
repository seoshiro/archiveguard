# Release validation

ArchiveGuard 1.1 is validated with synthetic and hostile fixtures. These checks support the declared JPEG/sample scope; they do not certify arbitrary archive formats or business demand.

## Reproducible checks

- Fresh installation from the pinned official npm lockfile, with install scripts disabled.
- Lint, strict TypeScript, 269 core tests, production build, and 57 isolated-browser scenarios.
- Current dependency audit and direct-package registry integrity/license validation.
- Independent source review and a browser deployment mounted under `/archiveguard/`.

Core tests cover safe paths and normalization collisions, file/resource limits, malformed/deep/duplicate-key JSON, multiple date sources, exact/ambiguous/truncated/shared-sidecar matching, unsupported formats, conflicts, missing sidecars, duplicates, strict JPEG/TIFF validation, hostile metadata, preservation checks, transactional failure, HTML escaping, and CSV formula neutralization. Independent synthetic JPEG decoding verifies repaired pixels are identical; source, output, and non-EXIF hashes are checked separately.

Browser checks exercise the synthetic archive, actual selected JPEG/JSON files, malformed JSON and unsupported ZIP input, explicit conflict decisions, quarter-hour offset policy, GPS acknowledgement, ZIP download and independent metadata readback, original-file preservation, no external/body requests, delayed-demo replacement, cancellation, download invalidation, mobile overflow, keyboard focus return, privacy links, deployment paths, release commit metadata, and unavailable worker support.

The expanded suite adds actual folder selection, ambiguous/shared matches, distinct creation/digitized evidence, batch limits, repeated selections/downloads, interrupted scans/exports, Blob allocation failures, blocked preference storage, worker retry, separate help windows, workflow history, and locale changes during review. All EN/RU/KK locales are checked at widths 320/360/390/414/768/1280/1440 in portrait and landscape with long Unicode filenames; these checks include review and a real ZIP download. Another three cases check 200% CSS zoom at 768 and 1440. Tables scroll in their own keyboard-accessible region.

CI runs the same 57 browser scenarios against a fresh production build using official Chromium. Deployment is gated on successful checks. The public `version.json` must match the workflow head SHA; the same suite can verify a hosted URL using the environment variables documented in the README. Screenshots in this repository show only original synthetic demo assets. The exploratory control checklist and fixed defects are recorded in [QA.md](QA.md).

## Practical limits

Tests cannot guarantee arbitrary JPEG decodability. The production parser checks the supported frame and initial scan layout and preserves non-EXIF bytes. Unsupported metadata disables repair rather than guessing. No personal photo folders are scanned by the tests or app. The user explicitly selects inputs, and originals should remain independently backed up.

Mobile results use Chromium viewport emulation, not physical devices. Safari, Firefox, operating-system file pickers and real touch hardware are not certified. An app cannot detect whether a native browser download was successfully saved to the user's chosen disk location; the tested browser download event is checked for failure and the resulting ZIP is independently opened and verified. The catalogs are complete and exercised but have not had an independent native-speaker editorial review.
