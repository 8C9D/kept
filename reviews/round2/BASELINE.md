# BASELINE - round 2

The state every later "green" claim in round 2 is measured against.

Captured 2026-08-10 at commit `b23ea08` - the tip of `prod-readiness/2026-08-10`, which is round 1's end state and **not** round 1's start.
Branch `prod-readiness/round-2` is cut from that commit.
`main` is still at `ca82907` and nothing here merges to it.

Working tree was clean at branch creation (`git status --porcelain` empty).
There is no git remote.

## What round 2 must reproduce before touching anything

The run's own instruction: server suite **276** green, `tsc --noEmit` clean, `npm audit` 6 moderate.
If it does not reproduce, that is a P0 and the run stops.

**It reproduces.** All three, measured below.

## Toolchain, as measured rather than assumed

```
$ node --version
v24.15.0
$ npm --version
11.12.1
```

Identical to round 1's baseline.

## Build / typecheck

There is no compile step and there is no linter; `npm run typecheck` is both gates.
That is round 1's ASSUMPTION 1, re-checked here rather than inherited: `ls -a server/` still shows no `.eslintrc*`, no `eslint.config.*`, no `.prettierrc*`, no `biome.json`, and `package.json` still has no `lint` script.

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

 Test Files  30 passed (30)
      Tests  276 passed (276)
   Start at  23:31:22
   Duration  19.92s (transform 481ms, setup 0ms, import 9.67s, tests 6.57s, environment 2ms)
```

**276 passed, 30 files, 0 failed, 0 skipped.**
Matches the number the run's instructions name.
No pre-existing failures, no skipped or `.only` tests.

## Dependency audit

```
$ npm audit
6 moderate severity vulnerabilities
```

Unchanged from round 1, and unchanged in composition: the `esbuild <=0.24.2` cluster reached through `drizzle-kit`, and `uuid <11.1.1` reached through `exceljs`.
Both fixes are major downgrades, which the prohibitions forbid.
Recorded so a later `npm audit` showing 6 reads as unchanged rather than as a regression.

## Migration / schema drift

Not measured at round 1's baseline, and it is the cheapest way to find out whether the committed migrations still describe the schema the code compiles against.

```
$ npx drizzle-kit check
Reading config file 'drizzle.config.ts'
Everything's fine 🐶🔥
(exit 0)
```

No drift. Five migrations, `0000`..`0004`, with matching snapshots.

## Production entrypoint (guardrail 7)

The project's rule is that a gate does not close until the real entrypoint has started the real way and answered one real request.
Run at round-2 baseline, before any change:

```
$ PORT=3011 node --env-file=<env> --import tsx src/index.ts
ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only
Kept API listening on port 3011

$ curl -s -i http://localhost:3011/api/me
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: application/json
content-length: 79

{"error":{"code":"unauthorized","message":"A valid session token is required"}}
```

And the server's own log line for that request, which is round 1's PR-3 still holding:

```
{"msg":"request","method":"GET","route":"/api/me/*","status":401,"durationMs":14,"authenticated":false}
```

**Two deviations, both deliberate, both carried over from round 1 with the same reasoning:**

1. **`ANTHROPIC_API_KEY` was withheld.**
   `src/index.ts:104` calls `llmParseSweep.kick()` at startup whenever the key is present, which issues real Anthropic requests for every row carrying `ocr_raw_text` with a null `llm_suggestions`.
   This run is prohibited from calling that API, so `.env.local` was copied to the scratchpad minus that line and `--env-file` pointed at the copy, for **every** server start in this run.
   Consequence, stated: **no code path that calls Anthropic has been executed in round 2 either.**
2. **Port 3011, not 3000.**
   The same `node --env-file=.env.local --import tsx src/index.ts` process (pid **31468**, started 2026-08-08 15:16) still holds port 3000 - now three days old.
   Round 1 recorded it as the fifth instance; this is the sixth.
   It was left running: it is not this run's process, and nothing here needs port 3000.

## Round 1's resolved findings, spot-checked rather than believed

A ledger saying RESOLVED is a claim. Each was re-checked against an artifact.

| Round-1 finding | Spot-check | Result |
|---|---|---|
| **PR-1** pool crash | `src/db/client.ts:30` carries `pool.on("error", ...)`; `tests/integration/dbClient.test.ts` still drives it through a **child process** (`tests/helpers/poolSurvivalChild.ts`), which is what makes the assertion falsifiable | **Holds** |
| **PR-2** sweep log leak | The redaction is live in the entrypoint, not just in tests: an authenticated request against a bad `DATABASE_URL` logged `DrizzleQueryError [message and detail withheld]` / `caused by DatabaseError [message and detail withheld] code=28P01 routine=auth_failed` - SQLSTATE kept, message and parameters gone | **Holds** |
| **PR-3** no request logging | The 401 above emitted a request line from the real entrypoint | **Holds** |
| **R-1** unnamed export failure | `src/export/generateExport.ts:191-211` names the receipt id and leads with the keep-the-receipt remedy; `tests/integration/export.test.ts:231` asserts ordering, the absence of "re-attach", and that no user id, filename, date or vendor reaches the message | **Holds** |

None was re-fixed.

## What can be executed to verify a change

| Available | Not available |
|---|---|
| `npm run typecheck` | Anything against Fly, Neon, R2, Cloudflare (no accounts, and prohibited) |
| `npm test` (276 tests, local Postgres `kept_test`) | Any Anthropic API call (prohibited; `parse-llm-*` scripts are off limits) |
| The real entrypoint against local Postgres + MinIO | The iOS client (out of scope by this run's own constraint) |
| `npx drizzle-kit check` | A real deploy - there is no remote and nothing is deployed |
| `docker build` and running the production image locally | R2's key-normalization behaviour (needs credentials) |
| Local Postgres (`kept-db`) and MinIO (`kept-minio`), both up and healthy | Fly's health-check behaviour |
| A 2 GB-limited container, to measure what Node does inside one | |

Nothing failed to run.
There is no P0 for "the baseline does not reproduce".
