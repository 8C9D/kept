# Baseline, round 3 - re-measured at `7035141` before anything was touched

Branch `prod-readiness/round-3`, cut from `prod-readiness/round-2` at `7035141`.
Rounds 1 and 2 artifacts are left intact and unedited.

The prompt supplies round 2's end state as the number to reproduce: **289 tests green across 31 files, `tsc --noEmit` clean, `npm audit` 6 moderate, `npx drizzle-kit check` clean.**
If it does not reproduce that is a P0 and the run stops.
It reproduces.

## Preflight - the machine, before the repository

Round 2's fix means the server refuses to start unless Postgres and object storage both answer, and the suite spawns the real entrypoint as a child process.
A cold machine therefore fails in ways that read as code defects, so the machine was checked first.

| Check | Required | Measured | Verdict |
|---|---|---|---|
| `kept-db` | healthy | `Up 5 days (healthy)` | ok |
| `kept-minio` | healthy | `Up 5 days (healthy)` | ok |
| `kept_test` database exists on `kept-db` | present | `kept`, `kept_test`, `postgres`, `template0`, `template1` | ok |
| `gitleaks` installed | present | `/opt/homebrew/bin/gitleaks`, `8.30.1` | ok |
| `git config core.hooksPath` | `.githooks` | `.githooks` | ok |
| `.githooks/pre-commit` fail-closed | refuses without gitleaks | `exit 1` when `command -v gitleaks` fails | ok |
| `node --version` | v24.x | `v24.15.0` | ok |
| Working tree | clean | clean | ok |
| `prod-readiness/round-2` at `7035141` | yes | `703514164eff1a3a06dbf83442d1baf12ff90696` | ok |
| `main` unmerged | at `ca82907` | `ca829075c15f2d0588a145126fa033147b118621` | ok |
| Port 3000 | note the holder | pid **31468**, four days old | **not this run's process; left alone** |

Nothing needed fixing.
`docker compose up -d` was not run because both containers were already healthy.

**Port discipline.** Pid 31468 still holds 3000, unchanged since round 1 recorded it and now in its seventh recorded run.
Round 3 used **3031** for its entrypoint gate and left 3000 alone.

## The four gates

All four run from a clean tree at `7035141`, in `server/`.

```
$ npm test
 Test Files  31 passed (31)
      Tests  289 passed (289)
   Duration  119.63s

$ npm run typecheck          # tsc --noEmit
(no output, exit 0)

$ npm audit
6 moderate severity vulnerabilities
  esbuild  <=0.24.2        (via drizzle-kit, and via vite -> vitest)
  uuid     (via exceljs)
Both fixes are `npm audit fix --force` major downgrades - exceljs@3.4.0, and a drizzle-kit downgrade.

$ npx drizzle-kit check
Everything's fine
```

| Gate | Round 2's number | Round 3's measurement | Reproduces? |
|---|---|---|---|
| `npm test` | 289 green / 31 files | **289 green / 31 files** | yes |
| `npm run typecheck` | clean | **clean, exit 0** | yes |
| `npm audit` | 6 moderate | **6 moderate** | yes |
| `npx drizzle-kit check` | clean | **"Everything's fine", exit 0** | yes |

**No P0 for "the baseline does not reproduce".**
**The run continues.**

## The fifth gate: the real entrypoint, started the real way

CLAUDE.md requires this of every gate, and round 2 is the reason: a suite that injects its own configuration can be fully green while the entry point cannot start.

`ANTHROPIC_API_KEY` was withheld - `src/index.ts:183` kicks the LLM sweep at startup whenever it is set, and this run may not call Anthropic.
The key was stripped by copying `.env.local` minus that line to the scratchpad and passing `--env-file` at the copy; the copy was checked to confirm the key is absent and the other seven variables present.

**Predicted before running:** the storage-probe line first, then the no-key notice, then `Kept API listening on port 3031`; `GET /api/me` answers 401 with `cache-control: no-store`.

```
$ PORT=3031 node --env-file=<.env.local minus ANTHROPIC_API_KEY> --import tsx src/index.ts
Object storage: checking http://dev-mac.local:9000 for bucket "kept"
ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only
Kept API listening on port 3031

$ curl -s -i http://localhost:3031/api/me
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: application/json
content-length: 79

# the request log line the same run emitted
{"msg":"request","method":"GET","route":"/api/me/*","status":401,"durationMs":8,"authenticated":false}
```

**Actual matched the prediction with no gap.**
Note that `.env.local` sets `STORAGE_*`, so this boot took the **configured-storage** branch (`src/index.ts:79-105`), not the MinIO-default one - which is the branch round 2's first tests failed to exercise.

## The five closed P1s, spot-checked

Round 2's own fix shipped two P1 regressions that only a reviewer caught, so "closed" was not taken on trust.
None is re-fixed; each was confirmed still in place.

| Finding | Closed in | Spot-check at `7035141` | Holds? |
|---|---|---|---|
| PR-1 · pool crash on a terminated idle connection | round 1 | `src/db/client.ts:30` `pool.on("error", ...)` present, logging through `errorSummary` | yes |
| PR-2 · sweep log leaked receipt contents | round 1 | `src/parse/llmParseSweep.ts:9` imports `errorSummary`/`redactedMessage`; `:147` stores `redactedMessage(error)`, `:228`/`:246` print `errorSummary` | yes |
| PR-3 · no request logging | round 1 | `src/app.ts:73` `app.use("*", requestLog())`; the live boot above emitted a request line | yes |
| R-1 · unnamed export failure | round 1 | `src/export/generateExport.ts:111` `Receipt ${receipt.id} has no page-1 image` | yes |
| R2-1 · entrypoint never asked whether either service answers | round 2 | `src/index.ts:93` `assertStorageReachable`, `:115` `assertDatabaseReachable`; the live boot printed the probe line before binding | yes |

## Verification of `7035141`, the commit no reviewer has seen

The prompt states this commit was made after `reviews/round2/REVIEW-FINAL.md` and asks that it be verified rather than trusted.
It touches three files and no code: `PROD-READINESS-ROUND-2.md`, `docs/DECISIONS.md`, `docs/Kept-Build-Spec.md`.

| Claim in the commit | Independent check | Verdict |
|---|---|---|
| The carry list had dropped **PR-5** | The line now reads eighteen ids; counted them: PR-4..PR-13 = 10, N-1..N-5 = 5, R2-2..R2-4 = 3. **18.** Arithmetic correct | **holds** |
| Two wrong counts in the DECISIONS entry | "Sixteen carried candidates" → "Fifteen" (round 1's carry-in is PR-4..PR-13 plus N-1..N-5 = **15**, since R2-2/R2-3/R2-4 are round 2's own); "Sixteen P2/P3 findings carry" → "Eighteen" (matches the 18 above) | **holds** |
| The "assertions that could not fail" tally was miscounted | Rewritten to two assertions that could not fail plus one behaviour shipped with no test, running project count **eight**. The three items the next paragraph enumerates split that way: the gutted storage probe was untested (no test), the retry-defaults override and the inherited-`STORAGE_*` shell were assertions that could not fail | **holds** |
| Em dashes removed | Counted mechanically over the commit's removed lines: **11**, not the seven the prompt states. Zero em dashes added. Net over round 2's own commits (`b23ea08..7035141`), **0** em dashes remain on lines round 2 added | **holds, with the count corrected** |

The prompt's "seven em dashes" is understated: `docs/DECISIONS.md` gave up 8 and `docs/Kept-Build-Spec.md` 3.
Recorded because the point of the commit was correcting counts, and its own count was reported low.

Round 1's added lines still carry 21 em dashes.
Those files are frozen by this round's instructions and are **not** touched; noted under NOT DEFECTS in the ledger rather than repaired.

## What this baseline commits round 3 to

Any pass ending with fewer than 289 tests, a non-clean `tsc --noEmit`, more than 6 audit moderates, or a `drizzle-kit check` that is not clean is worse than baseline and must be reverted.
The entrypoint gate above is re-run before the round closes.
