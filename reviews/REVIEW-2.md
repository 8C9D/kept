# REVIEW-2 - adversarial review of the PR-2 / PR-3 code stage

verdict: PASS-WITH-FINDINGS

Range reviewed: `6006d85..acb5309` (1 commit, 346 insertions, 7 deletions, 4 files).
Reviewed at `HEAD = acb5309`, branch `prod-readiness/2026-08-10`.
Working tree clean before this review and clean after it (`git status --porcelain` empty; every falsification edit below was reverted with `git checkout --` and the tree re-checked each time).
Everything below I re-ran myself against `reviews/BASELINE.md`. No builder narration was available and none was used.

---

## 1 · What the stage contains

```
$ git diff --name-status 6006d85..acb5309
M	server/src/app.ts
A	server/src/observability/requestLog.ts
M	server/src/parse/llmParseSweep.ts
A	server/tests/integration/logHygiene.test.ts
```

Two findings closed in one commit:

- **PR-2** - `llmParseSweep.ts:228` and `:246` now route the error through `errorSummary` instead of printing the raw object.
- **PR-3** - a new `requestLog()` middleware, registered outermost at `app.ts:73`.

This is exactly what `PROD-READINESS.md:172` and `:198` specified, in the blast radius each declared (`:174` "two log statements in one file"; `:200` "one middleware in `app.ts`"). No endpoint, no screen, no command, no flag, no table, no column, no config key, no dependency (`package.json` and `package-lock.json` untouched). The one new file is a genuine module boundary in an existing `src/observability/` directory that already holds `errorSummary.ts` and `portInUse.ts`.

**Nothing the stage adds writes anywhere but stdout.** `requestLog.ts` imports one type from `hono` and touches no filesystem, no database, no network, no storage. It sets no header and returns no value, so it cannot alter a response.

---

## 2 · Compliance checks the contract requires, each answered

| Check | Result |
|---|---|
| Fabricated or unreproducible findings | **None.** The stage's central factual claim - that the pre-fix line printed a whole receipt - I reproduced by reverting it (§3.2): vendor, GST/HST number and all three amounts came out in plaintext, matching `PROD-READINESS.md:155-166` field for field. |
| Evidence citations that don't say what they're claimed to say | **One, in a code comment rather than in evidence** - F-6. `requestLog.ts:45-47` states a Hono mechanism that is not Hono's. |
| Severity inflation / deflation | N/A - the stage assigns no severities and edits no severity in the ledger. |
| Features smuggled in under the no-features rule | **None.** See §1. The only new user-observable effect is stdout volume. |
| Prohibited actions taken | **None detectable.** `git merge-base --is-ancestor 6006d85 acb5309` holds and `ca82907` is still an ancestor of `HEAD`; the reflog shows seven linear commits and no `rebase`/`reset`/`amend`; `git remote -v` is empty so no push was possible; `git tag` is empty; `main` still points at `ca82907`. Zero files deleted. No credential touched. `npm audit` still reports **6 moderate**, unchanged from BASELINE. |
| iOS files touched | **None.** `git diff --name-only ca82907..acb5309 \| grep -c '^ios/'` → `0`, for this stage and for the whole branch. |
| An Anthropic API call made | **No positive evidence, and corroborating evidence against.** Every server log in the run's scratchpad (`server*.log`, `reqlog.log`, `after-fix.log`, `sigterm.log`, `server-crash.log`) opens with `ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled`, and the run's env files carry only `DATABASE_URL`, `SESSION_JWT_SECRET`, `APPLE_CLIENT_ID`, `STORAGE_*` (key names read; values not). Both `DATABASE_URL`s are `localhost:5432`. The added test injects its own `parse` function and never constructs an SDK client. My own runs were started with the key withheld. This cannot prove a negative and I do not claim it does. |
| Fixes that relocated a bug rather than removed it | **PR-3: no.** **PR-2: removed on the branch it was reported on, partially open on the sibling branch of the same `catch`** - F-3. Not a relocation; a residual instance the fix does not reach. |
| Error handling that hides errors | **No swallowing.** `requestLog` is `try { await next() } finally { … }` with **no `catch`**, so nothing is intercepted - I confirmed by probe that a thrown `Error` still reaches `onError` and a thrown non-`Error` still propagates out of `app.fetch` (§3.5). `errorSummary` keeps SQLSTATE, constraint, table and routine, so the redaction does not reduce a database failure to "something happened" - the falsification run shows `code=22P05` surviving. **One misreport, not a swallow** - F-1. |
| Verification that doesn't actually exercise the changed path | **Mostly no, one gap.** The sweep test drives the real `createLlmParseSweep` drain against a real Postgres rejection rather than calling `errorSummary` directly, and the request-log tests go through the real `createApp`. But `llmParseSweep.ts:246` - the second of the two changed lines - is exercised by nothing: F-2. |
| Anything marked resolved without an artifact | **Nothing is marked resolved, which is again the problem.** `PROD-READINESS.md:352-353` still reads `PR-2 \| P1 \| OPEN` and `PR-3 \| P1 \| OPEN` at the commit that closed both. This is REVIEW-1's F-1 recurring after it was accepted and corrected once - F-4. |

---

## 3 · What I re-ran, and what it produced

Predictions were written before each run and are stated with their outcomes.

### 3.0 Gates, against BASELINE

```
$ npm run typecheck    -> exit 0, no output          (BASELINE: clean)
$ npm test             -> Test Files 30 passed (30)
                          Tests     273 passed (273)
$ npm audit            -> 6 moderate severity vulnerabilities   (BASELINE: 6)
```

BASELINE is 28 files / 263 tests. `+1` file / `+3` tests is the prior PR-1 stage; `+1` file / `+7` tests is this one. 263 + 3 + 7 = 273. No pre-existing test changed state.

### 3.1 Guardrail 7 - the real entrypoint, started the real way, at `HEAD`

Port 3002 (3000 holds the two-day-old pid the BASELINE records; left alone and untouched). `ANTHROPIC_API_KEY` stripped from the env file, local Postgres and MinIO.

**Predicted:** the server boots, answers 401 on `/api/me`, and now emits one JSON line per request that contains no client-supplied path and no query string.

**Observed, exactly:**

```
ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only
Kept API listening on port 3002

$ curl .../api/me                                            -> 401
$ curl .../api/receipts/8f3a0000-...-444455556666             -> 401
$ curl ".../totally/unknown/path-SECRETVENDOR?q=Psychiatry"   -> 404
$ curl -X POST .../api/auth/apple -d '{"identityToken":"bogus"}' -> 401

{"msg":"request","method":"GET","route":"/api/me/*","status":401,"durationMs":3,"authenticated":false}
{"msg":"request","method":"GET","route":"/api/receipts/*","status":401,"durationMs":0,"authenticated":false}
{"msg":"request","method":"GET","route":"unmatched","status":404,"durationMs":0,"authenticated":false}
{"msg":"request","method":"POST","route":"/api/auth/apple","status":401,"durationMs":4,"authenticated":false}
```

The 404 line is the important one: neither `path-SECRETVENDOR` nor `q=Psychiatry` appears anywhere. The privacy claim holds on the one path the suite does not cover. It also exposes F-5: `/api/me` reports `/api/me/*` when the session middleware refuses and `/api/me` when it does not.

### 3.2 Falsification of the PR-2 fix (per-row site)

`console.error(errorSummary(failure.error))` → `console.error(failure.error)`; run the new file; restore.

**Predicted:** the first sweep test fails on its redaction assertions. **Observed:** it fails - first on the SQLSTATE assertion, and the received text shows every redaction assertion below it would have failed too:

```
× names the receipt and withholds its contents when the write fails
AssertionError: expected 'LLM parse sweep: 0 written, 0 superse…' to contain '22P05'
Received:
  Error: Failed query: update "receipts" set "llm_suggestions" = $1 where …
  params: {"model":"claude-haiku-4-5",…,"suggestions":{"vendor":"Dr Smith Psychiatry Clinic ",
   "purchasedAt":"2026-03-15","totalCents":11300,"hstCents":1300,"subtotalCents":10000,
   "vendorTaxNumber":"123456789RT0001"}},fd9c8e24-…
```

That is PR-2 reproduced at `HEAD`, on the real drain, with the real Postgres rejection. The finding was not fabricated and the fix is real.

### 3.3 Falsification of the PR-2 fix (drain-catch site)

`console.error(errorSummary(error))` at `:246` → `console.error(error)`; run the **whole** suite; restore.

**Predicted:** at least one test fails. **Observed:** `Test Files 30 passed (30) / Tests 273 passed (273)`. The second changed line is covered by nothing. F-2.

### 3.4 Falsification of the PR-3 fix, four ways

| Edit | Predicted | Observed |
|---|---|---|
| Delete `app.use("*", requestLog())` from `app.ts` | all five request-log tests fail | **5 failed, 2 passed** - exactly the five |
| Add `fullUrl: c.req.url` and `userId: c.get("userId")` to the line | the two privacy tests fail | **3 failed** - the route test plus both privacy tests |
| Move `requestLog()` from outermost to just above the route mounts | the 413 test fails, nothing else | **1 failed** - "records a body refused before any route ran" |
| (control) no edit | all pass | 7 passed |

The privacy assertions are load-bearing, not decorative, and the 413 test genuinely pins the outermost ordering the `app.ts:71-72` comment claims.

### 3.5 Behaviour on paths the stage was not meant to touch

A probe app mounting the real `requestLog` with a throwing route (scratchpad, not the repo):

```
--- ok ---        {"…","route":"/ok","status":200,…}                200
--- boom (thrown Error, onError handles) ---
                  {"…","route":"/boom","status":500,…}              500
--- nonerror (thrown string) ---
                  {"…","route":"/nonerror","status":200,…}          threw out of app.request
--- 404 ---       {"…","route":"unmatched","status":404,…}          404
```

Rows 1, 2 and 4 are correct. Row 3 is F-1. The client-visible behaviour is unchanged in all four - the throw still propagates - so this is a wrong log line, not a wrong response.

### 3.6 The model-error branch, measured locally without any API call

`errorSummary` redacts only errors carrying a database marker; for everything else it reproduces `message` **and the whole `cause` chain**. `claudeReceiptParser.ts:84` wraps `JSON.parse`'s `SyntaxError`, and V8 embeds the first characters of the input in that message. Running the two real failure constructors from `claudeReceiptParser.ts` through `errorSummary`:

```
LlmParseError: Model response was not parseable JSON
  caused by SyntaxError: Unexpected token 'D', "Dr Smith P"... is not valid JSON
```

F-3. The zod branch is clean in this zod version (`invalid_type` carries `expected`/`path`/`message` and not the input value) - I checked that too rather than assuming it.

---

## 4 · Findings

Format: `severity | evidence | why the builder missed it`.

---

### F-1 · P2 · A request that dies on a non-`Error` throw is logged as `status: 200`

**Severity: P2 | Evidence: §3.5 row 3 - `{"msg":"request","route":"/nonerror","status":200}` for a request that produced no response at all; mechanism at `node_modules/hono/dist/context.js:109-113`, `get res() { return this.#res ||= createResponseInstance(null, {…}) }` | Why missed: the `finally` was reasoned about as "still counted" and never exercised against an actual throw**

`requestLog.ts:38-39` states the intent: *"In a `finally` so a request that throws past the error handler is still counted - an uncounted request is exactly the one worth seeing."* The intent is right and the `finally` is the right shape. But `c.res` at `:49` is a **lazy getter that manufactures a fresh 200 Response when none was ever set**, so the request that most needs seeing is not merely uncounted - it is counted as a success, which is worse than silence for the exact diagnostic use this middleware exists for.

Hono's `compose` re-throws a non-`Error` without calling `onError` (`node_modules/hono/dist/compose.js`, `if (err instanceof Error && onError) … else throw err`), which is the reachable trigger. In this codebase everything deliberately thrown is an `Error` subclass, and I found no reachable non-`Error` throw, so this is **P2 and not P1** - the lower severity is taken and the reasoning stated, per the ledger's own rubric. Reading `c.res` also silently materialises a response object on the context in that case; it is discarded, and I confirmed the client-visible behaviour is unchanged.

The honest form is to read the status only when a response actually exists (`c.finalized`, or capturing the resolved value of `next()`), and to log a distinguishable value - `status: null`, or a `threw: true` flag - when it does not.

---

### F-2 · P2 · The second of the two changed log lines is verified by nothing

**Severity: P2 | Evidence: §3.3 - reverting `llmParseSweep.ts:246` to `console.error(error)` leaves `Tests 273 passed (273)` | Why missed: the test file drives the per-row drain, and the drain-catch branch needs `runLlmParseSweep` to throw *outside* the per-row `try`, which nothing constructs**

`PROD-READINESS.md:172` specifies "Route **both sites** through `errorSummary`". Both sites were routed; only one was proved. This is the softer cousin of the class this repository has caught five times: not an assertion that cannot fail, but a changed line with no assertion pointed at it at all - and the reason PR-2 exists is that a green 263-test suite watched this exact file reintroduce the leak on 2026-08-08.

The exposure at that site is genuinely small, and I say so rather than inflating it: `runLlmParseSweep` throws outside the row loop only from the SELECT at `:84-99` (which binds no receipt values) or the invariant throw at `:111` (which carries a receipt id and nothing else), and the `writeIfStillNull` at `:151` binds a failure record whose only free text is already `redactedMessage(error)`. So the fix is correct; it is the *verification* that stops one line short.

---

### F-3 · P2 · PR-2 is closed on the database branch and left open on the model branch of the same `catch`, and the new test reads as though it were not

**Severity: P2 | Evidence: §3.6, measured locally with no API call | Why missed: `errorSummary` was treated as "the redaction", when it is specifically a *database-error* redaction that passes every other message and its whole cause chain through verbatim**

`errorSummary.ts:112-118`: an error without a database marker is rendered as `${name}: ${error.message}` plus stack, and `:83-84` walks `cause` to depth 5 doing the same. `claudeReceiptParser.ts:84` throws `LlmParseError("Model response was not parseable JSON", { cause: error })` where the cause is `JSON.parse`'s `SyntaxError`, whose V8 message quotes the first characters of the model's output - output derived from the receipt's own OCR text. Measured: `caused by SyntaxError: Unexpected token 'D', "Dr Smith P"... is not valid JSON`.

Ten characters of a vendor name is a much smaller leak than the whole record PR-2 reported, which is why this is P2. What raises it above a note is the second half:

`logHygiene.test.ts:144-168` is titled *"keeps the model's own error text, and still withholds the receipt"* and asserts `expect(logs).not.toContain(VENDOR)` on a synthetic `new Error(...upstream refused after reading ${text.length} chars...)` - an error constructed so that it *could not* have carried the vendor. The comment at `:152-158` honestly discloses that this test passes with the redaction reverted, and `PROD-READINESS.md:308` correctly files the model branch under CANNOT ASSESS. But the disclosure is about the wrong axis: the test is not merely weak on redaction, it asserts cleanliness of a branch whose **real** error shapes it never constructs, and the real shape is not clean. Both of the parser's error constructors can be built and passed through `errorSummary` on this machine with no key and no network - as I did in §3.6 - so this was measurable, not blocked by the prohibition.

---

### F-4 · P2 · The ledger still says PR-2 and PR-3 are OPEN at the commit that closed them - the second time

**Severity: P2 | Evidence: `PROD-READINESS.md:352-353` at `HEAD = acb5309` read `| PR-2 | P1 | OPEN |` and `| PR-3 | P1 | OPEN |`; `git diff --name-status 6006d85..acb5309` does not list `PROD-READINESS.md` | Why missed: the same separation of fix from record that REVIEW-1 raised as F-1 and the builder then corrected in `6006d85`**

`PROD-READINESS.md:329` says "Filled in as passes complete", and `CLAUDE.md`'s doc-ownership rule exists because this project has already lost three days to a decision reaching one document and not the other. REVIEW-1 F-1 made exactly this finding against `c1104b9`; the builder accepted it and fixed the ledger in the following commit. The pattern has now repeated, which makes it a habit rather than a slip, and it is worth saying that a reader handed "the repo at `HEAD` plus the ledger" - the contract's own package - receives an inconsistent pair.

It stays P2: no code is wrong and one edit repairs it. When the RESOLVED artifacts are written they must not overstate - F-2 and F-3 both belong in PR-2's status paragraph, and the request log's status field (F-1) belongs in PR-3's.

---

### F-5 · P2 · `route` is not stable per endpoint, so the field cannot be grouped on

**Severity: P2 | Evidence: §3.1 - `route:"/api/me/*"` on the 401, and the builder's own `reqlog.log` shows `route:"/api/me"` on the 200, same endpoint, same process | Why missed: the only test that asserts `route` (`logHygiene.test.ts:194`) uses a request that reaches its handler**

`c.req.routePath` returns the registered path of the **last handler that ran**, so an endpoint reports its own pattern when the route handler runs and the session middleware's wildcard when it short-circuits. `/api/receipts/:id` becomes `/api/receipts/*` on a 401; `/api/me` becomes `/api/me/*`. Nothing leaks - all of these are patterns this project wrote - but PR-3's stated purpose (`PROD-READINESS.md:194`) is being able to "tell a 401 storm from a 404", and the field that would separate them changes shape precisely when the status changes. The 401 test at `:245` asserts only `status` and `authenticated`, so nothing pins this either way.

---

### F-6 · P2 · The comment explaining the `route` guard describes a mechanism Hono does not have

**Severity: P2 | Evidence: `requestLog.ts:45-47` vs `node_modules/hono/dist/request.js:281-283`, `get routePath() { return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path }` | Why missed: the observed output ("unmatched" on a 404) was correct, so the explanation behind it was never checked**

The comment reads *"Falls back to the raw path only when nothing matched, and a 404's path is client-supplied rather than one of ours."* `routePath` never returns the raw request path under any condition. It returns the registered pattern of the last matched handler, and on a 404 that is the `/*` of `app.use("*", …)` - which is why the `=== "/*"` test works. The behaviour is right and I verified it end to end (§3.1: neither the client path nor the query string appears). The explanation is wrong in a way that matters for the next edit: the guard is comparing against **this middleware's own registration string**, so registering any narrower wildcard ahead of the routes (`app.use("/api/*", …)`) would make unmatched requests log `/api/*` instead of `unmatched`, and a reader trusting the comment would look for a raw-path fallback that does not exist. `PROD-READINESS.md:198`'s fix description does not make this claim; only the code comment does.

---

### F-7 · informational · The middleware is built on a deprecated Hono API

`node_modules/hono/dist/types/request.d.ts:275-290` marks `routePath` `@deprecated` with "Use routePath helper defined in `hono/route` instead". Installed version is `hono@4.13.0`. Not a defect, nothing to do in this stage (swapping it is a change no finding cites, and the prohibitions forbid touching dependencies), but new code standing on a deprecated getter is worth one line in the ledger so the next Hono bump is not a surprise.

---

## 5 · Per-test statement: would each test still pass if the behaviour it verifies were deleted?

Answered by experiment, not by reading. Method: edit, run, `git checkout --`, confirm `git status --porcelain` empty. All seven tests are in `server/tests/integration/logHygiene.test.ts`.

| Test | Verifies | Passes if the behaviour is deleted? |
|---|---|---|
| `:112` "names the receipt and withholds its contents when the write fails" | `llmParseSweep.ts:228` routes the per-row failure through `errorSummary` | **NO.** Reverted to `console.error(failure.error)`: fails at `:132` (`expected … to contain '22P05'`), and the received text carries `Dr Smith Psychiatry Clinic`, `123456789RT0001` and `11300`, so the four `not.toContain` assertions below it would all have failed as well. It drives the real `createLlmParseSweep` drain against a real Postgres `22P05`, not a re-implementation - the vacuous version (calling `errorSummary` directly and asserting the output is clean) would have passed with `llmParseSweep.ts` untouched, and the builder explicitly avoided it at `:87-93`. |
| `:144` "keeps the model's own error text, and still withholds the receipt" | Two things, and they falsify differently | **PARTLY YES - and the test says so itself at `:152-158`.** The *withholding* half (`not.toContain(VENDOR)`, `not.toContain(OCR_TEXT)`) **cannot fail**: the injected error is `new Error("upstream refused after reading N chars")`, which never contained a vendor or the OCR text under any version of the code. The *keeping* half (`toContain("upstream refused")`) **can** fail - it guards over-redaction, which is a real direction. So this is not a test that cannot fail, but three of its five assertions are unfalsifiable, and F-3 shows the branch they appear to cover is not in fact clean. |
| `:194` "records one line per request, by route pattern rather than by path" | The middleware exists, logs method/status/authenticated/duration, and reports the pattern rather than the id | **NO.** Unregister the middleware: fails at `:207` (`expected undefined to be defined`). Log `c.req.url` and `userId` instead: fails at `:214`. Every field it asserts is pinned. |
| `:217` "never writes the search term" | The query string never reaches the log | **NO.** Adding `fullUrl: c.req.url` to the line fails it at `:230` on `not.toContain("q=")`. Note the guard is genuinely two-sided - it asserts `requestLine(logs)` is defined first, so it cannot pass by logging nothing. |
| `:234` "never writes the bearer token or the user id" | Neither credential nor user id reaches the log | **NO.** Adding `userId: c.get("userId")` fails it at `:242`. Same two-sided guard. |
| `:245` "records an unauthenticated refusal" | A 401 produces a line, with `authenticated:false` | **NO.** Unregister the middleware: fails at `:252` (`line?.status` is `undefined`). Weaker than it reads in one respect - it does not assert `route`, which is where F-5 hides. |
| `:256` "records a body refused before any route ran" | The middleware sits outside `bodyLimit`, so the 413 is logged | **NO, and it is the sharpest test in the file.** Moving `requestLog()` from outermost to just above the route mounts fails this test and *only* this test. It is the one assertion that pins the ordering claim at `app.ts:71-72`, and it would have been trivially vacuous had it asserted only "a line exists". |

**No test in this stage is of the class this project has caught five times.** The nearest miss is `:144`, and it is disclosed in the file rather than discovered by me - which is the right behaviour, though F-3 argues the disclosure understates the problem. The gap that is *not* disclosed anywhere is F-2: `llmParseSweep.ts:246` has no test pointed at it, and no test in the suite fails when it is reverted.

---

## 6 · Verdict

**PASS-WITH-FINDINGS.**

Both frozen findings are genuinely closed in the places they were reported. I reproduced PR-2's leak at `HEAD` by reverting one line - vendor, GST/HST number and every amount, exactly as the ledger described - and the fix removes it while keeping the SQLSTATE that makes the line actionable. PR-3's middleware is the one the ledger specified, mounted outermost, and I confirmed against the real entrypoint started the real way that it emits one line per request carrying no path, no query string, no token and no user id, including on the 404 the suite does not cover. It swallows nothing: there is no `catch`, and a thrown `Error` still reaches `onError`. It writes nowhere but stdout. Three gates hold against BASELINE: typecheck clean, 273/273 with the delta fully accounted for, `npm audit` unchanged at 6 moderate. No iOS file, no new endpoint, table, column, config key or dependency, no history rewrite, no remote, and every server start in the run carries the "ANTHROPIC_API_KEY is not set" banner.

All seven findings are P2 or informational and none of them makes a response wrong. Two should not close silently. **F-2**: one of the two lines PR-2 named is verified by nothing - reverting `llmParseSweep.ts:246` leaves the whole suite green, in the one file whose history is a leak returning under a green suite. **F-3**: `errorSummary` is a database-error redaction, not a redaction, and the model branch of the same `catch` still prints the first characters of the model's output through a `SyntaxError` cause - measurable locally, with no API call, and the new test's shape reads as covering it. **F-1** is the one to fix in code: the request log reports a request that died on a non-`Error` throw as `status: 200`, which is the opposite of what a diagnosability finding should ship. **F-4** is the repeat: the ledger says PR-2 and PR-3 are OPEN at the commit that closed them, exactly as REVIEW-1 found for PR-1.
