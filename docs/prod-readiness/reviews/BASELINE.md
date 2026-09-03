# BASELINE

The state every later "green" claim in this run is measured against.
Captured 2026-08-10, before any change, at commit `ca829075c15f2d0588a145126fa033147b118621` (branch `prod-readiness/2026-08-10`, branched from `main`).

Working tree was clean at branch creation (`git status --porcelain` empty).
There is no git remote.

## Toolchain, as measured rather than assumed

```
$ node --version
v24.15.0
$ npm --version
11.12.1
```

## Build / typecheck

There is no compile step: `tsconfig.json` sets `"noEmit": true`, and both development and the Docker image run the TypeScript directly through `tsx`.
So the build gate is the typechecker.

```
$ npm run typecheck

> typecheck
> tsc --noEmit

(no output, exit 0)
```

## Test suite

```
$ npm test

> test
> vitest run

 RUN  v4.1.10 /Users/<user>/dev/kept/server

 Test Files  28 passed (28)
      Tests  263 passed (263)
   Start at  19:08:19
   Duration  11.73s (transform 266ms, setup 0ms, import 6.33s, tests 2.78s, environment 2ms)
```

**263 passed, 28 files, 0 failed, 0 skipped.**
No pre-existing failures. No skipped or `.only` tests.

## Linter

**There is none, and its absence is a measured fact rather than an oversight to fix here.**
`ls -a server/` returns no `.eslintrc*`, no `eslint.config.*`, no `.prettierrc*`, no `biome.json`, and `package.json` has no `lint` script.
The scripts are: `db:generate db:migrate db:seed db:claim db:verify-restore parse-accuracy parse-llm-backfill parse-llm-probe parse-llm-reparse storage:init storage:probe-keys dev test typecheck`.

So **"linter" in this repository means `npm run typecheck`**, and that is the third gate this file records.
Introducing a linter would be a tooling addition no finding cites; it is recorded under NOT DEFECTS in the ledger.

## Dependency audit

```
$ npm audit
6 moderate severity vulnerabilities
```

Two advisory clusters, both already assessed in `docs/security/review-2026-08.md` §1 and unchanged since:

- `esbuild <=0.24.2` (GHSA-67mh-4wv8-2f99) reached through `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils`. Dev-tool only; the advisory concerns esbuild's development server, which nothing here runs. Fix is `drizzle-kit@0.18.1`, a major downgrade.
- `uuid <11.1.1` (GHSA-w5hq-g745-h8pq) reached through `exceljs`. Fix is `exceljs@3.4.0`, a major downgrade.

Neither is new, neither is on the work list, and the prohibition on dependency upgrades except pinned CVE patches means neither is actionable here.
Recorded so a later `npm audit` showing 6 is read as unchanged rather than as a regression.

## Production entrypoint (guardrail 7)

The project's own rule is that a gate does not close until the real entrypoint has started the real way and answered one real request.
Run at baseline, before any change:

```
$ PORT=3001 node --env-file=<env> --import tsx src/index.ts
ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only
Kept API listening on port 3001

$ curl -s -i http://localhost:3001/api/me
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: application/json
content-length: 79

{"error":{"code":"unauthorized","message":"A valid session token is required"}}
```

**Two deviations from the literal `npm run dev`, both deliberate and both stated:**

1. **`ANTHROPIC_API_KEY` was removed from the environment file.**
   `src/index.ts:104` calls `llmParseSweep.kick()` at startup whenever the key is present, which issues real Anthropic API requests for every receipt row carrying `ocr_raw_text` with a null `llm_suggestions`.
   This run is prohibited from calling that API, so the key is withheld and the server states the degradation itself at boot.
   Everything the guardrail exercises - config loading, database, storage, routing, auth middleware, the cache header - runs identically.
2. **Port 3001, not 3000.**
   A `node --env-file=.env.local --import tsx src/index.ts` process started **2026-08-08 15:16** (pid 31468) was already holding port 3000 when this run began - a two-day-old server answering with two-day-old code.
   This is the **fifth** recorded instance (`docs/security/review-2026-08.md` §"Note on machine state" calls it the third, `docs/security/audit-2026-08.md` §7 the fourth).
   It was left running rather than killed: it is not this run's process, and nothing here needs port 3000.

## What can be executed to verify a change

Recorded because the ledger's evidence rules depend on it.

| Available | Not available |
|---|---|
| `npm run typecheck` | Anything against Fly, Neon, R2, or Cloudflare (no accounts, and prohibited) |
| `npm test` (263 tests, local Postgres `kept_test`) | Any Anthropic API call (prohibited; `parse-llm-*` scripts are off limits) |
| The real entrypoint against local Postgres + MinIO | The iOS client (out of scope by the run's own constraint) |
| `docker build` and running the production image locally | A real deploy - there is no remote and nothing is deployed |
| Local Postgres (`kept-db`) and MinIO (`kept-minio`), both up and healthy | R2's key-normalization behaviour (needs credentials) |

Nothing failed to run. There is no P0 for "nothing runs cleanly".
