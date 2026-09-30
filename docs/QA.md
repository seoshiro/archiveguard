# Exploratory QA and regression coverage

The published 1.0 app was explored in isolated Chromium profiles using only synthetic inputs. A route/control checklist covered import, review, export and help, then repeat/interruption/error paths. The resulting 1.1 changes were independently reviewed and exercised against a frozen production build under `/archiveguard/`. This is bounded coverage, not a claim that every possible archive or browser has been tested.

| Surface | Exercised controls and scenarios |
|---|---|
| Import | File/folder selection, drag/drop path, demo, empty/canceled picker, same files twice, newer selection while busy, Cancel, New sample, failed demo/worker |
| Inventory | Every filter, search/clear/no matches, file evidence, duplicate/invalid/unsupported entries, long Unicode paths, keyboard table scrolling |
| Review | Open/close/Escape/focus return, filter hiding the original trigger, ambiguous candidate selection, keep/repair/skip, changed candidate resetting its decision |
| Metadata | Conflicting dates, missing offset, capture versus creation/digitized sources, malformed/empty/oversized JSON/JPEG, embedded GPS preservation without coordinate disclosure |
| Export | Fixed-offset selection, acknowledgement, reports-only result, decision changes revoking output, canceled export, Blob allocation failure/retry, repeated download, offline ZIP and two-reader metadata/hash verification |
| Navigation | Brand, workflow steps, browser Back/Forward, direct step URL, reload clears archive, separate privacy window |
| Locales | EN/RU/KK mid-work changes, persistence/blocked/invalid storage, cross-tab preference sync, localized help/errors/aria/reports, report-language snapshot and stable machine schema |
| Layout | Seven widths in both orientations, long translations/filenames, focus-visible and 44 px targets, 200% CSS zoom at two widths |

## Reproduced defects fixed

| Reproduction | Former behavior | Fixed behavior |
|---|---|---|
| Click brand from review/export | Only moved the fragment | Returns to inventory, preserving the sample |
| Inspect filter accessibility | Selected filter had no pressed state | Each filter exposes `aria-pressed` |
| Open review, filter away its row, close | Focus fell to body | Returns to available search/main fallback |
| Export only unsupported inputs | Claimed verified photo copies | Reports-only heading, warning and screen-reader notice |
| Force demo HTTP failure | Raw parser error | Localized actionable safe error |
| Navigate steps, then browser Back | Workflow/history diverged | URL and workflow state stay synchronized |
| Cancel or reset a busy workflow | Removed control retained no useful focus | Focus moves to main or Choose files |
| Review JSON or unsupported input | Called it an original JPEG | File-type-specific evidence and accurate copy guidance |
| Force ZIP Blob allocation failure | Uncaught exception, no alert | Visible retryable error without losing decisions |
| Deep-link export then interrupt import | Route could retain the old step | Scan start immediately synchronizes inventory URL |
| Unknown report reason | English/raw fallback could leak into readable report | Safe translated generic fallback; user paths still escaped verbatim |
| English header/Russian help at 200% zoom | Small overflow or clipped link | Header/select and help label wrap within their available width |
| Inspect a small non-empty sample | Batch size rounded to `0 MiB` | Localized KiB size below 1 MiB; regression assertion in all three locales |

The regression suite checks visible errors, original preservation, localized output and no external or request-body archive traffic. All committed screenshots and fixtures are synthetic. Native download completion after leaving the app is browser/OS-controlled, and old open tabs may need a refresh after deployment; neither condition is presented as guaranteed storage.
