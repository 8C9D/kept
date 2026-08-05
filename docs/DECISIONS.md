# Decisions

Append-only.
One dated entry per decision: what was decided, what was rejected, and why.

## 2026-08-05 - Wave-0 gate decisions (applied at start of wave 1)

**`receipts.deleted_at timestamptz NULL` added for soft delete.**
Rejected: hard delete, and a `deleted` enum status.
Why: §6 specifies a soft-delete endpoint and §10B makes retention (CRA six years) non-deferrable, but the wave-0 schema had no column to express it; a nullable timestamp records when, keeps `status` about the confirm workflow, and non-null rows are excluded from every list, count, and export.

**`receipt_images.user_id uuid NOT NULL` (FK to users) denormalized; unique `(user_id, sha256)` replaces `(receipt_id, sha256)`.**
Rejected: the original per-receipt unique, and enforcing user-scoped uniqueness through a join or application code.
Why: the per-receipt constraint only prevented the same image twice on one receipt, which is nobody's failure mode; a constraint that needs a join is not a constraint.
Scope honesty (recorded in the spec): the hash catches re-uploaded identical files, never a re-scanned paper receipt; near-duplicate detection on date+vendor+total is v2.

**`receipts.status` gains `DEFAULT 'pending'`.**
Rejected: no default (the wave-0 as-written reading).
Why: unlike `is_business`, status is a system state rather than a concealed human choice, and defaulting to `pending` is fail-closed because pending rows never export.

**`updated_at` is maintained by a Postgres trigger.**
Rejected: handler code and ORM hooks (`$onUpdate`).
Why: a field whose freshness depends on every future handler remembering it silently rots.

**`receipts.vendor` becomes nullable.**
Rejected: NOT NULL with a placeholder string.
Why: an illegible vendor is a real outcome; a forced placeholder corrupts the field for everyone reading it later.

## 2026-08-05 - Wave 1

**`users.display_name` becomes nullable.**
Rejected: NOT NULL with an empty-string default at sign-in.
Why: Apple provides the person's name only on first authorization, only client-side, and possibly not at all; an empty-string default is exactly the silently-defaulted-value anti-pattern the quality rules ban.

**`receipt_images` gains `deleted_at`; the `(user_id, sha256)` unique becomes partial (`WHERE deleted_at IS NULL`); DELETE stamps image rows with the receipt in one transaction.**
Rejected: hard-deleting image rows on receipt delete (breaks retention), and keeping the full unique (delete-then-recapture of the same file would 409 forever against an invisible row).
Why: surfaced by the wave-1 reviewer pass; the partial index keeps rows for CRA retention while freeing the duplicate slot.

**Validation with zod, JWTs with jose; no other new runtime dependencies.**
Rejected: hand-rolled validators (verbose, and a second validation style would inevitably appear) and hand-rolled JWT handling (signature verification is not code to write oneself).
Why: both are the boring standard choices; jose's remote JWK set also handles Apple's key rotation, which the kickoff explicitly required.

**The Apple test bypass is injection-only.**
Rejected: an env var or config flag selecting a fake verifier.
Why: the kickoff demands the bypass be structurally impossible in production; `createApp` takes a verifier as a value, the production entrypoint always constructs the real one, and no configuration value can swap them - tests build their own app with a fake.

**Export routes answer 501 until wave 2.**
Rejected: an in-memory job store now.
Why: §6 specifies job id + polling but §5 defines no job store; that design decision belongs to wave 2 (an `export_jobs` table is the likely answer, since losing job state on restart mid-year-end-export is the wrong failure mode), and an honest 501 keeps the auth surface final without pretending.

**`GET /api/receipts` gained a `status` filter beyond §6's list.**
Rejected: leaving the confirm queue to client-side filtering of full lists.
Why: §6A's "next unconfirmed receipt" queue on both clients needs the server to answer "pending only" directly.

**Object keys are prefixed `{userId}/` and creates reject keys outside the session user's prefix.**
Rejected: accepting any object key (would let a receipt point at, and later presign a download for, another user's stored object).
Why: closes the one path where client-supplied input could cross the isolation boundary.

## 2026-08-05 - Wave-1 gate review (the owner)

**Create and update handlers use explicit field maps, not spreads of the parsed body.**
Rejected: spreading the strict-schema output into the insert/update (my wave-1 shape).
Why: the spread silently drops a schema key with no matching column - an invisible failure - whereas a forgotten line in an explicit map is at least visible in review; §10's rule is explicit beats concise.

**`noUncheckedIndexedAccess` enabled.**
Rejected: leaving it off with per-site care.
Why: every `rows[0]` was typed as always-present; enabling it now, while the codebase is small, converts a class of latent 500s into compile errors.

**`GET /api/receipts` is paged: keyset cursor on `(purchased_at, created_at, id)` descending, limit default 50 / max 200.**
Rejected: unbounded lists ("fine at three users") and offset pagination.
Why: the §6A backlog import makes lists large on day one, and keyset cursors stay stable under concurrent inserts, which is exactly the backlog-import condition.

**`users.token_version`, carried as the JWT `tv` claim, checked on every verify.**
Rejected: unrevocable 30-day JWTs.
Why: bumping the integer revokes all of a user's sessions at the cost of one indexed read per request; tokens without the claim are invalid by construction.

## 2026-08-05 - Wave 2

**Export jobs persist in an `export_jobs` table, not process memory.**
Rejected: an in-memory job map.
Why: a restart must not lose a running year-end export; rows also give the polling endpoint failure reasons for free.

**The export request is `{fiscalYearEndingIn}` XOR `{periodStart, periodEnd}`.**
Rejected: fiscal-only (blocks the §12 quarterly affordance) and range-only (pushes the fiscal derivation to clients, against §5.1's derive-at-request-time rule).
Why: both spec statements are satisfied, and the range shape is the seam a quarterly picker plugs into.

**Zip label: the calendar year when the period is exactly Jan 1 to Dec 31, otherwise the explicit range.**
Rejected: always labelling with the period's end year.
Why: calling a Mar-31 fiscal year "Receipts-2026" would mislabel nine months of 2025; a range names itself honestly.

**XLSX money cells are numeric with a `0.00` format; CSV money is a decimal string; both derive from integer cents via string assembly.**
Rejected: string money in the XLSX (does not sum in Excel) and cents÷100 floating-point division.
Why: the accountant gets cells that behave like money while no value in the pipeline ever passes through a float.

**A missing image fails the export loudly; the reason is recorded on the job.**
Rejected: skipping the row or shipping the zip without the file.
Why: a silent gap in an accountant's zip is the error-masking failure mode §10 exists to prevent.

**Zip assembly is in-memory.**
Rejected: streaming to storage.
Why: legibility wins at this scale; the seam to change it is one function (`buildZip`), noted in place.

**Dependencies: archiver 8 (class API) and exceljs at runtime; adm-zip as a test-only dependency for zip inspection.**
Rejected: hand-rolling zip reading in tests.
Why: the suite must open the artifact it produced; adm-zip stays out of the runtime dependency tree.
