# Kept — Build Spec

**Status:** v1 spec, written August 5, 2026 · **Owner:** The owner · **Implementation harness:** Claude Code
**Name:** **Kept** *(chosen Aug 5 — "I kept the receipt." The bundle identifier follows from this; do not rename after wave 6, since the identifier is permanent for the App Store record.)*

---

## 1 · What this is and how we know it worked

**The problem.** Receipts accumulate. Paper ones pile up in a room, emailed PDFs bury themselves in an inbox, and at year-end both have to be excavated. The business's receipts have the same shape as the owner's, at higher volume.

**The success test — one sentence.** *A receipt is captured in under a minute and never thought about again.*

Every design decision in this document is subordinate to that sentence. If a feature improves the year-end artifact but slows capture, it loses. If a feature makes capture faster, it wins even if the year-end output is rougher.

**Anti-success test.** The tool fails if, in November, the owner or a second user has a receipt in hand and chooses the shoebox because the app is slower. That is the only failure mode that matters in v1.

---

## 2 · Non-goals — do not build these

- **Expense categorization as a system.** Category is a free-text field. No taxonomy, no CRA line mapping, no rules engine, no auto-categorization. *(The CRA T2125 research is a later retrofit; the schema should not preclude it, but v1 builds none of it.)*
- **Any deductibility judgment.** The app captures, stores, and totals. What is deductible is the accountant's call. No UI copy may imply otherwise.
- **A shared family space.** No household entity, no cross-user visibility, no shared dashboard.
- **Android, web client, or public distribution.** Possible future; not now.
- **Automated email ingestion.** v2 — see §11.
- **Bank/card feed integration, mileage tracking, invoicing, payroll.** Out of scope entirely.

---

## 3 · Constraints that do not move

These four came out of the requirements work and are not preferences. A change to any of them is a spec change, not an implementation decision.

1. **HST is its own field**, never folded into the total, and the **supplier's GST/HST registration number** is captured alongside it. Input tax credits are claimed on the HST portion specifically, and CRA requires the supplier's registration number on supporting documentation above roughly $30 (more above roughly $150 — confirm the thresholds with the accountant). "Photo plus total" is not sufficient documentation.
2. **No OCR value ever saves without a human confirming it.** Extracted fields are *suggestions* in an editable form. A receipt is not "done" until a person has looked at the amount. A tool that silently guesses a total is worse than a shoebox, because the error stays invisible until the accountant finds it.
3. **Business-vs-personal is set at capture time**, never as cleanup. If it is cleanup, it will not happen.
4. **Full per-user isolation.** Each user sees only their own receipts. Year-end sharing is an exported file, not a standing permission.

> **Design note on constraint 2.** It is what makes weak OCR acceptable. The parser in §7.3 is heuristic and *will* be wrong sometimes. That is fine by design, because a human reads every number before it saves. Do not let a later "improve accuracy" impulse turn into "skip the confirmation step for high-confidence extractions" — that trade destroys the guarantee.

---

## 4 · Architecture

### 4.1 Shape

```
iPhone (SwiftUI)                    Backend (TypeScript)
┌──────────────────────┐            ┌──────────────────────────┐
│ VisionKit scan       │            │ Hono route handlers      │
│ Vision OCR (on-dev)  │──HTTPS────▶│ Drizzle ORM              │
│ Confirm form         │            │ Postgres                 │
│ Offline outbox       │            │ XLSX + zip export        │
└──────────────────────┘            └───────────┬──────────────┘
         │                                      │
         └──── presigned PUT ──────────▶ Cloudflare R2 (images)
```

**The iOS app is a capture-and-confirm client. All domain logic lives in the backend.** HST arithmetic checks, export generation, filename derivation, fiscal-period slicing, validation — backend. This is deliberate: the stated possibility of an Android or web client later means a rule implemented in Swift is a rule that has to be written twice.

### 4.1a Two clients, one API

**iPhone — capture.** Scanning, confirming, and the offline outbox. This is where receipts enter the system.

**Web — everything a phone is bad at.** Reviewing and correcting many receipts at once, searching and filtering a year, viewing an image at full size beside its fields, and **running the year-end export.**

**The web client does not capture.** No camera path, no upload-a-photo flow in v1. Capture is a phone activity; splitting it across two clients doubles the most delicate code in the project for no gain.

**Export moves to web-only.** A year-end export is a zip containing every image — potentially gigabytes — that gets emailed to an accountant. Generating and downloading that over cellular, on the device with the least storage, to then share it off again, is the wrong place for it. **This removes the export screen from the iOS app**, taking it from six screens to five.

> This split is why §4.1's rule already mattered: the domain logic lives in the backend, so the second client is a second *view*, not a second implementation of the rules.

### 4.2 Stack, with reasons

| Layer | Choice | Why |
|---|---|---|
| Client | **SwiftUI**, iOS 17+ | Native was the decision; 17+ avoids back-compat work for a 3-device audience. |
| Scan | **VisionKit** `VNDocumentCameraViewController` | Apple's document scanner: edge detection, perspective correction, glare handling, multi-page. This is the single biggest reason native was chosen — do not replace it with a raw `AVCaptureSession`. |
| OCR | **Vision** `VNRecognizeTextRequest`, `.accurate` | On-device, free, offline, no per-scan API cost. |
| Backend | **Hono + TypeScript on Node** | This backend is ~10 JSON endpoints. Hono is a purpose-built API framework: minimal surface, first-class TS inference on routes and middleware, runtime-portable (Node, Bun, Workers). Shipping a React meta-framework to serve JSON would be the wrong shape. |
| DB | **Postgres 16**, Drizzle ORM | Postgres because it is free at this scale and permanently closes the concurrency, backup, and migration questions. Drizzle because on a two-table schema it earns its keep on typed queries and migrations without a client-generation step or a separate engine binary. |
| Images | **Cloudflare R2**, S3-compatible SDK | $0.015/GB-month, free egress, 10 GB free tier — storage is $0 for roughly four years at projected volume. *(Wave-3 gate review: local dev runs **MinIO** in docker-compose behind the same S3-compatible adapter, so the presigned upload/download path is exercised end to end before R2 credentials exist; wave 4's capture flow depends on it.)* |
| Auth | **Sign in with Apple** → backend-issued JWT | Zero passwords to store or reset, native sheet, one tap. Correct for an all-Apple audience. ⚠ The **web** flow needs a separate **Services ID**, a verified domain, and a configured return URL — real setup work, not a code change. Budget it. |
| Web client | **Vite + React + TypeScript**, static build | A table, a filter bar, a detail form, and an export button. A static SPA against the same API deploys free to Cloudflare Pages and keeps the API framework-agnostic — which is also what keeps a future Android client cheap. |
| Export | **ExcelJS** (XLSX) + **archiver** (zip) | ExcelJS is actively maintained and is the stronger mainstream option for *writing* files with cell formatting, which is what this needs. SheetJS is broader on format support and better at reading — not what matters here. Generation stays server-side so the rules live in one place. |
| Tests | **Vitest** (unit + integration + HTTP), **XCTest** (client) | Vitest covers the whole backend, including HTTP-level tests against the Hono app in-process. **No Playwright** — there is no browser anywhere in this project. |

### 4.3 Alternatives considered and rejected

Recorded so they are not silently revisited, and so the reasoning stays auditable.

- **Next.js for the backend** — rejected, and **re-examined on Aug 5 when the web client was added.** The obvious argument for Next.js is one framework serving both API and web UI. It still loses: the web client here is a table, a form, and a download button, which a static SPA covers with no SSR, no server components, and no framework coupling on an API that two other clients also consume. Hono can serve the SPA build from the same process if a single deployable is ever wanted.
- **Electron or a native macOS app for the desktop client** — rejected. The desktop surface is a table and a form. Electron ships a browser to render it; a SwiftUI Mac target shares Swift code but doubles client work for a view the browser already handles. A web app is also the only option that works from whatever computer either of them happens to be sitting at.
- **Fastify** — a legitimate second choice, and the safer pick if plugin ecosystem ever matters. Hono wins on TypeScript inference quality and a smaller surface for an API this size.
- **Swift on the server (Vapor)** — genuinely tempting for an all-Apple project: one language, and `Codable` models shared between client and server via a Swift package. Rejected on ecosystem — XLSX generation, object-storage SDKs, and hosting are all materially worse, and that cost lands directly on the features this app exists for.
- **Go** — fine language, no advantage here. The bottleneck is iteration speed on a small API, not runtime performance.
- **SQLite / Turso instead of Postgres** — defensible at three users and arguably simpler. Rejected because Postgres costs nothing at this scale and closes the backup and concurrency questions without further thought.
- **Prisma instead of Drizzle** — heavier, adds a client-generation step, and its abstraction pays off on large schemas. Two tables is not that.
- **Cloud expense-parsing OCR as the primary path** — see §7.3. Rejected *for v1 only*, on the offline requirement, not on cost.

### 4.4 Repo layout

```
kept/
  CLAUDE.md                     ← agent instructions, see §10
  docs/
    Kept-Build-Spec.md          ← this file
    Agentic-SDLC-Framework.md   ← reference
  web/                          ← Vite + React SPA (review, search, export)
    src/
    tests/
  server/
    docker-compose.yml          ← Postgres 16 for local dev
    drizzle/                    ← migrations
    src/domain/                 ← pure TS: validation, arithmetic checks, filename rules
    src/db/                     ← schema, seed
    src/routes/                 ← Hono route handlers
    src/export/                 ← XLSX + zip generation
    tests/unit/
    tests/integration/          ← against real Postgres
    tests/e2e/
  ios/
    Kept.xcodeproj
    Kept/                       ← SwiftUI app
    KeptTests/                  ← XCTest
```

---

## 5 · Data model

Deliberately small. No household, organization, or team entity — that was removed by the isolation decision.

### `users`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `apple_sub` | text unique | Sign in with Apple subject identifier |
| `email` | text nullable | Apple relay addresses are common; do not treat as identity |
| `display_name` | text **nullable** | Apple provides the name only on first authorization, client-side, and may provide nothing; a placeholder would corrupt the field (same reasoning as `vendor`). *(Wave 1)* |
| `token_version` | integer default 0 | Stamped into every session JWT (`tv` claim) and compared on each request; bumping it revokes all of the user's outstanding sessions. *(Wave-1 gate review)* |
| `fiscal_year_end_month` | smallint default 12 | **Config, not an assumption.** See §5.1 |
| `fiscal_year_end_day` | smallint default 31 | |
| `created_at` | timestamptz | |

### `receipts`
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → users | **Every query scopes on this. No exceptions.** |
| `purchased_at` | date | The date on the receipt, not the capture date |
| `captured_at` | timestamptz | |
| `vendor` | text **nullable** | An illegible vendor is a real outcome; forcing a placeholder string corrupts the field for everyone reading it later. |
| `vendor_tax_number` | text nullable | GST/HST registration number |
| `subtotal_cents` | integer nullable | |
| `hst_cents` | integer nullable | **Own field. Never derived from total.** |
| `other_tax_cents` | integer nullable | Tips, non-HST amounts — keeps them out of the HST field |
| `total_cents` | integer **nullable while `pending`** | *(Wave 4)* A batch-scanned receipt whose total the parser could not read stores the absence — never a fabricated amount. A CHECK constraint (`receipts_confirmed_complete_ck`) guarantees every `confirmed` row has a total, and the confirm screen cannot save without one. |
| `currency` | char(3) default 'CAD' | |
| `category` | text nullable | **Free text.** No enum, no FK, no taxonomy |
| `payment_method` | text nullable | |
| `is_business` | boolean **nullable while `pending`, no default** | **See §5.2.** *(Wave 4)* Null means "not chosen yet", which only a pending receipt may be; the same CHECK constraint forbids a confirmed row without the choice, and the confirm screen's save stays disabled until it is made. There is still no default at any layer. |
| `notes` | text nullable | |
| `deleted_at` | timestamptz nullable | **Soft delete.** Non-null rows are excluded from every list, count, and export. |
| `status` | enum `pending` \| `confirmed`, **default `pending`** | **See §5.3.** A receipt is `pending` until a human has confirmed its numbers. **Exports include `confirmed` only.** |
| `ocr_raw_text` | text nullable | Kept for debugging the parser and for future re-parsing |
| `ocr_suggestions` | jsonb nullable | *(Wave 4)* What the on-device parser suggested at capture, verbatim and **immutable** (no route updates it). Comparing it with the fields a human confirmed is the §7.3 accuracy measurement — `npm run parse-accuracy` — with no bookkeeping by anyone. |
| `created_at` / `updated_at` | timestamptz, default `now()` | ⚠ `updated_at` is maintained by a **Postgres trigger**, not by handler code. A field whose freshness depends on every future handler remembering it is a field that silently rots. |

**Money is stored as integer cents.** Never floats. The HST figure is a tax claim.

**Indexes:** `(user_id, purchased_at)`, `(user_id, is_business)`, `(user_id, status)`.

### `receipt_images`

Separate table from day one, even though v1 captures a single page.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `receipt_id` | uuid FK → receipts | |
| `user_id` | uuid FK → users | **Denormalized deliberately** — see the constraint note below. |
| `page` | smallint | 1-based ordering |
| `object_key` | text | R2 key |
| `sha256` | text | Integrity check and cheap duplicate detection |
| `deleted_at` | timestamptz nullable | Stamped when the owning receipt is soft-deleted; the row is kept for retention. *(Wave 1)* |
| `created_at` | timestamptz | |

**Unique `(receipt_id, page)`, and unique `(user_id, sha256)` — partial, `WHERE deleted_at IS NULL`.** *(Wave 1 correction.)* Deleting a receipt stamps `deleted_at` on its image rows in the same transaction. Without the partial scope, a deleted receipt's image would occupy its uniqueness slot forever: delete a receipt, re-capture the same file, and the API answers 409 against a row the user can no longer see, with no path to recovery.

⚠ **Corrected Aug 5 — the earlier version of this note overclaimed.** A unique on `(receipt_id, sha256)` only prevents the same image appearing twice *on one receipt*, which is not the failure anyone has. The constraint has to be scoped to the **user**, which is why `user_id` is denormalized onto this table rather than reached through a join — a constraint that needs a join is not a constraint.

⚠ **And be honest about what it catches.** Byte-identical duplicates are real on the **file-upload path**: re-dragging the same PDF out of an email backlog produces the same bytes, and the constraint stops it cleanly. **It does not catch a re-scanned piece of paper** — two photographs of one receipt differ in every pixel, so no hash will ever match them. **Near-duplicate detection** (same date, same vendor, same total → warn at confirm time) is the answer to that, and it is **deferred to v2** (§11). Do not let the hash constraint stand in for it.

**Why a table rather than a column.** Multi-page receipts are deferred (§11), but deferring them with an `image_key` column means a migration later; deferring them with this table costs one join now and nothing later. Cheap insurance against an unresolved question (§12).

### `export_jobs` *(added wave 2)*

§6's export contract (job id + polling) needs a job store, which the original data model omitted — flagged at the wave-1 gate. Jobs are rows, not process memory: a restart must not lose a running year-end export.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | uuid FK → users | Same isolation rule as everything else |
| `status` | enum `queued` \| `running` \| `complete` \| `failed`, default `queued` | Every outcome, including failure, is written to the row; a polling client always learns what happened |
| `period_start` / `period_end` | date | Inclusive, resolved at request time |
| `object_key` | text nullable | Where the finished zip landed; null until complete |
| `error` | text nullable | Why the job failed; null otherwise |
| `created_at` | timestamptz | |
| `completed_at` | timestamptz nullable | |

Index `(user_id, created_at)`.

### 5.1 Fiscal year end is config, and the rule that keeps it cheap

**Store `purchased_at` only. Derive the fiscal period at query time.** Never bake a year boundary into storage, object keys, or filenames — the image path stays calendar-based `YYYY/MM/`. Changing the fiscal year end then re-runs an export instead of triggering a migration. This is why the answer can arrive in October without costing anything.

### 5.2a `status` — how a backlog coexists with constraint 2

Constraint 2 says no OCR value saves without human confirmation. A backlog pass wants the opposite rhythm: scan sixty receipts quickly, confirm them later at a desk.

**These reconcile through state, not by relaxing the rule.** A scanned-but-unreviewed receipt is `pending`. Pending receipts are stored, are visible, are counted — and are **excluded from every export.** Nothing unconfirmed can reach an accountant, which is the actual guarantee constraint 2 exists to make. The confirm step is deferred, never skipped.

**The UI must make the pending count visible and slightly annoying** — a badge on Home, a banner on the web table. A pending queue that is easy to ignore recreates the shoebox inside the app.

### 5.2 `is_business` has no default

Not `false`, not `null`. The confirm form cannot be submitted without an explicit choice. A default is how this field silently becomes cleanup work in March.

---

## 6 · API surface

All routes require a valid session JWT. **Every handler derives `user_id` from the token — never from the request body.** An endpoint that accepts a user id as a parameter is a bug.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/apple` | Exchange Apple identity token for a session JWT |
| `POST` | `/api/receipts/upload-url` | Returns a presigned R2 PUT URL + object key |
| `POST` | `/api/receipts` | Create a receipt (after the image is uploaded) |
| `GET` | `/api/receipts` | List own receipts; filters: date range, `is_business`, `status`, text search. **Paged**: keyset cursor + limit (default 50, max 200), because the backlog import makes lists large on day one. *(Wave-1 gate review)* The response also carries **`pendingCount`** - the user's total pending, non-deleted receipts, deliberately independent of the request's filters and paging - so both clients' §5.2a badges read one number from the list they already fetch. *(Wave-3 gate review; replaces the iOS client's 200-row probe.)* |
| `GET` | `/api/receipts/:id` | Detail + presigned GET for the image |
| `PATCH` | `/api/receipts/:id` | Edit fields |
| `DELETE` | `/api/receipts/:id` | Soft delete |
| `POST` | `/api/export` | Kick off an export; body is either `{fiscalYearEndingIn}` (dates derived from the user's settings at request time, §5.1) or an explicit `{periodStart, periodEnd}` — the seam a quarterly picker would use (§12). Returns the job. *(Wave 2)* |
| `GET` | `/api/export` | The caller's own jobs, newest first — the web export screen's history list. *(Wave-2 gate review)* |
| `GET` | `/api/export/:id` | Poll status; carries a presigned download URL while complete and unexpired, and the recorded error when failed. Two **computed** statuses tell the client to re-run rather than wait: `expired` (complete but past the 30-day zip lifecycle, §10B) and `stale` (sat `queued` past 5 minutes, or `running` past 30 — lost before it started or crashed mid-run; no sweeper process exists, the status itself stops the polling). *(Wave-2 gate review, revised)* |
| `GET` | `/api/me` | Profile + fiscal year settings |
| `PATCH` | `/api/me` | Update fiscal year settings |

**Image upload goes phone → R2 directly via presigned URL.** The image never transits the API server. Simpler, cheaper, and it makes the offline outbox retry logic straightforward.

---

## 7 · The iOS client

### 7.1 Screens — the whole iOS app in v1

1. **Sign in** — one Sign in with Apple button.
2. **Home** — a large **Capture** button and a reverse-chronological list of recent receipts. Any pending outbox items show at the top with their status. Capture must be reachable in one tap from cold launch. *(Wave-3 gate review: "recent" is ordering, not a cutoff — the list is every receipt, newest purchase first, paged.)*
3. **Capture** — opens `VNDocumentCameraViewController` immediately. No intermediate screen, no mode picker.
4. **Confirm** — the heart of the app. See §7.2.
5. **Receipt detail** — the record plus the image; every field editable.
That is five screens. **Export is deliberately absent — it lives on the web client (§7A).** Resist adding a sixth.

### 7.2 The confirm screen — get this right or nothing else matters

- Scanned image at the top, tappable to zoom. The person is checking numbers against the paper; they must be able to see the paper.
- Fields in this order, all pre-filled with OCR suggestions and all editable: **total · date · vendor · HST · subtotal · other tax · vendor tax number · business/personal · category · payment method · notes.**
- **Total first** because it is the field most likely to be checked and least likely to be skipped.
- **Every prefilled field is visually marked as a suggestion** until the person has looked at it. Touching a field clears the marking. This is what makes constraint 2 real in the UI rather than just in the schema.
- **Inline arithmetic check:** if `subtotal + hst + other_tax` does not equal `total`, show a non-blocking warning next to the total. Do not auto-correct, do not block saving — plenty of legitimate receipts will not reconcile. It is a prompt to look, not a rule.
- **Business/personal is a required two-button choice**, prominent, never pre-selected.
- Save is one tap and returns to Home. No confirmation dialog, no success modal.

### 7.3 OCR parsing — heuristic on purpose

Vision returns text lines with bounding boxes, not structured fields. The parser is a set of heuristics in Swift:

- **Total** — the largest currency amount on a line containing "total" (case-insensitive), excluding "subtotal"; fall back to the largest currency amount in the lower third of the image.
- **HST/GST** — a currency amount on a tax-labelled line, with the labels **ranked, never lumped** *(wave-5 device step 1: a receipt printing "GST $0.00" above "HST $2.05" put the GST zero into the HST field - the input tax credit, where a wrong-but-plausible 0.00 is more dangerous than an absence)*: non-zero HST > non-zero GST > non-zero TAX > zero HST > zero GST > zero TAX, topmost within a tier. HST outranks GST as the more specific label; a lone GST row still suggests here (one CRA program); zeros are demoted below any non-zero sibling because an explicit 0.00 beside a charged sibling label is a shadow, while an all-zero tax block is a genuinely exempt receipt. Bare `TAX` lines that mention a total stay excluded.
- **Subtotal** — a currency amount on the **bottom-most** line matching `SUBTOTAL|SUB TOTAL` *(wave-5 audit: section subtotals print above the summary block; single-subtotal receipts unaffected; no real multi-subtotal receipt seen yet - the accuracy table arbitrates)*.
- **Vendor tax number** — regex `\b\d{9}\s?RT\s?\d{4}\b` (Canadian business number plus GST/HST program identifier), falling back to a bare 9-digit number adjacent to a `GST|HST|BN` label.
- **Date** — first parseable date; prefer the top third of the image.
- **Vendor** — the largest-font text block in the top quarter.

**⚠ The upgrade path, and why it is not v1.** Cloud expense parsers (AWS Textract `AnalyzeExpense`, Google Document AI, Azure Document Intelligence) return **structured fields** — vendor, date, total, tax — rather than raw text, and would delete this entire heuristic parser, the most fragile part of the spec. At roughly a cent per receipt, cost is not the objection: ~250 receipts a month is a few dollars.

**The objection is the success test.** Server-side OCR means a person standing in a store with poor signal gets a confirm screen with empty fields, or no confirm screen at all. On-device Vision returns suggestions instantly and offline, which is what makes capture-in-under-a-minute hold everywhere rather than only on good wifi. **So: on-device for v1, with the suggestion interface kept as a plain struct** so a server-side parser can later augment or override it — including re-parsing historical receipts, which is exactly what the stored raw text enables.

**Decide this with data, not taste.** Wave 4 measures per-field parse accuracy on ten real receipts. If a field parses badly enough that people stop trusting the prefill, that is the trigger to add a cloud parser as background enrichment — never a reason to relax the human-confirmation rule.

**Store `ocr_raw_text` on every receipt.** It makes parser failures diagnosable and lets a better parser re-run over old receipts later without recapturing anything.

**Two §7.3 refinements from the wave-4 re-test** *(second pass)*. **(1) Vendor is the topmost of the near-tallest band, not the single tallest line.** On a thermal receipt every header line is the same print size and Vision's measured heights jitter a few percent per scan - the same paper suggested the store name on one photo and its street address on the next. Among letter-bearing top-quarter lines within 15% of the tallest, the topmost wins (the name prints above the address); a genuinely larger name still wins outright. **(2) Labels also match with spaces removed** ("Tot al 15.25" - a real Vision mid-word split - reads as a total line), fenced by letters rather than word boundaries so "TOTAL SAVINGS" despaced does not false-match. Both carry the same one-sample caveat as the assembler.

**Row assembly precedes every heuristic** *(wave-4 gate review; de-skew added at the wave-5 device re-test)*. Thermal receipts - most receipts - print a label and its amount as two Vision observations separated by a wide gap, and a heuristic that matches label and amount within one string can never pair them; on the first real device receipt, subtotal and HST failed exactly this way while every contiguously-printed field parsed. The parser therefore first merges fragments sharing a horizontal band into printed rows (ordered left to right by bounding box), and the stored `ocr_raw_text` keeps the assembled rows so a future re-parse retains the pairing. **Assembly de-skews the amount column first**: a photographed receipt's right column can measure a near-constant vertical offset from its labels (camera angle, paper curl), and the wave-5 device receipt measured ~60% of a row pitch - enough that every tax-block amount's *nearest* label was the wrong one, which produced three different wrong HST suggestions (0.00, then the total) from one paper. The assembler estimates the receipt-wide offset (median of nearest-neighbour deltas; zero under 3 samples) and removes it for grouping only. ⚠ Validated against **two** real receipts with opposite skew signs; a skew of a full row pitch would shift every pairing undetectably - constraint 2's human check remains the floor. Treat assembler misfires (two rows merged, one row split, columns mispaired) as their own category when reading `parse-accuracy` corrections.

### 7.4 Offline outbox — v1, not optional

Capture happens standing in a store, sometimes with bad signal. A capture that fails because of connectivity breaks the success test.

- On save, write the record and the image to a local queue and return immediately - "save" meaning whichever save the flow reaches: the confirm screen's Save for a single capture (which lands the receipt already `confirmed`), the per-page queueing for a batch. *(Wave-5 gate ratification: "return to Home immediately" means don't block on the network, not don't show the confirm screen - a single capture still goes scan → confirm, with the form prefilled from the on-device parse and backed by local data; "Later" queues it pending. A batch queues pending immediately and is worked down through the confirm queue.)*
- A worker uploads the image to R2, then POSTs the receipt. *(Wave 5, ratified at the gate: the worker is app-lifecycle-driven - launch, foregrounding, connectivity return, sign-in, a fresh capture - plus the ~30-second system grant after backgrounding. There is deliberately no OS background execution, which is what lets the keychain stay `WhenUnlocked`; the argument is in `DECISIONS.md`.)*
- Retry with backoff. Surface stuck items on Home with a manual retry.
- **The person is never blocked on the network.** Their receipt is safe the moment they hit save.

---

## 6A · The backlog — confirmed, and it changes v1

Both the owner and a second user have an existing pile: **paper receipts and emailed PDFs, accumulated across a fiscal year already seven months old.** This was confirmed Aug 5 and is not a v2 concern — a tool that cannot absorb the existing pile starts life already behind, and the pile is the very thing that motivated the project.

**Three consequences, all in v1:**

1. **Batch scanning on iOS.** `VNDocumentCameraViewController` captures multiple pages in one session without reopening the camera. Use it for backlog mode: scan receipts back to back, each becomes its own `pending` receipt, confirm them afterwards in a queue. **One-at-a-time capture is correct for a receipt you just received and wrong for a stack of eighty.**
2. **⚠ Multi-file upload on the web client — a correction to §4.1a.** The rule stands that **web does not do *camera capture***, but the email backlog is a folder of PDFs on a laptop. Dragging eighty files into a browser is the right interaction; forwarding them to a phone one at a time is absurd. **Web gets a multi-file upload that creates `pending` receipts.** This is narrower than it sounds — it reuses the same create path, with no camera code on the web at all.
3. **A confirm queue, on both clients.** "Next unconfirmed receipt" as a repeatable action, so a backlog is worked down in a sitting rather than hunted through a list.

**⚠ Wave-order consequence.** Wave 7 (the web client) carries the email-backlog path, which makes it more valuable earlier than "before year-end." **Consider promoting it to immediately after wave 5**, ahead of iOS distribution — the backlog is a today problem, whereas distribution serves the ongoing case.

## 7A · The web client

**Purpose:** the year-end pass and any bulk correction. It is used rarely and intensely — the opposite of the iOS app's usage pattern — and the UI should reflect that: density over friendliness.

**Screens:**
1. **Sign in** — Sign in with Apple for the web.
2. **Table** — every receipt, sortable and filterable by date range, business/personal, vendor, and free-text search across vendor, category, and notes. Inline editing on every field. Row click opens the image.
3. **Detail** — the image at full size beside its fields, for checking a number against the paper properly.
4. **Export** — pick a period, generate, download the zip.

**Plus multi-file upload for the backlog (§6A):** drop a folder of PDFs or images, each becomes a `pending` receipt.

**What it must not have:** camera capture, or any cross-user view. Same isolation rule as everywhere else — the session decides whose receipts load, never a parameter.

**Deployment:** static build to Cloudflare Pages, free at this scale.

## 8 · Export

Triggered from the app, generated server-side, delivered as a single zip.

```
Receipts-2026.zip
  receipts-2026.xlsx
  receipts-2026.csv
  images/
    2026/01/2026-01-14_Staples_00042.jpg
    2026/02/...
```

**Columns, in this exact order, in both files:**

`receipt_id · date · vendor · vendor_gst_hst_number · subtotal · hst · other_tax · total · currency · category · payment_method · business_or_personal · whose · image_filename · notes`

- **`image_filename` must match the path in `images/`.** The point of the folder is that the accountant can click from a row to the paper. Verify this in a test rather than by eye.
- **`whose` exists for accountant-side merging.** Each export is strictly one person's data (§3 constraint 4), so the column is constant within a file **by design** - and that constancy is exactly what makes a combined workbook of two people's exports unambiguous row by row. Do not "clean it up". *(Wave-2 gate review)*
- **Generation refuses oversized exports rather than streaming them.** Assembly is in-memory, and with the backlog and six-year retention a year's zip can reach gigabytes; past a **byte budget** (default 256 MiB) the job **fails with a clear reason** ("export a shorter period"), which is a far better outcome than an OOM crash. Streaming is deliberately not built. Bytes are the only measure — a row count would be a worse-measured proxy for the same memory bound and could refuse an export that would have fit. *(Wave-2 gate review, revised)*
- **XLSX is primary** (what an accountant opens); **CSV is the same data** (what imports into accounting software).
- Money renders as decimal currency in the export, even though it is cents in the database.
- Filename pattern: `{date}_{vendor-slug}_{short-id}.jpg` — deterministic, sortable, no collisions. *(Wave 2: the short id is the receipt uuid's first 8 hex characters — deterministic with no counter state; a null vendor slugs to `unknown-vendor`.)*
- The export period is derived from the user's fiscal year settings at request time (§5.1).
- *(Wave 2)* The zip and spreadsheet label is the calendar year when the period is exactly Jan 1–Dec 31 (`Receipts-2026.zip`); any other period names itself as the explicit range (`Receipts-2025-04-01_to_2026-03-31.zip`), so a fiscal or quarterly slice is never mislabelled as a calendar year.

---

## 9 · Build order — waves with verification gates

Each wave ends at a gate. **A gate is passed by inspecting an artifact, not by reading a summary.** Do not start the next wave until the current gate is genuinely closed.

| Wave | Build | Gate — verified how |
|---|---|---|
| **0** | Repo, Docker Postgres, Drizzle schema, migrations, seed | `psql` into the container and inspect the actual tables and indexes. Not "migration ran successfully." |
| **1** | Domain logic + all Hono routes + auth, no client | Integration tests against real Postgres. **Write one test that queries as user A for user B's receipt and asserts a 404.** Isolation is the security property here; prove it in a test, not by reading the code. |
| **2** | Export generation | Open the produced XLSX. Confirm the columns, the ordering, the money formatting. Unzip and confirm every `image_filename` cell resolves to a real file in `images/`. |
| **3** | iOS shell: auth, home, list | Runs on a real device and signs in. |
| **4** | Scan → OCR → confirm → save | **Physical device only, and the owner must test this one himself.** Capture ten real receipts of varied quality. Record how often each field parses correctly — that number is the parser's spec for any future work. |
| **5** | Offline outbox | Airplane mode, capture three receipts, restore connectivity, confirm all three arrive with correct images. |
| **6** | Distribution (iOS) | See §11. |
| **7** | Web client: sign-in, table, detail, export | Run a real export end to end from a browser: download the zip, open the XLSX, click three rows through to their images. ⚠ **This wave must land before the first year-end use**, since export lives here — scheduled work, not "someday." |

**Order rationale.** Waves 0–2 are backend and are the part Claude Code can build *and verify* end to end. They come first so that by the time the Swift work starts, the rules are already proven and the client is only a client.

---

## 10 · Working with Claude Code

### 10.1 What goes in `CLAUDE.md`

- The success test from §1 and the four constraints from §3, verbatim. These are the things most likely to be quietly eroded across many small sessions.
- The rule that `user_id` comes from the token, never from a request parameter.
- Money is integer cents; never floats.
- Category is free text; never introduce an enum, taxonomy, or CRA mapping.
- No secrets in the repo. R2 keys, Apple credentials, and database URLs live in `.env.local`, which is gitignored, and the owner handles them.
- Never weaken or delete a failing test to make a suite pass. A failing test is a finding — report it.

### 10.2 The verification asymmetry — the thing to plan around

**Claude Code can build and verify the backend completely.** It runs Postgres in Docker, runs the migrations, runs the tests, opens the generated XLSX and checks the cells. That half is genuinely verifiable by the agent.

**The iOS half is not symmetric.** `xcodebuild` and `xcrun simctl` let it compile the project and run XCTest on a simulator — real and useful. But:

- **The simulator has no camera.** VisionKit's document scanner and the Vision OCR path cannot be exercised there at all. Wave 4 is *only* verifiable on a physical device, by hand.
- **Signing, provisioning, and submission are the owner's.** Certificates and the Apple account do not go to an agent.

**Consequence for the plan:** architect the client so the untestable surface is as thin as possible. Parsing heuristics (§7.3) go in a **pure Swift module with no VisionKit or UIKit imports**, taking an array of recognized text lines and returning a suggestion struct. That module is unit-testable on the simulator against fixture text captured from real receipts. Then the part that genuinely requires a device is only the camera plumbing, which is small and rarely changes.

### 10.3 Applying the agentic-SDLC framework — the thin slice, not the pipeline

`Agentic-SDLC-Framework.md` §9 covers this in full. The short version:

**Apply:** `builder` + `reviewer` subagents only, reviewer **read-only** — the minimal shape, and the one the multi-agent literature reinforces rather than contradicts. The **reviewer rubric must explicitly hunt duplication and error-masking** (catch blocks that swallow signal); without it the loop manufactures debt faster than it clears it. Verify artifacts, not reports. Predict before verifying. Keep a **correction catalog** — classify each correction you make to agent output by category; the PR diff is the log, so this costs nothing extra.

**Do not apply:** `architect` and `tester` subagents (trigger-gated — build one only when a recurring correction category is clearly attributable to its absence), the nine-stage contracted pipeline, or any promotion of a rule into global `~/.claude/`. **Building the framework and this product simultaneously is the momentum failure the framework's own gates exist to prevent.**

**Before any unattended run:** read the safety substrate — container isolation, secret handling, supply-chain gate. The surface is synthetic now; the permission boundaries set now are the ones in force when real receipts are in it.

### 10.4 Session hygiene

- One wave per session where possible. Commit at wave boundaries.
- At each gate, **predict before verifying** — write down what the artifact should look like, then look at it. The gap between prediction and reality is the part worth reading.
- Generating code is cheap; evaluating correctness is the bottleneck. Budget the session accordingly.

---

## 10A · What the UI currently is — and what it is not

**What this spec contains:** information architecture. Which screens exist, which fields appear, in what order, which are required, and one behavioural rule that matters more than any visual choice — **prefilled fields are visually marked as suggestions until touched** (§7.2). That marking is how constraint 2 becomes real to a user rather than merely true in the schema.

**What this spec contains nothing of:** visual design. No colour, type, spacing, iconography, motion, empty states, or error states. That is a deliberate gap, not an oversight — but it is a gap, and it should close **before wave 4, not after.** *(Wave-3 kickoff: closed for the confirm screen — see §10A.1. The remaining screens inherit from it and stay undesigned until they exist.)*

**Why before wave 4.** The confirm screen *is* the product. Everything else is plumbing around it. A confirm screen that is slow to scan, or where the total is not instantly findable, fails the success test no matter how correct the backend is. Designing it after it is built means redesigning it.

**Scope when it happens:** one screen designed properly (confirm), and the rest inheriting from it. This is a five-screen app for three people — a design system would be ceremony.

### 10A.1 · The confirm screen design - settled Aug 5, before wave 4 *(wave-3 kickoff)*

These decisions close §10A's "visual design is an open gap" for the confirm screen. They are recorded now, ahead of the wave that builds them, so the screen is designed before it exists rather than after.

- **Unchecked fields carry an amber tint; confirmed fields are plain.** The screen starts loud and goes quiet as the user works down it. A receipt with amber left on it is visibly unfinished; a confirmed one looks calm. The inverse - marking confirmed fields - was rejected because it makes a finished screen noisy and an unfinished one look fine.
- **Touching a field clears its tint permanently**, and a header counter tracks how many remain unchecked.
- **Total is a card, not a row** - largest type on screen, so the eye lands there first every time. It is the field most likely to matter and least likely to be checked carefully.
- **The arithmetic warning sits inside the total card, in the same amber**, not in red. Plenty of legitimate receipts do not reconcile; a red error trains people to dismiss it.
- **Save is disabled until business or personal is chosen**, with the reason stated below the button rather than left to be inferred. This is the one place a disabled control is correct, because it is what enforces `is_business` having no default (§5.2).
- **Absent values state their absence** - a missing tax number reads "Not found", not an empty field. A blank looks like a bug; a stated absence looks like a fact.
- **No success modal after saving.** Return straight to Home. A confirmation step on a five-second task is friction pretending to be care.

## 10B · Security, production readiness, and the rest of the lifecycle

**Not all at once, and not now — but slotted, so none of it becomes "eventually."**

### Already in v1 by design, not bolted on later
- `user_id` derived from the session token, never a request parameter (§6).
- **Isolation proven by test, not by inspection** — wave 1's gate requires a test asserting user A gets a 404 for user B's receipt.
- Presigned URLs for image transfer; images never transit the API server.
- Secrets in `.env.local`, gitignored, handled by the owner (§10.1).
- ⚠ **Unlisted distribution is not private** (§11) — anyone with the link installs the app. In-app authentication is the *only* thing protecting the data, which is why the isolation test is a security gate rather than a nicety.

### Security review — two passes, at natural points
**Pass 1, after wave 1** (the API exists, nothing has shipped). Scope: authorization on every route · JWT validation including Apple public-key rotation · presigned URL scoping and expiry · object keys unguessable rather than sequential · rate limiting on the auth and upload-URL endpoints · no PII or tokens in logs · dependency audit.

**Pass 2, before wave 6** (before anything reaches the second user). Scope: iOS keychain handling of the session token · certificate and provisioning hygiene · what the app logs and where · App Store privacy label accuracy.

### Bug review — after wave 5
Once capture, storage, and the outbox work end to end, run a deliberate bug pass before distribution. Adversarial parser inputs (blank receipt · crumpled · foreign currency · a photo that is not a receipt), outbox failure modes (app killed mid-upload · storage full · token expired mid-queue), and money edge cases (zero total · refund/negative · very large amounts).

### DevOps — deliberately minimal at this scale
**Build:** GitHub Actions running the backend suite on push. That is the whole CI story.
**Backups:** managed Postgres with point-in-time recovery. **Verify a restore once** — an untested backup is an assumption, not a backup.
**Errors:** an error monitor after first real use, not before. Three users produce no signal until they produce a bug.
**Explicitly deferred:** staging environment, infrastructure-as-code, observability stack, feature flags. At three users these are ceremony, and pretending otherwise is how a project that should ship instead stalls.

### The one piece that is not deferrable
**Retention.** CRA requires six years, and these are the supporting documents for tax filings. Deletes are soft, backups are real, and a restore has been tested. Everything else here can wait; losing a year of tax records cannot be undone.

**What retention covers — and what it does not** *(wave-2 gate review)*. The **receipts and images are the retained records**. **Export zips are artifacts**: regenerable at any time from the same data, so they are explicitly *not* records. The R2 bucket carries a **30-day lifecycle expiry on the exports prefix** (`{userId}/exports/...`; a deployment-time bucket rule — receipt images are under no lifecycle rule whatsoever). The job row keeps its period parameters, and a job past the window reports as `expired` — re-runnable, not downloadable.

## 11 · Deferred to v2 — recorded so they are not re-litigated

- **Automated email ingestion.** A **dedicated forwarding address**: forward the receipt email, a parser pulls the attachment or renders the body. Not mailbox OAuth polling — forwarding avoids inbox-read scopes, and works identically across whatever mail providers the family uses. v1's answer is manual file upload of a PDF or image, which reuses the confirm screen unchanged.
- **Dashboard** — per-user, not a family view. Spend and totals over time.
- **Category taxonomy** — CRA T2125 lines or T2 GIFI codes, depending on the sole-proprietor-vs-incorporated answer.
- **Near-duplicate detection** — warn when a new receipt matches an existing one on date, vendor, and total. This is the real answer to a re-scanned paper receipt, which hashing cannot catch (§5).
- **Multi-page receipts** — VisionKit supports it; v1 takes page one.
- **Second user's account** — the model already supports it; nothing to build.

### Distribution checklist (wave 6)

1. Apple Developer Program enrolment — $99 USD/yr.
2. TestFlight for the owner's own iteration.
3. Submit to App Review as though public, with a note in Review Notes stating unlisted intent.
4. File the unlisted app request — **must be submitted by the Account Holder**.
5. Share the resulting link with the second user.

⚠ **The unlisted conversion is permanent for that app record.** If a consumer version is ever wanted, it needs its own app record from the start.
⚠ **Unlisted is not private** — anyone with the link can install. In-app authentication is what actually protects the data, which is why §6's isolation test is a security gate and not a nicety.

---

## 12 · Open items — none block the build

- **Sole proprietorship vs. incorporated** — determines the eventual category taxonomy. Not needed for v1.
- **Accountant questions** — preferred format/software · her category list · who produces originals in an audit · fiscal year end. All useful, none gating.
- **CRA documentation thresholds** (~$30 / ~$150) — confirm with the accountant.
- **HST filing frequency — assumed ANNUAL** (the owner, Aug 5), which is the normal reporting period for a business of this size. ⚠ It matters less than it first appeared: **the export takes a date range**, so quarterly filing would be a UI affordance on the period picker, not an architecture change. If the assumption is wrong, the cost is one dropdown.
- **Multi-page receipts and foreign-currency purchases** — **explicitly non-blocking.** The `receipt_images` table (§5) already makes multi-page a feature addition rather than a migration, and `currency` plus `other_tax_cents` already carry a US receipt with no HST line. Answer whenever convenient.
- **Retention** — CRA requires six years. The schema and storage plan already assume it; no deletion policy is built in v1.

---

## Update log

- **August 6, 2026 (wave-5 airplane-mode run)** - The offline test surfaced a store defect (diagnosed from the pulled device evidence before any code change, per the owner): `URL.path()` percent-encodes by default, so under "Application Support" both of FileOutboxStore's `fileExists` checks named nonexistent paths - remove never removed (three uploaded receipts left three directories) and loadAll misfiled every healthy queued item as "could not be read" at relaunch, which also silently disabled the 409 self-heal built for exactly those items. Fixed with `path(percentEncoded: false)` at all call sites, and the store test suite now runs in a temp directory with a deliberate space - reverting the fix fails all 8 store tests (verified both ways). The general lesson - test environments matching production in load-bearing dimensions, now with three instances across waves 3-5 - is recorded as framework §9.3 candidate rule 5. Note: the run also proved the airplane test itself hadn't executed offline (Wi-Fi stays available under airplane mode; the created row was the tell) - it re-runs with Wi-Fi explicitly off. Suites: iOS 169, server 150, zero warnings.
- **August 6, 2026 (wave-5 device re-test)** - The Food Court receipt failed again with a third wrong HST value (17.84 - the total), which proved the owner's diagnosis: not rule ordering but **row assembly** - and, per his instruction, the fix waited for evidence. The receipt was queued via "Later" (the outbox's first real device run, end to end clean), its exact uploaded bytes pulled from storage, and `vision-dump` run over them: the amount column measured a coherent ~0.013 above its labels against a ~0.022 row pitch, so every tax-block amount's nearest label was genuinely the wrong one - no proximity threshold could pair it. §7.3's assembler now **de-skews the amount column** (median of nearest-neighbour deltas, applied to grouping only) before band-merging; the real dump is the new fixture asserting HST 2.05, the Noodle House fixture (opposite skew sign, milder) still passes, and the total heuristic was re-checked for the reverse mispairing (it survived even broken assembly via largest-across-lines plus the receipt's redundant contiguous TOTAL line; residuals recorded in DECISIONS.md). Suites: iOS 169, server 150, zero warnings.
- **August 6, 2026 (wave-5 device step 1)** - First device receipt through the ratified flow found a §7.3 defect, fixed same-day: the HST heuristic lumped `HST|GST|TAX` into one first-match pattern, so a tax block printing "GST: $0.00" above "HST: $2.05" suggested the zero into the HST field - the input tax credit, where a wrong-but-plausible 0.00 out-dangers an absence. §7.3's HST bullet now carries the ranked rule (non-zero HST > non-zero GST > non-zero TAX > their zeros, in the same order), and the accompanying audit of every several-candidates heuristic moved subtotal to the bottom-most match and recorded the others as deliberate. Fixture honesty: the scan was never queued, so no real Vision geometry exists yet - the fix ships with labelled rule tests and the real-dump fixture is owed from the re-test, via the newly committed `ios/Tools/vision-dump.swift`. Suites: iOS 168, server 150, zero warnings.
- **August 6, 2026 (wave-5 gate ratification)** - Two rulings from the owner on the wave-5 flags. **(1) Ratified:** §7.4's worker is app-lifecycle-driven with no OS background execution (no `BGTaskScheduler`; latency nobody perceives), keychain stays `WhenUnlocked`. **(2) Rejected:** capture returning to Home without the confirm screen - the kickoff's "return to Home immediately" meant *don't block on the network*, not *don't show the screen*. **A single capture goes scan → confirm again**, but the screen is now **local-backed**: prefilled from the on-device parse, showing the scanned bytes (no server row exists yet), and its **Save is a durable outbox write** that lands the receipt already `confirmed` when the drain uploads it - it never joins the pending queue, and nothing on the capture path touches the network. "Later" queues it pending. **Batch mode keeps the wave-5 shape** (queue pending immediately, confirm via the queue afterwards). One confirm screen serves all three routes - capture-time, queue, detail - via an injected save action (PATCH or outbox write). Decision detail and the superseded parts of the wave-4 "batch of one" ruling in `DECISIONS.md`; suites after the change: server 150, iOS 162, zero warnings.
- **August 6, 2026 (wave 5)** - Offline outbox built (§7.4): on save, each scanned page is written durably to a per-item on-disk queue and the app returns straight to Home; a foreground-driven drain then runs OCR, the presigned upload, and the create, with backoff retry, per-item stuck states with manual retry/discard on Home, and item ownership pinned to the capturing user's id (read from the session token's `sub`) so an account switch can never route one person's receipt into another's account. **Two things flagged for gate ratification:** (1) §7.4's "background task" is implemented as an app-lifecycle worker (foreground triggers plus the ~30s post-backgrounding grant, no OS background execution) - which is what lets the wave-3 keychain posture (`WhenUnlocked`) stand, answering the wave-5 kickoff §4 question with "foregrounding suffices"; (2) capture no longer auto-opens the confirm queue - §7.4's "return to Home immediately" replaces wave 4's scan→confirm transition, and confirmation now rides the pending badge or the receipt's detail screen once the upload lands. **`SWIFT_STRICT_CONCURRENCY = complete` is on** (Swift 5 mode; the recurring interleave-defect class now diagnosed by the compiler, with the zero-warnings discipline making diagnostics blocking). The read-only reviewer pass returned 20 findings - the worst four all in the drain's concurrency and error routing, the same class as waves 3-4 - fixed before the gate; `docs/gates/wave-5.md` carries the catalog. Suites: server 150, iOS 156, zero warnings. Wave 6 not started; **the §10B consolidated security review (pass 1, never run, merged with pass 2) is the next thing before wave 6.**
- **August 6, 2026 (wave-4 gate review, second pass)** - Re-test confirmed the four first-pass fixes (row pairing, borders, centring, arithmetic warning) and returned two findings, both fixed. **(1) Vendor regressed to the street address.** Diagnosed against the artifact rather than assumed: Vision's real geometry (dumped from the stored image on the Mac) shows the row assembler left both header lines untouched - the actual cause is per-scan height jitter on same-size thermal print, where "largest single box" is a coin flip; the address measured 5% taller on the second photo. §7.3's vendor rule is now topmost-within-15%-of-tallest. The same dump surfaced a third latent defect fixed alongside: Vision split "Total" into "Tot al", which no word-boundary match can see - labels now also match despaced, letter-fenced. The hand-invented fixture that had passed while the device regressed is replaced by Vision's real measurements verbatim, asserting every field. Geometry audit per the owner: vendor was the only height-dependent heuristic; the date and total-fallback rules read vertical position, which band-merging shifts by less than half a line height. **(2) A pending receipt's detail screen was a dead end** - it showed the badge with no way to act. It now carries a "Confirm this receipt" button opening the same confirm form; the header-badge queue remains the batch route.

- **August 6, 2026 (wave-4 gate review)** - Device run passed on one real receipt (capture → OCR → confirm → save end to end, image served from MinIO via the Mac's `.local` name); the owner waived the staged ten-receipt session - **the accuracy table accrues through real use of `parse-accuracy`** - and returned four findings, all fixed same-day. **(1) Spec violation, caught by the owner:** the queue's "Queue clear" screen after a single capture was a success modal, which §10A.1 forbids; a single confirm now returns straight to Home, and an end-of-sitting summary appears only when more than one receipt was handled or something was set aside. **(2-4)** Capture button label centred (a `Label` in a `List` renders left-shifted; now an explicit HStack), the business/personal buttons' rounded strokes no longer clipped at the row edges (zero row insets put them at the clip bounds), and - the substantive one - **§7.3 gains row assembly**: label/amount pairs printed across a wide gap are merged by bounding-box band before any heuristic runs, with the real receipt's recognized text as a fixture (subtotal and HST parse where they previously could not, and the total comes from its labelled row rather than the lower-third fallback). Assembly validated against one sample; flagged for re-checking as the table fills.

- **August 6, 2026 (wave 4)** - Capture built: VisionKit scan (single and batch), on-device Vision OCR, the §7.3 heuristics in a pure Swift `Parsing/` module tested against fixtures, the §7.2/§10A.1 confirm screen with its state in a camera-free model, presigned upload → create, and the confirm queue on iOS. **Two spec amendments under the doc-ownership rule, both flagged for gate review. (1) `total_cents` and `is_business` are nullable while `pending`** (§5): §6A's batch mode creates a pending receipt per scanned page, and a page whose total the parser cannot read - or whose business choice no human has made - cannot honestly satisfy a NOT NULL column; a `receipts_confirmed_complete_ck` CHECK constraint plus route validation guarantee every confirmed row carries both, `is_business` still has no default at any layer, and pending rows still never export, so constraints 2 and 3 hold through `status` exactly as §5.2a designed. The client-side alternative (local drafts, create-at-confirm) was rejected: it loses a sixty-receipt backlog scan to an app kill and contradicts §6A's "each becomes its own pending receipt". **(2) `ocr_suggestions` jsonb added** (§5): the parser's suggestions recorded verbatim at create, immutable thereafter; `npm run parse-accuracy` compares them with what the human confirmed and prints the per-field number §7.3 demands - confirming receipts is the recording. Also: when no date parses, the client sends the capture day as the date suggestion (amber on the confirm screen, corrected in the queue) rather than making `purchased_at` nullable, which would poison the keyset sort; wave 7's PDF upload needs its own answer, flagged in the gate report. **Wave-4 kickoff correction applied:** integration tests run against `kept_test` via `TEST_DATABASE_URL`, refuse to aim at the dev database (proven by test), and `npm test` no longer destroys the signed-in device user.

- **August 5, 2026 (wave-3 gate review)** - Device verification **passed, all eight steps, no deviations** (real Sign in with Apple end to end, list paging over 65 receipts, revocation via `token_version`, session across cold launch); the wave-3 gate is closed. Five changes accepted from the owner's review. **(1)** `GET /api/receipts` carries `pendingCount` (user-wide, filter-independent), replacing the iOS 200-row probe - §5.2a's badge now reads one server-counted number. **(2)** **MinIO added to docker-compose behind the real S3-compatible adapter** (§4.2): one adapter for local MinIO and deployed R2, auto-created bucket on the dev default, and the presigned path proven by integration tests - including a fix the tests forced, signing the content type into presigned PUTs so the upload-url schema's type restriction is enforced rather than decorative. **(3)** The device-test SQL became `npm run db:claim` (refuses when the real user is missing or ambiguous). **(4)** iOS `ReceiptListModel` now reaches the API only through `GuardedReceiptLoader`, whose result type carries `.superseded` - the stale-response guard moved from convention to construction. **(5)** `npm run dev` loads `.env.local` via `node --env-file` (creating the file if absent) - found when the server died mid-device-run: 110 green tests while the real entry point was unrunnable, which also produced **framework guardrail 7** (every gate starts the real server the real way and lands one request; mirrored in `CLAUDE.md`). Also settled: §7.1's "recent receipts" means ordering, not a cutoff.
- **August 5, 2026 (wave-3 kickoff)** - **Confirm-screen visual design settled and recorded as §10A.1**, closing §10A's open gap for that one screen ahead of wave 4: amber tint on unchecked fields that clears permanently on touch (with a header counter), the total as the largest-type card rather than a row, the arithmetic warning inside the total card in amber rather than red, save disabled until business/personal is chosen with the reason stated below the button, absent values stated ("Not found") rather than blank, and no success modal - save returns straight to Home. Externally confirmed: **Apple Developer Program membership active** (team `<team-id>`) and the **bundle identifier is `com.arthurzhang.kept`**, permanent as the App Store record; the App ID is created by Xcode through automatic signing, not manually in the portal.
- **August 5, 2026 (wave-2 gate review, second pass)** — Two revisions to the first pass. **(1) `stale` extended to `running` jobs older than 30 minutes** — a crash mid-run strands a poller identically to a crash before the claim, so the first ruling was too narrow; both stale clocks run from `created_at` (the claim follows creation within milliseconds, so it is an honest proxy for run start), and 30 minutes sits far above anything the size budget permits. **(2) The `maxReceipts` limit removed; the byte budget stands alone** — row count is a worse-measured proxy for the same memory bound (ten thousand small receipts and two thousand large ones are the same problem, and only bytes see that), and it could refuse an export that would have fit, the wrong failure for the one artifact the accountant needs.
- **August 5, 2026 (wave-2 gate review)** — Five changes accepted from the owner's review, all backend, applied before any wave-3 work. **(1)** §8 now states why `whose` exists: accountant-side merging — constant within a file by design, which is what makes a combined workbook unambiguous. **(2)** **Export zips reclassified as artifacts, not records** (§10B): receipts and images are the retained records, a zip is regenerable, the exports storage prefix carries a 30-day lifecycle expiry (bucket rule at deployment; images under no lifecycle rule), and a job past the window reports `expired` with its period intact — re-runnable, not downloadable. **(3)** `GET /api/export` (own jobs, newest first) added now, while the export code is loaded, rather than in wave 7. **(4)** Generation **refuses oversized exports** (row-count and byte budgets, default 10 000 receipts / 256 MiB) with an actionable failure instead of an OOM crash; streaming deliberately not built. **(5)** A job stranded in `queued` past five minutes reports a **computed `stale` status** — no sweeper, no new table, the client just stops polling and re-runs. Both computed statuses (`expired`, `stale`) are never written back; the row remains the truthful history.
- **August 5, 2026 (wave 2)** — Export generation built and gated on the real artifact. **`export_jobs` table added to §5** (the job-store gap flagged at wave 1): queued → running → complete/failed, every outcome written to the row, restart-safe by construction, with a queued→running claim guard so a double invocation is a no-op rather than a double generation. **§6's export body settled** as `{fiscalYearEndingIn}` (server derives dates from the user's settings at request time) or explicit `{periodStart, periodEnd}`. Zip contents per §8: XLSX (numeric money cells, `0.00` format, derived from integer cents — never a cents÷100 float), CSV (decimal-string money, RFC 4180 quoting), and every image under calendar-based `images/yyyy/mm/` at exactly the path the `image_filename` column names. **Label rule recorded:** calendar-year periods label as the year, anything else as the explicit range. Gate closed by generating a real zip from synthetic data and inspecting it with independent tools: `unzip`, cell-level XLSX reads (headers, order, formats, negative refund amounts), and click-through checks from every `image_filename` cell to its file. Failure paths verified too: a missing image fails the job loudly with the reason recorded on the row.
- **August 5, 2026 (wave-1 gate review)** — Four changes accepted from the owner's review of the wave-1 gate report. **(1)** The create handler's spread of the parsed body reverted to an explicit field map (and the PATCH handler matched, for one pattern): the spread traded a visible failure for an invisible one, and §10's rule is explicit beats concise. **(2)** `noUncheckedIndexedAccess` enabled; every index access hardened while the codebase is small. **(3)** `GET /api/receipts` is paged — keyset cursor on `(purchased_at, created_at, id)` descending with a limit (default 50, max 200); "fine at three users" missed that the §6A backlog import makes lists large on day one. **(4)** `users.token_version` added, carried as the JWT `tv` claim and compared on every request, so bumping the column revokes all of a user's sessions — closing the no-revocation gap flagged in the wave-1 report.
- **August 5, 2026 (wave 1)** — Backend built: domain layer (money as branded integer cents, arithmetic check, export filename derivation, fiscal-period resolution), Sign in with Apple verification against Apple's JWKS with injected fakes for tests (no bypass reachable from configuration), all §6 routes on Hono, and 90 Vitest tests including the isolation gate (user A requesting user B's receipt by real id gets 404 on get/patch/delete, list never crosses users). **Three spec amendments made under the wave-1 doc-ownership rule:** (1) `users.display_name` nullable — Apple provides a name only on first authorization and may provide none; same reasoning as `vendor`. (2) `receipt_images.deleted_at` added and the `(user_id, sha256)` unique made **partial (`WHERE deleted_at IS NULL`)** — as previously written, deleting a receipt and re-capturing the same file produced a permanent, unexplainable 409; soft-deleting now stamps image rows in the same transaction and frees the slot while keeping the rows for retention. (3) The list endpoint gained a `status` filter — §6A's confirm queue ("next unconfirmed receipt") needs it on both clients. **Recorded gaps for wave 2:** §6 defines export as job id + polling but §5 has no job store — wave 2 must choose (likely an `export_jobs` table, since a restart losing job state during a year-end export is the wrong failure); export routes answer 501 until then. Sign-in never updates `email` after user creation (relay addresses churn; the value is informational). List endpoint is unpaginated — acceptable at three users, revisit if it ever isn't. — Five schema corrections from Claude Code's wave-0 report, all accepted. **(1) `deleted_at` added** — §6 specified a soft delete and §10B made it a retention requirement, but the schema had no column for it; wave 1 could not have implemented its own API surface. A real spec bug. **(2) The duplicate-photo constraint was rewritten and the claim around it corrected** — unique `(receipt_id, sha256)` only prevents the same image twice on one receipt, which is nobody's failure mode; it is now unique `(user_id, sha256)` with `user_id` denormalized onto `receipt_images`, because a constraint that needs a join is not a constraint. **The stronger correction is honesty about scope:** hashing catches re-uploaded identical *files* (real on the email-backlog path) and can never catch a re-scanned piece of *paper*, since two photographs of one receipt share no pixels. Near-duplicate detection on date+vendor+total is now explicitly v2, so the hash constraint stops standing in for it. **(3) `status` gains `DEFAULT 'pending'`** — unlike `is_business`, this is a system state rather than a hidden human choice, and defaulting it is fail-closed. **(4) `updated_at` moves to a Postgres trigger**, not handler code. **(5) `vendor` becomes nullable** — an illegible vendor is a real outcome and a forced placeholder corrupts the field. Also aligned the repo layout with the kickoff's `docs/` directory.
- **August 5, 2026 (backlog pass)** — **The backlog was confirmed as real for both users and pulled into v1** (§6A): a tool that cannot absorb the existing pile starts behind, and the pile is what motivated the project. Three changes follow — **batch scanning** on iOS via VisionKit's multi-page session, **multi-file upload on the web client** (a deliberate narrowing of the earlier "web does not capture" rule: no camera on web, but a folder of emailed PDFs belongs on a laptop, not forwarded to a phone one at a time), and a **confirm queue** on both clients. **New `status` field (`pending` | `confirmed`)** reconciles a fast backlog pass with constraint 2 without weakening it: unconfirmed receipts are stored and visible but **excluded from every export**, so the confirm step is deferred rather than skipped. **Images moved to their own `receipt_images` table** — one join now, and multi-page becomes a feature addition instead of a migration, which is what makes the unresolved multi-page question genuinely non-blocking. **HST filing recorded as assumed annual**, with the note that quarterly would cost one dropdown since exports already take a date range. Flagged that wave 7 may deserve promotion ahead of iOS distribution, since the backlog is a today problem.
- **August 5, 2026 (lifecycle pass)** — Added **§10A** (the UI is information architecture only; visual design is an open gap that must close **before wave 4**, since the confirm screen is the product and designing it after building it means redesigning it), **§10B** (security review in two passes — after wave 1 and before wave 6 — a bug review after wave 5, minimal CI, a *tested* backup restore, and an explicit list of deferred DevOps ceremony), and **§10.3** (the thin agentic-SDLC slice: builder+reviewer only, duplication/error-masking rubric, correction catalog, safety substrate before unattended runs — and explicitly *not* the nine-stage pipeline). Named retention as the one non-deferrable item: six-year CRA requirement, so soft deletes, real backups, and a verified restore.
- **August 5, 2026 (web client + name)** — **Named Kept.** **Added a web client** as a first-class second view: review, search, bulk correction, and — moved here from iOS — **the year-end export**, because a multi-gigabyte zip destined for an accountant does not belong on a phone. That drops the iOS app from six screens to five. Stack is a **Vite + React static SPA** against the same Hono API; Next.js was re-examined in light of the new UI and still rejected, as were Electron and a native macOS target. **New wave 7** carries the web client, with the note that it must land before the first year-end since export now lives there. **Flagged as real setup work:** Sign in with Apple on the web needs its own Services ID, a verified domain, and a return URL.
- **August 5, 2026 (stack audit)** — the owner asked for the architecture to be re-derived on merits alone, with no carry-over from prior projects. **Four changes:** backend moved **Next.js → Hono** (no web UI in v1, so an SSR React framework serving JSON was unjustified weight — and a pure API keeps a future Android client cheap); **Playwright dropped** from the test stack (no browser in this project; Vitest covers HTTP-level tests in-process); ExcelJS and Postgres/Drizzle were **re-justified on their own merits** rather than on familiarity, and both survived the audit; and a new **§4.3 records every rejected alternative** — Next.js, Fastify, Vapor, Go, SQLite/Turso, Prisma, cloud OCR — so the reasoning is auditable rather than implicit. Also added the **cloud expense-parser upgrade path** to §7.3, with the offline argument for why it is not v1 and the wave-4 measurement that would trigger it.
- **August 5, 2026** — Spec written. Consolidates the decisions from the August 3 scoping session and the August 5 design session: native iOS with unlisted App Store distribution, full per-user isolation with no household entity, category demoted to free text, in-app camera capture pulled into v1, email ingestion deferred to v2 as a forwarding address, fiscal year end reclassified as config, and backend-owned domain logic so a later Android or web client is additive. Written for implementation by Claude Code, with §10 covering the backend/iOS verification asymmetry.
