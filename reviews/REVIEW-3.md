# REVIEW 3

Stage under review: `9673ce5..486923f` ("Name the receipt when an export cannot find its image").
Reviewed at `HEAD = 486923f`, branch `prod-readiness/2026-08-10`, working tree clean before and after this review (`git status --porcelain` empty).

verdict: REJECT

The rejection is narrow and does not ask for a revert.
The mechanism landed in `generateExport.ts` is right, the rethrow preserves the cause, and the rewritten test is genuinely falsifiable.
What is rejected is the claim in the ledger that R-1 is **RESOLVED** on the ground that "the export becomes actionable" (`PROD-READINESS.md:235`, `:239`, `:386`).
The delivered message prescribes two remedies: the first cannot be performed through any endpoint this server exposes, and the second removes the receipt - and its HST - from every export it appears in.
That is a two-sentence fix to the string, not a redesign, but it has to land before this finding is called closed.

---

## What I re-ran, rather than accepted

| Gate | Result | Measured against BASELINE |
|---|---|---|
| `npm run typecheck` | exit 0, no output | matches baseline |
| `npm test` | **30 files, 275 passed, 0 failed, 0 skipped**, 18.03s | baseline was 263/28; +12 from stages 1-2, +0 from this stage (the export test was rewritten, not added) |
| Real entrypoint (guardrail 7) | booted on port 3002 from `.env.local` with `ANTHROPIC_API_KEY` stripped; `ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled` then `Kept API listening on port 3002`; `curl -s -i http://localhost:3002/api/me` → `HTTP/1.1 401`, `cache-control: no-store`, `content-length: 79` | identical to baseline's boot and probe |
| Falsification of the stage's test | fails when the behaviour is deleted, at three separate assertions (below) | n/a |

Port 3000 was left alone.
No Anthropic call was made; the key was removed from the env copy before boot and the copy was deleted afterwards.
No remote exists, no history was rewritten, nothing was committed, no dependency was touched, and no file outside this one was created or modified except two temporary edits that were restored with `git checkout --` and verified clean.

## Contract checks that came back clean

- **iOS files touched.** No. `git diff --name-only 9673ce5..486923f` returns exactly `PROD-READINESS.md`, `server/src/export/generateExport.ts`, `server/tests/integration/export.test.ts`.
- **Feature smuggled in.** No. No route, no schema key, no table, no column, no config key, no CLI flag. `router.*` enumeration across `src/routes/*.ts` is unchanged from `9673ce5`.
- **Anthropic API call.** No path in the diff reaches `src/parse/*`; the entrypoint was started with the key withheld.
- **Prohibited actions.** None found. Linear history, no force-push surface (no remote), no credential touched, no file deleted.
- **Error swallowed.** No. The catch rethrows with `{ cause: error }`, and `errorSummary` (`src/observability/errorSummary.ts:79-93`) walks the `.cause` chain to depth 5, so the underlying storage error still reaches stdout via `src/routes/exports.ts:111`.
- **Does the new error text carry data that should not leave the server?** No, on the boundary that matters. The message embeds `row.receiptId` and `row.date`, both belonging to the caller; `export_jobs.error` is read only by `GET /api/export/:id` and `GET /api/export`, both scoped by `eq(exportJobs.userId, c.get("userId"))` (`src/routes/exports.ts:120-122`, and the "hides other users' export jobs behind 404" test still passes). It is also strictly *less* leaky than before: the old value stored on the row was the storage layer's own text, which under the fake is `No such object: {userId}/2026/03/{uuid}.jpg` - a user id handed to the client and printed to the log. See F-3 for the one thing that moved the wrong way.
- **Existing test weakened?** No, strengthened. One assertion (`toContain("No such object")`) was replaced by four, three of which I falsified independently.
- **Cause lost?** No. `redactedMessage` (`errorSummary.ts:100-109`) inspects only the top-level error, so the wrapper's own message is stored; the wrapped cause survives in the log line. Note in passing that this also means a database-marker-bearing cause could no longer trigger redaction of the *stored* value - harmless here, because the wrapper's message is entirely our own text and reproduces nothing of the cause.
- **Ledger citation accuracy.** `PROD-READINESS.md:235` says "see DEFERRED"; §3 DEFERRED does carry the R-1 existence-check entry (line 314). The citation is real and says what it is claimed to say.
- **`export_jobs.error` column.** `text` (`src/db/schema.ts:129`), so the ~250-character message cannot overflow the column and turn the failure-recording write into a second failure. Checked because the message grew 7x.
- **`purchasedAt` nullability.** `date("purchased_at").notNull()` (`src/db/schema.ts:54`), so `(purchased ${row.date})` cannot render `null`.

---

## Findings

### F-1 · P1 · The remedy the new message prescribes cannot be performed, and the one that can loses the receipt from the export

**Evidence.**

`server/src/export/generateExport.ts:182-188` tells the user:

```
... Open that receipt and re-attach its photo, or delete it, then run the export again.
```

Branch one, "re-attach its photo", is not a capability this server has.

- `server/src/http/schemas.ts:167-187` - `updateReceiptSchema` is a `z.strictObject` whose keys are the fifteen scalar fields; there is no `image` key, so `PATCH /api/receipts/:id` rejects an image with a 400.
- `server/src/routes/receipts.ts:305-334` - the PATCH handler's explicit field map contains no image branch.
- `server/src/routes/receipts.ts:58-77` - `POST /api/receipts/upload-url` mints the object key itself, `receiptImageObjectKey(userId, new Date(), randomUUID(), contentType)`. A caller cannot ask for a presigned PUT against the stale key the row already points at, so the missing object can never be filled in behind the existing receipt.

Route enumeration for the whole server confirms there is no other door: `POST /upload-url`, `POST /`, `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` on receipts, and three on exports.
No client - iOS included, which I did not read and did not need to - can offer "re-attach" against an API that has no such endpoint.

Branch two, "delete it", works, and it costs the receipt.
`DELETE /api/receipts/:id` soft-deletes, and `server/src/db/receiptQueries.ts:11` scopes every export query with `isNull(receipts.deletedAt)`.
So following the only workable instruction in the message permanently removes that receipt's vendor, date, total and **HST** from the year-end zip.

That is the exact loss the ledger's own DEFERRED entry argues against two sections earlier (`PROD-READINESS.md:314`): "a receipt row that exists with a missing image still holds the vendor, the date, the amounts and the HST".
The stage declined an existence check at create to avoid destroying that value, then shipped a message that instructs the user to destroy it by hand.

**Why this is P1 and not cosmetic.** R-1's stated goal is "make the failure name the receipt that caused it, **so the export becomes actionable**". Naming happened; actionable did not. The user now knows which row is jamming their export and still has no non-destructive way to clear it, and the guidance they are given points at data loss on the one path (HST, six-year retention) this project's first constraint is about.

**Why the builder missed it.** The verification exercised what the message *says* - three string assertions - and never asked whether the actions it names exist. The API surface was not enumerated, and `ios/` being out of scope removed the other place the absence would have been obvious. A message is a promise about the product's capabilities, and this one was tested as text rather than as a promise.

**Shape of the fix.** Keep the receipt id and the date; drop "re-attach its photo" until an endpoint exists; either drop the delete advice or state its consequence ("deleting it removes it from this and every future export"). Two sentences in `generateExport.ts:182-188` and the matching assertion at `export.test.ts:262`.

---

### F-2 · P2 · The catch is unconditional, so every storage failure is now reported as a permanently missing object

**Evidence.** `server/src/export/generateExport.ts:179-189` catches *every* rejection from `deps.storage.download` and replaces it with a single confident diagnosis - "has no image in storage", "Its photo never finished uploading" - plus the F-1 remedy.
`server/src/storage/s3ObjectStorage.ts:124-133` can reject for reasons that are not a missing key: a connection timeout or reset to R2/MinIO, an expired or wrong credential, a 5xx from the provider, and its own `Object ${objectKey} returned no body` for a 200 with no body.
All of them now tell the user their photo never finished uploading and offer them the delete button.

Reproduced, rather than reasoned. With the fake's throw at `tests/helpers/fakeObjectStorage.ts:31` temporarily changed to `TimeoutError: connection to storage timed out after 30000ms` (restored afterwards, tree verified clean):

```
$ npx vitest run tests/integration/export.test.ts -t "naming the receipt"
 Tests  1 passed | 16 skipped (17)
```

The test passes unchanged on a transient infrastructure failure, because nothing in it distinguishes the two causes - which is also the reason the misdiagnosis will not be caught later.

This is misdiagnosis, not a swallow: the real cause still reaches the server log through `errorSummary`'s cause chain.
The person holding the export screen is the one who is misinformed, and a storage outage is precisely the case where the correct advice is "wait and retry", not "delete your receipt".

**Why the builder missed it.** The fix was written against one reproduction (`NoSuchKey`) and the catch was never narrowed to it, and the only storage failure any test produces is that same one. Narrowing is available - the AWS SDK sets `error.name === "NoSuchKey"` - or the message can drop the causal claim and describe what is observable: this export could not read the image for receipt X of date Y.

---

### F-3 · P3 · A receipt field moved into the server log, and the log-hygiene suite was not extended to cover it

**Evidence.** The new message is also written to stdout: `src/routes/exports.ts:110-112` logs `errorSummary(error)`, whose non-database branch reproduces the message and stack verbatim (`errorSummary.ts:111-118`).
So a receipt id and its **purchase date** now appear in server logs.
`tests/integration/logHygiene.test.ts:13-16` states the invariant this project has broken twice - "server logs carry no receipt contents" - and asserts vendor, tax number, note and OCR text specifically; nothing was added for the new line.

Stated honestly: this is close to a wash, and arguably an improvement. The line previously printed the storage layer's message, which under the fake is the object key, whose first segment is the **user id**. This stage removes that and adds a date.
Recorded because the invariant has a dedicated file precisely because it regressed silently twice, and this stage moved a receipt field into a log line without a test looking at it.

---

### F-4 · P3 · One of the new assertions is written against the fake's wording, not the real adapter's

**Evidence.** `tests/integration/export.test.ts:264` asserts `expect(job.error).not.toContain("No such object")`.
"No such object" is the *fake's* string (`tests/helpers/fakeObjectStorage.ts:31`).
The real adapters say `NoSuchKey: The specified key does not exist.` - which the builder's own comment at `generateExport.ts:170` and the ledger's original R-1 evidence both record.
So that assertion cannot detect the regression it appears to guard against in production; the positive assertions carry the whole test.
Not vacuous (see the falsification table - the test does fail on revert), but the negative assertion is decorative as written. `not.toMatch(/No such object|NoSuchKey|specified key/)` would say what it means.

---

### F-5 · P3 · The RESOLVED status overstates what closed

**Evidence.** `PROD-READINESS.md:239` and `:386` mark R-1 **RESOLVED**, parenthesised as "diagnosability half; existence check DEFERRED".
The parenthetical is honest about the existence check and silent about the part F-1 establishes: the headline harm in the finding's own title - "kills every export of its period" - still holds, and after this stage there is still no non-destructive way for the user to clear it.
The ledger's artifact block also reformats the JSON `error` value across four indented lines; the stored value is a single line. Presentational, but an artifact block should be verbatim, and this run's rule is that recorded output is evidence rather than illustration.

I could not independently reproduce the authenticated MinIO replay quoted at `PROD-READINESS.md:239`, because minting a session token against the real entrypoint requires seeding the dev database, which this review may not write to.
I am not calling it fabricated: the quoted string matches the template at `generateExport.ts:183-186` character for character, and the same path - real HTTP route, real `runExportJob`, real `redactedMessage`, real Postgres, fake storage only - is exercised deterministically by the integration test I did run.

---

## Per-test falsifiability

One test appears in the stage diff. Every assertion in it was falsified by hand, by breaking the behaviour and observing the failure, then restoring the file and confirming `git status --porcelain` empty.

**`tests/integration/export.test.ts:231` - "records a loud failure when an image is missing from storage, naming the receipt that caused it"**

| Assertion | Would it still pass if the behaviour were deleted? | Proof |
|---|---|---|
| `:255 expect(job.status).toBe("failed")` | **Yes** - pre-existing, and it passes on the old code too. It verifies the pre-stage behaviour, not the stage's. Correct to keep; carries none of the stage's weight. |  |
| `:256 expect(job.downloadUrl).toBeNull()` | **Yes** - same. Pre-existing, unaffected by the change. |  |
| `:259 expect(job.error).toContain(receiptId)` | **No.** | Restored `generateExport.ts` to `9673ce5` (bare `download`): `AssertionError: expected 'No such object: e3b5560b-.../2026/03/5968525c-....jpg' to contain '1e9df4d7-...'` at `export.test.ts:259`. 1 failed / 16 passed. |
| `:260 expect(job.error).toContain("2026-03-15")` | **No.** | Removed only `(purchased ${row.date})` from the message: `AssertionError: expected 'Receipt afe45e2b-... ' to contain '2026-03-15'` at `export.test.ts:260`. Also non-vacuous by construction - the raw key renders the date as `2026/03`, never `2026-03-15`, and the test sets `purchasedAt: "2026-03-15"` explicitly rather than relying on a default. |
| `:262 expect(job.error).toMatch(/re-attach its photo, or delete it/)` | **No.** | Truncated the message after "finished uploading.": `AssertionError: expected 'Receipt 22ff4ab5-...' to match /re-attach its photo, or delete it/` at `export.test.ts:262`. Note that this assertion pins the sentence F-1 says should not ship - it locks in the defect rather than guarding a property. |
| `:264 expect(job.error).not.toContain("No such object")` | **No, but only against the fake.** It fails on revert (via `:259` first, and would fail on its own), yet it can never fire against a real MinIO or R2 message, which reads `NoSuchKey: The specified key does not exist.`. See F-4. |
| `:252 expect(response.status).toBe(201)` and the `receiptId` read at `:247` | **Yes** for the 201; it asserts the create's unchanged behaviour, which is deliberate per the ledger. The `receiptId` read is what makes `:259` possible and is not itself an assertion. |  |

No test in this stage is unfalsifiable in the sense the run has been burned by five times.
The stage's three load-bearing assertions each fail when their behaviour is removed, and the two that would still pass are pre-existing assertions the diff did not claim as new evidence.

---

## Restoration

Two files were temporarily edited to falsify assertions - `server/src/export/generateExport.ts` (three times) and `server/tests/helpers/fakeObjectStorage.ts` (twice) - each restored with `git checkout --` and confirmed by `git status --porcelain` returning empty and `git diff HEAD --stat` returning nothing.
The scratchpad copy of `.env.local` used for the entrypoint boot was deleted.
The server started for guardrail 7 was killed and port 3002 confirmed free.

One pre-existing observation, not a finding against this stage: `PROD-READINESS.md` contains two NUL bytes (lines 153 and 159, inside the log-hygiene reproduction) and has since at least `9673ce5`, so `grep` treats the ledger as a binary file. It predates this stage and is out of its scope.
