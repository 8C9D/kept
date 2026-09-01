# Product-feedback gate report — 2026-09-01

2026-09-01.
Scope: the owner's product feedback after two weeks of real use, and the
130-receipt parse investigation that was run first to find out what was
actually wrong. Built across `server/`, `ios/`, `web/` in one session, in
eight commits on `main` (`a2bf95a` … `ab14580`).

**Nothing here is deployed.** No `fly deploy`, no migration against Neon,
no Cloudflare Pages redeploy, no archive and no TestFlight upload. The
phones are on **1.0 (4)**, which predates every change in this report.
Migration `0009` is applied to the **local** database only.

**Suites**, all re-run in this documentation pass rather than taken from
the building sessions:

| suite | result |
|---|---|
| server `npm test` | **760** passed / **55** files |
| server `npx tsc --noEmit` | clean, exit 0 |
| web `npm test` | **334** passed / **15** files |
| web `npm run build` (`tsc --noEmit && vite build`) | clean, exit 0 |
| iOS `KeptTests` | **671** passed, 0 failures |
| iOS `KeptUITests` | **9** passed, 0 failures |

The web build's shape is worth recording, because a lazily-loaded PDF
parser is the point of that design: entry `index-*.js` **256.37 kB**, the
pdf.js chunk `pdfTextLayer-*.js` **437.81 kB** (131.32 kB gzipped) behind a
dynamic `import()`, and the worker asset `pdf.worker.min-*.mjs`
**1,265.41 kB**. Someone who only ever uploads photographs downloads none
of the last two.

**Guardrail 7 — the real server, started the real way, one real request.**

**Guardrail 7, run by the orchestrator against a clean checkout.** `git clone` of the repo at `ab14580` into a scratch directory, `server/.env.local` copied in as an operator would create it, `npm ci`, then the production entrypoint: `PORT=3200 npm run dev`. Boot printed the object-storage probe, `Receipt parse model: claude-sonnet-5`, `Web client CORS: allowing origin http://localhost:5173`, and `Kept API listening on port 3200`. `GET /api/me` → **401** with `cache-control: no-store`. A dev session token was minted (`npm run dev:session-token`); `GET /api/receipts/options` with it answered `{"categories":[],"paymentMethods":[],"vendors":[],"vendorDefaults":{}}` — correct empty lists for a brand-new user, served from the new `receipt_field_options` table. `POST /api/receipts/parse` with an invalid body answered **400** (strict schema; no model call billed). The process was killed and the port confirmed free.

---

## 1 · What was built

### 1.1 Data model and API (server)

- **Migration `0009_reviewed-fields-and-options.sql`** — `receipts.reviewed_fields`
  (`text[]`, NOT NULL, default `'{}'`), `receipts.ocr_source` (nullable text),
  and the new table `receipt_field_options` (`user_id`, `field` with a CHECK
  over `vendor|category|payment_method`, `value`, `last_used_at`,
  `created_at`; unique `(user_id, field, value)`; index
  `(user_id, field, last_used_at desc)`), followed by **three backfill
  INSERTs**, one per field, over non-deleted receipts. **Purely additive** —
  nothing dropped, no constraint tightened, both `ADD COLUMN`s metadata-only.
  It still has to run **before** the deploy: it backfills the table the new
  `/options` reads (§6 below).
- **`reviewed_fields`** — vocabulary in `server/src/domain/reviewedFields.ts`
  (ten names), validated at the boundary by
  `http/schemas.ts`'s `z.array(z.enum(REVIEWED_FIELDS)).max(...)` on **both**
  `createReceiptSchema` and `updateReceiptSchema`, replacing the stored set
  outright. Consumed by `withholdReviewed` in
  `server/src/domain/mergedSuggestions.ts`: on a `pending` receipt, a
  reviewed field is served `{value: null, source: null}` — eight of the ten
  names have a suggestion to withhold, `category` and `notes` never did.
- **`ocr_source`** — `OCR_SOURCES = ["vision", "pdf-text"]`
  (`domain/ocrSuggestions.ts`), accepted on **create only**. The one rule it
  drives is two lines in `mergedSuggestions.ts`:
  `const mergeMoney = context.ocrSource === "pdf-text" ? extractedTextMoney : heuristicOnlyMoney;`
  — a scoped exception to the Aug 8 no-fallthrough rule, and the reasoning
  is in `docs/DECISIONS.md` 2026-09-01.
- **`server/src/domain/suggestedAmounts.ts`** — `validateSuggestedAmounts`,
  `SUGGESTED_AMOUNT_TOLERANCE_CENTS = 2`, private
  `MAX_PLAUSIBLE_HST_RATE_BPS = 1600`. Applied last in the merge
  (`withholdImpossibleAmounts(withholdReviewed(...))`) and only to
  `totalCents`/`subtotalCents`, which are the only two fields that can be
  withheld. Served shape: `{value: null, source: null, disagreement: false, withheld: true}`.
- **`server/src/domain/receiptFieldOptions.ts`** and the routes in
  `routes/receipts.ts`: `GET /api/receipts/options` now reads rows
  (**no cap**; the 100-value limit went with the scan),
  `PATCH /api/receipts/options/:field {from,to}` renames and rewrites every
  receipt of the caller with that exact value **in every status, deleted
  included** (deliberately not `visibleTo`), merging onto an existing target
  row and keeping the later `last_used_at`; `DELETE
  /api/receipts/options/:field?value=` removes **only** the option row.
  `rememberFieldOptions` upserts inside the create and PATCH transactions;
  **nothing prunes on soft-delete or restore** — verified by there being
  exactly two call sites.
- **`POST /api/receipts/parse`** — body `{ocrRawText, capturedAt}` (strict:
  a receipt id is refused), answers `{suggestions, model, promptVersion}`,
  **503** `parse_unavailable` with no API key, **502** `parse_failed` on a
  model error. Writes nothing; `tests/integration/parseReceiptText.test.ts`
  reads the receipts table afterwards to prove it.
- **Vendor sort by `lower(vendor)`** — `ListSortSpec` gained a `sortKey`, and
  both `listOrderBy` and `afterCursorInSort` now use it, so the ORDER BY and
  the keyset predicate compare the same expression. Existing cursors stay
  valid (they encode the raw vendor and lower on bind).
- **Unchanged, and checked rather than assumed**: `POST /api/receipts/:id/images`,
  `PUT /api/receipts/:id/images/:page`, and everything under
  `server/src/export/` — `git diff b06a217..HEAD` is empty for all of them.

### 1.2 Parsing

- **`server/src/parse/claudeReceiptParser.ts`** — `thinking: {type: "disabled"}`
  in `buildParseRequest`, `max_tokens` still 1024, pinned by
  `tests/unit/llmSuggestions.test.ts`. The cost comment was rewritten
  against measurement (~67 output tokens with thinking off against ~794 with
  it on; ~3,000 input tokens per short receipt under v5 against ~880 under
  v4; ~$0.0069/receipt). **No `cache_control` anywhere** — `grep` over
  `server/src` returns nothing, and the comment says why it was left out.
- **`server/src/domain/llmSuggestions.ts`** — `RECEIPT_PARSE_PROMPT_VERSION = 5`,
  system prompt 5,512 characters. The user message is built in
  `claudeReceiptParser.ts` as `captureLine(capturedAt) + "\n\n" + ocrRawText`,
  where `captureLine` is `Captured on: ${capturedAt.toISOString().slice(0,10)}`.
  All ten rule topics present and quoted in full in the code: two-digit
  years, decoy dates, savings/discount/points, card-slip `AMOUNT + TIP = TOTAL`,
  subtotal synonyms, tax synonyms, tip, `otherFeesCents`, `paymentMethod`,
  arithmetic sanity, null-over-invention.
- **`OcrFieldSuggestions`** gained `otherFeesCents` and `paymentMethod`
  (`domain/ocrSuggestions.ts`), which is what reverses the spec's "other fees
  has no suggestion field, deliberately."
- **`ios/Kept/Parsing/`** — six files, rewritten rather than patched:
  `ReceiptParser.vendor(in:knownVendors:)` runs a known-vendor pass over the
  whole normalized text (first occurrence wins, length as tiebreak, four-character
  floor) before the geometric one; `ReceiptDateParser.bestDate(inLines:capturedAt:)`
  enumerates every reading of every token and scores them (+3 unambiguous /
  +1 ambiguous, +2 corroborated on another line, +1 clock time, −3 decoy,
  −1 per year of age, future discarded, `maxReceiptAgeYears = 7`);
  `total(in:)` gained `isDisqualifiedAsTotal`; `ReceiptAmount.damagedDecimal`
  accepts `9-86` and `4,58` and a bare integer is deliberately never an
  amount; `taxRows(in:)` reads
  `trailingAmountOutsideParentheses`; `splitOrCombinedHst(rows:subtotalCents:)`
  runs four tiers in order (amount-equality, summary-labelled row,
  rate-plausible sum over {5,13,14,15}% ±25 bps, then the old `%` rule);
  new `otherFees(in:)` (rounding capped at `maxRoundingAdjustmentCents = 4`)
  and `paymentMethod(in:)` (a line naming two or more brands is a menu, not a
  method).
- **`ReceiptRowAssembler.assembledToFixedPoint(_:maximumPasses:)`**, called by
  `VisionReceiptTextRecognizer.recognizeText` **before** `rawText` is taken —
  the fix for the two parsers having been scored on different text.

### 1.3 iOS

- **Capture-time second opinion** — `CaptureFlowModel.requestSecondOpinion(rawText:capturedAt:for:)`,
  `secondOpinionTimeout = 12`, raced against a `Task.sleep` in a task group,
  started after the confirm screen is already showing and never awaited.
  `ConfirmReceiptModel.applyServerSuggestions(_:)` replaces vendor, date and
  payment method only where `!touchedFields.contains(...)`; a differing
  amount becomes a `ServerAmountAlternative` chip ("Server read … - use it").
  Offline, a timeout and a 502 are one silent outcome.
- **Amber removed** from `SuggestedFieldRow`; `DisagreementNote` is
  `.foregroundStyle(.secondary)`; the title is `"Confirm receipt"` /
  `"Edit receipt"`. `unreviewedFields` and `unreviewedCount` remain and still
  drive the notes and the save-time telemetry.
- **Notes clear on value change** — `stillHoldsSuggestedValue(_:)` gates
  `showsDateDisagreementNote`, `showsHstDisagreementNote`, `showsHstRateHint`.
- **`ReceiptArithmetic.swift`** — `validateSuggestedAmounts` (mirror of the
  server's), `checkAmountFloor`, `suggestDefaultRateHst`
  (`defaultHstRateBps = 1300`), `hstRateCurrency = "CAD"` gating only the
  default-rate chip. Total tracking lives in
  `ConfirmReceiptModel.editComponentAmount(_:to:)` with a
  `lastTrackedComponentSum` memory. `saveNeedsAcknowledgement` starts
  `guard purpose == .confirm` — `acknowledgementFloorCents = 100`,
  `acknowledgementRateBps = 500`, i.e. `max($1, 5%)`.
- **Save for later** — `SaveForLaterRequest` uses double optionals
  (`String??`/`Int??`) so absent, null and value are three distinct wire
  states, and carries **no `status` key at all**. Capture-time "Later" puts
  the typed fields into `OutboxItem.partial` (`PendingReceiptFields`), which
  `OutboxController.createRequest` reads field by field.
- **PDF import** — `ios/Kept/Import/`: `PDFReceiptText.extract(from:)` per
  page via `PDFPage.string`, `PDFReceiptReading.read(documentData:)` deciding
  text-layer vs render-and-Vision, `renderFirstPage` pinning
  `UIGraphicsImageRendererFormat.scale = 1` (the default is the screen's, which
  on a 3× phone would render a letter page at seventeen megapixels). Every
  import lands `pending`; the original PDF is what uploads.
- **Multi-page** — `CaptureFlowModel.Phase.choosingPageMode(pageCount:)` and
  `ScannedPagesChoiceView`, an inline screen and deliberately not a
  `confirmationDialog`. `OutboxController.attachNextPage(...)` persists
  `pagesAdded` per page and treats a 409 as landed; a first-page create 409
  stops with the remedy stated and names no receipt id, because the server's
  duplicate error carries none.
- **`QuickConfirmRequest(displaying:)`** sends the displayed vendor, date,
  subtotal, HST, tip and total with `status: "confirmed"`;
  `ReceiptDisplay.canQuickConfirm` now gates on `displayTotalCents`.
- **`KeyboardDoneBar: UIView`** replaces the `UIToolbar` (44 pt bar, 36 pt
  button, `.systemChromeMaterial` blur). Free-text rows are leading-aligned;
  money rows keep trailing. `DocumentScannerView.shutterSoundID = 1108`,
  played once per scan session.
- **Manage values** — `ManageValuesView`/`ManageValuesModel`/`ManageValuesRules`;
  `PastValuesPresentation.menuLimit = 12` switches the past-values control
  from a menu to a searchable sheet.

### 1.4 Web

- **PDF text layer** — `upload.ts`'s `extractPdfTextLazily` does
  `await import("./pdfTextLayer.js")`; `pdfTextLayer.ts` wraps pdf.js;
  `pdfText.ts` holds the pure row assembly (`ROW_BAND_TOLERANCE = 0.5`,
  `OCR_RAW_TEXT_MAX_CHARS = 100_000`). `ocrRawText` and
  `ocrSource: "pdf-text"` are spread into the create body together or not at
  all. Extraction runs **after** the presigned PUT, so a failed upload never
  loads pdf.js. A PDF with no text layer, or an unreadable one, still creates
  the receipt and says so.
- **Save for later** — `patchForSaveForLater` = the patch limited to reviewed
  fields, plus `reviewedFields`, and **no `status`**. Reviewed is tracked in a
  `reviewedRef` separate from `touched` and from the edit telemetry.
- **Manage values** — `ManageValues.tsx` + `manageValues.ts`, over
  `renameReceiptOption` and `deleteReceiptOption` in `api.ts`.
- **Withheld amounts** — `withheldAmount()`, `draftFromPending` blanking the
  box without falling through to the row, and `withheldAmountsNote` rendering
  the explanation in `.muted` rather than amber.
- **`hstSuggestionChip(draft, currency)`** with `HST_RATE_CURRENCY = "CAD"`
  gating only the default-rate branch; `applyComponentEdit` +
  `lastTrackedComponentSum` for total tracking;
  `stillHoldsSuggestedValue`/`suggestionDisagreement` for the sticky notes.
- **Amber stays on web**, unchanged (`styles.css`'s `--warning-*` tokens and
  the `label.suggested` rules).

---

## 2 · The investigation, and the numbers the decisions rest on

Read-only, against a **restore-verified copy** of production and never
against production. Every one of the **130 live receipts** was compared
against its own photographed paper. **The full reports are outside this
repository on purpose** — `~/.kept/reviews/2026-09-01/` — because they quote
two real people's entire purchase histories.

**Stored records against paper.** The owner: 32 verifiable confirmed receipts,
**30 fully correct**. the second user: 97 live receipts, **70 fully correct as stored,
27 carrying at least one flag**, most cosmetic. Material errors, all left as
they are on the owner's decision: `74ae737c` Costco total $8.50 against a paper
$218.94; a tip entered as HST on `8ed5abdc` and `cf12562c`; a pre-discount
subtotal on `3b17aa9d`; a 1¢ HST on `4b28add4`; two duplicate pairs
(`5f8bac5e`/`5d5668e6`, whose dates are **both** wrong, and
`e6283500`/`aafc7a28`); a capture-day date on `894cfa6f`; and typed vendor
strings (`Tim Nortons.`, `Domno's`, `#D2`, `FIVE  GUYS`, two apostrophes for
one Dave's Hot Chicken).

**Parser accuracy, 130 receipts, scored against what the human confirmed:**

| field | heuristic right | LLM right |
|---|---|---|
| vendor | 51 (39%) | **82 (63%)** |
| total | 97 (75%) | **119 (92%)** |
| subtotal | 69 (53%) | **95 (74%)** |
| HST | 52 (40%) | **79 (61%)** |

| situation | outcome |
|---|---|
| both produced a value and disagreed | **LLM 22, heuristic 3** |
| heuristic absent, LLM had a value | 73 cases, **LLM right in 57** |
| confirmed vendor present verbatim in `ocr_raw_text` | **119 / 130 (92%)** |
| confirmations that happened at capture time, heuristic-only | **51 of 54** |
| vendor `suggestion_accepted` / `suggestion_overridden` | 20 / **33** |
| LLM write latency after create | Haiku median 1.4 s · Sonnet median 5.2 s · p90 8.2 s |
| measured confirm-screen dwell | median **47 s**, p25 20 s |

**The rebuilt on-device heuristic, measured on the same 130 receipts:**

| field | before | after |
|---|---|---|
| wrong dates | 25 | **2** |
| vendor right | 48 | **116** |
| total right | 97 | **107** |
| HST right | 54 | **69** |

**Arithmetic in confirmed data:** 129 confirmed receipts, **114 reconcile
exactly, 14 do not**; three of the violations are receipts whose own printed
figures are a cent out. That is the finding that made the amount floor an
extraction-time rule instead of a save-time rejection.

**Three reproduced defects**, each verified rather than inferred: the
`max_tokens` truncation (three live API calls — thinking on: `stop_reason:
max_tokens`, 1024 output tokens, 1024 thinking, no text block; thinking off:
`end_turn`, 67 tokens, clean JSON); the non-idempotent row assembler
(one receipt's stored text fed back through the real assembler, producing a
subtotal that cannot be derived from the stored text — 16 of 130 receipts
affected); and the capture-time confirm path having no merge at all, read
directly out of `user_events`.

---

## 3 · Verification actually performed, and by whom

- **All six suite runs above were re-executed for this report**, not copied
  from the building sessions.
- **Migration `0009` was read before being run** and applied to the local
  database only. Its additive-ness was checked by reading the SQL, not by
  trusting the filename: no `DROP`, no constraint alteration, no type change.
- **The `thinking` parameter is pinned by a unit test**, not just present in
  the source.
- **`POST /api/receipts/parse` writing nothing is pinned by an integration
  test that reads the receipts table afterwards** — the only honest way to
  assert an absence of writes.
- **The iOS parser rewrite is pinned against the real population**
  (`ReceiptParserProductionTests.swift` + `Support/ProductionReceipts.swift`),
  so the before/after numbers in §2 are reproducible from the repository
  rather than quoted from a session.
- **The investigation itself was read-only and against a restored copy.**
  Production was not written to at any point today by this workstream.
- **Two backups were taken and restore-verified** (Runbook §4): morning,
  2 users / 136 receipts / 136 images; afternoon, 237 / 237.

---

## 4 · What I could not verify, and what it would take

- **The document scanner, and therefore the multi-page choice screen behind
  it.** `VNDocumentCameraViewController` has no Simulator implementation, so
  the scan → "N separate receipts or one receipt with N pages" → outbox path
  has not been driven end to end anywhere. Needs a device.
- **The shutter.** One system sound per scan session, following the silent
  switch, is read from the source. Whether it is audible, well-timed, and not
  startling is the owner's to check on a physical device — and the per-page
  limitation cannot be verified either way without one.
- **The PDF import UI on iOS.** The `.fileImporter` sheet, the picker's own
  cancel path, and the per-file progress screen were exercised through
  `PDFImportModelTests` against injected data, not through a real file
  picker on a device.
- **Every pixel of the amber removal and the rebuilt Done bar.** The claim
  that iOS 26 does not paint a `UIToolbar` accessory view was established by
  pixel sampling in the building session; this pass read the resulting code
  and its tests. Nobody has looked at the finished screen on a phone.
- **The web PDF path in a real browser.** pdf.js's worker loading, the lazy
  chunk actually being fetched only for PDFs, and the upload-row wording were
  read from `pdfText.test.ts`/`upload.test.ts` and the build output, not
  driven in Chrome against a real emailed PDF.
- **Anything against production.** Nothing in this batch has run there in any
  form.

---

## 5 · Left open

- **Currency, and it is no longer hypothetical.** Production holds
  **US-dollar receipts** — reported at 16, and not independently counted
  here, since this pass does not read production. `formatCents` renders `$` for every currency on both clients,
  `GET /api/receipts/summary` sums across currencies into one figure, the iOS
  capture path hardcodes `currency: "CAD"`, and neither confirm form has a
  currency field. The one place currency is honoured is the 13% HST chip,
  which is CAD-only — deliberately, because that is where the wrong currency
  would have fabricated a tax figure rather than mislabelled one. Spec §12.
- **A prompt-cache breakpoint** for the ~3,000-token v5 input, worth roughly
  90% of the input cost. Held back so that a caching change and a prompt
  change do not land in the same generation of `parse-accuracy` data.
- **Payment method is a free-text suggestion and stays one.** Both parsers
  now propose it; there is no enum and there will not be one — the same rule
  `category` has always had.
- **The known data errors**, listed in §2 — the owner's decision is to leave
  them for now. The Costco $8.50 is the one that will reach an accountant if
  nothing is done. `Dave's Hot Chicken` existing under two apostrophes is the
  case the new rename route was built for.
- **The shutter's per-page limitation**, and the Done button being 36 pt
  inside a 44 pt bar — both recorded so neither is rediscovered as a bug.
- **`415701a3`'s failure record is permanent** unless someone deliberately
  clears the column; `llm_suggestions` is immutable by design, and
  `parse-accuracy` will score that receipt as "the LLM produced nothing"
  forever.
- **Two doc comments say the merge withholds six reviewed fields; the code
  withholds eight.** Cosmetic, in `mergedSuggestions.ts` and
  `reviewedFields.ts`, and left alone in this pass rather than touched
  outside its scope.

---

## 6 · Deploy ordering, when this batch goes

The owner's decision, recorded in `docs/DECISIONS.md` 2026-09-01 and in Runbook
§1/§2:

1. **A fresh verified dump.** The two taken 2026-09-01 are point-in-time
   artifacts, not a pre-migration backup for a later day.
2. **Migration `0009`, before the deploy.** It is additive, which by Runbook
   §2's default would put it after — it goes first because it **backfills**
   the table the new `/options` reads, and an empty vocabulary served
   confidently is worse than an error.
3. **`fly deploy`**, then the §1 confirmation checks.
4. **The Pages redeploy**, same session.
5. **TestFlight 1.0 (5) last.** The deployed build's create/update schemas
   are strict, so a phone ahead of the server would have **every save 400**
   on `ocrSource`/`reviewedFields`, surfacing as outbox items needing
   attention. The reverse is safe: 1.0 (4) sends neither key.

**Owner-only, and unchanged by this batch**: the 1.0 (1) demo recording and
the Resolution Center resubmission, the Sign in with Apple `.p8`, the R2
`kept-backups` token, and the App Store Connect privacy-label refiling. This
batch sits behind all of it, not beside it.

---

## 7 · Anti-pattern self-review (framework §10.2)

- **Duplication.** `validateSuggestedAmounts`, `checkAmountFloor`,
  `suggestDefaultRateHst` and the component-tracking rule are each defined
  once server-side and **mirrored** on iOS and web, not shared — the same
  necessary duplication the 2026-08-28 report accepted for
  `deriveMissingAmount`, for the identical reason (a network round trip per
  keystroke defeats a live affordance). Each mirror carries an explicit
  correspondence comment naming its counterpart. The one place duplication
  was **removed**: `assembledToFixedPoint` is now called once in the
  recognizer and is genuinely idempotent by the time the parser calls it,
  which is what stopped the two parsers reading different text.
- **Error-masking.** The capture-time second opinion swallows every failure
  into "nothing happens", and that is a documented contract rather than a
  silent catch: the screen must work identically offline, and a diagnostic
  log line on a path that runs on every capture would be noise. `POST
  /api/receipts/parse`'s 502 carries the model's own error message rather
  than a generic one; an unrecognised error is deliberately allowed to
  propagate to 500 rather than being flattened into 502.
- **Speculative generality.** `ocr_source` is an enum of exactly the two
  values that exist, not an open string; `reviewed_fields` is the ten field
  names that exist, enforced at the boundary. The option routes take
  `vendor|category|paymentMethod` and nothing else — no generic
  "edit any field's values" surface was built.
- **Scope discipline, one note.** The two stale "six fields" doc comments in
  §5 were found and deliberately not fixed, because this pass is
  documentation and the comments are in code.

---

## 8 · State of this batch

Built, committed to `main`, and locally verified: server 760/55 with a clean
typecheck, web 334/15 with a clean build, iOS 671 unit and 9 UI tests. One
new migration, applied locally only. **Not shipped in any sense** — no
deploy, no production migration, no Pages redeploy, no App Store or
TestFlight upload, and no change to the owner-action queue's order.

**The finding this batch exists because of** is worth restating as the last
line: the system's better parser had been right about the vendor on 63% of
receipts for weeks, and almost nobody ever saw it, because it answers five
seconds after the screen that asks the question has already been finished
with. Nearly every decision above is a consequence of measuring that rather
than guessing at it.
