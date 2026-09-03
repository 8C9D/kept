# Wave-4 gate report

2026-08-06.
Scope built: scan → OCR → confirm → save, per the wave-4 kickoff.
iOS: `VNDocumentCameraViewController` capture (single and batch - a single capture is a batch of one), on-device `VNRecognizeTextRequest` OCR, the §7.3 heuristics in a pure Swift `Parsing/` module with no VisionKit or UIKit imports, the §7.2/§10A.1 confirm screen with all state in a camera-free model, presigned upload → create-pending, and the confirm queue ("next unconfirmed receipt" as a repeatable action).
Server: the pending-create contract (`total_cents`/`is_business` nullable while pending, CHECK-constrained complete at confirmed), the immutable `ocr_suggestions` record, `npm run parse-accuracy`, and the kickoff §1 correction - integration tests now run against a separate `kept_test` database.
Suites: server 150 tests green (`tsc --noEmit` clean), iOS 114 tests green, app builds with zero warnings, installs and launches on the simulator (screenshot inspected).

## 1 · The kickoff §1 correction, verified by hand

`TEST_DATABASE_URL` (default `postgres://kept:kept@localhost:5432/kept_test`) now names the integration-test database; a vitest globalSetup creates and migrates it.
The setup refuses to run when the value resolves to the same database as `DATABASE_URL` - compared by host, port, and database name (loopback spellings normalized), not raw strings - and the refusal is proven by unit tests plus one live run: with `TEST_DATABASE_URL` pointed at the dev database, the suite exits 1 with zero tests executed and the reason stated.
Hand verification as demanded: dev row counts recorded (2 users, 5 receipts), full suite run, counts identical afterward.
`db:seed`, `db:claim`, and `npm run dev` still target the dev database untouched.

## 2 · Prediction versus reality

Predicted: the Swift regex and date-parsing seams were the likeliest small failures; the parser heuristics and model tests would mostly pass first run; the camera plumbing was unverifiable here and would carry the device-run risk.

Reality, in the pattern the cross-wave observation now predicts fourth time running:

- The seams did bite, but at compile time and cheaply: bare-slash regex literals are opt-in in Swift 5 mode (switched to `#/.../#`), and `Fixtures`/`StubKeptAPI` needed mechanical updates for the widened API surface.
- One genuine parser defect was caught by my own fixture test on its first run: the two-digit-year date pattern could match the *middle* of a longer number - `"2026-02-30"` (an invalid date) partially matched as `26-02-30` and fabricated `"2030-02-26"`. Fixed by fencing every numeric pattern with consumed non-digit boundaries (Swift's regex engine has no lookbehind). A date parser inventing dates is exactly the quiet-wrong-answer class this project cannot afford, and it would have survived to the device run had the fixture not included an impossible date on purpose.
- One fabricated "fact" of my own was caught by guardrail 5: I wrote a test asserting a "precomputed" SHA-256 that I had not computed. Running `shasum` independently produced a different digest. The habit of verifying against the source exists for precisely this.
- The two worst defects of the wave were found by the reviewer pass, not by me and not by the suites - same lesson as waves 1 and 3: I predict where I already suspect weakness; the reviewer finds the weakness I do not suspect. Both are in §5 below.

## 3 · What was verified, and what was not

Verified here, per §10.2's asymmetry:

- The parsing module against 26 fixture tests: five whole-receipt shapes (crisp grocery, tip-bearing restaurant, thousands-separator PDF invoice, faded fallback-only, empty) plus per-heuristic edge cases (subtotal exclusion, TAXABLE vs TAX, phone-number vs tax-number, top-third date preference, tallest-in-top-quarter vendor, unsorted input).
- The confirm screen's state logic without a camera: amber initialization from the parser's own suggestion record, permanent clearing on touch, the counter, the non-blocking arithmetic check, save gating with stated reasons, the full PATCH payload including the date round-trip, error surfacing.
- The capture pipeline without a camera: page → OCR (stubbed) → parse → upload-url → PUT → create-pending, per-page suggestions and raw text on the create, sha-256 against an independently computed digest, resume-from-failure, re-entrancy under a deliberate interleave, duplicate-409 recovery.
- The queue: pending-only fetching, set-aside semantics, done states, failure retry.
- Server contract end to end by integration test: pending creates without total/choice, confirmed creates and transitions refusing incompleteness with the missing field named, the CHECK constraint firing on a direct DB write that bypasses the API, suggestion immutability (PATCH carrying `ocrSuggestions` is a 400), suggestions round-tripping through the detail route.
- Guardrail 7: `npm run dev` from the real entrypoint (a stale pre-wave server was found holding port 3000, killed, and restarted on current code), MinIO bucket resolution logged, `GET /api/me` answering the correct unauthorized envelope, an unauthenticated `POST /api/receipts/upload-url` likewise.
- Migration artifact inspected in psql: both columns nullable, `ocr_suggestions` present, `receipts_confirmed_complete_ck` with the exact predicate.
- The app installs and launches on the simulator (screenshot); the capture button correctly states "Scanning needs a device with a camera" there.

**Not verifiable here - The owner's half, and this wave's real output:**

- The camera, the scanner UI, and real OCR: the simulator has no camera. Everything from "tap Capture" to recognized text is exercised for the first time on the device.
- **Per-field parse accuracy on ten real receipts** - the number that becomes the parser's specification (§7.3). The device script below ends with `npm run parse-accuracy`, which prints it.
- The DatePicker's UTC pinning under real interaction, and whether tapping the date row reliably clears its amber (see §5 finding 1 and §6 step 8).

## 4 · Judgment calls the spec did not settle

All recorded with rejected alternatives in `DECISIONS.md`; the load-bearing ones:

- **Scanned pages become server-side pending receipts immediately; the confirm queue works over server rows.** One code path for one receipt or eighty, durable the moment the scan lands, and the queue treats a fresh batch and last week's backlog identically. Cost, stated: until the wave-5 outbox, a mid-batch network failure stops at the failing page (retry offered; saved pages stay saved), and scanning requires connectivity.
- **When no date parses, the client sends the capture day as the suggestion** rather than making `purchased_at` nullable (which would poison the keyset cursor - NULLs make the row-comparison silently drop rows). The confirm screen states the fabrication outright: "No date was found on the receipt - this is the day it was scanned." (reviewer-driven, §5 finding 3).
- **Amber marks exactly what the parser suggested**, read from the `ocr_suggestions` record the detail route now returns; value-presence is the fallback only for rows created before this wave. Absences are stated, not tinted; the date is always amber because it is always prefilled.
- **Ambiguous `01/14/2026`-style dates read month-first** (the common POS print order here); day-first only when the first number cannot be a month. The accuracy measurement exists to falsify exactly this kind of guess.
- **A 409 `duplicate_image` during batch save counts as saved.** Disputed by the reviewer (§5 finding 4) and kept, with the reasoning tightened: two photographs never share bytes (spec §5's own scope-honesty note), so off the camera path the only cause is a retry after a create whose response was lost - the receipt exists, and continuing is recovery, not masking. The test now also asserts exactly one create per page.
- **"Later" in the queue is client-side for the sitting** - the receipt stays pending, the badge keeps nagging, nothing new is written.
- The §7.2 arithmetic check runs only when both a total and a subtotal exist to compare (spec silent); blank HST/other-tax count as zero, invalid text suppresses the warning since it is separately named at the field and at the save button.

## 5 · Self-review against the anti-pattern list

A read-only reviewer pass ran with the §10 rubric plus this kickoff's watch list and returned 17 findings: 2 high, 8 medium, 7 low.
It also verified: no force unwrap or `try!` in any new Swift, the parsing module genuinely free of VisionKit/UIKit, and `ocr_suggestions` structurally immutable.
The correction catalog, by category:

- **Timezone correctness (high, fixed):** the confirm screen's DatePicker was not pinned to the UTC frame its parse/format helpers use, so west of Greenwich it displayed the previous day - and "correcting" what it showed saved the *next* day, potentially across a fiscal-year boundary. The picker now runs under `ReceiptFormat.utcCalendar`/`utcTimeZone`, the model round-trip is under test, and the device script checks the rendered date against the row (step 8). This was the wave's worst finding: a silent wrong tax figure triggered precisely when the user is being careful.
- **Concurrency (high, fixed) - the wave-3 lesson found again:** `CaptureFlowModel` mutated its page queue across awaits with no re-entrancy guard; a double-tapped retry could save the head page twice and silently drop a later one, with the duplicate create masked by the 409 handling. Now single-flight (`isProcessing`), with a gate-based regression test reproducing the interleave. That this recurred one wave after `GuardedReceiptLoader` was built for the same class of bug is the finding to remember, not the fix.
- **Error-masking (medium, two fixed, one disputed):** Vision's underlying error was discarded (now carried in `UnreadableImageError` - during the accuracy run it is the only diagnostic); `accuracyPercent` rendered "no data" as `0%` (now null/`-`); the duplicate-409 swallow kept, reasoning above.
- **Duplication (medium, fixed):** the detail screen carried a verbatim copy of the AsyncImage block the wave's own `ReceiptImageView` was created to own (now shared); `SuggestedTextRow`/`SuggestedMoneyRow` were near-copies (merged into one `SuggestedFieldRow`).
- **Crash paths on unbounded input (medium, fixed):** cents scale-up used trapping `*` in both the OCR amount scanner and the keyboard money parser - a 19-digit misread (or typed) run fit `Int` but trapped at `× 100`, crashing mid-batch. Both now use checked arithmetic and drop/refuse; tests cover the boundary from both sides.
- **Suggestion honesty (medium, fixed):** amber was inferred from value-presence, making the fabricated capture-day date indistinguishable from a parsed one and mislabelling any human-written value on a pending row as a machine suggestion. The detail route now returns `ocr_suggestions`; marking follows the record; the fallback date is called out in words.
- **Contract typing (medium, fixed):** the presigned content type rode as a duplicated bare string between two calls whose agreement the signature enforces; now a shared `ImageUploadContentType` enum mirroring the server's schema.
- **Tests written to pass (medium, fixed):** the calendar-date test rebuilt its expectation with the implementation's own recipe (now an independent `DateFormatter` path); the duplicate-409 test asserted only the count (now also creates-per-page); `timestamp(of:)` - an API-syntax string - was untested (now asserted against shape and round-trip).
- **Negative money asymmetry (low, fixed):** `MoneyInput` could print `-45.20` but not parse it, so a refund prefill would have blocked its own confirmation with no keystroke able to unblock it.
- **Assorted (low, fixed):** loopback-spelling aliases in the test-database guard; the queue's pending count published but never rendered (now shown while loading); a dead padding branch; an unused import; phase-enum label inconsistency.

**Weakest code, named:** the confirm screen's touch wiring in `ConfirmReceiptView` - amber clearing rides on focus changes for text fields but on a `simultaneousGesture` plus value-change for the DatePicker, which is view-layer convention, untestable in unit tests, and plausibly flaky against the compact picker's popover. If step 8 of the device script shows the date's amber not clearing on tap, that wiring is the suspect. Second: `CaptureFlowModel` even after its fix - single-flight by flag is a discipline, not a structure; if wave 5's outbox adds more async to this class, it should get the `GuardedReceiptLoader` treatment (guard by construction) rather than a second flag. Third: `ConfirmReceiptView` is now the largest view file in the app; it delegates all decisions, but it is the file to watch when wave 5 touches capture again.

## 6 · Things I believe are wrong or missing in the spec

1. **The spec contradicted itself about batch mode, and wave 4 had to pick a side.** §5 declared `total_cents` required and `is_business` "required at capture", while §6A requires every batch-scanned page to become a pending receipt - including pages whose total no parser can read and whose business choice no human has made. Resolved by the nullable-while-pending amendment (§5, update log), which I believe is the only reading under which §6A is implementable at all; the constraint-2/3 guarantees ride on `status`, exactly as §5.2a already argued. **Needs your ratification at this gate.**
2. **Wave 7's multi-file upload has no `purchased_at` story.** iOS papers over a missing date with the capture day, which is defensible for paper scanned in hand; a PDF dragged into a browser months after the purchase has no such day. The web path will need either server-side text extraction, a nullable date (with the cursor problem solved), or an explicit "date unknown" UX. Flagging now so it is designed, not improvised.
3. **Currency is not on the §7.2 field list**, so a USD receipt confirmed on the phone keeps the CAD default until edited elsewhere. The detail screen edits "every field" per §7.1 but editing is otherwise a wave-7 web affordance. Cheap fix if wanted: a currency row on the confirm screen; deliberate omission also defensible for two CAD-resident users.
4. **Queue order is unspecified.** The queue serves newest-purchase-first (the list's order); for a backlog worked "later at a desk" oldest-first might feel more natural. One line to change if the device run says so.
5. Housekeeping: `NSCameraUsageDescription` added to Info.plist; the §10A.1 amber and the pending badge share one hue family by design.

## 7 · Device test script - what to tap, and what passing looks like

Setup (Mac):

1. `cd ~/dev/kept/server && docker compose up -d` (Postgres **and** MinIO must be healthy: `docker compose ps`).
2. `npm run db:migrate` - wave 4 changed the schema; this must run before the server starts. (`db:seed` optional; capture works into an empty account.)
3. Mac's name: `scutil --get LocalHostName` → call it `<mac>` below.
4. **The phone must reach MinIO, not just the API** - presigned URLs embed the storage endpoint, and the default is `localhost`, which on the phone is the phone. `.env.local` needs:
   ```
   STORAGE_ENDPOINT=http://<mac>.local:9000
   STORAGE_BUCKET=kept
   STORAGE_ACCESS_KEY_ID=kept
   STORAGE_SECRET_ACCESS_KEY=kept-local-dev
   ```
   Same MinIO container as always - only the address changes, so the phone can resolve it. The `kept` bucket already exists from prior default-config runs; if this is a fresh volume, create it with the env inline (`storage:init` does not read `.env.local`):
   `STORAGE_ENDPOINT=http://<mac>.local:9000 STORAGE_BUCKET=kept STORAGE_ACCESS_KEY_ID=kept STORAGE_SECRET_ACCESS_KEY=kept-local-dev npm run storage:init`
5. `npm run dev`. **Pass:** the "Object storage: local MinIO default at http://localhost:9000" line does **not** appear (the STORAGE_* config is in effect - if you see it, `.env.local` didn't load the storage vars), then "Kept API listening on port 3000".
6. Phone: open the app (build/install as in wave 3), Server settings → `http://<mac>.local:3000`, sign in.

The script - single capture first, then batch, then the queue, then the number:

1. **Single capture.** Home → **Capture**. **Pass:** camera permission prompt on first use, then Apple's document scanner opens directly - no intermediate screen. Scan one crisp receipt, Save. A "Saving receipt…" spinner, then **the confirm screen** - never a success modal, never Home.
2. **Confirm screen layout (§7.2/§10A.1).** **Pass:** the scanned image up top; the total in a card in the largest type on screen; fields in order date · vendor · HST · subtotal · other tax · tax number · business/personal · category · payment · notes; every field the parser filled tinted amber; absent fields reading "Not found" (placeholder), not blank, and not amber; the title reading "N to check"; Save disabled with "Choose business or personal to save." stated *below the button*; neither Business nor Personal pre-selected.
3. **Amber clears on touch, permanently.** Tap the total field. **Pass:** its tint clears, the counter drops by one, and it stays clear after editing other fields. Tap the date row: same.
4. **Arithmetic warning.** Edit HST so subtotal + HST ≠ total. **Pass:** an amber (not red) line appears *inside the total card* saying it doesn't add up; Save remains enabled once business/personal is chosen - it never blocks.
5. **Save.** Choose Business or Personal, tap Save. **Pass:** straight back to Home (via "Queue clear" if nothing else pending), the receipt in the list with no Pending badge, its detail showing the image and the confirmed fields.
6. **Batch mode (§6A).** Gather 5+ receipts. Capture → scan them back to back in one camera session → Save. **Pass:** "Saving receipt 2 of 5…" counts up; then the confirm queue presents receipt after receipt; the Home badge meanwhile counts them pending. Confirm two or three, tap **Later** on one (**pass:** it is skipped but the pending count keeps counting it), close the queue mid-way (**pass:** Home shows the correct "N pending - confirm" badge).
7. **Queue from the badge.** Tap the pending badge. **Pass:** the queue resumes with the remaining receipts, including - after reopening - any set aside earlier. Work it down to "Queue clear".
8. **⚠ The date check (this wave's highest-risk fix).** On a receipt whose paper shows a printed date, compare the confirm screen's date against the paper *before touching it*. **Pass:** they match exactly - not one day off in either direction. Then, for one receipt scanned from paper with **no legible date**: **pass:** the date row shows today with the caption "No date was found on the receipt - this is the day it was scanned." After confirming, check the detail screen shows the same calendar date you saw in the picker. **Fail reads:** a date one day off means the picker's UTC pin is broken on device - stop and report; do not hand-correct dates around it.
9. **Failure honesty (optional but cheap).** Mid-batch, kill the server (`Ctrl-C`) before a page saves. **Pass:** "Save failed" with the page number and how many saved, Retry and "Give up on the rest" offered; restart the server, Retry resumes from the failing page; nothing is double-created (check the list count).
10. **The ten receipts (§9's gate).** Capture ten real receipts of varied quality - crisp, crumpled, faded, long, a printed PDF-style one - and confirm each, *correcting every wrong field as you would in real use* (that IS the measurement; also confirm-unchanged a correct suggestion rather than retyping it). Include at least one no-HST receipt and one handwritten-or-hopeless one.
11. **The number.** On the Mac: `cd ~/dev/kept/server && npm run parse-accuracy`. **Pass:** a per-field table (total · date · vendor · hst · subtotal · tax number) with accuracy percentages over your confirmed receipts, plus every correction listed with suggested vs confirmed values. **Paste that table into §8 below - it is the parser's specification from now on (§7.3), and the trigger data for any future cloud parser.**

## 8 · Device verification - PASSED with findings (the owner, 2026-08-06)

Run: one real receipt end to end (a thermal restaurant receipt) rather than the staged ten - **the owner waived the ten-receipt session; the accuracy table accrues through real use of `npm run parse-accuracy`**, which reads every confirmed receipt with a suggestion record, so ordinary use produces the same number with better variety. The path itself passed: build and install over `devicectl`, capture through the real scanner, on-device OCR, the confirm screen against the presigned MinIO image via the Mac's `.local` name, and a confirmed row in the database.

Four findings returned, all fixed same-day (decisions and rejected alternatives in `DECISIONS.md`):

1. **Spec violation - the "Queue clear" screen was a success modal.** §10A.1 forbids exactly this on a five-second task, and I built it anyway on the everyday single-capture path. A single confirm now returns straight to Home; the summary appears only when the sitting handled more than one receipt or set one aside. That this shipped past my own §10A.1 checklist is the wave's most instructive miss: I checked "no success modal after *saving*" and did not read the queue-done screen as one.
2. **Capture button label off-center.** `Label` inside a `List` reserves a leading icon column; replaced with an explicit centered HStack.
3. **Two-column thermal layouts defeated the §7.3 heuristics** - subtotal and HST unparsed on the device receipt while contiguous fields (vendor, date, tax number) succeeded, and the total survived only via the lower-third fallback. Diagnosis confirmed against the stored `ocr_raw_text`: label and amount are separate Vision observations across a wide gap, and every heuristic matched within one string. Fixed with `ReceiptRowAssembler` - fragments sharing a vertical band (within half the taller fragment's height) merge into printed rows, left to right by bounding box - run both in the plumbing (so stored raw text keeps the pairing for future re-parses) and in the parser (stable on assembled input). The real receipt's recognized text is now a fixture: subtotal 13.50, HST 1.76, and total 15.25 all parse from their labelled rows. ⚠ Validated against one sample; the spec's §7.3 note flags re-checking the band rule as the accuracy table fills.
4. **Business/personal buttons' rounded strokes clipped flat at the row edges.** Zero list-row insets put the strokes on the clip bounds; default insets restored. Per the owner's instruction the confirm screen's layout was reviewed as a whole rather than symptom-patched: the only remaining zero-inset row is the image (full-bleed by intent, nothing to clip), and the save section and total card sit inside default insets.

Suites after all changes: server 150 green, iOS 122 green (row assembler + real-receipt fixture + queue summary-rule tests added), zero warnings; fixed build reinstalled on the device.

**The wave-4 gate is closed pending the accruing accuracy table.** Wave 5 not started (per the kickoff).

## 9 · Re-test (the owner, 2026-08-06)

Confirmed fixed on device: HST/subtotal pairing, segmented-control borders, Capture label centring, and the arithmetic warning (amber, non-blocking). Two new findings, both fixed same-day; decisions in `DECISIONS.md`.

1. **Vendor regressed to the address line on the same paper.** The attributed cause (row assembly reshaping boxes) was checked against the artifact and **disproven**: the stored assembled raw text and a Vision re-run over the stored image (dumped on the Mac with the same `.accurate` request) both show the two header lines untouched by the assembler. The actual mechanism is height jitter - on same-size thermal print, Vision measured the address at 0.0323 and the name at 0.0306 on this photo, and the reverse on the first, so "largest single box" was a per-scan coin flip. Fix: vendor is now the **topmost of the letter-bearing top-quarter lines within 15% of the tallest** - the name prints above the address - while a genuinely larger name still wins outright. The same geometry dump surfaced a third latent defect, fixed alongside: Vision split "Total" into `Tot` + `al`, invisible to any word-boundary match; labels now also match against a despaced copy of the row, letter-fenced so "TOTAL SAVINGS" cannot false-match (first attempt used `\b` on the despaced text and failed its own test - digits are word characters; the failing test caught it).
   **Why my fixture had not caught the regression:** it *did* assert the vendor - against geometry I invented, in which the vendor was comfortably tallest. Fabricated fixture data verified my model of Vision rather than Vision. The fixture is now the real dump verbatim (25 observations), which carries all three parser lessons at once, and the invented version is gone.
   **Geometry audit** (per the finding): vendor was the only heuristic reading heights; the date top-third preference and the total's lower-third fallback read vertical centers, which band-merging shifts by less than half a line height. No other heuristic depends on pre-assembly geometry.
2. **Pending receipt's detail was a dead end.** The detail screen now offers **"Confirm this receipt"** on any pending receipt, opening the same confirm form (same tested model, full-screen, "Later" closes it); saving re-reads the detail so the badge disappears in place. The header-badge queue remains the batch route.

Suites after all changes: server 150 green, iOS 124 green (real-geometry fixture, jitter and split-label tests), zero warnings; build reinstalled on the device. **Gate remains closed pending the accruing accuracy table; wave 5 not started.**
