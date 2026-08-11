# Stage 0 adversarial review - `prod-readiness/round-3` (7035141..e7548ba)

## Scope of the change, verified independently

`git diff --name-status 7035141..HEAD` returns exactly two additions: `PROD-READINESS-ROUND-3.md` (527 lines) and `reviews/round3/BASELINE.md` (128 lines). No code, no schema, no config, **no `ios/` path**, no dependency change. Both commits are authored by 8C9D, both messages are one sentence, neither carries an AI-attribution trailer.

## Gates re-run from `/Users/<user>/dev/kept/server`, not taken from the ledger

| Gate | Baseline given to me | I measured | Verdict |
|---|---|---|---|
| `npm test` | 289 / 31 files | **289 passed, 31 files** | reproduces |
| `npm run typecheck` | clean | **exit 0, no output** | reproduces |
| `npm audit` | 6 moderate | **6 moderate** (esbuild via drizzle-kit and vitest, uuid via exceljs) | reproduces |
| `npx drizzle-kit check` | clean | **"Everything's fine", exit 0** | reproduces |
| Entrypoint (fifth gate) | boots, 401 on `/api/me` | **reproduces on port 3041**, storage probe line then no-key notice then listen; `curl` → 401 + `cache-control: no-store` | reproduces |

`ANTHROPIC_API_KEY` was withheld from every process I started, via a scratchpad copy of `.env.local` with that line stripped (`grep -c '^ANTHROPIC_API_KEY'` = 0, 7 variables remain - which also confirms BASELINE.md:71). No Anthropic call was made, no `parse-llm-*` script was run, no non-local service was contacted. Ports 3041/3042/3043 were used and released.

## Reproductions the ledger claims, re-run rather than read

- **R3-1** (`PROD-READINESS-ROUND-3.md:99-108`). Booted with a deliberately wrong `STORAGE_SECRET_ACCESS_KEY`, `EXIT=1`. The refusal prints `...that the token is permitted to read the bucket's metadata (see ASSUMPTIONS in PROD-READINESS-ROUND-2.md)` and the cause carries `Code: 'SignatureDoesNotMatch', Key: '.startup-probe/reachability'`. **The finding is real and the `Key:` proof holds.**
- **§0's R2-1 re-exercise** (`:44-51`). `STORAGE_BUCKET=no-such-bucket-round3review` → `NoSuchBucket`, `EXIT=1`, `docker exec kept-minio ls /data` returns `kept` before and after. **No bucket conjured. Holds.**
- **PR-9(a)** (`:227`). `max: 10 | idleTimeoutMillis: 10000 | connectionTimeoutMillis: undefined | statement_timeout: undefined` - verbatim match.
- **R2-4** (`:277-279`). `ssl: undefined` - verbatim match.
- **R2-3** (`:39`). `docker run --rm --memory=2g node:24-slim` → `heap_size_limit MiB: 1120` - to the megabyte.
- **PR-12** (`:203-216`). Minted a token signed with the **real** `SESSION_JWT_SECRET` carrying `sub: "not-a-uuid"`, `tv: 1`: **status=500**, log shows `code=22P02 routine=string_to_uuid`. No header → 401. Forged token → 401. Reproduces.
- **R3-2** (`:143`). Same run: no-token 401 and forged-token 401 both log `"authenticated":false`, indistinguishable. Reproduces.
- **NOT DEFECTS, no secret leaked** (`:400`). `grep -c` for the wrong secret over the full R3-1 crash dump: **0**.

## Test mutation (required, and done)

The stage cites exactly one test: `tests/integration/exportable.test.ts:36-39` (`grep "test\.ts\|tests/"` over both artifacts returns one hit, line 402). I copied `server/` to the scratchpad, symlinked `node_modules`, confirmed 4/4 green, then **deleted `eq(receipts.status, "confirmed")` from `src/db/receiptQueries.ts:33`**. The test failed with `+ "Pending", + "Defaulted"` at `exportable.test.ts:42`. **The assertion can fail, and it covers both the explicit-pending and the omitted-status case as claimed.** No option-override/default divergence applies - the test calls the query directly with no injectable defaults.

## Citations: all re-resolved against live source

I re-resolved every file:line in the ledger. `src/index.ts:96-101`, `:183`, `:117-123`; `s3ObjectStorage.ts:180-190`, `:192-195`, `:267-273`, `:273`, `:280-286`, `:300-308`, `:143`/`:149-162`; `requestLog.ts:22-24`, `:56-61`, `:62`, `:66`; `sessionAuth.ts:43`, `:49`; `session.ts:52`; `db/client.ts:11`, `:57-59`, `:30`; `receipts.ts:143-152`, `:404-408`, `:409-411`, `:415-423`; `receiptQueries.ts:10-11`; `exports.ts:127`, `:142`, `:147-153`; `objectKeys.ts:116-126`; `generateExport.ts:111`, `:117`, `:223-227`, `:237-246`, `:258-264`; `productionEnv.ts:51-57`, `:59-65`; `Dockerfile:15-23`, `:16-19`, `:27`; `fly.toml:13-21`, `:23-28`; `drizzle.config.ts:9`; `schema.ts:75`, `:187-189`; `writeFiles.ts:87-93`; `errorSummary.ts:79-85`, `:105-119`; `http/schemas.ts:149-152`; `llmParseSweep.ts:9/147/228/246`; `app.ts:73`; the five N-1 pool sites; `docs/Kept-Build-Spec.md:581`; `docs/DECISIONS.md:70` (confirmed under the `## 2026-08-10` heading at `:40`). **Every one says what it is claimed to say.** The `diff` claim for N-4(b) is literally true - the two `isMissingObject` bodies are byte-identical. `grep -rE 'SIGTERM|SIGINT|server\.close|process\.on\('` over `src/` returns nothing, as PR-5 states. `assertIssuedObjectKey` has exactly two call sites; `exportObjectKey` exactly one.

**No finding is fabricated. No finding is unreproducible. No severity is indefensible. No feature is smuggled into a fix description. No prohibited action was taken.**

## Findings

**RV3-A · P2 · An ASSUMPTION marked verified points at an artifact that does not exist**
`PROD-READINESS-ROUND-3.md:375` reads "**verified by building and running the image**, not assumed. See the artifact under §7." §7 (`:440-471`) contains no image build, no container run, no `id`/`ls -l` output - only a blast-radius label in a table cell at `:452`. `grep -rniE 'docker build|USER node|uid=1000|non-root'` over both round-3 files returns exactly one hit, and it is the *proposed fix* text at `:260`. I verified the first half independently (`docker run --rm node:24-slim id node` → `uid=1000(node) gid=1000(node)`), but the second half - "`/app` is world-readable after `npm ci`" - is the half that decides whether PR-7's one-line `USER node` actually boots, and nothing anywhere supports it. This is the "resolved without an artifact" class, on the only `DEPLOY-CONFIG` item on the frozen list. **Recommend:** either produce the build-and-run artifact or restate ASSUMPTION 8 as unverified.

**RV3-B · P2 · §7's status table enumerates 21 items against a stated total of 20**
`:465-469`: 8 FROZEN + 10 P2 DOCUMENTED + 3 P3 DOCUMENTED = 21. PR-9 is counted twice - `PR-9(a)` at `:467` and `PR-9(b)` at `:468`. §8 `:479-480` enumerates 12 carrying and `:482` states PR-9(b) "is not a thirteenth finding", so the table contradicts §8. The bullet arithmetic at `:459-463` is correct and I recounted it against ROUND-2 `:475`, which does list 18 ids. The defect is confined to the table. **Recommend:** mark the PR-9(b) cell as the deferred half, or drop it from the row.

**RV3-C · P2 · "Two candidates were re-measured" is three**
`:36` says two and names PR-9 and R2-3. `:274` gives R2-4 the identical treatment with the identical justification - "*Re-measured this round*, because it is a claim about `pg` rather than about this repository" - and a `node -e` measurement at `:277-279`. I reproduced all three. The enumerated set at `:36` undercounts by one. This is the exact class the previous round shipped.

**RV3-D · P2 · §9's "the two that had drifted" names one that had not**
`:509` reads: "The two that had drifted are corrected there... **PR-4** is `routes/exports.ts:147-153` (round 2 cited `:150-153`...), and **R2-4**'s pair is `productionEnv.ts:51-57` and `:59-65`, **which round 2 cited correctly**." Verified against ROUND-2: `PROD-READINESS-ROUND-2.md:135` cites `exports.ts:150-153` (drifted), `:462` cites `productionEnv.ts:51-57` (did not). One drifted, not two. The sentence contradicts itself.

**RV3-E · P2 · PR-4's blast radius understates the failure mode on the list route**
`:199` says "A stored key that does not match becomes a 500 instead of a presigned URL." `downloadUrlFor` is called at `server/src/routes/exports.ts:126-128` inside `Promise.all` over up to 50 rows (`.limit(50)` at `:125`), and `assertIssuedObjectKey` *throws* (`src/storage/objectKeys.ts:116-125`). So a single corrupt stored key does not fail one job - it fails the whole `GET /api/export` history list, making every other export the user has unreachable through that route. `GET /api/export/:id` degrades per-row as described; the list route does not. **Recommend:** either state this in the blast radius, or scope the assertion so a bad row degrades to `downloadUrl: null` for that job alone.

**RV3-F · P3 · PR-9(a) is the only frozen finding with no severity justification**
`:220-245` has *Evidence*, *What makes it load-bearing*, *This finding is split*, *Fix*, *Blast radius* - and no "*Why P2*". All seven others have one (`:113`, `:146`, `:171`, `:188`, `:211`, `:256`, `:284`). The ledger's own rubric at `:18` requires it, and P1 is arguable on the rubric's own "fails under realistic load or edge input" clause, which `:235` describes verbatim. The grade may well be right; it is the only one not defended.

**RV3-G · P3 · R3-2's proposed fix would rewrite a historical `DECISIONS.md` entry**
`:154`'s blast radius is "plus the three prose sites that describe it", the third being `docs/DECISIONS.md`'s 2026-08-10 entry (`:132`; confirmed at `docs/DECISIONS.md:70` under the `## 2026-08-10` heading at `:40`). `CLAUDE.md` calls that file "the append-only log of how we got here". Editing a past entry to match new behaviour erases what was decided then. The shape the same rule requires is a *new* entry plus the spec amendment (`docs/Kept-Build-Spec.md:581`) in the same commit. Worth settling before pass 5 runs, not after.

**RV3-H · P3 · "five receipt routes" is six**
`:167`. `grep -n "router\.\(get\|post\|patch\|delete\|put\)" src/routes/receipts.ts` returns six: `:58` POST /upload-url, `:80` POST /, `:171` GET /, `:251` GET /:id, `:305` PATCH /:id, `:398` DELETE /:id. The load-bearing half - no image-delete route - is true, and I confirmed the create path inserts exactly one image (`receipts.ts:134`).

**RV3-I · P3 · "`connectionTimeoutMillis: undefined` becomes `0`" is not what pg does**
`:230`. `node_modules/pg-pool/index.js:206` and `:250` are both `if (!this.options.connectionTimeoutMillis)` - the value stays `undefined`, is tested for falsiness, and no timer is armed. There is no coercion to `0`. The conclusion ("wait forever") is correct. The mechanism as written is not, and this round's whole method (§0's hunt, `:57-72`) is that prose describing behaviour the code does not have is a finding.

**RV3-J · P3 · House style: em-dash rule clean, one-sentence-per-line rule not**
Em dashes: **zero** in either added file, and `git diff 7035141..HEAD | grep -c '^+.*—'` = 0. The claim at `:404` that round 2's own added lines carry zero reproduces (`b23ea08..7035141` → 0). The one-sentence-per-line rule in `/Users/<user>/.claude/CLAUDE.md` is broken on 12 paragraph lines (excluding list items, tables, code and headings, where the rule yields to Markdown structure): `PROD-READINESS-ROUND-3.md:32, 118, 154, 199, 245, 261, 295, 312, 323, 348, 356` and `reviews/round3/BASELINE.md:29, 64`. Round 2's ledger breaks it at roughly 2.5x the rate, so this is an improvement rather than a regression - but it is not clean.

## Two risks I am recording without grading

- **R2-4 is the one boot-blocking fix on the list**, and §5 `:416` admits this run cannot know whether it would refuse the *current* deploy. The ledger's distinction at `:289-292` from round 2's `HeadBucket` trap is sound (an operator-set string versus a third-party-granted permission), and ASSUMPTION 7 states the risk honestly. Flagging so the fix pass verifies the accepted spellings against a real Neon-shaped URL rather than only against a test.
- **PR-9(a) freezes an unmeasured constant while PR-9(b) is deferred for being one.** ASSUMPTION 5 grounds the value in Neon's published wake latency, and no number is named anywhere in the ledger. The asymmetry is defensible but unstated.

---

**PASS-WITH-FINDINGS**

The stage may proceed. All four gates plus the entrypoint gate reproduce exactly; every citation resolves; every reproduction re-runs; the one cited test dies under mutation. Nothing is fabricated and no severity needs to move. Before pass 1 opens, correct **RV3-A** (produce the image artifact or restate ASSUMPTION 8 as unverified), **RV3-B**, **RV3-C** and **RV3-D** (the three enumeration and self-contradiction defects) and **RV3-E** (PR-4's understated blast radius, which changes what the fix has to do). RV3-F through RV3-J are corrections to make in the same edit, not blockers.
