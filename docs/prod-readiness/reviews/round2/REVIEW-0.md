# REVIEW-0 (round 2) - adversarial review of the round-2 ledger

verdict: **PASS-WITH-FINDINGS**

Range reviewed: `b23ea08..2f36fbd`, one commit, branch `prod-readiness/round-2`.
Stage contents: `PROD-READINESS-ROUND-2.md` (+385) and `reviews/round2/BASELINE.md` (+150).
No source file, no test, no configuration file, no `ios/` file is touched by this stage.

I treated every sentence in both files as an unverified claim.
Nothing in the ledger's narration was accepted as evidence.
I re-ran the gates, re-checked the citations against the files line by line, re-executed the reproductions, and falsified the tests the stage leans on.
Working tree was clean before this review and is clean after it (`git status --porcelain` empty at both ends); the only file I add is this one.

---

## 1 · Gates, re-run against `reviews/round2/BASELINE.md`

| Gate | BASELINE claims | I measured | Verdict |
|---|---|---|---|
| `npm test` | 30 files / 276 passed, 0 failed, 0 skipped | 30 files / **276 passed**, exit 0, 18.41 s | reproduces |
| `npm run typecheck` | exit 0, no output | exit 0, no output | reproduces |
| `npm audit` | 6 moderate | **6 moderate** | reproduces |
| `npx drizzle-kit check` | "Everything's fine", exit 0 | identical | reproduces |
| Production entrypoint, guardrail 7 | 401 + `cache-control: no-store` on `/api/me`, with a request-log line | identical, on my own ports 3021/3022/3023 | reproduces |
| Node / npm | v24.15.0 / 11.12.1 | same | reproduces |

The BASELINE's own conclusion - "there is no P0 for the baseline does not reproduce" - is correct.

Every server I started used a copy of `server/.env.local` with the `ANTHROPIC_API_KEY` line stripped, and each printed `ANTHROPIC_API_KEY is not set` at boot, which is the entrypoint's own witness that `llmParseSweep.kick()` at `src/index.ts:104` was never reached.
Port 3000 was checked once with `lsof` and left alone; pid 31468 (started Sat 8 Aug 15:16:44 2026) is alive and untouched, which also confirms the ledger's ASSUMPTION 3 to the minute.

---

## 2 · The mandated checks, each answered

**Fabricated or unreproducible findings.**
**Checked, clean.**
I reproduced every finding the ledger claims to have reproduced, independently, and each came out as described.
R2-1: a server started against `postgres://kept:WRONG-PASSWORD@localhost:5432/kept` printed `Kept API listening on port 3021`, held the port, and answered `401` with `cache-control: no-store` to `GET /api/me`; a request carrying a token signed with the real secret then produced `status=500` and the server log `Unhandled error: DrizzleQueryError [message and detail withheld] / caused by DatabaseError [message and detail withheld] code=28P01 routine=auth_failed`.
That is the ledger's block, line for line, including the SQLSTATE and routine.
PR-4: reproduced end to end rather than by inspection - I planted a `complete` export job in the disposable `kept_test` database whose `object_key` was `exports/00000000-0000-4000-8000-000000000000/<jobId>/Receipts-2026.zip`, and `GET /api/export/:id` answered **200** with `downloadUrl` = `http://.../kept/exports/00000000-0000-4000-8000-000000000000/...`, naming another user's prefix, exactly as claimed.
I removed the rows I planted afterwards.
PR-12: `sub: "not-a-uuid"` signed with the server's own secret produced `500 internal_error` and `code=22P02 routine=string_to_uuid`.
N-2: reproduced with no API call - `caused by SyntaxError: Unexpected token 'D', "Dr Smith P"... is not valid JSON`, and `redactedMessage` returned `"Model response was not parseable JSON"` with no cause chain; the zod branch leaked none of `Dr Smith Pharmacy`, `811234567RT0001`, `amoxicillin`, `113.00`, so the ledger's narrowing of N-2 to the `JSON.parse` branch is correct.
R2-2: measured against the real `writeCsv` - `=1+1`, `+1+1`, `-Rogers Communications`, `@SUM(A1:A2)` all emerge unquoted; and `writeXlsx` stored every one of them as `type=3` (String), so the "XLSX is not affected" half is also true.
R2-3: `docker run --rm --memory=2g node:24-slim` reported `heap_size_limit MiB: 1120` and `totalmem MiB: 7935.93`, both of the ledger's numbers, exactly.

**Citations that do not say what they are claimed to say.**
**Two findings**, R0-1 and R0-2 below, plus a short list of imprecisions in §6 that do not rise to findings.
I checked roughly forty file:line citations against the files at `b23ea08`.
The large majority are exact, including all of `index.ts:32-40/48/66-75/78/104`, `productionEnv.ts:4-33/34-83`, `db/client.ts:11`, `sessionAuth.ts:28-30/40/43`, `exports.ts:127/142/150-153/49/209-239`, `receipts.ts:143-152/285/415-423`, `session.ts:52`, `schema.ts:156-158/187-189`, `errorSummary.ts:79-85/112-118` (with `MAX_CAUSE_DEPTH = 5` at `:61`), `writeFiles.ts:87-93`, `generateExport.ts:40-42/117/191-211/258-264/280-299`, `s3ObjectStorage.ts:149-162/176-184`, `requestLog.ts:62`, `exportFilename.ts:42-52`, `fiscalPeriod.ts:47-58`, `app.ts:87-90`, `databaseUrl.ts:41-47`, `Dockerfile:16-18/19/27`, `fly.toml:13-21`, `drizzle.config.ts:9`, and all five `new Pool` sites in N-1.
The verbatim quote of `docs/gates/wave-6.md:137` is verbatim, and `docs/Runbook.md:77` says what the ledger says it says.
N-1's exactness claim holds under my own `grep -rn "new Pool" src`: exactly those five scripts plus `db/client.ts`, and `llmBackfill.ts:46` does route through `createDb`.

**Severity inflation or deflation against the rubric.**
**Checked, clean, with one endorsement stated in my own words.**
R2-1 at P1 is defensible and I would not deflate it - see §5.
No finding on the ledger is graded above what its evidence supports, and the one movement recorded (PR-5 proposed for P1, withdrawn back to P2) resolves *against* the round's interest in having work to do, which is the opposite of inflation.

**Smuggled features.**
**Checked, clean.**
The stage contains no code.
`git diff --name-only b23ea08..2f36fbd` returns two Markdown files; `git diff --stat b23ea08..2f36fbd -- ios server web docs` returns nothing.
No endpoint, screen, command, flag, table, column, config key or dependency.

**Prohibited actions.**
**Checked, clean.**
`git reflog` shows a checkout to a new branch and one ordinary commit; no rebase, reset, amend or force.
There is no git remote at all.
`main` is still at `ca82907` and neither round-1 nor round-2 branch is merged.
Nothing in the stage rotates, revokes or deletes a credential, and nothing deletes a file.

**iOS files touched.**
**Checked, clean.**
Zero, in the diff and in my own reading; I did not read `ios/` for findings either.

**An Anthropic API call.**
**Checked, clean, to the limit of what is observable.**
The stage adds no code that could call it, the two committed files contain no model output, and every process this review started logged `ANTHROPIC_API_KEY is not set`, which is `src/index.ts:97-102`'s branch and proves `kick()` was not reached.
I did not run `parse-llm-backfill`, `parse-llm-probe` or `parse-llm-reparse`, and I reproduced N-2 from a locally constructed `SyntaxError` and a locally constructed `ZodError`.
The ledger's ASSUMPTION 2 and CANNOT ASSESS §2 quarantine this correctly.

**Fixes that relocated a bug rather than removed it.**
**Not applicable, stated explicitly.**
The stage fixes nothing; it is a ledger.
Round 1's four fixes were re-checked as artifacts instead - see the falsification table in §3.

**Error handling that hides errors.**
**Checked, clean.**
No error handling changed.
I read every `catch` in `server/src` anyway, since the ledger's §7 skips pass 2 on the strength of one measurement.
All of them are narrow: `session.ts:61-68` and `schemas.ts:40-45` and `llmSuggestions.ts:149-154` rethrow anything that is not the expected type; `validate.ts:27` and `receipts.ts:491` convert a parse failure into the 400 it is; `runExportJob.ts:49-63` records the redacted message on the job row *and* rethrows; `exports.ts:109-113` logs through `errorSummary` at the one place a rethrow has nowhere to go.
Nothing swallows signal.

**Verification that does not exercise the changed path.**
**Checked, clean.**
The "changed path" here is prose, and the ledger's method is to verify against live source and running processes rather than against round 1's copy.
The BASELINE ran the real entrypoint the real way before any claim, which is this project's guardrail 7, and I reproduced that independently on three ports.

**Anything marked resolved without an artifact.**
**Checked, clean.**
The BASELINE marks four round-1 findings "Holds".
I did not accept any of the four; I re-derived each from an artifact, and two of them by deleting the behaviour - see §3.

---

## 3 · Tests: would they still pass if the behaviour they verify were deleted?

The stage adds no test.
It cites four round-1 artifacts as spot-checks, and the ledger's §7 promises pass 7's test ships with the fix.
This project has shipped six assertions that could not fail, so I falsified the two cited tests rather than reading their comments.

I built a complete copy of `server/src`, `server/tests`, `drizzle`, the vitest config and the tsconfig in my scratchpad, with `node_modules` symlinked, and mutated **the copy**.
No repository file was edited at any point.

| Cited artifact | Behaviour deleted in the copy | Result | Can it fail? |
|---|---|---|---|
| `tests/integration/dbClient.test.ts`, 3 tests (PR-1) | `pool.on("error", ...)` removed from `src/db/client.ts:30-32` | **3 failed / 3**, plus the uncaught `57P01` vitest reports beside them | **YES** - and the child-process design is what makes it so; the exit-code assertion cannot be intercepted by vitest's own handler |
| `tests/integration/export.test.ts:231` (R-1) | Only the **order** of the two remedies swapped in `generateExport.ts:191-211`; same receipt id, same phrases, no "re-attach" | **1 failed** - `AssertionError: expected 143 to be greater than 222` at `:273` | **YES** - it fails on an order-only mutation, which is the tightest form of the behaviour it claims to pin |
| PR-2 redaction (no test cited; a live claim) | not mutated; re-derived | my own wrong-password run logged `DrizzleQueryError [message and detail withheld]` / `code=28P01 routine=auth_failed` | artifact, reproduced |
| PR-3 request log (no test cited; a live claim) | not mutated; re-derived | `{"msg":"request","method":"GET","route":"/api/me/*","status":401,"durationMs":4,"authenticated":false}` from the real entrypoint | artifact, reproduced |

Both cited tests are falsifiable.
Neither is a seventh unfailable assertion.
The negative assertions in `export.test.ts` (`not.toContain(userId)`, `not.toMatch(/re-attach/i)`) are non-vacuous because the positive `expect(job.error).toContain(receiptId)` above them establishes that `job.error` is a non-empty string first.

For the fix that pass 4 will ship, the standing bar: R2-1's test must fail when the probe is deleted, and it must be written so that a probe which merely constructs a pool passes nothing - the assertion has to be that the process **exits** against an unreachable database, which by the same argument as `poolSurvivalChild.ts` is only honestly observable from outside the vitest worker.

---

## 4 · The ledger, finding by finding

### R2-1 · P1 · startup config is never proved against the services it names

Citations exact, all six.
Reproduction reproduced, including the exact SQLSTATE and routine.
The verbatim quote of the deploy's success criterion at `docs/gates/wave-6.md:137` is verbatim, and `docs/Runbook.md:77` is quoted fairly, including the ledger's concession that the Runbook's own sentence is true.

One fact strengthens R2-1 beyond what the ledger claims, and I record it because the builder should have it: with `server/.env.local` as it stands, `STORAGE_*` **is** set, so `configuredStorage !== null` and the probe at `src/index.ts:66-75` does not run **even in local development**.
Nothing in any environment this repository can produce touches object storage before `serve()`.
The ledger says "a production `STORAGE_*` configuration is never touched"; the true statement is that no `STORAGE_*` configuration is ever touched.

Severity: **P1 is correct and I decline the deflation the ledger offers.**
My reason is narrower than the ledger's and does not depend on how likely a mistyped secret is: the project's own documented deploy verification, written in two places and repeated at a third (`wave-6.md:137` step 10, step 13, Runbook §3), is **satisfied by a machine that cannot reach its database**, and I reproduced that.
A verification procedure that returns green on a broken system is worse than no procedure, because it converts an operator's attention into false confidence.
Not P0: no receipt is lost, no isolation boundary moves, the deploy completes, and the failure is loud at the first authenticated request.

Fix scope: in scope, with one constraint the ledger does not state.
The `HeadBucket` probe must **not** add a `head` to the `ObjectStorage` interface - RULING 1 reserves exactly that decision for the owner, and the ledger's own R2-1 text proposes a HeadBucket in the same document.
There is no conflict only because `createBucketIfMissing` is already a module-level function in `s3ObjectStorage.ts` that the entrypoint imports directly, so a sibling `assertBucketReachable(config)` is the in-scope shape and an interface method is not.
Say so in the fix, or the two sections read as contradicting each other.

### PR-4 · P2 · export zip keys not re-validated on read

Citations exact.
Reproduced end to end by me against the real server, not by inspection.
The "unfulfilled ruling" framing is fair and understated: `storage/objectKeys.ts:99-115` states the ruling in its own docstring ("The same check on the way *out* of the database, before a stored key is turned into a presigned URL **or a download**"), and this is the site that does not honour it.
P2 holds: reaching it needs direct database write access, and I confirmed the ledger's supporting claim - `runExportJob` writes `objectKey` only from `exportObjectKey(job.userId, job.id, ...)`, `periodLabel`'s inputs are `isoDateSchema`-validated at `schemas.ts:227-228`, and nothing client-supplied reaches the column.

### PR-5 · P2 · no SIGTERM handling

`grep -n "SIGTERM\|SIGINT\|server.close" src/` returns nothing; confirmed.
The withdrawal of the P1 elevation is sound reasoning and I follow it: the 409 branch is the branch where the row committed, and a committed row reaches the client on the next list fetch, so no receipt is at risk in either branch.
Recording a severity that was raised and then withdrawn is the right call and is worth more in the log than one never tested.

### PR-6 · P2 · severed-but-committed create is not replayable

Citation exact.
Correctly routed to RULINGS rather than fixed, since the answer depends on `ios/`, which is out of scope.
The fact round 2 adds - the receipt is already stored when the 409 arrives, so the client's move is to reconcile, not re-send - is correct and is the useful half.

### PR-7, PR-8, PR-10, PR-13 · P2 · deploy and config

All four citations exact (`Dockerfile:27` is the last instruction and there is no `USER`; `fly.toml:13-21` has no `http_checks` and no `checks`; `drizzle.config.ts:9` is the localhost fallback; `Dockerfile:19` is `npm ci --include=dev`).
Severities defensible.
PR-8's sharpening by R2-1 is the honest observation in this group: the TCP check and the `curl` check pass on the same broken machine.

### PR-9 · P2 · pool timeouts - **see finding R0-1, the claim is wrong**

The body's one defended clause is right; the headline is not.
Detail in §6.

### PR-11 · P2 · image soft-delete has no tombstone guard - **see finding R0-2, the supporting citation is wrong**

The finding itself is real: `receipts.ts:415-423` carries no `deleted_at IS NULL`, and the guarantee does rest on caller ordering.
The line cited for that ordering is not the line that does it.

### PR-12 · P2 · `sub` is not validated as a UUID

Citation exact, reproduction reproduced, including the response body.
P2 is right: it is unreachable without the signing secret.

### N-1 · P2 · five dev scripts carry PR-1's defect

Exact, all five, and the exclusion of `llmBackfill.ts` is exact too.
I confirmed `verifyRestore.ts:58-59` also routes through `createDb`, so "five" is the complete set.

### N-2 · P2 · the parse sweep's model branch leaks ~10 characters

Citations exact, both branches measured by me, and the narrowing is correct.
The strongest sentence in this entry - "`redactedMessage` returns the message with no cause chain, so nothing leaks into stored data or into a client response" - I verified directly.
This is the entry where the round measured something *smaller* than round 1 feared and said so.

### R2-2 · P2 · new · CSV formula injection

Citation exact, both halves measured by me, and the reason for not fixing it is a genuine product trade rather than an excuse: the `'` prefix is what accounting software would then import, and spec §8 line 444 (verified, verbatim) makes the CSV the import artifact.
P2 is right: the XLSX is what an accountant opens and it is unaffected.
Routing the remedy to RULINGS is the correct disposal.

### R2-3 · P2 · new · 2 GB is argued in RSS, the binding limit is V8 old-space

Citation nearly exact (see §6), measurement reproduced exactly (1120 MiB), reasoning sound.
P2 is right and the ledger's own reason is the right one: reproducing an 891 MiB export here would measure this laptop.

### N-3, N-4, N-5 · P3

All three re-verified.
`requestLog.ts:62` reads `c.req.routePath`; `isMissingObject` (`generateExport.ts:258-264`) does duplicate the shape of `isNotFound` (`s3ObjectStorage.ts:176-184`); `schema.ts:187-189` is the partial unique index N-3 describes.

---

## 5 · What the ledger says is *not* a defect, and whether the hunt was adequate

I re-derived the NOT DEFECTS rather than reading them.

- **Fiscal periods are contiguous.** Confirmed by running `fiscalPeriodEndingIn` over 2023-2027 for year ends 12/31, 3/31, 2/29, 2/28, 6/30 and 1/1: no gap and no overlap anywhere, and 4/31 and 2/30 are rejected by `isValidFiscalYearEnd`. The Feb 29 numbers the ledger prints are exactly right, including that a 2/28 year end puts 2024-02-29 at the *start* of the next period rather than in a hole. A receipt absent from every export would be top-of-scale, and it cannot happen this way.
- **Error responses carry `Cache-Control: no-store`.** Confirmed in the strongest form, which the ledger only argues from `compose.js`: I checked the header on a **500 produced by a throwing handler**, and it is present. Also on the 404 and the 401.
- **Nothing pending reaches an export.** Confirmed at `db/receiptQueries.ts:33` (`eq(receipts.status, "confirmed")`) with `visibleTo` adding `isNull(receipts.deletedAt)`.
- **No migration or schema drift.** `drizzle-kit check` clean, exit 0.
- **The destructive dev scripts are guarded.** `seed.ts:14-18` and `claim.ts:19-23` call `assertLocalDatabase` before constructing a pool; `databaseUrl.ts:41-47` normalizes the loopback spellings.
- **`.env.local` untracked, gitleaks hook fail-closed.** Confirmed.
- **The abandoned archiver.** I did not re-run this one outside vitest; the ledger's measurement is described with enough specificity to be checkable and nothing I read contradicts it. Flagged as the one NOT DEFECT I accepted on the ledger's own artifact rather than re-derived.
- **X-3 from round 1** (`PROD-READINESS.md` carries NUL bytes and `grep` refuses it) is not carried into round 2, and it is right not to be: both ledgers and both baselines now contain **zero** NUL bytes and `grep -c` reads all four. Closed by artifact, though the ledger does not say so.

**Was the hunt adequate?**
Largely yes, and the frozen list of exactly one P1 is honest rather than lazy.
The evidence for good faith is structural: the one severity that moved during Stage 0 moved *down*, with the argument that killed it written out in full; N-2's blast radius was measured and came out smaller than round 1 believed, which cost the round a finding; and two new P2s were added that nobody asked for.
A builder minimising work does not write §0.

Two qualifications.

First, the re-verification pass is not as thorough as the ledger says it is.
"Every round-1 citation re-checked to the line" is true of the line numbers and false of at least one central *claim*: PR-9's headline survived into round 2 without anyone measuring the library it describes (R0-1), and PR-11's supporting citation points at the wrong lines (R0-2).
Both are the failure mode this project keeps naming - inheriting a sentence instead of re-deriving it.

Second, the round's own lens has an unfired barrel.
The lens is "the check asks whether the value is well-formed and never whether it is right", applied to three subjects.
Applied a fourth time, to `productionEnv.ts` itself, it produces R0-3 below: the file demands `STORAGE_ENDPOINT` be https on the explicit reasoning that receipt bytes would otherwise cross the network in cleartext, and asks nothing equivalent of `DATABASE_URL`, over which the rest of the receipt record travels.
The ledger enumerates all five of that file's checks and does not notice the sixth is missing.

Neither qualification changes the frozen list.
All three of my findings are P2 and route to the ledger's documented set, not to a fix pass.

---

## 6 · Findings

### R0-1 · P2 · PR-9's headline claim is false on two of its four clauses, and was re-asserted this round as re-verified

`PROD-READINESS-ROUND-2.md:161` reads: "The pool has **no connection, statement, or idle timeout and no size cap**".
Measured against the installed library:

```
$ node -e "const {Pool}=require('pg'); const p=new Pool({connectionString:'...'}); ..."
pg version: 8.22.0
max: 10
idleTimeoutMillis: 10000
connectionTimeoutMillis: undefined
statement_timeout: undefined
maxUses: Infinity
```

`pg` defaults `max` to **10** and `idleTimeoutMillis` to **10 000 ms**.
So "no idle timeout" and "no size cap" are both wrong; "no connection timeout" and "no statement timeout" are both right.
The body of the entry only defends the connection-timeout clause (`connectionTimeoutMillis` unset, which pg-pool treats as 0 = wait forever - confirmed), so the false half is carried entirely by the heading.

Why it matters rather than being pedantry: `§1` states that each carried finding "was re-verified at `b23ea08`", and R2-1's fix reasoning cites PR-9 by name as load-bearing.
A round-3 builder acting on PR-9 as written would add a size cap and an idle timeout that already exist, and would take the entry's accuracy on trust for the two clauses that are real.

P2, not P1: nothing fails in production because of this sentence, and the clause R2-1 actually leans on is the correct one.
Fix: correct the heading to "no connection timeout and no statement timeout; `max` and `idleTimeoutMillis` take pg's defaults of 10 and 10 s", and say the defaults were measured against `pg` 8.22.0.

### R0-2 · P2 · PR-11's citation for the short-circuit points at the 404, not at the guard

`PROD-READINESS-ROUND-2.md:171` reads: "It cannot overwrite an older tombstone today only because the receipts update above returns zero rows first and short-circuits at `:426-428`."

`server/src/routes/receipts.ts:426-428` is:

```
    if (deleted.length === 0) {
      throw notFoundError();
    }
```

That is the 404 response, **outside** the transaction, and it stops nothing - by the time it runs, the image update has already had its chance.
The guard that actually prevents the image update from touching an older tombstone is `:409-411`, **inside** the transaction:

```
      if (rows.length === 0) {
        return rows;
      }
```

and it works because `visibleTo(userId)` (`db/receiptQueries.ts:10-12`) is `and(eq(receipts.userId, userId), isNull(receipts.deletedAt))`, so an already-tombstoned receipt updates zero rows.

The finding itself is real and its primary citation (`:415-423`, no `deleted_at IS NULL`) is exact.
This is the supporting citation, and it is the one that carries the whole "the guarantee rests on caller ordering" argument - so a reader checking the argument is sent to a line that does not contain it.

P2: a documentation defect in a P2 entry, with no runtime consequence.
Fix: re-point to `:409-411` and name `visibleTo` as the reason the update returns zero rows.

### R0-3 · P2 · The round's own lens, applied to `productionEnv.ts`, finds a sixth check that is absent: `DATABASE_URL` is never required to carry TLS, though `STORAGE_ENDPOINT` is required to be https for exactly that reason

`src/productionEnv.ts:51-57` refuses a non-https `STORAGE_ENDPOINT`, and the reason is written into the file at `:16-19`: "a plain-http storage endpoint would presign http:// URLs, sending receipt image bytes over cleartext".
`:59-65` checks `DATABASE_URL` for one thing only - that its host is not loopback.
Nothing anywhere requires the database connection to be encrypted, and the whole receipt record other than the image bytes - vendor, purchase date, subtotal, **HST**, the supplier's GST/HST registration number, notes - travels over that connection.

Measured, because the default matters:

```
$ node -e "const {Client}=require('pg'); ..."
postgres://k:k@h:5432/db                  -> connectionParameters.ssl: false
postgres://k:k@h:5432/db?sslmode=require  -> connectionParameters.ssl: {}
```

A `DATABASE_URL` with no `sslmode` makes `pg` connect with TLS **off**.
`src/db/client.ts:11` passes the string through unmodified and adds no `ssl` option, so whether the API's database traffic is encrypted is decided entirely by a query parameter nothing in this repository checks, in the same file that refuses to start over the same question asked about storage.

This is squarely the defect class the ledger names as the round's own lens (`§0`: "a check that asks whether something is well-formed and never whether it is there"), applied to the file the lens was derived from.

**P2, taking the lower of an ambiguous pair and stating why.**
The P1/P0 case is that this is receipt data in transit with no transport guarantee, which is the security-exposure band.
It does not get there because the exposure is conditional on a server that accepts unencrypted connections, and the deployment target is Neon, whose connection strings carry `sslmode=require` as issued.
I cannot verify Neon's server-side enforcement - no account, and connecting to one is prohibited - so the conditional stays open rather than being resolved in the ledger's favour.
P2 also because R2-1's fix, if it lands, converts this from silent to loud for the case where the server refuses.

Fix, if the owner wants it: one clause beside the existing five in `assertProductionEnv`, requiring `sslmode` to be present and not `disable`.
No new configuration key - it constrains a value that must already be set - so it is inside the scope constraint on the same footing as the `https` check next to it.

### Citation imprecisions, recorded but not findings

- `fly.toml:23-27` is cited for "the 2 GB machine sizing"; the quoted measurement comment is in that range but `memory = "2gb"` is line **28**.
- `claudeReceiptParser.ts:88-93` is cited for the validation-failure throw; `:88` is blank and the `throw` runs `:91-95`.
- `claim.ts:19-24` is cited for `assertLocalDatabase`; the call is `:19-23` and `:24` is blank.
- The R2-1 reproduction narrative shows the 401 on port 3012 and the 500 on port 3013 without saying these are two runs of the same experiment; a reader checking the transcript sees one port change mid-block.

None of these misleads a reader about a fact.
They are listed so the ledger's own standard - paste rather than tidy, cite to the line - is measured against itself.

---

## 7 · Routing

| id | severity | routes to |
|---|---|---|
| R0-1 | P2 | correct PR-9's heading in the ledger; measure before re-asserting |
| R0-2 | P2 | re-point PR-11's supporting citation to `receipts.ts:409-411` |
| R0-3 | P2 | new P2 entry in the ledger's documented set, and a RULINGS line if the owner wants the check |

None of the three is a fix-pass item.
The frozen work list stands at **`R2-1`, one item, P1**, and I endorse it at that severity.
Pass 4 runs; passes 1, 2, 3, 5 are correctly skipped; pass 6 folding into pass 4 is correct because R2-1 *is* the startup-configuration finding; pass 7's test must fail when the probe is deleted, observed from outside the vitest worker.

---

## 8 · Verdict

The stage is a ledger and it is a good one.
Every reproduction in it reproduces, on my hardware, from my own commands, including the two it presents as measured rather than argued.
Both tests it leans on fail when the behaviour under them is deleted.
It contains no fabrication, no smuggled feature, no prohibited action, no iOS file, no Anthropic call, and nothing marked resolved without an artifact behind it.
Its one P1 is real, is graded correctly, and is the finding the round's stated lens predicts.

It falls short of PASS on its own standard rather than on a lower one: the sentence "every round-1 citation re-checked to the line" is not quite true, and the two places it fails are a claim nobody measured (R0-1) and a citation that points past the thing it is cited for (R0-2).
A third finding (R0-3) is the round's own lens fired once more than the round fired it.

**PASS-WITH-FINDINGS**
