# Kept - agent instructions

The spec is `docs/Kept-Build-Spec.md`.
It is the authority for the entire project.

## What this is

Kept is a general-purpose receipt-capture app in production use by two people: an iPhone client that scans a receipt, shows the OCR guesses in an editable form, and a backend that stores the record and generates the year-end export an accountant can import.
`README.md` is the entry point for a reader arriving at the repository; this file and `docs/` are the depth behind it.

The iOS app is a capture-and-confirm client and all domain logic lives in the backend.
HST arithmetic, export generation, filename derivation, fiscal-period slicing, and validation are the server's, deliberately, so a later Android or web client does not have to reimplement them.

`web/` is the browser client; its production enablement steps are in `web/README.md`.

## Production topology

The origin is `https://api.keptapp.net`.
The Fly machine behind it is described by `server/fly.toml`; what is *not* in the repo is Neon Postgres, the Cloudflare R2 bucket `kept`, and Cloudflare proxying the zone `keptapp.net` and carrying the rate limiter.
`server/ops/prod/` holds the compose file and scripts for the planned move of the origin to a VM behind a Cloudflare Tunnel (`docs/proposals/2026-09-03-free-hosting.md`).
Images never transit the API: the client PUTs straight to object storage through a presigned URL.
`docs/Runbook.md` is the operations authority - deploy, migrate, roll back, back up, restore.

## Build and test

Per-directory commands and the notes that make them work live in `server/CLAUDE.md`, `ios/CLAUDE.md`, and `web/CLAUDE.md`.
On a fresh clone run `git config core.hooksPath .githooks` once to enable the gitleaks pre-commit secret scan.

## The success test

A receipt is captured in under a minute and never thought about again.
Every design decision is subordinate to this sentence.

## The three constraints that do not move

1. HST is its own field, never folded into the total.
   (Tip and other fees have their own fields specifically so they have somewhere to go that isn't HST.)
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
  (Reuse of a user's own past values via `GET /api/receipts/options` is a convenience, not a vocabulary.)
- Nothing with `status = 'pending'` may appear in an export.
- No secrets in the repo.
  `.env.local` is gitignored and the owner handles its contents.
- Verify artifacts, not reports.
  Inspect the database, open the generated file, read `git log`.
  An exit code is not evidence.
- Predict before verifying.
  State in writing what you expect an artifact to look like, then look at it, then note the gap.
- Every gate starts the real server the real way before it closes: the production entrypoint (`npm run dev` or the platform equivalent), from a clean checkout, config loaded as an operator would load it, then one real request against it.
  A test suite that injects its configuration can be fully green while the entry point cannot start.

## Production is live

`api.keptapp.net` is a real deployment holding a real database and a real bucket.
Nothing may deploy, migrate against production, write to the production database or buckets, rotate a secret, or change DNS without the owner asking for it in that session.
Read-only inspection of local config and code is always fine.

Real purchase records (receipt import workspaces, per-user reviews) live under `~/.kept/`, deliberately outside this repository; the `imports/` line in `.gitignore` is a guard against an accidental in-repo workspace, not a pointer to one.

## Doc ownership

- When a decision is appended to `docs/DECISIONS.md`, `docs/Kept-Build-Spec.md` is amended in the same commit.
  `DECISIONS.md` is the append-only log of how we got here; the spec is the current state.
  Neither is optional and neither substitutes for the other.
- `docs/DECISIONS.md` is ordered newest-first by decision date: a new entry is inserted at the top of the file, never at the bottom, and a late-reconstructed entry files under the date the decision was made, not the date it was written.

## Review discipline

When reviewing your own or generated code, explicitly hunt duplication and error-masking: catch blocks that swallow signal, empty error handlers, silently-defaulted values.
