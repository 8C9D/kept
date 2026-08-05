# Wave-1 gate report

2026-08-05.
Scope built: domain layer, Sign in with Apple auth + session JWTs, all §6 routes on Hono, 90 Vitest tests (unit + integration against the real Postgres container).
Suite: 12 files, 90 tests, all green; `tsc --noEmit` clean.

## 1 · Prediction versus reality

Predicted before the first run: unit tests all pass; the three likeliest failures were the 409 duplicate-image test (drizzle's error wrapping), zod v4 custom message propagation, and a millisecond tie on the updated_at assertion.

Reality: 87 of 88 passed on the first run.
All three predicted risks held up fine - the one failure was in none of them.
It was a test-authoring bug: jose's `setIssuedAt` takes a `Date` or epoch seconds, and I passed an ISO string.
The fix changed the test's inputs, not its assertion.
Lesson recorded: my uncertainty pointed at the integration seams, but the actual failure was in the least-exercised corner of my own test code - the hand-built expired token.

A second, larger gap: I predicted the design's weak points before the reviewer pass, and named the me-PATCH overwrite, the helper mutation, and the 501 stubs.
The reviewer confirmed all three but found the two most important defects elsewhere (see §4) - neither was on my list.

## 2 · Judgment calls the spec did not settle

- **Sign-in never updates `email` after user creation.** Apple relay addresses churn and the spec says not to treat email as identity; first-seen wins. Escalate if wrong.
- **Session JWTs live 30 days with no revocation.** No logout or token invalidation is specified anywhere; at this user count a stolen-token story is thin, but pass 1 of the security review (§10B, due now) should rule on it.
- **The export filename short-id is the receipt uuid's first 8 hex chars**, not the spec example's `00042`-style sequence number - deterministic with no counter state. The spec's "deterministic, sortable, no collisions" is satisfied; the example's zero-padded look is not.
- **`POST /api/receipts` requires the image**, reading "create a receipt (after the image is uploaded)" as image-mandatory. The web multi-file backlog path (wave 7) fits this; a hypothetical image-less receipt does not exist in v1.
- **Upload content types are jpeg/png/pdf only**, matching the two capture paths (camera scan, emailed PDF). HEIC is notably absent: VisionKit scans export as JPEG, so it should not appear, but wave 4 will tell.
- **`status` may be set at creation** (a one-at-a-time capture that is confirmed on the spot saves as `confirmed` directly); omitting it yields the column's `pending` default.

## 3 · Things I believe are wrong or missing in the spec

1. **§6's export API has no persistence model.** A job id + polling contract implies a job store, and §5 defines none. Wave 2 must add one - likely an `export_jobs` table, because an in-memory store forgets running jobs on restart, and "the year-end export vanished" is the wrong failure mode. Routes answer 501 until then; recorded in the update log.
2. **The soft-delete/uniqueness interaction was unspecified and, as written, wrong.** Deleting a receipt and re-capturing the same file would 409 forever against a row the user cannot see. Fixed this wave: `receipt_images.deleted_at`, partial unique `WHERE deleted_at IS NULL`, delete stamps images transactionally. Spec amended.
3. **`users.display_name` NOT NULL contradicted how Sign in with Apple works** (name arrives client-side, first authorization only, possibly never). Made nullable; spec amended.
4. **§6's filter list omits `status`, which §6A's confirm queue needs.** Added; spec amended.
5. **Unpaginated list endpoint** - §6 defines no paging. Fine for three users; recorded so it is a decision, not an oversight.

## 4 · Self-review against §3's anti-pattern list

A read-only reviewer pass (the framework's builder/reviewer split) ran over the full diff with the §3 rubric and returned 17 findings: 2 high, 8 medium, 7 low.
The correction catalog, by category:

- **Error-masking (high, fixed):** every `c.req.json()` call was unguarded, so a malformed body surfaced as a 500 `internal_error` and polluted the log signal that "non-ApiError means real bug". Now a shared `readJsonBody` answers 400; regression-tested.
- **Design gap (high, fixed):** the soft-delete/sha256 deadlock above - found by the reviewer, not by me, and not by any test, because no test thought to delete and re-capture.
- **Non-falsifiable tests (medium, fixed):** both "smuggled userId" isolation tests would have passed even with `strictObject` removed, because a second independent 400 cause was present in each body. The tests guarding the project's central security rule could not fail. Rewritten so the smuggled key is the only possible cause, with message assertions.
- **Dead abstraction / comment drift (medium, fixed):** the `Cents` brand was production-dead - schemas validated plain numbers and the branding was only exercised by its own tests, while its doc comment claimed a guarantee the codebase did not have. The zod cents schema now brands values at the boundary. `checkReceiptArithmetic` remains legitimately caller-less (its consumers are the wave-4/7 confirm screens); its comment now says so instead of implying otherwise.
- **Duplication (medium, fixed):** status enum defined independently in zod and drizzle (now derived), the receipt field roster written out four times (now twice: the schemas share per-field definitions, and both handlers map the parsed body structurally instead of listing fields), connection string in three places (now one).
- **Inconsistency (medium, fixed):** receipts returned raw DB rows (leaking `userId`, `deletedAt`, and heavy `ocrRawText` on every list) while `/api/me` had a curated projection; receipts now project too, `ocrRawText` on detail only.
- **Isolation belt (medium, fixed):** the image lookup was the one receipt read relying on another query's scoping; now scoped to the session user itself.

**Weakest code, named:** the create handler's `...fields` spread into the insert.
It fixed the reviewer's forgotten-field complaint but has the mirror weakness: a future zod field with no matching column property would be spread in, fail no type check (spread does not trigger excess-property checking), and be silently ignored by drizzle.
The coupling between schema key names and column property names is real and invisible.
Second weakest: `/api/me`'s read-modify-write validates merged fiscal fields against stale state under concurrency; accepted and commented at this user count.
Also known and accepted: `noUncheckedIndexedAccess` stays off (recommended follow-up - it would harden every `rows[0]`), the list endpoint is unbounded, and the exportable-rows guarantee is proven at the query layer only, since the export API is 501 until wave 2 builds on `listExportableReceipts`.

## Gate verifications required by the kickoff

- Isolation: A→B get/patch/delete answer 404 (not 403), list never crosses users - proven by test.
- Pending receipts excluded from the export query; soft-deleted excluded from lists, counts, gets, and the export query - proven by test.
- Arithmetic mismatch is accepted by the server (warn-not-block) - proven by test; the warning UI is the clients'.
- Money round-trips as integer cents API→DB→API, floats rejected at the boundary with 400 - proven by test, including a DB-level integer check.
- updated_at moves via the Postgres trigger on API PATCH - proven by test and by direct psql UPDATE.
