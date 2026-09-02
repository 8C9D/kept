# Kept - agent instructions

The spec is `docs/Kept-Build-Spec.md`.
It is the authority for the entire project.

## What this is

Kept is a receipt-capture app for the owner and a second user's business: an iPhone client that scans a receipt, shows the OCR guesses in an editable form, and a backend that stores the record and generates the year-end export an accountant can import.
`README.md` is the entry point for a reader arriving at the repository; this file and `docs/` are the depth behind it.

The iOS app is a capture-and-confirm client and all domain logic lives in the backend.
HST arithmetic, export generation, filename derivation, fiscal-period slicing, and validation are the server's, deliberately, so a later Android or web client does not have to reimplement them.

`web/` is gated locally; production enablement is the owner's (`web/README.md`).

## Production topology

The origin is `https://api.keptapp.net`.
The Fly machine behind it is described by `server/fly.toml`; what is *not* in the repo is Neon Postgres, the Cloudflare R2 bucket `kept`, and Cloudflare proxying the zone `keptapp.net` and carrying the rate limiter.
Images never transit the API: the client PUTs straight to object storage through a presigned URL.
`docs/Runbook.md` is the operations authority - deploy, migrate, roll back, back up, restore.

## Status, as of 2026-09-01

- The shipped build is **1.0 (1)** - on TestFlight, on the owner's and the second user's phones. App Review rejected it 2026-08-22 under Guideline 2.1; the verbatim rejection, the seven-item reply, the Notes-field text and the recording script are `docs/app-review/2026-08-25/`.
- **TestFlight build 1.0 (5) is live**, uploaded 2026-09-01 15:59 EDT and confirmed in App Store Connect 2026-09-02 01:05 EDT: processing complete, `Ready to Submit`, in the Internal Testers group, one of the two phones had installed it by then. It replaces 1.0 (4) from 2026-08-28. Distribution signing was read off a sibling export of the same archive (`Apple Distribution`, `get-task-allow=false`, no `ProvisionedDevices`). It is a TestFlight upload only - **nothing has been submitted to App Review**. How a build is versioned, archived, signed and uploaded, and the traps that make a broken one look shippable, are in `ios/CLAUDE.md`.
- **Deployed:** everything through 2026-09-01 - machine **v9**, migrations `0005` through `0009` run against production (each preceded by a restore-verified backup), Pages redeployed. `0008` was the first non-additive migration here; `0009` was the first that had to run **before** its deploy, and it therefore could not run through `fly ssh console` at all - the v8 image did not ship it, and `drizzle-kit migrate` inside that image reported success having applied nothing (Runbook §2). Production is real and in use: **two users, 237 receipts** as of 2026-09-01 afternoon.
- **Built, committed and deployed 2026-09-01:** the product-feedback batch that followed two weeks of real use - `thinking` disabled in the parse request, prompt **v5** (which for the first time gives the model a `Captured on:` line), an amount floor that withholds an impossible extraction, migration **`0009`** (`reviewed_fields`, `ocr_source`, a stored and editable `receipt_field_options` - backfilled to 142 rows in production), `POST /api/receipts/parse` as a write-nothing second opinion the capture screen calls, the iOS parser rebuilt and measured on all 130 live receipts, PDF import on both clients, save-for-later, manage-values, live form arithmetic, and **amber dropped from the iOS confirm screen** on the owner's instruction. Record: `docs/DECISIONS.md` 2026-09-01 (five entries, in the order the day ran; the last records the deploy); verification: `docs/gates/product-feedback-2026-09-01.md`.
- **The deploy order that batch needed was executed as written:** fresh verified dump → `0009` **before** the deploy → `fly deploy` → Pages → **TestFlight 1.0 (5) last**. The reason it mattered still holds for the next such batch: production's strict create/update schemas answer **400 to every save** from a client that ships ahead of the server. Runbook §1/§2.
- **The investigation behind all of it is deliberately outside this repository:** `~/.kept/reviews/2026-09-01/` holds the per-user reviews, `verdicts.csv` and the code-and-data diagnosis. They quote two real people's whole purchase histories, receipt by receipt. The findings are in `DECISIONS.md`; the evidence stays there.
- **Three verified backups exist for 2026-09-01** - morning (2 users / 136 receipts / 136 images), afternoon post-backfill (237 / 237), and a pre-`0009` dump at 19:54 UTC (237 / 237, `kept-backups/pg/kept-20260901-manual-195446.dump`), each dumped **and restored and matched by whole-row md5**, laptop copy and R2 copy. All three are point-in-time artifacts: **re-dump before the next migration**, do not reuse them.
- **The blocking owner action:** The owner's demo recording on a physical device; then the Resolution Center reply and resubmission. Approval, the unlisted conversion and pressing Release all sit behind it. The Sign in with Apple `.p8` is to be minted **before** the resubmission, so account deletion revokes when the reviewer tests it. Behind those, decided 2026-08-26 and deliberately deferred: the App Store Connect privacy label must be refiled to match `PrivacyInfo.xcprivacy`'s Product Interaction entry. It is a gate, not a preference - **no build carrying that manifest entry may be submitted to App Review until the label declares it too**, because a manifest and a label that disagree is what a reviewer checks.
- **Two owner-held keys are still unminted**, and both are traps rather than status: the R2 `kept-backups` token, without which the nightly backup agent refuses every night - so what protects the data between hand-run dumps is Neon's 6-hour window and nothing else; and the Sign in with Apple `.p8` with its three `APPLE_*` secrets, without which account deletion still deletes but revokes nothing (Runbook §0).
- What was decided, what deployed when, and what stays deferred on which trigger live in `docs/DECISIONS.md` (newest-first), with the per-wave gate reports in `docs/gates/` and the hardening ledgers in `PROD-READINESS*.md`. This section does not restate them.

## Receipt intake

Receipts also arrive from outside the camera: manually downloaded PDFs, email receipts, vendor purchase-history pages.
Each such batch gets a **receipt import workspace** at `~/.kept/imports/<date>-<slug>/`, deliberately outside this repository, because a workspace holds real purchase records for real people.
This mirrors `~/.kept/reviews/`, which holds the per-user receipt reviews for the same reason.
The `imports/` line in `.gitignore` is a guard against an accidental in-repo workspace, not a pointer to one - the data itself is never in the repo, gitignored or otherwise.

A workspace holds one directory per source - `downloads/`, `gmail/`, `outlook/`, `vendor/`, whatever the batch drew from.
Inside each source directory: the raw source document, a per-receipt JSON of the extracted fields, a `manifest.json` recording what that extraction pass found and what it skipped and why (a gap-filling second pass writes `manifest-pass2.json`), and `ledger.jsonl`.
`ledger.jsonl` is one line per production write - source file, receipt id, R2 object key, sha256, total, currency, no token - and it is what makes the importer idempotent: an existing ledger entry blocks a second write of the same source file, so re-running the importer cannot double-import.
At the workspace root: `import-one.mjs` (the importer), `html-to-pdf.sh` (a headless-Chrome converter, needed because the API accepts only PDF/JPEG/PNG), `import-queue.json` and `review-table.md` for the batched human review, `decisions.json` recording every dedupe, drop and flag with its reasoning, and `IMPORT-REPORT.md` as the human-readable summary of the run.
`~/.kept/imports/2026-09-01-receipt-backfill/` is the worked example of this shape.

Two rules govern every import and are worth stating because they are the ones easy to get wrong.
Constraint 2 ("No OCR value saves without a human confirming it") applies here too - every imported receipt is shown to the owner before it is written, same as a camera capture.
`ocr_raw_text` and `ocr_suggestions` must never be written by an import: those columns are an immutable record of what a parser suggested at camera capture and feed the parse-accuracy measurement, and an import is not a camera capture.

## Build and test

Per-directory commands and the notes that make them work live in `server/CLAUDE.md`, `ios/CLAUDE.md`, and `web/CLAUDE.md`.
On a fresh clone run `git config core.hooksPath .githooks` once to enable the gitleaks pre-commit secret scan.

## The success test

A receipt is captured in under a minute and never thought about again.
Every design decision is subordinate to this sentence.

## The three constraints that do not move

1. HST is its own field, never folded into the total.
   (Strengthened 2026-08-28: tip and other fees got their own fields specifically so they have somewhere to go that isn't HST.)
2. No OCR value saves without a human confirming it.
   Extracted fields are suggestions in an editable form.
3. Full per-user isolation.
   Each user sees only their own receipts.

## Engineering rules

- `user_id` always comes from the session token, never from a request parameter.
  An endpoint accepting a user id as input is a bug.
- Money is integer cents.
  Never floats.
- `category` is free text.
  Never introduce an enum, taxonomy, or CRA line mapping.
  (Reuse of a user's own past values via `GET /api/receipts/options` is a convenience, not a vocabulary — 2026-08-26.)
- Nothing with `status = 'pending'` may appear in an export.
- No secrets in the repo.
  `.env.local` is gitignored and the owner handles its contents.
- Verify artifacts, not reports.
  Inspect the database, open the generated file, read `git log`.
  An exit code is not evidence.
- Predict before verifying.
  State in writing what you expect an artifact to look like, then look at it, then note the gap.
- Every gate starts the real server the real way before it closes: the production entrypoint (`npm run dev` or the platform equivalent), from a clean checkout, config loaded as an operator would load it, then one real request against it.
  A test suite that injects its configuration can be fully green while the entry point cannot start - that happened at wave 3.

## Production is live

`api.keptapp.net` is a real deployment holding a real database and a real bucket.
Nothing may deploy, migrate against production, write to the production database or buckets, rotate a secret, or change DNS without the owner asking for it in that session.
Read-only inspection of local config and code is always fine.

## Doc ownership

- When a decision is appended to `docs/DECISIONS.md`, `docs/Kept-Build-Spec.md` is amended in the same commit.
  `DECISIONS.md` is the append-only log of how we got here; the spec is the current state.
  Neither is optional and neither substitutes for the other.
  The failure mode this exists to prevent: a prompt that says "append a DECISIONS entry" without saying "amend the spec" must still produce both - the Aug 7-8 LLM-parse decisions reached the log while the spec went on describing a path not taken for three days.
- `docs/DECISIONS.md` is ordered newest-first by decision date: a new entry is inserted at the top of the file, never at the bottom, and a late-reconstructed entry files under the date the decision was made, not the date it was written.

## Review discipline

When reviewing your own or generated code, explicitly hunt duplication and error-masking: catch blocks that swallow signal, empty error handlers, silently-defaulted values.
