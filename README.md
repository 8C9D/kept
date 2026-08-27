# Kept

Kept is a receipt-capture system for a small business's bookkeeping. You scan a
paper receipt with your phone, the app reads it on-device and shows you what it
read as an editable form, and once you confirm the numbers the record is the
server's. At year end the server assembles the whole period into a single
archive an accountant can open. About 34,000 lines of Swift and TypeScript: a
SwiftUI iPhone client, a browser client, and the backend that owns every rule
either of them displays. The backend runs in production on Fly.io behind
Cloudflare; the iPhone build is on TestFlight and in use.

The success test the whole design answers to: a receipt is captured in under a
minute and never thought about again.

## Screenshots

*Not yet in the repository.* Three are worth adding here: the scan, the confirm
screen with its per-field suggestions, and the year-end export.

## Architecture

Three deployables and one rule about where thinking happens.

```
 iPhone (SwiftUI)              Browser (React)
  VisionKit scan                 file upload
  on-device OCR                      │
  durable outbox                     │
        │                            │
        └────── bearer JWT ──────────┘
                    │
                    ▼
        Cloudflare (proxy, rate limit,
        x-kept-edge-secret injection)
                    │
                    ▼
          API — Hono on Node (Fly.io)
       HST arithmetic · validation · export
       fiscal periods · filename derivation
            │                     │
            ▼                     ▼
      Neon Postgres         Cloudflare R2
        (Drizzle)         (presigned PUT/GET)
```

**The iOS app is a capture-and-confirm surface and nothing more.** HST
arithmetic, export generation, filename derivation, fiscal-period slicing and
validation all live in the backend — deliberately, so that adding a client does
not mean reimplementing the money rules. That decision is what let the web
client be a few hundred lines of React instead of a second engine.

**Images never transit the API.** A client asks for a presigned URL, PUTs the
JPEG straight to object storage, and then creates the receipt row referencing
the key it was issued. The API's request bodies are all small JSON, which is why
it can run under a strict body limit and why a slow upload never occupies a
request thread.

**Clients talk to the API with a bearer JWT** minted from Sign in with Apple.
The same token works from iOS and from the browser; the browser additionally
needs an exact-origin CORS grant that the server reads from configuration, never
from the request.

| Path | |
| --- | --- |
| `POST /api/auth/apple` | exchange an Apple identity token for a session |
| `POST /api/receipts/upload-url` | presigned PUT for one image |
| `POST /api/receipts` | create, pending or confirmed |
| `GET /api/receipts` | list, filtered and sorted |
| `GET/PATCH/DELETE /api/receipts/:id` | detail, edit, soft delete |
| `GET /api/receipts/options` | the user's own past categories and payment methods |
| `POST /api/exports`, `GET /api/exports/:id` | start a year-end export, poll it |
| `GET/PATCH/DELETE /api/me` | profile and account deletion |

## Engineering decisions worth reading

### The outbox: nothing captured is lost because the server was unreachable

Capture must not depend on the network. A store basement has no signal, and the
person scanning still has the paper in their hand — a false "saved" is the one
unforgivable answer. So the capture flow writes each scanned page to a durable
on-disk queue (`ios/Kept/Outbox/`) and returns immediately; a background drain
does OCR, the presigned upload and the create, retrying with backoff.

The invariant it maintains is that there is no state between "on this phone" and
"the server has it": an outbox row means the former, a row in the list means the
latter, and nothing is ever displayed as saved on the strength of an optimistic
guess. Consequences that fell out of it:

- **An enqueue failure is surfaced, not swallowed.** A full disk means the save
  genuinely failed and the person needs to hear it.
- **Retryable and permanent failures are different states.** No signal pauses an
  item; a corrupt image stops it and asks for a human. Nothing retries forever,
  and nothing disappears quietly — records that fail to read back are counted
  and stated on the home screen rather than skipped.
- **The drain re-checks the signed-in user at every step boundary**, not once
  per pass. Every `await` is a point where a sign-out or an account switch may
  have run, and a mid-flight one would otherwise upload one user's receipt under
  another's session.
- **The drain is single-flight by task identity**, so a double-tapped retry
  cannot start a second pass over the same item.

### Per-user isolation, enforced by tests that run on every push

The security property the project is built around: a user can never see, change,
or learn about another user's receipts. Two rules make it structural rather than
aspirational.

`user_id` always comes from the session token, never from a request parameter —
an endpoint that accepts a user id as input is a bug by definition. And every
denial is a **404, never a 403**, because a 403 confirms the resource exists.

`server/tests/integration/isolation.test.ts` walks the surface with two
signed-in users: the 404 on read, update and delete; the absence from the other
user's list; a create or update body that tries to smuggle in a user id; an
image key belonging to someone else's prefix, or one that walks out of the
session user's prefix; and a download URL for an object the caller does not own.
`auth.test.ts` covers the token boundary itself.
`.github/workflows/server.yml` runs the full suite — plus `tsc --noEmit` — on
every push, against the same Postgres and MinIO images `docker compose` brings
up locally, so the guarantee cannot quietly regress.

### Two parsers, merged per field, and neither of them saves anything

On-device Vision OCR gives raw text and a heuristic parser turns it into
suggested fields. Separately, a server-side sweep sends the stored OCR text
(and only the OCR text — never a field a human typed) to Claude Haiku for
structured extraction. Both records are written verbatim and are immutable: no
route updates either one, which is what makes per-field accuracy measurable
after the fact by comparing suggestions against what the human went on to
confirm.

The merge is a domain-layer function so both clients render the same answer:

- **Amounts come from the heuristic only**, with no fallthrough. This was
  amended after a live parse read `SUBTOTAL 43.49` as a total. An absent amount
  is visible and costs one keystroke; a wrong amount that passes unflagged
  reaches an accountant.
- **Vendor comes from the LLM**, which is better at it than a regex over noisy
  text.
- **The date trusts neither alone.** When the two disagree the field is flagged
  and the confirm screen marks it as needing attention.

The sweep runs over rows rather than inline in the create route, for the same
reason export jobs are rows rather than process memory: the work's state *is*
the receipt row, so a restart loses nothing and the next sweep picks it up. The
`UPDATE` re-checks `llm_suggestions IS NULL`, so overlapping sweeps land exactly
one writer.

And under all of it, constraint 2: **no OCR value saves without a human
confirming it.** Extracted fields are suggestions in an editable form. Rows are
`pending` by default — fail-closed — and nothing pending may appear in an
export.

### The export is the artifact the whole system exists to produce

`POST /api/exports` starts a job; the client polls it. The result is one archive
containing the period's receipts as **XLSX, CSV and JSON**, plus every image,
filed under derived names. All three encodings are generated from a single
column definition (`server/src/export/writeFiles.ts`), so they are the same
dataset by construction rather than by three lists that happen to agree today —
a column added in one place without the other is a compile error. Money is
integer cents everywhere and never a float; the XLSX writes numeric cells with a
two-decimal format, derived from the cents string rather than by dividing by 100
in floating point, so the accountant's totals sum correctly.

Assembly is bounded by bytes rather than row count, and an export too large to
fit is refused with a reason the user can act on — export a shorter period —
instead of an OOM.

### Smaller rules that shaped the schema

- **HST is its own column, never folded into the total.**
- **`category` is free text.** No enum, no taxonomy, no CRA line mapping; a
  user's own past values are offered back as a convenience, not a vocabulary.
- **Deletes are soft.** Retention requirements make hard deletes off the table,
  and soft-deleted rows are excluded from every list, count and export.
- **A database check constraint backstops confirmation**, so confirming can
  never be partial even if a route stops validating.
- **Migrations never run on boot** — they are deliberate, and the entrypoint
  refuses to bind the port until Postgres and object storage both answer.

## Running it

Node 24 and Docker for the backend; Xcode for the app.

### Backend

```sh
cd server
docker compose up -d          # Postgres + MinIO, the same images CI uses
npm install
npm run db:migrate
npm run storage:init          # create the bucket the startup probes expect
npm run dev                   # the real entrypoint, on :3000
```

`.env.local` holds the configuration (`DATABASE_URL`, `SESSION_JWT_SECRET`,
storage credentials, and `ANTHROPIC_API_KEY` if you want the LLM sweep — without
it the server runs heuristic-only). It is gitignored and has no committed
example; `docs/Runbook.md` lists what production expects.

```sh
npm test                      # integration tests create their own database
npm run typecheck
npm run dev:session-token     # a session token for the dev clients
```

### iOS

```sh
open ios/Kept.xcodeproj
xcodebuild test -project ios/Kept.xcodeproj -scheme Kept \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -only-testing:KeptTests
```

The scanner and the on-device OCR need a real device; the simulator runs
everything else. A Debug build carries a server-settings screen for pointing the
app at a backend on your Mac — it is compiled out of a Release build, where the
address is not configuration.

### Web

```sh
cd web
npm install
npm run dev                   # Vite on 5173 — strictPort, since the API's dev
                              # CORS grant names exactly that origin
npm test
npm run build                 # tsc + bundle into dist/
```

The dev build signs in by pasting a session token; the production bundle carries
Sign in with Apple and none of the dev affordance, which is asserted against the
built bundle rather than the source.

## Stack

| | |
| --- | --- |
| iOS | SwiftUI (iOS 17+), VisionKit document scanner, Vision OCR, Keychain, strict concurrency set to `complete` |
| Backend | TypeScript, Hono on Node 24, Drizzle ORM, Zod, `jose`, ExcelJS, Anthropic SDK |
| Data | Postgres (Neon in production), S3-compatible object storage (Cloudflare R2; MinIO locally) |
| Web | React 19, Vite |
| Infra | Fly.io origin, Cloudflare proxy + rate limiting + Pages, GitHub Actions |
| Tests | vitest (416 backend + 38 web cases), XCTest (251 Swift cases, unit + UI) |

## Repository map

```
ios/          SwiftUI client — Capture, Confirm, Outbox, Parsing, Networking, Session
server/       Hono API — routes/, domain/, export/, parse/, storage/, auth/, db/
web/          React client (see web/README.md for the deployment order)
docs/         Kept-Build-Spec.md (the authority), DECISIONS.md (append-only log),
              Runbook.md (deploy, migrate, roll back, back up, restore), gates/
```

`docs/Kept-Build-Spec.md` is the current state of the design and
`docs/DECISIONS.md` is how it got there, newest first. They are maintained
together: a decision that reaches the log without amending the spec is the
failure mode that ledger exists to prevent.

## A note on secrets

`.env.local` is gitignored and no secret is committed. A `gitleaks` pre-commit
scan enforces it — on a fresh clone, run `git config core.hooksPath .githooks`
once to enable it.
