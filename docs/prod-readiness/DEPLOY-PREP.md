# Deploy-prep ledger

The pass that prepares the first production deploy, on branch `deploy-prep`, cut from `main` at `7c70fda`.
It follows three completed hardening rounds (`PROD-READINESS.md`, `PROD-READINESS-ROUND-2.md`, `PROD-READINESS-ROUND-3.md`) and works their carried backlog with one question: does a finding get worse, or become unfixable, once real user data is in production - or does it block the first deploy itself?
Scope: `server/`, `fly.toml`, `docs/`; `ios/` untouched; nothing deployed, no remote service called, no Anthropic API call.
`ANTHROPIC_API_KEY` was withheld from every process this pass started.

---

## 1 · Triage of the carried backlog

Thirteen items: the twelve round 3 carried forward, plus the deferred statement-timeout half of PR-9.
Every definition was re-read in the round ledgers rather than guessed; classifications are this pass's own.

| Finding | One line | Classification | Reason |
|---|---|---|---|
| PR-5 | No SIGTERM drain: in-flight requests severed on every deploy | post-deploy | Data-safe by rounds 1-3's own analysis (a severed-but-committed create is already stored and reaches the client on the next list fetch); fixable at any time with nothing accumulating against it |
| PR-6 | A severed-but-committed create retried gets 409 | post-deploy | The receipt is committed when the 409 arrives, so nothing is lost; the remedy needs `ios/` (RULING 4), which this pass may not read |
| PR-8 | `fly.toml` defines no health check | **deploy-blocking** | The gap is a machine that dies after a successful boot with no automated signal - exactly the state a first deploy inaugurates; round 3 struck it only because the honest fix is a new endpoint, and this pass is the first allowed to add one. **Fixed - §2** |
| PR-10 | `drizzle.config.ts` falls back to localhost | post-deploy | Fails loudly rather than corrupting (no database listens on a Fly machine's loopback); the fallback is what makes a clean checkout work; migration-over-ssh has `DATABASE_URL` in the machine env |
| PR-13 | Production image ships dev dependencies | post-deploy | Advisories reachable only through tooling nothing starts; the fix is a major downgrade the prohibitions forbid; loses nothing by waiting |
| N-1 | Five dev scripts build their own `Pool` without PR-1's error listener | post-deploy | Operator-attended scripts whose crash is visible to the person who typed the command; three are Anthropic-calling and a fix would ship unverified |
| N-2 | `errorSummary`'s `JSON.parse` branch leaks ~10 chars of model output to the log | post-deploy | Log-only, never stored or served; Fly log retention is days, so nothing becomes unrecoverable; the fix narrows the redaction every log path routes through - the largest blast radius on the list for the smallest measured exposure |
| N-3 | Duplicate-image index makes re-capturing the same paper order-dependent | post-deploy | Correct behaviour needing documentation, not code; no data at risk |
| N-4 | Three hygiene items (deprecated `routePath`, duplicated `isMissingObject`, a re-wrapped artifact quote) | post-deploy | No runtime behaviour changes with data in production |
| N-5 | Pre-routing refusals log `route: "unmatched"` | post-deploy | Status code already separates the cases; a log-consumer nicety |
| R2-2 | Export CSV has no formula-injection defence | **settled by decision this pass** | The reserved question was decided, not deferred: the export stays byte-faithful - §3. Not deploy-blocking either way: the residual risk starts with the first export, and the decision is now recorded and pinned |
| R2-3 | V8 heap ceiling (~1120 MiB) vs the 891 MiB export measurement | post-deploy | Zero receipts exist at first deploy and exports grow with data over months; unfixable from inside the repository (machine size or export architecture); the 256 MiB export budget bounds a single export today |
| PR-9(b) | No statement timeout | post-deploy by construction | Closing it requires measuring `generateExport` against the deployed Neon at a realistic row count, which cannot exist before the deploy; a guessed value truncates an export, which is worse than the absence |

**One deploy-blocking item (PR-8), fixed.
One reserved decision (R2-2), decided.
Eleven post-deploy items, documented and untouched.**

---

## 2 · PR-8 settled: the health check is liveness only

**Commit `f6ffa39`** - `GET /health` answers a constant `200 {"status":"ok"}` from the process itself; `[[http_service.checks]]` in `fly.toml` probes it every 30 s with a 60 s grace period covering the boot probes' worst case.
Full decision record: `docs/DECISIONS.md` 2026-08-15, spec §6 (route table) and §10B (startup paragraph), same commit.

**How the constraints were weighed.**

- *Disclosure.* The body is a constant, so an unauthenticated caller learns nothing about backing-service state and no failure differentiates - structurally, not by policy.
- *Neon autosuspend.* A database-pinging check at 30 s cadence never lets the ~5-minute autosuspend fire, converting the check into a standing compute bill (the same reasoning that set the LLM sweep's interval at six hours); pinging rarely instead wakes the compute on every probe and buys churn for no savings. So the check re-asks nothing the boot probes answer: R2-1 already refuses to bind the port until both services respond, and a restart - the only remedy a failed check can trigger - lands back in those probes, whose crash-loop is already the visible signal for a dead backing service.
- *Cheap, unauthenticated, no amplification.* No I/O, no session, no body; a hostile caller hammering it costs HTTP parsing alone.
- *Edge secret.* The route is registered above the edge-secret middleware because Fly's checker probes the machine directly and cannot carry the Cloudflare header - `fly.toml` is committed, so a check header cannot hold a secret.
- *What it forgoes, accepted and recorded:* a process whose database dies mid-life still answers 200; that gap is covered by the request log's 500s and the client's honest-failure UI.

**Mutation evidence** (each mutation applied to the real source, run, and reverted; predictions written first):

| Mutation | Predicted | Actual |
|---|---|---|
| Delete the route registration | 4 of 5 tests fail on 404 | **3 failed** - gap: the no-store test asserts only the header, and a 404 carries `no-store` too, so it survived |
| Move the route below the edge-secret middleware | only "answers without the edge secret" fails, on 403 | exactly that, 1 failed / 4 passed |
| Make the handler read `deps.db` | "touches neither the database nor object storage" fails | exactly that (the throwing proxy fired) |
| Strip the `[[http_service.checks]]` block from `fly.toml` | the wiring test fails | exactly that |

---

## 3 · R2-2 settled: the export CSV is not mutated

**Commit `1cfd54d`** - decision only, plus the tests that make it executable.
Full record: `docs/DECISIONS.md` 2026-08-15, spec §8 bullet, same commit.

**The decision.** Fields beginning `=`, `+`, `-` or `@` are exported byte-for-byte in both files.
**The tradeoff, stated:** the CSV is an accountant-facing tax artifact whose spec-stated purpose is import into accounting software, and every available defence mutates the record - the standard `'` prefix arrives in the books as part of the vendor's name, silently and for the six-year life of the record, in exactly the artifact whose job is fidelity.
Against that, not mutating leaves a formula-injection vector for a human who opens the CSV in a spreadsheet - but the artifact spec §8 designates for humans is the XLSX, which ExcelJS writes as string cells (round 2's measurement, now pinned by test), and constraint 2 means every exported string passed a human's eyes on the confirm screen, so the strings are not attacker pass-through.
A corrupted tax record is this project's top-of-scale harm; a `#NAME?` cell is recoverable by opening the XLSX in the same zip.

**Mutation evidence:**

| Mutation | Predicted | Actual |
|---|---|---|
| Add the standard `'`-prefix defence to `csvField` | the CSV-fidelity test fails on `'=1+1` | exactly that: `expected ''=1+1' to be '=1+1'` |
| Write the vendor as an ExcelJS formula cell | the XLSX test fails on cell type 6 (Formula) vs 3 (String) | exactly that: `expected 6 to be 3` |

---

## 4 · Runbook: the first-deploy operator checklist

**Commit `173cf72`** - `docs/Runbook.md` §1 gains "First deploy only: the operator checklist": confirming the R2 token can read from its bucket (what to observe in `fly logs` on the pass and fail paths of the boot probe, then `storage:probe-keys` for a real read-write exercise), choosing and scheduling the `pg_dump` destination with the verification pointed at the scheduled dump's own file, and the Neon plan decision with PITR named as an hours-scale history window that is no part of the retention story.
`fly checks list` joins the deploy confirmation, subordinate to the `curl` 401 check.

**Two stale lines corrected in the same file, both the "prose describing behaviour the code does not have" class round 3 hunted:**

- Runbook §0 still said the storage probe is "a read-only `HeadBucket`" - the probe moved to `GetObject` on 2026-08-11 (round 2, ASSUMPTION 9) and R3-1 corrected the refusal message in `src/index.ts` while this sentence, describing the same probe, was missed.
- Runbook §7's request-log line shape omitted `sessionPresented`, which R3-2 added on 2026-08-11.

---

## 5 · The gate

Predictions written before looking; commands run from `server/` at `173cf72`.

| Gate | Predicted | Actual | Match |
|---|---|---|---|
| `npm test` | 306 green / 32 files (299 + 5 health + 2 formula) | **306 passed / 32 files** | yes |
| `npm run typecheck` | clean | **exit 0** | yes |
| `npm audit` | 6 moderate | **7 (6 moderate, 1 high)** | **no - gap below** |
| `npx drizzle-kit check` | clean | **"Everything's fine", exit 0** | yes |

**The audit gap.** The high is `nanoid <3.3.18` (GHSA-2v37-7h3g-55p8, custom generators loop when size is 0), via `vitest → vite → postcss` - published upstream after round 3's gate; `package-lock.json` is unchanged since `62699f2`.
Dev-tooling chain, nothing in this codebase calls nanoid, fix available via a plain `npm audit fix`.
Flagged for the backlog rather than fixed: not deploy-blocking, and this pass fixes only what is.

**The fifth gate: the real entrypoint, started the real way.**
`.env.local` minus `ANTHROPIC_API_KEY` copied to the scratchpad, key confirmed absent, seven variables present; port 3041.

Predicted: storage-probe line, no-key notice, `Kept API listening on port 3041`; `GET /api/me` → 401 + `cache-control: no-store`; `GET /health` → 200 + `no-store` + exactly `{"status":"ok"}`; request-log lines with `route":"/health"` and `route":"/api/me/*"`, both `sessionPresented:false, authenticated:false`.

```
$ PORT=3041 node --env-file=<.env.local minus ANTHROPIC_API_KEY> --import tsx src/index.ts
Object storage: checking http://dev-mac.local:9000 for bucket "kept"
ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only
Kept API listening on port 3041

$ curl -s -i http://localhost:3041/api/me
HTTP/1.1 401 Unauthorized
cache-control: no-store
{"error":{"code":"unauthorized","message":"A valid session token is required"}}

$ curl -s -i http://localhost:3041/health
HTTP/1.1 200 OK
cache-control: no-store
content-length: 15
{"status":"ok"}

# the request log the same run emitted
{"msg":"request","method":"GET","route":"/health","status":200,"durationMs":2,"sessionPresented":false,"authenticated":false}
{"msg":"request","method":"GET","route":"/api/me/*","status":401,"durationMs":1,"sessionPresented":false,"authenticated":false}
```

Actual matched the prediction with no gap; port 3041 was confirmed released after the process was stopped.

---

## 6 · Found along the way, against what the ledgers claim

- **`PROD-READINESS-ROUND-3.md` and the Runbook disagreed about the storage probe.** Round 3 closed R3-1 as "the storage refusal names the wrong permission" and fixed one template literal in `src/index.ts`; `docs/Runbook.md` §0 described the same probe as `HeadBucket` and was not on R3-1's fix list. The hunt round 3 ran ("what does this codebase assert in prose and nowhere else") did not cover the Runbook. Corrected at `173cf72`.
- **The Runbook's request-log line shape predated R3-2** (no `sessionPresented`), same commit.
- **Round 3's gate arithmetic holds** - 299/31 reproduced exactly at this pass's baseline before any change.
- **`npm audit` is no longer "6 moderate"** - see §5; the ledgers' number was true when written and is stale now through no fault of theirs.

## 7 · Commits

| SHA | What |
|---|---|
| `f6ffa39` | Add a liveness health check and point Fly's HTTP check at it |
| `1cfd54d` | Decide the export CSV stays byte-faithful and pin it with tests |
| `173cf72` | Add the first-deploy operator checklist to the Runbook and correct two stale lines |

The branch stays local and unmerged; nothing was pushed and nothing deployed.
