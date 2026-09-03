# FINAL ADVERSARIAL REVIEW — `prod-readiness/round-3`, `7035141..daf1e4b` (13 commits)

## 1 · What I re-ran, not read

Every number below is mine. Nothing was taken from `PROD-READINESS-ROUND-3.md` or `reviews/round3/`.

| Gate | Baseline given | I measured at `daf1e4b` | Verdict |
|---|---|---|---|
| `npm test` | 289 / 31 files | **299 passed, 31 files** | +10, no regression |
| `npm run typecheck` | clean | **exit 0, no output** | clean |
| `npm audit` | 6 moderate | **6 moderate** (esbuild via drizzle-kit/vitest, uuid via exceljs) | unchanged |
| `npx drizzle-kit check` | clean | **"Everything's fine", exit 0** | clean |
| Fifth gate: real entrypoint | not stated at HEAD | **boots on 3055, `GET /api/me` → 401 + `cache-control: no-store`** | passes (see F-8) |

289 + 10 new `it(` blocks = 299. I counted the 10 across the eight touched test files; the ledger's arithmetic at `:511` is correct.

`ANTHROPIC_API_KEY` was withheld from every process I started, via a scratchpad copy of `.env.local` with that line stripped (`grep -c '^ANTHROPIC_API_KEY'` = 0, 7 variables remain). Every boot logged `ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled`. No `parse-llm-*` script was run. Ports 3051/3055/3056/3057 were used and released; 3000 was never touched.

## 2 · Mutation testing — the project's standing requirement

I copied `server/` to the scratchpad, symlinked `node_modules`, confirmed a green control, then mutated **behaviour** and re-ran. Eleven source mutations plus one test-helper mutation.

| # | Mutation | Test(s) | Result |
|---|---|---|---|
| 1 | `src/auth/session.ts` reverted to `7035141` | `session.test.ts`, `auth.test.ts` | **both fail** — `:92` "expected `{userId:'not-a-uuid'}` to be null"; `:119` "expected 500 to be 401" |
| 2 | `src/routes/receipts.ts` reverted (drop `isNull(receiptImages.deletedAt)`) | `softDelete.test.ts` | **fails** at `:87` — tombstone moved Jan 15 → Aug 11 |
| 3 | `src/routes/exports.ts` reverted (drop `isIssuedExportKey`) | `export.test.ts` | **both fail** — `:663` and `:708`, received a presigned URL naming the victim's prefix |
| 4 | `downloadUrlFor`'s refusal replaced with a `throw` | `export.test.ts` | **fails** at `:701` "expected 500 to be 200" — **RV3-E's containment claim is genuinely pinned** |
| 5 | `src/observability/requestLog.ts` reverted | `logHygiene.test.ts` | **both fail** — `:308`, `:362` "expected undefined to be true" |
| 6 | `sessionPresented` hardcoded `true` | `logHygiene.test.ts` | **fails** at `:363` "expected true to be false" — the pairing discriminates in both directions |
| 7 | `captureRequest`'s per-capture `lines = []` removed | `logHygiene.test.ts` | **fails on unmutated source** at `:362` — reproduces the builder's self-caught regression exactly as recorded |
| 8 | `src/productionEnv.ts` reverted | `productionEnv.test.ts` | **fails** at `:101` "expected [Function] to throw" |
| 9 | `src/db/client.ts` reverted | `dbClient.test.ts` | **both fail** — `:211` "expected undefined to be 10000"; second **hung to the 40 s vitest timeout**, exactly the gap the builder recorded |
| 10 | `src/index.ts` reverted | `startupProbe.test.ts` | **fails** at `:248` on `toMatch(/GetObject/)` |
| 11 | `ISSUED_EXPORT_FILENAME` narrowed to calendar years only | `export.test.ts` | **fails** at `:226` — the false-refusal direction is covered by the pre-existing fiscal-year test |
| 12 | Dockerfile at HEAD vs at `7035141` | image build + run | see §3 |

**All ten new tests die when the behaviour they pin is removed. None is an assertion that cannot fail.** Mutation 11 additionally shows the new predicate cannot silently null a legitimate fiscal-year export.

**Default-vs-override check (the project's specific trap):** `dbClient.test.ts:206-211` and `:214-250` pass **no options** and read `createDb(url)` directly — which is exactly what `src/index.ts:118` runs. The R2-4 unit test drives `assertProductionEnv` itself, the path the entrypoint calls at `src/index.ts:51`. No test pins a value only through an injected override.

## 3 · Live artifacts I produced myself

- **R3-1** — booted the real entrypoint with a wrong `STORAGE_SECRET_ACCESS_KEY`, `EXIT=1`. Refusal prints the `GetObject` wording; `grep -c` returns **0** for `bucket's metadata`, **0** for `PROD-READINESS-ROUND-2.md`, **0** for `PROD-READINESS|reviews/`, and **0** for the wrong secret. Cause carries `Key: '.startup-probe/reachability'` — the object read, matching the sentence.
- **R3-2** — live server, two 401s: `"sessionPresented":false` with no header, `"sessionPresented":true` with a bearer. No token value in either line.
- **PR-12** — minted a token with the **real** `SESSION_JWT_SECRET` carrying `sub:"not-a-uuid"` → **401**, body `unauthorized`; `grep -c` for `22P02|internal_error|Internal server error` over the whole log = **0**. Control (well-formed uuid, no such user) also 401.
- **PR-7** — built the image at HEAD: `uid=1000(node)`; `/app`, `/app/src`, `/app/node_modules` are `root:root drwxr-xr-x`; `touch /app/src/EVIL.ts` → `Permission denied`; `/tmp` and `$HOME=/home/node` writable (tsx needs them); container boots, probes storage, answers `GET /api/me` → **401**. Contrast image built from `7035141:server/Dockerfile`: `uid=0(root)`, and `touch /app/src/EVIL.ts` **succeeds**. **ASSUMPTION 8 reproduces in both clauses.**
- **R2-4** — production-shaped boot with no `sslmode`: `EXIT=1`, refusal names the exact edit, **binds no port**, and `grep -c` for the URL password = **0**. Same shape with `?sslmode=require`: passes the TLS check and reaches the storage probe, which is downstream. Both as claimed.
- **§0's R2-1 re-exercise** — `docker exec kept-minio ls /data` → `kept`. No bucket conjured.

## 4 · The explicit checklist

| Check | Finding |
|---|---|
| Fabricated / unreproducible findings | **None.** All eight frozen findings reproduce against live source or a live process. |
| Citations that do not say what they are claimed to say | **Three.** F-1, F-2, F-3 below. All ledger `file:line` citations re-resolve correctly at `7035141` (I checked `index.ts:96-101`, `requestLog.ts:22-24`/`:66`, `receipts.ts:415-423`, `exports.ts:125-128`/`:147-153`, `session.ts:52`, `client.ts:11`/`:57-59`, `Dockerfile:27`, `productionEnv.ts:51-57`/`:59-65`, `objectKeys.ts:116-126`). |
| Severity inflation / deflation | **None I would move.** PR-9(a)'s P2 defence at `:288-296` is now present and sound; R3-2's P1 argument is stated and correctly resolved down. |
| Smuggled features | **None.** No new route (`grep` for added `router.(get\|post\|patch\|delete\|put)` in the range → 0), no new `process.env` read, no schema or migration change (`server/drizzle`, `src/db/schema.ts` untouched), no dependency change. |
| Prohibited actions, anywhere in range | **None.** |
| iOS files touched, anywhere in range | **Zero.** `git diff --name-only 7035141..HEAD -- ios/` → 0. |
| Anthropic call, anywhere in range | **None.** No file under `src/parse/`, `llmBackfill.ts`, `llmParseProbe.ts`, `llmPromptReparse.ts` or the sweep is in the diff. The only `anthropic` hits are prose and one pre-existing test fixture. |
| Fixes that relocated a bug | **None — the opposite.** PR-4 deliberately departs from `assertIssuedObjectKey`'s throw, and mutation 4 measures that a throw really does 500 the whole history list. Verified, not argued. |
| Error handling that hides errors | **None in shipped code.** The one candidate, `requiresTls`'s `catch { return false }` (`databaseUrl.ts:97-101`), is preceded by `databaseIdentity` at `productionEnv.ts:65`, which throws on an unparseable URL — I confirmed the ordering and the throw. See F-7 for the one soft spot. |
| Verification that does not exercise the changed path | **None.** All ten new tests die under mutation; six of the eight fixes are additionally verified against a real process or a real container. |
| Resolved without an artifact | **None among the eight §7 rows** — I reproduced all eight myself. One *other* claim is unbacked: F-4. |
| Defects introduced across pass boundaries | **One: F-1.** Pass 4's commit `e01be63` falsified a docstring eight lines below its own edit and left it standing. |
| Stage 0 assumptions later contradicted | **None.** ASSUMPTION 8 was the one at risk (RV3-A) and is now earned — I rebuilt and re-ran it. |
| Work expanding past the frozen list | **None.** The list held at 8. PR-8 was struck on scope and recorded as RULING 8 rather than implemented — the correct call, and the one place a builder would have been tempted to add an endpoint. |
| Drift toward scope expansion over time | **None.** The last five commits are progressively narrower. |

## 5 · Ledger arithmetic and house style — recounted against the ids actually present

- Carried in: **18** — PR-4, PR-5, PR-6, PR-7, PR-8, PR-9, PR-10, PR-11, PR-12, PR-13 (10), N-1…N-5 (15), R2-2, R2-3, R2-4 (18). Cross-checked against `PROD-READINESS-ROUND-2.md:475`, which lists the same 18. ✓
- New: **2** (R3-1, R3-2). Total **20**. Frozen **8**. Carry **12**. All consistent. ✓
- §7 table: 8 + 9 + 3 = **20**, and PR-9(b) is correctly excluded with the reason stated. RV3-B is genuinely fixed. ✓
- §6 rulings: 7 carried + 1 new = **8** rows. ✓
- §10 passes: 4 + 1 + 1 + 2 = **8** commits, one per frozen finding, and `git log` confirms one commit per source file. ✓
- §0 "three re-measured" (RV3-C) and §9 "exactly one had drifted" (RV3-D) are both now correct. ✓
- **One-sentence-per-line:** `PROD-READINESS-ROUND-3.md` **0 violations**, `reviews/round3/BASELINE.md` **0**. (`PROD-READINESS-ROUND-2.md` has 33 by the same checker.) RV3-J was actually remediated. `reviews/round3/REVIEW-0.md` has 15, but it is a verbatim transcript of a reviewer's text.
- **Em dashes on added lines: 2**, one of which is a real violation. See F-5.

---

## 6 · Findings

**F-1 · P2 · `e01be63` falsified the docstring eight lines below its own edit and left it standing**
`server/src/db/client.ts:88-90` still reads: *"Each attempt carries its own timeout because the pool has none: the pool is built with `connectionString` alone, so `connectionTimeoutMillis` is 0 and a connect against a black-holed host would otherwise hang here forever."*
At HEAD all three clauses are false. The pool **has** a connect timeout; it is **not** built with `connectionString` alone (`client.ts:38-42` now passes `connectionTimeoutMillis: CONNECT_TIMEOUT_MS`); and the value was never `0` — REVIEW-0 RV3-I established that, and the ledger corrects it explicitly at `:280-283` (*"The frozen version of this row said the value 'becomes 0'. It does not; nothing coerces it."*). The correction was applied to the ledger and not to the source file the same commit was editing.
This is the round's own hunt lens (§0, `:57-72`: *"where does a sentence in this repository describe behaviour the code does not have?"*) fired at the round's own commit — the identical shape as R3-1 and R3-2, which this round graded P2. The consequence is real but bounded: this docstring is the **stated justification** for `assertDatabaseReachable` carrying its own `withTimeout` race, and it now argues from a premise a reader can disprove in one line. A future reader could remove the race believing the pool is unbounded when it is bounded — at 10 s per checkout, without the retry semantics the probe needs for a waking Neon compute.
**Recommend:** rewrite `client.ts:88-90` to say the pool now bounds a connect at `CONNECT_TIMEOUT_MS` and that the probe's per-attempt race exists because a checkout has nothing to retry into — which is the argument `client.ts:24-27` already makes correctly.

**F-2 · P2 · The measurement cited as proof for R2-4 does not discriminate between the defect and the fix**
`PROD-READINESS-ROUND-3.md:323-324` quotes `new Pool({connectionString:'postgres://…'}).options.ssl` → `ssl: undefined`, repeated at `:41`, and restated as fact in two code comments: `server/src/productionEnv.ts:78-80` (*"Measured: a postgres:// URL with no sslmode yields `pool.options.ssl === undefined`, and the connection goes out in the clear"*) and `server/src/db/databaseUrl.ts:81-83`.
Measured by me against the installed `pg`, `pg.Pool` does not parse the connection string at all — it defers to `Client` at connect time. **Every** URL yields `pool.options.ssl === undefined`, including `?sslmode=require`, `?sslmode=verify-full` and `?ssl=true`:

```
(none)            -> pool.options.ssl = undefined
?sslmode=require  -> pool.options.ssl = undefined
?ssl=true         -> pool.options.ssl = undefined
```

The cited measurement is therefore reproduced identically by a configuration this round considers correct. It proves nothing about TLS.
**The conclusion is still right** — I confirmed it at the layer that decides, `client.connectionParameters.ssl`: no `sslmode` → `false` (cleartext); `?sslmode=require` → `{}` (encrypted). The finding and the fix stand; the evidence does not.
**Recommend:** replace the `Pool` measurement in all three places with the `Client` one, which discriminates.

**F-3 · P2 · The refusal of `prefer` and `allow` rests on a claim that is false of the installed `pg`**
`server/src/db/databaseUrl.ts:86-91`: *"The accepted spellings are libpq's, **which is what `pg` parses**: … `prefer` and `allow` are deliberately NOT accepted - both fall back to cleartext when the server declines."*
`pg-connection-string@2.14.0:77` sets `config.ssl = {}` whenever **any** `sslmode` is present, and only `disable` clears it. Measured at `Client` level: `?sslmode=prefer` → `ssl: {}`, `?sslmode=allow` → `ssl: {}`. Under `pg` as installed, both **encrypt and fail closed** if the server declines; they do not downgrade. pg's own runtime deprecation warning says libpq semantics arrive in `pg-connection-string` v3 / `pg` v9 — i.e. the docstring describes a future library, not this one. The same claim is repeated at `server/tests/unit/productionEnv.test.ts:91-93`.
Consequence: three spellings that **do** encrypt today are refused at boot with a message saying they do not require TLS — `?sslmode=prefer`, `?sslmode=allow`, and `?ssl=1` (which `pg-connection-string:69-71` honours identically to `ssl=true`, and which `requiresTls`'s `=== "true"` at `databaseUrl.ts:106` rejects). The direction is conservative and there is **no false accept** — I checked every spelling, and nothing `requiresTls` returns `true` for connects in cleartext — so this is not a security hole. But it is a boot-blocking refusal whose written justification is wrong about the library it names, in a round whose thesis is that exact defect.
**Recommend:** state the refusal as forward-compatibility with libpq semantics (which is defensible and is what pg's own warning advises), not as current `pg` behaviour; and accept `ssl=1` alongside `ssl=true`.

**F-4 · P2 · A ledger claim with no artifact, and the doc-ownership rule is unsatisfied at HEAD**
`PROD-READINESS-ROUND-3.md:165`: *"The 2026-08-10 DECISIONS entry stays exactly as written, and **this round's own entry records the change forward**."* Stated in the present tense, as the accomplished half of the argument for not editing the historical entry.
There is no round-3 entry. `git log 7035141..HEAD -- docs/DECISIONS.md` returns **nothing**; the file's newest heading is `## 2026-08-11 - Production-readiness round 2`. `docs/Kept-Build-Spec.md` **was** amended, alone, in `697213b`.
`CLAUDE.md`'s doc-ownership rule says *"Neither is optional and neither substitutes for the other"*, and round 2's own entry records that it honoured the pairing *"with its spec amendment in the same commit"* (`868d796`). Round 3 amended the spec in a fix commit and has not paired it. This is the same class as RV3-A, which REVIEW-0 caught on ASSUMPTION 8 and the builder repaired — recurring here, unnoticed, into the final state.
Mitigating: round 2's entry landed in `868d796`, *after* its final-review commit `c2061ce`, so by precedent the entry may be scheduled for after this review. That does not rescue the sentence at `:165`, which asserts it as already done.
**Recommend:** append the round-3 `DECISIONS.md` entry (newest-first, dated 2026-08-11) before the round closes, and either restate `:165` in the future tense or write it after the entry exists.

**F-5 · P3 · An em dash on a line the stage added**
`docs/Kept-Build-Spec.md:581` went from 3 em dashes to 4. The new one is in the builder's own new sentence: *"…logged identical lines **—** which is the one distinction 'the app says it can't sync' turns on."* `CLAUDE.md` forbids the character outright.
REVIEW-0's RV3-J recorded zero em dashes and was correct for its range (`7035141..e7548ba`); the spec amendment landed two commits later, so nothing has looked since. The ledger's §4 claim covers rounds 1 and 2 only and does not assert round 3 is clean, so the ledger is not wrong — only the output is.
The second em dash in the diff is inside a backtick-quoted `grep` pattern in `reviews/round3/REVIEW-0.md`, a verbatim transcript. Not a violation.
**Recommend:** replace with a plain hyphen.

**F-6 · P3 · Eight of the nine recorded falsification line citations are stale**
Every new test records *"Actual: … at :NNN"*. I ran all nine mutations; the **substance is accurate in all nine** — the right assertion fires, with the message as transcribed. The line numbers are not:

| Test | Recorded | Actual |
|---|---|---|
| `auth.test.ts` | `:118` | `:119` |
| `session.test.ts` | `:89` | `:92` |
| `softDelete.test.ts` | `:85` | `:87` |
| `export.test.ts` (PR-4) | `:661` | `:663` |
| `export.test.ts` (RV3-E) | `:697` | `:701` |
| `logHygiene.test.ts` | `:355`, `:356` | `:362`, `:363` |
| `startupProbe.test.ts` | `:244` | `:248` |
| `productionEnv.test.ts` | `:97` | `:101` |
| `dbClient.test.ts` | `:211` | `:211` ✓ |

Consistent with the falsification runs preceding the explanatory comments that shifted them. §9 claims *"every line number in this ledger was re-resolved by hand rather than copied"*, and §7 `:517` extends that discipline to *"predicted-versus-actual recorded in the test file"*. These were not re-resolved.
**Recommend:** re-resolve the eight, or drop the line numbers and keep the assertion text, which is what actually identifies the failure.

**F-7 · P3 · PR-4's log line is the load-bearing half of its own severity argument and no test pins it; the ledger also misdescribes it**
`PROD-READINESS-ROUND-3.md:220` says *"`downloadUrlFor` … logs the refusal through `errorSummary`"*. It does not: `server/src/routes/exports.ts:179-182` is a plain `console.error` with a template literal. (The code is right — there is no error object to summarise — the ledger is wrong. `errorSummary` is used at `:112`, a different site.)
More substantively, `:221-222` and the docstring at `exports.ts:157-165` rest the whole choice of `return null` over `throw` on the log line: *"the load-bearing half of `objectKeys.ts`'s 'fail the request loudly and leave a log line' is the log line, not the status code… the refusal is unconditional and the log line is unconditional."* No test asserts it — `grep -rn "did not issue" server/tests/` returns nothing. Both new export tests assert only `downloadUrl === null`, which passes just as well with the `console.error` deleted. That is the one edit that would turn an explicit refusal into a silent null, in a repository that maintains `logHygiene.test.ts` for exactly this class.
**Recommend:** add one assertion on the refusal line (the pattern already exists in `logHygiene.test.ts`'s `captureConsole`), and correct `:220`.

**F-8 · P3 · The fifth gate is not recorded at HEAD**
`reviews/round3/BASELINE.md:130` commits the round to it: *"The entrypoint gate above is re-run before the round closes."* `PROD-READINESS-ROUND-3.md:511` names only the four. `CLAUDE.md` requires the fifth of *every* gate.
Satisfied in substance — five of the eight §7 artifacts are live boots of the real entrypoint, and I re-ran the gate at HEAD myself (boots on 3055, storage probe line, no-key notice, `Kept API listening`, `GET /api/me` → 401 with `cache-control: no-store`). This is a recording gap, not a defect.
**Recommend:** add the fifth gate to `:511`.

---

## 7 · What I want to say for the record

The eight frozen findings are real, correctly graded, correctly scoped, and each is closed by one commit with a test that dies when the behaviour is removed. I mutated every one rather than reasoning about it, and the two that the builder said failed in an unexpected way — PR-9(a)'s 40-second hang and R3-1's earlier-firing assertion — failed in exactly the unexpected way recorded. The `captureRequest` regression the builder caught in themselves reproduces precisely when I re-introduce it. PR-4's departure from its sibling is not a rationalisation: mutation 4 measures the 500 that a throw would produce on the list route. That is the strongest verification trail this project has produced.

The findings cluster in one place, and it is worth naming: **five of the eight are prose that does not match code** — a docstring the round's own fix invalidated (F-1), a measurement that is not evidence (F-2), a library claim about the wrong library version (F-3), an artifact asserted before it exists (F-4), and a fix described using a function it does not call (F-7). This round's entire method was built on hunting that shape in other people's code, and it shipped five instances in its own. None is a runtime defect. All are cheap.

---

**PASS-WITH-FINDINGS**

The stage may proceed. All four gates plus the entrypoint gate reproduce or improve; every frozen finding is real, reproduced, and closed by a test that cannot pass without the fix; the arithmetic recounts correctly against the ids actually present; the one-sentence-per-line rule is clean in both files the stage authored; no iOS file, no Anthropic call, no prohibited action, no smuggled feature, and no bug relocated rather than removed.

Before the round closes, remediate **F-1** (the docstring `e01be63` falsified), **F-4** (append the `DECISIONS.md` entry and fix the claim at `:165`), and **F-2**/**F-3** (the two measurements and the library claim that do not say what they are cited as saying). **F-5** through **F-8** are corrections to fold into the same edit, not blockers.
