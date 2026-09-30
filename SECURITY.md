# Security and support scope

ArchiveGuard 1.x supports bounded JPEG samples and Google Photos JSON sidecars. It has no upload API, server account, analytics SDK, or secret input. It never deletes or overwrites selected originals. Unsupported metadata disables repair instead of weakening preservation checks.

For a reproducible defect, open a repository issue with the browser/version, error message, and a synthetic fixture. Do not attach private photos, real sidecars, GPS coordinates, or private audit reports. Support is best effort for this free project.

Runtime input is bounded by file count, total/per-file bytes, JSON depth/value counts, TIFF logical size, directory/tag limits, and JPEG segment/dimension limits. EXIF capture fields are read back with two engines, and non-EXIF bytes are preserved. These checks do not prove arbitrary JPEG image decodability or the historical truth of a user-supplied timestamp. See the README and privacy page for supported boundaries.
