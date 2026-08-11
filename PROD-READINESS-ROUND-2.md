# Production-readiness ledger, round 2 - server only

Round 2 of the hardening pass, on branch `prod-readiness/round-2`, cut from `prod-readiness/2026-08-10` at `b23ea08`.
Round 1's files (`PROD-READINESS.md`, `reviews/BASELINE.md`, `reviews/REVIEW-*.md`) are left intact and unedited.
Round 2's review trail is `reviews/round2/`.

Baseline: `reviews/round2/BASELINE.md`. It reproduces - 276 tests green, `tsc --noEmit` clean, `npm audit` 6 moderate - so there is no P0 for "the baseline does not reproduce" and the run continues.

Scope: `server/` and its tooling. `ios/` was not read, changed, or counted.
Deploy configuration (`fly.toml`, `Dockerfile`, `docker-compose.yml`, the Runbook) is in scope and every change to it is flagged `DEPLOY-CONFIG`.

Severity rubric, unchanged from round 1: **P0** = data loss, security exposure, silent failure, or cannot deploy. **P1** = fails under realistic load or edge input, or undiagnosable in production. **P2** = everything else.
Receipt data loss is the top of the scale; everything is weighed against that rather than against generic web-app risk.
Where severity is arguable the lower one is taken and the reasoning is stated.

---

## 0 · What Stage 0 actually did

Round 1's ledger was treated as a list of **claims to re-verify**, not findings to inherit.
Every candidate below was checked against live source at `b23ea08`: does the cited line still say what it is said to say, is the severity defensible on this round's own reading, and does the fix stay in scope.

Two candidates changed status on re-verification, and both changes are *against* this round's interest in having work to do:

- **PR-5 was proposed for elevation to P1 and the elevation was withdrawn.** The argument was that round 1's P2 reasoning is circular: PR-5 is P2 because "the iOS outbox retries a severed capture", and PR-6 says an identical retry is refused with 409. Following it through kills it. The retry is refused *only* in the case where the transaction committed - and in that case the receipt is already in the database and appears on the next list fetch. The case where the retry matters (transaction did not commit) is the case where the retry succeeds. Nothing is lost either way. **PR-5 stays P2.** Recorded because a severity inflated and then withdrawn is worth more in the log than one that was never tested.
- **N-2's blast radius was measured and came out smaller than feared.** See N-2.

Nothing was struck as fabricated. Every round-1 citation re-checked to the line.

### The hunt: what round 1 asked two of three questions about

Round 1's stated weakness was auditing the create path for ownership and idempotency and never for existence.
Run as a lens over the rest of the system, the same shape holds in three places, two already on the list and one new:

| Subject | Q1 | Q2 | Q3 | Missing |
|---|---|---|---|---|
| Stored object keys | validated on write | validated at the detail route | validated at export generation | validated at **export download** - **PR-4** |
| The export artifact | nothing pending reaches it | every row has its image | every cell reads as **data, not a formula** | **R2-2**, new |
| Startup configuration | is it **present**? | is it **production-shaped**? | does the service it names **answer**? | **R2-1**, new |

**R2-1 is the round's finding.** It is the same defect class round 1 named - a check that asks whether something is well-formed and never whether it is there.

---

## 1 · Findings

`id | area | severity | evidence (file:line) | fix | blast radius`

### P1

**R2-1 · startup · P1 · The entrypoint checks that configuration is present and production-shaped, never that either backing service answers - and the deploy check the Runbook prescribes cannot tell the difference**

*Evidence.*
`server/src/index.ts:32-40` refuses to start on a missing environment variable.
`server/src/index.ts:48` calls `assertProductionEnv`, which checks the deployed *shape*: storage configured, endpoint `https`, database not loopback, secret long enough, Anthropic key present (`src/productionEnv.ts:34-83`).
`server/src/index.ts:78` then calls `createDb(databaseUrl)`, and `pg`'s `Pool` connects **lazily** - `src/db/client.ts:11` constructs it and nothing checks a connection out.
Storage is probed at `src/index.ts:66-75`, but only inside `if (configuredStorage === null)` - the *local-dev* branch. A production `STORAGE_*` configuration is never touched before `serve()`.

So both questions asked at startup are about the string. Neither is about the service.

*Reproduced against the real entrypoint, with a deliberately wrong database password:*

```
$ PORT=3012 node --env-file=<env with DATABASE_URL=postgres://kept:WRONG-PASSWORD@localhost:5432/kept> \
    --import tsx src/index.ts
ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only
Kept API listening on port 3012

$ lsof -ti tcp:3012
48521                       <- listening

$ curl -s -i http://localhost:3012/api/me
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: application/json
content-length: 79

{"error":{"code":"unauthorized","message":"A valid session token is required"}}
```

**That 401 is the deploy's own success criterion.**
`docs/gates/wave-6.md:137` step 10 reads, verbatim: "**Confirm it is real:** `curl -i https://kept-api.fly.dev/api/me` must answer **401** with `Cache-Control: no-store`. Not a health check - a real route." Step 13 repeats it against `api.keptapp.net`.
It passes here against a server that cannot reach its database at all, because `sessionAuth` throws `unauthorizedError()` at `src/http/sessionAuth.ts:28-30` - on the missing `Authorization` header, *before* the `users` lookup at `:40`. The 401 path never opens a connection. (5 ms, per the request log.)

**In fairness to the Runbook, which states its own scope correctly.** `docs/Runbook.md:77` says a 401 "proves routing, TLS, the app, and the auth middleware all ran" - and that is exactly true, and does not claim the database was reached. The gap is not a false sentence in the docs; it is that nothing else in the running system asks the question either.

**And in fairness to the deploy sequence, which does touch both services - once.** `docs/gates/wave-6.md` §3 step 9 runs `db:migrate` over ssh and step 12 runs `storage:probe-keys` against R2, so a wrong credential is caught at the **first** deploy.
Neither is re-run afterwards, deliberately: `server/Dockerfile:16-18` records that drizzle-kit is on the machine so migrations can be run "deliberately from inside the machine (never on boot)".
So the exposure is every deploy after the first, and every machine restart - a rotated or mistyped `fly secrets set`, a Neon credential change, a plan change - after which the process comes up listening, the TCP check passes (PR-8), the `curl` check passes, and every authenticated request answers 500.

The first request that does need the database:

```
$ curl -H "Authorization: Bearer <session token signed with the real secret>" localhost:3013/api/me
status=500
```

Server log:

```
Unhandled error: DrizzleQueryError [message and detail withheld]
  caused by DatabaseError [message and detail withheld] code=28P01 routine=auth_failed
{"msg":"request","method":"GET","route":"/api/me/*","status":500,"durationMs":151,"authenticated":false}
```

*Why P1, and the P2 argument in full, because this severity moved twice while Stage 0 ran.*

The P2 case is real and should be read before the P1 case: nothing is lost, the pool self-heals the transient version of this (Neon waking from autosuspend recovers on the next checkout, with no process intervention), and the persistent version is diagnosable the moment traffic arrives - `code=28P01 routine=auth_failed` is exactly the right fact, kept readable by round 1's PR-2 redaction and surfaced by its PR-3 request log. So this is not "undiagnosable in production".

It is graded **P1** on the narrower ground that survives that: the failure is **unsignalled**, and it is reachable by a routine operation. Every deploy after the first, and every machine restart, brings a process up against whatever credentials `fly secrets` currently hold, with nothing between "the string is well-formed" and "serve traffic". A mistyped or rotated secret then produces a machine that is listening, passes the TCP check, passes the documented `curl` check, and answers 500 to every real request - and the only thing that will ever tell anyone is a person opening the app. "Fails under realistic load or edge input" is the P1 band, and a wrong value in `fly secrets set` is realistic edge input.

*Why not P0.* No data is lost, no isolation boundary moves, the failure is not silent once traffic arrives, and the deploy does complete. Stingy, as instructed.

*What would deflate it to P2.* If Review 0 judges that "a wrong secret after the first deploy" is too narrow a conjunction to count as realistic, P2 is defensible and the work list is then empty. That is a legitimate outcome of this round, not a failure of it.

**REVIEW-0 declined the deflation and kept it P1, on narrower ground than the one offered above** - not on how likely a mistyped secret is, but on this: the project's deploy verification, documented in three places, returns green against a machine that cannot reach its database, and a check that returns green on a broken system converts operator attention into false confidence. REVIEW-0 also reproduced the whole chain independently.
It added one fact that strengthens the finding beyond what was claimed here: **with the current `.env.local`, `STORAGE_*` is set, so the MinIO probe at `src/index.ts:66-75` does not run in local development either.** No configuration this repository can produce touches object storage before `serve()`.
And one constraint on the fix, honoured in pass 4: the storage probe must **not** add a `head` operation to the `ObjectStorage` interface, because RULING 1 reserves that decision. `createBucketIfMissing` is already a module-level function the entrypoint imports, so a sibling `assertBucketReachable(config)` is the in-scope shape.

*Fix.* Probe the database once at startup and refuse to serve if it never answers, with a bounded retry so a cold Neon compute (which autosuspends, and is the expected deployment) is waited for rather than crashed on. Probe configured object storage the same way with a read-only `HeadBucket` - never `CreateBucket`, which `src/storage/s3ObjectStorage.ts:149-162` already reserves for local development on the stated reasoning that a deployed bucket is provisioned deliberately.
No new endpoint, no new configuration key, no schema change: this extends the startup posture `src/index.ts:21-25` and `src/productionEnv.ts:4-33` already state in their own comments ("stop at startup with the fix named, not later, at the first request that needed it").
The probe must carry its **own** timeout rather than the pool's, because PR-9 records that `connectionTimeoutMillis` is unset (`0` = wait forever) and PR-9 is not on this round's list.

*Blast radius.* `src/index.ts`, plus one exported probe helper. No route, no schema, no middleware, no client-visible behaviour except that a misconfigured process exits instead of listening.

---

### P2 - documented, not fixed

Carried from round 1 unless marked new. Each was re-verified at `b23ea08`; line numbers below are this round's, not round 1's copy.

**PR-4 · isolation · P2 · Export zip keys are not re-validated on read - the third dereference site**
`server/src/routes/exports.ts:150-153`: `downloadUrlFor` presigns `job.objectKey` with no `assertIssuedObjectKey`. Used by both `GET /api/export/:id` (`:142`) and `GET /api/export` (`:127`), so one site covers two routes.
The 2026-08-06 ruling was "stored object keys are re-validated on read, in both places one is dereferenced", and it landed at `routes/receipts.ts:285` and `export/generateExport.ts:117`. There are **three** places, and this is the third - so this is an unfulfilled ruling as much as a severity call.
*Reproduced*, by hand-editing one row exactly as the August audit did, since no route can produce this state:

```
export_jobs.object_key := exports/00000000-0000-4000-8000-000000000000/<uuid>/Receipts-2026.zip
GET /api/export/:id  ->  200
downloadUrl: https://fake/download/exports/00000000-0000-4000-8000-000000000000/<uuid>/Receipts-2026.zip
URL names another user's prefix: true
```

**P2 on round 1's precedent, independently re-derived.** Reaching it needs direct database access, which the August audit ranked below a hostile authenticated user. Checked specifically this round: nothing client-supplied reaches this column. `runExportJob` writes it from `exportObjectKey(job.userId, job.id, ...)` where the user id comes from the row and the filename from `periodLabel`, whose inputs are `isoDateSchema`-validated dates that cannot contain a slash.
*Fix* would need an `isIssuedExportKey` predicate in `storage/objectKeys.ts`.

**PR-5 · deploy · P2 · No SIGTERM handling: in-flight requests are severed on every deploy**
`server/src/index.ts` registers no signal handler; `grep -n "SIGTERM\|SIGINT\|server.close" src/` returns nothing.
Fly sends SIGINT then SIGTERM on every `fly deploy` and every machine roll.
**Re-graded to P1 and back to P2 during Stage 0** - see §0. The retry that bounds it is refused (PR-6) only when the transaction committed, and in that case the receipt is already stored and reaches the client on the next list fetch. Nothing is lost in either branch.
`failAbandonedJobs` reaps a severed export, on a 30-minute clock (`routes/exports.ts:49`, `:209-239`).

**PR-6 · idempotency · P2 · A severed-but-committed create is not replayable: the retry gets 409**
`server/src/routes/receipts.ts:143-152` maps `receipt_images_user_id_sha256_uq` to `409 duplicate_image`.
The server behaves correctly and the data is safe; what is unresolved is what a client should be told. Whether this costs anything depends on the iOS outbox, which this run may not read.
**The remedy is a ruling, not a fix** - see RULINGS.

**PR-7 · deploy · P2 · The production image runs as root**
`server/Dockerfile:27` (`CMD`) is the last instruction; there is no `USER`. Defence in depth only - the process reaches no filesystem at runtime and Fly machines are isolated. `DEPLOY-CONFIG` if fixed.

**PR-8 · deploy · P2 · `fly.toml` defines no health check**
`server/fly.toml:13-21` configures `[http_service]` with no `[[http_service.http_checks]]` and no `[checks]`.
Fly falls back to a TCP connect on port 3000 (ASSUMPTION 4). **R2-1 sharpens this**: a machine that cannot reach its database is listening, so it passes a TCP check *and* passes the `curl`-for-401 check, and there is no automated signal anywhere that would notice. `DEPLOY-CONFIG`.

**PR-9 · resilience · P2 · The pool sets no connection timeout and no statement timeout** *(headline corrected at REVIEW-0 R0-1)*
`server/src/db/client.ts:11` passes only `connectionString`.
Round 1 recorded this as "no connection, statement, or idle timeout **and no size cap**", and round 2 re-asserted it under "re-verified" without measuring the library. **Two of those four clauses are false.** Measured against the installed `pg`:

```
$ node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:'...'});
           console.log(p.options.max, p.options.idleTimeoutMillis,
                       p.options.connectionTimeoutMillis, p.options.statement_timeout)"
max: 10 | idleTimeoutMillis: 10000 | connectionTimeoutMillis: undefined | statement_timeout: undefined
```

So `pg` already caps the pool at 10 and reaps idle connections after 10 s. What is genuinely absent is a **connection** timeout (`undefined` → `0` → wait forever) and a **statement** timeout, which is what round 1's crash dump actually showed.
Inert at three users; matters against Neon's autosuspend wake latency. Load-bearing for R2-1's fix, which must therefore carry its own timeout rather than lean on the pool's - and now for a sharper reason, since the pool's connect timeout is genuinely unbounded.

**PR-10 · config · P2 · `drizzle.config.ts` silently falls back to localhost**
`server/drizzle.config.ts:9`: `url: process.env.DATABASE_URL ?? "postgres://kept:kept@localhost:5432/kept"`.
Run inside a Fly machine with `DATABASE_URL` absent, drizzle-kit targets a database that is not there. It fails rather than corrupting anything, and the fallback is what makes a clean checkout work.

**PR-11 · correctness · P2 · The image soft-delete has no tombstone guard of its own**
`server/src/routes/receipts.ts:415-423` sets `deleted_at` on `receipt_images` with no `deleted_at IS NULL` condition.
It cannot overwrite an older tombstone today only because the receipts update above returns zero rows first and short-circuits at `:409-411` - inside the transaction, and working only because `visibleTo` carries `isNull(receipts.deletedAt)`. *(Cited as `:426-428` in the first draft of this ledger, which is the `throw notFoundError()` outside the transaction and stops nothing - REVIEW-0 R0-2.)*
The guarantee rests on caller ordering rather than on the statement.

**PR-12 · session · P2 · `sub` is not validated as a UUID**
`server/src/auth/session.ts:52` checks `typeof payload.sub === "string"` and non-empty, nothing more.
*Reproduced*: a token signed with the server's own secret carrying `sub: "not-a-uuid"` reaches `eq(users.id, claims.userId)` at `src/http/sessionAuth.ts:43` as a uuid parameter.

```
PR-12  GET /api/me with sub='not-a-uuid' -> 500 {"error":{"code":"internal_error","message":"Internal server error"}}
```

401 is the correct answer; 500 is what it gives. Unreachable without the signing secret, which is why it is P2 and not higher.

**PR-13 · supply chain · P2 · The production image ships dev dependencies**
`server/Dockerfile:19` runs `npm ci --include=dev`, deliberately - tsx runs the TypeScript and drizzle-kit must be on the machine for `fly ssh console -C "npm run db:migrate"`. The cost is that the `esbuild` advisory ships in the production image; it concerns esbuild's dev server, which nothing starts, and the fix is a major downgrade the prohibitions forbid.

**N-1 · resilience · P2 · Five dev scripts build their own `Pool` and still carry PR-1's defect**
Re-verified, all five, exact:
`src/db/seed.ts:20`, `src/db/claim.ts:25`, `src/db/llmParseProbe.ts:56`, `src/db/llmPromptReparse.ts:53`, `src/db/parseAccuracyReport.ts:26`.
`src/db/llmBackfill.ts:46` is **not** among them - it already routes through `createDb` and inherits the listener.
Short-lived operator scripts, and a crash mid-run is visible to the person who typed the command.

**N-2 · logging · P2 · The parse sweep's model branch logs the first characters of the model's output, which is derived from the receipt**
`src/observability/errorSummary.ts:112-118` renders any error without a database marker as `${name}: ${error.message}` plus stack frames, and `:79-85` walks the `cause` chain to depth 5 doing the same.
*Reproduced locally with no API call* - the leak is in how `JSON.parse`'s `SyntaxError` renders, and `JSON.parse` is local:

```
LlmParseError: Model response was not parseable JSON
  caused by SyntaxError: Unexpected token 'D', "Dr Smith P"... is not valid JSON
```

**Blast radius measured this round, and it is smaller than "any non-database error".** The other branch that could leak - `claudeReceiptParser.ts:89-94`, where a *valid* JSON reply fails `validateLlmParseResponse` - was tested with a reply carrying a vendor, a tax number, a total and an extra key:

```
caused by ZodError: [ { "expected": "number", "code": "invalid_type", "path": ["totalCents"], ... },
                      { "code": "unrecognized_keys", "keys": ["diagnosis"], ... } ]
"Dr Smith Pharmacy" present: false      "811234567RT0001" present: false
"amoxicillin" present: false            "113.00" present: false
```

zod 4 reports types and key names, never values. So N-2 is the `JSON.parse` branch alone: roughly ten characters of the model's reply.
`redactedMessage` - what reaches `export_jobs.error` and the failure record - returns `"Model response was not parseable JSON"` with no cause chain, so **nothing leaks into stored data or into a client response.** Log-only.
Confirms round 1's P2 rather than inheriting it.

**R2-2 · export · P2 · new · The CSV in every export is written with no formula-injection defence, so a receipt field beginning `=`, `+`, `-` or `@` is read as a formula by a spreadsheet**
`server/src/export/writeFiles.ts:87-93`: `csvField` implements RFC 4180 quoting and nothing else - it quotes only when the value contains `"`, `,`, `\r` or `\n`.
*Measured*, against the real writer:

```
vendor "=1+1"                    -> field "=1+1"
vendor "+1+1"                    -> field "+1+1"
vendor "-Rogers Communications"  -> field "-Rogers Communications"
vendor "@SUM(A1:A2)"             -> field "@SUM(A1:A2)"
```

Affects every string column: `vendor`, `vendor_gst_hst_number`, `category`, `payment_method`, `whose`, `notes`.
**The XLSX is not affected**, measured rather than assumed: ExcelJS stores a leading-`=` string as a string cell.

```
xlsx vendor cell type: 3   (ExcelJS ValueType.String = 3, .Formula = 6)
```

*Why P2.* Spec §8 line 444 fixes the division: "**XLSX is primary** (what an accountant opens); **CSV is the same data** (what imports into accounting software)". The artifact an accountant opens is safe, and accounting software importing a CSV does not evaluate formulas. The exposure is a human opening the CSV in Excel, Sheets or LibreOffice, where a vendor like `-Rogers` renders as `#NAME?` instead of a name.
*Why it is not fixed here.* Every available remedy mutates the exported data - the standard defence prefixes the field with `'`, which is then what accounting software imports. Choosing between a wrong cell in a spreadsheet and a wrong string in an import is a product decision. **RULINGS.**

**R2-3 · deploy · P2 · new · The 2 GB machine sizing is argued in RSS, but what bounds a Node process is V8's old-space cap, which inside a 2 GB container is ~1120 MiB**
`server/fly.toml:23-28` sizes the machine at 2 GB (`memory = "2gb"` at `:28`) on the measurement at `:25-27`, "a 250 MiB export peaks at 891 MiB RSS (2.8x the payload)".
*Measured this round*, in a container limited exactly as the machine is:

```
$ docker run --rm --memory=2g node:24-slim node -e "console.log(require('v8').getHeapStatistics().heap_size_limit/1024/1024)"
heap_size_limit MiB: 1120
```

So the headroom on a single export at the 256 MiB budget (`src/export/generateExport.ts:40-42`) is under 25 %, against a ceiling nothing in the repository names, and exceeding it aborts the process rather than failing the job.
Round 1 already recorded, under NOT DEFECTS, that nothing serializes exports **across** users (`export_jobs_one_active_per_user_uq` is scoped to `userId`, `src/db/schema.ts:156-158`); two concurrent exports were already known to exceed the machine, and this measurement says they exceed the *heap* well before they exceed the machine.
P2 because it is unmeasurable end to end here - reproducing an 891 MiB export would measure this laptop, not a `shared-cpu-1x` - and because at three users a quarter-gigabyte export is not today's shape. Recorded so the sentence "2 GB, measured rather than guessed" is read as true of RSS and unexamined for heap.

---

### P3 - carried from round 1's NEXT ROUND, unchanged and re-verified

**N-3 · P3 · The duplicate-image index makes "re-capture the same paper" order-dependent**
`src/db/schema.ts:187-189`. Re-capturing a receipt whose photo produces byte-identical output 409s until the old row is tombstoned. Correct behaviour; the ordering is a rule a person has to be told, and only the export failure message tells them.

**N-4 · P3 · Three review findings accepted during round 1 and neither fixed nor carried**
(a) `src/observability/requestLog.ts:62` reads `c.req.routePath`, which hono marks deprecated; it works on hono 4.13. (b) `isMissingObject` in `src/export/generateExport.ts:258-264` duplicates the shape of `isNotFound` in `src/storage/s3ObjectStorage.ts:176-184`, which is the export layer reaching through the `ObjectStorage` abstraction. (c) round 1 re-wrapped a quoted artifact block for width instead of pasting it verbatim.

**N-5 · P3 · Every request-log line for a pre-routing refusal reads `route: "unmatched"`**
`src/observability/requestLog.ts:62`. The edge-secret 403 and the body-limit 413 answer before hono routes, so they share the 404's label; the status code separates them but a consumer grouping by `route` sees three events under one key.

---

## 2 · ASSUMPTIONS

Every undeterminable fact resolved conservatively, and listed.

1. **`npm run typecheck` is the linter.** Re-checked, not inherited: no linter config and no `lint` script exist. Introducing one is a tooling addition no finding cites.
2. **`ANTHROPIC_API_KEY` was withheld from every process this run started.** `src/index.ts:104` kicks the sweep at startup whenever the key is set. Consequence, stated: **no code path that calls Anthropic has been executed in round 2**, and anything touching `parse/` is verified against local values or marked UNVERIFIED.
3. **Guardrail 7 ran on ports 3011-3013.** Pid 31468 still holds port 3000, now three days old. Left running - not this run's process.
4. **`fly.toml`'s TCP-only fallback health check** is taken from Fly's documented default for an `[http_service]` with no checks block. Unverifiable without a Fly account. Load-bearing for PR-8 and for one clause of R2-1.
5. **Neon Free-plan autosuspend (~5 min) and its wake latency** are taken from Neon's published behaviour and `docs/gates/wave-6.md` §3 step 6. Load-bearing for R2-1's fix needing a *bounded retry* rather than a single probe: a cold compute must be waited for, not crashed on. Cannot be measured - there is no Neon account and connecting to one is prohibited.
6. **Fly restarts a machine whose process exits.** Carried from round 1's ASSUMPTION 8, and load-bearing again: it is why R2-1's fix (refuse to serve) is an improvement rather than a new outage - a crash-loop is visible where a listening-but-broken machine is not.
7. **Node's heap ceiling inside the Fly machine is taken from a local 2 GB container**, not from the machine itself. Docker Desktop's VM reports 7936 MiB of total memory and Node still sized the heap to 1120 MiB, which is the cgroup limit being honoured; whether Fly's `shared-cpu-1x` presents the limit identically is unverified. R2-3 only.
8. **The 409-on-retry consequence in PR-6 is stated as unknown, not as loss**, and this round narrowed *why*: the receipt is committed and reachable, so the open question is client UX, not data. Determining it requires reading `ios/`.
9. **An R2 API token scoped to one bucket with read and write is assumed to permit `HeadBucket` on that bucket** *(added at REVIEW-1 F6, which found this load-bearing and unrecorded)*.
   R2-1's storage probe makes a successful `HeadBucket` a precondition of serving. `docs/gates/wave-6.md:118` provisions the credential as a token "scoped to that bucket with read and write", and nothing in this repository has ever issued `HeadBucket` against R2 - `npm run storage:probe-keys` exercises `GetObject` and `PutObject`. There are no R2 credentials on this machine and connecting to Cloudflare is prohibited, so it cannot be checked here.
   **If the assumption is wrong the consequence is "cannot deploy", which is P0**: `assertBucketReachable` propagates any error, so a `403 AccessDenied` on a bucket that is present and writable is indistinguishable from a wrong credential, and a machine that would have served refuses to boot.
   Conservative resolution, per this run's rule: the strict behaviour is kept and the assumption is written down, because a wrong-credential refusal is loud and fixed by one `fly secrets set`, whereas failing open on 403 would let exactly the misconfiguration R2-1 exists to catch through. The startup message was amended to name the permission as a candidate cause so an operator who hits it is not sent chasing only credentials. **the owner's to confirm against the real token before the storage probe is trusted - see RULING 7.**

---

## 3 · DEFERRED

- **PR-6's client half.** Unchanged from round 1: check `OutboxController`'s classification of 409 before PR-5/PR-6 are called closed. Round 2 adds one fact the next iOS pass should carry in - **the receipt is already stored when the 409 arrives**, so the client's correct move is to reconcile against the list, not to re-send.
- **Orphaned objects have no policy.** Open since 2026-08-06. `ObjectStorage` (`src/storage/objectStorage.ts`) still declares no delete operation. A sweep is a deletion path beside tax records. **RULINGS.**
- **The scheduled `pg_dump` has no destination.** `docs/gates/wave-6.md` §3 step 17 and Runbook §4 both rest retention on a dump kept off Neon; nothing schedules it and nowhere is named. **RULINGS.**
- **Neon's history window is 6 hours on Free.** A plan decision. **RULINGS.**
- **Rate limiting.** §10B requires it; the ruling is that it lands at the Cloudflare edge with the deployment. Unchanged.
- **R-1's other half: an existence check on the image object at create time.** **RULINGS.**
- **iOS per-request token pinning.** Open since 2026-08-06; out of scope.
- **R2 key normalization.** `npm run storage:probe-keys` works against MinIO; R2 needs credentials.
- **R2-2's remedy** (CSV formula defence). The finding is recorded and measured; the choice of remedy is a ruling.

---

## 4 · NOT DEFECTS

Considered this round and rejected as findings, with the measurement that rejected them - so none is re-litigated in round 3.

- **An abandoned archiver does not take the process down.** `src/export/generateExport.ts:280-299` builds the zip behind a `finished` promise wired to `output.on("finish")`, `archive.on("error")` and `archive.on("warning")`. When `fill()` throws - a missing image, the size limit - `buildZip` unwinds without awaiting `finished`, leaving a rejectable promise with no handler. If archiver emitted afterwards that would be an unhandled rejection, which Node kills the process for. **Measured outside vitest, where that would actually happen:** the real export-failure path ran to completion, printed `PROBE A SURVIVED`, and exited 0 with no `unhandledRejection` and no `uncaughtException`. The archiver emits nothing after abandonment. Recorded because it was a plausible P0 and it is not one.
- **Zip entry names cannot escape the archive.** `src/domain/exportFilename.ts:42-52` reduces a vendor to `[A-Za-z0-9]` runs, the date is `parseIsoDate`-validated, the short id is a uuid slice, and the extension comes from an object key that `isIssuedObjectKey` constrains to `[a-z]+`. No `..`, no `/`, no absolute path can reach a zip entry name. Zip-slip is closed by construction.
- **Fiscal periods are contiguous; no purchase date falls outside every period.** `fiscalPeriodEndingIn` (`src/domain/fiscalPeriod.ts:47-58`) computes `start` as `nextDay(<previous year's end>)`, so consecutive periods abut by construction. The Feb 29 case, which is where a gap would hide, was walked: ending-2024 is `2023-03-01 .. 2024-02-29`, ending-2025 is `2024-03-01 .. 2025-02-28`, ending-2026 is `2025-03-01 .. 2026-02-28`. Contiguous, no overlap. A receipt silently absent from every export would have been top-of-scale; it cannot happen this way.
- **Error responses do carry `Cache-Control: no-store`.** The middleware at `src/app.ts:87-90` sets the header *after* `await next()`, which reads like it would be skipped when a handler throws. It is not: hono's `compose` catches at the dispatch frame that owns the throwing handler, calls `onError` there, and returns normally up the chain (`node_modules/hono/dist/compose.js`), so the outer middleware resumes. Confirmed live - the 401 in the baseline carries the header.
- **No migration or schema drift.** `npx drizzle-kit check` → "Everything's fine", exit 0. Five migrations with matching snapshots.
- **The destructive dev scripts are guarded.** `src/db/seed.ts:14-18` and `src/db/claim.ts:19-23` both call `assertLocalDatabase` before constructing a pool, and `src/db/databaseUrl.ts:41-47` normalizes `127.0.0.1`, `::1` and `[::1]` to `localhost` so the guard cannot be walked around by spelling.
- **`.env.local` is not tracked**, `.gitignore` covers `.env.local` and `.env`, `core.hooksPath` is `.githooks`, and the gitleaks pre-commit hook is present and fail-closed (it refuses to commit if gitleaks is not installed).
- **No linter.** A tooling addition no finding cites; `tsc --noEmit` under `strict` is doing the load-bearing work.
- **The 6 `npm audit` moderates.** Unchanged, both unreachable, both fixed only by major downgrades the prohibitions forbid.
- **Forward-only migrations, `^`-ranged dependencies, the local-container credentials in `docker-compose.yml`, no `iss`/`aud` on the session JWT, no CORS or security headers.** All recorded decisions in round 1's ledger, all still true, none re-opened.

---

## 5 · CANNOT ASSESS

- **Anything against Fly, Neon, R2, or Cloudflare.** No accounts; prohibited regardless.
- **Any Anthropic-calling path.** `src/parse/claudeReceiptParser.ts`, `src/db/llmBackfill.ts`, `llmParseProbe.ts`, `llmPromptReparse.ts`, and the sweep's real parse function. N-2 is proved against a locally-constructed `SyntaxError` with the identical shape; no model call was made.
- **Whether Fly's TCP health check behaves as documented**, and therefore the last clause of PR-8.
- **Neon's actual cold-start latency**, which is what R2-1's retry budget should be sized against. It is sized conservatively instead.
- **The iOS half of PR-6.**
- **Whether a `shared-cpu-1x` presents its memory limit to Node the way a local `--memory=2g` container does** (R2-3).

---

## 6 · RULINGS - surfaced, not decided

The owner's calls. **None of these is implemented in this run.**

1. **R-1's other half: an existence check on the image object at create time.**
   It needs an `ObjectStorage` method that does not exist - the interface declares four operations and no `head` - and it converts a broken export into a refused capture.
   The trade: today a receipt whose upload was interrupted is captured and jams the export of its period until someone acts on the message; with the check, the capture is refused at the moment the paper is still in the person's hand, at the cost of a storage round trip on the one path that must never be slow.

2. **The orphaned-object policy.** Open since 2026-08-06.
   An image uploaded whose create never completed is never deleted, and nothing lists such objects, so today they are inert and invisible.
   The trade: leaving it means unbounded storage growth nobody can audit; closing it means writing a deletion path that runs beside six years of tax records, which is the last thing §10B wants built casually.

3. **The scheduled `pg_dump` destination, and the Neon plan.**
   `docs/gates/wave-6.md` §3 step 17 and Runbook §4 both rest six-year retention on a dump kept off Neon; nothing schedules it, nowhere is named, and Neon Free's history window is 6 hours.
   The trade: this is the single largest gap between retention as written and as implemented, and it cannot be closed from inside this repository - it needs an account, a bucket and a credential this run may not create.

4. **PR-6's remedy: what a replayed create should be told.**
   Answering the existing receipt instead of `409 duplicate_image` makes capture replayable, which is the correct shape for a client that must retry a severed request.
   The trade: it changes a documented response code that the iOS outbox already classifies somehow, and this run may not read `ios/` to find out which - so a fix could turn a survivable UX wrinkle into a real one.

5. **R2-2's remedy: whether the CSV should be mutated to defend a spreadsheet.**
   Prefixing a leading `=`, `+`, `-` or `@` with `'` is the standard defence and stops a vendor name being evaluated as a formula.
   The trade: the CSV exists to import into accounting software (spec §8), and the prefix is then what imports - so the choice is between a wrong cell for a human who opens the CSV in Excel and a wrong string for the software the file is actually for.

6. **Whether `prod-readiness/2026-08-10` and `prod-readiness/round-2` merge to `main`.**
   Neither branch is merged; `main` is still at `ca82907`, and nothing in either round has been exercised against a deployed environment.

7. **Whether the storage startup probe should fail open on a permission error.**
   R2-1's probe refuses to serve unless `HeadBucket` succeeds, and ASSUMPTION 9 records that no one has confirmed a bucket-scoped R2 token permits that call.
   The trade: keeping it strict means a token that cannot `HeadBucket` blocks a deploy that would otherwise have worked, while treating `403` as "storage answered" would let a wrong access key - the exact misconfiguration the probe exists to catch - through to a machine that then fails every image request. Confirming the permission against the real token removes the choice entirely, and is the cheaper move.

---

## 7 · Status

The frozen work list is the P0/P1 set surviving Review 0.

**Proposed frozen list: `R2-1`** - one item, no P0, far under the ten-item cap, so nothing is dropped for size.

Everything else on this ledger is P2 or P3 and is documented rather than fixed, per the run's own rule.

| id | severity | status |
|---|---|---|
| R2-1 | P1 | **RESOLVED** - artifacts below |
| PR-4 … PR-13, N-1, N-2, R2-2, R2-3, R2-4 | P2 | DOCUMENTED, not fixed |
| N-3, N-4, N-5 | P3 | DOCUMENTED, not fixed |

**R2-1's artifacts**, from the real entrypoint started the real way, `ANTHROPIC_API_KEY` withheld:

```
# wrong DATABASE_URL password - before: listened, answered 401, 500'd every real request
$ PORT=3016 node --env-file=<env> --import tsx src/index.ts
Object storage: checking http://dev-mac.local:9000 for bucket "kept"
Database at localhost:5432 did not answer, so this process is refusing to serve. Check
DATABASE_URL and that the database is running and reachable from here.
Error: Database did not answer after 5 attempts
  caused by DatabaseError [message and detail withheld] code=28P01 routine=auth_failed
EXIT CODE: 1
$ lsof -ti tcp:3016      -> (nothing bound)

# unreachable storage endpoint
$ PORT=3017 ... -> EXIT 1, "Object storage did not answer at http://localhost:9999 ..."

# absent bucket - and MinIO's /data still lists only `kept`, so the probe created nothing
$ PORT=3018 ... -> EXIT 1

# a database that answers: unchanged
$ PORT=3021 ... -> "Kept API listening on port 3021"; GET /api/me -> 401 + cache-control: no-store
```

**Two P1 regressions this pass introduced were caught by REVIEW-1 and fixed inside it**, per the rule that a defect of the builder's own making is repaired in the stage that caused it rather than carried:

- **REVIEW-1 F1** - the storage probe shipped with no timeout, so a host that accepts a TCP connection and never answers left the boot pending indefinitely with zero bytes of output, no port bound and no exit. Measured at 45 s and still going. Strictly worse than the defect R2-1 closed. Now bounded, and measured refusing in 11 s: `Object storage: checking http://127.0.0.1:9096 ... -> EXIT 1`. The second attempt at this fix - `requestHandler: { connectionTimeout, requestTimeout }` on the client - was measured to do nothing at all (still pending past 180 s), which is why the bound is a race the module owns.
- **REVIEW-1 F2** - the refusal line rendered `databaseIdentity(...).database`, and a `DATABASE_URL` that lost its `postgres://` prefix still parses with the userinfo in the pathname, so the **password** was printed by the very line whose comment said it withheld the URL because "DATABASE_URL carries the password". Now host and port only, with parsing guarded. Measured: `Database at :5432 did not answer ...`, and `grep -c s3cr3t-PASSWORD` over the whole output returns 0.

REVIEW-1's other findings were routed the same way: **F3** (the storage probe had no test and could be deleted with the suite green) closed with four cases in `tests/integration/objectStorage.test.ts`; **F4** (three comments that stated measurements they did not match) corrected; **F5** (the Runbook enumerates the startup refusals and this pass added two) closed in `docs/Runbook.md` §0 and §7; **F6** recorded as ASSUMPTION 9 and RULING 7.

**Passes.** One commit per pass; a pass no frozen finding touches is skipped and said so.

| Pass | Runs? |
|---|---|
| 1 · Secrets, authn/authz, injection, vulnerable deps | **Skipped as a code change** - no frozen finding. Live source was read at Stage 0 and the results are under NOT DEFECTS |
| 2 · Correctness, resource leaks, Node/TS failure modes | **Skipped** - no frozen finding. The one candidate (the abandoned archiver) was measured and is not a defect |
| 3 · Migrations, constraints, transactions, restore path | **Skipped** - no frozen finding. `drizzle-kit check` is clean and recorded at BASELINE |
| 4 · Timeouts, retries, idempotency, dependency-down behaviour | **Ran** - R2-1, in two commits: the fix, then the remediation REVIEW-1 required |
| 5 · Structured logging, error reporting, health signal | **Skipped** - no frozen finding. N-2 stays P2 on this round's own measurement |
| 6 · Reproducible build, pinned deps, startup config validation | **Folded into pass 4** - R2-1 *is* the startup-config-validation finding, and splitting it across two commits would leave one of them unverified |
| 7 · Tests | **Folded into the pass**, so the fix ships with the assertion that fails without it |

---

## 8 · NEXT ROUND

Findings discovered after Review 0 - by any reviewer or by the builder - land here with full evidence and are **not** fixed in this run. The work list froze at Review 0.

**R2-4 · security · P2 · Nothing requires TLS on `DATABASE_URL`, though the same startup check requires it on `STORAGE_ENDPOINT` for the same reason** *(REVIEW-0 R0-3 - the round's own lens, fired once more at the module the round was already looking at)*
`src/productionEnv.ts:51-57` refuses a non-`https` `STORAGE_ENDPOINT` in production, and states the reason: "Presigned URLs inherit this endpoint, so a plain-http value sends receipt images over cleartext."
The database connection carries the same class of data in the other direction - vendor, purchase date, subtotal, **HST**, the supplier's GST/HST registration number, notes, and `ocr_raw_text`, which is the whole receipt - and `assertProductionEnv` checks only that its host is not loopback (`:59-65`).
*Measured*: a `postgres://…` URL with no `sslmode` yields `pool.options.ssl === undefined`; `pg` does not negotiate TLS on its own.

```
$ node -e "const {Pool}=require('pg');
           console.log(JSON.stringify(new Pool({connectionString:'postgres://kept:kept@neon.example.com:5432/kept'}).options.ssl))"
ssl: undefined
```

**P2, taking the lower of an ambiguous pair.** In practice Neon's connection strings carry `?sslmode=require` and Neon's endpoints refuse cleartext, so the realistic deployment is encrypted - but that is Neon enforcing it, not this repository requiring it, and nothing here would notice if a URL arrived without it. The symmetry argument is what makes it a finding at all: the same function, eight lines apart, requires TLS of one backing service and not of the other.
Discovered after Review 0, so it is documented here and not fixed, regardless of severity.

**Carried in from round 2's own P2/P3 set, as round 3's candidate input:** PR-4, PR-6, PR-7, PR-8, PR-9, PR-10, PR-11, PR-12, PR-13, N-1, N-2, N-3, N-4, N-5, R2-2, R2-3, R2-4.

**Plus one nit not worth a finding row:** `.githooks/pre-commit` tells the reader to "bypass once with `--no-verify`" when gitleaks is missing, and `CLAUDE.md` says never to use it. The hook is fail-closed and correct; only its advice contradicts the standing instruction.
