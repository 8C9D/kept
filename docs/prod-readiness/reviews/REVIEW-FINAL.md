# REVIEW-FINAL - adversarial review of the complete run

verdict: PASS-WITH-FINDINGS

Range reviewed: `ca82907..fdf7ae0` (15 commits, 18 files, 2401 insertions, 14 deletions).
Reviewed at `HEAD = fdf7ae0b19bcc2f04c99924723acfb6a33ae028f`, branch `prod-readiness/2026-08-10`.
Working tree clean before this review and clean after it, apart from this file (`git status --porcelain` empty at every checkpoint; every falsification edit was reverted with `git checkout --` and the tree re-checked).
Everything below I re-ran myself, measured against `reviews/BASELINE.md`. No builder narration was available and none was used. I read the five prior review verdicts as claims, not as evidence, and re-executed the falsifications they report.

---

## 1 · Gates, against BASELINE

| Gate | BASELINE | At `HEAD` | Verdict |
|---|---|---|---|
| `npm run typecheck` (the build gate and the linter both) | exit 0, no output | exit 0, no output | clean |
| `npm test` | 28 files / 263 passed | **30 files / 276 passed, 0 failed, 0 skipped** (run twice: 19.12s, 28.18s) | +2 files / +13 tests, fully accounted: 3 `dbClient` + 9 `logHygiene` + 1 `export`; `objectStorage.test.ts` strengthened in place |
| `npm audit` | 6 moderate | 6 moderate | unchanged |
| Production entrypoint (guardrail 7) | 401 + `no-store` on `/api/me` | identical, on port 3011 | reproduced, plus the four exercises in §3 |
| `docker images` | `kept-api:prod-readiness`, 714 MB | same image present | the ledger's §0 build claim is backed by an artifact |

Port 3000 (pid 31468, the two-day-old process BASELINE records) was confirmed alive at the end and never touched.

---

## 2 · The seven additional checks, each answered

### 2.1 Defects introduced across pass boundaries that no single-pass review could see

Four, all recorded as findings below: **X-1** (the remedy the export message prescribes was inverted from non-destructive-first to destructive-first by successive single-finding remediations, against the ledger's own DEFERRED reasoning), **X-2** (the `route` field collapses the production 403 and the 413 into `unmatched`, which the ledger's disclosed caveat does not cover), **X-3** (the run's deliverable is a binary file to `grep`), **X-4** (three accepted review findings are neither fixed nor carried to NEXT ROUND).

### 2.2 Stage 0 assumptions that later evidence in this run contradicted

Three, and the ledger repaired two of them in place:

- **PR-1's blast radius** originally read "every caller of `createDb` (server, tests, dev scripts, restore verifier)". REVIEW-1 F-2 showed five scripts build their own `Pool`. The ledger now carries a ⚠ correction at `PROD-READINESS.md:125` and N-1 at `:424`. **Repaired.**
- **PR-3's console-site enumeration** named five sites while calling them four and omitted six. Replaced by the table at `PROD-READINESS.md:186-193` with the strike disclosed at `:194`. **Repaired.**
- **R-1's blast radius** at `PROD-READINESS.md:237` still reads "The error path of one loop in `generateExport.ts`. No schema, no route, no response shape, **no new interface method**." The final shape of the fix also added a module-private `isMissingObject` (`generateExport.ts:246-252`) that hardcodes S3/R2 error-name strings into a module which otherwise depends only on the `ObjectStorage` interface. The literal claim ("no new interface method") stays true; the blast-radius sentence is now narrower than the change. **Not repaired** - part of X-4.

ASSUMPTION 2 ("no code path that calls Anthropic has been executed") and ASSUMPTION 8 ("Fly restarts a machine whose process exits", load-bearing for PR-1 being P1) are both still correctly quarantined and neither was contradicted.

### 2.3 Work that expanded past the frozen work list

**No scope violation in code.** The frozen list is `PR-1, PR-2, PR-3, R-1` (`PROD-READINESS.md:390`). Every code hunk in the range traces to one of them or to a reviewer's finding against one of their fixes:

| Commit | Files touched | Traces to |
|---|---|---|
| `c1104b9` | `db/client.ts` + 2 test files | PR-1 |
| `6006d85` | tests + ledger only | REVIEW-1 F-1/F-3/F-4 |
| `acb5309` | `app.ts`, `observability/requestLog.ts`, `parse/llmParseSweep.ts`, 1 test file | PR-2, PR-3 |
| `9673ce5` | `requestLog.ts` (+ ledger, tests) | REVIEW-2 F-1, F-2, F-6 |
| `486923f` / `34da846` / `bd22e72` | `export/generateExport.ts` + export/objectStorage/fake tests | R-1, then REVIEW-3 F-1/F-2/F-3, then REVIEW-3b F-1/F-2/F-3/F-4/F-5/F-6 |

No new endpoint, screen, command, flag, table, column or config key. `git diff --name-only ca82907..fdf7ae0 -- '*package*.json'` returns 0 files - no dependency added, upgraded or installed. The single new source file (`src/observability/requestLog.ts`) sits in an existing directory beside `errorSummary.ts` and `portInUse.ts` and is a genuine module boundary.

**The one borderline call:** `bd22e72` acted on REVIEW-3b's F-5 and F-6, which are P3 *wording* findings raised after the freeze, while filing the schema behaviour underneath F-5 as N-3 for the next round. Fixing a reviewer's finding against this run's own new string is defensible under "behaviour-preserving changes that close a specific finding". I do not call it a violation. I do call the result a finding - it is where X-1 came from.

### 2.4 Prohibited actions anywhere in the history

**None found.**

```
$ git remote -v            -> (empty; no push was possible)
$ git tag                  -> (empty)
$ git rev-parse main       -> ca829075c15f2d0588a145126fa033147b118621   (unmoved)
$ git merge-base --is-ancestor ca82907 HEAD  -> 0
$ git diff --name-status ca82907..fdf7ae0 | grep -c '^D'  -> 0
$ git reflog               -> 15 linear commits on the branch, no rebase/reset/amend
```

The two `reset: moving to HEAD` reflog entries are dated 2026-08-08 and predate the run. No credential was rotated, revoked or deleted; no file the run did not create was deleted; no `rm -rf`. No `.only`, `.skip` or `todo(` was added anywhere in the diff. My own work touched only local Postgres (`kept-db`, database `kept_test`) and local MinIO (`kept-minio`); nothing reached Neon, Fly, R2 or Cloudflare.

### 2.5 iOS files touched at any point

**None, at any commit.** `git diff --name-only ca82907..fdf7ae0 -- ios/` returns 0 files. `ios/` is not read, cited as evidence, or reasoned about anywhere in the shipped code. The two places the run wanted an answer from `ios/` - PR-6's 409 classification and PR-7's per-request token pinning - are both refused and filed under DEFERRED with the consequence stated as unknown rather than guessed. That is the correct handling of the constraint.

### 2.6 Any Anthropic API call

**No positive evidence, and corroborating evidence against. I cannot prove a negative and do not claim to.**

- No `+` line in the whole server diff imports `@anthropic-ai/sdk`, constructs a client, or touches `src/parse/claudeReceiptParser.ts`, `src/db/llmBackfill.ts`, `llmParseProbe.ts` or `llmPromptReparse.ts`.
- `logHygiene.test.ts` drives the real `createLlmParseSweep` with an **injected** `parse` function (`:71-95`) and never constructs an SDK client; the sweep's model-calling path is not reached.
- `src/index.ts:104` gates the startup sweep on the key being present.
- Every server start I performed used a scratchpad env file with `ANTHROPIC_API_KEY` stripped (`grep -c ANTHROPIC` → 0) and the process said so at boot: `ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only`. The copies were deleted afterwards. I ran none of `parse-llm-backfill`, `parse-llm-probe`, `parse-llm-reparse`.
- ⚠ Worth stating: the repository's real `server/.env.local` **does** carry an `ANTHROPIC_API_KEY`, so "start the server the normal way" and "make no API call" are mutually exclusive on this machine. ASSUMPTION 2 is therefore not a formality, and every guardrail-7 run in this run and in every review is a deliberate deviation. That is disclosed at `PROD-READINESS.md:309` and at `BASELINE.md:96-99`.

### 2.7 Whether every finding marked RESOLVED has an artifact that supports it

Four are marked RESOLVED. I reproduced all four independently, three of them against the real entrypoint started the real way. **All four artifacts hold.**

- **PR-1** - real entrypoint on 3011 against `kept_test`, authenticated `GET /api/me` → 200, `pg_terminate_backend` on the idle backend → `t`, `ps -p 82951` → alive, `lsof -ti tcp:3011` → 82951, next authenticated request → 200, and the log line **character-for-character what the ledger quotes**: `Idle database connection error: DatabaseError [message and detail withheld] code=57P01 routine=ProcessInterrupts`. `grep -c` for `terminating connection`, `password` and `connectionParameters` in the server log: 0, 0, 0.
- **PR-2** - both changed lines falsified (§4, F3 and F4). The drain-catch line at `llmParseSweep.ts:246`, which REVIEW-2 F-2 showed was covered by nothing, is now covered: reverting it fails `redacts a failure that stops the whole sweep` on `not to contain 'Dr Smith Psychiatry Clinic'`. F-2 is genuinely closed.
- **PR-3** - real entrypoint, four lines produced, none carrying the client path, the query string, the bearer token or a user id (`grep -c` for `SECRETVENDOR`, `Psychiatry`, `q=`, the receipt uuid: 0/0/0/0). All six request-log tests falsified.
- **R-1** - **I reproduced the authenticated real-entrypoint replay that REVIEW-3 and REVIEW-3b both said they could not.** Against the real entrypoint with real MinIO behind it: create naming a never-uploaded key → 201, then `GET /api/export/<job>` →

  ```
  status: failed
  error:  Receipt 51bd4f0a-04c5-4dfb-9acf-098efaa2ac2e has no image in storage, so this
          export cannot be completed - its photo never finished uploading. Delete that
          receipt, then capture it again if you still have the paper. Deleting alone will
          let the export run, without that receipt in it.
  ```

  Identical to the template at `generateExport.ts:191-199` and to the ledger's quoted string. `grep -c` in the server log for the user id, `2026-03-15`, `Test Vendor` and `.jpg`: 0/0/0/0. The block at `PROD-READINESS.md:241-251` is still a hand-wrapped rendering rather than verbatim output (REVIEW-3b F-7, unrepaired - see X-4), but the claim it renders is true and I verified it.

---

## 3 · What I re-ran beyond the reviews, and what it produced

Predictions were written before each run.

**3.1 The 403 path, which no test and no prior review exercised.** The edge-secret middleware (`app.ts:96-113`) is registered only when `EDGE_SHARED_SECRET` is set, which is never in tests and always in production (wave-6 §3 step 8). **Predicted:** the 403 is logged, since `requestLog` is outermost. **Observed:** it is - and with `route: "unmatched"`.

```
$ curl http://localhost:3011/api/me                                    -> 403
$ curl -H "x-kept-edge-secret: <value>" http://localhost:3011/api/me   -> 401

{"msg":"request","method":"GET","route":"unmatched","status":403,"durationMs":3,"authenticated":false}
{"msg":"request","method":"GET","route":"/api/me/*","status":401,"durationMs":2,"authenticated":false}
```

The shared secret does not appear in the log (`grep -c` → 0). See X-2.

**3.2 The 413 path against the real entrypoint.** A 2 MB body to `POST /api/receipts` → 413, logged as `{"route":"unmatched","status":413}`. The route exists; the log says `unmatched`. Also X-2.

**3.3 The storage-outage discrimination, against a real S3 client and a real network failure - not a stub.** This is the case REVIEW-3's F-2 raised and REVIEW-3b probed only in isolation. My first replay used the repository's own `STORAGE_ENDPOINT` (`http://dev-mac.local:9000`), whose mDNS name resolves to a link-local IPv6 address that Node cannot reach; the SDK timed out after ~225 s. The export job then reported:

```
"status": "failed",
"error":  "connect ETIMEDOUT fe80::9826:39ff:fe19:d99c:9000"
```

A genuine storage failure, through the real client, reported **as itself** and not as "its photo never finished uploading" - with no advice to delete anything. `isMissingObject`'s discrimination is correct against reality, not only against the fake.

(The mDNS endpoint is a pre-existing property of `server/.env.local`, not of this run, and not a finding against the builder. It is worth one line for the next operator: `resolveStorageConfig` with that hostname makes every image download a 225-second timeout, and BASELINE's guardrail-7 probe - an unauthenticated 401 - never touches storage, so no run in this history would have noticed.)

**3.4 Hono's error routing, read from source rather than inferred.** `node_modules/hono/dist/compose.js` catches a thrown `Error` at the dispatch level where it surfaces and calls `onError` there, then assigns `context.res`, so `requestLog`'s `finally` at the outermost level sees `finalized === true` and a real 500. A thrown non-`Error` is re-thrown (`else throw err`) and reaches the outermost level with `finalized === false`. The `answered ? c.res.status : null` guard at `requestLog.ts:56` is aimed at exactly the reachable case and nothing else.

---

## 4 · Per-test statement for every test added or changed across the whole run

Answered by experiment. Method: edit, `npx vitest run <file>`, `git checkout --`, `git status --porcelain` empty. Fifteen tests; thirteen new, two rewritten in place.

### `server/tests/integration/dbClient.test.ts` - 3 new

| # | Test | Passes if the behaviour it verifies were deleted? |
|---|---|---|
| 1 | `:47` keeps a process alive when the server terminates its idle connection | **NO.** Delete `pool.on("error", ...)`: `AssertionError: expected 'READY 49096\n' to contain 'SURVIVED'`. Asserted across a process boundary, which is the only honest witness - vitest intercepts the uncaught exception, so an in-process assertion passes either way. The file discloses that its own first draft did exactly that. |
| 2 | `:100` logs the terminated connection without reproducing the database error's text | **NO, in both directions.** Listener deleted: `expected undefined to be defined`. Listener kept, `errorSummary` removed: `expected 'Idle database connection error: error…' to contain '57P01'`. |
| 3 | `:147` does not throw when the pool emits an error with no client attached | **NO.** `expected [Function] to not throw an error but 'Error: synthetic' was thrown`. The listener's presence *is* the behaviour. |

REVIEW-1's F-4 (`expect(pool.ended).toBe(false)`, an assertion that could not fail) was removed in `6006d85` and replaced by a real `select 1` through the same pool; the `pg_terminate_backend` guard now targets the child's own `pg_backend_pid` rather than "whatever is idle". Both corrections verified present at `HEAD`.

### `server/tests/integration/logHygiene.test.ts` - 9 new

| # | Test | Passes if the behaviour it verifies were deleted? |
|---|---|---|
| 4 | `:112` names the receipt and withholds its contents when the write fails | **NO.** Revert `llmParseSweep.ts:228` to `console.error(failure.error)`: `expected 'LLM parse sweep: 0 written…' to contain '22P05'`. Drives the real drain against a real Postgres `22P05`; also fails under over-redaction. |
| 5 | `:144` keeps a non-database error's own message | **PARTLY YES - and the file says so at `:151-165`.** It passes with the redaction reverted; it fails under over-redaction (`expected … to contain 'upstream refused'`). A one-directional guard, honestly labelled, and correctly no longer asserting cleanliness of a branch that is not clean (N-2). |
| 6 | `:191` redacts a failure that stops the whole sweep, not only a single row's | **NO.** Revert `llmParseSweep.ts:246` to `console.error(error)`: `expected 'LLM parse sweep did not complete…' not to contain 'Dr Smith Psychiatry Clinic'`. This is the test REVIEW-2's F-2 said did not exist. It exists and it bites. |
| 7 | `:238` records one line per request, by route pattern rather than by path | **NO, twice.** Unregister the middleware: `expected undefined to be defined`. Log `c.req.path` instead of `routePath`: `expected '/api/receipts/0eb72729-…' to be '/api/receipts/:id'`. |
| 8 | `:261` never writes the search term | **NO.** Add `fullUrl: c.req.url`: `expected '{"msg":"request","fullUrl":…}' not to contain 'Psychiatry'`. Two-sided - it asserts a line exists first, so it cannot pass by logging nothing. |
| 9 | `:274` never writes the bearer token or the user id | **NO, on both halves separately.** Add `userId: c.get("userId")`: fails on the user id. Add `auth: c.req.header("authorization")`: `expected … not to contain 'eyJhbGciOiJIUzI1NiJ9…'`. |
| 10 | `:286` records an unauthenticated refusal | **NO.** Unregister the middleware: `expected undefined to be 401`. Weaker than it reads in one respect: it does not assert `route`, which is where X-2 hides. |
| 11 | `:297` reports a request that produced no response as such, rather than as a success | **NO.** Drop the `finalized` guard and read `c.res.status` unconditionally: `expected 200 to be null`. This closes REVIEW-2's F-1 and is the sharpest new assertion in the file. |
| 12 | `:318` records a body refused before any route ran | **NO.** Unregister the middleware: `expected undefined to be 413`. REVIEW-2 additionally showed that moving `requestLog()` inward fails this test and *only* this test, so it genuinely pins the ordering claim at `app.ts:71-72`. |

### `server/tests/integration/export.test.ts` - 1 rewritten, 1 new

| # | Test | Passes if the behaviour it verifies were deleted? |
|---|---|---|
| 13 | `:231` records a loud failure when an image is missing from storage, naming the receipt that caused it | **NO.** Restore `generateExport.ts` to `9673ce5^`: `expected 'No such object: fa39a4ce-…' to contain '5a6dc000-…'`. Assertion-by-assertion: `toContain(receiptId)` and `toMatch(/Delete that receipt, then capture it again/)` are verifications and fail on revert; `not.toContain(userId)` and `not.toMatch(/\.jpg/)` are reachable (under revert the fake's message is `No such object: {userId}/2026/03/{uuid}.jpg`, which contains both - they do not *fire* only because `toContain(receiptId)` throws first); `not.toMatch(/re-attach/i)`, `not.toContain("2026-03-15")` and `not.toContain("Test Vendor")` are one-directional guards that pass on unfixed code and fail when the removed content is re-added (REVIEW-3b proved the last two by re-adding the fields). `expect(response.status).toBe(201)`, `job.status === "failed"` and `downloadUrl === null` are pre-existing and carry none of the stage's weight. |
| 14 | `:280` reports storage being unreachable as that, not as a missing photo | **NO for the discrimination it verifies.** Delete `if (!isMissingObject(error)) { throw error; }`: `expected 'Receipt cb43b0e8-…' to contain 'ETIMEDOUT'`. It does pass under a *full* revert of the stage, which is correct and was disclosed by REVIEW-3b: full deletion preserves the discrimination by accident. I went past the test - see §3.3, where a real S3 client and a real network timeout produce `connect ETIMEDOUT …` rather than the missing-photo text. |

### `server/tests/integration/objectStorage.test.ts` - 1 rewritten

| # | Test | Passes if the behaviour it verifies were deleted? |
|---|---|---|
| 15 | `:73` download of a missing key fails loudly, and names itself NoSuchKey | **NO.** Change the expected name to `DefinitelyNotTheName`: `AssertionError: expected NoSuchKey: The specified key does not exi… { …(10) } to match object { name: 'DefinitelyNotTheName' }`. `rejects.toMatchObject` genuinely discriminates on `name` against the **real** S3 client. This is precisely the assertion REVIEW-3b's F-1 (its only P2) demanded, and it closes it: the property the entire R-1 fix pivots on is now pinned to reality rather than asserted by fiat in the fake. |

Helper, not a test but load-bearing: deleting `error.name = "NoSuchKey"` from `tests/helpers/fakeObjectStorage.ts:35` fails test 13 (`expected 'No such object: c5d7141e-…' to contain 'd03abc93-…'`). Confirmed.

**No test added in this run is of the class this project has been burned by five times.** Every one of the fifteen fails under some edit that removes the behaviour it claims to verify. Test 5 and four assertions inside test 13 are one-directional guards rather than verifications - a legitimate role - and every one of them is labelled as such in the file or in a prior review. Nothing in this suite passes vacuously.

---

## 5 · Findings

Format: `severity | evidence | why the builder missed it`.

---

### X-1 · P2 · Three successive single-finding remediations inverted the export failure message from a non-destructive remedy to a destructive one, against the ledger's own DEFERRED argument

**Severity: P2 | Evidence: `server/src/export/generateExport.ts:191-199` vs `PROD-READINESS.md:326`, and the three-commit history below | Why missed: each remediation answered the one review finding in front of it; no pass compared the final wording against the reasoning three sections up in the same document**

The message a person is shown when their year-end export jams, as shipped:

```
Receipt <id> has no image in storage, so this export cannot be completed - its photo
never finished uploading. Delete that receipt, then capture it again if you still have
the paper. Deleting alone will let the export run, without that receipt in it.
```

Its history across the run:

| Commit | Prescribed remedy | Why it changed |
|---|---|---|
| `486923f` | "Open that receipt and re-attach its photo, or delete it" | REVIEW-3 F-1 (P1): no endpoint can re-attach an image. Rejected. |
| `34da846` | "**Capture that receipt again** so a copy with its photo exists, **then delete this one**" | Non-destructive order. REVIEW-3b F-5 (P3): 409s when the re-captured bytes are byte-identical, because `receipt_images_user_id_sha256_uq` (`src/db/schema.ts:187-189`) is partial on `deleted_at IS NULL`. |
| `bd22e72` | "**Delete that receipt, then capture it again** if you still have the paper" | The order was reversed to dodge that 409. **This commit was never reviewed.** |

The 409 the reversal avoids fires only in the sub-case where the person re-uploads the *identical file*. In the ordinary case - re-photographing the paper - the bytes differ, no index slot is contested, and capture-then-delete works and loses nothing. So a P3 edge case was answered by making the destructive step first for everyone.

What makes this more than a style preference is that the ledger uses the opposite argument two sections later to justify a different decision. `PROD-READINESS.md:326` declines the existence check at create because it "would trade a broken export for a **refused capture**, which is the wrong direction when the paper is usually already gone", and `:235` spells out what the row still holds: "the vendor, the date, the amounts and the HST". The shipped message now instructs the person to destroy exactly that, first, conditioned on paper the ledger itself says is usually already in the bin. REVIEW-3's F-1 made this observation about the earlier draft ("The stage declined an existence check at create to avoid destroying that value, then shipped a message that instructs the user to destroy it by hand"); the remediation trail has since moved *toward* the thing F-1 objected to, not away from it, and the run's own N-3 records the underlying ordering rule as a next-round item while the destructive order ships now.

Mitigating, and stated because the severity is arguable in both directions: the delete is a soft delete (`routes/receipts.ts:401-424`), so the row survives in Postgres and the owner can recover it with SQL; the message is honest about the cost of deleting alone; and no server behaviour is wrong - only the advice. That is why this is P2 and not P1. The argument for P1 is that on this project's own severity scale a lost receipt is the top harm, the person following the instruction has no in-product way back (`db/receiptQueries.ts:10-12` folds `isNull(deletedAt)` into every read, so a deleted receipt is unreachable through the API), and the failing export is the one artifact the product exists to produce. A reader who weights that differently should read this as P1.

---

### X-2 · P3 · In the production configuration, `route` reports `unmatched` for every edge refusal and every oversized body, and the ledger's disclosed caveat covers only the `/api/me/*` case

**Severity: P3 | Evidence: my own real-entrypoint runs, §3.1 and §3.2 | Why missed: the edge-secret middleware is conditional on `EDGE_SHARED_SECRET` and is never registered by `createTestHarness`, so no test and no prior review ever produced a 403; the ledger's caveat was written from REVIEW-2's narrower 401 observation**

`PROD-READINESS.md:215` discloses one shape of `route` instability: "a request refused by the auth middleware reports the middleware's mount pattern (`/api/me/*`) while one that reaches the handler reports `/api/me`". Measured against the real entrypoint, there is a second and coarser shape:

```
GET  /api/me       , no edge header   -> {"route":"unmatched","status":403}
POST /api/receipts , 2 MB body        -> {"route":"unmatched","status":413}
GET  /nope?q=...                      -> {"route":"unmatched","status":404}
```

`c.req.routePath` returns the registration pattern of the deepest handler that ran; when the edge check or `bodyLimit` answers, that is their own `"/*"`, which `requestLog.ts:55` maps to `unmatched`. Production is the configuration where the edge secret is set (`app.ts:96-113`, wave-6 §3 steps 8 and 11), so a Cloudflare transform rule that stops adding the header produces a log full of `route: "unmatched"` - indistinguishable by that field from traffic to paths that do not exist. PR-3's stated purpose (`PROD-READINESS.md:196`) is "no way to tell a 401 storm from a 404 from an idle server"; status still separates these, so the finding is a narrowing of the disclosure rather than a hole in the fix. **Nothing leaks** - `unmatched` is a literal, and the edge secret does not appear in the log (`grep -c` → 0). `logHygiene.test.ts:318` asserts only `status` on the 413, and there is no 403 test at all, so nothing pins either shape.

---

### X-3 · P3 · The run's own deliverable is not a text file: `PROD-READINESS.md` carries two NUL bytes and `grep` refuses to read it

**Severity: P3 | Evidence: below | Why missed: a NUL renders as nothing in an editor, and no pass re-read the ledger with a tool**

```
$ perl -ne 'while(/([\x00-\x08\x0b\x0c\x0e-\x1f])/g){ print "line $.: 0x", sprintf("%02x",ord($1)), "\n" }' PROD-READINESS.md
line 153: 0x00
line 159: 0x00

$ file PROD-READINESS.md
PROD-READINESS.md: data

$ grep -c "Psychiatry" PROD-READINESS.md
(no output - grep treats the file as binary)
```

Both NULs are in the PR-2 reproduction block, inside the vendor string that was pasted verbatim from the reproduction (the NUL is the whole point of that reproduction, which is why it got there). They are in the committed `HEAD` blob, and the file is *added* by this run at `9146806` - so this is the run's own artifact, not inherited state. REVIEW-3 spotted it and filed it as "pre-existing... out of its scope", which was true of that stage and is false of the run. Consequence: the deliverable the whole exercise produces cannot be searched by `grep`, `git grep`, or anything else that sniffs for binary content; the fix is to write the byte as `\0` or `<NUL>` in the two quoted lines.

---

### X-4 · P3 · Three accepted review findings were neither fixed nor carried to NEXT ROUND, so the run's record of itself is incomplete

**Severity: P3 | Evidence: `grep -a` over `PROD-READINESS.md` | Why missed: each review's findings were triaged in the next commit, and the ledger has no section for "accepted, declined, and why"**

§8 carries N-1 (REVIEW-1 F-2), N-2 (REVIEW-2 F-3) and N-3 (REVIEW-3b F-5). These three are in neither §8 nor anywhere else:

- **REVIEW-2 F-7** - `c.req.routePath` is `@deprecated` in the installed `hono@4.13.0` (`node_modules/hono/dist/types/request.d.ts:275-290`, "Use routePath helper defined in `hono/route` instead"). The review explicitly asked for "one line in the ledger so the next Hono bump is not a surprise". `grep -a -c deprecated PROD-READINESS.md` → **0**; `grep -a -c routePath` → **0**. New production code stands on a deprecated getter with nothing recorded.
- **REVIEW-3b F-4, its substance** - `isMissingObject` (`generateExport.ts:246-252`) is a near-duplicate of `isNotFound` (`src/storage/s3ObjectStorage.ts:176-184`) and hardcodes S3/R2 error-name strings into a module that otherwise depends only on the `ObjectStorage` interface, so a future non-S3 adapter loses the fix silently. `bd22e72` rewrote only the *comment* that cited the false precedent; the duplication and the layering leak are untouched and unrecorded. `grep -a -c isNotFound PROD-READINESS.md` → **0** (the four `duplicat` hits are all about the duplicate-image index). `CLAUDE.md`'s review-discipline section names duplication as a thing to hunt explicitly.
- **REVIEW-3b F-7** - the R-1 artifact block (`PROD-READINESS.md:241-251`) is still a hand-wrapped pseudo-transcript with the job id elided, against the run's own rule that recorded output is evidence rather than illustration. `grep -a -c verbatim` → **0**. (I reproduced the underlying replay in §2.7, so the *claim* is sound; the presentation is what was asked for and not given.)

The run is otherwise unusually disciplined about carrying its own residue forward - which is what makes three silent drops worth naming rather than shrugging at.

---

### X-5 · informational · The last code commit shipped without a review, and the ledger's pass table does not say so

`reviews/` covers `ca82907..9146806` (REVIEW-0), `2856284..c1104b9` (REVIEW-1), `6006d85..acb5309` (REVIEW-2), `9673ce5..486923f` (REVIEW-3) and `9673ce5..34da846` (REVIEW-3b). `bd22e72` - which rewrote the user-facing remedy string and added the real-client `NoSuchKey` assertion - and `fdf7ae0` are covered by nothing until this file. Not a defect in itself, and this review is that coverage: I falsified both of `bd22e72`'s test changes (§4, tests 13 and 15) and reproduced its message end-to-end (§2.7). Recorded because the one unreviewed commit is also where X-1 came from, which is the argument for the review cadence rather than against it.

---

## 6 · Verdict

**PASS-WITH-FINDINGS.**

Four P1s were on the frozen list and all four are genuinely closed, in the places they were reported, with artifacts I reproduced rather than accepted. The pool listener survives a real `pg_terminate_backend` against the real entrypoint and logs a line that keeps the SQLSTATE and drops the message, the detail and the connection password. Both of PR-2's log sites now have a test that fails when reverted - including the drain-catch line REVIEW-2 proved was covered by nothing. The request log emits one line per request through the real `createApp`, carries no path, query string, token or user id on any path I could reach including the 403 and 413 that answer before a route, and reports a request that produced no response as `status: null, threw: true` rather than as a success. The export failure names the receipt, and its discrimination between "the object is gone" and "storage did not answer" holds against a real S3 client and a real network timeout, not only against the fake - which is more than any prior pass established, and which the new `objectStorage.test.ts` assertion now pins so it cannot silently drift.

Fifteen tests were added or rewritten and every one of them fails under an edit that removes the behaviour it claims to verify. The handful of one-directional guards are labelled as such in the files that contain them. Three gates hold against BASELINE with the delta fully accounted for, no dependency moved, no iOS file was touched at any commit, history is linear with no remote and no tags, `main` is where it started, and every server start in my work booted with `ANTHROPIC_API_KEY` withheld and said so.

Nothing I found rises to P1. The one finding that should not close silently is **X-1**: the export message's remedy was inverted across three single-finding remediations until the destructive step came first, in the one commit no reviewer saw, and it now contradicts the argument the ledger itself uses two sections later to justify leaving the create path alone. **X-2**, **X-3** and **X-4** are P3 bookkeeping and disclosure gaps in an otherwise honest record; X-3 in particular means the deliverable cannot be `grep`ed, which is a strange property for a document whose whole method is citation.

---

## 7 · Restoration

Thirteen temporary falsification edits were made - `server/src/db/client.ts` (2), `server/src/parse/llmParseSweep.ts` (3), `server/src/app.ts` (1), `server/src/observability/requestLog.ts` (4), `server/src/export/generateExport.ts` (2), `server/tests/integration/objectStorage.test.ts` (1), `server/tests/helpers/fakeObjectStorage.ts` (1) - each restored with `git checkout --` and confirmed by `git status --porcelain` returning empty after every batch.

Final state: `git status --porcelain` clean apart from this file, `git rev-parse HEAD` = `fdf7ae0b19bcc2f04c99924723acfb6a33ae028f`, and a confirming full run of `npm test` at **30 files / 276 passed / 0 failed** with `npm run typecheck` at exit 0.

Two servers started for guardrail 7 on port 3011 were killed and the port confirmed free. The scratchpad env copies (all with `ANTHROPIC_API_KEY` stripped) were deleted. Port 3000's pre-existing pid 31468 was never touched and was confirmed alive at the end. Rows written during the replay went only to the disposable `kept_test` database, which the suite truncates on its next run. The only file this review created is this one.
