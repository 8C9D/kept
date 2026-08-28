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

## Status, as of 2026-08-28

- The shipped build is **1.0 (1)** - on TestFlight, on the owner's and the second user's phones. App Review rejected it 2026-08-22 under Guideline 2.1; the verbatim rejection, the seven-item reply, the Notes-field text and the recording script are `docs/app-review/2026-08-25/`.
- **1.0 (2) was uploaded to App Store Connect 2026-08-26** and carries the in-app account deletion Apple asked for. It finished processing, joined the Internal Testers group and is offered to both phones as an ordinary TestFlight update. It is a TestFlight upload only - **nothing has been submitted to App Review**. How a build is versioned, archived, signed and uploaded, and the traps that make a broken one look shippable, are in `ios/CLAUDE.md`.
- **Deployed:** everything through the 2026-08-26 field reduction - `fly deploy` to machine v6, migration 0005 run against production, the Pages redeploy in the same session. Production is real and in use: two users, 53 receipts as of 2026-08-27 (78 by 2026-08-28).
- **Deployed 2026-08-28:** a second round of product feedback - `tip_cents`/`other_fees_cents` (partially reversing the 2026-08-26 field reduction), split-HST parsing in both parsers, the parser moved from Haiku 4.5 to Sonnet 5 and made configurable (`RECEIPT_PARSE_MODEL`), `user_events` behavioural telemetry, an iOS export screen, a rewritten image zoom, receipt deletion, and three web-client gap fixes plus a visual redesign. Migrations `0006` and `0007` ran against production (backup taken and restore-verified first), then `fly deploy` to **machine v7**, then the Pages redeploy - all in the same session. Production: **two users, 78 receipts.** ⚠ **The phones are still on 1.0 (2)**, which predates all of the iOS work here; no build carrying it has been made. Record: `docs/DECISIONS.md` 2026-08-28; verification: `docs/gates/product-feedback-2026-08-28.md`.
- **The blocking owner action:** The owner's demo recording on a physical device; then the Resolution Center reply and resubmission. Approval, the unlisted conversion and pressing Release all sit behind it. The Sign in with Apple `.p8` is to be minted **before** the resubmission, so account deletion revokes when the reviewer tests it. Today's build adds one more item to this same queue, **decided 2026-08-28 and deliberately deferred behind the items above**: the App Store Connect privacy label must be refiled to match `PrivacyInfo.xcprivacy`'s new Product Interaction entry. It is a gate, not a preference - **no build carrying that manifest entry may be submitted to App Review until the label declares it too**, because a manifest and a label that disagree is what a reviewer checks. Record: `docs/DECISIONS.md` 2026-08-26.
- **Two owner-held keys are still unminted**, and both are traps rather than status: the R2 `kept-backups` token, without which the nightly backup agent refuses every night; and the Sign in with Apple `.p8` with its three `APPLE_*` secrets, without which account deletion still deletes but revokes nothing (Runbook §0). A verified manual backup was taken 2026-08-27 - dump restored and row-counted, all 53 images hash-checked, copies on the laptop (`~/.kept/backups/`) and in `kept-backups` via wrangler - so the exposure until the token exists is writes since that backup, not everything beyond Neon's 6-hour PITR window.
- What was decided, what deployed when, and what stays deferred on which trigger live in `docs/DECISIONS.md` (newest-first), with the per-wave gate reports in `docs/gates/` and the hardening ledgers in `PROD-READINESS*.md`. This section does not restate them.

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
