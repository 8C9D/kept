# REVIEW-1 (round 2) - adversarial review of pass 4, the startup probe

verdict: **PASS-WITH-FINDINGS**

Range reviewed: `0126c2a..f62ff9a`, one commit, branch `prod-readiness/round-2`.
Stage contents: `server/src/db/client.ts` (+75), `server/src/index.ts` (+50/-2), `server/src/storage/s3ObjectStorage.ts` (+25), `server/tests/integration/startupProbe.test.ts` (+222, new).
No `ios/` file, no `web/` file, no `docs/` file, no ledger file is touched by this stage.

Posture: I assumed the stage was defective and went looking for how.
Every sentence in the stage's own comments was treated as an unverified claim, including the falsification block in the test file.
I re-ran the gates, mutated the behaviour in a scratch copy rather than reasoning about the tests, and drove the real entrypoint through the failure modes the stage claims to handle.
I edited no repository file; `git status --porcelain` was empty before this review and is empty after it, and the only file I add is this one.

Three of the six findings below are things I measured that the stage does not know about.
Two of them are in the object-storage half, which - measured, not argued - has no test at all.

---

## 1 · Gates, re-run

| Gate | Baseline requires | I measured | Verdict |
|---|---|---|---|
| `npm test` | 276 green, no regression | **282 passed / 31 files**, 0 failed, 0 skipped, exit 0, 22.4 s | no regression; 276 + the 6 this stage adds |
| `npm run typecheck` | clean | exit 0, no output | reproduces |
| `npm audit` | 6 moderate | **6 moderate**, same `esbuild`/`uuid` composition | reproduces |
| Real entrypoint, guardrail 7 | `GET /api/me` → 401 + `Cache-Control: no-store` | **401**, `cache-control: no-store`, correct JSON body, plus the PR-3 request line | reproduces |

Guardrail 7 verbatim, run the real way (`node --env-file=<copy> --import tsx src/index.ts`, port 3094):

```
ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only
Kept API listening on port 3094
{"msg":"request","method":"GET","route":"/api/me/*","status":401,"durationMs":3,"authenticated":false}

--- GET /api/me -> 401 Unauthorized
--- cache-control: no-store
--- body: {"error":{"code":"unauthorized","message":"A valid session token is required"}}
```

That run is worth one extra sentence: `.env.local` sets `STORAGE_*`, so this start went through the **new** `else` branch and `assertBucketReachable` passed against MinIO.
The changed storage path does execute at boot on this machine; what it does not have is a test (F3).

Every server I started used a copy of `server/.env.local` with the `ANTHROPIC_API_KEY` line removed, and none of the copies contains that string (`grep -l ANTHROPIC` over all of them returns nothing).
Port 3000 was read once with `lsof` and left alone - pid 31468, still the same process, untouched.
All ports I used (3091-3095, 3101-3105, 9099) are free again.

---

## 2 · The mandated checks, each answered

**Fabricated or unreproducible findings.**
**Checked, one finding: F4.**
The stage's central falsification claim is reproducible to the letter.
Its comment predicts that deleting the probe fails the first entrypoint test not on `expect(exitCode).not.toBe(0)` but one assertion later on `not.toContain("Kept API listening")`.
I predicted the same before running, deleted the probe from a scratch copy, and got exactly that - `AssertionError: expected 'Object storage: local MinIO default a…' not to contain 'Kept API listening'`, at `startupProbe.test.ts:137`.
The two mutations it names for the unit tests also reproduce exactly (§3).
What is not reproducible is the *count*: it says "the three `assertDatabaseReachable` cases", and there are four (F4).

**Citations that do not say what they are claimed to say.**
**Checked, one finding: F4**, covering three claims in the new comments.
Everything else the stage cites is exact.
`db/client.ts:57-59` says the pool is built with `connectionString` alone so `connectionTimeoutMillis` is 0 - true, `src/db/client.ts:11` passes only that, and round 2's own R0-1 measurement stands.
`s3ObjectStorage.ts:178-180` says a `head` on the `ObjectStorage` interface is the open ruling - true, RULING 1, and the function is correctly a module-level sibling of `createBucketIfMissing` rather than an interface method, which is the shape REVIEW-0 required.
The test file's reference to `tests/helpers/poolSurvivalChild.ts` is real, and the reasoning it borrows from it is sound.

**Severity inflation or deflation.**
**Checked, clean.**
The stage assigns no severities; it is a fix, and the ledger it implements is outside this range.

**Smuggled features.**
**Checked, clean.**
No endpoint, screen, command, flag, table, column, dependency, or config key.
`git diff 0126c2a..f62ff9a | grep -E "process\.env"` returns only pre-existing reads plus the test harness's own child environment.
`assertBucketReachable` is a new exported function, which is not a feature - it is read-only, it creates nothing, and no user-visible behaviour changes except that a misconfigured process refuses to start.

**Prohibited actions.**
**Checked, clean.**
`git reflog` shows one ordinary commit on top of `0126c2a`; no rebase, reset, amend, force, or tag operation.
`git remote -v` is empty, so nothing was pushed.
`main` is still `ca82907` and neither branch is merged.
Nothing rotates or deletes a credential, and the stage deletes no file.

**iOS files touched.**
**Checked, clean.**
Zero, in the diff and in my own reading.
`git diff --stat 0126c2a..f62ff9a -- ios web docs` returns nothing.

**An Anthropic API call.**
**Checked, clean, and the stage is better than neutral here.**
The diff adds no code that could reach the API.
`runEntrypoint` explicitly destructures `ANTHROPIC_API_KEY` out of the child's environment before spawning the real entrypoint, and comments why - so `npm test` cannot bill the card even on a machine where the key is exported.
That is the correct instinct and I want it recorded as a credit, not passed over.
I ran no `parse-llm-*` script, and every process I started printed `ANTHROPIC_API_KEY is not set` or exited before that line.

**Fixes that relocated a bug rather than removed it.**
**Checked, one finding: F1.**
The database half genuinely removes the defect: the wrong-credential process that used to listen now refuses, measured below.
The storage half relocates one.
Before this stage, an unreachable `STORAGE_*` produced a listening server whose failure surfaced at the first image upload, with a diagnosable error.
After it, one specific unreachable shape - a host that accepts the TCP connection and never answers - produces a process that emits **zero bytes**, never binds the port, and never exits.
That is a move from diagnosable to undiagnosable, and it is F1.

**Error handling that hides errors.**
**Checked, clean.**
Neither new catch swallows anything.
The database catch prints a named message plus `errorSummary(error)` and exits non-zero; the storage catch rethrows with `{ cause }`.
I checked the redaction claim in the database catch's own comment by running the real entrypoint against a bad `DATABASE_URL` and reading what came out: the cause chain is preserved through `errorSummary`, and the `pg` error printed its message and frames without any row values.
I also checked the thrown storage error, which the comment implies is the riskier shape: node's default handler dumps it, and what it dumps is `$fault`, `$metadata`, an httpStatusCode and request ids - **no access key id, no secret**.
So the asymmetry the comment worries about is real in principle and harmless in this case.

**Verification that does not exercise the changed path.**
**Checked, one finding: F3.**
The database probe is exercised from outside the vitest worker, correctly.
The object-storage probe is exercised by nothing: I deleted its body in a scratch copy and the full suite stayed at **282 passed / 282**.

**Anything marked resolved without an artifact.**
**Checked, clean - trivially.**
This stage marks nothing resolved.
`PROD-READINESS-ROUND-2.md` is untouched by it and its §7 table still reads `R2-1 | P1 | pending Review 0`, so no resolution claim exists yet to be unsupported.
Flagged only so the next stage knows the ledger has not yet been brought forward (see F5).

---

## 3 · Tests: would they still pass if the behaviour they verify were deleted?

Six new tests.
I built a complete copy of `src`, `tests`, `drizzle`, `vitest.config.ts`, `tsconfig.json` and `drizzle.config.ts` in my scratchpad with `node_modules` symlinked, and mutated **the copy**.
No repository file was edited at any point.
Every mutation below was predicted in writing first, then run.

| # | Mutation applied to the scratch copy | Predicted | Actual | Can the tests fail? |
|---|---|---|---|---|
| M1 | The whole probe block deleted from `src/index.ts:106-124` | entrypoint test 1 fails, on the listening-line assertion rather than the exit code | **1 failed / 6**, `expected 'Object storage: local MinIO default a…' not to contain 'Kept API listening'` at `:137` | **YES** |
| M2 | `assertBucketReachable` body replaced with `return;` | I expected **nothing** to fail | **282 passed / 282**, full suite | **NO test covers it at all** - F3 |
| M3 | `attempts` forced to 1 | the retry test fails | **3 failed / 6**: retry test `promise rejected "…after 1 attempts" instead of resolving`, plus both tests that pin the "after 2 attempts" wording | **YES** |
| M4 | `withTimeout(pool.query(…))` replaced by a bare `pool.query(…)` | the never-settles test fails by timing out | **1 failed / 6**, `Error: Test timed out in 5000ms` | **YES** |
| M5 | the probe inverted so it never accepts | tests 1, 3 and entrypoint test 2 fail | **3 failed / 6**, exactly those | **YES** |

**Five of the six new tests are falsifiable, and I falsified each one by deleting or inverting the behaviour it claims to pin.**
There is no seventh unfailable assertion here.
The child-process design is what earns that: M1's failure could not have been observed from inside a vitest worker, and the stage understood this and said so.

The sixth test - `"rejects a wrong credential rather than waiting forever"` (`:40`) - is non-vacuous but weak on its own.
It passes under M5 (a probe that always rejects satisfies it), so its only discriminating power comes from being read together with `"resolves against a database that answers"` (`:34`), which M5 does fail.
That is an acceptable pairing and I am not raising it as a finding; I record it because the stage's comment claims a falsification for it that the stage did not perform (F4).

One robustness note on the two entrypoint tests, short of a finding.
They inherit the ambient environment and override only `DATABASE_URL`, `PORT`, `SESSION_JWT_SECRET` and `APPLE_CLIENT_ID`, so which storage branch the child takes depends on the developer's shell.
On this machine `STORAGE_*` is unset in the shell, which is how M2 could delete the storage probe with the suite green - the child logs `Object storage: local MinIO default at http://localhost:9000`, proving `resolveStorageConfig` returned `null` and the new branch was never entered.
On a machine where `STORAGE_*` is exported, `npm test` would start making network calls to whatever it names.
It also means the failure test's `expect(result.output).toMatch(/did not answer/)` is not database-specific - the storage refusal message at `index.ts:89` contains "did not answer" too - and only the neighbouring `toContain("DATABASE_URL")` keeps that test honest.

---

## 4 · Can the probe make things worse? The question this review was told to press

Judged in four parts.

**The retry budget is defensible.**
Five attempts, 1 s apart, 5 s each: a worst case of 29 s before the process gives up, and a fast path of one round trip when the database answers.
Against Neon's autosuspend that is the right shape - a waking compute is waited for rather than crashed on, and I confirmed by mutation (M3) that the retry is real rather than decorative.
A wrong credential does not consume the budget: the SASL failure returns immediately and the whole refusal took under 5 s in every one of five runs.

**It does not crash-loop a deployment that would otherwise have served.**
A running process is unaffected - the probe is startup-only.
The window where behaviour changes is a restart or a deploy during a database outage, and in that window the old build would have served 500s to every authenticated request anyway.
Exiting is better than that: Fly restarts the machine, the port is never bound, and the TCP check keeps traffic away.
The ledger's ASSUMPTION 6 carries this correctly.

**The output survives the exit.**
`console.error` immediately followed by `process.exit(1)` can truncate on a pipe, which is what Fly's log capture is.
I ran the refusal path five times through a pipe and got 11 lines every time, with both `console.error` calls intact.
**Checked, clean** - but it is luck of the platform rather than design, and the safer shape is `process.exitCode = 1` plus a natural exit.

**One shape does make things worse, and it is F1.**
The storage probe carries no timeout of any kind.

**The database probe's own docstring names this exact hazard** (`db/client.ts:57-59`: "a connect against a black-holed host would otherwise hang here forever") and guards against it.
The storage probe, added in the same commit, one file over, does not - and it runs **first**, so when it hangs the database probe never runs either.

Measured against the real production entrypoint, with `STORAGE_ENDPOINT` pointed at a local socket that accepts the TCP connection and never answers:

```
[sink] accepted at +1065ms
[watch] +20s  alive=true bytesEmitted=0
[watch] +40s  alive=true bytesEmitted=0
[watch] +60s  alive=true bytesEmitted=0
[watch] +80s  alive=true bytesEmitted=0
[verdict] after 100s: still alive=true, total bytes on stdout+stderr=0
```

Zero bytes.
The `else` branch has no `console.log` of its own - only the local-MinIO branch does - so the process says nothing at all, binds nothing, and exits never.
Isolated from the entrypoint, `assertBucketReachable` against the same sink was still pending at 120 s when I stopped it.

---

## 5 · Findings

### F1 · P1 · The object-storage probe has no timeout, so a black-holed endpoint hangs the boot forever in total silence - and its own justification for having no retry depends on an exit that never comes

`server/src/storage/s3ObjectStorage.ts:182-187`: one `client.send(new HeadBucketCommand(...))`, no `requestTimeout`, no `connectionTimeout`, no wrapper.
Reached from `server/src/index.ts:86`, inside the branch that runs in **every** production boot - `assertProductionEnv` refuses a production start with no `STORAGE_*`, so `configuredStorage` is never `null` there.

Measured, twice, on the real entrypoint and on the function alone: 100 s and 120 s respectively with no settlement, no output, no exit, no listener (§4).

The docstring at `s3ObjectStorage.ts:173-176` argues the design:

> One attempt, unlike the database probe's five: R2 does not autosuspend, so there is no cold start to wait out, and Fly restarts a machine whose process exits - which makes a transient blip a retry at the platform's layer rather than a loop in ours.

The load-bearing clause is "Fly restarts a machine whose process **exits**".
In the hang case the process does not exit, so the platform-layer retry the design delegates to never fires.
The failure lands in the one place the whole round exists to eliminate: a machine that is neither serving nor saying why.
`docs/Runbook.md:249` tells the operator that `fly logs` will show "a startup refusal [that] names exactly which environment variable is missing or wrong" - here `fly logs` shows nothing at all.

**P1, not P0, and the reasoning.**
No receipt is lost, no isolation boundary moves, and the machine never serves a wrong answer - with no port bound, Fly's TCP fallback check (PR-8, ASSUMPTION 4) keeps traffic away.
The band it lands in is "undiagnosable in production", which is P1.
It is worse than the state before this stage, which is why it is a finding rather than a limitation: that configuration used to produce a listening server whose first image upload failed with a named error.

*Fix.* The `withTimeout` helper already written for the database probe is the answer, or the SDK's own `requestHandler: new NodeHttpHandler({ connectionTimeout, requestTimeout })`.
Either way the branch should also say something before it blocks, as the MinIO branch at `index.ts:66-68` does.

### F2 · P1 · The refusal message this stage adds prints the `DATABASE_URL` password when the URL has no scheme - from the line whose own comment says it does not

`server/src/index.ts:105-121`:

```
// Named without the URL, deliberately: DATABASE_URL carries the password.
const database = databaseIdentity(databaseUrl, "DATABASE_URL");
...
  console.error(
    `Database at ${database.host}:${database.port}/${database.database} did not ` +
```

`databaseIdentity` (`src/db/databaseUrl.ts:20-33`) takes `database` from `parsed.pathname`.
For a `DATABASE_URL` that lost its `postgres://` prefix, `new URL()` succeeds with a garbage decomposition and the userinfo lands in the pathname.

Reproduced end to end on the real entrypoint, with a fabricated password so nothing real is exposed:

```
$ PORT=3092 node --env-file=<env with DATABASE_URL=kept:s3cr3t-PASSWORD@localhost:5432/kept_test> \
    --import tsx src/index.ts
Database at :5432/s3cr3t-PASSWORD@localhost:5432/kept_test did not answer, so this process is
refusing to serve. Check DATABASE_URL and that the database is running and reachable from here.
```

The production gate does not stop it, verified by calling `assertProductionEnv` directly with a production-shaped environment carrying that URL: it returns cleanly, because `productionEnv.ts:59-65` reads `database.host` (`""`, which is not `"localhost"`) and never renders any component.
**This stage adds the first code path anywhere that renders a `databaseIdentity` field into a log line**, and Fly's log stream is where that line goes.

A second, narrower half.
`index.ts:106` sits **outside** the try, and `databaseUrl.ts:25` throws `` `${label} is not a parseable URL: ${url}` `` - the whole URL in the message.
Node's default handler then prints it twice, once in the message and once as `input:` on the `ERR_INVALID_URL` cause:

```
Error: DATABASE_URL is not a parseable URL: postgres://kept:s3cr3t-PASSWORD@/kept_test
  [cause]: TypeError: Invalid URL { code: 'ERR_INVALID_URL',
    input: 'postgres://kept:s3cr3t-PASSWORD@/kept_test' }
```

In production this half is **pre-existing**, not this stage's: `productionEnv.ts:59` already calls `databaseIdentity` earlier and throws first.
In development - `npm run dev` - `assertProductionEnv` returns at its first line, so `index.ts:106` is a new site for it.

**P1, not P0, and the reasoning.**
A database password in a retained log stream is squarely the "security exposure" wording of the P0 band, and I considered it.
It does not get there because the trigger is a malformed `DATABASE_URL` rather than the normal path, the process refuses to serve rather than continuing wrongly, no receipt data is involved, and the rubric says to take the lower of an ambiguous pair.
It does not deflate to P2 because the trigger - a mistyped secret at `fly secrets set` - is the *precise* scenario R2-1 was written about, so the fix's own motivating case is the case that leaks.

*Fix.* Render only `host` and `port`, or refuse a `DATABASE_URL` whose parsed `protocol` is not `postgres:`/`postgresql:` before anything else runs, and give `databaseIdentity` a message that names the label without the value.

### F3 · P2 · Half of what the commit message promises has no test: `assertBucketReachable` can be deleted outright and the suite stays at 282/282

The commit is titled "Refuse to serve until the database **and object storage** answer".
M2 (§3) replaced the body of `assertBucketReachable` with `return;` and the full suite passed 282/282.
Nothing in `tests/` reaches the `else` branch of `index.ts:79-95` either: the two entrypoint tests run with no `STORAGE_*` in the child environment, and their own output shows the child taking the local-MinIO branch instead.

The ledger's §7 states the rule this misses - pass 7 is "folded into the pass, so the fix ships with the assertion that fails without it" - and REVIEW-0 §3 set it as the standing bar.
It holds for the database half and not for the storage half.

The omission was cheap to avoid: `tests/integration/objectStorage.test.ts` already imports from `src/storage/s3ObjectStorage.js` and already runs against the real MinIO container, including a `createBucketIfMissing` call in `beforeAll`.
Two cases - resolves against the real bucket, rejects against a wrong secret - would have been a handful of lines in a file that already exists, and the wrong-secret case does work: I ran the real entrypoint with a bad `STORAGE_SECRET_ACCESS_KEY` and got the intended refusal, exit 1, with an actionable message and no credential in the dump.

**P2, not P1, and the reasoning.**
A missing test is not itself a runtime defect, and the runtime consequence it allowed through is F1, already graded P1 - grading both at P1 would double-count one failure.
It is not P3 because this is the project's own stated bar for a fix pass, and because the untested half is the half that shipped a defect.

### F4 · P2 · Three factual claims in the new comments do not match the code they describe

Small individually; together they are the pattern this project keeps naming, which is a sentence carried rather than measured.

**(a)** `tests/integration/startupProbe.test.ts:122`: "The three `assertDatabaseReachable` cases above were falsified the same way".
There are **four** `it(...)` blocks in that describe - `:34`, `:40`, `:50`, `:72` - and the comment then names two mutations, covering two of them.
`:34` and `:40` have no recorded falsification.
I supplied one for `:34` (M5, it fails) and found `:40` weak on its own (§3).

**(b)** `src/storage/s3ObjectStorage.ts:173`: "One attempt, unlike the database probe's five".
The AWS SDK's default retry strategy retries beneath that call.
Measured against a refused connection: `rejected at +128ms name=Error attempts=3 totalRetryDelay=106`.
Three attempts, not one.
Harmless at 128 ms, and it matters only because the sentence is the design's stated justification.

**(c)** `src/db/client.ts:61-64`: "startup either proceeds (in which case **one** stray checkout is reclaimed by pg's 10 s idle reaper) or throws and takes the process with it".
With `attempts = 5`, up to **four** attempts can time out before one succeeds, so up to four stray checkouts, not one.
The reaper claim also only holds for a checkout that eventually settles and returns to the pool; one that never settles is not idle and is never reaped, permanently costing a slot of the pool's `max` of 10.
Inert at three users - the pool would fall from 10 to 6 - which is why this is a wording defect rather than a resource finding.

**P2.** No runtime consequence follows from any of the three.
They are graded at all because in this repository a comment that states a measurement is an artifact, and (b) and (c) are exactly the "verify, never infer" rule applied to the reviewer's own side of the ledger.

### F5 · P2 · The stage adds two startup-refusal conditions and updates none of the operator documentation that enumerates them, though the Runbook is explicitly in scope

`docs/Runbook.md:32`: "A missing one stops the process at startup with the name in the message".
`:49`: the production refusal list - storage unconfigured, non-https endpoint, loopback database, short secret, missing Anthropic key.
`:79`: "check `fly logs` for a startup refusal, which names what is missing".
`:249`: "a startup refusal names exactly which environment variable is missing or wrong".

After this stage there are two refusals that are not about an environment variable being missing or wrong, but about a service not answering, and an operator reading §7 step 2 is told to look for something else.
Deploy configuration and the Runbook are named in scope for this run, so this is inside it.

One fact in the stage's favour that nobody recorded, and should be.
`docs/Runbook.md:255` already read "the app cannot start without a reachable database".
That sentence was **false** before this commit - it is the exact claim R2-1 disproved - and this commit is what makes it true.
Neither the ledger nor REVIEW-0 noticed the Runbook was asserting it, and the fix closing a false operator-facing sentence is worth more in the log than the doc edit it still needs.

No `docs/DECISIONS.md` entry and no spec amendment are yet due - the run's own plan puts those in the final stage - but `PROD-READINESS-ROUND-2.md` §7 still reads `R2-1 | P1 | pending Review 0` and its Passes table still says pass 4 "Runs" without saying what it did.

**P2.** Documentation drift against a system whose behaviour changed; nothing fails because of it.

### F6 · P2 · The storage probe adds a hard dependency on an R2 permission nothing in this repository has ever exercised, and it is recorded as no assumption

`assertBucketReachable` requires `HeadBucket` to succeed on the deployed bucket before the process will serve.
`docs/gates/wave-6.md:118` provisions the credential as "an R2 API token **scoped to that bucket** with read and write".
Whether a token of that scope permits `HeadBucket` cannot be determined here - there are no R2 credentials on this machine and connecting to Cloudflare is prohibited - and nothing in the repository has ever issued that call against R2.
`npm run storage:probe-keys` (`wave-6.md:135`, step 12) exercises `GetObject` and `PutObject`, not `HeadBucket`.

If the assumption is wrong, the failure is severe and badly shaped: `assertBucketReachable` propagates any error, so a `403 AccessDenied` on a bucket that is present and writable is indistinguishable from a wrong credential, and the message at `index.ts:89-91` tells the operator to check four `STORAGE_*` values that are all correct.
A deployment that would have served then cannot boot at all.

The bucket's *existence* at first deploy is fine, which I did check: `wave-6.md:117` creates the bucket at step 2 and `:136` deploys at step 9, so the ordering does not brick the documented first deploy.

**P2, and the P0 argument stated rather than hidden.**
If a bucket-scoped R2 token does not permit `HeadBucket`, this is "cannot deploy", which is P0.
It is graded P2 because what I can demonstrate is an unrecorded assumption, not a failure - and the ledger has eight ASSUMPTIONS, none of which is this one, in a round whose own discipline is that an undeterminable fact gets written down and resolved conservatively.

*Fix.* Either record it as ASSUMPTION 9 and have the owner confirm it against the real token before the storage probe is trusted, or make the probe fail open on `403` and closed on everything else, or probe with an operation the application actually performs.

---

## 6 · What the stage got right, stated so the findings are read in proportion

The database half of R2-1 is genuinely closed, and closed in the shape REVIEW-0 demanded.

Reproduced by me: a wrong `DATABASE_URL` password no longer produces a process that prints "Kept API listening", holds the port, and answers 401 to the Runbook's own deploy check.
It now prints a named refusal and exits 1, in under 5 s, five runs out of five, with the cause chain preserved through `errorSummary` and no row values in it.

The falsification method is the right one and was performed rather than described - the entrypoint is spawned as a child so the assertion is an exit code and an output stream read from outside, which is the only honest way to test "the process refuses to serve", and it is the lesson of `poolSurvivalChild.ts` applied correctly by a builder who has been caught by this before.
The recorded predicted-versus-actual gap in the test file is real, reproducible, and more useful than a clean prediction would have been.

The probe carries its own timeout instead of leaning on the pool's, which is what PR-9 required; the retry exists and is falsifiable; the storage probe is read-only and is deliberately not a method on `ObjectStorage`, which honours RULING 1; and `ANTHROPIC_API_KEY` is stripped from the test's child environment on purpose.

---

## 7 · Routing

| id | severity | routes to |
|---|---|---|
| F1 | P1 | fix pass - give `assertBucketReachable` a bounded timeout and a line of output before it blocks |
| F2 | P1 | fix pass - stop rendering `database.database`, and gate on the URL's protocol before parsing |
| F3 | P2 | fix pass, alongside F1 - two cases in the existing `tests/integration/objectStorage.test.ts` |
| F4 | P2 | correct the three comments; supply the missing falsification for `:34` and `:40` or drop the claim |
| F5 | P2 | Runbook §0 and §7, and the ledger's §7 status table when the pass is recorded |
| F6 | P2 | ledger ASSUMPTIONS, and a RULINGS line if the owner wants the probe softened |

F1 and F2 are in the same file the pass already owns and neither needs a new module, a new key, or a new endpoint, so both are inside the scope constraint on the same footing as the code they correct.

---

## 8 · Verdict

The baseline does not regress: 282 tests green against a required 276, `tsc --noEmit` clean, `npm audit` unchanged at 6 moderate, and the real entrypoint started the real way answers `GET /api/me` with 401 and `Cache-Control: no-store`.
Five of six new tests fail when the behaviour under them is deleted, and I deleted it rather than reasoning about it.
There is no fabrication, no smuggled feature, no prohibited action, no iOS file, no Anthropic call, and nothing marked resolved without an artifact.

It is not a PASS because the half of the fix that ships with no test is also the half that shipped a defect, and because the line added to keep a password out of the log can print one.
Both of those I measured on the real entrypoint rather than inferred.

**PASS-WITH-FINDINGS**
