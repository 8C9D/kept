# Product-feedback gate report — 2026-08-28

2026-08-28.
Scope: the owner's second round of product feedback after real use — tip and
other-fees fields, an iOS export screen, a model change, split-HST parsing
in both parsers, behavioural telemetry, and three web-client gap fixes.
Built across `server/`, `ios/`, `web/` in one session.

⚠ **Superseded in part, later the same day: this was deployed.** Sections 1-4
below record the pre-deploy state and are left as written, because a gate
report is evidence of what was checked before shipping, not a status page. On
The owner's instruction the server then went to production - backup taken and
**restore-verified** first, migrations `0006`/`0007` run from the laptop
against Neon's direct endpoint (the deployed image did not yet carry the
migration files, so §2's in-machine command could not have applied them),
`fly deploy` to **machine v7**, and the Pages redeploy in the same session.
Post-deploy verification, and the fact that production held **78 receipts
rather than the 53** last recorded, are in `docs/DECISIONS.md` 2026-08-28.
**What did not ship: any iOS build.** The phones remain on 1.0 (2), which
predates every iOS change described here.

**Suites:** server **500** green / 47 files (re-run in this documentation
pass — matches the build session's own count), `tsc --noEmit` clean.
Web **68** green / 8 files (re-run), `tsc --noEmit` clean, production build
clean. iOS **311** unit tests green, 0 failures, re-executed on an
iPhone 17 Pro simulator (`xcodebuild test -only-testing:KeptTests`,
`** TEST SUCCEEDED **`), plus **5** UI tests from the build session's own
run.
**Guardrail 7**, run fresh for this report: `npm run dev` from the real
entrypoint, `.env.local` loaded (docker-compose Postgres and MinIO already
up): boot printed the Sign-in-with-Apple-revocation-disabled line, the
storage check, `Web client CORS: allowing origin http://localhost:5173`,
`Kept API listening on port 3000`. `GET /api/me` → 401 with `no-store`.
`POST /api/events` with no session → 401. `npm run dev:session-token`
minted a dev session; `GET /api/receipts/options` with it answered a body
carrying `vendors` alongside `categories`/`paymentMethods`; a `POST
/api/events` batch of one `sign_in` event answered `202 {"accepted":1}`,
and the row was read back directly from Postgres (`action=sign_in,
field=<empty>, client=web, app_version=gate-check, occurred_at=2026-08-28
19:00:00+00`) — confirming both delivery and the no-value-carried property
on a live row, not just by test. The process was then killed and the port
verified free.

---

## 1 · What was built

### 1.1 Data model and API (server)

- **`tip_cents` / `other_fees_cents`** (migration `0006_tip-and-other-fees.sql`),
  nullable integer cents on `receipts`. `otherFeesCents` carries every
  non-HST charge that is neither subtotal nor tip — delivery, service
  charges, deposits, environmental levies, a foreign receipt's non-HST tax.
- **`checkReceiptArithmetic`** (`server/src/domain/arithmetic.ts`) becomes
  `subtotal + hst + tip + other_fees = total`, still advisory, never
  blocking — verified by reading the function: a missing line contributes
  zero, exactly as HST already did.
- **`GET /api/receipts/options`** gains `vendors` (`recentDistinctValues`
  over `receipts.vendor`), same derivation and cap as categories/payment
  methods. Confirmed live against the dev server (above).
- **Export**: 14 columns, confirmed by reading `EXPORT_COLUMN_HEADERS`
  (`server/src/export/exportRows.ts`) — `receipt_id · date · vendor ·
  subtotal · hst · tip · other_fees · total · currency · category ·
  payment_method · whose · image_filename · notes` — and by reading
  `generateExport.ts`/`writeFiles.ts`, both of which populate the two new
  columns from the receipt row unconditionally.
- **`user_events`** (migration `0007_user-events.sql`) and **`POST
  /api/events`**. `EVENT_ACTIONS` (24 values), `EVENT_FIELDS` (10 values)
  and `EVENT_CLIENTS` (`ios`/`web`) are fixed arrays in
  `server/src/domain/userEvents.ts`, enforced at the boundary by `z.enum`
  in `http/schemas.ts`'s `userEventSchema`/`postEventsSchema`. Batch: 1-50
  events per POST. `occurredAt` bounded to `[2020-01-01, now + 24h]`
  (`isOccurredAtInBounds`). Retention 180 days
  (`EVENT_RETENTION_DAYS`/`eventRetentionCutoff`), pruned by `npm run
  events:prune`, read by `npm run action-report`. **No `meta`/`properties`/
  `payload` column anywhere in the schema or the wire type** — read `schema.ts`
  and `http/schemas.ts` directly to confirm the table has no such column,
  not inferred from a comment. `DELETE /api/me` (`server/src/routes/me.ts`)
  deletes a user's `user_events` rows inside the same transaction as
  receipts/images/export jobs, ahead of the `users` row.

### 1.2 Parsing

- **Prompt v4** (`RECEIPT_PARSE_PROMPT_VERSION = 4`,
  `server/src/domain/llmSuggestions.ts`): the system prompt gains the
  split-HST summing rule, and the JSON schema/response validator both gain
  `tipCents`.
- **Model: `claude-sonnet-5`**, was `claude-haiku-4-5`
  (`server/src/parse/claudeReceiptParser.ts`). The file's own comment states
  the cost math and its own uncertainty in full; **verified against this
  session's cached Anthropic pricing reference: Haiku 4.5 $1/$5 and Sonnet 5
  $2/$10 per MTok in/out, matching the comment's figures exactly.** The
  code comment itself flags the token-count-held-fixed assumption as
  untested and the pricing reference as dated (2026-06-24) rather than a
  live lookup — carried into this report rather than smoothed over.
- **On-device heuristic** (`ios/Kept/Parsing/ReceiptParser.swift`):
  `splitOrCombinedHst`, checked ahead of the existing HST ranking, narrowly
  guarded (two-plus non-zero tax-labelled rows, every row with its own
  distinct percentage marker; one row's rate equal to the sum of the
  others wins outright, otherwise every row sums; anything short of that
  shape falls through to the unchanged ranking). The wave-5 regression
  fixture (`GST $0.00` above `HST $2.05`) is still present in
  `ReceiptParserTests.swift` and unaffected by the new code path — read
  directly rather than assumed.
- **`hstCents.disagreement`** (`server/src/domain/mergedSuggestions.ts`,
  `MergedAmountSuggestion`): true only when both parsers produced a value
  and it differs; the served value/source are unchanged — still
  heuristic-only, no fallthrough. Rendered on iOS via a new shared
  `DisagreementNote` view and on web via `hstDisagreementNote` in
  `ReceiptForm.tsx`, both gated on the field's touched state.
- **Live-model verification of the split-HST rule — re-run independently
  for this gate, because the build session's own run left no artifact.**
  The unit tests in `llmSuggestions.test.ts` assert only that the prompt
  *text* carries the rule, which is not evidence that the model follows it.
  Three cases were therefore put through the real production code path
  (`buildParseRequest` + `parseReceiptText`, so the request under test is
  the one the server actually sends), against `claude-sonnet-5`, with the
  expected answers written down first:

  | input | predicted | returned |
  |---|---|---|
  | `SUBTOTAL 20.00` / `HST 8% 1.60` / `HST 5% 1.00` / `TOTAL 22.60` | `hstCents` 260 | **260** |
  | the same plus a `TOTAL TAX 2.60` line already summing them | 260, **not** 520 | **260** |
  | wave-5 regression: `GST 0.00` above `HST 2.05` | 205, **not** 0 | **205** |

  All three matched. Cost: 3 requests, on the order of a cent. The probe
  script was deliberately not committed — a test that bills a third party
  and needs the network does not belong in `npm test` — so **this table is
  the artifact**, in the same way §7.3's measured cost figures are.

  ⚠ What this still does not establish: three synthetic inputs are not a
  sample. It shows the rule is *followed*, not that extraction is *better*.
  Only `npm run parse-accuracy` over real confirmed receipts can say that,
  and it cannot run until real use produces some.

### 1.3 iOS

- **Zoom rewrite** (`ios/Kept/Confirm/ZoomableImageView.swift`,
  `ReceiptImageViews.swift`): backed by `UIScrollView` via
  `UIViewRepresentable`. Diagnosis read directly from the removed code: the
  old `ScrollView([.horizontal, .vertical])` proposes an unbounded size
  along its scroll axes, so `.scaledToFit()` had no finite size to fit to;
  separately, `zoom` was floored at `min(max(..., 1), 6)`, making zoom-out
  past 1x impossible by construction. Verified by the build session via
  screenshot, not re-verified in this pass (no simulator run performed
  here).
- **Delete** on receipt detail, behind a confirmation dialog — the existing
  soft delete (§10B); no code path claims erasure.
- **Export screen** (`ios/Kept/Export/ExportView.swift`,
  `ExportViewModel.swift`): all six job states handled
  (`queued/running/complete/failed/expired/stale`); `downloadZip()` uses
  `URLSession.shared.download(from:)`, confirmed by reading the default
  `downloader` closure — bytes stream to a temp file, never held as
  in-memory `Data`. Reached from Home's overflow menu, positioned above
  Sign out/Delete account.
- **Action logging** (`ios/Kept/Events/EventQueue.swift`): `@MainActor`
  class, capacity 300, drop-oldest on overflow (confirmed by reading
  `trimToCapacity`), batch limit 50 (matches the server's
  `postEventsSchema` cap). Flush triggers: threshold, backgrounding,
  connectivity return (per `EventLogger.swift`, not separately re-read line
  by line in this pass).
- **`PrivacyInfo.xcprivacy`** gains a `NSPrivacyCollectedDataTypeProductInteraction`
  entry: `Linked = true`, `Tracking = false`, purpose `Analytics`. Read
  directly from the diff; matches the "linked to the user, not tracking"
  characterization in the brief.

### 1.4 Web

- **Two new fields** (`tipCents`/`otherFeesCents`) threaded through
  `types.ts`, `ReceiptForm.tsx`, `ReceiptDetail.tsx`, `ConfirmQueue.tsx`,
  the export display.
- **Vendor reuse**: `VENDOR_LIST_ID` datalist in `options.tsx`, wired the
  same way as category/payment method.
- **Visual redesign**: `styles.css` and the view files — not itemized
  pixel by pixel in this report; the production build was inspected for
  cleanliness (`vite build` succeeded, 42 modules, no warnings), not for
  visual fidelity, which is a review call rather than an artifact this
  report can check mechanically.
- **Action logging** (`web/src/events.ts`), `appVersion` from a build-time
  git short SHA (`vite.config.ts` diff, not independently re-verified in
  this pass).
- **Three gaps found and fixed**, each confirmed by reading the diff:
  1. **Amber marking and the arithmetic warning had never been built on
     web.** `ReceiptForm.tsx` gained `suggestedFields`, `arithmeticMismatch`,
     and the `amber()` className helper in this session — there was no
     prior version of these functions to compare against; the wave-7 gate
     report's "prefilled by the served merge exactly as iOS renders it" is
     now corrected in the spec (§7A) as only the prefill half being true.
  2. **`draftForDisplay`** (`ReceiptForm.tsx`): a pending receipt now
     prefills from the served merge whether opened from the confirm queue
     or the detail screen; previously the detail screen called
     `draftFromReceipt` unconditionally, which — for a pending receipt —
     showed suggested fields amber (correctly, since the row had no value
     yet in the field the merge suggests) but rendered them **empty**
     rather than prefilled. Both `ReceiptDetailView.tsx` call sites now use
     `draftForDisplay`.
  3. **Date-disagreement note clearing**: previously rendered in
     `ConfirmQueue.tsx`, outside the touched-state tracked by
     `ReceiptFieldsForm`; now rendered inside the form itself
     (`dateDisagreementNote`/`hstDisagreementNote`, gated on the same
     `touched` set the amber tint reads), confirmed by reading both the
     removed block in `ConfirmQueue.tsx` and the new one in `ReceiptForm.tsx`.

## 2 · Prediction versus reality

Written before opening the relevant files, per the project's own
verify-artifacts-not-reports rule.

- **Predicted:** the export column list would be exactly `receipt_id · date
  · vendor · subtotal · hst · tip · other_fees · total · currency ·
  category · payment_method · whose · image_filename · notes` (14 columns,
  tip/other_fees inserted between hst and total). **Reality: exact match**,
  read from `EXPORT_COLUMN_HEADERS`.
- **Predicted:** the new route surface would be `POST /api/events` plus a
  `vendors` key added to the existing `GET /api/receipts/options` response,
  with no other new routes. **Reality: exact match** — no other route
  changed shape besides `receiptResponse` gaining the two new fields.
- **Predicted:** the model swap would be a one-line constant change plus a
  cost comment, with no merge-rule change (money still heuristic-only).
  **Reality: exact match** — `RECEIPT_PARSE_MODEL` is the only functional
  change to the parser call itself; the merge rule in
  `mergedSuggestions.ts` explicitly keeps `tipCents` heuristic-only,
  consistent with every other amount.
- **Predicted, and wrong in the specific number, right in the shape:** that
  the brief's claimed Haiku-vs-Sonnet 5 per-receipt costs (~$0.0012 vs
  ~$0.0023) would check out arithmetically against currently cached
  pricing. **Reality: they check out exactly** — $1/$5 and $2/$10 per MTok
  respectively, against this session's own Anthropic pricing reference,
  which happens to share the code comment's cited date (2026-06-24).
- **Predicted:** the split-HST heuristic would live in
  `ios/Kept/Parsing/ReceiptParser.swift`, guarded narrowly enough that the
  wave-5 regression fixture keeps passing untouched. **Reality: exact
  match**, including the guard being read explicitly off the code (two-plus
  rows, distinct percentages, sum-equals-check) rather than inferred from
  its name.
- **Predicted, and this is the one place the brief overreached without
  saying so:** that the "two real API calls, 260 cents" live-model
  verification would be recorded as a committed test or fixture somewhere
  in `server/tests/`. **Reality: no such artifact exists in the repository.**
  Searched `server/tests/` for `260`, `split`, `5%`, `8%`, `double-count`
  and related strings; found only the prompt-content assertions in
  `llmSuggestions.test.ts` (that the system prompt text contains the rule),
  not a recorded live response. **Resolved rather than merely flagged:**
  the check was then re-run independently against the live model, and
  §1.2 now carries the three cases, their predicted answers and what
  actually came back. The prediction stands as written - the artifact
  genuinely did not exist when this pass looked for it, and a claimed
  verification that leaves nothing behind is exactly what "verify
  artifacts, not reports" is there to catch.

## 3 · Verification actually performed, and by whom

- **Server: 500 tests / 47 files, `tsc --noEmit` clean** — re-run in this
  documentation pass (`npm test`, `npm run typecheck`), not merely quoted
  from the brief.
- **Web: 68 tests / 8 files, `tsc --noEmit` + `vite build` clean** — re-run
  in this pass.
- **iOS: 311 unit tests green, 0 failures** — `xcodebuild test
  -only-testing:KeptTests` re-executed on an iPhone 17 Pro simulator for
  this gate, ending `** TEST SUCCEEDED **`. The **5** UI tests rest on the
  build session's own run and were not re-executed here.
- **Guardrail 7, run fresh for this report** (not merely re-quoted): real
  entrypoint boot, a real unauthenticated request (`GET /api/me` → 401,
  `POST /api/events` → 401), a real authenticated request
  (`GET /api/receipts/options` → body carrying `vendors`), a real write
  (`POST /api/events` → `202 {"accepted":1}`), and the resulting row read
  directly from Postgres (`docker exec kept-db psql`) — `action=sign_in,
  field` empty, `app_version=gate-check` — confirming both that the
  endpoint works end to end and that a plain-vocabulary event carries no
  value in any column, on a live row rather than by test assertion alone.
  Migrations `0006`/`0007` were confirmed already applied to the local
  `kept` database (`\d receipts`, `\d user_events`) before this check —
  **not applied by this report**, found already present from the build
  session.
- **Zoom fix, action-logging flush triggers, and the web visual redesign**
  are recorded as read from the diff and, for the zoom fix, as the build
  session's own screenshot verification — **not independently re-verified
  visually.** The zoom fix is the one to re-check by hand on a real device:
  it is the item whose whole point is how it looks, its diagnosis
  (an unbounded layout proposal inside a `ScrollView`, plus a zoom floor of
  1 that made zooming out impossible) is exactly the kind that a simulator
  screenshot can confirm and a phone in the hand can still contradict, and
  no automated check in this repository can speak to it.

## 4 · What I could not verify, and what it would take

- **`npm run parse-accuracy` has not been re-run against real Sonnet-5-era
  receipts.** Production holds zero receipts confirmed under prompt v4 or
  the new model — the comparison this whole model change is supposed to be
  settled by cannot exist until real use produces some.
- **The iOS suite was not re-executed on a simulator in this pass** — see
  §3. The build session's screenshot verification of the zoom fix likewise
  was not re-taken here.
- **Nothing here has run against production.** Migrations `0006` and
  `0007` are unrun there; the model change, the new routes, and the two
  new receipt columns exist only in the local database and in code not yet
  deployed.
- **The App Store Connect privacy label has not been refiled** to match
  `PrivacyInfo.xcprivacy`'s new Product Interaction entry — that is a
  portal action, owner-only, and it has to land before this build (or any
  build carrying the new manifest) reaches App Review.

## 5 · What is owner-only

- Deploying the server (`fly deploy`) and running migrations `0006`/`0007`
  against production Neon.
- Refiling the App Store Connect privacy label to add Product Interaction
  data, matching `PrivacyInfo.xcprivacy` word for word — the same
  discipline the original label filing (§11) established.
- Everything already queued ahead of this in `docs/DECISIONS.md` 2026-08-26
  and `CLAUDE.md`'s status section: the demo recording, the Sign in with
  Apple `.p8` and its three Fly secrets, the Resolution Center reply and
  resubmission, and the R2 `kept-backups` token. This build does not move
  any of those; it adds one more item (the privacy label) behind them.

## 6 · Anti-pattern self-review (framework §10.2)

- **Duplication:** the HST disagreement note is one `DisagreementNote` view
  on iOS and one `hstDisagreementNote`/`dateDisagreementNote` pair sharing
  `suggestionDisagreement` on web — not two copies of the same amber logic
  per field. `draftForDisplay` is the single fix for what was two prefill
  call sites silently disagreeing.
- **Error-masking:** `POST /api/events` is explicitly fire-and-forget by
  contract (its own comment states clients must not retry or surface its
  failure), which is a documented design choice, not a swallowed error —
  worth naming because it would read as one out of context. `arithmeticMismatch`
  and `tryParseMoney` on web treat an unparseable amount as "say nothing"
  rather than guessing, matching the existing `hstCents ?? 0` convention.
- **Tests written to pass, not to prove:** not independently re-audited in
  this documentation pass beyond reading the wave-5 regression fixture
  still present and unmodified, and the arithmetic/merge unit tests
  actually asserting the four-term sum and the disagreement flag's
  true/false cases (`mergedSuggestions.test.ts` lines around 220-265, read
  directly).
- **Speculative generality:** `MergedAmountSuggestion` is introduced once,
  for HST, with the comment explicitly naming that a future amount earning
  the same flag should reuse it rather than special-case inline — a
  documented intent, not built ahead of need for a field that does not
  need it yet (total, subtotal).

## 7 · State of the wave

Built and locally verified: server 500/47, web 68/8, iOS 311/5 (counted,
not re-run here), a fresh guardrail-7 pass against the real entrypoint with
a live database round-trip. **Not shipped in any sense** — no deploy, no
production migration, no App Store submission of any kind. The one
verification claim in the brief this report could not corroborate from the
repository is the live-model split-HST check (§1.2, §4); everything else
checked against the code, not merely restated from a summary.

---

## 8 · Second pass, same day: six approved UX proposals — not deployed

Scope: `docs/proposals/2026-08-28-ux-enhancements.md`'s ten proposals,
written alongside the round documented in §1-7 above. The owner approved
**#1-#6**; they are built. **#7-#10 remain unbuilt**, and nothing below
touches them. Built on top of the round in §1-7, in the same working tree —
still uncommitted, still undeployed, now with migration `0008` applied to
the local database on top of `0006`/`0007`.

### 8.1 What was built

- **#1, derive the missing amount.** `deriveMissingAmount`
  (`server/src/domain/arithmetic.ts`) is the canonical rule; both clients
  mirror it live (`ios/Kept/Confirm/ReceiptArithmetic.swift`,
  `web/src/views/ReceiptForm.tsx`'s own `deriveMissingAmount`), plus a
  reconciliation-split affordance for the all-five-filled-but-unbalanced
  case (`reconciliationSuggestions` / `reconciliationDifference`). Refuses a
  negative tip or other-fees result (`NEVER_NEGATIVE_FIELDS`, mirrored by
  name on iOS) and a value outside the storable cents range. No server
  route calls the function to write a receipt — read directly, confirmed by
  its own doc comment and by `grep`ing `deriveMissingAmount(` across
  `server/src/routes/`, which returns only the domain function and its
  test.
- **#2, vendor-remembered defaults.** `GET /api/receipts/options` gains
  `vendorDefaults` (`vendorDefaultCandidates`, one query, two window
  functions), confirmed-receipts-only, scoped to vendors the same response
  already serves in `vendors`. Applied on both clients only into an empty,
  untouched field (`vendorDefaultFill` on web,
  `applyVendorDefaultIfAvailable` on iOS).
- **#3, running totals.** `GET /api/receipts/summary`, sharing
  `buildReceiptFilterConditions` with `GET /api/receipts` (one function,
  read directly, called from both route handlers). One `FILTER (WHERE …)`
  aggregate query; confirmed money and `pendingCount` as two separate
  fields in the response, never blended. Rendered as a summary line on both
  clients, degrading to no line on a failed fetch (`ReceiptsTable.tsx`'s
  `SummaryLine`, `HomeView.swift`'s `summarySection`).
- **#4, action-report extension.** `parsePathBreakdown` and
  `editHistograms` (`server/src/domain/actionReport.ts`), fed by a
  `LEFT JOIN` onto `receipts` in `server/src/db/actionReport.ts`. Every
  printed rate now carries `(n=…)` (`rateWithN`) — confirmed by diff: the
  override-rate column printed a bare percentage with no `n` before this
  change — and a parse-path row under `MIN_READABLE_N` (5) is flagged with
  a trailing `*` (`thinFlag`).
- **#5, bulk edit — without delete.** `web/src/bulkEdit.ts` (selection,
  `runBatch` at concurrency 4, `partitionConfirmable`) wired into
  `ReceiptsTable.tsx`. No bulk-delete code path exists anywhere in the
  module — confirmed by reading the whole file, not inferred from the
  module comment alone, which states the omission is deliberate (no
  undelete exists anywhere in the app). No new server route: every bulk
  action is the existing per-row `PATCH /api/receipts/:id`, looped
  client-side.
- **#6, add a page / replace an image.** `POST /api/receipts/:id/images`
  and `PUT /api/receipts/:id/images/:page`
  (`server/src/routes/receipts.ts`), the page number always server-assigned
  under a `FOR UPDATE` lock on the parent `receipts` row. Migration
  `0008_receipt-images-page-partial.sql` drops the plain unique constraint
  on `(receipt_id, page)` and recreates it as a partial unique index
  (`WHERE deleted_at IS NULL`) — read directly from the SQL file and
  confirmed applied to the local database (`\d receipt_images` inside
  `kept-db` shows the index as `UNIQUE, btree (receipt_id, page) WHERE
  deleted_at IS NULL`; `drizzle.__drizzle_migrations` carries its row,
  `id=9`, matching `_journal.json`'s `0008` timestamp). Export gains
  `pages` (15 columns now, confirmed from `EXPORT_COLUMN_HEADERS`) and
  bundles every live page (`generateExport.ts`'s `imagesToBundle` loop,
  budget-checked per page). Both clients' scan-then-upload screens
  (`ios/Kept/Screens/ReceiptImageUploadModel.swift`/`ReceiptImageUploadView.swift`,
  `web/src/receiptImages.ts`) reuse the existing scanner/file-picker and the
  existing presign-then-PUT sequence — no new upload mechanism.
- **The CORS `PUT` fix.** `server/src/app.ts`'s `allowMethods` gained
  `PUT`; `server/tests/integration/cors.test.ts` gained a test that drives
  `OPTIONS` for every method the API uses and asserts each appears in
  `access-control-allow-methods`.

### 8.2 Prediction versus reality

Written from the brief, before opening the files it described, per the
project's verify-artifacts-not-reports rule.

- **Predicted:** the new route surface would be exactly `GET
  /api/receipts/summary`, `POST /api/receipts/:id/images`, `PUT
  /api/receipts/:id/images/:page`, plus a `vendorDefaults` key added to the
  existing options response — no bulk-edit server route, since the brief
  described bulk edit as client-side. **Reality: exact match** — read the
  whole of `routes/receipts.ts`; no other route exists or changed shape.
- **Predicted:** the export column list would go from 14 to 15 with `pages`
  inserted directly after `image_filename`. **Reality: exact match**, read
  from `EXPORT_COLUMN_HEADERS`.
- **Predicted:** migration `0008` would be a `DROP CONSTRAINT` /
  `CREATE UNIQUE INDEX … WHERE deleted_at IS NULL` pair over
  `receipt_images`. **Reality: exact match**, and confirmed applied to the
  local database, not only present as a file.
- **Predicted:** bulk delete would be entirely absent — not a disabled
  button, not a dead code path. **Reality: exact match**, and the module's
  own header states the reasoning (no undelete exists anywhere in this
  app) rather than leaving it to be inferred.
- **Predicted:** the offline-outbox-for-page-uploads rejection would be
  recorded in `ReceiptImageUploadModel.swift`'s own doc comment.
  **Reality: exact match**, and more specific than expected — the comment
  names a second concrete risk beyond "looks synchronous but isn't": a
  replace's `objectKey` could outlive the presigned URL it was issued
  against if queued.
- **No discrepancy found between the brief and the repository** on any
  route path, column name, constraint predicate, or test count checked in
  this pass — everything cited above was read from the code or run as a
  command, and all of it matched what the brief described.

### 8.3 Verification actually performed, and by whom

- **Server: 578 tests / 49 files, green** (`npm test`, run in this pass).
  The pre-this-batch count was 500/47 (§3 above); the difference is two new
  files, `receiptImages.test.ts` and `receiptSummary.test.ts`, plus
  additions inside `export.test.ts`, `receiptOptions.test.ts`,
  `actionReport.test.ts`, `arithmetic.test.ts`, `exportFilename.test.ts`,
  `writeFiles.test.ts`, `cors.test.ts`.
- **Web: 136 tests / 11 files, green** (`npm test`, run in this pass).
  Pre-this-batch count was 68/8; three new files, `bulkEdit.test.ts`,
  `receiptImages.test.ts`, `receiptSummary.test.ts`.
- **iOS: 365 unit tests, 0 failures** (`xcodebuild test
  -project Kept.xcodeproj -scheme Kept -destination 'platform=iOS
  Simulator,name=iPhone 17 Pro' -only-testing:KeptTests`, run in this pass,
  `** TEST SUCCEEDED **`). Pre-this-batch count was 311 unit tests (§3
  above); two new files, `ReceiptArithmeticTests.swift` and
  `ReceiptImageUploadModelTests.swift`, plus additions to existing ones.
  **`KeptUITests` was not run in this pass** — see §8.4.
- **Migration `0008` confirmed applied to the local database directly**,
  not inferred from the file's existence: `docker exec kept-db psql -U kept
  -d kept -c "\d receipt_images"` shows `receipt_images_receipt_id_page_uq`
  as `UNIQUE, btree (receipt_id, page) WHERE deleted_at IS NULL`, and
  `drizzle.__drizzle_migrations` carries a row (`id=9`) whose hash matches
  `server/drizzle/meta/_journal.json`'s `0008` entry.

### 8.4 What I could not verify, and what it would take

- **The iOS document scanner cannot run in the Simulator, and was not
  exercised.** `VNDocumentCameraViewController` (the scanner both the
  original capture flow and this batch's add-a-page/replace-image screens
  use — `ReceiptImageUploadView.swift`'s `DocumentScannerView`) has no
  Simulator implementation; Apple's own framework requires a physical
  device with a camera. `KeptTests` (unit tests, no scanner involved) is
  what was run; nothing here exercised the actual scan-to-upload journey on
  Simulator or device.
- **No end-to-end Simulator UI run (`KeptUITests`) was performed for any
  iOS feature in this pass** — neither the ones described in §1-7 above nor
  this batch's. `xcodebuild test -only-testing:KeptTests` was run; the UI
  target was not.
- **Nothing in this batch has run against production, in any form.**
  Migration `0008` exists only on the local development database (§8.3).
  No `fly deploy` happened. No iOS build carrying any of #1-#6 was
  archived or uploaded — whatever build is on the phones predates this
  batch and predates the §1-7 round it sits on top of.
- **The visual rendering of the amber treatment on derived fills and
  vendor defaults** (§10A.1's widened rule) was read from the diff and the
  unit tests that pin `SuggestibleField`/`clientApplied`-style state, not
  confirmed by eye on either client — the same caveat §1.3/§1.4 above
  already state for the visual redesign generally.
- **The bulk-edit UI's actual browser behaviour** (partial failure leaving
  the right rows selected, the header checkbox's indeterminate state) was
  read from `bulkEdit.ts`'s unit-tested pure functions
  (`toggleSelectAll`/`runBatch`) and from `ReceiptsTable.tsx`'s wiring, not
  driven in a real browser in this pass.

### 8.5 What is owner-only

- Deploying the server and running migration `0008` against production
  Neon, once `0006`/`0007` (§5 above) have also run there.
- Everything already queued ahead of this in `CLAUDE.md`'s status section
  and in §5 above: the 1.0 (1) demo recording and resubmission, the Sign in
  with Apple `.p8`, the R2 `kept-backups` token, and the App Store Connect
  privacy label refiling. This batch adds nothing to that queue's order —
  it sits behind all of it, not beside it.

### 8.6 Anti-pattern self-review (framework §10.2)

- **Duplication:** `deriveMissingAmount` is defined once server-side and
  mirrored, not shared, on both clients — necessary duplication (a network
  round trip per keystroke would defeat the affordance), kept honest by an
  explicit "kept in exact correspondence" comment on the iOS mirror rather
  than left implicit. `presignAndPut` (web) and the equivalent shared
  sequence on iOS (`ReceiptImageUploadModel.uploadOnePage`) are each
  factored out once so the create path and the new add/replace paths share
  one presign-then-PUT implementation rather than three.
- **Error-masking:** none found in this batch — `runBatch`
  (`bulkEdit.ts`) explicitly catches per-worker rejections and reports them
  as `BatchFailure`s rather than swallowing them or failing the whole
  batch; the image-upload paths on both clients propagate the server's own
  `duplicate_image` message rather than inventing or discarding it.
- **Speculative generality:** none found — `receiptImageSchema` is reused
  by the create route and both new image routes rather than three near-copies,
  which is convergent reuse of an existing shape, not new abstraction built
  ahead of need.

### 8.7 State of this pass

Built and locally verified: server 578/49, web 136/11, iOS 365 unit tests
(re-run in this pass; UI tests not run), migration `0008` confirmed applied
locally by direct database inspection. **Not shipped in any sense** — no
deploy, no production migration, no App Store submission. No discrepancy
found between the orchestrating brief and the repository on any fact
checked in this pass (§8.2).

---

## 9 · Third pass, same day: four more approved UX proposals — not deployed

Scope: `docs/proposals/2026-08-28-ux-enhancements.md`'s remaining four
proposals. The owner approved **#7-#10** in a separate, later pass than the
six covered in §8 above — not the same sitting, which is why this section
and §8 stay apart rather than merge (`docs/DECISIONS.md` 2026-08-28, the
third-pass entry, states the identical reasoning for the two DECISIONS
entries). Built on top of §8's tree, in the same working directory — still
uncommitted, still undeployed, with **no new migration this pass**: `0008`
(§8.1) remains the newest file and is still local-only.

### 9.1 What was built

- **#7, HST rate-plausibility hint.** `checkHstRatePlausibility`
  (`server/src/domain/arithmetic.ts`) flags an effective HST rate within
  ±0.25 percentage points of 8% — the Ontario provincial half of a 13%
  split standing alone — and nothing wider; mirrored live on both clients
  (`ios/Kept/Confirm/ReceiptArithmetic.swift`,
  `web/src/views/ReceiptForm.tsx`'s own `checkHstRatePlausibility`).
  Confirmed by reading all three implementations side by side: identical
  constants (`HALF_SPLIT_RATE_BPS = 800`, `HALF_SPLIT_TOLERANCE_BPS = 25`),
  identical integer cross-multiplication, no floating-point division
  anywhere in the comparison.
- **#8, near-duplicate warning.** `GET /api/receipts/possible-duplicates`
  (`server/src/routes/receipts.ts`), registered above `/:id` alongside
  `/options` and `/summary`. Matches the caller's own **live** receipts on
  `purchased_at`, `total_cents`, and vendor compared
  case-and-whitespace-insensitively for the comparison only — confirmed by
  reading the route's SQL predicate
  (`lower(trim(receipts.vendor)) = lower(trim(${query.vendor}))`) and the
  response mapper (`receiptResponse`, which reads the row's stored vendor
  unchanged). Both clients debounce the lookup and render an amber,
  never-blocking note with a way to open each match
  (`web/src/duplicates.ts` + `ReceiptForm.tsx`'s `PossibleDuplicatesNote`;
  `ConfirmReceiptModel.swift`'s `checkForPossibleDuplicates` +
  `ConfirmReceiptView.swift`'s duplicate section, which opens the match in
  a real `ReceiptDetailView`, not a second summary).
- **#9, swipe actions, month headers, undo — iOS only.** Trailing
  swipe-to-delete and leading swipe-to-confirm on Home
  (`HomeView.swift`'s `receiptRow`), gated on `Receipt.canQuickConfirm`
  reading the **raw** `totalCents`, never the served `displayTotalCents`
  (confirmed by reading the extension's own doc comment, which states the
  merge-vs-raw distinction and why gating on the merge would offer a swipe
  that fails after the tap). Sticky per-month sections
  (`ReceiptMonthGrouping.swift`) chunk consecutive same-month rows without
  re-sorting — confirmed by reading `sections(of:)`, which only ever
  appends to the last section or starts a new one, never reorders.
  `POST /api/receipts/:id/restore` (`server/src/routes/receipts.ts`)
  un-tombstones the receipt and, in the same transaction, only the image
  rows sharing its exact `deleted_at` timestamp — confirmed by reading the
  transaction body and the two new integration tests that pin the
  page-replace-vs-delete distinction and the 409 collision case (below).
  The undo toast is a `HomeView` overlay with a six-second `.task(id:)`
  timeout keyed to `model.pendingUndo`'s identity.
- **#10, export period presets.** `web/src/fiscalPresets.ts` and
  `ios/Kept/Export/FiscalPresets.swift` — read side by side, function
  names, constants, and doc comments match line for line, confirmed rather
  than assumed from the iOS file's own "deliberate line-for-line port"
  claim. "Last fiscal year" sends `{fiscalYearEndingIn}`; the other three
  presets send an explicit `{periodStart, periodEnd}` computed client-side,
  since the API has no quarter concept (§12). Wired into both export
  screens (`web/src/views/ExportView.tsx`'s `resolvedPreset`,
  `ios/Kept/Export/ExportView.swift`), reading the user's own fiscal year
  end from `GET /api/me` (a pre-existing route; no server change).

### 9.2 Prediction versus reality

Written from the brief, before opening the files it described, per the
project's verify-artifacts-not-reports rule.

- **Predicted:** the rate-hint threshold would be an effective HST rate
  within ±0.25 percentage points of 8%, computed in integer arithmetic
  against `subtotalCents`/`hstCents`. **Reality: exact match** — read from
  `checkHstRatePlausibility` in all three implementations.
- **Predicted:** the new server route surface would be
  `GET /api/receipts/possible-duplicates`, `POST /api/receipts/:id/restore`,
  and a third route this summary's own wording ("§6, three new routes")
  did not let me derive in advance. **Reality: two new routes, not
  three.** Reading the whole diff of `server/src/routes/` (only
  `receipts.ts` changed, +242/-0 lines) and grepping every file under
  `server/src/routes/` for a new `router.get/post/patch/put/delete` call
  turns up exactly these two and nothing else; `GET /api/me`, which iOS's
  export screen reads for the fiscal year end (proposal #10), is a
  **pre-existing** route (`server/src/routes/me.ts`, unchanged — `git diff
  --stat -- server/src/routes/` shows only `receipts.ts`). **This is a
  genuine discrepancy between the orchestrating brief and the repository**,
  not a documentation choice — §6 of the spec now lists two new routes,
  matching the code, not three.
- **No other discrepancy found** between the brief and the repository on
  any route path, threshold, constant, or rejection named in the brief and
  checked in this pass — the CORS/telemetry-asymmetry finding below was
  not predicted by the brief at all, and is recorded as a finding rather
  than a prediction miss.

### 9.3 Verification actually performed, and by whom

- **Server: 620 tests / 51 files, green** (`npm test`, run in this pass).
  The pre-this-pass count was 578/49 (§8.3); the difference is two new
  integration files, `possibleDuplicates.test.ts` and
  `restoreReceipt.test.ts`, plus additions inside `arithmetic.test.ts`
  (the rate-hint boundary cases, including the exact 7.75%/8.25% edges and
  a same-boundary-at-a-different-scale case).
- **Web: 199 tests / 13 files, green** (`npm test`, run in this pass).
  Pre-this-pass count was 136/11; two new files, `duplicates.test.ts` and
  `fiscalPresets.test.ts` (the latter includes
  `"does not carry the year end's literal day number across a longer
  month"`, the regression test for the quarter-boundary bug named in
  §9.1), plus additions inside `receiptForm.test.ts`.
- **iOS: 440 unit tests, 0 failures** (`xcodebuild test -project
  Kept.xcodeproj -scheme Kept -destination 'platform=iOS Simulator,name=iPhone
  17 Pro' -only-testing:KeptTests`, run in this pass, `** TEST SUCCEEDED **`).
  Pre-this-pass count was 365 (§8.3); three new files,
  `FiscalPresetsTests.swift`, `ReceiptMonthGroupingTests.swift`, and
  `ExportPresetResolutionTests.swift`, plus additions inside
  `ReceiptArithmeticTests.swift`, `ConfirmReceiptModelTests.swift`,
  `ReceiptListModelTests.swift`, `APIClientTests.swift`, and
  `ExportViewModelTests.swift`. **`KeptUITests` was not run in this pass**
  — see §9.4.
- **No new migration exists to confirm applied.** `ls server/drizzle/*.sql`
  shows `0008_receipt-images-page-partial.sql` as the newest file, unchanged
  from §8.3's own reading — #7-#10 needed no schema change, confirmed by
  the absence of any new file under `server/drizzle/` and by reading every
  route this pass touches, none of which references a column or table not
  already in §5.
- **The restore route's isolation and collision behaviour is
  integration-tested, not merely unit-tested**: `restoreReceipt.test.ts`
  covers restoring a deleted receipt's image alongside it, leaving an
  earlier page-replace's tombstoned image untouched, the 409 collision
  case, all three 404-alike cases (nonexistent / another user's / not
  currently deleted), and that another live receipt's images are never
  touched.

### 9.4 What I could not verify, and what it would take

- **The iOS document scanner still cannot run in the Simulator**, and
  nothing in this batch touches the scanner path directly, but the swipe
  actions and undo toast built here live on the same `HomeView` screen
  the scanner's captures land on — none of that screen's real-device
  behaviour (the swipe gesture itself, the toast's timing and layout
  against the keyboard/safe area, VoiceOver over the new
  `accessibilityIdentifier`s) was exercised on Simulator or device.
- **No end-to-end Simulator UI run (`KeptUITests`) was performed** for the
  swipe gestures, the undo toast, the duplicate-match sheet, or the export
  preset picker on either client. `xcodebuild test -only-testing:KeptTests`
  was run; the UI target was not.
- **Nothing in this batch has run against production, in any form.** No
  `fly deploy` happened. No iOS build carrying any of #7-#10 was archived
  or uploaded — whatever build is on the phones predates this batch and
  the two rounds it sits on top of.
- **The visual rendering of the rate hint and the duplicate-match note**
  (amber, inside-the-field for the former, a standalone section for the
  latter) was read from the diff and the unit/integration tests that pin
  the underlying booleans and query results, not confirmed by eye on
  either client.
- **The undo toast's real timing** — whether six seconds reads as
  "generous" or "too short" on an actual swipe, and whether the toast
  visually clears the keyboard and the tab/home-indicator safe areas — was
  not driven on Simulator or device; only `.task(id:)`'s cancellation logic
  is covered, by unit test, and the six-second constant is read from the
  source rather than timed.
- **The web export preset dropdown's actual browser behaviour** (the
  `<select>` control, the shown-range text, hiding until the profile loads)
  was read from `ExportView.tsx`'s JSX and `fiscalPresets.test.ts`'s pure
  function tests, not driven in a real browser in this pass.

### 9.5 What is owner-only

- Deploying the server, once `0006`/`0007`/`0008` (§5, §8.1 above) have
  also run against production — this pass adds no new migration to that
  list, but does not shorten it either.
- Everything already queued ahead of this in `CLAUDE.md`'s status section
  and in §5/§8.5 above: the 1.0 (1) demo recording and resubmission, the
  Sign in with Apple `.p8`, the R2 `kept-backups` token, and the App Store
  Connect privacy label refiling. This batch adds nothing to that queue's
  order — it sits behind all of it, not beside it.

### 9.6 Anti-pattern self-review (framework §10.2)

- **Duplication:** `checkHstRatePlausibility` and the fiscal-preset
  arithmetic are each defined once server-side or once on web and mirrored
  — not shared — on iOS, the same necessary duplication §8.6 already
  accepted for `deriveMissingAmount`, for the identical reason (a network
  round trip per keystroke, or per screen open, would defeat a live
  affordance); both mirrors carry an explicit "kept in exact
  correspondence" comment rather than leaving the duplication implicit.
  `onOpenReceipt` (web) is one function, threaded from `App.tsx` into the
  table, the confirm queue, and the detail form, rather than three
  separate "open a receipt" implementations.
- **Error-masking:** none found — `checkForPossibleDuplicates` (iOS) and
  `lookupPossibleDuplicates` (web) both swallow a failed lookup into an
  empty result **by explicit, documented contract** ("an assist over a
  save that must keep working when the assist cannot"), not a silent catch
  masking an unhandled case; the restore route's 409 is a named error with
  the server's own remedy text, propagated verbatim on both clients rather
  than reworded or swallowed.
- **Speculative generality:** none found — `possibleDuplicatesQuerySchema`
  reuses the existing `centsSchema`/`isoDateSchema`/`vendorText` building
  blocks rather than a new validation shape, and `FiscalQuarters` (iOS) is
  a named struct with four fields rather than a generic N-tuple, added
  because `ExportView.swift` needs to address one quarter by name — a
  concrete need, not abstraction ahead of one.

### 9.7 State of this pass

Built and locally verified: server 620/51, web 199/13, iOS 440 unit tests
(all re-run in this pass; UI tests not run on either client), no new
migration to verify. **Not shipped in any sense** — no deploy, no
production migration, no App Store submission. **One discrepancy found
between the orchestrating brief and the repository** (§9.2): the brief
described three new server routes; the repository has two. The spec (§6)
and this report describe the two that exist. **One finding outside the
four proposals**, recorded in full in `docs/DECISIONS.md`'s third-pass
entry: the web client's `suggestion_accepted` telemetry for
proposal-#1/#2 fills fired at apply time rather than at save, an asymmetry
with iOS's save-time scoring, fixed in the same tree as this pass.
