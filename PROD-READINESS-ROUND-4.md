# Production-readiness round 4 - the post-deploy pass

2026-08-20, two days after distribution day, four days after the first deploy.
The 2026-08-15 deferral said this round waits for production evidence or for the owner to ask; the owner asked, in a session whose instruction also authorized production-touching steps.
Scope: `server/`, `ios/` (first round permitted to read it), `docs/`, and - a first for a hardening round - the deployed system itself: the fixes below ship to production at the end of this pass, and wave-6 §3 step 17 is executed to the boundary of what a machine can do (its record: `docs/DECISIONS.md` 2026-08-20, Runbook §1/§4, wave-6 §3).

**The work list is the eleven carried findings** (`DEPLOY-PREP.md` §1, DECISIONS 2026-08-15), plus the three round-3 §8 not-yet-findings observations, the `nanoid` audit advisory, and PR-6's ios/ half.
Every definition was re-read in the round ledgers rather than guessed.
Build execution was fanned out to parallel implementer agents, one disjoint file set each, every fix landing with mutation evidence in its section below; the integration, review of every diff, all documentation, the gates, and the deploy are this session's own.

---

## 1 · Disposition of the eleven

| Finding | One line | Disposition |
|---|---|---|
| PR-5 | No SIGTERM drain | **Fixed** - §2.1 |
| PR-6 | Severed-but-committed create retried gets 409 | **Closed by verification, no change** - §2.2. The remedy has existed in `ios/` since wave 5 |
| PR-10 | `drizzle.config.ts` falls back to localhost | **Fixed** - §2.3 |
| PR-13 | Production image ships dev dependencies | **Fixed, without the forbidden downgrade** - §2.4 |
| N-1 | Five dev scripts build their own `Pool` | **Fixed** - §2.5 |
| N-2 | `errorSummary` renders ~10 chars of model output | **Fixed at the throw site** - §2.6 |
| N-3 | Duplicate-image order-dependence undocumented | **Documented** - §2.7 |
| N-4 | Three hygiene items | **All three closed** - §2.8 |
| N-5 | Pre-routing refusals log `route:"unmatched"` | **Fixed** - §2.9 |
| R2-3 | V8 heap ceiling vs the 891 MiB export measurement | **Still deferred, trigger re-verified** - §4 |
| PR-9(b) | No statement timeout | **Still deferred, trigger re-verified** - §4 |

Also closed: round-3 §8 observations 1 (the `src/index.ts` throw-vs-`errorSummary` asymmetry - fixed with PR-5, same file) and 3 (probe-key disjointness untested - now a 5-case unit test); observation 2 was N-4(b) itself.
The `nanoid` high advisory and the rest of the audit surface: §3.

---

## 2 · The fixes, each with its falsification evidence

### 2.1 PR-5 - graceful shutdown *(see §7 for the commit)*

`src/index.ts` now handles SIGTERM and SIGINT: one stated log line, stop accepting, drain in-flight requests under a cap chosen to fit inside Fly's default 5 s `kill_timeout`, end the pool, exit 0; a second signal forces immediate exit. The same commit closes round-3 §8 observation 1: the storage-probe failure branch follows the database branch's `errorSummary` + named-sentence + `exit(1)` pattern instead of throwing raw.
Evidence: a new entrypoint test sends SIGTERM to the real spawned server and asserts exit code **0** (default SIGTERM death is by signal, not 0 - the assertion discriminates), the drain line, and the released port; mutation (handler removed) kills it.

### 2.2 PR-6 - closed by reading the code the ledgers could not

Round 1 filed the open question verbatim: "check `OutboxController`'s classification of 409 before PR-5/PR-6 are called closed."
Read this round: `OutboxController.advance` catches an `APIError` whose code is `duplicate_image` **on the create step and only there** (a reviewer finding already pinned the scoping: a 409 anywhere else must not delete a receipt that was never created), counts the receipt server-confirmed, and removes the item - exactly RULING 4's "reconcile against the list, not re-send," implemented since wave 5.
`testRelaunchAfterKillBetweenCreateAndCleanupLandsOn409AndCountsSaved` pins it: store emptied, `serverConfirmedCount` 1, no error entry. The iOS suite ran green this round (209 tests).
RULING 4's alternative - the server answering the existing receipt instead of 409 - is **rejected now that the classification is verified**: it would change a documented response code to solve a problem the client demonstrably does not have.
⚠ Forward constraint, recorded so it survives to wave 7: the *web* client's multi-file upload must NOT inherit 409-as-saved blindly - on that path a duplicate means "you already uploaded this file," a user-facing fact, not a lost 201.

### 2.3 PR-10 - the fallback stays, production refuses

`resolveDrizzleDatabaseUrl` (new, `src/db/drizzleDatabaseUrl.ts`): `DATABASE_URL` verbatim when set; under `NODE_ENV=production` with it unset, a refusal naming the variable in the entrypoint's message shape; otherwise the localhost fallback that keeps a clean checkout working.
Found on the way: the ledger's "fails loudly rather than corrupting" was generous - measured pre-fix, drizzle-kit against a dead loopback prints a stalled spinner and exits 1 with **no cause at all**. Post-fix the same invocation prints the refusal.
Evidence: 10 unit tests, three mutations killing 4/2/4 of them as predicted; `npx drizzle-kit check` with no `DATABASE_URL` still passes (the clean-checkout property, proven at the tool level).

### 2.4 PR-13 - the image drops dev dependencies without downgrading anything

Every round recorded "the fix is a major downgrade the prohibitions forbid" - true of `npm audit fix --force`, and not the only fix. `tsx` and `drizzle-kit` are runtime dependencies of the deployed machine (the entrypoint runs through tsx; migrations run from the machine), so they move to `dependencies`, and the Dockerfile runs `npm ci --omit=dev`: vitest, vite, adm-zip, the type packages and their advisory chains leave the image; nothing is downgraded.
Evidence: the image builds, boots against the dev database and MinIO the wave-6 §1.2 way, and answers; `node_modules` in the image carries no `vitest`/`vite`. (Verification detail in §5's gate.)

### 2.5 N-1 - all five scripts through `createDb`

`seed.ts`, `claim.ts`, `parseAccuracyReport.ts`, `llmParseProbe.ts`, `llmPromptReparse.ts` now construct their pool via `createDb`, inheriting PR-1's error listener and PR-9(a)'s connect timeout; refusals, output, and ordering byte-identical. Round 3 deferred this on "three of the five are Anthropic-calling, so a fix ships unverified" - re-measured, that was an overcount: **two** are Anthropic-calling, and both check `ANTHROPIC_API_KEY` at module top ahead of any pool, so with no key they refuse before constructing anything.
Verification: the three non-Anthropic scripts ran their full real paths against a throwaway loopback database (seed 2 users/5 receipts inspected in Postgres; the accuracy report end to end including its no-real-user refusal; claim both refusal and full write path); the two Anthropic scripts ran to their key refusals with the key deliberately absent - their pool line is reached by no run this round, stated rather than smoothed over.
The gap found while fixing: nothing pinned the routing - re-adding `new Pool` to a script would have failed no test, which is how the defect survived PR-1 and PR-9(a). `tests/unit/poolRouting.test.ts` now asserts no file in `src/` outside `client.ts` constructs a pool (a sixth script written later is covered) and that the five reach `createDb`; mutation (seed reverted to `new Pool`) kills both assertions.

### 2.6 N-2 - fixed where the message is written, not where it is redacted

Round 3's deferral reason was blast radius: `errorSummary` redacts every log path. So `errorSummary` is untouched; the one throw site handing it a message it did not write - `claudeReceiptParser`'s `JSON.parse` catch - now rebuilds the cause as `` `${name} [message withheld]${" at position N"?}` ``. V8's message families make the trade clean: the snippet-carrying family never has an offset, and every prose-reason family does, so the offset stands in exactly where prose existed and the case that loses everything but the class name is the one whose message was pure receipt content.
Confirmed unchanged: `redactedMessage` (what reaches `export_jobs.error` and the stored failure record) never walked the cause - those paths were already clean, verified against a real stored row.
Evidence: `logHygiene.test.ts` now asserts the branch's cleanliness with a sentinel sized to V8's quote window (`"Dr Smith"` - the full vendor never fit, so asserting on it would pass over a real leak) and pre-asserts the leak exists at its source so a Node wording change cannot make it vacuous; reverting the fix kills it.

### 2.7 N-3 - the ordering rule is now written where an operator looks

The delete-then-recapture rule (a byte-identical re-upload 409s until the old receipt is deleted; re-photographed paper never collides) is now stated in Runbook §6 and beside §5's constraint note in the spec, with REVIEW-FINAL X-1's scope honestly carried: the rule matters only for the identical-file sub-case.

### 2.8 N-4 - all three

- **(a)** `requestLog` reads the `routePath` helper from `hono/route` instead of the deprecated getter - same index, same value; a wrong-index mutation dies against the route-pattern test.
- **(b)** `ObjectNotFoundError` is the `ObjectStorage` contract for absence, documented on `download` itself: the S3 adapter translates once at the boundary (raw error kept as `cause`), the export path asks `instanceof`, the probe shares the adapter's single internal predicate, and the byte-identical duplicates are deleted. The test fake now honours the contract too, which is the point - a non-honouring adapter is caught by test (mutation M3), where before it would silently turn every missing photo into an unexplained export failure. The export path's load-bearing distinction (absence names the receipt and the delete-first remedy; a timeout reports as itself) is re-verified on both branches, including a refused-credential case against real MinIO.
- **(c)** The re-wrapped artifact block in `PROD-READINESS.md` §R-1 carries a dated annotation naming it a hand-wrapped rendering rather than verbatim server output; the original response is unrecoverable, so honesty about the rendering is the close available.

### 2.9 N-5 - refusals name themselves

The edge-secret 403 logs `route:"refused:edge-secret"`, the body-limit 413 `route:"refused:body-limit"`, via one typed `markRefused` both middlewares call; `"unmatched"` now means a genuine 404 and nothing else. No label carries any part of the request. The production stake is the one REVIEW-FINAL measured: a Transform Rule that stops adding the header now reads as a run of `refused:edge-secret` lines instead of blending into 404 noise.
Evidence: all three lines pinned by test with real artifact output four-for-four against prediction; six mutations (label preference dropped, labels swapped, path leaked on either branch, wrong route index, `/*` mapping dropped) each killed exactly the predicted assertions. Runbook §7 and spec §10B amended in the same commit.

---

## 3 · The dependency surface

`npm audit` at this round's start: 7 advisories (6 moderate, 1 high). Dispositions:

- **`nanoid` <3.3.18 (high, vitest chain)** - fixed by plain `npm audit fix`, as deploy-prep's gate said it would be.
- **`uuid` <11.1.1 via `exceljs` (moderate)** - see §5 gate notes: resolved by override if the export suite proves it, otherwise documented as unreachable (the advisory is v3/v5/v6 with a caller-supplied buffer; nothing in the export path calls those).
- **`esbuild` <=0.24.2 chain via `drizzle-kit` (4 moderates)** - the advisory is esbuild's *dev server*, which nothing in any environment starts; npm's only offered fix is drizzle-kit 0.18, a major downgrade. Unchanged from PR-13's original acceptance, now with a smaller blast radius because the production image no longer ships the vitest/vite half of the chain.

---

## 4 · Still deferred, with the triggers re-verified rather than re-argued

- **R2-3** (heap ceiling vs export size) and **PR-9(b)** (statement timeout) both wait on the same fact that does not exist: production holds **zero receipts** (read from the production database this round), so no realistic fiscal-year export can be measured, and both findings' own ledgers reject a guessed number. The 2026-08-15 triggers stand verbatim: the first real fiscal-year export's size and peak memory decide R2-3; the statement timeout is set above `generateExport`'s measured worst case against deployed Neon, never at a round number, and R2-3 reopens before any raise of the 256 MiB export budget.

## 4a · Residuals recorded by this round's own work

- **zod's `unrecognized_keys` issue echoes the key name the model invented** (`claudeReceiptParser`'s validation branch). Far narrower than N-2 - keys are model-chosen, not OCR-echoed - and left alone deliberately; recorded so the next log-hygiene pass starts from it.
- **`verifyRestore.ts` labels every download failure `MISSING`** - the same absence-vs-unreachable conflation N-4(b) just removed from the export path, on an operator script whose §4 drill this round exercised only at zero images. Recorded, not fixed unverified.
- **The two Anthropic-calling scripts' pool-construction line is executed by no run this round** (§2.5) - covered by typecheck and the routing test; their first keyed run verifies it live.
- **`pg` 8.16 warns that `sslmode=require` is treated as `verify-full` until pg 9** - surfaced during the restore drill against Neon. Today's behavior is the stricter one; revisit at the pg major bump.
- **The launchd backup agent refuses nightly until the owner's R2 token exists** - deliberate (DECISIONS 2026-08-20): a loud failure over a silent absence.

---

## 5 · The gate

*(Predictions written before running; commands from `server/` unless stated.)*

| Gate | Predicted | Actual | Match |
|---|---|---|---|
| `npm test` | 345-355 green / 37 files | **349 / 37** - but see the note below | yes, with one honest wrinkle |
| `npm run typecheck` | clean | exit 0, no output | yes |
| `npm audit` | 4 moderate after the fixes | **4 moderate** (the esbuild dev-server chain under drizzle-kit, accepted - §3) | yes |
| `npx drizzle-kit check` | clean | "Everything's fine", exit 0 | yes |
| iOS `KeptTests` | green (no iOS change was made) | **209 passed, 0 failures** | yes |

**The npm-test wrinkle, stated:** the first full run landed 348/349 with one failure while the §2.4 image-boot verification was concurrently hitting the same dev Postgres and MinIO; two immediately-following runs were 349/349 with nothing changed. Recorded rather than smoothed over: the failure was interference between two verifications sharing dev services, not a code defect, and the lesson is not to run them concurrently.

**The fifth gate - the real entrypoint, started the real way.** `npm run dev` from this checkout, `.env.local` loaded as the operator loads it: boot to `Kept API listening on port 3000`, one real `GET /api/me` → **401** with `cache-control: no-store` and its request-log line, then SIGTERM → `SIGTERM received - draining in-flight requests, then exiting`, exit, port 3000 free. All as predicted. The PR-5 agent additionally ran the Dockerfile's exec-form CMD verbatim with operator-set env and measured the same four facts (§2.1).

**The image gate (PR-13).** The built image: `vitest`/`vite`/`adm-zip` absent from `node_modules` (count 0), `tsx` and `drizzle-kit` present in `.bin`, and the container boots against the dev services to a 401-with-`no-store` `/api/me`, a 200 `/health`, and correct request-log lines - the wave-6 §1.2 procedure re-run against the slimmed artifact.

**The production gate - this round deployed.** `fly deploy` rolled machine `8270ddb535de08` to version 3: `fly status` started, `fly checks list` passing, `https://api.keptapp.net/api/me` → 401 + `no-store` through Cloudflare, and the naked origin still answering 403 `forbidden` without the edge header. Then the live falsification nothing pre-deploy could give: `fly machine restart` made the **deployed** process print `SIGINT received - draining in-flight requests, then exiting` and come back clean - PR-5 observed in production, and the agent's open PID-1 question (§2.1's report) answered in practice: Fly's stop signal reaches the node process and the handler fires.

**Step 17's own gate** ran under its own record (`docs/DECISIONS.md` 2026-08-20): the launchd agent's live run to the designed refusal, the MinIO rehearsal of the full upload path with the bytes re-downloaded and re-hashed, and the production restore drill matching its prediction exactly - including the vacuity refusal.

---

## 6 · What only the owner can do, unchanged by this round

1. **Step 17's last piece**: mint the R2 token scoped to `kept-backups` (dashboard → R2 → Manage R2 API Tokens → Object Read & Write → bucket `kept-backups`), paste both values into `~/.kept/backup.env`, `launchctl start net.keptapp.backup`, read `~/Library/Logs/kept-backup.log`, then run the Runbook §4 drill against that scheduled dump's file. The drill's image leg re-runs after the first receipt with an image lands in production.
2. **Step 18's gates**: accept the updated Apple Developer Program License Agreement as Account Holder; fill the contact address in `web/privacy/index.html` and deploy `web/` per its README (Cloudflare Pages, ~5 minutes; the privacy policy URL becomes `https://keptapp.net/privacy`); paste that URL into App Store Connect → App Information; then submit per wave-6 §3 step 18 with the Review Notes line, and file the unlisted request as Account Holder. ⚠ Step 18 remains the irreversible one.

## 7 · Commits

| SHA | What |
|---|---|
| `bb5dca8` | Drain in-flight requests on SIGTERM and SIGINT, then exit 0 (PR-5 + obs. 1) |
| `c12ae29` | Route the five direct-Pool dev scripts through createDb (N-1) |
| `2f641aa` | Make object absence an ObjectStorage contract, not an S3 spelling (N-4(b) + obs. 3) |
| `1b906d6` | Name pre-routing refusals in the log; withhold model output from the parse cause (N-5, N-4(a), N-2 - one commit because they meet in `logHygiene.test.ts`) |
| `ecd7916` | Refuse a production migrate with no DATABASE_URL instead of dialling localhost (PR-10) |
| `609b12e` | Ship the production image without dev dependencies; fix the fixable advisories (PR-13 + §3) |
| *(this commit)* | This ledger, the two DECISIONS entries, the spec/Runbook/wave-6/plist/CLAUDE.md amendments, and the N-4(c) annotation |

Deployed to production as machine version 3, 2026-08-21T03:41Z (§5).
