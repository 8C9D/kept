# Product-feedback gate report — 2026-08-28

2026-08-28.
Scope: the owner's second round of product feedback after real use — tip and
other-fees fields, an iOS export screen, a model change, split-HST parsing
in both parsers, behavioural telemetry, and three web-client gap fixes.
Built across `server/`, `ios/`, `web/` in one session. **Nothing deployed.
Migrations `0006` and `0007` are applied to the local dev database only.**

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
