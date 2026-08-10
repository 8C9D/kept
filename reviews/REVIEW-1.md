# REVIEW-1 - adversarial review of the PR-1 code stage

verdict: PASS-WITH-FINDINGS

Range reviewed: `2856284..c1104b9` (1 commit, 211 insertions, 3 files, 0 deletions).
Reviewed at `HEAD = c1104b9`, branch `prod-readiness/2026-08-10`.
Working tree clean before this review and clean after it (`git status --porcelain` empty, verified twice - the falsification edits below were reverted with `git checkout --`).
Everything below I re-ran myself against `reviews/BASELINE.md`. No builder narration was available and none was used.

---

## 1 · What the stage contains

```
$ git diff --name-status 2856284..c1104b9
M	server/src/db/client.ts
A	server/tests/helpers/poolSurvivalChild.ts
A	server/tests/integration/dbClient.test.ts
```

The code change is one added listener in `createDb`:

```ts
// server/src/db/client.ts:30-32
pool.on("error", (error) => {
  console.error("Idle database connection error:", errorSummary(error));
});
```

This is exactly the fix `PROD-READINESS.md:123` specified for PR-1, in exactly the blast radius it declared (`:125`, "one function, `src/db/client.ts`"). No endpoint, no screen, no command, no flag, no table, no column, no config key, no dependency. Nothing under `ios/` appears anywhere in the branch (`git diff --name-only ca82907..c1104b9 | grep -c '^ios/'` → `0`).

---

## 2 · Compliance checks the contract requires, each answered

| Check | Result |
|---|---|
| Fabricated or unreproducible findings | **None.** The stage asserts nothing in a document; its only claims are code comments, and all but one of those I verified against source or measurement (the exception is F-3 below). |
| Evidence citations that don't say what they're claimed to say | **One, in a code comment, not in evidence** - F-3. |
| Severity inflation / deflation | N/A - the stage assigns no severities. It closed the P1 the frozen list ordered first by blast radius, which is the order `PROD-READINESS.md:331` states. |
| Features smuggled in under the no-features rule | **None.** See §1. The only new runtime behaviour is a log line on an event that previously killed the process. |
| Prohibited actions taken | **None detectable.** `git merge-base --is-ancestor 2856284 c1104b9` passes and `ca82907` is still an ancestor of `HEAD` - history is append-only, no rewrite. `git remote -v` is empty, so no push was possible. `git tag` is empty. `main` still points at `ca829075c15f2d0588a145126fa033147b118621`. Reflog shows three linear commits on the branch and no `rebase`/`reset`/`amend` entries. No file was deleted (0 deletions in the range). No credential touched. |
| iOS files touched | **None**, in this stage or anywhere on the branch. |
| An Anthropic API call made | **No positive evidence, and corroborating evidence against.** The run's on-disk environment files (`env.nollm`, `env.test`, `env.review` in the run scratchpad) carry the key names `DATABASE_URL`, `SESSION_JWT_SECRET`, `APPLE_CLIENT_ID`, `STORAGE_*` and **no `ANTHROPIC_API_KEY`**; every `DATABASE_URL` is `localhost:5432`. I read key names only, not values. The added test file imports `db/client.js` and `drizzle-orm` only - no path from it reaches `parse/`. My own entrypoint runs (below) were started with the key absent and the server said so at boot. This cannot prove a negative and I do not claim it does. |
| Fixes that relocated a bug rather than removed it | **No, for the API process** - measured, §3.2/§3.3. **Partially, for the tooling**: five `new Pool` sites outside `createDb` still carry the defect. F-2. |
| Error handling that hides errors | **No.** `pg-pool/index.js:62` is the *only* `pool.emit('error', ...)` site in the library, and it lives inside `makeIdleListener` - reached solely for a client that is already idle and has already been `_remove`d from the pool. So the listener cannot intercept an error that had any other delivery path: an in-flight query still rejects through its own promise, and a failed checkout still rejects `pool.connect()`. The code comment's claim at `client.ts:27-29` is accurate, and I verified it from the library source rather than taking it. |
| Verification that doesn't exercise the changed path | **No.** All three tests fail when the listener is deleted - proved by falsification, §3.1. |
| Anything marked resolved without an artifact | **Nothing is marked resolved - which is itself the problem.** `PROD-READINESS.md:336` still reads `PR-1 | P1 | OPEN` at `HEAD`, after the commit that closed it. F-1. |

---

## 3 · What I re-ran, and what it produced

**Predictions were written before each run and are stated with their outcomes.**

### 3.0 Baseline and gates

```
$ npm run typecheck        -> exit 0, no output   (BASELINE: clean)
$ npm test                 -> Test Files 29 passed (29) / Tests 266 passed (266)
```

Baseline was 28 files / 263 tests. The delta is exactly the three added tests; no pre-existing test changed state. Run three times total (19:39, 19:46, 19:47), 266/266 every time, so the new child-process test is not flaky on this machine.

### 3.1 Falsification of the tests (the check this repository exists to make)

I temporarily deleted the listener from `src/db/client.ts`, ran the new file, and restored with `git checkout --`.

**Predicted:** all three tests fail. **Observed:** all three fail, each on its own assertion, and the worker was *not* killed:

```
❯ tests/integration/dbClient.test.ts (3 tests | 3 failed)
  × keeps a process alive when the server terminates its idle connection
      AssertionError: expected 'READY\n' to contain 'SURVIVED'
  × logs the terminated connection without reproducing the database error's text
      AssertionError: expected undefined to be defined      (dbClient.test.ts:120)
  × does not throw when the pool emits an error with no client attached
      AssertionError: expected [Function] to not throw an error but 'Error: synthetic' was thrown
```

The first failure is the defect's exact signature: the child printed `READY` and then died before it could print `SURVIVED`.

Second falsification, narrower - listener kept, `errorSummary(error)` replaced with the raw `error`:

**Predicted:** test 2 fails on both redaction assertions. **Observed:** it fails on the first of them, which is enough:

```
AssertionError: expected 'Idle database connection error: error…' to contain '57P01'
Received: "Idle database connection error: error: terminating connection due to administrator command"
```

The received string also contains `terminating connection`, so the `not.toContain` assertion on the next line would have failed too. Both halves of the redaction claim are load-bearing.

`git status --porcelain` empty after restore.

### 3.2 The original PR-1 reproduction, re-run against the fixed real entrypoint (guardrail 7)

Real entrypoint, started the real way (`node --env-file=<env> --import tsx src/index.ts`), port 3007, `DATABASE_URL` on `kept_test`, `ANTHROPIC_API_KEY` absent, docker-compose MinIO. Port 3000's pre-existing pid 31468 left alone throughout and confirmed still alive at the end.

**Predicted:** authenticated 200, then `pg_terminate_backend` on the idle connection, then the process stays alive, logs one redacted line, and answers a second authenticated 200.

**Observed, exactly:**

```
$ curl -H "Authorization: Bearer <valid>" localhost:3007/api/me   -> 200
$ psql -d kept_test -c "select pg_terminate_backend(pid) from pg_stat_activity
                        where datname='kept_test' and state='idle' and pid <> pg_backend_pid()"  -> t
$ ps -p 32443    -> 32443 node        (alive; at baseline this was empty)
$ lsof -ti tcp:3007 -> 32443          (listening; at baseline this was empty)
$ curl -H "Authorization: Bearer <valid>" localhost:3007/api/me   -> 200

server log:
Idle database connection error: DatabaseError [message and detail withheld] code=57P01 routine=ProcessInterrupts
```

That log line is the PR-2 class checked in the same breath: SQLSTATE and routine survive, the message does not, and `pg-pool` attaches `err.client = client` - an object whose `connectionParameters` carries the **database password** (I saw it in vitest's own serialized dump of the unhandled error during §3.1). `errorSummary`'s database branch prints only name plus safe *string* fields, so neither the message nor `client` reaches the log. The fix does not open a new leak.

### 3.3 Recovery under concurrent load, which no test covers

**Predicted:** if `pg` really discards and reopens, killing every idle backend mid-traffic costs zero requests.

Eight connections warmed, then all eight terminated at once during a 60-request run, then a ninth later:

```
idle-before=8
terminated: 8, then 1
--- histogram ---
  60 200
SERVER ALIVE
final=200
```

Nine redacted log lines, no leak, no non-200. The fix is not merely non-fatal; the pool genuinely recovers. This is the part of the fix the suite does not assert, and it holds.

---

## 4 · Findings

Format: `severity | evidence | why the builder missed it`.

---

### F-1 · P2 · The ledger still says PR-1 is OPEN at the commit that closed it

**Severity: P2 | Evidence: `PROD-READINESS.md:336` at `HEAD = c1104b9` reads `| PR-1 | P1 | OPEN |`; `git diff --name-status 2856284..c1104b9` shows `PROD-READINESS.md` is not in the stage | Why missed: the fix and the record of the fix were treated as separable, and the commit closed the first without the second**

`PROD-READINESS.md:329` states "Filled in as passes complete", and `:14` of `CLAUDE.md`'s doc-ownership rule exists because this project has already lost three days to a decision that reached one document and not the other. The commit message - `Stop a terminated idle database connection from killing the server` - is a good one-line summary but names no finding id, so nothing in the committed history connects this diff to PR-1 except a reader's inference. At `HEAD`, the run's own deliverable misreports the run's own state.

This is the inverse of the contract's "anything marked resolved without an artifact": here the artifact exists and the mark does not. It is P2 because no code is wrong and the omission is recoverable in one edit - but it is exactly the bookkeeping failure the project's doc rule was written against, so it should not close silently.

---

### F-2 · P2 · The same crash remains live in five tooling entrypoints, and the ledger's blast-radius sentence reads as though it did not

**Severity: P2 | Evidence: `grep -rn "new Pool" server/src/` | Why missed: the finding was scoped to `createDb`, and "every caller of createDb" was allowed to stand in for "every pool"**

`PROD-READINESS.md:125` says the fix reaches "Every caller of `createDb` (server, tests, dev scripts, restore verifier)". That sentence is true and is also misleading, because five of the seven dev scripts are not callers of `createDb`:

```
src/db/seed.ts:20                const pool = new Pool({ connectionString: databaseUrl });
src/db/claim.ts:25               const pool = new Pool({ connectionString: databaseUrl });
src/db/llmParseProbe.ts:56       const pool = new Pool({ connectionString: databaseUrl });
src/db/llmPromptReparse.ts:53    const pool = new Pool({ connectionString: databaseUrl });
src/db/parseAccuracyReport.ts:26 const pool = new Pool({
tests/helpers/globalSetup.ts:23  const pool = new Pool({ connectionString: testUrl });
```

`verifyRestore.ts:58-59` and `llmBackfill.ts:46` do use `createDb` and are covered. The one that matters operationally is `llmPromptReparse.ts`: `:60-72` selects every confirmed receipt and then loops over them making a real model call per receipt per run, which is precisely the long-lived, mostly-idle process an autosuspend or a connection reap kills. Same defect, same SQLSTATE, same uncaught `'error'`, and it dies mid-run with no listener.

I am **not** calling this a relocated bug. The API process - the thing PR-1 was about - is genuinely fixed, measured three ways in §3. This is a residual instance of the class in the tooling, which the run's own scope statement ("`server/` **and its tooling**", `PROD-READINESS.md:7`) covers. P2: these are operator-run, restartable, and none of them writes anything a rerun cannot redo. It belongs in NEXT ROUND rather than in this stage, but the sentence at `:125` should not be left implying coverage the code does not have.

---

### F-3 · P2 · A committed comment states the opposite of what the tests actually do when falsified, and contradicts the other file in the same commit

**Severity: P2 | Evidence: `tests/integration/dbClient.test.ts:22-26` vs. my falsification run in §3.1, and vs. `tests/helpers/poolSurvivalChild.ts:6-9` | Why missed: the comment describes an expectation about vitest that was never re-checked after the child-process design removed the condition it described**

`dbClient.test.ts:22-26`:

> `⚠ These tests fail by killing the worker rather than by reporting, if the listener is removed - which is exactly the defect's real signature. An EventEmitter 'error' with no listener is an uncaught exception, so there is no gentler way to assert this that would still be about the real behaviour.`

Measured: with the listener removed, the worker was **not** killed. Vitest reported `Test Files 1 failed (1) / Tests 3 failed (3) / Errors 1 error` and each test failed on its own assertion, cleanly. The header comment is also directly contradicted by `poolSurvivalChild.ts:6-9` in the same commit, which says the opposite and is the one that is correct: *"vitest installs its own uncaughtException handling, so a pool error with no listener is reported beside the test instead of killing the worker"*.

No behaviour is wrong. It is P2 rather than cosmetic because the comment is a standing instruction to the next person about how to interpret a red run on this file, and it will send them looking for a killed worker that will not be there.

---

### F-4 · P2 · Two assertions in the new tests are weaker than they read

**Severity: P2 | Evidence: `dbClient.test.ts:129` and `:83-84` | Why missed: both were written as belt-and-braces beside assertions that do the real work, and neither was falsified individually**

- `:129` `expect(pool.ended).toBe(false);` **cannot fail.** `pg-pool` sets `ended` in `end()` and nowhere else, and nothing in that test calls `end()` before this line. It reads as "the pool survived in a usable state" and asserts only "nobody called `pool.end()`". The test's other three assertions are real and I falsified them; this line is decoration. (If the intent is what it reads as, the honest form is another `select 1` through the same pool - which is what `poolSurvivalChild.ts:41-44` correctly does in the child.)
- `:83-84` `expect(terminated.rows.length).toBeGreaterThan(0);` asserts that *something* idle was terminated, not that **the child's** backend was. The `where` clause is `datname = current_database() and state = 'idle'`, so any stray idle connection on `kept_test` - a developer's open `psql`, a dev server pointed at the test database, a leaked pool from a crashed earlier run - satisfies the guard. In practice the child cannot escape (it prints `READY` only after `select 1` returns, so its connection is idle and the same statement kills it too), and `fileParallelism: false` keeps the suite from supplying foreign connections. So this is a hardening note, not a vacuity: the test still cannot go green with the listener deleted, which I proved. Filtering on the child's own `pg_backend_pid` would make the guard say what it appears to say.

The same `where` clause has a side effect worth stating: **running `npm test` now terminates every idle backend on the test database, including connections owned by processes outside the suite.** Benign today, and only on `kept_test`, which `assertSeparateTestDatabase` already keeps distinct from the dev database.

---

### F-5 · informational · Closing PR-1 removes a crash that was, incidentally, the only signal a dead database produced

Not a defect and not a finding against the stage - recorded so it is not discovered later as a surprise. Before this commit, an idle-connection reap exited the process, which on Fly is a restart signal. After it, the machine stays up and logs. For the actual trigger (a transient close), that is strictly correct and I measured full recovery (§3.3). For a *persistent* database outage the delta is near zero, because the old code did not crash on that either - a failed checkout has always rejected through `pool.connect()` rather than through the pool's `'error'` event. So PR-8's "no health check" (`PROD-READINESS.md:225`) is not made materially worse by this fix, contrary to what the two findings' interaction might suggest on a quick read. Stating it because `PROD-READINESS.md:226` explicitly links PR-8 to PR-1, and that sentence now needs rereading.

---

## 5 · Per-test statement: would each test still pass if the behaviour it verifies were deleted?

Answered by experiment, not by reading. Falsification method: delete `pool.on("error", ...)` from `src/db/client.ts`, run `npx vitest run tests/integration/dbClient.test.ts`, restore with `git checkout --`, confirm `git status --porcelain` empty.

| Test | Verifies | Passes if the behaviour is deleted? |
|---|---|---|
| `dbClient.test.ts:47` "keeps a process alive when the server terminates its idle connection" | The process does not exit when an idle backend is terminated | **NO.** Fails: `expected 'READY\n' to contain 'SURVIVED'` - the child died exactly as the defect predicts. The assertion is a child process's stdout and exit code read from outside, which is the only honest witness to "the process did not die"; an in-process assertion would have been the vacuous version, and the child-process design is the right call. |
| `dbClient.test.ts:100` "logs the terminated connection without reproducing the database error's text" | (a) the listener logs at all; (b) it logs through `errorSummary` | **NO, twice over.** With the listener deleted: fails at `:120`, `expected undefined to be defined`. With the listener kept but `errorSummary` removed: fails at `:123`, `expected 'Idle database connection error: error…' to contain '57P01'`, and the received string also contains `terminating connection`, so `:127` would fail as well. Both directions falsified separately. |
| `dbClient.test.ts:134` "does not throw when the pool emits an error with no client attached" | The listener exists | **NO.** Fails: `expected [Function] to not throw an error but 'Error: synthetic' was thrown`. This is the tightest of the three - the listener's presence *is* the behaviour, and `emit` on a listener-less EventEmitter throws synchronously. |
| `dbClient.test.ts:129` `expect(pool.ended).toBe(false)` (one assertion inside test 2, not a test) | Nothing reachable | **YES - this single line cannot fail.** See F-4. It does not make its test vacuous; the three assertions above it in the same test all fail under falsification. |

No test in this stage is of the class this project has caught five times. The two that could have been - an in-process "the process survived" assertion, and a log assertion that only checks a string is present - were both written in the non-vacuous form, and the second one is the assertion REVIEW-0 §5 demanded before PR-2 is touched ("whatever fixes PR-2 must arrive with an assertion that would have failed before it"). This stage supplies that pattern for the pool's log line ahead of PR-2 itself.

---

## 6 · Verdict

**PASS-WITH-FINDINGS.**

The change is the fix the ledger specified, in the blast radius it declared, with nothing else smuggled alongside it. It removes the defect rather than relocating it in the process that matters: I reproduced BASELINE's PR-1 crash scenario against the real entrypoint started the real way and the process now survives, logs one redacted line, and answers the next authenticated request - then survives eight simultaneous terminations mid-traffic at a cost of zero failed requests. It swallows nothing: `pg-pool` emits `'error'` on the pool from exactly one place, for a client that is already idle and already evicted, so no error that had another delivery path is intercepted. The redaction is real and keeps the SQLSTATE, and the vitest dump proved the stakes - the error object carries the database password on `err.client`, and `errorSummary` does not print it. Three gates green, three times: typecheck clean, 266/266, no regression against BASELINE's 263.

All four findings are P2 and none of them is in the shipped code path. The one that should not close silently is F-1: `PROD-READINESS.md:336` still says PR-1 is OPEN at the commit that closed it, and this project has a written rule about exactly that failure mode. F-2 belongs in NEXT ROUND, not in this stage.
