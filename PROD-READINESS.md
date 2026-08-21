# Production-readiness ledger - server only

Run artifact, 2026-08-10, branch `prod-readiness/2026-08-10`, from `main` at `ca82907`.
Baseline it is measured against: `reviews/BASELINE.md`.
Adversarial review trail: `reviews/REVIEW-*.md`.

Scope: `server/` and its tooling. `ios/` is out of scope and is not read, changed, or counted.
This file lives at the repo root, not in `docs/`, because it is a record of one run rather than a living document.

---

## 0 · Context, established by inspection

### Stack and commands, from the manifest rather than assumption

`server/package.json` declares an ESM TypeScript project (`"type": "module"`) on Node 24, package manager npm with a committed `package-lock.json`.

- **Framework** Hono 4 on `@hono/node-server` 2.
- **Database** Postgres via `pg` 8 and Drizzle ORM 0.45; migrations by `drizzle-kit` 0.31.
- **Object storage** `@aws-sdk/client-s3` + `s3-request-presigner`, S3-compatible (MinIO locally, R2 in deployment).
- **Auth** `jose` 6 - Apple identity tokens in, HS256 session JWTs out.
- **Export** `exceljs` + `archiver`.
- **LLM parse** `@anthropic-ai/sdk` 0.116.
- **Validation** `zod` 4.
- **Tests** `vitest` 4.

| Command | What it is | Confirmed |
|---|---|---|
| `npm run dev` | The production entrypoint: `node --env-file=.env.local --import tsx src/index.ts` | Yes - see BASELINE, guardrail 7 |
| `npm test` | `vitest run`, 263 tests | Yes - 263 passed |
| `npm run typecheck` | `tsc --noEmit`; **this is the build gate and the linter both** | Yes - clean |
| `npm run db:migrate` | `drizzle-kit migrate`, run deliberately, never on boot | Not run (would write to a database) |
| `docker build .` | The production artifact | Yes - built, exit 0, 714 MB |

**There is no compile step and no bundler.** `tsconfig.json` sets `noEmit: true`; the Docker image runs the same `tsx` entrypoint development runs, deliberately (wave-6 gate §4: a compiled artifact would be a second code shape existing only in production).

**There is no linter.** No eslint/prettier/biome config, no `lint` script. Recorded under NOT DEFECTS.

### How this ships

`server/Dockerfile` → `node:24-slim`, `NODE_ENV=production` baked in, `npm ci --include=dev`, `CMD ["node","--import","tsx","src/index.ts"]`.
`server/fly.toml` → app `kept-api`, region `yyz`, one always-on `shared-cpu-1x` machine at 2 GB, `force_https`, `auto_stop_machines = "off"`.
`docs/Runbook.md` → deploy, migrate, roll back, back up, restore.
Data plane: Postgres on **Neon**, object storage on **Cloudflare R2**, **Cloudflare** proxying in front of Fly and carrying the rate limiter.

**Nothing is deployed.** No remote, no Fly app, no Neon project, no R2 bucket, no registered domain. Every deployment fact above is configuration, not a running system - which is exactly why `fly.toml`, `Dockerfile`, `docker-compose.yml` and the Runbook are in scope for this run and flagged `DEPLOY-CONFIG`.

### Boundaries actually present

- **Network in** - one HTTP listener, four route groups (`/api/auth`, `/api/receipts`, `/api/export`, `/api/me`). Exactly one route is reachable without a session: `POST /api/auth/apple`.
- **Network out** - Apple's JWKS endpoint (`appleid.apple.com/auth/keys`), the S3/R2 endpoint, the Anthropic API.
- **Persistence** - Postgres (four tables) and object storage (receipt images, export zips).
- **Filesystem** - none. Nothing reads or writes local files at runtime; exports are assembled in memory and PUT to storage.
- **Process execution** - one, startup-only: `src/observability/portInUse.ts:1` imports `execFileSync` and shells out to `lsof` from `src/index.ts:132` when the port is already taken. Arguments are not attacker-controlled. Added at REVIEW-0 R-6's request; the inventory's original categories had nowhere to put a subprocess.
- **Auth** - Apple identity token exchanged once for an HS256 session JWT carrying `sub` and `tv`; `tv` re-checked against `users.token_version` on every request. Optional `x-kept-edge-secret` gate ahead of everything.
- **Background jobs** - two, both in-process: the export generator (fire-and-forget after a 202) and the LLM parse sweep (kicked at startup, after captures, and on a 6-hour interval).
- **Third-party APIs** - Apple, S3/R2, Anthropic.

### What "production" means here, and who breaks

Derived from `docs/Kept-Build-Spec.md` §1/§3/§10B, `docs/gates/wave-6.md` §3, and `fly.toml` - not guessed.

Production is **one always-on 2 GB Fly machine in Toronto serving three people** - The owner, a second user, and later a third user - through an **unlisted** App Store link, storing **Canadian tax records under a six-year CRA retention requirement**.

The thing that breaks is not a funnel. It is that **a receipt someone photographed is gone**, and the paper is usually already in the bin by the time anyone would notice. The spec's success test is "captured in under a minute and never thought about again"; the failure that matters is the second half of that sentence turning out to be false at tax time, months later, when nothing can be recaptured.

That ranking governs the severities below. Ahead of it in immediacy but behind it in cost: an unauthenticated stranger with the install link degrading the service for the three real users; and an authenticated user's receipt contents reaching a log that later leaves the machine.

### Prior art this ledger is net of

Read before writing, and **not** re-discovered here:

- `docs/security/review-2026-08.md` and `docs/security/audit-2026-08.md` - findings 0-9 and N1-N5.
- `docs/DECISIONS.md` 2026-08-06 "the owner's rulings on the security review, applied" - **every open finding from both reports was ruled on and implemented.** Verified in source, not taken on trust: `errorSummary`/`redactedMessage` exist and are used at `http/errors.ts:46`, `export/runExportJob.ts:58` and `parse/llmParseSweep.ts:147`; `assertIssuedObjectKey` runs on read at `routes/receipts.ts:285` and `export/generateExport.ts:117`; `assertLocalDatabase` guards `db/seed.ts:14`; money is bounded to int4 at `http/schemas.ts:30-31`; export keys are hoisted to `exports/` at `storage/objectKeys.ts:23`.
- `docs/DECISIONS.md` 2026-08-07 secret-exposure audit - history scanning is done; no remote, no env file ever committed on any ref.
- `docs/gates/wave-6.md` §3 - the eighteen-step deployment checklist, written and unexecuted. Cross-referenced in full in the DEPLOY-CONFIG section below.

Two items were left explicitly open by those rulings and stay open: **the orphaned-object policy** and **iOS per-request token pinning** (out of scope). Both appear under DEFERRED.

---

## 1 · Findings

`id | area | severity | evidence | fix | blast radius`

Severity rubric: **P0** = data loss, security exposure, silent failure, or cannot deploy. **P1** = fails under realistic load or edge input, or undiagnosable in production. **P2** = everything else. Where severity is arguable the lower one is taken and the reasoning is stated.

### P1

**PR-1 · availability · P1 · A terminated idle Postgres connection kills the API process**

*Evidence.* `server/src/db/client.ts:10` constructs `new Pool({ connectionString: databaseUrl })` and attaches **no `error` listener**; `grep -rn "pool.on\|SIGTERM\|process.on" src/` returns nothing in the server path. `pg-pool/index.js:62` re-emits an idle client's error on the pool, and an `EventEmitter` `'error'` with no listener throws.

Reproduced against **the real production entrypoint**, started the real way, not against a harness:

```
$ PORT=3001 node --env-file=<env> --import tsx src/index.ts
Kept API listening on port 3001
$ curl -H "Authorization: Bearer <valid>" localhost:3001/api/me   -> 200
$ psql -c "select pg_terminate_backend(pid) from pg_stat_activity
           where datname='kept_test' and state='idle'"
t
$ ps -p <pid>          -> (empty)
$ lsof -ti tcp:3001    -> (empty)
```

Server log:

```
node:events:487
      throw er; // Unhandled 'error' event
error: terminating connection due to administrator command
  ...
Emitted 'error' event on BoundPool instance at:
    at Client.idleListener (pg-pool/index.js:62:10)
  code: '57P01'
```

*Why this is not theoretical.* The trigger is one idle connection being closed by the server side. **Neon's Free-plan compute autosuspends after ~5 minutes of inactivity**, which is precisely this event, and at three users the API is idle far more than it is busy. Every Neon maintenance window, failover, and connection-limit reap does the same thing. The first probe in this run *failed* to kill the server because an unauthenticated 401 never opens a connection - the crash needs one authenticated request first, which is to say it needs the app to have been used.

*Severity.* P1, not P0, and the reasoning is stated because it is arguable both ways. It is not silent (a stack trace and a process exit), not a security exposure, and **not receipt data loss** - the iOS outbox holds an unsent capture and retries, and any in-flight transaction rolls back. The fourth leg of the argument - that Fly restarts the machine - is **unverifiable in this run** and is filed as ASSUMPTION 8 rather than asserted here (REVIEW-0 R-3). What this is, is a hard crash on an entirely routine event, so it is the highest-blast-radius item on this list.

*Fix.* Attach `pool.on("error", ...)` in `createDb`, logging through `errorSummary` and **not** exiting. `pg` discards the broken client and the next checkout opens a fresh connection; that is the documented contract.

*Blast radius.* One function, `src/db/client.ts`. Adds a listener; changes no query, no response, no schema. Every caller of **`createDb`** gains it - the server, the test harness, and `verifyRestore`. ⚠ **Corrected after REVIEW-1 F-2:** an earlier draft of this line said "dev scripts" too, which overstates it. Five scripts construct `new Pool` directly and are untouched by this fix - see NEXT ROUND N-1.

*Status: RESOLVED.* Artifact, against the real entrypoint started the real way, after the fix:

```
authenticated GET /api/me -> 200
t <- pg_terminate_backend on the idle connection
alive AFTER terminate: '30928'  (process survived)
next request after the kill -> 200

Idle database connection error: DatabaseError [message and detail withheld] code=57P01 routine=ProcessInterrupts
```

One further consequence, found while falsifying and worth stating: the **pre-fix** crash dump printed the pg client's `connectionParameters`, including `password`, to stdout. In development that is `kept`; in production it would be the Neon password. The fix removes that as a side effect of never reaching the uncaught-exception printer, and the redacted line above carries no credential.

Three tests, `tests/integration/dbClient.test.ts`, all three falsified: with the listener deleted, all three fail. The first asserts across a **process boundary** because vitest intercepts the uncaught exception, so an in-process "the process survived" assertion passes either way - which this test's own first draft did, and which is recorded here rather than quietly corrected.

---

**PR-2 · logging / privacy · P1 · The LLM sweep logs raw errors, printing receipt contents the comment two lines above promises it never prints**

*Evidence.* `server/src/parse/llmParseSweep.ts:221` is `console.error(failure.error);` - the raw error object. `:239` is the same in the drain's catch. The comment directly above, at `:212-213`, reads:

> `// Receipt id only - never the OCR text or a vendor name; server`
> `// logs carry no receipt contents (spec §10B).`

The `try` at `:113` spans `writeIfStillNull` at `:121`, so a failed **database write** lands in `failure.error` and is printed raw. `DrizzleQueryError` builds the bound parameters **into its own message** - the fact `docs/DECISIONS.md` (2026-08-06) records as the reason redaction had to be structural.

Reproduced: a receipt whose parse record carries a NUL in the vendor string (Postgres refuses `` inside `jsonb`; OCR text from a photograph can carry control characters, and the model echoes what it is given):

```
LLM parse failed for receipt 778b0193-...; a later sweep retries it
Error: Failed query: update "receipts" set "llm_suggestions" = $1 where ...
params: {"model":"claude-haiku-4-5","promptVersion":2,"requestedAt":"...",
 "suggestions":{"vendor":"Dr Smith Psychiatry Clinic ",
 "purchasedAt":"2026-03-01","totalCents":12345,"hstCents":1600,
 "subtotalCents":10745,"vendorTaxNumber":"123456789RT0001"}},778b0193-...

LEAKED  Dr Smith Psychiatry Clinic
LEAKED  123456789RT0001
LEAKED  10745
```

*Why the prior work did not catch it.* `renderError` and `runExportJob` were both redacted under the 2026-08-06 ruling. `llmParseSweep.ts` was **written afterwards** (2026-08-08, the LLM parse wiring) and reintroduced the class the ruling closed - in a module whose own comment asserts the opposite. The NUL is one reachable trigger; the general one is *any* failed query on that path.

*Severity.* P1. Same class and same ranking the 2026-08-06 ruling gave it: information disclosure into a log that today is a terminal on one Mac and becomes an exfiltration path the moment §10B's error monitor lands. Not P0 - it crosses no isolation boundary (a user's own receipt, in the operator's own log) and needs a failure to fire.

*Fix.* Route both sites through `errorSummary`, which already exists for exactly this.

*Blast radius.* Two log statements in one file. No control flow, no data, no responses.

*Status: RESOLVED, on the database branch, which is the branch that was reported.* Both changed lines are now covered by tests that fail when reverted (`tests/integration/logHygiene.test.ts`), and the sweep's own drain is what drives them - not a re-implementation of its reporting. ⚠ **The model branch of the same `catch` is not closed and is not claimed to be:** `errorSummary` redacts *database* errors specifically, so a parse error's own message and cause chain pass through, and the parser's real failure carries a `SyntaxError` cause quoting the first characters of the model's output. Recorded as **N-2** rather than fixed, because it was found after the work list froze.

---

**PR-3 · observability · P1 · Nothing is logged at the request boundary, so a production failure has no trace at all**

*Evidence.* `server/src/app.ts:66-135` mounts, in order: `onError` (`:68`), the `Cache-Control` middleware (`:82`), the optional edge-secret check (`:93`), and `bodyLimit` (`:112`). **No logging middleware exists anywhere.**

`grep -rn "console\." src/` returns eleven sites reachable in the serving process, and **not one of them is on the request path**:

| Site | When it fires |
|---|---|
| `index.ts:63`, `:100`, `:122` | Startup, once |
| `index.ts:132` | Startup, port already in use |
| `http/errors.ts:46` | Only an **unhandled 500** |
| `routes/exports.ts:111` | Only a failed export job |
| `parse/llmParseSweep.ts:205`, `:214`, `:221`, `:238`, `:239` | Only a sweep run or a sweep failure |

*(This table replaces an earlier enumeration in this ledger that named five sites while calling them four and omitted `routes/exports.ts:111` and the five sweep sites - REVIEW-0 R-2. The omission did not change the finding: none of the omitted sites is on the request path either.)*

So a deployed machine emits three lines at boot and then - for every 400, 401, 403, 404, 409, 413 and every successful request - **nothing**. `fly logs` after a report of "the app says it can't sync" shows the boot banner, plus a line if an export happened to fail. There is no way to tell a 401 storm from a 404 from an idle server, no request rate, no latency, and no correlation between a user's report and anything on the machine.

*Severity.* P1 - this is the rubric's "undiagnosable in prod", stated literally. Not P0: nothing is lost or exposed, and the system is correct while it works.

*Fix.* One middleware in `app.ts` emitting a single structured line per request: method, route path, status, duration, and whether a session was present. **No bodies, no query strings, no receipt fields, no tokens, no user ids** - `q=` on the list route carries vendor text the user typed, and a user id is the first segment of every object key.

*Blast radius.* One middleware in `app.ts`; adds stdout volume (~3 lines per receipt captured, at three users). Changes no response.

*Status: RESOLVED.* Artifact, against the real entrypoint started the real way:

```
{"msg":"request","method":"GET","route":"/api/me/*","status":401,"durationMs":3,"authenticated":false}
{"msg":"request","method":"GET","route":"/api/me","status":200,"durationMs":26,"authenticated":true}
{"msg":"request","method":"GET","route":"/api/receipts","status":200,"durationMs":8,"authenticated":true}
{"msg":"request","method":"GET","route":"unmatched","status":404,"durationMs":0,"authenticated":false}
```

The third line is a `?q=Psychiatry%20Clinic` search: the term does not appear, and neither does the bearer token (`grep -c` for each: 0). Six tests, all falsified.

Two things stated rather than smoothed over. **`route` is not stable per endpoint**: a request refused by the auth middleware reports the middleware's mount pattern (`/api/me/*`) while one that reaches the handler reports `/api/me`. It leaks nothing and both are legible, but a log consumer grouping by `route` sees two keys for one endpoint. **A request that produces no response at all** - Hono rethrows a non-`Error` without calling `onError` - is logged `status: null, threw: true`, because `c.res` is a lazy getter that would otherwise manufacture a 200 and report the one request most worth seeing as a success (REVIEW-2 F-1, fixed in stage).

---

**R-1 · failure behaviour · P1 · A receipt naming an image object that does not exist kills every export of its period, with an error that names nothing**

*Raised by REVIEW-0, not by Stage 0. It joins the frozen work list under the run's rule that Review 0's own findings do.*

*Evidence.* `server/src/routes/receipts.ts:88` gates the create on `isIssuedObjectKey`, which (`src/storage/objectKeys.ts:80-93`) is a **shape** test - user prefix, `yyyy/mm`, a uuid, a known extension. Nothing checks the object exists; the client-asserted `sha256` (`src/http/schemas.ts:132-135`) is never compared against stored bytes. Reviewer's measurement against the real entrypoint: a create naming a never-uploaded key returns **201**, and every export covering that period then fails with

```
{"status":"failed","error":"The specified key does not exist.","downloadUrl":null}
```

`generateExport.ts:166` downloads each image inside the zip build; the first miss aborts the job. **The message names no receipt, no vendor and no date**, so the person has no way to find the row that is jamming their year-end export.

*The honest trigger is not an attacker.* It is a presigned PUT that failed or was interrupted, followed by a create the client still sent - the other half of the severed two-step PR-5 and PR-6 describe.

*Severity.* P1. Nothing crosses a user boundary and nothing stored is destroyed, so not P0; but the export is the one artifact the product exists to produce, and "undiagnosable in production" is the rubric's own P1 wording.

*Fix, and the half of it that is deliberately not taken.* **This run closes the diagnosability half only**: make the failure name the receipt that caused it, so the export becomes actionable. It does **not** add an existence check at create, and that is a judgement rather than an omission - see DEFERRED. Adding one would need an `ObjectStorage` method that does not exist, and it would convert a broken export into a **failed capture**, which is the wrong direction on this project's severity scale: a receipt row that exists with a missing image still holds the vendor, the date, the amounts and the HST, while a refused create sends the person back to a photograph they have probably already thrown away.

*Blast radius.* The error path of one loop in `generateExport.ts`. No schema, no route, no response shape, no new interface method.

*Status: RESOLVED (diagnosability half; the existence check stays DEFERRED). **REJECTED ONCE by REVIEW-3, remediated.*** Artifact - the reviewer's own scenario replayed against the real entrypoint with real MinIO behind it. The create still returns 201, which is unchanged and deliberate; what changed is what the export screen is handed:

*(Annotation, 2026-08-20 - N-4(c): the block below is a hand-wrapped rendering of that response, re-flowed for column width with the job id elided - not the bytes the server emitted. The values are unaltered, but a ledger whose method is "verify artifacts, not reports" should have pasted verbatim; the original response is unrecoverable, so this note is the honest close available.)*

```
create a receipt naming an object never uploaded  -> HTTP 201

GET /api/export/<job>
status: failed
error:  Receipt 9ef955ab-b801-4658-aad6-e36447589a4d has no image in storage,
        so this export cannot be completed - its photo never finished
        uploading. If you still have the paper, delete that receipt and
        capture it again; deleting it first is what lets the same photo be
        accepted. If the paper is gone, deleting the receipt will let the
        export run without it.
```

Before, that field read `The specified key does not exist.`

**What REVIEW-3 rejected, because the correction matters more than the fix.** The first version told the person to *"open that receipt and re-attach its photo"*. **No endpoint in this server can do that** - `updateReceiptSchema` has no `image` key, the PATCH handler has no image branch, and `/upload-url` mints a fresh uuid key on every call. So the message was diagnosable but not *actionable*: it sent someone looking for a control that does not exist, and its only working remedy, delete, silently drops the receipt from every export (`db/receiptQueries.ts:11`) without saying so. A message that names an impossible remedy is worse than the storage error it replaced, because it is confidently wrong.

Two changes came out of it, and the second is the one that would have hurt:

1. The message now names only remedies this server can perform, and states the cost of the destructive one.
2. **Only a genuinely absent object is described as one.** The first version caught *every* download failure, so a storage timeout or a refused credential would have been reported as "this receipt's photo never uploaded" - telling someone to delete a receipt over a network blip, which is the worst available trade on a project whose top severity is a lost receipt. Non-`NoSuchKey` errors now rethrow unchanged.

`tests/helpers/fakeObjectStorage.ts` was corrected in the same change: it threw a nameless `Error`, so a caller conflating "not there" with "storage did not answer" would still have passed. It now carries `name = "NoSuchKey"` like the real client.

Three tests, each falsified independently: reverting to the bare `download` fails the naming test; removing the not-found discrimination fails the storage-outage test. **No receipt field beyond the id is in the string** - the purchase date was in the first version and is gone, because this message is also logged, and `grep` for the user id, the vendor and the date in the server log returns 0.

**REVIEW-3b then passed it, and REVIEW-FINAL corrected it once more. Four corrections from 3b to this same change, all taken:** the remedy order is reversed (capture-then-delete 409s on the duplicate-image index when the re-captured bytes are identical; delete-then-capture does not); `objectStorage.test.ts` now asserts the **real** client names a missing object `NoSuchKey`, which the whole fix pivots on and which only the fake had been asserting; a dead setup block in the storage-outage test is removed (deleting it changed nothing, which is how it was caught); and `isMissingObject`'s comment no longer cites `createBucketIfMissing` as precedent for a name it does not match.

---

### P2 - documented, not fixed

**PR-4 · isolation · P2 · Export zip keys are not re-validated on read, though receipt image keys are**
`server/src/routes/exports.ts:153` presigns `job.objectKey` with no ownership check. The 2026-08-06 ruling ("Stored object keys are re-validated on read, in both places one is dereferenced") added `assertIssuedObjectKey` at `routes/receipts.ts:285` and `generateExport.ts:117`; there are **three** dereference sites, and this is the third. No route writes `object_key` from client input, so reaching it needs direct database access - which the audit itself ranked below a hostile authenticated user. P2 on that precedent. Fix would need an `isIssuedExportKey` predicate in `storage/objectKeys.ts`.

**PR-5 · deploy · P2 · No SIGTERM handling: in-flight requests are severed on every deploy**
`server/src/index.ts` registers no signal handler (`grep` for `SIGTERM|SIGINT|server.close` in `src/` returns nothing). Measured: `kill -TERM` exits the process immediately, port released, no drain. Fly sends SIGINT then SIGTERM on every `fly deploy` and every machine roll. Bounded in consequence - the iOS outbox retries a severed capture and `failAbandonedJobs` reaps a severed export - which is why it is P2 rather than P1. See PR-6 for the retry's own edge.

**PR-6 · idempotency · P2 · A severed-but-committed create is not replayable: the retry gets 409**
`server/src/routes/receipts.ts:144-150` maps `receipt_images_user_id_sha256_uq` to `409 duplicate_image`. If the transaction commits and the 201 never reaches the phone (deploy, crash, network), the client's retry of the identical image is refused rather than answered with the receipt that exists. The server behaves correctly; whether this costs a receipt depends entirely on how the iOS outbox classifies 409, which this run may not read. Logged, with the client half under DEFERRED.

**PR-7 · deploy · P2 · The production image runs as root**
`server/Dockerfile:27` is the last instruction; there is no `USER`. Measured: `docker run --rm kept-api:prod-readiness id` → `uid=0(root)`. Defence in depth only - the process reaches no filesystem at runtime and Fly machines are already isolated - so P2. `DEPLOY-CONFIG` if fixed.

**PR-8 · deploy · P2 · `fly.toml` defines no health check**
`server/fly.toml:13-21` configures `[http_service]` with no `[[http_service.http_checks]]` and no `[checks]`. Fly falls back to a TCP connect on port 3000, which a process that is listening but cannot reach its database still passes. Given PR-1, a machine can be up, listening, and answering 500s while Fly reports it healthy. The Runbook (§1) already names the right probe - `GET /api/me` answering 401 - so this is expressing an existing decision in config, not inventing a health endpoint. `DEPLOY-CONFIG`.

**PR-9 · resilience · P2 · The pool has no connection, statement, or idle timeout and no size cap**
`server/src/db/client.ts:10` passes only `connectionString`. Confirmed from the crash dump's own `ConnectionParameters`: `statement_timeout: false, lock_timeout: false, idle_in_transaction_session_timeout: false, query_timeout: false, connect_timeout: 0`. A hung query holds its connection until Postgres or TCP gives up. Inert at three users; matters against Neon's autosuspend wake latency.

**PR-10 · config · P2 · `drizzle.config.ts` silently falls back to localhost**
`server/drizzle.config.ts:9`: `url: process.env.DATABASE_URL ?? "postgres://kept:kept@localhost:5432/kept"`. *(Cited as `:10` in the first draft - REVIEW-0 R-4.)* Run inside the Fly machine (`fly ssh console -C "npm run db:migrate"`, Runbook §2) with `DATABASE_URL` somehow absent, drizzle-kit would target a localhost database that does not exist there. It fails rather than corrupting anything, and the fallback is what makes a clean checkout work, so P2.

**PR-11 · correctness · P2 · The image soft-delete has no tombstone guard of its own**
`server/src/routes/receipts.ts:415-423` sets `deleted_at` on `receipt_images` with no `deleted_at IS NULL` condition. It cannot overwrite an older tombstone today only because the receipts update above it returns zero rows first and short-circuits at `:409`. Noted by `docs/security/audit-2026-08.md` §4.7 and still true: the guarantee rests on caller ordering rather than on the statement.

**PR-12 · session · P2 · `sub` is not validated as a UUID**
`server/src/auth/session.ts:52` checks `typeof payload.sub === "string"` only. A malformed `sub` reaches Postgres as a uuid parameter and raises an unhandled error → 500. Unreachable without the signing secret; noted in `docs/security/audit-2026-08.md` §4.1 and unchanged.

**PR-13 · supply chain · P2 · The production image ships dev dependencies**
`server/Dockerfile:19` runs `npm ci --include=dev`, deliberately (tsx and drizzle-kit are needed on the machine). The cost, stated: the `esbuild` advisory from `npm audit` ships in the production image. Unreachable - the advisory concerns esbuild's dev server, which nothing starts - and the fix is a major downgrade of `drizzle-kit`, which the prohibitions forbid. Recorded so the trade is a decision rather than an oversight.

---

## 2 · ASSUMPTIONS

Every undeterminable fact was resolved conservatively and is listed here.

1. **`npm run typecheck` is the linter.** No linter config exists. Rather than introduce one (a tooling addition no finding cites), the typechecker is treated as the third gate. Conservative: it means "no worse than baseline" is measured against a real, currently-clean gate.
2. **Guardrail 7 ran with `ANTHROPIC_API_KEY` withheld.** `src/index.ts:104` kicks the sweep at startup whenever the key is set, which would issue real Anthropic requests. The prohibition is absolute, so the key was removed from the environment file for every server start in this run. Consequence, stated: **no code path that calls Anthropic has been executed**, and anything touching `parse/` is verified against local stubs or marked UNVERIFIED.
3. **Guardrail 7 ran on ports 3001/3002.** A two-day-old dev server (pid 31468, started 2026-08-08 15:16) holds port 3000. It was left running - not this run's process to kill.
4. **Crash reproduction used `kept_test`, not the dev database.** Terminating idle backends on `kept` would also have terminated the stale server's connections and crashed a process this run did not start.
5. **Neon Free-plan autosuspend (~5 min) is taken as the operative trigger for PR-1** from Neon's published behaviour and `docs/gates/wave-6.md` §3 step 6. It cannot be measured here - no Neon account exists. PR-1 does not depend on it: `pg_terminate_backend` proved the mechanism, and the trigger only affects how often.
6. **`fly.toml`'s TCP-only fallback health check** is taken from Fly's documented default for an `[http_service]` with no checks block. Unverifiable without a Fly account.
7. **The 409-on-retry consequence in PR-6 is stated as unknown, not as loss.** Determining it requires reading `ios/`, which the scope constraint forbids.
8. **Fly restarts a machine whose process exits.** Load-bearing for PR-1 being P1 rather than P0, and unverifiable here - there is no Fly account and the platform is off limits. Filed at REVIEW-0 R-3's request, because the discipline of quarantining what cannot be measured applies to reasoning that *lowers* a severity at least as much as to a finding itself. If the assumption is wrong, PR-1 is a P0.

---

## 3 · DEFERRED

- **Orphaned objects have no policy.** Left open by the 2026-08-06 rulings, unchanged. An image uploaded whose create never completed is never deleted; `ObjectStorage` (`src/storage/objectStorage.ts`) declares no delete operation at all. Inert - unguessable keys under the uploader's own prefix, no endpoint lists them - and writing a sweep would be a deletion path beside tax records, which is the last thing §10B wants built casually. Needs a written policy, which is a ruling, not a fix.
- **The scheduled `pg_dump` has no destination.** `docs/gates/wave-6.md` §3 step 17 and the Runbook §4 both say retention rests on a dump kept off Neon; nothing schedules it and nowhere is named. It cannot be built here - it needs an account, a bucket, and a credential this run may not create - and it is the single largest gap between "six-year retention" as written and as implemented.
- **Neon's history window is 6 hours on Free.** Already recorded in the spec and Runbook. A plan decision, the owner's.
- **Rate limiting.** §10B requires it; the ruling is that it lands at the Cloudflare edge with the deployment. Building an in-app limiter now would encode a guess about a topology that does not exist. Unchanged.
- **PR-6's client half.** If the iOS outbox treats `409 duplicate_image` as permanent, a severed-but-committed create loses a receipt. Reading or changing `ios/` is outside this run's scope. **Implication recorded for the next iOS pass: check `OutboxController`'s classification of 409 before PR-5/PR-6 are called closed.**
- **R-1's other half: an existence check on the image object at create time.** Deliberately not taken, with the reasoning stated at the finding: it needs an `ObjectStorage` method that does not exist (the interface declares four and no `head`), and it would trade a broken export for a **refused capture**, which is the wrong direction when the paper is usually already gone. That is a ruling for the owner, not a drive-by fix. A digest check has the same shape and the same objection. What this run does instead is make the existing failure name the row.
- **iOS per-request token pinning.** Left open 2026-08-06; out of scope.
- **R2 key normalization.** `npm run storage:probe-keys` exists and works against MinIO; R2 needs credentials. Unchanged.

---

## 4 · NOT DEFECTS

Considered and rejected as findings, recorded so they are not re-litigated.

- **No linter.** A tooling addition no finding cites. `tsc --noEmit` under `strict` + `noUncheckedIndexedAccess` is doing the load-bearing work.
- **Forward-only migrations.** `docs/Runbook.md` §2 states there is no down migration and gives the two remedies. A recorded decision, not an omission.
- **`^`-ranged dependencies.** The build is reproducible regardless: `package-lock.json` is committed and the Dockerfile runs `npm ci`, which honours the lock exactly.
- **`kept/kept` and `kept-local-dev` in `docker-compose.yml` and `s3ObjectStorage.ts:38-45`.** Local-container credentials for containers holding synthetic data, on the reasoning already recorded in both files. Not secrets.
- **No `iss`/`aud` on the session JWT.** Checked-and-deliberate per `docs/security/review-2026-08.md` §1; one secret, one token type, one verifier. The trigger to revisit is a second token type.
- **No CORS or security headers.** Fail-safe with only native clients; becomes a real decision at wave 7. Recorded there already.
- **Export assembled in memory at a 256 MiB budget.** Measured at 891 MiB RSS and the machine sized to it (2 GB); a ratified decision, not a defect. ⚠ **With one correction to the sizing argument, which is not a defect either but should not be quietly inherited** (REVIEW-0 R-5): `fly.toml:25-27` justifies the 2 GB on "exports are serialized one-per-user", and `src/db/schema.ts:156` scopes `export_jobs_one_active_per_user_uq` to `userId`. So the serialization is **per user**, and nothing bounds how many users export at once - three concurrent 250 MiB exports are permitted by every guard in the system, on one 2 GB machine. Unmeasured here (three concurrent quarter-gigabyte exports would measure this laptop, not a `shared-cpu-1x`), and the 2026-08-06 ratification already recorded "⚠ Nothing serializes concurrent exports, so two at once doubles this. Acceptable at three users." Recorded so the sentence "the machine sized to it" is read as true of one export and unexamined for the case the schema allows.
- **`db:seed`'s unconditional deletes.** Guarded by `assertLocalDatabase` at `src/db/seed.ts:14`. The audit's N4 is closed.
- **The 6 `npm audit` moderates.** Unchanged from baseline, both assessed as unreachable, both fixed only by major downgrades the prohibitions forbid.
- **gitleaks' weakness on opaque secrets is narrower than recorded.** The 2026-08-07 entry states gitleaks is shape-based and weak on values like `SESSION_SECRET`. Measured against gitleaks 8.30.1: staging `SESSION_JWT_SECRET=<60 random chars>` and `EDGE_SHARED_SECRET=<52 random chars>` in a `.env`-shaped file → **both caught**; in a `.ts` file, `const SESSION_JWT_SECRET = "..."` → **caught**, `export const EDGE = "..."` → **missed**. So the residual gap is a high-entropy literal under a variable name containing no secret-like keyword. The hook is not decorative and needs no change; the recorded limit is refined rather than contradicted.

---

## 5 · CANNOT ASSESS

- **Anything against Fly, Neon, R2, or Cloudflare.** No accounts; prohibited regardless.
- **Any Anthropic-calling path** - `src/parse/claudeReceiptParser.ts`, `src/db/llmBackfill.ts`, `llmParseProbe.ts`, `llmPromptReparse.ts`, and the sweep's real parse function. PR-2 is proved against the sweep's *database* write path, which needs no model call; the model-error branch of the same log line is UNVERIFIED by the same prohibition.
- **The rate limiter's effectiveness.** No traffic, no edge.
- **Whether Fly's TCP health check behaves as documented.** No Fly account.
- **The iOS half of PR-6.**
- **Real-world Neon connection churn frequency.**

---

## 6 · DEPLOY-CONFIG cross-reference: wave-6 §3's eighteen steps

Every step marked covered / uncovered / superseded by this run. **Sixteen of eighteen need an account, a payment method, a browser, or Apple's portal, and remain the owner's**; this run can only change what the repository says about them.

| # | Step | Status |
|---|---|---|
| 1 | Cloudflare account, register `keptapp.net` | **Uncovered** - The owner's |
| 2 | Create R2 bucket `kept` | **Uncovered** - The owner's |
| 3 | R2 API token | **Uncovered** - The owner's |
| 4 | Lifecycle rule, prefix `exports/`, 30 days | **Uncovered** - The owner's. The key layout it needs is in place (`storage/objectKeys.ts:23`) |
| 5 | Neon project, pooled connection string | **Uncovered** - The owner's |
| 6 | Decide the Neon plan | **Uncovered** - The owner's. Bears on DEFERRED (history window) |
| 7 | `fly launch --no-deploy` | **Uncovered** - The owner's |
| 8 | `fly secrets set` | **Uncovered** - The owner's |
| 9 | `fly deploy`, then `db:migrate` over ssh | **Uncovered** - The owner's |
| 10 | `curl` the origin, expect 401 + `no-store` | **Uncovered** as a deployed check. Covered locally at baseline against the real entrypoint |
| 11 | Proxied CNAME, rate limit rule, transform rule | **Uncovered** - The owner's |
| 12 | Run `storage:probe-keys` against R2 | **Uncovered** - needs credentials |
| 13 | Re-run step 10 against `api.keptapp.net` | **Uncovered** - The owner's |
| 14-16, 18 | Apple: privacy label, archive, TestFlight, submit | **Uncovered** - out of scope (iOS) |
| 17 | Scheduled `pg_dump` kept off Neon | **Uncovered**, and recorded under DEFERRED as the largest retention gap |

**Nothing in §3 is superseded by this run.** PR-8 (a health check in `fly.toml`) would *add* to step 10 rather than replace it, since step 10's whole point is that a real route beats a health check.

---

## 7 · Status

Filled in as passes complete. The frozen work list is the P0/P1 set surviving Review 0.

**The work list froze at REVIEW-0** and is `PR-1, PR-2, PR-3, R-1` - four items, no P0, under the fifteen-item cap so nothing was dropped for size. Ordering within the band is by blast radius, smallest first.

**Passes run, and passes skipped.** One commit per pass, skipping any pass no frozen finding touches:

| Pass | Ran? |
|---|---|
| 1 · Secrets, authn/authz, injection, vulnerable deps | **Skipped** - no frozen finding. Live source was read at Stage 0 and the gitleaks limit re-measured (NOT DEFECTS); history scanning was already done 2026-08-07 |
| 2 · Correctness, resource leaks, Node/TS failure modes | **Ran** - PR-1 |
| 3 · Migrations, constraints, transactions, restore path | **Skipped** - no frozen finding. Migration reversibility is a recorded decision, and the restore was tested 2026-08-07 |
| 4 · Timeouts, retries, idempotency, dependency-down behaviour | **Ran** - R-1 |
| 5 · Structured logging, error reporting, health signal | **Ran** - PR-2, PR-3 |
| 6 · Reproducible build, pinned deps, startup config validation | **Skipped as a code change** - no frozen finding. The build was verified (`docker build`, exit 0) and wave-6 §3 is cross-referenced in full in §6 below |
| 7 · Tests | **Folded into each pass**, so every fix ships with the assertion that fails without it, rather than arriving as a separate commit after the fact. The log-hygiene suite is the "single path that would hurt most if it broke silently" |

| id | severity | status |
|---|---|---|
| PR-1 | P1 | **RESOLVED** - artifact at the finding |
| PR-2 | P1 | **RESOLVED** (database branch; model branch → N-2) |
| PR-3 | P1 | **RESOLVED** - artifact at the finding |
| R-1 | P1 | **RESOLVED** (diagnosability half; existence check DEFERRED) |
| PR-4 … PR-13 | P2 | DOCUMENTED, not fixed |

---

## 8 · NEXT ROUND

Findings discovered after Review 0 - by any reviewer or by the builder - recorded with full evidence and **not** fixed in this run. The work list froze at Review 0; these are the next one's input.

**N-4 · P3 · Three review findings accepted during the run and neither fixed nor carried** *(REVIEW-FINAL X-4, which is itself the finding: they were agreed with in passing and then dropped)*
(a) `src/observability/requestLog.ts` reads `c.req.routePath`, which hono marks deprecated (REVIEW-2); it works on hono 4.13 and the replacement is a different call, so it is a churn-now-or-churn-later choice rather than a defect. (b) `isMissingObject` in `src/export/generateExport.ts` duplicates the shape of `isNotFound` in `src/storage/s3ObjectStorage.ts`, and asking an S3 error's `name` inside the export module is the export layer reaching through the `ObjectStorage` abstraction (REVIEW-3b); the honest close is for `ObjectStorage` to express "not found" as its own type, which is an interface change no frozen finding cites. (c) The artifact block quoted in R-1's status is re-wrapped for width rather than verbatim (REVIEW-FINAL); the values are unaltered, but a ledger whose method is "verify artifacts, not reports" should paste rather than tidy.

**N-5 · P3 · Every request-log line for a pre-routing refusal reads `route: "unmatched"`** *(REVIEW-FINAL X-2)*
The edge-secret 403 and the body-limit 413 answer before hono routes, so they share the 404's label. Now pinned by test and stated in the code rather than left to be discovered, and the status code separates the cases - but a log consumer grouping by `route` sees three different events under one key. Closing it properly means labelling refusals distinctly without echoing the client's path, which is a design question rather than a line change.

**N-3 · P3 · The duplicate-image index makes "re-capture the same paper" order-dependent** *(REVIEW-3b)*
`src/db/schema.ts:187-189` scopes `receipt_images_user_id_sha256_uq` to live rows, so re-capturing a receipt whose photo produces byte-identical output 409s *until* the old row is tombstoned. Correct behaviour, and the export failure message now names the working order (delete, then capture) - but the ordering is a rule a person has to be told rather than one the API expresses, and nothing tells them anywhere else.

**N-2 · P2 · The parse sweep's model branch still logs the first characters of the model's output, which is derived from the receipt** *(REVIEW-2 F-3)*
`errorSummary` is a **database-error** redaction: `src/observability/errorSummary.ts:112-118` renders any error without a database marker as `${name}: ${error.message}` plus stack, and `:83-84` walks the `cause` chain to depth 5 doing the same. `src/parse/claudeReceiptParser.ts:84` throws `LlmParseError("Model response was not parseable JSON", { cause })` where the cause is `JSON.parse`'s `SyntaxError`, whose V8 message quotes the start of the model's output - and the model's output is derived from the receipt's own OCR text. Measured by REVIEW-2 locally, with no API call: `caused by SyntaxError: Unexpected token 'D', "Dr Smith P"... is not valid JSON`. Roughly ten characters of a vendor name, against the whole record PR-2 reported, which is why it is P2. Not fixed here: the work list froze at Review 0, and closing it means deciding what a non-database error may keep, which touches every `errorSummary` caller.

**N-1 · P2 · Five dev scripts build their own `Pool` and still carry PR-1's defect** *(REVIEW-1 F-2)*
`src/db/seed.ts:20`, `src/db/claim.ts:25`, `src/db/llmParseProbe.ts:56`, `src/db/llmPromptReparse.ts:53`, `src/db/parseAccuracyReport.ts:26` each call `new Pool(...)` directly rather than `createDb`, so none of them gained the error listener. The consequence is far smaller than PR-1's - these are short-lived operator scripts, not the serving process, and a crash mid-run is visible to the person who typed the command - which is why it is P2 and why it is here rather than on the frozen list. The systematic close is to route them through `createDb`, which is a refactor no frozen finding cites.
