# REVIEW-FINAL (round 2) - adversarial review of the complete round-2 diff

verdict: **PASS-WITH-FINDINGS**

Range reviewed: `b23ea08..cf794e8`, six commits, branch `prod-readiness/round-2`.
This is the final review over the whole round plus the full trail (`reviews/round2/BASELINE.md`, `REVIEW-0.md`, `REVIEW-1.md`), read against round 1's `PROD-READINESS.md`, `reviews/BASELINE.md` and `reviews/REVIEW-*.md`.

Ten files change and not one is under `ios/` or `web/`:

```
PROD-READINESS-ROUND-2.md                      | 450 +
docs/Runbook.md                                |  14 +-
reviews/round2/BASELINE.md                     | 150 +
reviews/round2/REVIEW-0.md                     | 377 +
reviews/round2/REVIEW-1.md                     | 387 +
server/src/db/client.ts                        |  79 +
server/src/index.ts                            |  83 +-
server/src/storage/s3ObjectStorage.ts          |  81 +
server/tests/integration/objectStorage.test.ts |  88 +
server/tests/integration/startupProbe.test.ts  | 254 +
```

Posture: I assumed the stage was defective and went looking for how.
Every sentence in the ledger, in both prior reviews, and in the stage's own code comments was treated as an unverified claim.
I re-ran every gate, re-checked citations against the files line by line, drove the real entrypoint through each failure mode it claims to handle, and mutated behaviour in a scratch copy rather than reasoning about the tests.
I edited no repository file: `git status --porcelain` was empty before this review and is empty after it, `HEAD` is still `cf794e8`, and the only file I add is this one.

Five findings.
Three of them are things no prior review measured, and two of those are behaviours that delete cleanly with the whole suite green.

---

## 1 · Gates, re-run

| Gate | Baseline requires | I measured | Verdict |
|---|---|---|---|
| `npm test` | 276 green, no regression | **287 passed / 31 files**, 0 failed, 0 skipped, exit 0, 27.9 s | no regression; 276 + the 11 this round adds |
| `npm run typecheck` | clean | exit 0, no output | reproduces |
| `npm audit` | 6 moderate | **6 moderate**, same `esbuild`/`uuid` composition | reproduces |
| Real entrypoint, guardrail 7 | `GET /api/me` → 401 + `Cache-Control: no-store` | **401**, `cache-control: no-store`, correct body | reproduces |

Guardrail 7 run the real way, from the production entrypoint, on port 3041:

```
$ PORT=3041 node --env-file=<copy of .env.local minus ANTHROPIC_API_KEY> --import tsx src/index.ts
Object storage: checking http://dev-mac.local:9000 for bucket "kept"
ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only
Kept API listening on port 3041

$ curl -s -i http://localhost:3041/api/me
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: application/json
content-length: 79
```

That start went through the **new** `else` branch: `.env.local` sets `STORAGE_*`, so `assertBucketReachable` ran against MinIO and announced itself first.
The changed storage path does execute at boot on this machine.

Every process I started used a copy of `server/.env.local` with the `ANTHROPIC_API_KEY` line removed (`grep -c ANTHROPIC` over the copy returns 0), and each printed `ANTHROPIC_API_KEY is not set`, which is the entrypoint's own witness that `llmParseSweep.kick()` was never reached.
Port 3000 was read once with `lsof` and left alone: pid 31468, started Sat 8 Aug 15:16:44 2026, alive and untouched.
My ports (3041-3045, 9098) are all free again.
One bucket was created in local MinIO by **my own** mutation MS4 and removed by me; `docker exec kept-minio ls -1 /data` reads `kept` alone at both ends.

---

## 2 · The mandated checks, each answered

**Fabricated or unreproducible findings.**
**Checked, clean.**
I reproduced the round's central claims independently rather than accepting them.
The pre-fix defect: a wrong `DATABASE_URL` password used to produce a listening process answering 401 to the Runbook's own deploy check.
The post-fix behaviour, on the real entrypoint at port 3042:

```
EXIT CODE: 1
Object storage: checking http://dev-mac.local:9000 for bucket "kept"
Database at localhost:5432 did not answer, so this process is refusing to serve. Check
DATABASE_URL and that the database is running and reachable from here.
Error: Database did not answer after 5 attempts
  caused by DatabaseError [message and detail withheld] code=28P01 routine=auth_failed

$ lsof -ti tcp:3042  ->  (nothing bound)
$ grep -c WRONG-PASSWORD-XYZ  ->  0
```

That is the ledger's §7 artifact block, reproduced on my own ports with my own commands, including the SQLSTATE and the routine.
REVIEW-1 F1 (the unbounded storage probe) is genuinely closed: against a TCP sink that accepts and never answers, the entrypoint refused in **11 s** with `caused by Error: Object storage did not answer within 10000ms`, exit 1, nothing bound.
REVIEW-1 F2 (the password in the refusal line) is genuinely closed, measured above and pinned by a test (§3, MD5).

**Citations that do not say what they are claimed to say.**
**One finding: F-5.**
I checked the ledger's citations against the files.
The large majority are exact, and I verified each of these myself: `receipts.ts:409-411` really is the `if (rows.length === 0) return rows;` short-circuit inside the transaction and `:415-423` really is the unguarded image update (so REVIEW-0's R0-2 correction landed correctly); `exports.ts:150-153` is `downloadUrlFor`; `writeFiles.ts:88-93` is `csvField`; `fly.toml:28` is `memory = "2gb"`; `productionEnv.ts:51-57` is the https check and `:59-65` the loopback check; `db/client.ts:11` is the bare `new Pool({ connectionString })`; `s3ObjectStorage.ts:149` is `createBucketIfMissing`.
R2-1's evidence citations resolve exactly **at `b23ea08`**, which I checked by `git show`: `index.ts:32-40` is the missing-env refusal, `:48` is `assertProductionEnv`, `:66-75` is the MinIO try/catch, `:78` is `const { db } = createDb(databaseUrl)`, `sessionAuth.ts:28-30` throws before the `:40` users lookup, and the `wave-6.md:137` quote is verbatim to the character.
What fails is three citations the stage's own edits invalidated and did not re-point - F-5.

**Severity inflation or deflation against the stated rubric.**
**One finding: F-1**, which is a deflation of a status rather than of a severity.
Everything else is graded defensibly.
R2-1 at P1 is right, and I decline the deflation to P2 the ledger offers for the same reason REVIEW-0 did: the project's documented deploy verification returns green against a machine that cannot reach its database, and a check that passes on a broken system converts operator attention into false confidence.
Not P0: no receipt is lost, no isolation boundary moves, the deploy completes.
The withdrawal of PR-5's proposed elevation back to P2 resolves against the round's interest in having work to do, which is the opposite of inflation, and the reasoning survives checking.
R2-2, R2-3 and R2-4 are correctly P2, and I re-derived R2-2's `csvField` and R2-4's `pg` TLS default rather than reading them.

**Smuggled features.**
**Checked, clean.**
No endpoint, screen, command, flag, table, column, migration, dependency or config key.
`git diff b23ea08..cf794e8 -- server/package.json server/package-lock.json server/drizzle server/fly.toml server/Dockerfile server/docker-compose.yml` returns **zero lines**.
No new `process.env.*` read is added anywhere in `server/src`.
`HeadBucketCommand` was already imported at `b23ea08` for `createBucketIfMissing`, so even the SDK surface is unchanged.
`assertBucketReachable` and `assertDatabaseReachable` are new exported functions, which is not a feature: both are read-only probes, neither changes any user-visible behaviour except that a misconfigured process exits instead of listening.

**Prohibited actions, anywhere in the range.**
**Checked, clean.**
`git reflog` shows six ordinary commits and one checkout across the range: no rebase, reset, amend, force, cherry-pick or tag operation.
`git remote -v` is empty, so nothing was or could be pushed.
`main` is still `ca82907` and neither round-1 nor round-2 branch is merged.
Nothing rotates, revokes or deletes a credential; the stage deletes no file; no `--no-verify` appears anywhere in the range.

**iOS files touched, anywhere in the range.**
**Checked, clean.**
`git diff --name-only b23ea08..cf794e8 -- ios web` returns nothing, across all six commits.
I did not read `ios/` for findings either.

**An Anthropic API call, anywhere in the range.**
**Checked, clean, and the stage is better than neutral.**
The only two added lines in the whole range that mention Anthropic are in `runEntrypoint`, which destructures `ANTHROPIC_API_KEY` out of the child's environment before spawning the real entrypoint, and comments why.
That means `npm test` cannot bill the card even on a machine where the key is exported, and it is the correct instinct.
I ran no `parse-llm-*` script, and every process I started printed `ANTHROPIC_API_KEY is not set` or exited before that line.

**Fixes that relocated a bug rather than removed it.**
**Checked, clean.**
This was REVIEW-1's F1 - the storage probe that moved a diagnosable failure into a silent hang - and the remediation removes it rather than moving it again.
I pressed the one place a relocation could hide: `assertBucketReachable` abandons an in-flight `send()` on timeout and then calls `client.destroy()` in its `finally`, which is exactly the shape that produces an unhandled rejection and, in Node, a dead process.
Measured outside vitest, where that would actually happen: the probe rejected at 1.5 s as designed, the process stayed up for a further 25 s with `unhandledRejection` and `uncaughtException` handlers installed, printed `PROBE A SURVIVED (no unhandled rejection)` and exited 0.
The same check on the real entrypoint reported zero occurrences of either.
The database probe's analogous cost - a timed-out attempt leaving its checkout behind - is bounded, correctly stated in its own docstring after REVIEW-1 F4c, and startup-only.

**Error handling that hides errors.**
**Checked, clean.**
Neither new catch swallows anything.
The database catch prints a named message plus `errorSummary(error)` and exits 1; the storage catch rethrows with `{ cause }`.
I checked the asymmetry the database catch's own comment worries about - that a thrown error is dumped by node's default handler - by triggering it with a wrong `STORAGE_SECRET_ACCESS_KEY` and reading every byte of what came out.
What node dumps is `$fault`, `$retryable`, `$metadata` (httpStatusCode 403, request ids), and frames.
The secret appears **0** times and `Credential=` appears **0** times.
So the asymmetry is real in principle and harmless as measured; I record it as an observation rather than a finding because I could not make it leak.
The redaction on the database side holds: `DatabaseError [message and detail withheld] code=28P01 routine=auth_failed` keeps the SQLSTATE and drops the parameters, which is round 1's PR-2 still working through a path that did not exist when PR-2 was written.
I also re-tested REVIEW-1's truncation concern through a real pipe rather than a file redirect, five runs: 6 lines every time, with both `console.error` calls intact.

**Verification that does not exercise the changed path.**
**Two findings: F-2 and F-3.**
The database half is exercised from outside the vitest worker, correctly, and its refusal is pinned.
Two changed paths are not: the entrypoint's storage refusal branch (F-3) and the probe's production retry budget (F-2).
Both delete cleanly with the full suite at 287/287, and I deleted them rather than reasoning about them.

**Anything marked resolved without an artifact.**
**One finding: F-1.**
§7 marks R2-1 **RESOLVED** and prints artifacts.
The database half's artifacts reproduce on my hardware from my own commands.
The storage half's do too, locally - but the storage probe's production precondition has never been exercised against the deployment target and the ledger itself says the consequence of it being wrong is P0.
"RESOLVED" is not supportable for that half.

---

## 3 · Tests: would they still pass if the behaviour they verify were deleted?

The stage adds **11** tests and its BASELINE cites **2** round-1 artifacts.
I built a complete copy of `src`, `tests`, `drizzle`, `vitest.config.ts`, `tsconfig.json`, `drizzle.config.ts` and `package.json` in my scratchpad with `node_modules` symlinked, and mutated **the copy**.
No repository file was edited at any point.
Every mutation was predicted in writing first, then run, then the gap recorded.

| # | Mutation applied to the scratch copy | Predicted | Actual | Can the tests fail? |
|---|---|---|---|---|
| MS1 | `assertBucketReachable` body → `return;` | 3 of the 4 storage-probe tests fail | **3 failed / 11**, all three `promise resolved "undefined" instead of rejecting` | **YES** |
| MS2 | the timeout race removed, bare `HeadBucket` | the never-answers test fails by timing out | **1 failed**, `Test timed out in 30000ms` at 30 009 ms | **YES** |
| MS4 | probe delegates to `createBucketIfMissing` (it creates) | the read-only test fails on its second assertion | **2 failed**, incl. `rejects a bucket that does not exist, and does not create it` | **YES** |
| MD1 | the whole database-probe block deleted from `index.ts` | entrypoint tests fail on the listening-line assertion, not the exit code | **2 failed / 7**, `expected 'Object storage: local MinIO default a…' not to contain 'Kept API listening'` | **YES** |
| MD2b | `attempts` forced to 1, ignoring the caller's option | 3 fail | **3 failed / 7** - retry case plus both "after 2 attempts" cases | **YES** |
| MD3 | `withTimeout(pool.query(…))` → bare `pool.query(…)` | the never-settles case fails by timing out | **1 failed**, `Test timed out in 5000ms` | **YES** |
| MD5 | `describeDatabaseTarget` renders `identity.database` again (reverts F2) | the password test fails | **1 failed**, `not to contain 's3cr3t-PASSWORD'` | **YES** |
| MD6 | the refusal logs but does not `process.exit(1)` | both entrypoint failure tests fail | **2 failed / 7**, on the listening line | **YES** |
| **MD2d** | **`attempts ?? 5` → 1 and `delayMs ?? 1000` → 0** | **287 green - the retry budget is unpinned** | **287 passed / 287** | **NO** - F-2 |
| **MSE** | **the entire storage `else` branch deleted from `index.ts`** | **287 green - the wiring is untested** | **287 passed / 287** | **NO** - F-3 |
| MC1 | `pool.on("error", …)` removed (BASELINE's PR-1 citation) | all 3 dbClient tests fail | **3 failed / 3** | **YES** |
| MC2 | **order only** of the two export remedies swapped, same words, same receipt id (BASELINE's R-1 citation) | the ordering assertion fails | **1 failed**, `expected 143 to be greater than 222` | **YES** |

**Nine of the eleven mutations that should fail a test did fail one, and both cited round-1 artifacts are falsifiable** - MC2 fails on an order-only mutation, which is the tightest form of the behaviour it claims to pin, and MC1 takes all three dbClient tests with it.
REVIEW-1's F3 is genuinely closed at the function level: `assertBucketReachable` used to delete with the suite green and now takes three tests with it.

**Two mutations found live gaps, MD2d and MSE, and they are F-2 and F-3.**

On the stage's own falsification comment, which I checked rather than read.
`startupProbe.test.ts:122-133` claims all four `assertDatabaseReachable` cases were falsified and names three mutations.
Under the reading REVIEW-1 used - force the resolved value, ignoring the caller's option - the claim is **exact**: MD2b fails the retry case and both cases that pin the "after 2 attempts" wording, which is three of the four, and MD5-style inversion covers the fourth.
Under the other available reading - change the **default** - it is false, and that is MD2d.
I am not calling the comment fabricated, because its intended reading reproduces to the letter; I am reporting the gap the second reading exposes as F-2, because that gap is real regardless of which mutation the comment meant.
The comment's admission that `"rejects a wrong credential rather than waiting forever"` is weak on its own, and discriminates only in company with the resolves-when-answering case, is correct and is the right thing to have written down.

---

## 4 · The final-review questions, answered specifically

**Defects introduced across pass boundaries.**
**Checked, clean.**
I diffed each boundary rather than the endpoints.
`f62ff9a..cf794e8` touches `db/client.ts` in comments only - no behaviour changes - and the code change is confined to `s3ObjectStorage.ts` (the timeout and `destroy`), `index.ts` (the announce line and `describeDatabaseTarget`), and the two test files.
Nothing that worked at `f62ff9a` is broken at `cf794e8`: I re-ran the healthy start, the database refusal, the storage refusal and guardrail 7 at HEAD and all four behave correctly.
`describeDatabaseTarget` is used at `index.ts:125` and declared at `:150`, which is legal only because it is a function declaration and hoisted; it works, and the tests exercise it, but it is the one place in the new code where the reading order fights the execution order.

**Stage 0 assumptions that later evidence contradicted.**
**Two, and the stage handled one of them well and left the other standing.**
Handled well: Stage 0's R2-1 fix text proposed a `HeadBucket` probe with no note that the permission had never been exercised.
REVIEW-1 F6 caught it and the ledger now carries it as ASSUMPTION 9 and RULING 7, with the P0 consequence stated in the ledger's own words - that is the discipline working.
Left standing: §0's summary sentence, which is F-4.
ASSUMPTION 3 (pid 31468 on port 3000) I confirmed to the minute and left alone; ASSUMPTION 5 and 7 remain genuinely unmeasurable here and are resolved conservatively as the run's rule requires.

**Work that expanded past the frozen list.**
**Checked, clean.**
The frozen list is exactly one item, R2-1, and every code change traces to it or to a defect the fix itself introduced.
`db/client.ts`, `index.ts` and `s3ObjectStorage.ts` are R2-1; the `docs/Runbook.md` edit is REVIEW-1 F5, which is the operator documentation of behaviour this stage changed rather than new work; the two test files are pass 7 folded in.
Nothing on the P2/P3 set was fixed: PR-4 through PR-13, N-1 through N-5, R2-2, R2-3 and R2-4 are all still documented and unfixed, which I verified by diffing the files they cite - `exports.ts`, `writeFiles.ts`, `receipts.ts`, `session.ts`, `schema.ts`, `Dockerfile`, `fly.toml`, `drizzle.config.ts` and `productionEnv.ts` are **untouched across the whole range**.
That is the strongest single piece of evidence against scope drift and I want it recorded as such.

**Drift toward scope expansion over time.**
**Checked, clean, and the trend runs the other way.**
Commit 1 is a ledger, commit 3 corrects that ledger downward after review, commit 4 is the fix, commit 6 is remediation of the fix.
The one thing that grew is the number of P2s *documented* (R2-4 added from REVIEW-0 R0-3), which costs the round work rather than claiming it.

**Whether REVIEW-0's and REVIEW-1's findings were actually addressed or merely described as addressed.**
**Checked against artifacts; eight of nine genuinely addressed, one partially.**

| Finding | Claim | What I verified |
|---|---|---|
| R0-1 | PR-9 headline corrected | Heading now reads "no connection timeout and no statement timeout" with the `max`/`idleTimeoutMillis` defaults measured in the body. **Addressed** |
| R0-2 | PR-11 citation re-pointed | Now cites `:409-411`, names `visibleTo` as the reason, and records the wrong `:426-428` in place. I confirmed `:409-411` is the short-circuit. **Addressed** |
| R0-3 | carried as a new P2 | Present as R2-4 in §8 with the `pg` `ssl: undefined` measurement, which I reproduced. **Addressed** |
| F1 | storage probe bounded | Measured: 11 s, exit 1, named cause, nothing bound. Pinned by a test (MS2). **Addressed** |
| F2 | password kept out of the refusal | Measured: host and port only, `grep -c` on the fabricated password returns 0. Pinned by a test (MD5). **Addressed** |
| F3 | storage probe now has tests | Four cases added; MS1 takes three of them. **Addressed at the function level, not at the entrypoint - F-3** |
| F4 | three comments corrected | (a) count now four with the mutations named; (b) "one attempt" replaced by "retries are the SDK's own", which matches what I measured (`attempts: 1` on a 403, non-retryable); (c) now states up to four stray checkouts and a worst case pool of 6. **Addressed** |
| F5 | Runbook updated | §0 gains both refusals with their budgets, §7 step 2 and step 4 updated. The documented budgets match the code. **Addressed** |
| F6 | recorded as an assumption | ASSUMPTION 9 and RULING 7, with the P0 consequence stated. **Recorded, not retired - F-1** |

No finding is merely described as addressed.
The two that fall short fall short by being incomplete, not by being misreported.

---

## 5 · Findings

### F-1 · P1 · R2-1 is marked RESOLVED, but half of the fix it resolves is a boot-blocking gate on a permission nothing in this repository has ever exercised

`PROD-READINESS-ROUND-2.md:382` reads `R2-1 | P1 | **RESOLVED** - artifacts below`.
The artifacts under it are local: MinIO, local Postgres, my own reproduction agrees with all of them.
But `server/src/index.ts:93` now makes a successful `HeadBucket` a precondition of the process serving at all, and ASSUMPTION 9 (`:290-293`) records that no one has confirmed a bucket-scoped R2 token permits that call.
The ledger states the consequence itself, in its own words: *"If the assumption is wrong the consequence is 'cannot deploy', which is P0"*.

`assertBucketReachable` propagates any error, so a `403 AccessDenied` on a bucket that is present and writable is indistinguishable from a wrong credential.
I confirmed the shape locally: a wrong secret produces `httpStatusCode: 403` and the process exits 1.
Against R2 a permission denial would produce the same 403 and the same refusal, on a machine that would otherwise have served.
`npm run storage:probe-keys` - the one thing that has ever run against R2 - exercises `GetObject` and `PutObject`, not `HeadBucket`, which I verified.

REVIEW-1 F6 asked for one of three things: record the assumption, fail open on 403, or **probe with an operation the application actually performs**.
The round took the first, which is the only one of the three that leaves the risk live, and then marked the finding RESOLVED.
The third option would have removed the assumption entirely at no cost in strictness, using the operation `storage:probe-keys` already proves works against R2.

**P1, with both neighbouring arguments stated because this is the round's own standard applied to the round's own status table.**
The P0 argument is the ledger's: if the token denies `HeadBucket`, every production boot fails, and "cannot deploy" is the P0 band verbatim.
It does not reach P0 because the precondition is conditional and probably satisfied - read-scoped S3-compatible tokens conventionally permit `HeadBucket` - because the refusal is loud and its message names the permission as a candidate cause, because no receipt is lost, and because the rubric says to take the lower of an ambiguous pair.
It does not deflate to P2 because this is exactly the argument REVIEW-0 used to keep R2-1 itself at P1: a status that reads green on a system whose precondition has never been checked converts operator attention into false confidence.
A reader of §7 sees RESOLVED; the fact that the storage half is gated on RULING 7 lives 300 lines away.

*Fix.* Either change the §7 row to resolve the database half and mark the storage half pending RULING 7, or switch the probe to the operation `storage:probe-keys` already exercises, which retires ASSUMPTION 9 and RULING 7 together.

### F-2 · P2 · The database probe's production retry budget is pinned by no test: `attempts` 5 → 1 and `delayMs` 1000 → 0 leaves the full suite at 287/287

`server/src/db/client.ts:74-76`:

```ts
const attempts = options.attempts ?? 5;
const delayMs = options.delayMs ?? 1000;
const timeoutMs = options.timeoutMs ?? 5000;
```

All four `assertDatabaseReachable` unit tests pass `attempts` explicitly (`:42`, `:67`, `:85`), so none of them exercises a default.
The three entrypoint tests do call the default shape - `index.ts:115` is `assertDatabaseReachable(pool)` with no options, the only call site in `src/` - but none of them discriminates on the retry count.

Predicted, then run: MD2d set `attempts ?? 1` and `delayMs ?? 0` and the full suite returned **287 passed / 287**.

The retry loop is not incidental.
It is the whole reason the probe is safe to put in front of an autosuspending database: ASSUMPTION 5 makes Neon's cold start the expected first-connection experience, ASSUMPTION 6 makes "exit rather than serve" an improvement only because the platform restarts, and the probe's own docstring says crashing on a waking compute "would turn a routine cold start into a restart loop".
As of this commit `docs/Runbook.md:54` also states the budget to operators as fact: "retried up to five times a second apart with a 5-second cap on each attempt".
Every one of those sentences is now load-bearing and none of them is defended by an assertion.
A round-3 change that reduced the budget would pass every gate this project has, and the failure it reintroduces - a crash loop on every cold start - appears only against Neon, which is the one environment nothing here can test.

**P2, not P1, and the reasoning.**
The code is correct today; this is a coverage gap, not a runtime defect, and it does not meet "fails under realistic load or edge input" as things stand.
It matches the precedent this round already set - REVIEW-1 graded F3, a whole function that deleted with the suite green, at P2 on the ground that a missing test is not itself a runtime defect.
It is not P3 because the untested constants are the ones an operator has now been told about in the Runbook.

*Fix.* One case calling `assertDatabaseReachable(flakyPool)` with **no options**, where the fake refuses three times and then answers, asserting it resolves - which fails the moment the default drops below four.

### F-3 · P2 · The entrypoint's storage refusal branch deletes whole with the suite at 287/287, so REVIEW-1 F3 is closed for the function and open for the wiring

`server/src/index.ts:79-105` - the announce line, the `try`, the `await assertBucketReachable(storageConfig)`, and the refusal that names `STORAGE_ENDPOINT`, `STORAGE_BUCKET` and the credentials.

Predicted, then run: MSE deleted the entire `else` branch and the full suite returned **287 passed / 287**.

The cause is visible in the mutation output of MD1 and MD6, which both fail with `expected 'Object storage: local MinIO default a…' not to contain 'Kept API listening'`.
`runEntrypoint` (`startupProbe.test.ts:203-228`) inherits the ambient environment and overrides only `DATABASE_URL`, `PORT`, `SESSION_JWT_SECRET` and `APPLE_CLIENT_ID`.
No `STORAGE_*` is in the shell and vitest loads no `.env.local`, which I confirmed both ways, so every spawned child takes the **local-MinIO** branch and the new branch is never entered by any test.

The ledger says F3 was "closed with four cases in `tests/integration/objectStorage.test.ts`", and for `assertBucketReachable` itself that is true and I proved it (MS1).
What has no test is that the entrypoint calls it, catches it, names the four variables, and refuses - all of which the Runbook now documents as operator-facing behaviour ("the process names the endpoint and bucket and exits 1").
Those claims rest on manual artifacts in §7, not on an assertion.
The asymmetry is the notable part: the database half got a child-process test precisely because "the process refuses to serve" is not observable from inside a vitest worker, and the storage half makes the same claim with no such test, in a harness that already exists three lines away.

A second consequence of the same design, short of a finding on its own: because the child inherits the shell, `npm test` on a machine with production `STORAGE_*` exported would issue `HeadBucket` against R2 during the test run.
REVIEW-1 raised this as a robustness note before the storage probe existed; it now has a network call behind it.

**P2**, on the same reasoning as F-2 and the same precedent as REVIEW-1 F3: no runtime defect, and the runtime consequence this gap allowed through last time (F1) has already been graded and fixed.

*Fix.* Add `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY` to `runEntrypoint`'s child environment - pointing at MinIO for the healthy case and at a dead port for the refusal case - which also pins the child onto a known storage branch instead of the developer's shell.

### F-4 · P2 · §0 still tells a round-3 reader that every round-1 citation was re-checked to the line, after REVIEW-0 found two that were not

`PROD-READINESS-ROUND-2.md:28`: "Nothing was struck as fabricated. Every round-1 citation re-checked to the line."

REVIEW-0 disproved the second sentence and said so in its verdict: *"the sentence 'every round-1 citation re-checked to the line' is not quite true, and the two places it fails are a claim nobody measured (R0-1) and a citation that points past the thing it is cited for (R0-2)."*
Commit `0126c2a` is titled "Correct the ledger citations Review 0 measured wrong" and it did correct both entries, annotating each in place - which is the right way to do it.
It did not correct the summary sentence that generalised from them, and that sentence is what a round-3 builder reads first.

This matters more than a normal wording defect because §0 is the section whose entire purpose is to say how much of round 1 was re-derived rather than inherited, and inheriting a sentence instead of re-deriving it is the failure mode this project names most often.
The ledger is otherwise scrupulous about this: PR-9 carries "(headline corrected at REVIEW-0 R0-1)", PR-11 carries its own wrong first draft, and PR-5 records a severity that moved and moved back.

**P2.** No runtime consequence; it is an accuracy defect in the document that is the round's deliverable.

*Fix.* One clause: every round-1 citation was re-checked and two did not survive, named, with a pointer to the corrected entries.

### F-5 · P2 · Three ledger citations were invalidated by this stage's own edits and none was re-pointed

The ledger's §1 states that "line numbers below are this round's, not round 1's copy".
Three citations presented as current facts no longer resolve at HEAD, all three because a file this range edits moved them.

| Ledger site | Cites | At `b23ea08` | At HEAD |
|---|---|---|---|
| `:85` (R2-1, "In fairness to the Runbook") | `docs/Runbook.md:77` | correct - the 401 sentence | the sentence is at **`:86`**; `:77` reads "An exit code is not evidence…" |
| `:283` (ASSUMPTION 2) and `BASELINE.md:116` | `src/index.ts:104` "kicks the sweep at startup" | correct | `:104` is a comment line inside the new probe block; `llmParseSweep.kick()` is at **`:183`** |
| `:271` (N-4b) | `src/storage/s3ObjectStorage.ts:176-184` for `isNotFound` | correct | that range is now inside `assertBucketReachable`'s docstring; `isNotFound` is at **`:257`** |

The Runbook one is inside R2-1's own fairness argument, which is precisely the sentence a sceptical reader would go and check.
ASSUMPTION 2 is the ledger's Anthropic-safety justification and is worded as a live fact about the current code, not as history.
N-4 is carried forward as round 3's input, so its citation is aimed at a future reader by design.

R2-1's evidence citations into `index.ts` (`:32-40`, `:48`, `:66-75`, `:78`) have also moved, but those describe the **pre-fix** defect and resolve exactly at `b23ea08`, which I verified by `git show`; that is defensible as historical evidence, though the ledger never says which commit they are relative to.
`db/client.ts:11` and `s3ObjectStorage.ts:149` still resolve at HEAD, so this is not a general collapse - it is three sites.

**P2**, and the same class REVIEW-0 graded R0-2 at P2: a reader checking the argument is sent to a line that does not contain it.
No runtime consequence.

*Fix.* Re-point the three, and state which commit R2-1's evidence line numbers are relative to.

---

## 6 · What the round got right, stated so the findings are read in proportion

The defect R2-1 named is genuinely gone, and I proved it from the production entrypoint rather than from the suite.
A wrong `DATABASE_URL` password no longer produces a process that prints "Kept API listening", holds the port, and satisfies the deploy check documented in three places.
It refuses in under 5 s, names the host and port without the password, keeps the SQLSTATE, and binds nothing.

The falsification method is the right one and was performed rather than described.
Spawning the entrypoint as a child so the assertion is an exit code and an output stream read from outside is the only honest way to test "the process refuses to serve", and the recorded predicted-versus-actual gap in the test file - that the failure lands on the listening-line assertion rather than the exit code - is real, reproducible, and more useful than a clean prediction would have been.

Both P1 regressions the fix introduced were caught inside the round and repaired in it rather than carried, which is the rule working as written.
The storage probe is read-only and is deliberately not a method on `ObjectStorage`, which honours RULING 1 rather than deciding it in passing; `client.destroy()` releases the abandoned socket and I could not make it produce an unhandled rejection; `ANTHROPIC_API_KEY` is stripped from the test harness's child environment on purpose; and the P2/P3 set was documented and left alone, which I verified file by file.

The trail also does the thing it is for.
REVIEW-0 corrected the ledger downward, REVIEW-1 found two P1s in the fix, and the remediation commit closed all six of REVIEW-1's findings to the extent that any of them was closable here.

---

## 7 · Routing

| id | severity | routes to |
|---|---|---|
| F-1 | P1 | §7 status row, or switch the probe to the operation `storage:probe-keys` exercises and retire ASSUMPTION 9 / RULING 7 |
| F-2 | P2 | one test calling `assertDatabaseReachable` with no options against a pool that refuses three times then answers |
| F-3 | P2 | `STORAGE_*` in `runEntrypoint`'s child environment, plus a healthy case and a refusal case |
| F-4 | P2 | one clause in `PROD-READINESS-ROUND-2.md:28` |
| F-5 | P2 | re-point three citations; state the commit R2-1's evidence is relative to |

F-1 is the only one that could change code, and even there the cheaper half of the fix is a status correction.
None of the five needs a new module, endpoint, config key or dependency, so all are inside the scope constraint.

---

## 8 · Verdict

The baseline does not regress: **287 tests green** against a required 276, `tsc --noEmit` clean, `npm audit` unchanged at 6 moderate, and the real entrypoint started the real way answers `GET /api/me` with 401 and `Cache-Control: no-store`.
Across all six commits there is no fabrication, no smuggled feature, no prohibited action, no iOS file, no Anthropic call, no new dependency or config key, and no fix that relocated a bug.
REVIEW-0's three findings and REVIEW-1's six are genuinely addressed rather than described as addressed, with one recorded rather than retired.
Nine of eleven mutations fail a test, both cited round-1 artifacts are falsifiable, and I deleted the behaviour rather than reasoning about it in every case.

It is not a PASS because two changed behaviours delete cleanly with the whole suite green - the probe's production retry budget and the entrypoint's entire storage refusal branch - and because the round's single frozen finding is marked RESOLVED while half of its fix is a boot-blocking gate on a permission this repository has never exercised and whose failure the ledger itself grades P0.
None of the five findings is a defect in the running code, which is why this is not a REJECT: the fix works, and I measured it working.

**PASS-WITH-FINDINGS**
