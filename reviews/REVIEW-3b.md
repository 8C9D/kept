# REVIEW 3b

Re-review of the remediated stage. Range `9673ce5..34da846`, reviewed at `HEAD = 34da8465eb1809813c323f2342db8ad2074d41d6`, branch `prod-readiness/2026-08-10`.
Working tree clean before and after (`git status --porcelain` empty both times); `HEAD` unmoved; nothing committed.

verdict: PASS-WITH-FINDINGS

REVIEW-3's P1 is genuinely closed, and the remediation went further than the rejection asked in a way I was able to confirm against the real S3 client rather than the fake.
What survives is one P2 about coverage - the entire fix now pivots on `error.name === "NoSuchKey"`, and nothing committed to this repository pins that to the real client - plus five P3s, one of which is REVIEW-3's own F-4 left untouched.
No finding here justifies a revert.

---

## What I re-ran, rather than accepted

| Gate | Result | Measured against BASELINE |
|---|---|---|
| `npm run typecheck` | exit 0, no output | matches baseline |
| `npm test` | **30 files, 276 passed, 0 failed, 0 skipped**, 21.4s (14.8s on the confirming re-run) | baseline 263/28; +12 from stages 1-2, +1 from this stage (the storage-outage test). REVIEW-3 measured 275/30; the delta is exactly the one test the remediation added |
| Real entrypoint (guardrail 7) | booted on port 3003 from a copy of `.env.local` with `ANTHROPIC_API_KEY` stripped: `ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled` then `Kept API listening on port 3003`; `curl -s -i http://localhost:3003/api/me` → `HTTP/1.1 401`, `cache-control: no-store`, `content-length: 79` | identical to baseline's boot and probe |
| **Real MinIO probe of the fix's central assumption** | `name="NoSuchKey"`, `Code="NoSuchKey"`, `message="The specified key does not exist."`, status 404 | not in baseline; this is the link the fake cannot prove, so I proved it |
| **Real MinIO probe of the three misconfiguration cases** | wrong bucket → `NoSuchBucket` (isMissingObject=false); bad credentials → `SignatureDoesNotMatch` (false); endpoint down → connection error (false) | none is misdiagnosed as a missing photo |
| Falsification of both stage tests | seven independent edits, each restored | n/a |

Port 3000 was left alone.
No Anthropic call was made - the key was stripped from the env copy before boot, verified with `grep -c ANTHROPIC` returning 0, and the copy was deleted afterwards.
No remote exists (`git remote -v` empty), `git merge-base --is-ancestor 9673ce5 34da846` succeeds, no history was rewritten, nothing was committed, no dependency was touched (`git diff --name-only 9673ce5..34da846 -- '*package*.json'` returns 0 files), and no file outside this one was created or modified.
Only local Postgres (`kept-db`) and local MinIO (`kept-minio`) were contacted.

## Contract checks that came back clean

- **iOS files touched.** No. `git diff --name-only 9673ce5..34da846 -- ios/` returns 0 files. The full range is `PROD-READINESS.md`, `reviews/REVIEW-3.md`, `server/src/export/generateExport.ts`, `server/tests/helpers/fakeObjectStorage.ts`, `server/tests/integration/export.test.ts`.
- **Feature smuggled in.** No. `isMissingObject` is a module-private function. No route, no schema key, no table, no column, no config key, no CLI flag.
- **Anthropic API call.** No. No path in the diff reaches `src/parse/*`; the entrypoint was started with the key withheld and said so at boot.
- **Prohibited actions.** None found. Linear history, no remote, no credential touched, no file deleted, no dependency installed or upgraded, no `.only`/`.skip`/`todo(` added (`git diff 9673ce5..34da846 -- server/ | grep -E '^\+.*(\.only|\.skip|todo\()'` returns nothing).
- **Error swallowed?** No, and the remediation improved this. `generateExport.ts:188-190` rethrows non-`NoSuchKey` errors **unchanged**, and the wrapped case still preserves `{ cause: error }`, which `errorSummary` walks to depth 5. I confirmed the resulting log line by executing the real wrapper against the real `errorSummary`: it prints the wrapper's message, its frames, then `caused by NoSuchKey: ...` with the cause's own frames.
- **Fix that relocated a bug rather than removing it?** No. The catch narrowed; nothing was moved elsewhere.
- **Log hygiene.** I checked the case REVIEW-3 raised as F-3 and it is closed on the merits, not deferred. Against the **real** client the cause message is `The specified key does not exist.` - it contains no object key, therefore no user id. The `No such object: {userId}/...` string REVIEW-3 worried about is the **fake's** text and exists only in the test process. The stored value (`redactedMessage`) is the wrapper's own message, which I confirmed contains no user id. The purchase date is gone from the message entirely and a falsifiable assertion now guards its absence.
- **`export_jobs.error` column.** Still `text` (`server/src/db/schema.ts:129`); the message shrank relative to the rejected version, so no overflow risk.
- **Severity inflation or deflation.** None found. R-1 stays P1 and the resolution claim is explicitly scoped to the diagnosability half.

---

## Findings

### F-1 · P2 · The whole fix pivots on `error.name === "NoSuchKey"`, and nothing in the repository pins that to the real client

**Evidence.**

`server/src/export/generateExport.ts:241-247` decides everything on the error's `name`:

```ts
return name === "NoSuchKey" || name === "NotFound";
```

The only committed test that exercises a missing key against the **real** adapter is `server/tests/integration/objectStorage.test.ts:73-77`, and it asserts nothing about the name:

```ts
it("download of a missing key fails loudly", async () => {
  await expect(
    storage.download(`${runPrefix}/does-not-exist.jpg`),
  ).rejects.toThrow();
});
```

Everywhere else the property is asserted **by fiat**: `server/tests/helpers/fakeObjectStorage.ts:34-36` sets `error.name = "NoSuchKey"` because the builder wrote it there. The fake agreeing with the code proves only that the builder held one belief consistently in two files.

I verified the belief is currently true, which the repository does not:

```
$ npx tsx <probe against localhost:9000 via createS3ObjectStorage/LOCAL_DEV_STORAGE_CONFIG>
constructor: NoSuchKey
name       : "NoSuchKey"
Code       : "NoSuchKey"
message    : "The specified key does not exist."
status     : 404
```

**Why this is P2.** If the real name ever stops being `NoSuchKey` - a different `@aws-sdk/client-s3` version, R2 diverging from MinIO, a retry wrapper interposing its own error - then `isMissingObject` returns false, the wrap never happens, and R-1 regresses to precisely the "names nothing" state it was raised for. **All 276 tests stay green.** The suite cannot observe the fix becoming a no-op. I demonstrated the mechanism directly: deleting `error.name = "NoSuchKey"` from the fake (one line) makes the naming test fail with `expected 'No such object: a2d54d21-…' to contain '8a921a38-…'`, which is exactly the production regression - but only because the fake, not the real client, was changed.

The fix is one assertion in a file already in the suite and already running against the local MinIO the tests depend on.

**Why the builder missed it.** The fake was corrected to match reality, which felt like closing the gap, and it closes it in the direction that makes the code's tests pass. The direction that matters - reality is pinned so it cannot drift away from the code - requires asserting on the real client, and the builder's own evidence for the real client's behaviour is a sentence in the ledger ("It now carries `name = \"NoSuchKey\"` like the real client") with no artifact behind it. The sentence is true. Nothing in the repo makes it stay true.

---

### F-2 · P3 · REVIEW-3's F-4 was not addressed; the fake was half-aligned with reality

**Evidence.** REVIEW-3 F-4 said `expect(job.error).not.toContain("No such object")` is written against the fake's wording, not the real adapter's. That assertion is unchanged at `server/tests/integration/export.test.ts:271`, and the fake's message is unchanged at `server/tests/helpers/fakeObjectStorage.ts:34` (`No such object: ${objectKey}`).

My MinIO probe above establishes the real message is `The specified key does not exist.` - the two strings share no substring the assertion tests.

So the remediation aligned the field the **code** reads (`name`) and left misaligned the field the **test** asserts on (`message`). The assertion is reachable - with the source reverted and the other four assertions disabled, it fails on its own: `AssertionError: expected 'No such object: 531aed27-…' not to contain 'No such object'` - but it can never fire against a real MinIO or R2 message, so it guards nothing in production.

`not.toMatch(/No such object|NoSuchKey|specified key/)` would say what it means. This was REVIEW-3's stated shape of the fix and it was not taken, nor was the omission noted anywhere in the ledger.

---

### F-3 · P3 · The storage-outage test's setup is dead, and its comment claims otherwise

**Evidence.** `server/tests/integration/export.test.ts:290-295` sets bytes into fake storage under the comment `// The bytes DO exist - this is not the missing-object case.` and then, four lines later, replaces `harness.storage.download` wholesale with a stub that always throws. The fake's object map is never consulted.

Reproduced: deleting the entire `harness.storage.objects.set(...)` block and re-running the file gives `Tests  18 passed (18)`.

The test therefore exercises "an injected error whose `name` is not `NoSuchKey` is not converted", which is the right thing, but not "an error raised while the bytes are present", which is what the comment asserts. It also drags a `receiptImages` / `eq` database query into the test for a line with no effect. Harmless today; the risk is a later reader trusting the comment about what is covered.

---

### F-4 · P3 · `isMissingObject`'s doc comment cites a precedent that does not say what it is claimed to say

**Evidence.** `server/src/export/generateExport.ts:236-240`:

```
 * R2 both name this on the error rather than in its text; the same two names
 * `createBucketIfMissing` already matches on.
```

`createBucketIfMissing`'s helper is `isNotFound` at `server/src/storage/s3ObjectStorage.ts:176-184`, and it matches `"NotFound"` or **`"NoSuchBucket"`** - not `"NoSuchKey"`. The two functions share exactly one of their two names. The comment presents an established in-repo precedent for a pair that has no precedent.

Two things follow. The `"NotFound"` branch in `isMissingObject` appears to be inherited from that misread rather than reasoned: `GetObject` does not produce it (my probe returned `NoSuchBucket` for a nonexistent bucket and `SignatureDoesNotMatch` for a bad credential, so no misdiagnosis results - I checked before recording this). And `isMissingObject` is a near-duplicate of `isNotFound`, in a module that otherwise depends only on the `ObjectStorage` interface and now hardcodes S3 error-name strings; a future non-S3 adapter loses the fix silently. This is the duplication-and-layering hunt the project's own review discipline calls for.

---

### F-5 · P3 · The prescribed remedy names an order that 409s in the case the message is written for

**Evidence.** `server/src/export/generateExport.ts:194-195` tells the person: *"Capture that receipt again so a copy with its photo exists, then delete this one"* - capture first, delete second, so nothing is lost in between. That order is the safe one and it is also the one that can fail.

`server/src/db/schema.ts:187-189` makes `receipt_images_user_id_sha256_uq` **partial** on `deleted_at IS NULL`, and `server/src/routes/receipts.ts:144-149` turns a violation into `409 duplicate_image` ("An identical image is already attached to one of your receipts").

The broken receipt's image row is live, so it still occupies the `(user_id, sha256)` slot. The stated trigger for this whole finding is "a presigned PUT that failed or was interrupted" - which means the bytes are still on the device. If the person re-captures that same file rather than re-photographing the paper, the create 409s, and the only way through is the reverse order the message advises against. The schema comment at `schema.ts:184-186` and the delete route's comment at `receipts.ts:412-414` both already know this shape ("re-capturing the same file after a deletion would 409 forever"); the message does not.

Recoverable, and a fresh photograph avoids it entirely, hence P3 and not higher. Recorded because it is the same failure mode REVIEW-3 rejected - guidance describing a path the server will refuse - one layer down.

---

### F-6 · P3 · "Kept as a record" is true of the database and false of anything the person can reach

**Evidence.** The message ends *"A deleted receipt is kept as a record but does not appear in exports."*

`server/src/routes/receipts.ts:401-424` does soft-delete, so the row survives - that half is accurate. But `visibleTo` (`server/src/db/receiptQueries.ts:10-12`) folds `isNull(receipts.deletedAt)` into **every** receipt read, and `grep -rn "deletedAt" src/routes/` shows no route that opts out. There is no endpoint through which a person can see, list, or restore a deleted receipt.

So "kept as a record" reads as reassurance the product cannot honour: to the user, delete is indistinguishable from permanent. Given that the sentence exists specifically to make a destructive action feel safe, its accuracy matters more than it would elsewhere. "does not appear in exports" alone would be true without implying retrievability.

---

### F-7 · P3 · The ledger's artifact block is still not verbatim, and the replay it records remains unreproduced

**Evidence.** `PROD-READINESS.md:241-250` presents the artifact as

```
GET /api/export/<job>
status: failed
error:  Receipt 8a0ede75-… has no image in storage,
        so this export cannot be completed - its photo never finished
```

REVIEW-3 F-5 objected that the previous block reformatted the stored single-line value across four indented lines. The remediation changed the shape - fake JSON became a pseudo-transcript - but it is still a hand-wrapped rendering with the job id elided, not the response the server emits. Under this run's rule that recorded output is evidence rather than illustration, that is still a paraphrase in an artifact block.

On the replay itself: I could not independently reproduce the authenticated real-entrypoint run, because minting a session token requires writing to the dev database, which this review may not do. I am **not** calling it fabricated, and I have stronger grounds than REVIEW-3 did for accepting it. The quoted string matches the template at `generateExport.ts:191-199` character for character; the receipt id changed from the rejected version's, which is consistent with an actual re-run rather than a hand-edit; the same path is exercised deterministically by the integration test I ran and falsified; and I confirmed against real MinIO the one step the integration test fakes.

I note for the record that the session scratchpad contains prior-run files (`mintToken.mts`, `after-fix.log`, and others). I did not read them. They are not committed artifacts and the review contract does not put them in front of me.

**On the RESOLVED status generally.** REVIEW-3 F-5 said RESOLVED overstates what closed. I do not carry that forward as a finding. The status line now reads `RESOLVED (diagnosability half; the existence check stays DEFERRED)`, the finding's own text states which half is deliberately not taken and why, and the summary-table row carries the same parenthetical. The claim is scoped to what was actually done.

---

## Per-test falsifiability

The stage diff contains two tests in `server/tests/integration/export.test.ts`: one rewritten, one new. Every assertion was checked by breaking the behaviour and observing the result, then restoring the file and confirming `git status --porcelain` empty.

### Test A - `:231` "records a loud failure when an image is missing from storage, naming the receipt that caused it"

| Assertion | Would it still pass if the behaviour it verifies were deleted? | Proof |
|---|---|---|
| `:247 expect(response.status).toBe(201)` | **Yes.** Pre-existing; asserts the create's unchanged behaviour, deliberately per the ledger. Carries none of the stage's weight. | Passes under every falsification run below. |
| `:256 expect(job.status).toBe("failed")` | **Yes.** Pre-existing; the job fails under both old and new code. | Passed with `generateExport.ts` reverted to `9673ce5`. |
| `:257 expect(job.downloadUrl).toBeNull()` | **Yes.** Same - pre-existing, unaffected. | Same run. |
| `:259 expect(job.error).toContain(receiptId)` | **No.** | Reverted `generateExport.ts` to `9673ce5`: `AssertionError: expected 'No such object: 016c6682-…' to contain 'f0594422-…'`, 1 failed / 17 passed. |
| `:265 expect(job.error).toMatch(/Capture that receipt again/)` | **No.** | Replaced the sentence with the rejected draft's "Open that receipt and re-attach its photo": `AssertionError: expected 'Receipt 0519a604-…' to match /Capture that receipt again/`. |
| `:266 expect(job.error).not.toMatch(/re-attach/i)` | **Yes** under full deletion; **no** under regression to the rejected wording. Stated precisely because the distinction matters: reverting to the bare `download` leaves the fake's `No such object: …`, which contains no "re-attach", so this assertion passes on code that has no fix at all. It is a regression guard against one specific prior string, not a verification of present behaviour. | It never fired in the full-revert run (`:259` failed first and this one would not have failed); it is reachable only via the F5 edit, where `:265` fires ahead of it. |
| `:269 expect(job.error).toMatch(/does not appear in exports/)` | **No.** | Fails on full revert (the raw fake message contains no such phrase); confirmed reachable in the revert run behind `:259`. |
| `:271 expect(job.error).not.toContain("No such object")` | **No** against the fake; **yes** against any real adapter, permanently. | Isolated by reverting the source and disabling the four assertions above: `AssertionError: expected 'No such object: 531aed27-…' not to contain 'No such object'`. But the real message is `The specified key does not exist.` (probed), so it can never fire in production. See F-2. |
| `:274 expect(job.error).not.toContain("2026-03-15")` | **Yes** under full deletion; **no** under reintroduction of the date. Reverting leaves `…/2026/03/…` in the key, which does not contain `2026-03-15`, so it passes on unfixed code. It is a guard, not a verification. | Re-added `(purchased ${row.date})` to the message: `AssertionError: expected 'Receipt 8485c180-…' not to contain '2026-03-15'`. |
| `:275 expect(job.error).not.toContain("Test Vendor")` | **Yes** under full deletion; **no** under reintroduction of the vendor. Same character as the line above. Not vacuous - `"Test Vendor"` is the real default from `tests/helpers/testApp.ts:132`, so the string exists in the row under test. | Added `from ${row.vendor}` to the message: `AssertionError: expected 'Receipt aba1445f-…' not to contain 'Test Vendor'`. |

### Test B - `:280` "reports storage being unreachable as that, not as a missing photo"

| Assertion | Would it still pass if the behaviour it verifies were deleted? | Proof |
|---|---|---|
| `:288 expect(response.status).toBe(201)` | **Yes.** Setup, not evidence. | n/a |
| `:311 expect(job.status).toBe("failed")` | **Yes.** The job fails whether or not the error is discriminated. | Passed in the removed-guard run. |
| `:312 expect(job.error).toContain("ETIMEDOUT")` | **No.** | Deleted `if (!isMissingObject(error)) { throw error; }`: `AssertionError: expected 'Receipt 76aadf54-…' to contain 'ETIMEDOUT'`, 1 failed / 17 passed. |
| `:314 expect(job.error).not.toMatch(/never finished uploading/)` | **No.** | Same edit; reachable behind `:312`, and the produced message contains the phrase verbatim. |
| `:315 expect(job.error).not.toMatch(/delete/i)` | **No.** | Same edit; the produced message contains "delete" three times. |

**Stated plainly, because it is the honest reading:** test B does **not** fail if the whole stage is reverted. With `generateExport.ts` at `9673ce5` the raw `ETIMEDOUT` passes straight through and all five assertions hold (`Tests 1 failed | 17 passed` - the one failure is test A). That is correct and expected: test B verifies the *discrimination*, which full deletion preserves by accident. It fails on the edit that actually removes its behaviour, which is the right falsification for it.

Also falsified, and worth recording as the coupling that carries F-1: deleting `error.name = "NoSuchKey"` from `tests/helpers/fakeObjectStorage.ts:35` fails test A (`expected 'No such object: a2d54d21-…' to contain '8a921a38-…'`). The fake's `name` is load-bearing. The real client's `name` is not asserted anywhere.

**No test in this stage is unfalsifiable** in the sense this run has been burned by five times. Every assertion I checked is reachable by some code change. Four of them (`:266`, `:271` in production, `:274`, `:275`) are one-directional guards rather than verifications, which is a legitimate role, but a reader should not count them as evidence that the feature works.

---

## Is REVIEW-3's rejection addressed?

**Addressed**, on its central point, with my own evidence.

- **F-1 (P1, the rejection itself) - addressed.** `git diff 9673ce5..34da846 -- server/src/export/generateExport.ts` shows "Open that receipt and re-attach its photo" gone. The replacement names `POST /api/receipts` (capture again), which exists, and states the cost of delete. I confirmed the delete claim at source rather than accepting it: `receipts.ts:398-428` soft-deletes, `receiptQueries.ts:10-12` scopes every read past `deletedAt`. Two residual inaccuracies in the new wording are recorded above as F-5 and F-6; neither reaches P1, because neither sends the person after a control that does not exist.
- **F-2 (P2) - addressed, and verified harder than the builder verified it.** The catch is now conditional (`generateExport.ts:188-190`), and a falsifiable test covers it. I went past the fake: against real MinIO, a wrong bucket yields `NoSuchBucket`, a bad credential `SignatureDoesNotMatch`, a dead endpoint a connection error - none matches `isMissingObject`, so none is misdiagnosed as a missing photo. The misconfiguration case REVIEW-3 was worried about is genuinely excluded.
- **F-3 (P3) - addressed by removal.** The purchase date is out of the message and `:274` guards it. `tests/integration/logHygiene.test.ts` was not extended, which no longer matters: there is no receipt content in the string to cover. I also checked the concern underneath F-3 and found REVIEW-3 had overstated it - the real client's message is `The specified key does not exist.`, so the `{userId}`-bearing object key it described was the fake's text, never production's.
- **F-4 (P3) - not addressed.** Unchanged assertion, unchanged fake message. See F-2 above. The ledger does not mention declining it.
- **F-5 (P3) - partly addressed.** The status line is now scoped honestly and I do not carry the overstatement forward. The artifact block is still not verbatim, and the real-entrypoint replay is still not independently reproducible. See F-7.

---

## Restoration

Seven temporary edits were made to falsify assertions - `server/src/export/generateExport.ts` (five), `server/tests/helpers/fakeObjectStorage.ts` (one), `server/tests/integration/export.test.ts` (two) - each restored with `git checkout --`.
Final state verified: `git status --porcelain` empty, `git rev-parse HEAD` = `34da8465eb1809813c323f2342db8ad2074d41d6`, and a confirming full run of `npm test` at **30 files / 276 passed / 0 failed**.
The scratchpad copy of `.env.local` was deleted. The server started for guardrail 7 was killed and port 3003 confirmed free. Port 3000 was never touched.
The only file this review created is this one.
