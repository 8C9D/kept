# Kept - agent instructions

The spec is `docs/Kept-Build-Spec.md`.
It is the authority for the entire project.

## What this is

Kept is a receipt-capture app for the owner and a second user's business: an iPhone client that scans a receipt, shows the OCR guesses in an editable form, and a backend that stores the record and generates the year-end export an accountant can import.
There is no README; this file and `docs/` are the entry points.

## Layout

- `server/` - the API and all domain logic.
- `ios/` - the SwiftUI client, a capture-and-confirm surface only.
- `web/` - the web client (wave 7, built 2026-08-21): Vite + React + TypeScript SPA - table, detail, confirm queue, backlog upload, export - plus the static privacy page under `public/privacy/`. Gated locally; production enablement is the owner's (`web/README.md`).
- `docs/` - spec, decisions, runbook, per-wave gate reports.
- `reviews/`, `PROD-READINESS*.md`, `DEPLOY-PREP.md` - the hardening rounds and their ledgers.

The iOS app is a capture-and-confirm client and all domain logic lives in the backend.
HST arithmetic, export generation, filename derivation, fiscal-period slicing, and validation are the server's, deliberately, so a later Android or web client does not have to reimplement them.

## Stack

- Server: Node with TypeScript run through `tsx`, Hono, Drizzle ORM over Postgres, zod, jose for session JWTs, `@aws-sdk/client-s3` for object storage, exceljs plus archiver for the export zip, `@anthropic-ai/sdk` for the server-side LLM parse sweep.
- iOS: SwiftUI, VisionKit scanning with on-device Vision OCR, XCTest, deployment target 17.0, bundle id `com.arthurzhang.kept`.
- Web: Vite + React + TypeScript (strict), react/react-dom as the only runtime dependencies, vitest for the client's logic; static build for Cloudflare Pages; API origin baked per build (dev localhost:3000, production `https://api.keptapp.net`), session as the same bearer JWT iOS uses.
- Deployed: one Fly.io machine (`keptapp-api`, region `yyz`, `shared-cpu-1x` at 2 GB), Neon Postgres, Cloudflare R2 bucket `kept`, Cloudflare proxying the zone `keptapp.net` and carrying the rate limiter, origin at `https://api.keptapp.net`.
- Local development: `server/docker-compose.yml` brings up Postgres 16 on 5432 and MinIO on 9000/9001.

## Architecture landmarks

- `server/src/index.ts` is the only place environment variables are read, and it refuses to bind the port until Postgres and object storage both answer.
- `server/src/productionEnv.ts` holds the checks that run only under `NODE_ENV=production`.
- `server/src/app.ts` builds the Hono app from injected dependencies; nothing inside it reads the environment, which is what keeps the test-mode Apple verifier out of production.
- `GET /health` is liveness only and is registered above the edge-secret middleware, because Fly's checker probes the machine directly and cannot carry the Cloudflare header.
- Images never transit the API: the client PUTs straight to object storage through a presigned URL.
- `docs/Runbook.md` is the operations authority - deploy, migrate, roll back, back up, restore.

## Status, as of 2026-08-21 (night)

- The first production deploy happened 2026-08-16 (`docs/gates/wave-6.md` §3 steps 1-13); steps 14-16 completed 2026-08-18: privacy label published, build 1.0 (1) on TestFlight, the owner's phone signed into production and verified end to end (`users 1, receipts 0` - re-read 2026-08-20, unchanged).
- The App Store record is "Kept Receipts" (app id 6802835941) because "Kept" was taken as a store name; the home-screen name stays Kept via `CFBundleDisplayName`. The Fly app is `keptapp-api`, not `kept-api`, for the same reason on that platform.
- **Production-readiness round 4 (the post-deploy pass) ran 2026-08-20**: nine of the eleven carried findings closed and deployed - ledger `PROD-READINESS-ROUND-4.md`. R2-3 and PR-9(b) stay deferred on their 2026-08-15 triggers (both need a realistic production export to measure; production holds zero receipts). Round 4's §4a residuals were closed 2026-08-21 except the pg-9 note, which waits on the pg major bump.
- **Wave 7, the web client, is built and gated against local dev (2026-08-21)** - all §7A screens plus the §6A upload and confirm queue; the §9 gate scenario ran in a real browser (`docs/gates/wave-7.md`). **The wave-7 server is deployed to production (machine version 4, same evening, on the owner's instruction)** with `APPLE_WEB_CLIENT_ID` and `WEB_ORIGIN` set and verified live, and the R2 bucket CORS rule for browser PUTs written and falsified against R2 itself. **Still the owner's**, per `web/README.md`: the Apple Services ID `com.arthurzhang.kept.web`, the Pages deploy of `web/dist` (blocked on the privacy contact address) - which is also what makes the privacy URL exist - and the production sign-in-and-export that closes the wave.
- **CI exists (2026-08-21)**: `.github/workflows/server.yml` runs the backend suite on push against the committed compose file. Its first trigger (the 2026-08-21 push) never started: GitHub refused the job on account billing ("recent account payments have failed or your spending limit needs to be increased"); the workflow is unvalidated on GitHub's runners until billing is fixed and a run executes.
- **Step 17 is executed to the token boundary** (2026-08-20): the nightly launchd backup agent is installed and loaded on the owner's Mac, the pipeline and drill are rehearsed and run (Runbook §4). One piece is the owner's: mint the R2 token scoped to `kept-backups` in the Cloudflare dashboard, paste it into `~/.kept/backup.env`, `launchctl start net.keptapp.backup`, then the §4 drill against that scheduled dump's file. The drill's image leg re-runs after the first receipt with an image lands.
- Step 18, the irreversible unlisted submission, is open and gated on things only the owner can do: accept the updated Apple Developer Program License Agreement as Account Holder, fill the contact address in `web/public/privacy/index.html` and deploy per `web/README.md` (the privacy policy URL becomes `https://keptapp.net/privacy`), paste that URL into App Store Connect, then submit per wave-6 §3 step 18.
- The dev database and MinIO bucket were wiped to zero 2026-08-18 and now hold only the wave-7 gate's fixtures (user `dev:gate`, three confirmed receipts) - disposable, like all dev data.

## Build and test

From `server/`, with `docker compose up -d` running first:

- `npm test` - vitest, unit and integration; the integration tests need Postgres and create their own test database.
- `npm run typecheck` - `tsc --noEmit`.
- `npm run dev` - the real entrypoint, loading `server/.env.local`.
- `npm run db:migrate` - migrations are deliberate and never run on boot.

From `ios/`:

- `xcodebuild test -project Kept.xcodeproj -scheme Kept -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:KeptTests`
- The same command with `-only-testing:KeptUITests` for the UI tests, which need a booted simulator and take about a minute.

From `web/` (after `npm install`):

- `npm test` - vitest over the client's logic (money, query assembly, upload outcomes, prefill/patch rules).
- `npm run build` - typecheck plus the production bundle into `dist/`.
- `npm run dev` - Vite on 5173, the origin the API's dev CORS default grants; sign in with a token from `npm run dev:session-token` (server/).

On a fresh clone run `git config core.hooksPath .githooks` once to enable the gitleaks pre-commit secret scan.

## The success test

A receipt is captured in under a minute and never thought about again.
Every design decision is subordinate to this sentence.

## The four constraints that do not move

1. HST is its own field, never folded into the total, plus the supplier's GST/HST registration number.
2. No OCR value saves without a human confirming it.
   Extracted fields are suggestions in an editable form.
3. Business-vs-personal is set at capture time, never as cleanup.
4. Full per-user isolation.
   Each user sees only their own receipts.

## Engineering rules

- `user_id` always comes from the session token, never from a request parameter.
  An endpoint accepting a user id as input is a bug.
- Money is integer cents.
  Never floats.
- `category` is free text.
  Never introduce an enum, taxonomy, or CRA line mapping.
- `is_business` has no default value at any layer.
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
