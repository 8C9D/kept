# Decisions

Append-only.
One dated entry per decision: what was decided, what was rejected, and why.

## 2026-08-06 - Wave 4

**Integration tests run against `kept_test` (TEST_DATABASE_URL), and the setup refuses a config that resolves to the dev database.**
Rejected: the shared dev database (the wave-3 "known tradeoff", corrected by the wave-4 kickoff), and comparing raw URL strings.
Why: `npm test` emptied every table, destroying the signed-in device user before each hand-tested wave; the guard compares host, port, and database name so differing credentials cannot disguise the same database, and a unit test proves the refusal.

**`total_cents` and `is_business` are nullable while `pending`; a CHECK constraint plus route validation make confirmed rows complete.**
Rejected: local drafts confirmed before any create (loses a sixty-receipt backlog scan to an app kill, contradicts §6A's "each becomes its own pending receipt"), and fabricated fallbacks (a guessed total is tax-data corruption; a defaulted `is_business` is the exact thing §5.2 forbids).
Why: batch mode's pending rows must be able to state what the parser could not read and what no human has chosen; constraints 2 and 3 hold through `status` - pending rows never export, confirming still requires the explicit choice - and `is_business` still has no default at any layer.

**When no date parses, the client sends the capture day as the date suggestion; `purchased_at` stays NOT NULL.**
Rejected: a nullable `purchased_at` (NULLs poison the keyset row-comparison cursor, silently dropping rows from pages), and refusing to create the receipt (blocks the whole batch on its worst page).
Why: most single captures happen the day of purchase, the confirm screen presents the date amber like every suggestion, and a wrong-looking date on a backlog receipt is exactly what the queue exists to fix. Wave 7's PDF upload path has no capture-day story and needs its own answer.

**`ocr_suggestions` jsonb records the parser's output verbatim at create and is immutable; `npm run parse-accuracy` compares it with confirmed fields.**
Rejected: a hand-maintained spreadsheet (the kickoff explicitly bars it), an in-app accuracy screen (a sixth screen for a one-wave measurement), and re-running the parser over stored raw text (the heuristics need line positions, which raw text does not keep).
Why: confirming receipts is the recording - the report reads suggestions against what the human went on to save, prints per-field accuracy plus every correction, and refuses when the real user is missing or ambiguous, in the db:claim mould. Stated limit: a wrong suggestion the human accepted counts as correct, because the confirmed value is the only truth available.

**Scanned pages are created as pending receipts immediately, then confirmed via a queue over server-side pending rows; single capture is a batch of one.**
Rejected: two code paths (immediate confirm for single capture, queue for batches).
Why: one path means the scan is durable server-side the moment it lands - abandoning the confirm queue loses nothing - and a batch scanned now and a backlog pending from last week are worked down by the same queue (§6A.3). Until the wave-5 outbox, a mid-batch network failure stops at the failing page with retry; pages already saved stay saved.

**A 409 `duplicate_image` during batch save counts as saved and the batch continues.**
Rejected: surfacing it as a failure.
Why: byte-identical bytes already attached to one of the user's receipts means the receipt exists - the common cause is a retry after a create whose response was lost, and failing the batch for it would punish recovery.

**Amber marks prefilled suggestions only; focusing or editing a field clears it permanently; the date is always amber initially.**
Rejected: marking absent fields amber (an absence is a stated fact, not a suggestion to review), and clearing only on edit (a correct suggestion would never clear).
Why: §10A.1's design - the screen starts loud and goes quiet as the person works down it; the date is always prefilled (parsed or capture-day fallback), so it always starts amber.

**The confirm queue's "Later" sets a receipt aside client-side for the sitting; nothing is written server-side.**
Rejected: a server-side snooze state.
Why: the receipt simply stays pending - the §5.2a badge keeps nagging, which is the design - and the queue just stops re-offering it until reopened.

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

## 2026-08-05 - Wave-2 gate review (the owner)

**`whose` is documented as existing for accountant-side merging.**
Rejected: leaving the column's purpose unstated (it read as redundant and would eventually be "cleaned up").
Why: constancy within a file is the design - it is what makes a combined workbook of two people's exports unambiguous.

**Export zips are artifacts, not records; the exports storage prefix gets a 30-day lifecycle expiry.**
Rejected: keeping zips forever as records.
Why: receipts and images are the retained records and a zip is regenerable from them; the job row keeps its period, and past the window a job reports `expired` - re-runnable, not downloadable.

**`GET /api/export` (own jobs, newest first) added now.**
Rejected: deferring the job list to wave 7.
Why: cheapest while the export code is loaded; the web export screen needs a history list regardless.

**In-memory zip assembly is guarded by row-count and byte budgets (10 000 receipts / 256 MiB defaults) that fail the job with an actionable reason.**
Rejected: building streaming assembly.
Why: with the backlog and six-year retention a year's zip can reach gigabytes; an explicit "export a shorter period" refusal is a far better outcome than an OOM crash, and streaming is real complexity for a case a shorter period solves.

**A job stranded in `queued` past five minutes reports a computed `stale` status.**
Rejected: a background sweeper process and any new state.
Why: the only problem was a client polling forever; a computed status solves exactly that, and nothing is written back - the row stays the truthful history.

## 2026-08-05 - Cross-wave observation

**Runtime predictions have been consistently pessimistic; the real friction has landed at dependency seams every wave.**
Evidence: wave 1 predicted drizzle error-wrapping and zod message failures - all passed; the one failure was a jose API misuse in my own test.
Wave 2 predicted CSV assertion and archiver behavioral failures - all 105 tests passed first run; the two stumbles were compile-time dependency changes (archiver 8 dropping its factory API, exceljs typings predating Node's generic Buffer).
How to apply: spend prediction effort on dependency upgrade notes and API surfaces at the seams (read the changelog of a newly added or majored dependency before writing against it), and trust the tested-runtime paths more.

## 2026-08-05 - Wave-2 gate review, second pass (the owner)

**`stale` also covers `running` jobs older than 30 minutes.**
Rejected: the first pass's queued-only rule (the owner's own, revised on my flag).
Why: a crash mid-run strands a poller identically to a crash before the claim; both clocks run from `created_at` since the claim follows creation within milliseconds, and 30 minutes is far above anything the byte budget permits.

**The export byte budget stands alone; `maxReceipts` removed.**
Rejected: keeping a row-count limit alongside the byte cap.
Why: row count is a worse-measured proxy for the same memory bound - ten thousand small receipts and two thousand large ones are the same problem, and only bytes see that - and it could refuse an export that would have fit, the wrong failure for the one artifact the accountant needs.

## 2026-08-05 - Wave 3

**The Xcode project file is hand-written using filesystem-synchronized groups (Xcode 16+ format).**
Rejected: XcodeGen or Tuist (a new tool dependency, and the kickoff bars global installs), and the classic pbxproj that lists every file (rots on every file add, a standing merge hazard).
Why: synchronized root groups make the on-disk folders the source of truth, so adding a Swift file never touches the project file again.

**Swift 5 language mode, not Swift 6 strict concurrency.**
Rejected: SWIFT_VERSION = 6.
Why: the codebase is a teaching text (§10.1) and strict concurrency's annotation ceremony would obscure the code it decorates; async/await and @MainActor isolation are still used throughout, so the migration later is additive, not corrective.

**Models depend on a KeptAPI protocol; APIClient is its one production implementation.**
Rejected: view models on the concrete APIClient (every model test would build HTTP responses), and a client with per-endpoint request/decode logic (the kickoff's call-site-per-endpoint ban).
Why: transport-level behaviour (token attachment, error mapping, decoding) is proven once in APIClientTests against a stubbed transport; model tests script the protocol and stay about model decisions.

**Session state is one enum (signedOut / signingIn / signedIn); a 401 on any authenticated call and a missing keychain token both funnel into the same rejected-session path.**
Rejected: boolean flags, and treating sign-in's own 401 (a rejected Apple identity token) as a session death.
Why: the two flavours of 401 mean different things - one ends a session, the other fails a sign-in attempt - and conflating them would tear down nothing on a failed sign-in yet show the wrong message.

**Session token in the keychain as a generic password with kSecAttrAccessibleWhenUnlocked.**
Rejected: UserDefaults (barred by the kickoff - a plaintext plist in unencrypted backups), and AfterFirstUnlock accessibility (my first choice, reversed by the reviewer pass: loosening a security posture for the wave-5 background outbox before it exists is speculative generality applied to security).
Why: WhenUnlocked is the strictest class the app's current foreground-only reads allow; the save path re-asserts accessibility on update, so wave 5 can widen it with one constant and existing installs migrate on their next save.

**Pending count comes from a probe query (status=pending, limit 200) and is typed exact / atLeast / unknown.**
Rejected: counting pending rows in loaded pages only (a silent undercount, the error-masking pattern), adding a server count endpoint this wave (server changes are out of wave-3 scope; flagged in the gate report instead), and coupling the probe to the list fetch (my first shape, reversed by the reviewer pass: a failed badge count was taking down a successfully loaded list).
Why: the server has no count endpoint; one maximum-size page gives an exact count up to 200, an honest "200+" beyond, and a stated "unavailable" when the probe fails - never a quiet zero.

**purchasedAt stays a yyyy-mm-dd String in the model, formatted by one UTC-pinned formatter.**
Rejected: decoding it as Date (invents a midnight and a timezone the receipt never had, and shifts a day west of Greenwich), and a custom CalendarDate type (weight without a second consumer; reconsider when the wave-4 confirm form edits dates).
Why: the API's calendar date survives round trips untouched, and display formatting pins UTC on both parse and render.

**Server address is UserDefaults-configurable in-app, defaulting to http://localhost:3000.**
Rejected: a build-setting-only base URL (repointing a device build means rebuilding), and .env-style config (no such mechanism on iOS).
Why: the simulator reaches a local server with zero setup, and a device on the same network is a settings-sheet edit away; ATS is relaxed for local networking only, revisited at distribution.

## 2026-08-05 - Wave-3 gate review (the owner)

**`GET /api/receipts` returns `pendingCount`; the iOS 200-row probe is deleted.**
Rejected: a dedicated count endpoint (more API surface for one integer), and keeping the probe (honest but heavy, and it saturates at "200+" exactly when the backlog is largest).
Why: the badge's number rides the response both clients already fetch; it is user-wide and filter-independent because the badge means "receipts awaiting confirmation", not "pending rows on this page".

**Local object storage is MinIO in docker-compose, behind the real S3-compatible adapter.**
Rejected: a filesystem stub (does not exercise the presigned path, which is the part that will actually break), and deferring storage to deployment (wave 4's capture flow cannot run against a server that cannot store).
Why: one adapter serves MinIO locally and R2 in deployment; the dev default auto-creates its bucket so a clean checkout serves images with no ceremony, and `STORAGE_*` env repoints it (`npm run storage:init` creates the bucket for custom endpoints, e.g. the Mac's .local name so a phone can reach presigned URLs).

**Presigned PUT URLs sign the content-type header.**
Rejected: the SDK default (only `host` is signed), under which the upload-url schema's jpeg/png/pdf restriction was decorative - any bytes under any declared type would store.
Why: found by the integration test asserting a mismatched PUT fails; the signature now binds the PUT to the type the client declared and the server validated.

**The device-test reassignment SQL became `npm run db:claim`.**
Rejected: leaving it as a documented psql snippet in the gate report.
Why: it is dev tooling that will run every time a fresh device user needs data; the script refuses loudly when the real user is missing or ambiguous, and moves receipts and their denormalized image rows in one transaction.

**iOS: ReceiptListModel reaches the API only through GuardedReceiptLoader.**
Rejected: the wave-3 shape - a generation counter captured and re-checked by convention at every await (my own gate report named it the weakest code: nothing enforced the discipline on future awaits).
Why: the model holds no raw API reference, so a bare unguarded await is unrepresentable; every response arrives as an Outcome whose `.superseded` case the compiler forces callers to handle, and waves 4-5 add more async to exactly this class.

**`npm run dev` loads `.env.local` via node --env-file, creating the file if absent.**
Rejected: relying on shell-sourced environment (the wave-0 status quo; nothing loaded the file the docs told the owner to fill).
Why: found during device verification when the server died mid-run - 110 tests were green while the real entry point was unrunnable from a clean checkout, because tests inject config and never execute src/index.ts.

**Standing rule (framework guardrail 7, mirrored in CLAUDE.md): every gate starts the real server the real way and lands one real request.**
Rejected: treating a green dependency-injected suite as evidence the system starts.
Why: injection discipline makes the entry point structurally untested - the better the tests, the bigger the blind spot - so gate closure now requires the production start command, from a clean checkout, and one real response, recorded in the gate report.
