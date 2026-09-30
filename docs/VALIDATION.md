# Release validation

ArchiveGuard 1.0 is validated with synthetic and hostile fixtures. These checks support the declared JPEG/sample scope; they do not certify arbitrary archive formats or business demand.

## Reproducible checks

- Fresh installation from the pinned official npm lockfile, with install scripts disabled.
- Lint, strict TypeScript, 244 core tests, production build, and seven isolated-browser scenarios.
- Current dependency audit and direct-package registry integrity/license validation.
- Independent source review and a browser deployment mounted under `/archiveguard/`.

Core tests cover safe paths and normalization collisions, file/resource limits, malformed/deep/duplicate-key JSON, multiple date sources, exact/ambiguous/truncated/shared-sidecar matching, unsupported formats, conflicts, missing sidecars, duplicates, strict JPEG/TIFF validation, hostile metadata, preservation checks, transactional failure, HTML escaping, and CSV formula neutralization. Independent synthetic JPEG decoding verifies repaired pixels are identical; source, output, and non-EXIF hashes are checked separately.

Browser checks exercise the synthetic archive, actual selected JPEG/JSON files, malformed JSON and unsupported ZIP input, explicit conflict decisions, quarter-hour offset policy, GPS acknowledgement, ZIP download and independent metadata readback, original-file preservation, no external/body requests, delayed-demo replacement, cancellation, download invalidation, mobile overflow, keyboard focus return, privacy links, deployment paths, release commit metadata, and unavailable worker support.

CI runs the same seven browser scenarios against a fresh production build using official Chromium. Deployment is gated on successful checks. The public `version.json` must match the workflow head SHA; the same suite can verify a hosted URL using the environment variables documented in the README. Screenshots in this repository show only original synthetic demo assets.

## Practical limits

Tests cannot guarantee arbitrary JPEG decodability. The production parser checks the supported frame and initial scan layout and preserves non-EXIF bytes. Unsupported metadata disables repair rather than guessing. No personal photo folders are scanned by the tests or app. The user explicitly selects inputs, and originals should remain independently backed up.
