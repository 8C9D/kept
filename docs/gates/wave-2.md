# Wave-2 gate report

2026-08-05.
Scope built: the four wave-1 gate-review changes, then export generation - `export_jobs` table, job runner, XLSX/CSV/zip assembly, real `POST /api/export` + `GET /api/export/:id`.
Suite: 14 files, 105 tests, all green; `tsc --noEmit` clean with `noUncheckedIndexedAccess` on.

## Gate verification - the artifact, not the suite

Prediction was written before inspection: zip contents, sheet name, the 15 headers in order, numeric money cells with `0.00` format, ascending date order, calendar `images/yyyy/mm/` paths, every `image_filename` cell resolving, CSV nulls as empty cells.

Reality, inspected with tools independent of the generator (`unzip`, cell-level ExcelJS reads, file-existence checks on disk):

- `Receipts-2026.zip` → `receipts-2026.xlsx`, `receipts-2026.csv`, three images under `images/2026/01|02|03/`.
- XLSX sheet "Receipts": headers exactly `receipt_id … notes` in spec §8 order; money cells are numbers (100, 13, 113, -25, -3.25, -28.25) with `numFmt 0.00`; null money cells empty.
- CSV: same data, decimal-string money including a negative refund, `"synthetic note, with a comma"` correctly quoted, null vendor as an empty cell with an `unknown-vendor` image filename.
- The pending fixture receipt appears nowhere; every `image_filename` cell resolves to a real extracted file; extracted image bytes are byte-identical to what was uploaded.

Prediction matched reality on every point.
The suite additionally proves what a single artifact cannot: deleted/out-of-period/other-user exclusions, the fiscal-period derivation (Mar-31 year end → `2025-04-01..2026-03-31`, labelled as the range, not a year), job isolation across users (404), and the failure path (missing image → status `failed`, reason recorded, no zip).

## Prediction versus reality, build phase

Predicted trouble at the CSV substring assertions and archiver behavior; all 105 tests passed on the first full run.
The two stumbles were compile-time, both dependency-shaped: archiver 8 removed the classic `archiver("zip")` factory in favor of `new ZipArchive()`, and exceljs's typings predate Node's generic `Buffer` (bridged by one documented cast in a test).
Pattern across three waves: my runtime predictions have been pessimistic, and the actual friction is consistently at dependency seams.

## Judgment calls

- **Zip label** - calendar year only when the period is exactly Jan 1-Dec 31; otherwise the explicit range. The spec example implied `Receipts-2026` universally, but that name on a Mar-31 fiscal year would mislabel nine months of 2025.
- **`whose`** - the user's display name, empty when null. The column reads as redundant in a fully per-user export (§3 below).
- **Export request body** - fiscal year XOR explicit range, reconciling §5.1 ("derived from the user's fiscal year settings at request time") with §12 ("the export takes a date range").
- **In-memory zip assembly** - simple over streaming at this scale; the seam is one function.
- **No concurrency limit on jobs** - two simultaneous POSTs both run. Accepted at this user count; the queued→running claim guard already prevents double-running a single job.

## Things I believe are wrong or unresolved in the spec

1. **The `whose` column has no source of truth for its purpose.** Exports are strictly per-user (§3 constraint 4), so every row carries the same value. It only becomes meaningful if the accountant merges two people's exports - plausible, but unstated. Worth one sentence in §8 saying why it exists, or it will eventually be "cleaned up" by someone reasonable.
2. **Export retention/cleanup is unspecified.** Every export run stores a full zip in R2 forever. At projected volume this is cents, but §10B's retention story should say whether export zips are records (keep) or artifacts (expire); an expiring presigned URL on an expired object is a confusing failure.
3. **`GET /api/export` (list own jobs) does not exist in §6.** The web export screen (wave 7) will want "your recent exports" rather than requiring the client to remember job ids. Cheap to add then; recorded now.

## Self-review against §3/§10's anti-pattern list

- **Fixed during the wave:** `generateExport` originally looked the image key up twice, the second time behind a defensive throw that could never fire - dead code masquerading as care; restructured so each row pairs with its storage key once. The `UUID_PATTERN` helper had been copy-adapted into a second route file; extracted to the shared validation module.
- **Weakest code, named:** the main export integration test is one long test doing setup, six exclusions, CSV, XLSX, and click-through assertions in a single body - a failure there will take reading to localize. I kept it because the fixtures are expensive and the assertions genuinely share one artifact, but it is the least legible test in the suite.
- **Second:** `buildZip`'s stream plumbing (PassThrough + finish/error/warning events) is the one place in the codebase where correctness depends on event ordering rather than types; it is covered by real extraction in tests, and archiver warnings are escalated to failures rather than logged, but it is the code I would want a second reader on.
- **Known and accepted:** `void runExportJob(...)` is fire-and-forget - correct per the polling contract, but a crash between job insert and the first status write leaves a job `queued` forever; a stale-job sweep is deliberately not built at three users. The moderate npm audit findings now number six: drizzle-kit's bundled esbuild (dev-time only) and `uuid <11.1.1` in exceljs's transitive tree (a buffer-bounds issue in uuid v3/v5/v6 generation with a caller-provided buffer - a code path this project never invokes); flagged not fixed.
