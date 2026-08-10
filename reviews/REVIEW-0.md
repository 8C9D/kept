# REVIEW-0 — adversarial review of Stage 0 (recon)

verdict: PASS-WITH-FINDINGS

Range reviewed: `ca82907..9146806` (2 commits, 424 insertions, 2 files: `PROD-READINESS.md`, `reviews/BASELINE.md`).
Reviewed at `HEAD = 9146806`, branch `prod-readiness/2026-08-10`, working tree clean before and after this review.
Everything below was re-run by me. No builder narration was available and none was used.

---

## 1 · Compliance checks the contract requires, each answered

| Check | Result |
|---|---|
| Fabricated or unreproducible findings | **None found.** Every one of the thirteen findings' cited lines was opened and reads as claimed. The two findings carrying a live reproduction (PR-1, PR-2) I reproduced end-to-end myself; see §3. |
| Evidence citations that don't say what they're claimed to say | **Two.** PR-3's console-site enumeration (R-2, below) and PR-10's off-by-one line number (R-4). Neither destroys its finding. |
| Severity inflation | None. If anything the ledger runs conservative, which its rubric states it will. |
| Severity deflation | **One structural instance** — PR-1's demotion from P0 rests on an unverifiable fact that is not listed in ASSUMPTIONS (R-3). |
| Features smuggled in under the no-features rule | None. The stage adds no code at all. `git diff --name-status ca82907..9146806` returns two added Markdown files. |
| Prohibited actions taken | None detectable. `git merge-base --is-ancestor ca82907 9146806` passes — history is append-only, no rewrite. `git remote -v` is empty, so no push was possible. `main` still points at `ca82907`; the work is on its own branch, exactly as the ledger says. No credential was rotated, no file deleted. |
| iOS files touched | **None.** No path under `ios/` appears in the diff, and no finding cites an iOS file. PR-6 and DEFERRED explicitly refuse to read `ios/` and mark the consequence unknown rather than guessing — the correct move. |
| An Anthropic API call made | **No positive evidence of one, and corroborating evidence against.** The ledger's ASSUMPTION 2 says the key was withheld; the run's on-disk environment files (`env.nollm`, `env.test` in the run scratchpad) contain the keys `DATABASE_URL`, `SESSION_JWT_SECRET`, `APPLE_CLIENT_ID`, `STORAGE_*` and **no `ANTHROPIC_API_KEY`**, and both `DATABASE_URL`s are `localhost:5432`. I checked key names only, not values. This corroborates the assumption with an artifact instead of a claim. It cannot prove a negative, and I say so rather than overstating it. |
| Fixes that relocated a bug rather than removed it | N/A — this stage fixes nothing. |
| Error handling that hides errors | Not introduced by this stage. PR-2 is itself a finding of the opposite failure (an error handler that reveals too much), and it is correct. |
| Verification that doesn't exercise the changed path | The "changed path" is a document. The baseline's guardrail-7 claim I re-ran independently (§3.0). |
| Anything marked resolved without an artifact | Nothing is marked resolved. All thirteen are OPEN or DOCUMENTED. Section 7 is honest. |

### Tests: would any of them still pass if the behaviour it verifies were deleted?

**The builder added zero tests.** Stage 0 is a document. The only test evidence cited is `BASELINE.md`'s "263 passed, 28 files", which I re-ran: `Test Files 28 passed (28) / Tests 263 passed (263)`. `npm run typecheck` exit 0. `npm audit` → 6 moderate. Baseline reproduces exactly.

For the tests the ledger's *reasoning* leans on:

- `tests/unit/errorSummary.test.ts` — **cannot pass vacuously, and is unusually well built.** It constructs a real `DrizzleQueryError` (not a stub), and `:44-51` is an explicit premise guard asserting `raw.message` *does* contain the private note and the SQL before `:53-58` asserts the summary does not. Delete the redaction branch in `describe()` and `:53-58` fails on `error.message`. This is the pattern the other five broken assertions in this project's history lacked.
- `tests/integration/isolation.test.ts` — substantive. Ten cases, cross-user data, real status assertions, and `:205-234` is the tampered-row test that asserts a hand-edited `object_key` produces a 500 whose body contains neither the other user's key nor their id. Not vacuous.
- **The gap that matters, and it is a proof rather than an argument:** exactly one test in the entire suite spies on `console` (`tests/unit/errorSummary.test.ts:113`, scoped to `renderError`). Nothing anywhere asserts the spec §10B invariant "server logs carry no receipt contents". I demonstrated the consequence directly: the suite is **263/263 green** while `llmParseSweep.ts:221` prints a vendor name, a GST/HST number and three dollar amounts to stdout (§3.2). No test in this suite *can* fail on that behaviour. That is why the class the 2026-08-06 ruling closed came back on 2026-08-08 unnoticed, and it is why a PR-2 fix that adds no log assertion will not prevent a third instance.

---

## 2 · My findings

Format: `severity | evidence | why the builder missed it`.

---

### R-1 · P1 · A receipt can be created naming an image object that does not exist, and one such row makes every export of its period fail permanently with an error that names nothing

**Severity: P1 | Evidence: measured against the real entrypoint, transcript below | Why missed: the ledger inventoried orphaned *objects* and never orphaned *keys***

`src/routes/receipts.ts:88` gates the create on `isIssuedObjectKey(body.image.objectKey, userId)`. That predicate (`src/storage/objectKeys.ts:80-93`) is a **shape** test — user prefix, `yyyy/mm`, a uuid, a known extension. It does not check that this server issued *that* key, and nothing checks that the object exists. The client-asserted `sha256` (`src/http/schemas.ts:132-135`) is never compared against stored bytes either.

Measured, real entrypoint on port 3005 against local Postgres `kept_test` and the docker-compose MinIO, `ANTHROPIC_API_KEY` absent:

```
$ curl -X POST localhost:3005/api/receipts -H 'Authorization: Bearer <valid>' -d '{
    "purchasedAt":"2026-03-01","capturedAt":"2026-03-01T12:00:00Z",
    "vendor":"Never Uploaded Inc","totalCents":1000,"isBusiness":true,"status":"confirmed",
    "image":{"objectKey":"<userId>/2026/03/deadbeef-0000-4000-8000-000000000001.jpg",
             "sha256":"0000...0000"}}'
HTTP 201     <- accepted; nothing was ever uploaded to that key

$ curl -X POST localhost:3005/api/export -d '{"periodStart":"2026-01-01","periodEnd":"2026-12-31"}'
$ curl localhost:3005/api/export/81a61109-...
{"status":"failed","error":"The specified key does not exist.","downloadUrl":null}

server log:
Export job 81a61109-6258-444c-83c9-de1cdc94c7a6 failed: NoSuchKey: The specified key does not exist.

$ curl localhost:3005/api/receipts/e4e7c512-...
... "images":[{"page":1,"downloadUrl":"http://localhost:9000/kept/<userId>/2026/03/deadbeef-...jpg"}]
```

The detail route still hands out a presigned URL for the nonexistent object, and the export is dead for that whole period. `generateExport.ts:166` downloads each image inside the zip build; the first miss aborts the job. The message the user is shown names no receipt, no vendor, no date — so there is no way to find the offending row and remove it. This is the ledger's own rubric verbatim: "fails under realistic load or edge input, **or undiagnosable in production**", applied to the single artifact the whole product exists to produce.

The hostile framing (an authenticated user poisoning their own exports) is the least of it. The honest trigger is a presigned PUT that failed or was interrupted, followed by a create the client still sent — precisely the severed-request scenario PR-5 and PR-6 are about, arriving at the other half of the same two-step. The ledger reaches the create route twice (PR-6 on the 409, PR-4 on key ownership) and both times asks about ownership and idempotency, never about existence. Its DEFERRED entry covers objects with no receipt; the inverse — receipts with no object — is nowhere in the document.

Not P0: nothing crosses a user boundary, nothing already stored is destroyed, and the user can delete the receipt to unblock (if they can work out which one). Fix would stay in scope: a `HEAD`/`headObject` existence check at create, or a digest check — but it needs a `ObjectStorage` method that does not exist today, so it is a ruling for the owner, not a drive-by.

---

### R-2 · P2 · PR-3's evidence understates what the process actually logs, in a document whose whole method is "verify artifacts, not reports"

**Severity: P2 | Evidence: `PROD-READINESS.md:164` vs. my own grep | Why missed: the grep was filtered by eye, and the filter dropped two real sites**

`PROD-READINESS.md:164` states: *"`grep -rn "console\." src/` returns exactly four sites in the serving path: three startup lines in `index.ts` (`:63`, `:100`, `:122`), the port-in-use message (`:132`), and `http/errors.ts:46`."* That enumerates **five** items while calling them four, and my run of the same grep returns two further sites that live in the serving process:

```
src/routes/exports.ts:111    console.error(`Export job ${job.id} failed:`, errorSummary(error));
src/parse/llmParseSweep.ts:205,214,221,238,239
```

Both are in-process background jobs the ledger itself inventories at `:55` ("Background jobs — two, both in-process"). So `:166`'s "a deployed machine emits three lines at boot and then, for every 400, 401, 403, 404, 409, 413 and every successful request, **nothing**" is false as written: a failed export and every sweep run also emit. The conclusion PR-3 actually rests on — that there is no logging at the *request boundary* — survives intact, and I uphold the finding. But an audit whose stated rule is "verify artifacts, not reports" published a grep result that its own grep does not produce.

---

### R-3 · P2 · PR-1's demotion from P0 rests on "Fly restarts the machine", which this run cannot verify and did not list as an assumption

**Severity: P2 | Evidence: `PROD-READINESS.md:120` vs. `:212-221` and `:255-260` | Why missed: the assumption is load-bearing for a severity rather than for a finding, and the audit only hunted the second kind**

`:120` argues PR-1 is P1 and not P0 in four steps: not silent, not a security exposure, not receipt data loss, and "**Fly restarts the machine.**" The first three are verifiable and I verified them. The fourth is a fact about a platform this run has no account on — the ledger's own CANNOT ASSESS opens with "Anything against Fly, Neon, R2, or Cloudflare" (`:255`), and ASSUMPTION 6 correctly quarantines a *different* Fly-documented default for exactly this reason.

The rubric's P0 includes "cannot deploy". A process that exits on a routine idle-connection reap, on a platform whose restart behaviour is unverified here, is one unverified fact away from a crash loop on a machine configured `auto_stop_machines = "off"` with no health check (PR-8) to notice. The severity is probably right. The problem is that the discipline the ledger applies rigorously to findings — quarantine what you cannot measure — was not applied to the reasoning that *lowered* a severity, which is where an unstated assumption does the most damage. ASSUMPTION 5 does this correctly for the same finding's trigger; the restart claim needed the same treatment and did not get it.

---

### R-4 · P2 · PR-10 cites `drizzle.config.ts:10`; the fallback is on line 9

**Severity: P2 | Evidence: `drizzle.config.ts:9` is `url: process.env.DATABASE_URL ?? "postgres://kept:kept@localhost:5432/kept",`; line 10 is `},` | Why missed: transcription**

Off by one. The finding itself is correct in substance and correctly rated.

---

### R-5 · P2 · The NOT-DEFECTS dismissal of the in-memory export budget imports a single-export measurement, but the one-live-export index is per user

**Severity: P2, unmeasured | Evidence: `src/db/schema.ts:156` `uniqueIndex("export_jobs_one_active_per_user_uq")`; `server/fly.toml:25-27`; `PROD-READINESS.md:246` | Why missed: the wave-6 ratification was carried over verbatim instead of re-derived against the concurrency the index actually permits**

`PROD-READINESS.md:246` retires the export memory question as "Measured at 891 MiB RSS and the machine sized to it (2 GB); a ratified decision, not a defect", and `fly.toml:25-27` justifies the 2 GB on "exports are serialized one-per-user". The uniqueness index is scoped to `userId`, so the serialization is per user and nothing bounds the number of users exporting at once. Production is three people (`:62`) sharing one 2 GB machine; three concurrent 250 MiB exports would be permitted by every guard in the system.

I did not measure this — doing so honestly needs three concurrent quarter-gigabyte exports and would tell us about my laptop, not about a `shared-cpu-1x`. So this is filed as a **gap in the ledger's reasoning**, not as a measured OOM: the sentence "the machine sized to it" is true of one export and unexamined for the case the schema allows. It deserves a line in the document saying so, and it interacts with PR-5 (an OOM kill severs everything in flight and leaves the jobs `running` until the next POST reaps them).

---

### R-6 · P2 · The boundary inventory omits process execution

**Severity: P2 | Evidence: `src/observability/portInUse.ts:1` `import { execFileSync } from "node:child_process";`, reached from `src/index.ts:132` | Why missed: the inventory's categories were network / persistence / filesystem / auth / jobs / third-party, and a subprocess fits none of them**

`PROD-READINESS.md:53` states "**Filesystem** — none. Nothing reads or writes local files at runtime." That is true of files and remains a good finding. The process does, however, shell out to `lsof` via `execFileSync` on `EADDRINUSE` at startup. The arguments are not attacker-controlled and the path is startup-only, so this is a completeness note on the inventory rather than a defect — but an inventory that Stage 1 will use to decide what is in scope should say it.

---

## 3 · What I re-ran, and what it produced

**3.0 Baseline, independently reproduced.** `npm run typecheck` → exit 0, no output. `npm test` → 28 files, 263 passed, 0 failed, 0 skipped. `npm audit` → 6 moderate. `docker images` → `kept-api:prod-readiness`, 714 MB, built 19:15:57. `docker run --rm --entrypoint id kept-api:prod-readiness` → `uid=0(root) gid=0(root) groups=0(root)`. `gitleaks version` → 8.30.1. Production entrypoint started the real way on a spare port with `ANTHROPIC_API_KEY` absent and `DATABASE_URL` on `kept_test`: `Kept API listening on port 3003`, `curl /api/me` → `HTTP/1.1 401` with `cache-control: no-store`. Every figure in `BASELINE.md` reproduces. Port 3000 (pid 31468) left alone throughout.

**3.1 PR-1, reproduced.** Real entrypoint on 3003, one authenticated `GET /api/me` → 200 (this step is required — an unauthenticated 401 never checks out a connection), then from inside the `kept-db` container:

```
$ psql -c "select pg_terminate_backend(pid) from pg_stat_activity
           where datname='kept_test' and state='idle'"   ->  t
$ ps -p 20339      -> (empty)
$ lsof -ti tcp:3003 -> (empty)

node:events:487
      throw er; // Unhandled 'error' event
error: terminating connection due to administrator command
Emitted 'error' event on BoundPool instance at:
    at Client.idleListener (node_modules/pg-pool/index.js:62:10)
  code: '57P01',
```

PR-9 falls out of the same dump: `statement_timeout: false, lock_timeout: false, idle_in_transaction_session_timeout: false, query_timeout: false, connect_timeout: 0` — verbatim what the ledger claims.

**3.2 PR-2, reproduced, and worse than a citation.** Driving the real `createLlmParseSweep` against `kept_test` with a parse stub returning a vendor string containing a NUL:

```
LLM parse failed for receipt 5d86cc4b-...; a later sweep retries it
DrizzleQueryError: Failed query: update "receipts" set "llm_suggestions" = $1 where ...
params: {"model":"claude-haiku-4-5","promptVersion":2,"requestedAt":"...",
 "suggestions":{"vendor":"Dr Smith Psychiatry Clinic  ",...,"totalCents":12345,
 "hstCents":1600,"subtotalCents":10745,"vendorTaxNumber":"123456789RT0001"}},5d86cc4b-...
  cause: error: unsupported Unicode escape sequence ... code: '22P05'
```

Vendor, GST/HST number and three amounts, on stdout, two lines below a comment promising none of them ever appear. No Anthropic call was involved — the leak is on the database write, exactly as the ledger scopes it. `node_modules/drizzle-orm/errors.js:10-13` confirms the mechanism: `super(\`Failed query: ${query}\nparams: ${params}\`)`.

**3.3 PR-5, reproduced.** Real entrypoint on 3004, `kill -TERM <pid>` → process gone within 1 s, port released, no drain, nothing in the log.

**3.4 The gitleaks refinement in NOT DEFECTS, reproduced.** gitleaks 8.30.1 over a directory containing a 52-char high-entropy literal in both shapes: `SESSION_JWT_SECRET=...` and `EDGE_SHARED_SECRET=...` in a `.env`-shaped file → both caught; `const SESSION_JWT_SECRET = "..."` in a `.ts` file → caught; `export const EDGE = "..."` → **missed**. Four findings, and the `EDGE` line is not among them. The ledger's refinement is exact.

**3.5 One candidate of my own, struck by its own evidence.** I suspected `assertProductionEnv` (`src/productionEnv.ts:60`, `if (database.host === "localhost")`) would let a `127.0.0.1` or `::1` `DATABASE_URL` through the production guard. It does not: `databaseIdentity` runs `normalizeHost`, and `src/db/databaseUrl.ts:47` folds `localhost`, `127.0.0.1`, `::1` and `[::1]` to one spelling. Recorded because a review that only reports its hits is not showing its work.

---

## 4 · Per-finding table — every ledger finding, independently verified

| id | ledger severity | my verdict | reasoning |
|---|---|---|---|
| **PR-1** | P1 | **UPHELD, severity upheld with a caveat** | `src/db/client.ts:10` is `new Pool({ connectionString: databaseUrl })` with no listener; `grep -rn "pool.on\|SIGTERM\|process.on" src/` returns nothing — both confirmed. Crash reproduced end-to-end by me (§3.1), same SQLSTATE, same `idleListener` frame. The observation that an unauthenticated 401 does not trigger it is correct and I hit it too. P1 stands, but see **R-3**: the "Fly restarts the machine" leg is unverifiable here and belongs in ASSUMPTIONS. Fix and blast radius are in scope and correctly bounded. |
| **PR-2** | P1 | **UPHELD** | `llmParseSweep.ts:221` and `:239` are `console.error(failure.error)` / `console.error(error)`; the comment at `:212-213` reads as quoted; the `try` is at `:113` and spans `writeIfStillNull` at `:121`. Reproduced verbatim (§3.2), including the vendor, the GST number and the amounts. The "written afterwards and reintroduced the class" account is consistent with `git log` (LLM parse wiring, 2026-08-08; the redaction ruling, 2026-08-06). Fix (`errorSummary`, already present) is minimal and in scope. |
| **PR-3** | P1 | **UPHELD in substance; evidence struck and rewritten — see R-2** | `app.ts:66-135` mounts `onError` (`:68`), the cache header (`:82`), the edge check (`:93`) and `bodyLimit` (`:112`), and no logging middleware exists — all confirmed line by line. The conclusion (nothing at the request boundary) is correct and P1 is defensible under the rubric's "undiagnosable in prod". The console-site enumeration is wrong: five items called four, and `routes/exports.ts:111` plus five `llmParseSweep` sites omitted. The proposed fix is well-specified, and its explicit exclusion of `q=` and user ids from the log line is exactly right. |
| **PR-4** | P2 | **UPHELD, severity upheld, with a note** | `routes/exports.ts:153` is `return deps.storage.presignDownload(job.objectKey);` with no `assertIssuedObjectKey` — confirmed. The "three dereference sites" count is right: `receipts.ts:285`, `generateExport.ts:117`, and this. No route writes `object_key` from client input — confirmed. Note for Stage 1: `tests/integration/isolation.test.ts:205` is the tampered-row test for the *receipts* site and has no export counterpart, so this is the one dereference with neither a runtime check nor a test. The 2026-08-06 ruling's own words were "in **both** places one is dereferenced" — it was written believing there were two. P2 is defensible on reachability, but the ledger's own precedent argues for closing it rather than documenting it. |
| **PR-5** | P2 | **UPHELD** | No signal handler anywhere in `src/` — confirmed. Immediate exit on `kill -TERM`, port released, no drain — reproduced (§3.3). The P2 argument (outbox retries, `failAbandonedJobs` reaps) is sound: `failAbandonedJobs` (`routes/exports.ts:208-238`) does write `failed` durably and is called before every insert, so the one-live-export index cannot lock a user out permanently. |
| **PR-6** | P2 | **UPHELD** | `routes/receipts.ts:144-150` maps `receipt_images_user_id_sha256_uq` to `409 duplicate_image` — confirmed at exactly those lines. Refusing to guess at the iOS half, and recording the implication for the next iOS pass instead, is the correct handling of the scope constraint rather than an evasion of it. |
| **PR-7** | P2 | **UPHELD** | `Dockerfile:27` (`CMD [...]`) is the last instruction and no `USER` appears in the file — confirmed. `uid=0(root)` reproduced against the same image tag the ledger names. |
| **PR-8** | P2 | **UPHELD** | `fly.toml:13-21` is `[http_service]` with `internal_port`, `force_https`, `auto_stop_machines`, `auto_start_machines`, `min_machines_running` and no checks block; the file is 28 lines and contains no `[checks]` or `[[http_service.http_checks]]` anywhere — confirmed. The Fly TCP-fallback behaviour is correctly quarantined in ASSUMPTION 6. The PR-1 interaction it draws (listening but database-dead still passes TCP) is real. |
| **PR-9** | P2 | **UPHELD** | `db/client.ts:10` passes only `connectionString` — confirmed. Every timeout value reproduced from my own crash dump (§3.1), not taken from the ledger's. |
| **PR-10** | P2 | **UPHELD, citation corrected — see R-4** | The fallback exists and reads exactly as quoted, on line **9**, not 10. Substance and P2 rating both correct. |
| **PR-11** | P2 | **UPHELD** | `routes/receipts.ts:415-423` updates `receipt_images` with `receiptId` + `userId` and no `deleted_at IS NULL` — confirmed at exactly those lines. The claimed short-circuit is real: `visibleTo` (`db/receiptQueries.ts:10-12`) is `and(eq(userId), isNull(deletedAt))`, so the receipts update at `:405-408` returns zero rows on a second delete and `:409-411` returns before reaching the image update. "The guarantee rests on caller ordering rather than on the statement" is an accurate description of the code. |
| **PR-12** | P2 | **UPHELD** | `auth/session.ts:52` is `if (typeof payload.sub !== "string" \|\| payload.sub === "")` — the ledger's "checks `typeof payload.sub === "string"` only" is right about the missing UUID validation (it omits mentioning the non-empty check, which changes nothing). Unreachable without the signing secret — confirmed, `sub` comes only from `jwtVerify`. |
| **PR-13** | P2 | **UPHELD** | `Dockerfile:19` is `RUN npm ci --include=dev` — confirmed, with the reason stated in the comment above it. `npm audit` → 6 moderate, unchanged from baseline. Recording the trade rather than acting on it is correct given the prohibition on dependency changes. |

**Struck: none. Severity changed: none.** Thirteen findings, thirteen cited locations, thirteen that read as claimed. Two citation defects (R-2, R-4), neither of which changes a verdict.

---

## 5 · Verdict and what Stage 1 inherits

**PASS-WITH-FINDINGS.** The ledger is a sound artifact and an unusually honest one: the ASSUMPTIONS, CANNOT ASSESS and NOT DEFECTS sections do real work, the two live reproductions hold up under independent re-execution, the scope constraint is respected including where respecting it costs the ledger an answer it wanted (PR-6), and I could not find a fabricated or inflated finding anywhere in it. Its weakness is the boundary it drew around the create path: it audited that route for ownership and for idempotency and never for existence, and that is where the one missing P1 was hiding.

The frozen P0/P1 work list surviving this review is **PR-1, PR-2, PR-3, and R-1** (four items; no P0). PR-3's evidence paragraph needs rewriting before it is acted on. R-3 asks for one sentence moved into ASSUMPTIONS. R-5 asks for one sentence added to NOT DEFECTS. R-1 needs a ruling from the owner before code, because closing it properly means a storage existence check that `ObjectStorage` cannot currently express.

One thing Stage 1 should carry regardless of which finding it starts with: **the suite is 263/263 green while receipt contents print to stdout.** Whatever fixes PR-2 must arrive with an assertion that would have failed before it.
