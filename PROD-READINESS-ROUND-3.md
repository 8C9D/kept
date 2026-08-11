# Production-readiness ledger, round 3 - server only

Round 3 of the hardening pass, on branch `prod-readiness/round-3`, cut from `prod-readiness/round-2` at `7035141`.
Rounds 1 and 2 keep their files (`PROD-READINESS.md`, `PROD-READINESS-ROUND-2.md`, `reviews/`, `reviews/round2/`) intact and unedited.
Round 3's review trail is `reviews/round3/`.

Baseline: `reviews/round3/BASELINE.md`.
It reproduces at `7035141` on all four gates plus the entrypoint gate, so there is no P0 for "the baseline does not reproduce" and the run continues.

Scope: `server/` and its tooling.
`ios/` was not read, changed, or counted.
Deploy configuration (`fly.toml`, `Dockerfile`, `docker-compose.yml`) is in scope this round for the first time, and every change to it is flagged `DEPLOY-CONFIG`.

Severity rubric, unchanged: **P0** = data loss, security exposure, silent failure, or cannot deploy.
**P1** = fails under realistic load or edge input, or undiagnosable in production.
**P2** = everything else.
Receipt data loss is the top of the scale.
Where severity is arguable the lower one is taken and the reasoning is stated.

**What is different about this round.**
Rounds 1 and 2 each froze a P0/P1-only list and documented every P2.
Two independent sweeps have now re-verified the same backlog and found no further P1s in it, so this round's work list is drawn from the P2s, on the thesis that the remaining risk is an accumulation of small things nobody was allowed to fix.
The frozen list is capped at **8**.

---

## 0 · What Stage 0 actually did

Neither ledger was inherited.
Every one of the eighteen carried candidates was re-checked against live source at `7035141`: does the cited line still say what it is said to say, is the severity defensible on this round's own reading, does the fix stay in scope.

**Eighteen candidates carried in, and eighteen survived.**
**None was struck as fabricated, and no severity moved.**
That is a weaker result than it sounds and is stated as such: round 2 re-verified the same set six weeks of work ago in project time and one day ago in wall-clock time, so agreement is cheap.
What was not cheap, and is recorded under §9, is that **five of the eighteen citations were measured wrong or stale** by round 2's own §9 warning, and every line number in this ledger was re-resolved by hand rather than copied.

**Three candidates were re-measured rather than re-read**, because their claims are about library behaviour rather than about this repository's source:

- **PR-9.** Round 2's correction holds exactly. Re-measured against the installed `pg`: `max: 10 | idleTimeoutMillis: 10000 | connectionTimeoutMillis: undefined | statement_timeout: undefined`. Two of round 1's four clauses remain false and two remain true.
- **R2-3.** Re-measured in a container limited exactly as the machine is: `docker run --rm --memory=2g node:24-slim` reports `heap_size_limit MiB: 1120`. Reproduces to the megabyte.
- **R2-4.** Re-measured the same way, since "`pg` does not negotiate TLS on its own" is a claim about the library: a `postgres://` URL with no `sslmode` yields `ssl: undefined`. The measurement is quoted under the finding.

*(This set said "two" and named the first two when the ledger was frozen.
REVIEW-0 RV3-C caught the undercount, which is the exact class round 2 shipped, so it is corrected here rather than silently.)*

**One of round 2's own fixes was re-exercised rather than trusted**, because the prompt is right that round 2's fix shipped two P1 regressions that only a reviewer caught.
The storage probe was driven against a bucket that does not exist:

```
$ PORT=3033 STORAGE_BUCKET=no-such-bucket-round3 node --env-file=<no ANTHROPIC_API_KEY> --import tsx src/index.ts
Object storage: checking http://dev-mac.local:9000 for bucket "no-such-bucket-round3"
... Code: 'NoSuchBucket' ... refusing to serve
EXIT=1
$ docker exec kept-minio sh -c 'ls /data'
kept                     <- the probe created nothing
```

`NoSuchBucket` fails the probe, as `s3ObjectStorage.ts:192-195` promises, and no bucket was conjured.
R2-1 holds.
The other four closed P1s were spot-checked and are tabulated in `reviews/round3/BASELINE.md`.

### The hunt: what does this codebase assert in prose and nowhere else?

Round 1's blind spot was existence.
Round 2's was that its own new code had no test and its own comments stated measurements nobody had taken.
Fired as a lens, that second shape asks: where does a sentence in this repository describe behaviour the code does not have?

Two places, both new findings, both this round's own:

| Prose | What it says | What the code does |
|---|---|---|
| `src/index.ts:100-101`, the storage refusal an operator reads | check "that the token is permitted to read the bucket's **metadata**", and see a named ledger file | the probe stopped reading metadata one commit earlier and reads an **object**; the named file is not in the image. **R3-1** |
| `src/observability/requestLog.ts:22`, `docs/Kept-Build-Spec.md`, `docs/DECISIONS.md` | the log records "whether a session was **presented**" | it records whether authentication **succeeded**, so a rejected token and no token at all are the same line. **R3-2** |

Both are small.
Both are also exactly the failure round 2 was told to watch for, one round later and in round 2's own new code.

---

## 1 · Findings

`id | area | severity | evidence (file:line) | fix | blast radius`

There is no P0 and no P1 on this ledger.
That is a finding about the round, not an absence of one: two prior sweeps plus this one have now looked, and what is left is twenty P2/P3 items.

### P2 - the frozen work list, ordered by blast radius, smallest first

---

**R3-1 · startup · P2 · new · The storage refusal names a permission the probe no longer needs, and cites a file that is not in the production image**

*Evidence.*
`server/src/index.ts:96-101` tells an operator to check "that the token is permitted to read the bucket's metadata (see ASSUMPTIONS in PROD-READINESS-ROUND-2.md)".
Neither half is true any more.

`868d796` changed the probe from `HeadBucket` to `GetObject` on a key that cannot exist, and changed nothing else in that message.
`src/storage/s3ObjectStorage.ts:180-190` now states the opposite in its own docstring: the operation is "a `GetObject` on a key that cannot exist, NOT a `HeadBucket`", chosen precisely because bucket **metadata** is the permission the R2 token is not known to have.
So the refusal message sends an operator to check the one permission the fix exists to avoid needing.

And `server/Dockerfile:15-23` copies `package.json`, `package-lock.json`, `tsconfig.json`, `drizzle.config.ts`, `drizzle/` and `src/`.
`PROD-READINESS-ROUND-2.md` is not among them, so the file the message names does not exist on the machine that prints it.

*Reproduced against the real entrypoint*, with a deliberately wrong storage secret:

```
$ PORT=3032 node --env-file=<STORAGE_SECRET_ACCESS_KEY=s3cr3t-WRONG-STORAGE-PASSWORD> --import tsx src/index.ts
Object storage: checking http://dev-mac.local:9000 for bucket "kept"
Error: Object storage did not answer ... that the token is permitted to read the bucket's metadata
      (see ASSUMPTIONS in PROD-READINESS-ROUND-2.md).
  [cause]: SignatureDoesNotMatch ... Code: 'SignatureDoesNotMatch', Key: '.startup-probe/reachability'
EXIT=1
```

The `Key:` in the cause is the proof: the call is an object read.
The sentence above it says metadata.

*Why P2, not higher.*
Nothing is lost and nothing is exposed; the process refuses correctly and the cause line names the real fault.
The cost is that the one sentence written for the person diagnosing a refused boot points at the wrong permission and at a document they cannot open, which is a slower fix rather than a wrong one.

*Fix.* Say what the probe does, in the message, with no cross-file reference.
*Blast radius.* One template literal in `src/index.ts`.
No behaviour, no route, no schema.

---

**R3-2 · observability · P2 · new · The request log's `authenticated` field does not answer the question three documents say it answers**

*Evidence.*
`server/src/observability/requestLog.ts:66` computes `authenticated: c.get("userId") !== undefined`.
`c.set("userId", ...)` happens at `src/http/sessionAuth.ts:49`, which is reached only after the bearer header parses, the JWT verifies, the user row is found, and `tokenVersion` matches.
So the field reports **authentication succeeded**.

Three places say it reports something else.
`src/observability/requestLog.ts:22-24`, listing what is deliberately excluded: "**The user id.** Whether a session was **presented** is the diagnostic fact; *whose* it was is not".
`docs/Kept-Build-Spec.md` §10B, on the request log: "and whether a session was presented".
`docs/DECISIONS.md`, the 2026-08-10 entry, repeats it.

*The consequence, and it is round 2's own artifact that shows it.*
`PROD-READINESS-ROUND-2.md:96-105` records a request that carried a real bearer token, signed with the real secret, against a server that could not reach its database:

```
$ curl -H "Authorization: Bearer <session token signed with the real secret>" localhost:3013/api/me
{"msg":"request","method":"GET","route":"/api/me/*","status":500,"durationMs":151,"authenticated":false}
```

`authenticated: false` on a request that presented a session.
Re-derived independently this round from the source: every 401 logs `authenticated: false`, whether the client sent no `Authorization` header at all, sent a forged token, or sent a genuine token whose `token_version` was bumped.
Those have different causes and different remedies, and the field that exists to separate them does not.

*Why P2, and the P1 argument, because this is the one severity worth arguing.*
The P1 case is that "the app says it can't sync" is exactly the question `fly logs` is opened for, and the log cannot distinguish "the client stopped sending a token" from "the server is rejecting every token".
The reason it stays P2: the status code carries most of the load.
A 500 says the failure is ours, a 401 says the session was refused, a 200 says it worked, and a deployment with three users has few enough lines that the ambiguity is a slower diagnosis rather than an impossible one.
"Undiagnosable in production" overstates it, so the lower grade is taken.

*Fix.* Make the line answer both questions.
The existing field keeps its meaning, so nothing that reads it changes; the fact the docstring promises is added beside it.

*What REVIEW-0 corrected about the fix's reach* (RV3-G).
The frozen version named three prose sites, one of them the 2026-08-10 entry in `docs/DECISIONS.md`.
That file is the append-only log of how we got here, and editing a past entry to match new behaviour erases what was decided then.
So the fix touches **two** prose sites, the docstring at `src/observability/requestLog.ts:22-24` and `docs/Kept-Build-Spec.md` §10B, which is the current-state document and is supposed to move.
The 2026-08-10 DECISIONS entry stays exactly as written, and this round's own entry records the change forward.

*Blast radius.* One JSON field in one middleware, plus the two prose sites that describe it.
Every request logs one more boolean.

---

**PR-11 · correctness · P2 · The image soft-delete has no tombstone guard of its own, and will overwrite an older one**

*Evidence.*
`server/src/routes/receipts.ts:415-423` sets `deletedAt` on `receipt_images` filtered only by `receiptId` and `userId`.
There is no `isNull(receiptImages.deletedAt)`.
Round 2's citation is correct to the line and its reasoning is correct: the only thing stopping an overwrite today is that the receipts update at `:404-408` returns zero rows first and short-circuits at `:409-411`, inside the transaction, working only because `visibleTo(userId)` carries `isNull(receipts.deletedAt)`.

*What this round adds.*
Round 2 graded it on the guarantee resting on caller ordering.
Re-derived here, the reachable state is narrower and the consequence is concrete: a row whose image is tombstoned while its receipt is **not** is unreachable through any route (`grep` over `src/routes/receipts.ts` finds six routes, at `:58`, `:80`, `:171`, `:251`, `:305` and `:398`, none of them an image delete, and the create path inserts one image per receipt), so this needs a hand-edited row exactly as PR-4 does.
In that state, deleting the receipt rewrites the older `deleted_at` forward.
`deleted_at` is what a §10B retention rule would be written against, so the value that moves is the one that decides when an object may be swept.

*Why P2.* Not reachable through the API, no data lost, and the sweep the moved timestamp would mislead does not exist yet (RULING 2).
*Fix.* Add the guard the statement should have carried.
*Blast radius.* One `where` clause on the delete path.

---

**PR-4 · isolation · P2 · Export zip keys are not re-validated on read, the third dereference site, and an unfulfilled 2026-08-06 ruling**

*Evidence.*
`server/src/routes/exports.ts:147-153`: `downloadUrlFor` presigns `job.objectKey` with no validation.
Called at `:127` (`GET /api/export`) and `:142` (`GET /api/export/:id`), so one site covers two routes.
`src/storage/objectKeys.ts:116-126` provides `assertIssuedObjectKey` for receipt images and has no export equivalent; `grep` confirms its two call sites are `routes/receipts.ts` and `export/generateExport.ts`.

The 2026-08-06 ruling was "stored object keys are re-validated on read, in both places one is dereferenced".
There are three places.
This is the third, so this is an unfulfilled ruling as much as a severity call.

*Why P2, re-derived rather than inherited.*
Nothing client-supplied reaches `export_jobs.object_key`.
`src/export/generateExport.ts:223-227` writes it from `exportObjectKey(input.userId, input.jobId, "Receipts-" + label + ".zip")`, where the user id and job id come from the row and `label` is `periodLabel` (`:237-246`) over `isoDateSchema`-validated dates, which cannot contain a slash.
Reaching the bad state needs direct database access, which the August audit ranked below a hostile authenticated user.

*What this round adds to the fix.*
The export key is **more** constrained than a receipt-image key, and the check can be correspondingly stronger.
`exportObjectKey` produces exactly `exports/{userId}/{jobId}/Receipts-{label}.zip`, and at the call site in `downloadUrlFor` both the user id and the job id are in hand from the row.
So the predicate can pin all three segments, where `isIssuedObjectKey` can only pin the user.

*And what REVIEW-0 changed about the fix, which is the part worth reading.*
The frozen version of this row said a non-matching key "becomes a 500 instead of a presigned URL", and that was measured wrong.
`downloadUrlFor` is called at `src/routes/exports.ts:126-128` inside a `Promise.all` over the row set, which `:125` caps at `.limit(50)`.
A throwing assertion there does not fail one job, it fails `GET /api/export` entirely, so **one corrupt row makes every other export in that user's history unreachable through the only route that lists them** (RV3-E).
Copying `assertIssuedObjectKey`'s throw would therefore have relocated the blast radius rather than bounded it.

So the fix departs from its receipt-image sibling deliberately, and the departure is stated rather than smuggled.
`objectKeys.ts:111-114` justifies the throw as "fail the request loudly and leave a log line", and the load-bearing half of that sentence is the log line, not the 500.
`downloadUrlFor` refuses the URL for the offending job, logs the refusal through `errorSummary`, and returns `null` for that job alone.
The isolation guarantee is identical, the failure is louder in the log than a 500 would be (a 500 says nothing about which row), and one bad row costs one download link instead of a history.
This is explicit handling and not a swallowed error: the refusal is unconditional and the log line is unconditional.

*Fix.* An `isIssuedExportKey` predicate in `storage/objectKeys.ts` beside its receipt-image sibling, and a refusal at the one dereference site that is contained to the job it concerns.
*Blast radius.* One new predicate, one call site, two routes.
A stored key that does not match yields `downloadUrl: null` for that job and a server log line naming the fault, on both routes, and leaves every other job in the response untouched.

---

**PR-12 · session · P2 · `sub` is not validated as a UUID, so a token that is genuine but malformed answers 500 instead of 401**

*Evidence.*
`server/src/auth/session.ts:52` checks `typeof payload.sub === "string" && payload.sub !== ""` and nothing more.
`src/http/sessionAuth.ts:43` then passes `claims.userId` to `eq(users.id, ...)`, where the column is `uuid`.
Postgres rejects the parameter, the route throws, and the app answers 500.
Round 2 reproduced it and this round confirms the two lines are unchanged.

*Why P2.* Unreachable without the signing secret, which is what keeps it out of the P1 band.
Anyone who can mint a token with `sub: "not-a-uuid"` can mint one with a real user's uuid, so this is not an isolation hole; it is the wrong status code on a path nobody hostile has a reason to take.
The reason it is worth closing anyway is that it is the one place a *forged* token produces a server error rather than a refusal, so a forgery attempt reads in the log as an outage.

*Fix.* Reject a `sub` that is not a uuid in `verify`, where every other claim is already checked.
*Blast radius.* One guard in the session verifier, on the path every authenticated request takes.

---

**PR-9(a) · resilience · P2 · The pool sets no connection timeout, so a connect against an unreachable database waits forever**

*Evidence.*
`server/src/db/client.ts:11` passes `connectionString` alone.
Re-measured this round against the installed `pg`:

```
max: 10 | idleTimeoutMillis: 10000 | connectionTimeoutMillis: undefined | statement_timeout: undefined
```

`connectionTimeoutMillis` stays `undefined`, and `node_modules/pg-pool/index.js:206` and `:250` both test it for falsiness (`if (!this.options.connectionTimeoutMillis)` and `if (this.options.connectionTimeoutMillis)`), so **no timer is ever armed** and a connect waits forever.
*(The frozen version of this row said the value "becomes `0`".
It does not; nothing coerces it.
The conclusion was right and the mechanism was wrong, which is precisely the defect class this round's hunt is built on, so REVIEW-0 RV3-I is corrected here rather than waved through.)*
Round 2's correction of round 1's headline stands: `max` and `idleTimeoutMillis` **are** defaulted by the library, and round 1's claim that they were not was wrong.

*What makes it load-bearing rather than theoretical.*
`src/db/client.ts:57-59` already states in prose that the pool has no connect timeout, and it says so as the *reason* `assertDatabaseReachable` must carry its own `withTimeout` race.
So the startup path is protected and every other path is not: a checkout during a Neon failover, against a host that accepts the TCP connection and never completes the handshake, hangs the request until the client gives up.

*This finding is split, and only half is frozen.*
The **statement** timeout is deferred, not fixed, and the reason is receipt data.
A statement timeout is a single number applied to every query in the process, and `generateExport` reads an entire fiscal year of rows and streams every image through one connection.
No measurement exists here of how long that query takes against Neon at a realistic row count, and a value guessed too low truncates an export rather than failing one request.
Guessing it is the kind of unmeasured constant this project has twice been burned by, so the honest move is to leave it open with the measurement named.
See NEXT ROUND.

*Why P2, and the P1 argument, since REVIEW-0 RV3-F is right that this was the one frozen finding shipped without a severity defence.*
The P1 reading is real and comes straight from the rubric: a checkout that hangs forever "fails under realistic load or edge input", and a Neon failover is realistic.
Three things hold it at P2.
The startup path, which is the one that meets a cold or moved compute first, is already bounded by `assertDatabaseReachable`'s own race, so the unbounded case is a *mid-life* failover rather than a boot.
The request that hangs is one request, not the process: `pg` caps the pool at 10 and the hono handler owns its own promise, so this degrades a caller rather than wedging the server.
And nothing here has measured it happening, because measuring it needs Neon.
Taking the lower of an ambiguous pair, as the rubric instructs.

*And the constant this fix introduces, named rather than left implicit* (REVIEW-0's second ungraded risk).
The value chosen is **10000 ms**, and it is a judgement rather than a measurement, so it is written down as one.
It sits above `assertDatabaseReachable`'s own 5000 ms per-attempt probe, deliberately: the probe is allowed to give up on an attempt and retry, and a pool checkout has nothing to retry into.
It is the same order as the storage probe's `PROBE_TIMEOUT_MS` of 10000 (`s3ObjectStorage.ts:169`), which is the only comparable constant in the codebase.
This is precisely the kind of number PR-9(b) is deferred for not having, and the difference is that a connect timeout set too low fails one request that would have succeeded, while a statement timeout set too low truncates an export.

*Fix.* Set `connectionTimeoutMillis` on the pool.
*Blast radius.* One pool option, affecting every database connection the process opens.
A connect that would have hung now fails, which changes a hang into an error the existing handlers already render.

---

**PR-7 · deploy · P2 · `DEPLOY-CONFIG` · The production image runs as root**

*Evidence.*
`server/Dockerfile:27` is `CMD ["node", "--import", "tsx", "src/index.ts"]` and is the last instruction.
There is no `USER`, so the process runs as uid 0.
`node:24-slim` ships a `node` user (uid 1000) for exactly this.

*Why P2.*
Defence in depth only, and the depth is real: the process reaches no filesystem path at runtime except reading its own source, Fly machines are single-tenant VMs, and there is no second process to escalate toward.
It is on the list because it is one line, it is the cheapest item on this ledger by a wide margin, and "the container runs as root" is the kind of finding that costs nothing until the day it is the difference.

*Fix.* Add `USER node` before `CMD`, with the file ownership `npm ci` created accounted for.
*Blast radius.* `DEPLOY-CONFIG`, the production image's runtime uid.
Nothing in the application; everything in what a compromise of it could reach.
Verified by building the image and running it, not by reading the Dockerfile.

---

**R2-4 · security · P2 · Nothing requires TLS on `DATABASE_URL`, though the same function requires it of `STORAGE_ENDPOINT` for the same stated reason**

*Evidence.*
`server/src/productionEnv.ts:51-57` refuses a non-`https` `STORAGE_ENDPOINT` in production and gives the reason in the error: "Presigned URLs inherit this endpoint, so a plain-http value sends receipt images over cleartext."
Eight lines later, `:59-65` checks only that the database host is not loopback.

The database connection carries the same class of data in the other direction: vendor, purchase date, subtotal, **HST**, the supplier's GST/HST registration number, notes, and `ocr_raw_text`, which is the entire receipt.

*Re-measured this round*, because it is a claim about `pg` rather than about this repository:

```
$ node -e "const {Pool}=require('pg'); ... new Pool({connectionString:'postgres://kept:kept@localhost:5432/kept'}).options.ssl"
ssl: undefined
```

`pg` does not negotiate TLS on its own.
A `DATABASE_URL` with no `sslmode` connects in cleartext and nothing in this repository notices.

*Why P2, taking the lower of an ambiguous pair.*
Neon's connection strings carry `?sslmode=require` and Neon's endpoints refuse cleartext, so the realistic deployment is encrypted.
But that is Neon enforcing it, not this repository requiring it, and a self-hosted Postgres or a hand-edited string would be silently in the clear.
The symmetry is what makes it a finding: the same function, eight lines apart, requires TLS of one backing service and not of the other.

*Why this is safe to fix where `HeadBucket` was not, since that is the trap round 2 fell into.*
Round 2 traded a P0 for a P1 by making a boot-blocking requirement out of a **permission a third party grants**.
This is a string check on a value the operator sets and can read, in a function that already refuses four other production-shaped mistakes, and the refusal names the exact edit.
It cannot refuse a deploy for a reason the operator cannot see and fix in one command.

*Fix.* Require TLS on `DATABASE_URL` in production, accepting the spellings that mean it, beside the check that already requires it of storage.
*Blast radius.* `assertProductionEnv`, production only, and it is boot-blocking: a production `DATABASE_URL` without TLS stops the process.
Nothing changes in development or in tests, where `assertProductionEnv` returns immediately.

---

### P2 - documented, not fixed, above the cap

These survived Stage 0 with their severity intact and lost their place to the cap of 8.
Full evidence is in `PROD-READINESS-ROUND-2.md` §1 and is re-verified here to the line; only what changed is restated.

**PR-5 · deploy · P2 · No SIGTERM drain: in-flight requests are severed on every deploy**
Re-verified: `grep -rn 'SIGTERM|SIGINT|server.close|process.on(' src/` returns **nothing**.
Round 2 proposed elevating this to P1 and withdrew it, and that reasoning was re-read before being re-derived, as instructed.
It holds: the retry PR-6 refuses is refused only when the transaction committed, and in that case the receipt is already stored and reaches the client on the next list fetch.
Observed incidentally this round: `kill <pid>` on the entrypoint released port 3031 immediately, which is Node's default SIGTERM behaviour and is the finding.

**PR-6 · idempotency · P2 · A severed-but-committed create is not replayable: the retry gets 409**
`src/routes/receipts.ts:143-152` maps `receipt_images_user_id_sha256_uq` to `409 duplicate_image`, unchanged.
The remedy is a ruling, not a fix.
**RULING 4.**

**PR-8 · deploy · P2 · `fly.toml` defines no health check**
Re-verified: `server/fly.toml:13-21` is the whole `[http_service]` block and there is no `[[http_service.http_checks]]` and no `[checks]` anywhere in the file's 28 lines.
**Struck from the frozen list on a scope ground, not a severity one, and this is the round's one significant scope call.**
A health check worth adding must re-ask the question R2-1 asks at boot, and the only honest way to do that is an endpoint that touches both backing services, which is a new endpoint and therefore a feature this run may not add.
A check pointed at an existing route is worse than none: `GET /api/me` answers 401, which Fly reads as failing, and any route that answers 2xx to an unauthenticated caller does not exist.
R2-1 already covers the case a health check would have caught at boot, and leaves uncovered only a service that dies after a successful boot.
Recorded as **RULING 8** rather than fixed.

**PR-9(b) · resilience · P2 · No statement timeout**
The deferred half of PR-9.
See the finding above for why, and NEXT ROUND for what would close it.

**PR-10 · config · P2 · `drizzle.config.ts` silently falls back to localhost**
Re-verified verbatim at `server/drizzle.config.ts:9`: `url: process.env.DATABASE_URL ?? "postgres://kept:kept@localhost:5432/kept"`.
It fails rather than corrupting anything, and the fallback is what makes a clean checkout work.

**PR-13 · supply chain · P2 · The production image ships dev dependencies**
Re-verified at `server/Dockerfile:16-19`, `npm ci --include=dev`, deliberate and commented.
Unchanged and not actionable: the fix is a major downgrade the prohibitions forbid.

**N-1 · resilience · P2 · Five dev scripts build their own `Pool` and still carry PR-1's defect**
Re-verified, all five, exact and unchanged: `src/db/seed.ts:20`, `src/db/claim.ts:25`, `src/db/parseAccuracyReport.ts:26`, `src/db/llmPromptReparse.ts:53`, `src/db/llmParseProbe.ts:56`.
`src/db/llmBackfill.ts` is still not among them.
Off the frozen list on testability: three of the five are Anthropic-calling scripts this run may not execute, so a fix there ships **UNVERIFIED**, and shipping four fifths of a fix is worse than carrying it whole.

**N-2 · logging · P2 · `errorSummary`'s model branch leaks roughly ten characters of model output**
Re-verified at `src/observability/errorSummary.ts:105-119` (`describe`, whose leaking `return` is `:118`) and `:79-85` (the cause walk).
Round 2's measurement stands and is not re-litigated.
Off the frozen list on blast radius: `errorSummary` is the redaction every log path in the project routes through, and narrowing it is the largest-radius change on this ledger for the smallest measured exposure.

**N-3 · P3 · The duplicate-image index makes "re-capture the same paper" order-dependent**
Re-verified at `src/db/schema.ts:187-189`.

**N-4 · P3 · Three round-1 findings accepted and neither fixed nor carried**
(a) `src/observability/requestLog.ts:62` still reads `c.req.routePath`, deprecated on hono 4.13 and working.
(b) **This one got worse in round 2 and the ledger should say so.**
N-4(b) was "`isMissingObject` in `src/export/generateExport.ts:258-264` duplicates the shape of `isNotFound` in `s3ObjectStorage.ts`".
Round 2's probe added a *third* predicate, `isMissingObject` at `s3ObjectStorage.ts:280-286`, which is **byte-identical** to the export one (`diff` over both ranges: no output).
So the file now holds two near-twin predicates and the duplication the finding names is now literal rather than merely shaped.
(c) unchanged.

**N-5 · P3 · Every request-log line for a pre-routing refusal reads `route: "unmatched"`**
Re-verified at `src/observability/requestLog.ts:62`, with the reasoning still in the comment above it at `:56-61`.

**R2-2 · export · P2 · The export CSV has no formula-injection defence**
Re-verified verbatim at `src/export/writeFiles.ts:87-93`: `csvField` quotes only on `/[",\r\n]/`.
Every available remedy mutates exported data, so the remedy is a ruling.
**RULING 5.**

**R2-3 · deploy · P2 · V8's heap ceiling is ~1120 MiB inside the 2 GB machine, against a 891 MiB export**
Re-verified at `server/fly.toml:23-28` (`memory = "2gb"` at `:28`, the RSS measurement in the comment at `:25-27`) and re-measured at 1120 MiB.
Unfixable from inside this repository without either changing the machine size or changing how exports are built, and both exceed this round.

---

## 2 · ASSUMPTIONS

Every undeterminable fact resolved conservatively, and listed.

1. **`npm run typecheck` is the build gate and the lint gate.** Re-checked, not inherited: no linter config, no `lint` script. Adding one is a tooling addition no finding cites.
2. **`ANTHROPIC_API_KEY` was withheld from every process this run started.** `src/index.ts:183` kicks the sweep at startup whenever it is set. Every entrypoint run used a copy of `.env.local` with that line removed, and the copy was checked for the key's absence before use. Consequence, stated: **no code path that calls Anthropic has been executed in round 3.**
3. **Port 3000 belongs to pid 31468 and is not this run's.** Four days old, recorded since round 1, left alone. Round 3 used ports 3031, 3032 and 3033.
4. **`fly.toml`'s TCP-only fallback health check** is Fly's documented default for an `[http_service]` with no checks block. Unverifiable without a Fly account. Load-bearing for PR-8 and RULING 8.
5. **Neon Free-plan autosuspend and its wake latency** are taken from Neon's published behaviour. Load-bearing for PR-9(a): the connect timeout must be generous enough that a waking compute is waited for, not crashed on, which is why the value chosen is well above a healthy connect and well below a request timeout.
6. **Fly restarts a machine whose process exits.** Carried from round 1 ASSUMPTION 8 and round 2 ASSUMPTION 6, load-bearing again for R2-4: a production boot refused for a cleartext `DATABASE_URL` is a visible crash-loop rather than a silent outage.
7. **A production `DATABASE_URL` that omits TLS is an error rather than a deliberate choice.** This is the assumption R2-4's fix rests on, and it is the one that could refuse a deploy that would otherwise have worked. It is taken because the alternative reading, that someone deliberately runs receipt data over cleartext to a non-loopback host, is a configuration this project's own §10B forbids. Recorded rather than asserted: no Neon connection string has been seen by this run.
8. **`node:24-slim` ships a `node` user at uid 1000, and `/app` is readable by it after a root `npm ci`.** Load-bearing for PR-7. **The first clause is verified** (`docker run --rm node:24-slim id node` reports `uid=1000(node) gid=1000(node)`). **The second clause is UNVERIFIED at Stage 0**, and it is the half that decides whether a one-line `USER node` actually boots. The frozen ledger claimed both were "verified by building and running the image" and pointed at an artifact that did not exist; REVIEW-0 RV3-A caught it, and the claim is withdrawn to what was actually measured. The image is built and run in pass 1, and PR-7 does not close without that artifact.
9. **The R2 token can read a key from its own bucket.** Carried unchanged from round 2 ASSUMPTION 9 and still unexercised: there are no R2 credentials on this machine and connecting to Cloudflare is prohibited. **RULING 7.**
10. **`export_jobs.object_key` is only ever written by `generateExport`.** Load-bearing for PR-4's severity. Re-derived by grep this round: `exportObjectKey` has exactly one call site, `src/export/generateExport.ts:223`.

---

## 3 · DEFERRED

- **PR-9's statement-timeout half.** Frozen finding, half fixed, half deferred with the reason in the finding: no measurement exists of a realistic export query against Neon, and a value guessed low truncates an export.
- **PR-6's client half.** Unchanged through three rounds: `OutboxController`'s classification of 409 cannot be checked without reading `ios/`. Round 2's fact carries forward: the receipt is already stored when the 409 arrives, so the client's correct move is to reconcile, not re-send.
- **Orphaned objects have no policy.** Open since 2026-08-06. `src/storage/objectStorage.ts` still declares no delete operation. **RULING 2.**
- **The scheduled `pg_dump` has no destination**, and **Neon's history window is 6 hours on Free.** **RULING 3.**
- **R-1's other half: an existence check on the image object at capture time.** **RULING 1.**
- **Rate limiting.** §10B requires it; the ruling stands that it lands at the Cloudflare edge with the deployment.
- **iOS per-request token pinning.** Out of scope.
- **R2 key normalization.** `npm run storage:probe-keys` works against MinIO; R2 needs credentials.
- **R2-2's remedy.** **RULING 5.**
- **PR-8's remedy.** Struck from the frozen list on scope, not severity. **RULING 8.**

---

## 4 · NOT DEFECTS

Considered this round and rejected as findings, with the measurement that rejected each, so none is re-litigated in round 4.

- **The storage refusal's uncaught throw does not leak a secret.** `src/index.ts:95-103` throws rather than following the database branch's `errorSummary` + `process.exit(1)` pattern, and `src/index.ts:117-123` states in its own comment that a throw is avoided there because node's default handler "dumps the whole object", which PR-2 established must never happen. The asymmetry is real and was measured rather than reasoned about: booted with a wrong `STORAGE_SECRET_ACCESS_KEY`, the dump carries `Code`, `Key`, `BucketName`, `RequestId`, `HostId` and `$metadata`, and `grep -c` for the secret over the whole output returns **0**. No credential, no receipt data. Recorded because it was a plausible P1 and it is not one; the asymmetry is noted for round 4 rather than graded.
- **`is_business` has no default at any layer.** Checked because it is one of the four constraints that do not move. `src/db/schema.ts:75` is `boolean("is_business")` with no `.default()`; `drizzle/0002_wave-4-pending-contract.sql:2` drops the NOT NULL and `:4` adds `receipts_confirmed_complete_ck`, which forbids a confirmed receipt with a null flag; `src/http/schemas.ts:149-152` rejects a confirm that omits it. No layer supplies one.
- **Nothing pending reaches an export**, and it is tested rather than asserted: `tests/integration/exportable.test.ts:36-39` covers both the explicit `status: "pending"` and the omitted-status case.
- **The probe key cannot collide with a real object.** `.startup-probe/reachability` (`s3ObjectStorage.ts:273`) begins with a dot; `receiptImageObjectKey` begins with a uuid and `exportObjectKey` with the literal `exports/`. True by construction, though asserted in prose only. Not worth a finding row; noted for round 4 as an untested invariant.
- **Round 1's artifacts still carry 21 em dashes** on lines its commits added, against CLAUDE.md's rule. Those files are frozen by this round's instructions and were not touched. Round 2's own added lines carry **zero**, measured over `b23ea08..7035141`.
- **No migration or schema drift.** `npx drizzle-kit check` is clean at baseline.
- **The 6 `npm audit` moderates.** Unchanged, both reachable only through tooling, both fixed only by major downgrades the prohibitions forbid.
- Everything rounds 1 and 2 recorded under NOT DEFECTS and did not re-open.

---

## 5 · CANNOT ASSESS

- **Anything against Fly, Neon, R2, or Cloudflare.** No accounts; prohibited regardless.
- **Any Anthropic-calling path.** `src/parse/claudeReceiptParser.ts`, `src/db/llmBackfill.ts`, `llmParseProbe.ts`, `llmPromptReparse.ts`, and the sweep's real parse function. N-2 is unchanged from round 2's local reproduction; no model call was made.
- **Whether Fly's TCP health check behaves as documented**, and therefore PR-8 and RULING 8.
- **Whether a production `DATABASE_URL` in `fly secrets` carries `sslmode`.** R2-4's fix is correct either way, but whether it would refuse the *current* deploy cannot be known from here.
- **Whether a `shared-cpu-1x` presents its memory limit to Node the way a local `--memory=2g` container does** (R2-3).
- **The iOS half of PR-6.**

---

## 6 · RULINGS - surfaced, not decided

The owner's calls.
**None is implemented in this run.**
Seven carried in; all seven were re-verified as still open and are restated in one line each rather than re-argued, with round 3's addition where there is one.
One is new.

1. **R-1's other half: an existence check on the image object at capture time.** Still open; `src/storage/objectStorage.ts` still declares four operations and no `head`. The trade is unchanged: a refused capture while the paper is in hand, against a jammed export later.
2. **The orphaned-object policy.** Open since 2026-08-06. Round 3 adds one consequence: PR-11's frozen fix pins `deleted_at` against being moved forward, and `deleted_at` is what a sweep would be written against, so closing PR-11 makes this ruling cheaper to act on later.
3. **The scheduled `pg_dump` destination, and the Neon plan.** Still the largest gap between retention as written and as implemented, and still uncloseable from inside this repository.
4. **PR-6's remedy: what a replayed create should be told.** Unchanged; needs `ios/`.
5. **R2-2's remedy: whether the export CSV should be mutated to defend a spreadsheet.** Unchanged: a wrong cell for a human who opens the CSV, against a wrong string for the accounting software the file is actually for.
6. **Whether `prod-readiness/2026-08-10`, `prod-readiness/round-2` and now `prod-readiness/round-3` merge to `main`.** Re-verified: `main` is still at `ca82907` and none of the three is merged. Three branches deep is the part worth deciding on.
7. **Confirm at first deploy that the R2 token can read from its bucket, since the server refuses to boot without it.** Unchanged and still unexercised. One `npm run storage:probe-keys` at wave-6 §3 step 12, already in the deploy sequence, settles it.
8. **NEW. What a health check should ask, given that no route can answer it.** PR-8 is a real finding and its remedy is out of this run's scope, because a check that is worth adding must touch both backing services and no such route exists: `GET /api/me` answers 401, which Fly reads as failure, and nothing else answers 2xx unauthenticated. The trade: adding `GET /api/health` is a new endpoint, which is the feature line this run may not cross, and it is also an unauthenticated route that reports whether the database is up, which is a small amount of free reconnaissance. Leaving it means a machine whose database dies *after* a successful boot has no automated signal, which is exactly the gap R2-1 closed at boot and not after.

---

## 7 · Status

**Proposed frozen list, 8 items, at the cap:**

| # | id | severity | blast radius |
|---|---|---|---|
| 1 | R3-1 | P2 | one string in `src/index.ts` |
| 2 | R3-2 | P2 | one log field, plus three prose sites |
| 3 | PR-11 | P2 | one `where` clause on the delete path |
| 4 | PR-4 | P2 | one predicate, one call site, two routes |
| 5 | PR-12 | P2 | one guard on every authenticated request |
| 6 | PR-9(a) | P2 | one pool option, every database connection |
| 7 | PR-7 | P2 `DEPLOY-CONFIG` | the production image's runtime uid |
| 8 | R2-4 | P2 | production boot refusal |

No P0 and no P1 was found at Stage 0, so nothing preempts the P2s and the list is ordered by blast radius alone, smallest first.

**The arithmetic, recounted against the ids actually present**, because round 2 shipped a carry list that dropped one:

- Carried in from `PROD-READINESS-ROUND-2.md` §8: **18**. PR-4, PR-5, PR-6, PR-7, PR-8, PR-9, PR-10, PR-11, PR-12, PR-13 (10), N-1, N-2, N-3, N-4, N-5 (5, running 15), R2-2, R2-3, R2-4 (3, running 18).
- New this round: **2**. R3-1, R3-2.
- Total on this ledger: **20**.
- Frozen: **8**. R3-1, R3-2, PR-11, PR-4, PR-12, PR-9(a), PR-7, R2-4.
- To NEXT ROUND: **12**. 20 minus 8.

| id | count | severity | status |
|---|---|---|---|
| R3-1, R3-2, PR-4, PR-7, PR-9(a), PR-11, PR-12, R2-4 | 8 | P2 | FROZEN, status per finding filled in at the final stage |
| PR-5, PR-6, PR-8, PR-10, PR-13, N-1, N-2, R2-2, R2-3 | 9 | P2 | DOCUMENTED, not fixed, to NEXT ROUND |
| N-3, N-4, N-5 | 3 | P3 | DOCUMENTED, not fixed, to NEXT ROUND |
| **total** | **20** | | 8 frozen plus 12 carried, matching the bullets above |

**PR-9(b) is deliberately absent from this table.**
It is the deferred half of PR-9(a), which the first row already counts, and listing it as its own row is how the frozen version of this table enumerated 21 items against a stated total of 20 (REVIEW-0 RV3-B).
Its disposition is under §3 DEFERRED and §8.

Per-finding status with artifact evidence is filled in at the final stage, not here.

---

## 8 · NEXT ROUND

Findings above the cap, and anything discovered after Review 0, land here with full evidence and are **not** fixed in this run.

**Twelve findings carry to round 4:** PR-5, PR-6, PR-8, PR-10, PR-13, N-1, N-2, N-3, N-4, N-5, R2-2, R2-3.
Counted: PR-5, PR-6, PR-8, PR-10, PR-13 (5), N-1, N-2, N-3, N-4, N-5 (5, running 10), R2-2, R2-3 (2, running 12).

**Plus the deferred half of a frozen finding, which is not a thirteenth finding:**

- **PR-9(b), the statement timeout.** What would close it: measure `generateExport`'s row query and image loop against a realistic fiscal year, then set the timeout above the measured worst case rather than at a round number. Until that measurement exists, any value is a guess that can truncate an export.

**And three observations this round made that are not yet findings**, recorded so round 4 starts from them rather than rediscovering them:

- **The throw-versus-`errorSummary` asymmetry in `src/index.ts`.** Measured to leak nothing today (see NOT DEFECTS), so it is not graded. It is written down because the reasoning in the comment at `:117-123` applies to the branch eight lines above it and is not applied there, and "it happens to be safe" is the phrasing that same comment rejects.
- **N-4(b) is now a literal duplication rather than a shaped one**, introduced by round 2's own probe. `isMissingObject` exists byte-identically at `src/export/generateExport.ts:258-264` and `src/storage/s3ObjectStorage.ts:280-286`.
- **The probe key's disjointness is asserted in prose and tested nowhere** (`s3ObjectStorage.ts:267-273`). True by construction today.

---

## 9 · Citations re-resolved this round

`PROD-READINESS-ROUND-2.md` §9 lists five citations its own edits moved, and warns that every line number in either ledger is stale until resolved.
Taken literally: every citation used above was re-resolved against the working tree at `7035141`.
The five §9 entries were checked first.

| Round 2 said | Round 3 measured at `7035141` | Verdict |
|---|---|---|
| `src/index.ts:104` → `:183` (`llmParseSweep.kick()`) | `:183` | correct |
| `src/index.ts:66-75` → `:64-77` (the local-MinIO branch) | the branch tests at `:65` and its body runs `:66-78`; `:64` is the `storageConfig` assignment above it | **off by one at both ends, and used as-is nowhere in this ledger** |
| `s3ObjectStorage.ts:176-184` → `:300-308` (`isNotFound`) | `:300-308` | correct |
| `s3ObjectStorage.ts:149-162` → `:143-162` (`createBucketIfMissing`) | body at `:149-162`, docstring from `:143` | correct as annotated |
| `docs/Runbook.md:77` → `:86` | not re-resolved; no round-3 finding cites the Runbook | not needed |

Round 2's own P2 citations were re-resolved individually and are quoted inline in §1 above.
**Exactly one had drifted**, and it is corrected there rather than listed here: **PR-4** is `routes/exports.ts:147-153`, where round 2 cited `:150-153`, which is the body and omits the signature the finding is about.
*(The frozen version of this paragraph said "the two that had drifted" and then named R2-4 as the second while stating in the same sentence that round 2 had cited it correctly.
`PROD-READINESS-ROUND-2.md:462` does cite `productionEnv.ts:51-57` correctly.
REVIEW-0 RV3-D caught the self-contradiction.)*

---

## 10 · Passes

One commit per finding.
A pass no frozen finding touches is skipped and said so.
Filled in as the passes run.

| Pass | Runs? |
|---|---|
| 1 · Secrets, authn/authz, injection, vulnerable deps | **Runs** - PR-12 (session `sub`), PR-4 (export key isolation), R2-4 (`DATABASE_URL` TLS), PR-7 (image uid) |
| 2 · Correctness, resource leaks, Node/TS failure modes | **Runs** - PR-11 (tombstone guard) |
| 3 · Migrations, constraints, transactions, restore path | **Skipped** - no frozen finding. `drizzle-kit check` is clean at baseline and PR-11 changes a statement, not a schema |
| 4 · Timeouts, retries, idempotency, dependency-down behaviour | **Runs** - PR-9(a) (pool connect timeout) |
| 5 · Structured logging, error reporting, health signal | **Runs** - R3-1 (the storage refusal), R3-2 (the request log's `authenticated`) |
| 6 · Reproducible build, pinned deps, startup config validation | **Folded into pass 1** - R2-4 and PR-7 are both startup/build findings, and splitting either across two commits would leave one commit unverified |
| 7 · Tests | **Folded into every pass**, so each fix ships with the assertion that fails without it |
