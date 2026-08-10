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
| Deployment *(decided Aug 6, 2026)* | **Node on Fly.io** for the origin, with **Cloudflare proxying in front of it**; **R2** (images) + **Neon** (Postgres) | Cloudflare in front supplies the two things that motivated the platform choice - **an edge rate limiter** (§10B's one outstanding requirement, which the security review deliberately did not build because a limiter's shape depends on what identifies a client) **and DDoS protection** - without the origin having to be a Worker. A Node origin keeps `@hono/node-server`, `pg`, `archiver` and `exceljs` exactly as they are, and needs no export rewrite. R2 stays the image store; Neon stays the database. |
| Server parse *(added Aug 7, 2026)* | **Claude Haiku 4.5** via `@anthropic-ai/sdk`, server-side, **text only** | Structured extraction over the stored `ocr_raw_text` - roughly 30 lines of text per receipt, measured at about a tenth of a cent each ($0.0069 for the first 6-receipt run). The image never leaves the phone; on-device Vision stays the only OCR. §7.3 carries the merge rule and the evidence. |

⚠ **This reverses a same-day decision, and the reversal is the more useful record.**
The first ruling was **Cloudflare Workers** for the API, on the reasoning that Hono was chosen partly for Workers portability (§4.2 backend row) so the bet should be cashed.
Writing it into this file surfaced the disqualifying fact: **a Workers isolate is capped at 128 MB on both the free and paid plans**, and that cap is *per isolate*, shared across the concurrent requests it handles, not per request.
The export path assembles its zip in memory against a **256 MiB** budget, so the budget alone was double the ceiling before accounting for the images existing roughly twice during assembly.
**the owner's reversal, in his words: forcing a memory-heavy export onto a 128 MB isolate was buying portability we do not need at three users.**
Cloudflare-in-front keeps the edge benefits; only the origin's runtime changed.
The Workers option is not dead - it becomes available if the export ever streams to R2 rather than buffering (the seam is `buildZip`, deliberately one function) - but nothing needs it today.

⚠ **The export budget under a Node origin - measured, not estimated (Aug 6, 2026).**
An export of **25 images totalling 250 MiB**, just under the configured budget, was generated against a storage double that produces incompressible bytes on demand and discards uploads, the way R2 behaves.
**Peak RSS 891 MiB, of which 693 MiB was growth over baseline - roughly 2.8x the payload.**
The multiplier is structural rather than surprising: `buildZip` accumulates the archive's output chunks and then `Buffer.concat`s them, so a fully-assembled incompressible zip exists twice, alongside the image buffer in flight.
**So the budget is sound but not free: it sizes the machine.**
A 256 MiB export needs roughly **1 GB for a single export with little margin**, and the ratified provision is **`shared-cpu-1x` at 2 GB** - Fly's ceiling is 2 GB per shared CPU (minimum 256 MB per shared CPU, set via `[[vm]] memory` or `fly scale memory`).

⚠ **"Cloudflare in front" is only true if the origin refuses to be reached around it** *(Aug 7, 2026)*.
Fly gives every app a public `*.fly.dev` hostname, so an edge rate limiter on its own guards one door of a two-door building - the same decorative-control shape as the wave-3 presigned content type.
The origin therefore serves only requests carrying `EDGE_SHARED_SECRET` in an `x-kept-edge-secret` header, which a Cloudflare Transform Rule adds; the check is constant-time and sits ahead of every route.
It is **optional, not required**, because the origin has to answer before Cloudflare can be pointed at it - so a first deploy works without it and configuring it is a checklist step (`docs/gates/wave-6.md` §3) rather than a footnote.

**Concurrent exports would multiply that, so they are refused rather than allowed** *(Aug 7, 2026)*.
**One live export per user**, enforced by a partial unique index on `export_jobs (user_id) WHERE status IN ('queued','running')` - not by a check in the handler, which cannot be made race-free: generation runs after the 202 response, so no transaction spans it, and Postgres takes no lock on rows that do not exist yet, meaning two taps of Export would land two rows and two concurrent generations.
A second request is **refused with 409 `export_already_running`, deliberately not queued**: a queue needs a worker, a fairness rule and a way to cancel, while refusing needs a sentence and the client already polls the running job.
⚠ **The index has a companion that is not optional.** A job whose process dies leaves its row `running` forever, and the index reads stored status, so on its own it would turn one crash into a permanent, silent lockout of that user's exports. `POST /api/export` retires jobs past the staleness windows §8 already defines before inserting - the same two clocks `reportedStatus` reports with, from the same constants. Neither half is safe alone, and both are tested, including the lockout.

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
  *(Resolved Aug 7-8, 2026: the upgrade landed as a text-only LLM parse over the stored OCR text, so these products stayed rejected at upgrade time too - they parse the image server-side, and the image never leaves the phone.)*

### 4.4 Repo layout

*(Corrected Aug 8, 2026 against the actual tree - the sketch had drifted since wave 1.)*

```
kept/
  CLAUDE.md                     ← agent instructions, see §10
  .githooks/                    ← gitleaks pre-commit hook (Runbook §0)
  docs/
    Kept-Build-Spec.md          ← this file
    Agentic-SDLC-Framework.md   ← reference
    DECISIONS.md                ← append-only decision log, newest-first
    Runbook.md                  ← deploy, migrate, roll back, restore
    gates/                      ← per-wave gate reports
    security/                   ← §10B review and audit records
  web/                          ← Vite + React SPA (review, search, export); empty until wave 7
  server/
    Dockerfile                  ← production image (§4.2 deployment row)
    fly.toml                    ← Fly.io machine config (shared-cpu-1x, 2 GB)
    docker-compose.yml          ← Postgres 16 + MinIO for local dev
    drizzle/                    ← migrations
    src/auth/                   ← Sign in with Apple verification, session JWTs
    src/db/                     ← schema, seed, operational scripts (backfill, accuracy, restore-verify)
    src/domain/                 ← pure TS: validation, arithmetic checks, filename rules, LLM prompt + schema
    src/export/                 ← XLSX + zip generation
    src/http/                   ← request schemas, validation, session middleware, error envelope
    src/observability/          ← error redaction, stale-listener diagnosis
    src/parse/                  ← the server-side LLM parse (§7.3)
    src/routes/                 ← Hono route handlers
    src/storage/                ← object storage client + the key shapes (§10B)
    tests/unit/
    tests/integration/          ← against real Postgres
    tests/e2e/
    tests/helpers/              ← fakes + test app/database setup
  ios/
    Kept.xcodeproj
    Kept/                       ← SwiftUI app
    KeptTests/                  ← XCTest
    Tools/                      ← vision-dump.swift, the committed OCR diagnostic
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
| `llm_suggestions` | jsonb nullable | *(Aug 7, 2026, migration `0004_llm-suggestions`)* What the server-side LLM parse suggested from `ocr_raw_text` (§7.3), verbatim and **immutable** beside `ocr_suggestions`: written once, updated by no route, and every writer goes through one sweep core (`src/parse/llmParseSweep.ts` - the server's own sweep since Aug 8, plus `npm run parse-llm-backfill` as its manual wrapper) that only fills nulls: the UPDATE re-checks `WHERE llm_suggestions IS NULL`, so under concurrent writers exactly one record lands and the loser counts the row superseded rather than overwriting. A row whose parse fails 3 times gets an **explicit failure record** (model, promptVersion, requestedAt of the final attempt, the error, the attempt count, and `suggestions: null`) so the null-guard stops re-selecting - and re-billing - it and the failure is visible in the data; `parse-accuracy` scores it as "the LLM produced nothing", distinct from a receipt the LLM was never run on, and re-parsing an abandoned row means clearing the column deliberately. The record carries the exact `model`, `requestedAt`, the suggestions, and a `promptVersion` stamp (absent means version 1, the pre-verbatim-vendor prompt from the first backfill), so stored records stay attributable to the prompt generation that produced them. The pair of immutable records against the confirmed fields is what lets `parse-accuracy` score the two paths separately. |
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
| `POST` | `/api/export` | Kick off an export; body is either `{fiscalYearEndingIn}` (dates derived from the user's settings at request time, §5.1) or an explicit `{periodStart, periodEnd}` — the seam a quarterly picker would use (§12). Returns the job. **409 `export_already_running` when this user already has a live one** - one at a time, refused rather than queued, because an export at the budget peaks near 890 MB against a 2 GB origin (§4.2). *(Wave 2; serialization Aug 7, 2026)* |
| `GET` | `/api/export` | The caller's own jobs, newest first — the web export screen's history list. *(Wave-2 gate review)* |
| `GET` | `/api/export/:id` | Poll status; carries a presigned download URL while complete and unexpired, and the recorded error when failed. Two **computed** statuses tell the client to re-run rather than wait: `expired` (complete but past the 30-day zip lifecycle, §10B) and `stale` (sat `queued` past 5 minutes, or `running` past 30 — lost before it started or crashed mid-run; no sweeper process exists, the status itself stops the polling). *(Wave-2 gate review, revised)* |
| `GET` | `/api/me` | Profile + fiscal year settings |
| `PATCH` | `/api/me` | Update fiscal year settings |

**Image upload goes phone → R2 directly via presigned URL.** The image never transits the API server. Simpler, cheaper, and it makes the offline outbox retry logic straightforward.

**Every receipt response carries `suggestions`** *(Aug 8, 2026)*: the two parse records merged under §7.3's field-level rule, with a per-field provenance marker and the date-disagreement flag, computed by the domain layer.
Clients render it; neither client implements the merge (§4.1).
The detail route additionally keeps the raw `ocrSuggestions` record, which the shipped iOS confirm screen reads today.

---

## 7 · The iOS client

### 7.1 Screens — the whole iOS app in v1

1. **Sign in** — one Sign in with Apple button.
2. **Home** — a large **Capture** button and a reverse-chronological list of recent receipts. Any pending outbox items show at the top with their status. Capture must be reachable in one tap from cold launch. *(Wave-3 gate review: "recent" is ordering, not a cutoff — the list is every receipt, newest purchase first, paged.)*
3. **Capture** — opens `VNDocumentCameraViewController` immediately. No intermediate screen, no mode picker.
4. **Confirm** — the heart of the app. See §7.2.
5. **Receipt detail** — the record plus the image; every field editable.
That is five screens. **Export is deliberately absent — it lives on the web client (§7A).** Resist adding a sixth.

**What a pending receipt shows, everywhere it is read** *(Aug 8, 2026)*: the Home row and the detail screen render the served §7.3 merge by the confirm screen's own prefill rule - a served suggestion outranks the row's copy of the field, and the row fills only fields no suggestion covers.
A pending row's stored values are the capture-time heuristic snapshot; rendering them would show one receipt two different ways depending on the screen, with the merge's corrections invisible outside the confirm form - the defect the Aug 8 device pass surfaced.
A confirmed receipt renders its row - the human's values - everywhere; the merge never overrides a confirmed value (confirmed receipts are swept and served suggestions too, but only the accuracy measurement consumes those).

### 7.2 The confirm screen — get this right or nothing else matters

- Scanned image at the top, tappable to zoom. The person is checking numbers against the paper; they must be able to see the paper.
- Fields in this order, all pre-filled with OCR suggestions and all editable: **total · date · vendor · HST · subtotal · other tax · vendor tax number · business/personal · category · payment method · notes.**
- **Total first** because it is the field most likely to be checked and least likely to be skipped.
- **Every prefilled field is visually marked as a suggestion** until the person has looked at it. Touching a field clears the marking. This is what makes constraint 2 real in the UI rather than just in the schema.
- *(Aug 8, 2026 - §7.3's merge rule; the server computes and serves the merge, provenance, and flag on every receipt response, and this screen renders them.)* **LLM-sourced values are suggestions like any other - amber until touched, no trust shortcut** - and **when the heuristic and the LLM disagree on the date, the field stays amber and carries an inline note saying the two reads differ**, with the arithmetic warning's exact treatment (same amber, inside the field, never red - §10A.1): disagreement between two independent parsers over the same text is free signal, and the date is the field that decides the fiscal year. Touching the field clears the tint and the note together. Provenance is served but not rendered - amber already means unverified, and a source badge would ask the user to adjudicate parser internals; it stays in the API for diagnostics.
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

**The upgrade path - taken, Aug 7-8, 2026.**
This section used to frame the upgrade as a future choice among cloud expense parsers (AWS Textract `AnalyzeExpense`, Google Document AI, Azure Document Intelligence).
That framing is retired: it describes a path not taken.
The trigger it defined - per-field accuracy measured on real receipts - fired across waves 4-5, and the answer is a second parser, not a replacement.

**What the LLM path is.** A server-side parse by **Claude Haiku 4.5** over the **assembled `ocr_raw_text`** the client already stores - **text only; the image never leaves the phone**, and on-device Vision stays the only OCR, so capture stays instant and offline.
The request is the raw text and nothing else - never a field a person typed - built by a pure function so a test can assert what leaves the building.
The model gets a system prompt of Canadian-receipt domain facts (HST/GST are one program; cross-check multiply-printed dates; tax numbers carry letter prefixes) plus a structured-output JSON schema, and the reply is validated before anything stores it: a non-calendar date or an unstorable amount is refused loudly, never quietly corrected.
The result lands on the receipt as `llm_suggestions` (§5), immutable beside `ocr_suggestions`, stamped with the exact model and a `promptVersion`; `npm run parse-accuracy` scores both paths against what the human confirmed and lists every disagreement and which side the human took.

**The field-level merge rule** *(ruled Aug 8, 2026, on the n=3 reparse evidence)*:
- **Amounts - total, HST, subtotal - come from the heuristic, and only the heuristic: no fallthrough** *(amended Aug 8, 2026, on the first wild misparse)*. If the heuristic has no value, the field is served absent - never filled from `llm_suggestions`. The original ruling rested on both paths scoring 100% on money, which only covers cases where both produced a value and says nothing about the LLM on amounts the heuristic misses - exactly when a fallthrough fires; the first wild instance, on clean input, was a digit transposition ("SUBTOTAL 43.49" served as 3449 cents with `llm` provenance). §7.2's arithmetic check is only a partial net - it needs all three of subtotal, HST and total present, so a receipt missing two of them gets no check at all. An absent amount is visible and costs one keystroke; a wrong amount that passes unflagged reaches an accountant. The LLM's money values are still **stored** in `llm_suggestions` and still scored by `parse-accuracy` - the rule governs what the merge serves, not what is recorded, and that comparison is how the ruling gets revisited on more data.
- **Vendor and tax number come from the LLM.** 15/15 vendor matches under prompt v2, and 100% against the heuristics' 80% on the tax number.
- **Date trusts neither source alone.** The heuristic is deterministically wrong on an ambiguous DateTime line, and the LLM is wrong on roughly 1 of 3 runs over the same line. When the two disagree, the confirm screen keeps the field amber and marks it as needing attention (§7.2, §10A.1) - disagreement between two independent parsers over the same text is free signal, and this is the field that decides the fiscal year.
- **All LLM-sourced values stay amber until touched - no trust shortcut.** The corruption probe (`npm run parse-llm-probe`) is why: on deliberately degraded input the model returned a plausible invented date rather than null, so on bad input the LLM fails plausibly where the heuristic fails visibly.

**Prompt discipline.** The verbatim-vendor rule lives in the **vendor field's schema description**, scoped to the one field that transcribes (prompt v2; branch and store numbers, addresses, and phone numbers excluded).
Version 1 had no such rule and tidied "Noodle House (BCE)" down to "Noodle House" - a 40%-vs-80% vendor headline against the heuristics on the first run; a first v2 draft put the rule in the shared system prompt with "including store numbers" wording, which folded "Store #1234" into the vendor, and a date regression first read as a prompt effect re-ran as plain nondeterminism.
`RECEIPT_PARSE_PROMPT_VERSION` is bumped whenever the request's meaning changes; stored v1 records stay untouched and are distinguishable by their absent `promptVersion`.

**Cost, measured rather than estimated:** the first real run parsed 6 receipts for **$0.0069** (5,281 input, 332 output tokens) - about a tenth of a cent per receipt.

**⚠ Provisional, stated rather than smoothed over.** Every number above rests on **5 confirmed receipts from 2 vendors**, too few to distinguish a good model from a lucky one.
Re-run `parse-accuracy` after weeks of real use before treating the merge rule as settled; the accuracy table still arbitrates - a larger model, or a revised merge rule, is a data question, not taste.

**How the parse runs** *(built Aug 8, 2026)*: as a **sweep over rows, not inline in the create route** - the same reasoning as export jobs being rows rather than process memory.
The work's state is the receipt row itself (`ocr_raw_text` present, `llm_suggestions` null means "not parsed yet"), so a restart loses nothing and the next sweep simply picks the row up.
The server kicks the sweep at startup, after any capture that lands OCR text (fire-and-forget - a create never fails, blocks, or waits on the model; a model outage degrades that receipt to heuristic-only suggestions until a later sweep), and on a deliberately long interval as the retry net.
**The retry is capped**: a receipt whose parse fails 3 times gets a failure record written into `llm_suggestions` (§5) instead of another spot in the next sweep - every attempt bills the API, and an unbounded retry is fine at six receipts and a slow leak once the backlog lands.
**Confirmed receipts are swept too**: they cannot benefit from the suggestions, but each parse grows the accuracy set - which is exactly what the n=5 caveat above needs.
`ANTHROPIC_API_KEY` is **required at production boot** (`productionEnv.ts` - a missing key would be silent feature loss); in local dev a missing key just disables the sweep, stated at startup.
**The merge is computed in the domain layer and served on every receipt response** as `suggestions` - per-field values with a provenance marker (`heuristic`, `llm`, or `both` for an agreed date) and the date-disagreement flag; for vendor, tax number and date, when the ruled source found nothing the other side's value is served with its provenance stated - the money fields have no such fallthrough (heuristic or absent, per the amended rule above) - and on a date disagreement the heuristic's value is the prefill (it is the deterministic side) while the flag carries the signal.
Both clients render this; neither decides it (§4.1).
`npm run parse-llm-backfill` remains as a manual wrapper over the same sweep core (local-database-only, the same guard as `db:seed`, because pointing a laptop script at production should be a deliberate act - production's parsing is the server's own job).
**The iOS confirm screen renders the served merge** *(built Aug 8, 2026 - §7.2, §10A.1)*: the suggestion set is injected into the one confirm form by whichever route opens it (the served merge for a stored receipt; the on-device parse alone at capture time, where no server row and so no merge exists yet), a served suggestion wins the prefill over the row's capture-time copy of the field, exactly the suggested fields start amber, a merge-absent money field renders as a stated absence, and the date-disagreement flag is an inline note in the field with the arithmetic warning's treatment. The raw `ocrSuggestions` record stays in the detail response for the shipped client; the current client no longer reads it.
**Every read-only rendering of a pending receipt shows the same merge** *(Aug 8, 2026 - §7.1)*: the Home row and the detail screen render a pending receipt by the confirm screen's prefill rule (suggestion over row copy, row filling only fields no suggestion covers), so the merge's corrections are not a confirm-screen secret; a confirmed receipt renders the human's row values everywhere.
Constraint 2 is untouched: the LLM adds suggestions, never confirmations.

**Store `ocr_raw_text` on every receipt.** It makes parser failures diagnosable and lets a better parser re-run over old receipts later without recapturing anything - which is now exactly what the LLM parse sweep does.

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
- The doc-ownership rule *(added Aug 8, 2026)*: a decision appended to `docs/DECISIONS.md` amends this spec **in the same commit**. The log is how we got here; the spec is the current state; neither substitutes for the other.
- The DECISIONS ordering rule *(added Aug 8, 2026)*: `docs/DECISIONS.md` is ordered **newest-first by decision date** - a new entry is inserted at the top, never at the bottom, and a late-reconstructed entry files under the date the decision was made, not the date it was written.

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
- *(Aug 8, 2026 - device pass.)* **The keyboard has three ways out, and Save is never under it.**
**No field may raise a keyboard the person cannot put away without knowing a gesture** - editing a money field last was leaving the Save button covered with no obvious way back, on a screen whose whole brief is a five-second task ending in one tap.
**(1) Every keyboard with no exit of its own carries a toolbar with a Done button**: the four money fields (total, HST, subtotal, other tax), whose decimal pad has no return key, and notes, whose return key inserts a newline.
The single-line text fields are left without one - their return key already dismisses, and an accessory bar they do not need costs form height.
*(Aug 9, 2026 - device pass.)* **Which fields those are is read off the keyboard the field raises, not listed per field**: a numeric pad has no return key and a text view's return key inserts a newline, both properties of the keyboard. The hand-maintained list drifted once already and shipped a decimal pad nothing could close.
**The bar is installed on the first responder in UIKit, not requested from `ToolbarItemGroup(placement: .keyboard)`**, which installs nothing at all through this screen's `fullScreenCover` presentation - proven on device three ways, and non-deterministic across sessions as to whether it installs even an empty collapsed host. The bar is re-asserted on focus, text and keyboard-frame changes, because SwiftUI overwrites the accessory property on every body update.
⚠ *(Aug 10, 2026.)* **Verified on the detail entry, unverified on the capture entry.** The device pass covers all five keyboards with no exit, both cold and warm focus, the background round trip (a genuine resume, confirmed by pid), the no-bar control, and Done actually dismissing - all through `ReceiptDetailView`'s `fullScreenCover`. Two verifications remain open: the zero-height negative control has run only on the simulator, never on device, and the capture path (`VNDocumentCameraViewController` → `ConfirmQueueView`) has not been exercised at all. This defect was presentation-dependent, so the second gap is a real one.
**(2) A tap anywhere that is not a text field dismisses**, and **(3) any scroll of the form dismisses**.
Dismiss-on-scroll is also the answer to Save sitting under the keyboard: reaching Save is a scroll, and the scroll is what uncovers it - chosen over insetting the form, which would keep a keyboard-height gap on screen and still leave the person reaching past the pad.
The focused field itself stays visible above the keyboard.
- *(Aug 8, 2026 - added by §7.3's merge rule; rendered by the built screen the same day.)* **A date the two parsers disagree on stays amber and carries an inline note saying the two reads differ - the arithmetic warning's exact treatment: same amber, inside the field, never red, a prompt to look rather than a rule.** Touching the field clears the tint and the note together - touched means a human looked and decided; there is no separate dismissal and nothing persists. **Provenance is not rendered anywhere on this screen** - amber already means unverified, and a source badge would ask the user to adjudicate parser internals; it stays in the API for diagnostics. The amber semantics are unchanged for everything else: LLM-sourced values are suggestions like any other, amber until touched, no trust shortcut.

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

**Both passes ran on Aug 6, 2026, merged** (pass 1 was never run at its natural point, so its scope folded into pass 2), **and were then adversarially audited by a separate session.**
Full record: `docs/security/review-2026-08.md` and `docs/security/audit-2026-08.md`.
The isolation model held under both.
**Wave 6 was called no-go - on unfinished distribution work, not on a breach** - and the owner ruled on every open finding the same day.
Two consequences belong in this section rather than only in the reports:

- **Rate limiting lands *with* the deployment, at the Cloudflare edge, not in the application.** §10B has named it since the beginning and it is still not built. That is deliberate: a limiter's shape depends on what identifies a client, which depends on what sits in front of the app, and building one before a deployment existed would have encoded a guess about a topology that did not exist - the same mistake as the decorative presigned content-type check caught at wave 3. The deployment target is now decided (§4.2), so the guess is no longer needed.
- **The threat model this is all ranked against:** three users, an unlisted link, no public discovery. A finding reachable by an unauthenticated stranger holding the link outranks one needing a hostile authenticated user, which outranks one needing physical possession of a device. Findings are ranked that way in both reports rather than listed as equals.

### Bug review — after wave 5
Once capture, storage, and the outbox work end to end, run a deliberate bug pass before distribution. Adversarial parser inputs (blank receipt · crumpled · foreign currency · a photo that is not a receipt), outbox failure modes (app killed mid-upload · storage full · token expired mid-queue), and money edge cases (zero total · refund/negative · very large amounts).

### DevOps — deliberately minimal at this scale
**Build:** GitHub Actions running the backend suite on push. That is the whole CI story.
**Backups:** managed Postgres with point-in-time recovery. **Verify a restore once** — an untested backup is an assumption, not a backup.
✅ *(Aug 7, 2026)* **The restore has been run and the verifier falsified.** `npm run db:verify-restore` compares row counts between the source and the restored database, then follows every live image row in the *restored* database out into object storage and re-hashes the bytes against the digest that row carries — a key that resolves proves an object is there, and only the digest proves it is the right one. Procedure in `docs/Runbook.md` §4.
⚠ **And a correction to the sentence above it.** "Managed Postgres with point-in-time recovery" turned out to name a **history window**, not retention: **Neon's is 6 hours on the Free plan**, 7 days on Launch, 30 on Scale. That covers "I ran the wrong thing twenty minutes ago" and does not cover six years. **Retention rests on a scheduled `pg_dump` kept off Neon**, which is now an explicit step rather than something the word "backups" was quietly assumed to include.
**Errors:** an error monitor after first real use, not before. Three users produce no signal until they produce a bug.
**Explicitly deferred:** staging environment, infrastructure-as-code, observability stack, feature flags. At three users these are ceremony, and pretending otherwise is how a project that should ship instead stalls.

### The one piece that is not deferrable
**Retention.** CRA requires six years, and these are the supporting documents for tax filings. Deletes are soft, backups are real, and a restore has been tested. Everything else here can wait; losing a year of tax records cannot be undone.

**What retention covers - and what it does not** *(wave-2 gate review)*. The **receipts and images are the retained records**. **Export zips are artifacts**: regenerable at any time from the same data, so they are explicitly *not* records. The R2 bucket carries a **30-day lifecycle expiry on the literal prefix `exports/`** (a deployment-time bucket rule - receipt images live under `{userId}/...` and are under no lifecycle rule whatsoever). The job row keeps its period parameters, and a job past the window reports as `expired` - re-runnable, not downloadable.

⚠ **The prefix changed on Aug 6, 2026, and the reason generalizes.**
This rule was originally written as `{userId}/exports/...`, which **cannot be expressed**: S3 and R2 lifecycle rules match a *literal* prefix, and `{userId}` varies per user, so no single rule selects every user's exports without also selecting their receipt images - the one thing that must never expire.
The alternatives were one rule per user (three today, and silently one more at every sign-up, remembered by nobody) or object tags applied at upload.
Hoisting `exports/` to the front makes it one literal prefix for every user, forever.
Zips written under the old layout keep it and simply fall outside the rule; there are none outside dev.
**The general lesson: a retention rule written against a path that varies per user is not a rule, it is a description** - and this one survived two gate reviews because nobody tried to write it out as the bucket would receive it.

## 11 · Deferred to v2 — recorded so they are not re-litigated

- **Automated email ingestion.** A **dedicated forwarding address**: forward the receipt email, a parser pulls the attachment or renders the body. Not mailbox OAuth polling — forwarding avoids inbox-read scopes, and works identically across whatever mail providers the family uses. v1's answer is manual file upload of a PDF or image, which reuses the confirm screen unchanged.
- **Dashboard** — per-user, not a family view. Spend and totals over time.
- **Category taxonomy** — CRA T2125 lines or T2 GIFI codes, depending on the sole-proprietor-vs-incorporated answer.
- **Near-duplicate detection** — warn when a new receipt matches an existing one on date, vendor, and total. This is the real answer to a re-scanned paper receipt, which hashing cannot catch (§5).
- **Multi-page receipts** — VisionKit supports it; v1 takes page one.
- **Second user's account** — the model already supports it; nothing to build.

### Distribution checklist (wave 6)

**Prerequisites, from the Aug 6 security review's no-go.** None of these is App Store paperwork; all three are the reasons the wave was blocked.

- ✅ **Deploy the API over HTTPS and make it the Release default** *(configuration done Aug 7; the deploy itself is the owner's)*. A Release build now reaches **`https://api.keptapp.net`** and **does not read the in-app override at all** - the server-settings sheet is compiled out of shipped builds, because with the ATS exception gone the remaining risk is redirection, and a control that points an installed app at another server is one an unlisted link should not carry. Development keeps `http://localhost:3000` and the sheet. The origin is Node on Fly (`server/Dockerfile`, `server/fly.toml`), refusing at startup on any non-production-shaped configuration.
- ✅ **Split the Debug and Release `Info.plist`** *(done Aug 6; confirmed in a built Release bundle Aug 7)*. One plist served both configurations, so `NSAllowsLocalNetworking` and an `NSLocalNetworkUsageDescription` reading "during development builds" would have shipped. `InfoPlistConfigurationTests` asserts the split, the shipping plist's contents, and that the two configurations point at different files - a build-setting defect no runtime test could have caught. The wave-6 check went further and read the **built** `Kept.app`: neither key is present, and `Info-Debug.plist` is not in the bundle.
- ✅ **Add `PrivacyInfo.xcprivacy` and file an honest privacy label** *(manifest done Aug 7; the label is filed by the owner)*. `UserDefaults` is a required-reason API (`NSPrivacyAccessedAPICategoryUserDefaults`, reason `CA92.1`), so the manifest is needed for submission. The declaration is **other financial info** (amounts and tax figures), **photos or videos** and **other user content** (receipt photographs, vendor, category, notes), **user ID** (the Apple subject id), and **email address** and **name** - the server stores the Apple relay address and, when Apple provides it, the display name. All six are **linked to identity, none used for tracking**, purpose App Functionality. "Data Not Collected" would be false. This could not be written until the deployment existed, because where the data goes is part of what the label declares.

**Operations, once deployed:** `docs/Runbook.md` - deploy, migrate, roll back, back up and restore. **The ordered list of what only the owner can do:** `docs/gates/wave-6.md` §3.

⚠ **Nothing migrates from the dev database.** The owner's phone points at `http://localhost:3000` and its receipts live in the local docker-compose database. **Production starts empty**, and a TestFlight build has no settings screen to point back at the Mac.

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

- **August 8, 2026 (pending receipts render the served merge on every screen)** - Device-pass defect from the entry below, fixed same day: the confirm form rendered the served §7.3 merge while the Home row and the detail screen rendered the row's stored values - one receipt, two readings, with the merge's corrections ("Food Basics" over "Basics", the corrected date and tax number) invisible outside the confirm screen. Now **every read-only rendering of a pending receipt reads the merge by the confirm screen's prefill rule** (suggestion over row copy, row filling only fields no suggestion covers), via one `Receipt` extension (`ReceiptDisplay.swift`) shared by both screens and pinned by unit test; **confirmed receipts are unchanged and render the row - the human's values - everywhere**, though they are swept and served suggestions too. Checked, unchanged: the detail screen's "Not recorded" and the confirm form's "Not found" both stay - stored-record absence vs parse absence, a distinction carried by the components' contexts and now recorded in DECISIONS.md so it is deliberate rather than accidental. Amended: §7.1 (the display rule), §7.3 (read-only renderings named beside the confirm screen). Suites: iOS 204 (was 199), server 263 (untouched), all green; zero compiler warnings. ⚠ Test honesty, stated: the extension's selection is pinned by unit test, but the views reading `display*` instead of the raw fields is SwiftUI body content no unit test executes - reverting a row to `receipt.vendor` would stay green; the device pass is the real evidence, per §10.2.
- **August 8, 2026 (iOS confirm screen renders the served merge)** - The remaining piece named by the two entries below is built: the confirm screen renders the `suggestions` field the API serves - prefill, amber, and the date note all read off the §7.3 merge - and the client no longer reads the detail route's raw `ocrSuggestions`, which stays in the response for the shipped client. **The suggestion set is the injected thing**: one form serves all three routes (queue, detail, capture-time), each construction handing it the set that exists for it - the server merge for a stored receipt, the on-device parse alone for a capture-time confirm, where no server row and so no merge or disagreement flag can exist. **A served suggestion wins the prefill over the row's copy of the field** (the row's values on a pending receipt are the capture-time heuristic snapshot; rendering them would un-take the merge decision client-side); a value only on the row prefills without amber, and rows with no suggestion set at all keep the value-presence proxy. **The date-disagreement flag renders as an inline note with the arithmetic warning's exact treatment** - same amber, inside the field, never red - cleared together with the tint when the field is touched; no separate dismissal, nothing persisted. **Provenance is served but not rendered** - the client does not even decode the `source` markers - and **a merge-absent money field prefills empty so the form's "Not found" placeholder states the absence** (the served `{value: null, source: null}` shape pinned by decode test). Amended: §7.2, §7.3, §10A.1 (rendering flipped from "remaining piece" to built); DECISIONS.md carries the entry. Suites: iOS 199 (was 194), server 263 (untouched), all green; zero warnings, strict concurrency complete. ⚠ Test honesty, stated: the model pins the note's visibility flag and the empty prefill, but the view's `if` around the note and the literal "Not found" placeholder are SwiftUI body content no unit test executes - their removal would not fail the suite. They are guarded by review and the device pass, like every §10.2 view-layer fact.
- **August 8, 2026 (money merge corrected: no fallthrough on amounts)** - The live run recorded in the previous entry surfaced the correction: "SUBTOTAL 43.49" was parsed by the model as 3449 cents and **served with `llm` provenance**, because the heuristic found no subtotal and the merge's fallthrough passed the field to the LLM. §7.3's merge rule is amended: **for total, subtotal and HST the heuristic is the only source - a heuristic-absent amount is served absent, never filled from `llm_suggestions`**; fallthrough is unchanged for vendor, tax number and date. The "amounts from the heuristic" ruling rested on both paths scoring 100% on money, which only covers cases where both produced a value - it says nothing about the LLM on amounts the heuristic misses, exactly when fallthrough fires - and §7.2's arithmetic check needs all three amounts present, so a receipt missing two of them gets no check at all; an absent amount costs one keystroke, a wrong amount that passes unflagged reaches an accountant. The LLM's money values are still stored and still scored by `parse-accuracy`, which is how the ruling gets revisited on more data. Checked, not altered: two receipts in the dev database (both synthetic-user rows, one soft-deleted - the 3449 receipt itself among them) carried an llm-sourced amount through the merge at the time of the change. Amended: §7.3 (merge-rule bullet, serving semantics). Suites: server 263, all green.
- **August 8, 2026 (LLM parse wired into the running system)** - The gap the previous LLM entry stated ("decided, not built - no route or client code reads `llm_suggestions` yet") is closed on the server side. **The parse runs as a sweep** (`src/parse/llmParseSweep.ts`), not inline in the create route - the receipt row itself is the work's state (`ocr_raw_text` present, `llm_suggestions` null), so a restart loses nothing; the server kicks it at startup, fire-and-forget after any capture landing OCR text, and on a long interval as the retry net, with confirmed receipts swept too because their parses grow the accuracy set the n=5 caveat needs. **The §7.3 merge is computed in the domain layer** (`src/domain/mergedSuggestions.ts`) **and served on every receipt response** as `suggestions` - per-field value, provenance (`heuristic`/`llm`/`both`), and the date-disagreement flag; both clients render, neither decides (§4.1). **`ANTHROPIC_API_KEY` is required at production boot** (silent feature loss otherwise), while a runtime model failure degrades that receipt to heuristic-only suggestions and a create never fails, blocks, or waits on the model - verified against the live dev server: create returned 201 in 63 ms and the sweep's record (model + promptVersion stamped) landed seconds later. **The retry is capped at 3 attempts per receipt**, after which the sweep writes an explicit failure record into `llm_suggestions` (model, promptVersion, the error, attempt count, `suggestions: null`) - every attempt bills the API, so an unbounded retry is a slow leak once the backlog lands, and a failure that lives only in a log is invisible; `parse-accuracy` scores such a record as "the LLM produced nothing", distinct from a receipt never parsed. `npm run parse-llm-backfill` remains as a manual wrapper over the same sweep core, keeping its local-database guard; its "refuse loudly on an already-set column" became a counted `superseded` outcome, since two legitimate writers now exist and the null-only UPDATE guard is what keeps the first record immutable. Amended: §5 (`llm_suggestions` writers and the failure record), §6 (responses carry `suggestions`), §7.2/§10A.1 (server side landed; the confirm screen's rendering is the remaining piece), §7.3 (status paragraph replaced by the built shape, retry cap stated). Suites: server 261 (was 242), all green. ⚠ One observation from the live run, recorded as evidence in `DECISIONS.md`: the model misread a printed subtotal of 43.49 as 3449 cents - the "fails plausibly" caveat occurring in the wild rather than under a deliberate probe. ⚠ Still not built: the iOS confirm screen rendering the merge - that is the next step, and nothing about the on-device capture path changed.
- **August 8, 2026 (DECISIONS ordering stated)** - `DECISIONS.md` had drifted into three orderings with no stated rule - newest-first at the top, oldest-first through the Aug 5 wave entries, and four LLM entries appended at the bottom out of order among themselves. It is now **newest-first by decision date** (new entries at the top, never the bottom; a late-reconstructed entry files under the date the decision was made), stated in its own header, mirrored in `CLAUDE.md` beside the doc-ownership rule, and the whole file reordered to match with every entry's wording preserved except the founding entry's positional cross-references, which now name the entries they point at. Spec changes: the §10.1 bullet and the §4.4 repo-sketch annotation, alongside this entry.
- **August 8, 2026 (LLM parse path - the spec caught up)** - Three days of LLM-parse decisions (`DECISIONS.md`, Aug 7-8) landed in code without amending this spec; this entry closes that gap, and the doc-ownership rule is now standing in `CLAUDE.md`: a decision appended to `DECISIONS.md` amends the spec **in the same commit**. **§5 gains `llm_suggestions`** (migration `0004_llm-suggestions`): the server-side LLM parse's record, immutable beside `ocr_suggestions`, write-once (the backfill's UPDATE re-checks `WHERE llm_suggestions IS NULL`), stamped with the exact model and a `promptVersion` (absent = v1). **§7.3's upgrade path is rewritten as taken**: Claude Haiku 4.5 over the assembled `ocr_raw_text`, text only - the image never leaves the phone - with the field-level merge rule (amounts from the heuristic, vendor and tax number from the LLM, date trusting neither source alone), the date-disagreement amber flag (§7.2, §10A.1), the measured cost ($0.0069 for the 6-receipt first run), and the provisional caveat that every number rests on 5 confirmed receipts from 2 vendors. The Textract / Document AI / Azure framing is retired as a path not taken (§4.3), and §4.2 gains the server-parse stack row. ⚠ Stated rather than smoothed over: the merge rule and the confirm screen's disagreement flag are **decided, not built** - no route or client code reads `llm_suggestions` yet, and the column is filled only by `npm run parse-llm-backfill`.
- **August 7, 2026 (wave 6: deployment and distribution, built but not performed)** - The three security-review blockers are closed as far as they can be without credentials, and **§10B's tested backup restore has run for the first time**. **Deployment exists as reproducible configuration** - `server/Dockerfile`, `server/fly.toml` (`shared-cpu-1x`, 2 GB) - and `src/productionEnv.ts` refuses at startup on four shapes under which the server would *run* while being quietly wrong: no `STORAGE_*` (which would silently fall back to a MinIO that is not on a Fly machine), a plain-http storage endpoint (presigned URLs inherit it), a loopback database, and a session secret under 32 characters. Verified by making the real Docker image refuse each one. **The origin refuses to serve unless Cloudflare put it there** (`EDGE_SHARED_SECRET` in an `x-kept-edge-secret` header) - without it, Fly's public `*.fly.dev` hostname would let anyone walk around §10B's edge rate limiter. **A shipped iOS build reaches exactly one address**, `https://api.keptapp.net`, ignores the stored override entirely, and has **no server-settings screen** - The owner's ruling: with the ATS exception gone the remaining risk is redirection of the bearer token, and an unlisted link anyone can install from should not carry that control. **`PrivacyInfo.xcprivacy` ships** with six data types, all linked to identity and none for tracking, plus `CA92.1` for `UserDefaults`; the App Store Connect label is written out word for word in the gate report. **The restore drill:** dump, restore to a scratch database, compare row counts, then re-hash every live image's stored bytes against its own row's digest - falsified against a deliberately damaged copy, which reports a deleted row, a corrupted digest and a missing object and exits 1. ⚠ **Two things the write-up surfaced.** Neon's history window is **6 hours on the Free plan**, so "managed Postgres with PITR" was never a six-year retention story and the scheduled dump is what is; and a new test **passed while an unfenced settings button sat in a shipped build** - it searched for the view type, which the button's line never names, so it guarded how the control is *built* rather than what a person *sees*. Fixed, re-falsified, and recorded as the general lesson. `docs/Runbook.md` is new (deploy, migrate, roll back, restore); `docs/gates/wave-6.md` §3 is the ordered list of what only the owner can do, ending at the permanent unlisted conversion, which nothing in the session went near. Suites: server 214, iOS 194, zero warnings; guardrail 7 run against both the real entrypoint and the production image.
- **August 7, 2026 (provisioning ratified, exports serialized)** - `shared-cpu-1x` at **2 GB** is the ratified origin size, on the previous entry's measurement. **Exports are now one-at-a-time per user**, built now rather than deferred: on a fixed 2 GB ceiling what matters is not the user count but how many exports can overlap, and this removes the only path that doubles peak RSS. A second request is **refused with 409 `export_already_running`, not queued** - a queue needs a worker, a fairness rule and a cancel path, while refusing needs a sentence and the client already polls. Enforced by a **partial unique index** (`export_jobs (user_id) WHERE status IN ('queued','running')`, migration `0003_one-active-export-per-user`) rather than a handler check, which cannot be race-free: generation runs after the 202 response, so no transaction spans it and Postgres locks no row that does not yet exist. ⚠ **Its companion is not optional** - a crashed job leaves its row `running` forever and the index reads stored status, so `POST /api/export` retires jobs past §8's staleness windows before inserting, using the same clocks `reportedStatus` already reports `stale` with; without it, one crash would lock that user out of exports permanently and silently. Both halves falsified. One pre-existing test that inserted two concurrent running jobs for one user was **moved to two users rather than weakened**, keeping both assertions. Also recorded: the memory measurement required a storage double producing bytes on demand, because the shared fake retains them in a `Map` and would have measured the fake - framework §9.3 rule 5's eighth instance, and the first where the divergence would have corrupted a measurement rather than a test. Suites: server 201, iOS 177; guardrail 7 re-run, dev database migrated and intact.
- **August 6, 2026 (security rulings applied)** - The owner ruled on every open finding from the §10B review and its audit, and the rulings are implemented. **Deployment target decided: Node on Fly.io behind a Cloudflare proxy, keeping R2 and Neon** (§4.2). This reverses a same-day ruling of Cloudflare Workers, and the reversal is the more useful record: writing the choice into the spec surfaced that **a Workers isolate is capped at 128 MB on both plans while `generateExport` budgets 256 MiB and holds an incompressible zip roughly twice during assembly**, so the export could not have run there. Cloudflare in front still supplies the edge rate limiter and DDoS protection that motivated Workers, while a Node origin leaves `@hono/node-server`, `pg`, `archiver` and `exceljs` untouched. The budget was then **measured rather than argued**: a 250 MiB export peaks at **891 MiB RSS, 693 MiB over baseline** - about 2.8x the payload - so the budget is sound but sizes the machine at 2 GB, and concurrent exports multiply it. **Eight changes landed:** the Debug and Release `Info.plist` are split and asserted, so the local-networking ATS exception can no longer ship; outbox files write at `.completeFileProtection`, with a new locked-vs-lost distinction so a locked phone retries instead of reporting a healthy receipt as unrecoverable; `renderError` strips database detail unconditionally (the leak rides drizzle's `params`, which are interpolated **into the error's own message** - so the review's proposed "log `error.message` instead" fix would have leaked identically, and the same redaction now covers the `export_jobs.error` column, which is returned to clients); `db:seed` and `db:claim` refuse any database not on this machine; `db:claim` refuses receipts carrying images rather than orphaning their object keys; `cents()` is narrowed to the int4 range with the superseded test replaced rather than deleted; export zips move to a single literal `exports/` prefix so §10B's 30-day lifecycle rule is expressible at all; and stored object keys are re-validated **on read**, in both the detail route and the export, because write-time validation cannot speak for what a row holds later. **`npm run dev` now names a stale listener on port 3000** - found four times across waves - and says what a stale server means for anything measured against it. **Deferred, recorded as open:** the orphaned-object policy and per-request token pinning. Suites: server 195, iOS 177, zero warnings; guardrail 7 re-run against the real entrypoint.
- **August 6, 2026 (wave-5 gate closed)** - The §9 wave-5 gate scenario passed on device, genuinely offline (cable out, both radios off): three receipts captured in separate sessions queued, drained serially in capture order on reconnect, and survived a force-quit in between; server-side verification confirmed exactly three rows with three distinct images whose stored bytes re-hash to their own rows' digests, no duplicates, no orphans, and an empty phone outbox. §14's multi-item gap is closed; the stuck-item manual tap and pocket case fold into ordinary use under the owner's call (wave-4 waiver form). **The wave-5 gate is closed.** Next, before wave 6: the consolidated §10B security review.
- **August 6, 2026 (wave-5 offline pass)** - The offline test passed on device, genuinely offline for the first time: the owner found the missing variable - a phone tethered by the dev cable can reach the dev server with both radios off, which had silently invalidated every earlier "offline" run (recorded as the fifth instance of framework §9.3 candidate rule 5, and as a partial re-attribution of the cache diagnostic, whose fix remains correct and is what made the honest failure visible). Verified unplugged: honest refresh failure, capture-confirm-save to Home with live outbox status, automatic backoff retry, queue survival across force-quit, automatic drain on reconnect. One finding fixed: the 60-second default request timeout read as a hang - the API session now fails idle requests at 10 seconds (an idle timer, so progressing image uploads are never cut), asserted in the transport-configuration test; the outbox rides the same transport, so its first attempt is covered by the same fix. Stated gap: single receipt only - the §6 three-receipt drain-and-ordering run is still ahead. Suites: iOS 170, server 152, zero warnings.
- **August 6, 2026 (wave-5 offline diagnostic)** - A pre-test check with both radios off showed pull-to-refresh succeeding with a current-looking list and no error. Diagnosed from the phone's own cache database: CFNetwork had heuristically cached the list response (the API sent no cache directive) and served it offline as a fresh 200 - the app's failure UI was verified correct and simply never fired, because the transport reported success. Fixed on both sides: the iOS API transport now runs a cache-free session (`urlCache = nil` + `.reloadIgnoringLocalCacheData`), and every server response carries `Cache-Control: no-store` via app-wide middleware, with tests asserting the transport configuration (iOS) and the header on success and error responses (server). Lesson recorded in DECISIONS.md and as the fourth instance of framework §9.3 candidate rule 5: the masking lived below the app - trusting the layer beneath, not error handling, was the gap. Suites: iOS 170, server 152, zero warnings.
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
