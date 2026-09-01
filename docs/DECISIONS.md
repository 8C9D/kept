# Decisions

Append-only.
One dated entry per decision: what was decided, what was rejected, and why.
Ordered newest-first by decision date: a new entry is inserted at the top, never at the bottom, and a late-reconstructed entry files under the date the decision was made, not the date it was written.

## 2026-09-01 - The parse investigation: 130 real receipts read against their paper, and the three defects that explain almost all of it

*First of the four 2026-09-01 entries. These four are filed in the order the day ran rather than newest-first within the date - each one rests on the one above it, and this investigation is what every decision below cites.*

**What was done.** Every one of the **130 live receipts** in production was opened and its stored record compared field by field against its own photographed paper, by two agents working one user each; a further pass wrote a code-and-data diagnosis over the same rows plus `user_events`, `ocr_suggestions`, `llm_suggestions`, and three live calls to the Anthropic API. All of it read-only, against a **restore-verified copy** of production and never against production itself. **The full reports are deliberately not in this repository** - they quote two real people's entire purchase histories, receipt by receipt, and a git history is the wrong place for that. They are at `~/.kept/reviews/2026-09-01/` (`review-user-a.md`, `review-user-b.md`, `verdicts.csv`, `diagnosis.md`). This entry records the findings; those files hold the evidence.

**Stored data, against paper.** The owner: 32 verifiable confirmed receipts, **30 fully correct**, two flagged - `4b28add4` Noodle House stores HST 1.75 where the paper prints 1.76 with the last digit faded, and `5fecc5df`'s vendor is a location code (`ON- PR- Food Court`) rather than the store. the second user: 97 live receipts, **70 fully correct as stored, 27 carrying at least one flag**, most of them cosmetic. The material ones, which **the owner decided to leave as they are for now** - recorded, not fixed, neither in-app nor by SQL, in this session:

- **`74ae737c` Costco: total stored $8.50, paper $218.94.** The heuristic took a `TOTAL DISCOUNT(S)` line. This is the worst record in production and it will go into an export as-is until someone fixes it.
- **`8ed5abdc` Pho House** and **`cf12562c` Pub Kitchen**: a tip entered into the HST field.
- **`3b17aa9d` Longos**: the pre-discount subtotal (52.55) where the receipt's own summary says 52.10.
- **Two duplicate pairs.** Happy Lamb `5f8bac5e` (the bill) and `5d5668e6` (the card slip for the same meal, 17 seconds apart) - **and both of their dates are wrong**: the slip spells the month out, `03-Jul-2026`, so the stored `2026-03-07` and `2026-07-31` are both misreadings of one `03/07/2026`. And T&T `e6283500`/`aafc7a28`, one transaction photographed on two different days. Both pairs predate the near-duplicate warning that shipped 2026-08-28.
- **`894cfa6f` Costco**: the stored date is the capture day; the paper says 2026-02-01.
- Vendor strings a person typed: `Tim Nortons.`, `Domno's`, `#D2`, `FIVE  GUYS`, and `Dave's Hot Chicken` living under both a curly and a straight apostrophe.

**Parser accuracy over the same 130 receipts, heuristic against LLM, both scored against what the human confirmed.** Vendor: heuristic **39%**, LLM **63%**. Total: **97 vs 119** right. Subtotal: **69 vs 95**. HST: **52 vs 79**. Where the heuristic had no value at all, the LLM had a correct one **57 times out of 73** - 73 fields a person typed by hand while the model already held the answer. Where both produced a value and disagreed, the LLM won **22 to 3**. Dates: 23 heuristic suggestions were not even in 2026.

**Why "vendor recognition seems broken", answered precisely - and it is not the vendor heuristic alone.** The confirmed vendor string is present verbatim in `ocr_raw_text` on **119 of 130 receipts (92%)**; the text always had it. But **51 of the 54 confirmations in the telemetry window happened on the capture-time confirm screen**, where `ConfirmReceiptModel.init(draft:)` is handed the on-device parse alone - no server row exists yet, so there is no merge and no LLM. The better extractor runs on every receipt and publishes its answer a median of **5.2 s after the row is created** (Haiku's median was 1.4 s; Sonnet's p90 is 8.2 s), by which time the person has finished. What the owner has been looking at all along is the 39%-accurate geometric guess. `user_events` shows the cost in one line: vendor is the only field where overrides outnumber acceptances, **33 to 20**, and it is the most-edited field in the app.

**And the geometry is wrong in a specific, fixable way.** The heuristic takes the topmost of the near-tallest letter-bearing lines in the top quarter. Food Basics prints `food` small and italic above `Basics` large, so it returns `Basics`; UNIQLO's stacked logo OCRs as `UNI`/`QLO`; Jimmy the Greek prints `In Store 392` larger than its own wordmark. The LLM had all three right.

**The date bug, named.** `ReceiptDateParser` took the first date-shaped token on the receipt and read the last group of `26/07/19` as the year - `2019-07-26` - and never reached the unambiguous `07/19/2026` printed at the bottom of the same paper. Seventeen of the 23 bad suggestions are exactly that shape; the rest are decoys the parser had no way to refuse (a sweepstakes `12/31/26`, a `TIMED ORDER 7/17/20`). **The disagreement flag is not a net here**: on **12 receipts both parsers produced the same wrong date**, so `mergeDate` returned `source: "both", disagreement: false` and the screen showed a confidently wrong date with no flag at all. No confirmed receipt actually carries a wrong year - every one was corrected by hand - so the defect has cost keystrokes rather than correctness, so far.

**"Subtotal 9.86, total 3.25", explained and closed.** That pair was a *suggestion*, on `5eaa79c9`; the stored record is 9.86/9.86 because the owner fixed it. Vision read the decimal in `TOTAL 9.86` as a hyphen (`TOTAL 9-86`), so that line yielded no amount at all, and the only surviving `total`-labelled line with a parseable amount was `Total of your savings 3.25`. **The advisory arithmetic warning fired and was heeded** - it did its job. The same class of failure, *not* heeded, is what produced the Costco $8.50.

**The Chipotle failure record, reproduced against the live API rather than theorised.** Receipt `415701a3` carries a three-attempt failure record. The cause is the 2026-08-28 model swap: **Sonnet 5 runs adaptive thinking when the request omits `thinking`**, thinking tokens count against `max_tokens`, and `max_tokens: 1024` was consumed entirely by it - `stop_reason: max_tokens`, 1024 output tokens, 1024 of them thinking, **no text block at all**. Haiku 4.5 did no thinking unless asked, which is why 1024 was ample headroom before the swap and a hard ceiling after it. The same three-call reproduction measured a second-order cost nobody had seen: every Sonnet parse since 2026-08-28 pays about 725 thinking tokens, **~794 output tokens per receipt** against Haiku's ~55 - roughly **3.5× the cost estimate written in the code**. And because `llm_suggestions` is immutable, that failure record is permanent: `415701a3` will never be re-parsed without a deliberate column clear.

**When the LLM pass runs, since it was asked directly.** Kicked at boot, after every create or PATCH that lands OCR text, and every six hours as the retry net; one request in flight; three attempts, then a failure record. Because a pending receipt renders the served merge on every read and the merge prefers the LLM's vendor, **the displayed vendor of a pending receipt changes seconds after capture, untouched.** That is the Aug 8 ruling working as designed, not a bug, and it is not being changed. **Two real bugs were found beside it**, both fixed in today's batch rather than left here as observations: a value a person typed into a pending receipt could be displaced by the served suggestion when the receipt was next opened elsewhere (typed on the web table, reopened on the phone), and the leading-swipe quick-confirm PATCHed `{status}` alone - saving the row's raw values while the row on screen displayed the merge (`JIMMY THE GREEK` shown, `In Store 392` saved).

**Arithmetic in confirmed data, and why a hard rejection was not built.** Of 129 confirmed receipts, **114 reconcile exactly and 14 do not**. Three of the violations are receipts whose own printed figures are a cent out (`13.50 / 1.76 / 15.25`); one is a discount applied after the subtotal. A server-side 400 on confirm would refuse a receipt that has been transcribed **correctly**, with no honest edit available - the person would have to falsify the paper to save it. That finding is what shaped the amount floor below into an extraction-time rule rather than a save-time one.

## 2026-09-01 - The parsers answer the investigation: thinking off, prompt v5, an amount floor at extraction, and the on-device heuristic rebuilt against 130 real receipts

**Decided: `thinking: { type: "disabled" }` goes into the parse request, and `max_tokens` stays 1024** (`server/src/parse/claudeReceiptParser.ts`, pinned by test). The direct repair of the Chipotle failure above. **Rejected: keeping thinking and raising `max_tokens` to 4096.** Both fix the truncation; only one is honest about what this request is. Extraction from OCR text is transcription, not reasoning, and the measurement says so: the same request answers correctly in **~67 output tokens** with thinking disabled and spends **~794** with it on, for an answer that was no better. The 4096 option roughly doubles the bill to buy deliberation the task does not need - and the one place the extra thinking showed itself in the reproduction was inventing `subtotalCents: 1300, hstCents: 135` off an illegible photo, arithmetically self-consistent and entirely wrong. The owner confirmed the disabled form.

**The cost comment was rewritten with measured numbers rather than nudged.** It had estimated ~$0.0023/receipt by holding Haiku's token counts fixed across the model change - an assumption the comment itself flagged as untested, and which was wrong by about 3.5×. What is written there now is measured: ~67 output tokens per receipt with thinking off, and prompt v5 raising the input side to **~3,000 tokens for a short receipt** (against roughly 880 under v4), for about **$0.0069 per receipt**. **Rejected for now: a prompt-cache breakpoint**, which would take roughly 90% off that input side. It is recorded as a follow-up rather than taken, because caching changes the request, and the request is what §7.3's accuracy comparison holds fixed between prompt generations - a cache breakpoint landing in the same pass as a new prompt would make the two inseparable in the data.

**Decided: prompt v5 - and it is the first time the model is given anything that is not the receipt's own text.** The user message now begins `Captured on: yyyy-mm-dd`, a blank line, then the OCR text (`captureLine` in `claudeReceiptParser.ts`; `RECEIPT_PARSE_PROMPT_VERSION` = 5 in `server/src/domain/llmSuggestions.ts`, which also documents the change in place). **This amends the Aug 7 ruling that "the model only ever sees `ocr_raw_text` - never a field a person typed", and it is meant in that ruling's spirit rather than against it.** The capture date is client-stamped metadata every row already carries; it is not a field anyone typed and not a value the model is asked to echo back. What it is, is the only fact that disambiguates `26/07/19` - the shape behind 17 of the 23 bad date suggestions - on receipts where the model was reproducing the heuristic's wrong reading and the disagreement flag then stayed silent because both parsers agreed. The pure-function request builder and the test that asserts what leaves the building are unchanged; the input is now two named things instead of one.

**What else v5 says**, each rule written against a specific production receipt rather than in the abstract: two-digit years on Canadian card slips read `yy/mm/dd`; sweepstakes, "expires", "valid until", "TIMED ORDER", warranty and order-number dates are never the purchase date; `TOTAL DISCOUNT(S)`, `Total of your savings` and `TOTAL … POINTS` are amounts that were **not paid** (the Costco $8.50 and the Food Basics $3.25 in one rule); on a card slip printing `AMOUNT`, `TIP` and `TOTAL`, `AMOUNT + TIP = TOTAL`; the subtotal and tax label synonyms real receipts actually print (`Sub Total`, `NET Sales`, `Sales tax total`, `Total Tax`, `H.S.T.`, `H 13.000% of $109.80`); arithmetic sanity; and null over invention, stated twice. **The schema gained `otherFeesCents` and `paymentMethod`.**

**Decided, reversing a sentence the spec has carried since 2026-08-28: other fees gets a suggestion field after all**, on both parsers, and payment method joins it (`OcrFieldSuggestions`, `server/src/domain/ocrSuggestions.ts`). The old reasoning was that other fees "has no consistent printed label for a heuristic to match". the second user's 97 receipts say otherwise - service charge, credit-card surcharge, delivery, eco fee, bottle deposit and cash `Rounding 0.02` are labelled consistently enough to match - and the card brand is printed on 32 of the owner's 33 receipts while `payment_method` is null on every one of them. **v4 and v5 records are not comparable in `parse-accuracy` on `purchasedAt`, `totalCents` or `hstCents`**: a v4 record was never given the capture date or the not-the-total rules. Said in the prompt-version note rather than left for someone to discover inside a table.

**Decided: an amount floor, applied to extractions and never to confirmed values.** `validateSuggestedAmounts` (`server/src/domain/suggestedAmounts.ts`) states the one thing that cannot be true of any receipt - `total < subtotal + hst + tip + other fees`, beyond a 2¢ allowance for independent rounding - and when a suggestion set violates it, the merge serves the offending amount as `{value: null, source: null, disagreement: false, withheld: true}` rather than a plausible number. **Which amount is withheld is decided rather than guessed**: when HST corroborates the subtotal (no HST at all, or an implied rate at or under 16%), the subtotal has a second witness and the **total** is withheld alone; with no corroboration both go. On `74ae737c` that withholds the $8.50 and leaves an empty, must-fill total. **Rejected: a hard server-side rejection at confirm**, which is what "reject bad extractions" would most naturally have meant. 14 of 129 confirmed receipts do not reconcile and three are receipts whose own printed figures are a cent out; a 400 would refuse a correctly-transcribed receipt with no honest edit available. The owner's instruction to reject or flag bad extractions is met **at extraction**, where the thing refused is a machine's guess rather than a human's confirmation - exactly the line constraint 2 draws. The rule is mirrored on device (`ReceiptArithmetic.validateSuggestedAmounts`, `ConfirmSuggestionSet.withhold`) for the capture-time set, which the server never sees.

**Decided: the on-device heuristic is rebuilt, not patched, and it is measured on all 130 live receipts rather than on a fixture.** `ios/Kept/Parsing/`, with `ReceiptParserProductionTests.swift` pinning the population. Results, heuristic-only, before → after: **wrong dates 25 → 2**, **vendor 48 → 116 right** (with the known-vendor list), **total 97 → 107**, **HST 54 → 69**.

- **A known-vendor pass runs before the geometric one.** The user's own past vendors come from `ReceiptOptionsStore`'s cached options - already on disk, so the capture path still touches no network - and are matched over the whole normalized text rather than the top quarter, because the name that failed to parse as a logo is almost always printed again in the address block or the footer. **First occurrence wins, length only as a tiebreak; longest-overall was measured and rejected**: 109 right against 116, because "Food Court" appears inside UNIQLO's own address. A four-character floor keeps short strings from matching noise.
- **Geometric vendor, hardened.** Address, phone, postal-code, registration-number, `store #`, `in store`, `order`, `table`, `cashier`, `www.`/`.com`/`.ca` and short `#xx` lines are disqualified; two single short words stacked one above the other rejoin into one name, which is what makes `food` over `Basics` read as "Food Basics".
- **Dates are scored, not first-match.** `ReceiptDateParser` now emits **every valid reading of every date-shaped token** and scores them: +3 unambiguous (+1 for an ambiguous reading), +2 corroborated by a different line, +1 for a clock time on the same line, −3 for a decoy word (`sweepstake`, `contest`, `expire`, `valid`, `until`, `timed order`, `return by`, `warranty`), −1 per whole year of age; a reading in the future is discarded outright, and so is one **older than seven years**. **Rejected: the two-year floor the diagnosis proposed.** Two years is the wrong number for this app specifically - the backlog it was built for is a shoebox, and scanning a 2022 receipt is a real thing to do; seven years is the CRA retention horizon and refuses only readings that could not be a receipt anyone is filing.
- **Totals stop taking the largest amount on any line containing "total".** `saving`, `discount`, `point`, `item`, `number of`, `balance`, `change`, `tender` and `cash` disqualify a line; `tax` disqualifies unless the line also says "after tax" or "incl". Damaged decimals are accepted (`TOTAL 9-86`, `Sub Total 4,58`) when the strict pattern found nothing on the line. **A clipped cents field is an absence, not a number**: Burger King prints `Sub Total $7` for a $7.99 line, so a bare integer is deliberately never an amount here.
- **Tax labels widened and the total-line exclusion dropped.** The old `excludingTotalLines` parameter is gone: `Total Tax`, `Tax Total`, `Sales tax total` and `Included in Total` are tax lines, and treating them as totals is what lost HST on six of eight UNIQLO receipts and on Tim Hortons. In its place: the amount must **end the line** (outside parentheses), so `HST (on 9.99)` and prose mentions no longer match; only `before tax` / `after tax` / `pre-tax` / `taxable` / `tax exempt` phrasing excludes; and a tip or gratuity line is never a tax line.
- **Split HST gets three tiers ahead of the old one.** A row whose amount equals the sum of the others is the tax (`Total Tax $1.17` = `$0.72 + $0.45`); failing that, exactly one summary-labelled row wins; failing that, the sum is accepted when `sum / subtotal` lands within ±0.25 pp of a real Canadian combined rate (5, 13, 14, 15%); and only then the 2026-08-28 rule requiring a distinct `%` on every row. That rule alone was too fragile in practice: `7a0f899c` failed because OCR turned `HST - ON 8%` into `HST - 001300`.
- **New `otherFees` and `paymentMethod` heuristics**, matching the labels the LLM prompt now names; a rounding line above 4¢ is refused (`Rounding 40.02` on a $12.55 bill), and a line naming two or more payment brands is a menu of options, not the method used.
- **Row assembly now runs to a fixed point before `rawText` is stored.** The recognizer used to hand the server one-pass text while the parser read two-pass text, so the stored `ocr_raw_text` the LLM re-parses carried orphaned amount-only lines on **16 of the 130 live receipts** - the two parsers were being scored on different text.

## 2026-09-01 - Partial entry becomes a first-class state: `reviewed_fields`, `ocr_source`, a stored options table, and the deploy ordering this batch needs

**Decided: `reviewed_fields` on `receipts` - a `text[]`, migration `0009_reviewed-fields-and-options.sql`.** It names which of the ten confirm-screen fields a human has actually looked at, and it is the answer to "let me enter what I know now and finish later" without confirming. Three things follow from it. **`POST` and `PATCH` accept `reviewedFields`** (validated by `z.enum` over the ten names, deduped, replacing the stored set outright). **On a pending receipt the merge serves no suggestion at all for a reviewed field** (`withholdReviewed`, `server/src/domain/mergedSuggestions.ts`) - eight of the ten names have a suggestion to withhold; `category` and `notes` have never had one. And **"Save for later" on both clients PATCHes the reviewed fields' values and no `status`**, so the receipt stays pending with the typed values durable. **This is also what closes the displacement bug** the investigation found: a value typed into a pending receipt on the web table used to be overwritten on screen by the served suggestion when the same receipt was opened on the phone, because a pending receipt renders the merge and the merge did not know a human had already decided that field. It knows now. **Rejected: treating a pending receipt's stored column as authority instead** - that is the Aug 8 ruling in reverse, and it would have taken the merge's corrections away from every genuinely untouched field to fix the handful someone had typed. The capture-time "Later" path carries the same information: the typed fields ride into the pending create through the outbox item's `partial`, per-field, so a receipt set aside at the shop is not a blank row.

**Decided: `ocr_source` (`'vision' | 'pdf-text'`), and a scoped exception to the no-fallthrough rule.** The column records where a receipt's text came from; it is accepted on **create only**, because a receipt's text does not change origin mid-life. For a `pdf-text` receipt the money merge falls through to the LLM when the heuristic has nothing (`extractedTextMoney` versus `heuristicOnlyMoney`, `mergedSuggestions.ts`). **This is deliberately an exception to the Aug 8 ruling that money is heuristic-only with no fallthrough, and it is scoped rather than a softening of it.** That ruling rests on OCR noise: a wrong-but-plausible amount produced from a mis-paired thermal row reaches an accountant, and an absence costs one keystroke. A PDF text layer has no OCR noise - the characters are the ones the merchant's own software wrote - and **no on-device heuristic runs over it at all**, so the alternative to a fallthrough here is not "a safer heuristic value", it is an empty field on every PDF forever. Vision-sourced receipts are untouched by this. **Web extracts the text layer with pdf.js**, loaded through a dynamic `import()` so the 438 kB chunk and its 1.27 MB worker never load for someone uploading photographs; **iOS uses PDFKit**, with a render-to-image-then-Vision fallback for a scanned PDF that has no text layer. **PDFs always land pending on both clients** - an email backlog is desk work, and there is no camera-side confirm screen in front of it.

**Decided: the reuse lists become a stored per-user table, `receipt_field_options`, and they become editable.** Until today `GET /api/receipts/options` computed the lists by scanning the user's receipts, capped at 100 values each. Now they are rows - upserted on every create and PATCH, backfilled by `0009` from non-deleted receipts, indexed `(user_id, field, last_used_at desc)`. **The cap is gone**: a cap was a defence against an unbounded scan, and there is nothing to bound now. **A list entry is no longer pruned when a receipt is soft-deleted**, which is a real change in meaning: the list is the person's vocabulary, and deleting the only receipt from a shop should not make you retype its name next time. Two routes make it editable: **`PATCH /api/receipts/options/:field` with `{from, to}` renames**, and rewrites every receipt of that user carrying the exact old string - **every status, soft-deleted rows included**, deliberately, because a receipt that is restored later should not come back with the old spelling; it merges onto an existing target row rather than colliding with it, taking the later `last_used_at`. **`DELETE /api/receipts/options/:field?value=` removes the list entry and nothing else** - **the owner's decision, and the interesting one.** The alternative read of "delete this value" is to clear it off the receipts too, and that was rejected: a receipt's category is a fact about a receipt, and a pick-list is a convenience over past values (2026-08-26). Removing a stale entry from a menu should never edit a tax record. Both clients get a manage-values screen; iOS's past-values control turns into a searchable sheet above twelve entries, which is about what fits on screen without scrolling. **The rename route is also the support path for the vendor typos the investigation found** - `Tim Nortons.`, `Dave's Hot Chicken` under two apostrophes - and it is a better one than editing rows by hand.

**Decided: the swipe quick-confirm saves what the row shows.** `QuickConfirmRequest(displaying:)` sends the row's **displayed** vendor, date, subtotal, HST, tip and total alongside `status: "confirmed"`, and the gate widened from the raw `totalCents` to the displayed one (`ReceiptDisplay.canQuickConfirm`) - strictly wider than before, so no swipe that used to be offered has been taken away. The old form PATCHed `{status}` alone, which saved the row's raw capture-time values while the row on screen rendered the merge; `JIMMY THE GREEK` was displayed and `In Store 392` was what got confirmed. **Rejected: rendering the row's raw values on Home instead**, the other way to make display and save agree - it would have made a pending receipt read one way on Home and another on the confirm screen, which is precisely the defect the Aug 8 merge-everywhere ruling exists to prevent.

**Decided, and it is the owner's, on how this batch reaches production when it does: the order is backup → migration `0009` → `fly deploy` → Pages → TestFlight 1.0 (5).** `0009` is additive - one new table, two columns, three backfill inserts, nothing dropped or tightened - so Runbook §2's default would put it *after* the deploy. It goes **before**, for one reason stated in the migration's own header: the new `/options` routes read `receipt_field_options`, and an empty table is not a degraded list, it is a wrong answer served confidently to a person whose vocabulary just vanished. The backfill is what makes the table right, and it has to have run before the code that reads it. **The client ordering is the sharper half.** The deployed build (`b06a217`) validates create and update bodies with **strict** schemas, so a 1.0 (5) phone reaching today's server-side-unaware production would have **every save 400** on the unknown `ocrSource`/`reviewedFields` keys - surfaced by the outbox as items needing attention, which is the honest failure but still a broken app. So the server deploys first and the build follows it, never the reverse. **Nothing was deployed today**: no `fly deploy`, no migration against production, no Pages redeploy, no archive and no upload. The phones are still on **1.0 (4)**.

## 2026-09-01 - The confirm screen answers the investigation too: amber dropped on iOS, a capture-time second opinion, live form arithmetic, and the multi-page prompt

*Last of the four 2026-09-01 entries.*

**Decided: the amber tint comes off the iOS confirm screen - The owner's instruction, after using it.** This reverses the visual half of §7.2's "every prefilled field is visually marked as a suggestion" and of §10A.1's opening bullet, which have stood since Aug 5. **What is reversed is the tint and only the tint.** `unreviewedFields` is untouched and still does three jobs: it gates the date and HST disagreement notes and the rate hint, and it is what `suggestionOutcomes()` scores at save time into `suggestion_accepted`/`suggestion_overridden` - the telemetry the investigation above was read from. The header counter goes with the tint; the screen is titled **"Confirm receipt"** (and "Edit receipt" for the edit purpose) rather than counting what is left. **The web keeps amber**, because the owner did not ask about the web and the two clients are used differently - the table is the unhurried year-end screen, and the phone screen is a five-second task where, after two weeks of real use, the owner reported the amber as noise rather than signal. **The related fix, and the one the investigation actually demanded: the inline notes now clear when the VALUE changes, not when the field is focused.** They were gated on the same touched-state as the tint, so the note explaining why an HST looked wrong vanished at the instant a person tapped in to fix it. Both clients now compare the current draft against the suggestion (money as cents, so "$1.65" and "1.65" are the same value) and keep the note while the suggested value still stands.

**Decided: the capture-time confirm screen asks the server for a second opinion.** `POST /api/receipts/parse` takes OCR text plus a capture date, returns LLM suggestions, and **writes nothing at all** - no receipt, no `llm_suggestions` row, pinned by a test that reads the table afterwards. 503 when no API key is configured, 502 when the model call fails. iOS fires it fire-and-forget when the confirm screen opens, with a **12-second client-side timeout**; a failure, a timeout and being offline are the same silent nothing, and today's behaviour is exactly what remains. **This is the direct answer to the investigation's central finding** - 51 of 54 confirmations never saw the LLM's answer, and the measured confirm-screen dwell is a median of 47 seconds against a parse that lands in 5.2. **Vendor, date and payment method replace only fields the person has not touched**; **amounts are never silently replaced** - a differing amount is offered as a labelled chip ("Server read the total as $218.94 - use it") that a tap applies. **This amends the wave-5 wording that called the confirm screen "deliberately an offline screen".** It is still never blocked on the network: the screen opens, works and saves with no server at all. The network is a bonus that arrives or does not. The owner confirmed it. **Rejected: waiting for the parse before showing the screen**, which would trade a 5-second median (and a 199-second worst case) against the one screen whose whole brief is speed.

**Decided: the form does live arithmetic on both clients, mirrored line for line.** The server's `arithmetic.ts` remains canonical and gained `suggestDefaultRateHst` and `checkAmountFloor` beside a widened `deriveMissingAmount` (which now distinguishes a genuinely unknown blank from a tip or fee line the receipt simply does not have). **The total tracks its components while it is consistent with them** - blank, or equal to the previous sum - and stops the moment a person types a total of their own; **editing the total never moves a component**, which is the asymmetry that makes it safe. **A mid-keystroke unparseable box suspends tracking rather than cancelling it**, so typing "12." in the subtotal does not permanently detach the total. **The HST chip offers `Total − Subtotal − Tip − Other fees` when that remainder is positive, and "HST at 13% of subtotal" otherwise - the 13% half on a CAD receipt only** (`hstRateCurrency`/`HST_RATE_CURRENCY`): production now holds USD receipts, and offering another country's tax rate is worse than offering nothing. **Acknowledge-to-save**: on iOS, confirming a receipt whose amount floor fires, or whose gap exceeds `max($1, 5%)`, raises a dialog that states the gap and asks again. **The `.edit` purpose is exempt, deliberately** - a store-credit receipt legitimately never reconciles, and a person editing an already-confirmed record has already decided. **Rejected: the same dialog on web**, where the floor stays an advisory note: this is the deliberate, unhurried screen, and the dialog exists to interrupt a five-second phone task, not a year-end review.

**Decided: after a multi-page scan the app asks, rather than guessing.** A session that produced two or more pages lands on an inline screen offering "Save as N separate receipts" or "One receipt with N pages". **Deliberately a screen and not a `confirmationDialog`**: a dialog always offers Cancel, and there is no honest cancel here - the pages are scanned, unsaved, and the paper may already be back in a pocket, so every way out has to end with them queued (wave-5's rule that a scan is never lost to a tap). Extraction runs on page 1; the extra pages go through the outbox to `POST /api/receipts/:id/images`, with per-page progress persisted so a crash mid-upload resumes rather than restarts, and a 409 on a page treated as already-landed. **Rejected: always one receipt per scanning session** (the backlog case - eighty receipts scanned back to back - is the reason batch mode exists) **and "merge into the previous receipt"** (it needs a target the person has not been asked about). If the *first* page's create 409s as a duplicate, the item stops with the remedy spelled out - open that receipt, use "Add a page", discard this one - because the server's duplicate error is a message and carries no receipt id to link to.

**Decided: the keyboard Done bar is rebuilt as a plain `UIView`.** `KeyboardDoneBar` replaces the `UIToolbar` that has served as the input accessory view since Aug 8. **iOS 26 does not paint a `UIToolbar` in that role** - an opaque appearance with an explicit background colour leaves not one pixel of that colour on screen, measured by sampling the rendered pixels rather than inferred from the view hierarchy - so the bar was there, tappable, and invisible against the keyboard. The **2026-08-09 decision about where the bar hangs (on the first responder, in UIKit, never `ToolbarItemGroup(placement: .keyboard)`) is unchanged and still load-bearing**; only the view class changed. The Done button is 36 pt inside the 44 pt bar.

**Three smaller findings, each recorded because each is a trap that makes a broken thing look fine.** **(1) A trailing-aligned SwiftUI `TextField` does not render a space that is currently the last character** - typing "Food Basics" showed "Food" until the "B" arrived, which reads as dropped input. The free-text rows (vendor, category, payment method) are leading-aligned now; the money rows keep trailing alignment, where digits line up on the decimal point and no amount ends in a space. **(2) The shutter is one system click per scanning session, not per page** (`AudioServicesPlaySystemSound(1108)`, which follows the ring/silent switch). `VNDocumentCameraViewController` exposes three terminal delegate callbacks and hands over its scan only at the end; there is nothing to observe while the camera is up, so per-page feedback is not achievable without replacing Apple's scanner outright. **Device verification of the sound is the owner's** - the Simulator has no document camera. **(3) Delete joins the confirm queue's screen**, with the detail screen's dialog copy reproduced verbatim, so the same action does not read as two different promises depending on which screen you reached it from. **And vendor sort now defaults to A→Z** and orders by `lower(vendor)` server-side, with the keyset cursor comparing the same expression the ORDER BY does, so paging cannot skip or repeat a row.

**Verification performed, stated here only as far as this entry needs it — `docs/gates/product-feedback-2026-09-01.md` is the report.** Server **760 tests / 55 files** green with `tsc --noEmit` clean; web **334 / 15** green, typecheck and production build clean; iOS **671 unit tests and 9 UI tests**, 0 failures, all re-run in this documentation pass rather than taken from the build sessions. Migration `0009` was applied to the **local** database only. **What nothing here verified**: the document scanner and the multi-page choice screen behind it (no Simulator implementation), the per-scan shutter sound, the PDF file-importer sheet, and every pixel of the amber removal and the rebuilt Done bar — all of it read from the diff and the unit tests, none of it seen on a device.

**Not deployed, and this batch is the first that a client could break by arriving early.** Everything above is committed to `main` and nothing has run against production: no `fly deploy`, no migration against Neon, no Pages redeploy, no archive and no upload. The phones are on **1.0 (4)**, which predates all of it. The order when it does go — backup, `0009`, deploy, Pages, then TestFlight 1.0 (5) — is in the entry above and in Runbook §1/§2, and it is not interchangeable: production's strict schemas would 400 every save from a build that ships ahead of the server. This adds nothing to the owner-action queue `CLAUDE.md` carries — the demo recording and resubmission, the Sign in with Apple `.p8`, the R2 `kept-backups` token, the privacy-label refiling — it sits behind all of it.

**Spec amended in this commit:** §5 (`reviewed_fields`, `ocr_source`, the new `receipt_field_options` table and its three rules), §6 (`POST /api/receipts/parse`, the two option routes, `/options` becoming stored and uncapped, `reviewedFields`/`ocrSource` on the write schemas and the strict-schema deploy-order warning, the `withheld` flag and the reversed "other fees has no suggestion field" sentence), §7.1 (Import PDFs and Manage values as screens seven and eight, the multi-page question, the corrected quick-confirm), §7.2 (amber dropped on iOS, withheld amounts explained, the second opinion and its amendment to "deliberately an offline screen", total tracking, acknowledge-to-save, save-for-later, Delete in the queue, notes clearing on value change), §7.3 (the heuristic list rewritten to what the code does, the three merge-rule changes, prompt v5, thinking off, the corrected cost, the 130-receipt measurement, sweep timing, assembly to a fixed point), §7.4 (`partial`, extra pages, PDFs), §7A (all of the web work and the two deliberate differences from iOS), §10A and §10A.1 (the amber reversal, scoped to iOS), §12 (foreign currency, now with 16 USD receipts in production), and the update log. §8 is unchanged — the export gained nothing today. `CLAUDE.md`'s status section and `docs/Runbook.md` §0/§1/§2/§4/§6 amended alongside.

## 2026-08-28 - Everything built today is deployed: machine v8, migration 0008, and TestFlight build 1.0 (4)

*Recorded at the end of the day, for actions taken in the same session. Latest of the 2026-08-28 entries.*

**Done, recorded rather than decided.** The two undeployed batches above - the six approved UX proposals and then the last four - went to production together, on the owner's instruction, by the same procedure the morning's round used.

**A backup was taken and restore-verified before the migration, not merely taken.** `pg_dump` to `~/.kept/backups/kept-prod-20260828-premigration-0008.dump`, restored into a scratch database, row counts matched (`users 2, receipts 78, receipt_images 78, user_events 0`). The distinction matters: a dump nobody has restored is a file, not a backup, and this is the second time today the check was run rather than assumed.

**Migration `0008` ran before the deploy, and it is the first migration here that is not purely additive.** `0006` and `0007` added a column and a table; `0008` **drops a unique constraint and recreates it as a partial unique index** (`receipt_images_receipt_id_page_uq … WHERE deleted_at IS NULL`), taking an `ACCESS EXCLUSIVE` lock while it does. At 78 image rows the lock is momentary, and the Runbook now carries the distinction so the next reader does not assume every migration in this project is additive. Read back from production afterwards: the index carries its `WHERE (deleted_at IS NULL)` predicate, both image indexes are present, and all 78 image rows survived with none tombstoned.

**Ordering, decided rather than defaulted.** Runbook §2's default is to migrate *after* deploying when a migration only adds - but the new code cannot run without `0008` (a page replacement soft-deletes and reinserts at the same page number, which the old non-partial constraint forbids), while the *old* code runs perfectly well *with* it, since machine v7 never reinserted a page. So migrating first was the order with no broken window in either direction. The same reasoning governed `0006`/`0007` this morning.

**Verified against artifacts, not exit codes.** `fly deploy` rolled the machine to **version 8**, health check passing, boot log printing `Receipt parse model: claude-sonnet-5`. Through Cloudflare: `GET /api/me` answers **401** with `Cache-Control: no-store`; `GET /api/receipts/possible-duplicates` and `POST /api/receipts/:id/restore` both answer **401**, proving they are registered and behind session auth; and `keptapp-api.fly.dev` still answers **403** directly, so the edge secret is intact and the origin is not reachable around the rate limiter. The Pages redeploy went out in the same session: the live bundle hash matches the local build byte for byte, and the export presets are present in the served JavaScript.

**TestFlight build 1.0 (4) was uploaded**, carrying everything from all three of today's batches - the phones were on 1.0 (3), which predated every UX proposal. `CURRENT_PROJECT_VERSION` went 3 → 4 on the Kept target's Debug and Release configurations only; the test targets stay at 1, being neither archived nor uploaded. The exported `.ipa` was inspected rather than trusted: `Authority=Apple Distribution: 8C9D (<team-id>)`, `get-task-allow` **false**, **no** `ProvisionedDevices`, version pair `(1.0, 4)` - which strictly exceeds `(1.0, 3)`, the condition for TestFlight to offer it as an update. The archive was development-signed at archive time, as it always is here; distribution signing happens at export, and `** ARCHIVE SUCCEEDED **` remains no evidence of an uploadable artifact.

**Production read after all of it: `users 2, receipts 78, receipt_images 78, user_events 0`.** The event log is empty because no build carrying the telemetry client has run against production yet - 1.0 (4) is the first, and it has not been installed. That is the expected reading, not a fault.

**Unchanged and still the owner's:** the App Store Connect **privacy label refiling**, which is a gate on submitting *any* build carrying `PrivacyInfo.xcprivacy`'s Product Interaction entry to App Review - and 1.0 (3) and 1.0 (4) both carry it. TestFlight internal distribution is not App Review and is unaffected. Behind that, unchanged: the demo recording, the Sign in with Apple `.p8`, the Resolution Center reply and resubmission, and the R2 `kept-backups` token.

## 2026-08-28 - Four more UX proposals approved and built - an HST rate hint, near-duplicate detection, swipe-and-undo, and export presets - still none of it deployed

**Filed as its own entry, above the six-proposals entry directly below, not folded into it.** That entry's own opening paragraph gives the reason to keep entries apart rather than blur them - shipped-and-verified versus built-and-waiting - and the identical reasoning applies one level up here: the owner approved **#7 through #10** of `docs/proposals/2026-08-28-ux-enhancements.md` in a *separate* pass, after the six below were already built, not in the same sitting as those six. `DECISIONS.md` is append-only; rewriting an already-written entry's title and body to absorb a later, separately-approved batch would make it look like all ten were decided together, when they were not. This entry is built on top of the six-proposals tree, in the same working directory, still entirely uncommitted.

**Decided: proposal #7, an HST rate-plausibility hint scoped to 8% alone, never to "any non-13% rate."** `checkHstRatePlausibility` (`server/src/domain/arithmetic.ts`), mirrored live on both clients (`ios/Kept/Confirm/ReceiptArithmetic.swift`, `web/src/views/ReceiptForm.tsx`'s own copy) flags an effective rate within ±0.25 percentage points of 8% - the Ontario provincial half of a 13% split standing alone - and nothing else. **Rejected: the proposal's own named alternative, flagging any rate not close to 13%.** 5% is a legitimate standalone rate on its own terms - GST-only provinces are real, and nothing this system stores knows which province a receipt is from, so a lone federal-half misread is indistinguishable here from a genuine GST-only receipt. A grocery basket mixing taxable and zero-rated items also legitimately reconciles well under 13% on a genuine Ontario receipt, and groceries are most receipts - the wider check would have fired on exactly what people capture most. The narrow band is not free of false positives either, and the reasoning states that rather than hiding it: a real 13% receipt that happens to be roughly 38% zero-rated also reconciles near 8%, which is why this is an amber prompt-to-look and never a block, the same register §7.2's arithmetic warning already uses. Both implementations cross-multiply in integer basis points rather than dividing in floating point, over a real difference the web test suite pins at the boundary: a naive `Math.abs(hst/subtotal - 0.08) <= 0.0025` computes `0.0025000000000000022` at the exact $7.75-on-$100.00 lower edge, and wrongly excludes the one receipt that should flag there.

**Decided: proposal #8, a near-duplicate warning at `GET /api/receipts/possible-duplicates`, closing a v2 deferral §11 has carried since wave 1.** §5 stated the reasoning for that deferral from the start, and it is the reason this route had to exist rather than a wider `(user_id, sha256)` index: the sha256 constraint can only ever catch a byte-identical re-upload, and it **can never** catch a re-photographed piece of paper, because two photographs of one receipt share no pixels at all. The route matches the caller's own live receipts sharing `purchased_at`, `total_cents`, and vendor. **Vendor is compared case-and-whitespace-insensitively, for the comparison only** - a deliberate departure from the exact-match rule every other filter in this file follows (`buildReceiptFilterConditions`'s category/paymentMethod, and `/options`, which hands back a person's own strings verbatim - normalizing there would refuse to match a value the server just offered). A duplicate warning is answering a different question than a filter: the case this route exists to catch is "Tim Hortons" and "TIM HORTONS" from two scans of the same paper, which an exact match would treat as unrelated, and the response still returns every match's vendor exactly as stored - never normalized - so nothing this normalization does ever reaches storage or a response body. A null vendor matches a null vendor, decided deliberately rather than read as "ignore vendor entirely" - an illegible receipt scans the same illegible way twice. **Warns and never blocks**, on both clients, rendered as an amber note with a way to open the match: a false positive is real and cheap to dismiss (two identical coffees is a normal Tuesday), and blocking would cost more than the duplicate it exists to catch. **Rejected: blocking a save on a duplicate match**, the proposal's own named risk, not revisited - refusing a legitimate second identical purchase is a worse failure than a duplicate slipping through to be caught later by a human eventually opening both.

**Decided: proposal #9, swipe actions, sticky month headers, and undo - iOS only, no web change.** Swipe-to-delete and swipe-to-confirm on Home's list (`HomeView.swift`, `ReceiptListModel.swift`), sticky per-month section headers rendered over the server's own ordering (`ReceiptMonthGrouping.swift` - a pure rendering pass, never a re-sort, per §4.1's rule that domain logic including ordering stays server-side), and `POST /api/receipts/:id/restore` as the undo path all of it needs. **The undo is what gated this proposal, stated in the route's own doc comment**: a soft delete was already recoverable in principle (§10B), but nothing exposed getting it back, which made a mis-swipe against a tax record a one-gesture accident - the undo toast is what turns "recoverable in principle" into "recoverable in fact." **Restore is not time-limited at the API, decided deliberately.** §10B's six-year retention gives a soft-deleted receipt no principled cutoff before which a restore should start refusing, and nothing sweeps a deleted row today either; the **iOS toast** that offers the tap times out after six seconds (`HomeView`'s `.task(id:)`), but that is a UI affordance bounding how long ONE opportunity stays on screen, not a rule the server enforces - the route itself will restore a receipt deleted at any point in the past, for as long as it stays undeleted. **Restore can legitimately fail, and for a real reason, not a theoretical one.** Both `receipt_images` unique indexes are partial, `WHERE deleted_at IS NULL` (§5) - which is exactly what lets a delete free a slot for re-capture at all. So: delete a receipt, re-capture the now-legal identical file onto a second receipt, then try to restore the first - its tombstoned image's sha256 now collides with the second receipt's live row. The route catches this inside the same transaction as the receipt's own un-delete (409 `restore_conflict`, naming the collision and the remedy) rather than leaving the receipt half-restored or surfacing a raw constraint violation to the person. **Rejected: a confirmation dialog in front of swipe-to-delete or swipe-to-confirm.** The undo toast is what makes the delete gesture safe, not a second "are you sure" step ahead of it - matching ordinary iOS list conventions (Mail, Reminders); quick-confirm shows the same vendor, date and total the row already renders, the same amount of looking the web bulk-confirm button already asks for with no dialog of its own (proposal #5, `docs/DECISIONS.md` 2026-08-28, the entry below). **No web change**: `web/src/api.ts` gained no `restoreReceipt` method and no web screen offers it - the route exists generically and could serve either client, but only iOS's swipe UI calls it in this pass. The web client's existing single-row delete (§7A, Aug 25) still has no undo of any kind.

**Decided: proposal #10, export period presets, client-only, over §12's own predicted seam.** "Last fiscal year," the four quarters, and "this fiscal year to date" (`web/src/fiscalPresets.ts`, `ios/Kept/Export/FiscalPresets.swift` - a deliberate line-for-line port between the two, kept in exact correspondence so the two implementations cannot silently drift). Whole-fiscal-year presets send `{fiscalYearEndingIn}` and let the **server** derive the actual dates (§4.1a, §5.1); the range shown for that preset is a preview computed the identical way, never the value actually sent. Quarters and year-to-date have no server equivalent to derive from at all - the API has never had a quarter concept (§12 named this the reason a quarterly picker would be "a UI affordance on the period picker, not an architecture change") - so for those three presets the client-computed range **is** the request body. **§5.1's "fiscal year end is config, not an assumption" is the entire difficulty here**: a preset built off the calendar year would be silently, plausibly wrong for anyone whose fiscal year end is not December 31. **A real bug was caught by the web test suite before a person found it.** Naively carrying a June-30 year end's literal day number (30) across every quarter boundary put a quarter ending in a longer month (December, March - 31 days each) on the 30th instead of the 31st; the fix (`isMonthEndConfig`) re-resolves "end of month" per quarter for an ordinary month-end year end, rather than repeating one month's day number into a month of a different length. A genuinely mid-month year end keeps its literal day, clamped the same way the year end itself already is (`fiscalYearEndDateIn`'s own Feb-29-in-a-non-leap-year clamp, reused here).

**One asymmetry found and fixed along the way, worth its own paragraph in the tradition of the CORS-`PUT` entry above: the web client's `suggestion_accepted` telemetry fired at the wrong moment.** Building #8's duplicate note into `ReceiptFieldsForm` (`ReceiptForm.tsx`) meant touching the same component the derived-amount fill (proposal #1) and vendor-default fill (proposal #2) already lived in, and the owner ruled on a pre-existing defect while there: those two web-only fill sources logged `suggestion_accepted` the instant the value landed in the field, which could never emit `suggestion_overridden` for a fill someone went on to edit before saving - structurally always-accepted on this client, while iOS's `suggestionOutcomes()` has scored the identical fields honestly at save time since telemetry was built. **Decided: fold both sources into the one save-time mechanism iOS already uses.** `onSuggestionApplied` now only reports which field carried a client-sourced fill, without logging anything itself; `summarizeFieldEdits` unions that set with the server's own `suggestedFields` and scores accepted-versus-overridden once, at save, the same way for every suggestion source on both clients now - so `npm run action-report`'s override rate means the same thing regardless of which client produced the row. No `user_events` action or field vocabulary changed (§5); this is a change in *when* an existing event fires, not a new one.

**Verification performed.** Server: **620 tests / 51 files green** (`npm test`, re-run this session; the pre-this-pass count was 578/49 - two new integration files, `possibleDuplicates.test.ts` and `restoreReceipt.test.ts`, plus additions inside `arithmetic.test.ts`). Web: **199 tests / 13 files green** (`npm test`, re-run this session; pre-pass count 136/11 - two new files, `duplicates.test.ts` and `fiscalPresets.test.ts`, plus additions inside `receiptForm.test.ts`). iOS: **440 unit tests, 0 failures** (`xcodebuild test -only-testing:KeptTests`, re-run this session on an iPhone 17 Pro simulator, `** TEST SUCCEEDED **`; pre-pass count was 365 - three new files, `FiscalPresetsTests.swift`, `ReceiptMonthGroupingTests.swift` and `ExportPresetResolutionTests.swift`, plus additions inside `ReceiptArithmeticTests.swift`, `ConfirmReceiptModelTests.swift`, `ReceiptListModelTests.swift`, `APIClientTests.swift` and `ExportViewModelTests.swift`). **No new migration in this pass** - `0008` (proposal #6, the entry below) is still the newest migration file and is still applied to the local database only; #7-#10 needed no schema change at all. **What this pass did not verify:** the iOS document scanner (`VNDocumentCameraViewController`) has no Simulator implementation and was not exercised by anything in this batch - nothing here touches the scan path directly, but nothing confirms the screens that share code with it still behave correctly under a real scan either; no end-to-end Simulator UI run (`KeptUITests`) was performed for the swipe gestures, the undo toast, or the export preset picker on either client; and nothing in this batch has run against production in any form.

**Not deployed, on top of an already-undeployed tree.** Every change described here is further uncommitted working-tree code on top of the six-proposals batch below, the same day - `git status` shows the same files modified again plus several new untracked ones, none staged, none committed. No new migration exists to run against anything; `0008` remains local-only, carried over unchanged from the entry below. No server deploy, no iOS build, no Pages redeploy happened. This adds nothing new to the owner-action queue `CLAUDE.md`'s status section and the entries below already carry - the 1.0 (1) demo recording and resubmission, the Sign in with Apple `.p8`, the R2 `kept-backups` token, and the App Store Connect privacy label refiling - it is further behind all of it, not beside it.

**Spec amended in this commit:** §5 (`possible-duplicates`'s vendor-comparison rule, and why the sha256 constraint could never do this job), §6 (the two new routes), §7.1 (swipe actions, month headers, undo, the export-presets list), §7.2 (the rate hint, the duplicate warning), §7A (the same two mirrored on web, the telemetry fix, no restore UI on web), §10A.1 (the amber/pending-only treatment now covering the rate hint too), §11 (near-duplicate detection struck through as built rather than deferred), §12 (the quarterly-picker prediction marked realized), the update log; `CLAUDE.md` alongside; `docs/proposals/2026-08-28-ux-enhancements.md` marked #7-#10 built, with pointers.

## 2026-08-28 - Six UX proposals approved and built - derived amounts, vendor defaults, running totals, a deeper action-log report, bulk edit, and multi-page receipts - and none of it deployed

**Filed as its own entry, not folded into the second-round-feedback entry directly below, on purpose.** That entry records a product-feedback round that was built, verified, deployed to production, and left the phones on a stale build; this entry records a second pass the *same day*, over `docs/proposals/2026-08-28-ux-enhancements.md` (ten UX proposals written alongside that build), of which **the owner approved six - #1 through #6 - and they are now built. Nothing in this entry is deployed.** The distinction the two entries draw - shipped-and-verified versus built-and-waiting - is the entire reason to keep them apart rather than let one long entry blur it.

**Decided: proposal #1, a one-tap derive for the missing amount, plus a reconciliation split when nothing is missing but the five do not balance.** `deriveMissingAmount` (`server/src/domain/arithmetic.ts`) is the canonical rule - when exactly one of `subtotal · hst · tip · other_fees · total` is blank, what value would make the equation hold - and both clients carry a live mirror of it (`ReceiptArithmetic.swift` on iOS, `ReceiptForm.tsx`'s own `deriveMissingAmount` on web) so the affordance updates on every keystroke without a round trip. **Rejected: a negative tip or negative other-fees result.** Tip and other fees are charges layered on a subtotal - a gratuity, a delivery fee, a deposit - never something that runs negative on any receipt this app has seen; offering "tip: -$3.00" would not be a suggestion anyone could act on, it would be evidence the *other* four fields are wrong, which the function has no way to say and should not paper over by inventing a number that looks like an answer. The function returns `null` instead, and the person still sees the mismatch and looks at the paper. **There is deliberately no path from either function to a write** - constraint 2 governs the result exactly as it governs `checkReceiptArithmetic`: the filled value lands amber and unconfirmed, precisely like an OCR suggestion, and a person still has to look at it and touch the field before it counts as confirmed. A second affordance covers the other case proposal #1 also named - all five filled but not reconciling - by solving the same equation for tip or for other fees while holding the rest at their current draft values (`reconciliationSuggestions` on web, `reconciliationDifference`/`reconciliationResult(for:)` on iOS); it reuses the identical never-negative refusal rather than inventing a second, looser one.

**Decided: proposal #2, vendor-remembered category and payment defaults - confirmed receipts only.** `GET /api/receipts/options` gains `vendorDefaults`, keyed by the exact vendor string a person's most recent *confirmed* receipt from that vendor carried for category and payment method (`vendorDefaultCandidates`, `server/src/routes/receipts.ts` - one query, two window functions, no per-vendor round trip). **Rejected: sourcing the default from pending receipts too**, unlike the vendor/category/payment reuse lists themselves, which do count pending rows (2026-08-26's own ruling: "a value typed at capture is still a value the person chose," for a pick-list the person is about to look at themselves). A default is different in kind - it prefills a field on a *different* receipt without a human having looked at *this* one yet, and a pending receipt's category may itself be nothing more than an unreviewed heuristic guess. Confirmed-only is the more conservative reading of "chose" for a value about to be reused elsewhere unlooked-at. **Rejected: the identical mechanism for HST, or any amount.** Category and payment are free text with no tax consequence - a wrong default costs a mislabelled row an accountant re-reads, never a wrong claim - which is exactly why prefilling them this way is defensible where prefilling an amount never would be (`deriveMissingAmount`'s own doc comment makes the contrasting case in full). Both clients apply the fill only into an empty, untouched field, and never re-apply once touched even if touching emptied it back out - the same permanent-opt-out rule §10A.1 states for every other suggestion source.

**Decided: proposal #3, running totals for the current filter - `GET /api/receipts/summary`, confirmed money and a separate pending count, never one blended figure.** The route takes exactly the filter parameters `GET /api/receipts` accepts, none of its paging ones, and shares that route's own `buildReceiptFilterConditions` rather than a second filter implementation that could quietly drift from it - the proposal's own named risk, "two filter implementations that can disagree is precisely the bug this route would otherwise introduce." One query, `FILTER (WHERE …)` aggregates for both halves, so confirmed and pending are computed from one snapshot rather than two queries a concurrent write could race between. **Rejected: computing the total from whatever rows are currently loaded in the table.** The list is paged (default 50, max 200) and the proposal's own risk is a number that "invites being read as a tax figure" - summing only the loaded page would either silently undercount past the first page or require loading every page to be honest, defeating the point of paging; the dedicated route answers the question correctly, over the full filtered set, in the scope the export itself uses. Both clients caption the money "confirmed only" in the same sentence they state it, every time, zero pending included, so the caveat is a fact about the number rather than something that only appears when it is bad news; a failed summary fetch degrades to no summary line on either client, never a stale or wrong one.

**Decided: proposal #4, deepen `action-report` rather than build a new tool.** Two more cuts over the same `field_edited` events, both named in the owner's original brief for the table. **`parsePathBreakdown`** separates "edited when a parser actually suggested something" (the only case that is evidence a parse path is unreliable) from "edited when nothing was suggested" (filling a gap, not correcting a wrong answer), from fields with no suggestion path at all (`otherFees`, `category`, `paymentMethod`, `notes` - always a person typing from scratch), and from `unknown_receipt` (the event's receipt reference did not resolve - an offline event whose receipt has not synced yet or has since been deleted; genuinely unknown, not the same fact as "nothing suggested"). **`editHistograms`** buckets repeat edits (`1`/`2`/`3-5`/`6+`) per field, on the owner's own reasoning: a mean cannot distinguish "one receipt edited fifteen times" from "fifteen receipts edited once," and the first is the red-flag pattern the whole feature exists to surface. Every printed rate now carries its own `(n=…)`, and a row under 5 is flagged too thin to read as a pattern (`MIN_READABLE_N`) - the same caveat §7.3's `parse-accuracy` already states about its own 5-receipt sample, now applied everywhere a rate is printed rather than left to be inferred.

**Decided: proposal #5, bulk edit on the web table - select, set category, set payment method, confirm.** Selection is scoped to currently-loaded rows only (`toggleSelectAll`); the header checkbox can never mean "every receipt in my account," only "the ones on this page" - the proposal's own named risk. No batch route exists, so a client-side runner (`runBatch`, `web/src/bulkEdit.ts`) drives the existing per-row `PATCH`, a handful at a time (concurrency 4) rather than fifty parallel requests against an API built for one row. **Partial failure is the normal case this feature is built around, not the edge case**: every id gets its own result, successes and failures are reported separately and by id, and failed rows stay selected so a retry has something to retry. A bulk confirm partitions rows client-side into what can be sent and what the server would refuse (`partitionConfirmable` - a row with no total), reporting the blocked rows through the identical `BatchFailure` shape a real request failure would produce, rather than only surfacing the server's 400 after the fact. **Rejected: bulk delete**, though the proposal itself offered it as part of the set. Deletes are soft server-side and recoverable in principle, but there is no undelete anywhere in this app - not in the API, not in either client - so a mis-clicked bulk delete would be unrecoverable by any means a user actually has. The proposal named this exact risk itself; leaving delete out is not an oversight, and it should not be added later as an "obviously missing" feature without an undelete path built first to sit behind it.

**Decided: proposal #6, add a page to an existing receipt, and replace one page's image.** `POST /api/receipts/:id/images` and `PUT /api/receipts/:id/images/:page` (`server/src/routes/receipts.ts`), both behind the same presign-then-PUT handshake every image write already uses. **Migration `0008_receipt-images-page-partial.sql`** widens `receipt_images`' `(receipt_id, page)` uniqueness from a plain constraint to a partial index, `WHERE deleted_at IS NULL` - the identical fix wave 1 already made once, on the sha256 index beside it. It was needed because replacing a page soft-deletes the live row at that page and inserts a new one at the *same* page number; a plain constraint would refuse that insert against its own just-tombstoned predecessor, forever. **Rejected: a client-supplied page number.** A client-chosen page number is a client-chosen primary key, and two devices adding a page to the same receipt at the same moment would collide on it; the server assigns the next page as the receipt's current max *live* page plus one, computed with the `receipts` row locked `FOR UPDATE` for the read-then-insert, which is what turns "two devices at once" into "one goes first, the other computes its next page from the first's result" rather than a TOCTOU race where both read the same max. **Rejected: routing either write through the §7.4 offline outbox**, iOS's disk-backed guarantee for a shop-floor capture. Adding or replacing a page targets a receipt that is already durably stored server-side, ordinarily as a desk activity - fixing something noticed later - not a moment standing in a shop with bad signal; queuing it would let a scanned repair sit unsent for hours with no visible reason on a screen that looks synchronous, and for replace specifically would risk a stale `objectKey` outliving the presigned URL issued against it. Both routes fail clearly instead, with a retry the person controls, exactly like every other desk-time edit in the app (a PATCH from the confirm screen, a delete); reconsider only if this screen starts seeing shop-floor, offline usage, which nothing today suggests. **The export now carries a `pages` column** (after `image_filename`, 15 columns) and **bundles every live page**, not only page 1 - a multi-page receipt whose second page never reached the accountant was judged worse than no multi-page support at all. Page 1 keeps its existing, un-suffixed filename (byte-identical to every export before this feature, for a receipt with only one page); later pages get a `_p{page}` suffix on the same deterministic pattern. **The §8 missing-image failure message now leads with repair, not deletion** - `PUT /api/receipts/:id/images/:page` can fix just the broken page without losing the receipt's vendor, date, total or HST, which an earlier version of that message could not offer because the route did not exist yet; deleting the whole receipt is still named, second, with its cost stated, for the person who would rather start over or whose paper is gone.

**One bug found and fixed along the way, and worth recording properly rather than folding into the paragraph above: CORS's `allowMethods` never gained `PUT`.** The replace-image route is the API's first `PUT`, and `server/src/app.ts`'s `allowMethods` list was not updated with it. It worked perfectly under `curl`, which sends no preflight, and was completely dead from the browser, refused at the preflight before the request was ever made - invisible to every existing test, all of which call the app directly rather than through a real CORS preflight. `allowMethods` now lists `PUT`, and a regression test drives `OPTIONS` for every method the API's routes use, matching `access-control-allow-methods` against each, so a future route joining a new HTTP method cannot recreate this silently. This is a good entry in this project's own tradition of recording the traps that make a broken thing look working - the identical shape as the wave-3 stale-listener guardrail and the wave-5 offline-cache diagnostic.

**Verification performed.** Server: **578 tests / 49 files green** (`npm test`, re-run this session; the pre-this-pass count was 500/47 - two new files, `receiptImages.test.ts` and `receiptSummary.test.ts`). Web: **136 tests / 11 files green** (`npm test`, re-run this session; pre-pass count 68/8 - three new files, `bulkEdit.test.ts`, `receiptImages.test.ts`, `receiptSummary.test.ts`). iOS: **365 unit tests green, 0 failures** (`xcodebuild test -only-testing:KeptTests`, re-run this session on an iPhone 17 Pro simulator, `** TEST SUCCEEDED **`; pre-pass count was 311 unit tests - two new files, `ReceiptArithmeticTests.swift` and `ReceiptImageUploadModelTests.swift`, plus additions to existing ones). Migration `0008` was confirmed applied to the **local** database directly (`\d receipt_images` inside `kept-db`, and `drizzle.__drizzle_migrations` carrying its row) - not inferred from the migration file existing, read from the running database. **What this pass did not verify:** the iOS unit-test run does not exercise `VNDocumentCameraViewController` - Apple's document scanner has no Simulator implementation, so the add-a-page and replace-image scan flow (`ReceiptImageUploadView.swift`) was not exercised at all, on Simulator or device; no end-to-end Simulator UI run (`KeptUITests`) was performed for any iOS feature in this pass; and nothing in this entry has run against production in any form.

**Not deployed, and stated as plainly as the entry below states the opposite.** Every change described here is **uncommitted working-tree code** - `git status` shows modifications across `server/`, `ios/`, `web/` and several new untracked files, none staged, none committed. **Migration `0008` has been applied to the local development database only**; it has not been prepared, let alone run, against Neon production. No server deploy happened. No iOS build was archived or uploaded - the phones remain on **1.0 (2)**, which the entry below already states predates its own iOS work (export, zoom, delete), and so predates this pass's iOS work too. No Pages redeploy happened. This lands on top of an already-long queue of owner-only actions recorded in `CLAUDE.md`'s status section and the entry below: the 1.0 (1) demo recording and resubmission, the Sign in with Apple `.p8`, the R2 `kept-backups` token, and now the App Store Connect privacy label refiling. This entry adds nothing to that queue's order - it is further behind all of it, not beside it.

**Spec amended in this commit:** §5 (`receipt_images`'s now-partial page constraint, multi-page built), §6 (`GET /api/receipts/summary`, the two image routes, `vendorDefaults`, the CORS fix), §7.1 (Home's summary line, receipt detail's add/replace page), §7.2 (the derive-and-fill affordance, vendor defaults), §7A (all six mirrored on web, bulk edit's own rejections), §8 (15 columns, `pages`, per-page filenames, the repair-first failure message, the budget counting every page), §10A.1 (amber now covers derived fills and vendor defaults, not only the OCR merge), §11 and §12 (multi-page struck through as built rather than deferred), the update log; `CLAUDE.md` alongside; `docs/proposals/2026-08-28-ux-enhancements.md` marked #1-#6 built with pointers, #7-#10 left open.

## 2026-08-28 - Second-round product feedback: tip and other fees return as two fields, export reaches iOS, and the parser moves ahead of its own evidence

**The ruling, from the owner's product feedback after two more days of real use, built and locally verified across all three layers. Nothing deployed - see the last paragraph.**

**This partially reverses the 2026-08-26 field reduction, two days later, on the same kind of evidence - first real use - and that reversal is the interesting part of this entry, not a footnote to smooth over.** That entry removed `other_tax_cents` - the lumped field that tips and non-HST amounts shared - and reasoned in writing that a tipped receipt would now show the advisory amber warning forever, and that this was "the warning doing precisely what it was designed to do." Real use said otherwise: the owner reported the mismatch as a real cost, not a warning behaving correctly. **Decided: tip and other fees come back as two separate columns, `tip_cents` and `other_fees_cents` (migration `0006_tip-and-other-fees.sql`), not as `other_tax_cents` restored.** The lump was the problem the 2026-08-26 entry never named as one - a tip and a foreign sales tax have nothing in common except both landing outside HST - and undoing the removal by re-adding the same lumped field would have reproduced the defect it is meant to fix. **Rejected: relumping.** `other_fees_cents` carries every non-HST charge that is neither subtotal nor tip - delivery, service charges, deposits, environmental levies, and a foreign receipt's non-HST tax, exactly the residual the old field's third job covered (§12's foreign-currency note). The confirm-screen arithmetic check (§7.2) becomes `subtotal + hst + tip + other_fees = total`, still advisory, and a tipped restaurant receipt reconciles again instead of warning - restoring the reconciliation the 2026-08-26 entry knowingly gave up, without giving up the split that made the original field impossible to reason about.

**Decided: `hstCents` gains a `disagreement` flag - the date's treatment, narrowed to one field.** When the heuristic and the LLM both produce an HST amount and it differs, the confirm screen marks it amber with an inline note; the served value is unchanged - still heuristic-only, no fallthrough, same rule as every other amount since Aug 8. HST earns this and total/subtotal do not: it is the input tax credit, the one amount with a direct tax consequence, and it is exactly the field a split-HST misread corrupts silently - a heuristic that reads one component of a printed 5%+8% split produces a wrong-but-plausible number the arithmetic check cannot catch when the subtotal is also absent. **Rejected: widening the flag to every amount.** Every inline note costs attention on a screen whose brief is a five-second task; a note that fires on most receipts is wallpaper, not signal. Revisit once real usage shows how often the HST flag actually fires - the same argument that justifies it today argues against widening it further if it turns out to fire on most receipts.

**Decided: both parsers learn the split-HST rule, because the merge rule made a server-only fix useless.** Some receipts print a harmonized tax as component lines at different rates (Ontario's 8% + 5% = 13%) rather than one combined line; naively summing every tax-labelled line double-counts a receipt that also prints the combined total, so the rule sums components only when no line already totals them. The LLM prompt (v4, `RECEIPT_PARSE_PROMPT_VERSION`) gained this rule and asks for `tipCents` for the first time. **But money is served heuristic-only with no LLM fallthrough (the Aug 8 ruling), so a prompt fix alone would never reach the confirm screen** - the on-device Swift heuristic needed the identical rule, narrowly guarded: two or more non-zero tax-labelled rows, every row carrying its own distinct percentage marker, one row's rate equal to the sum of the others (that row already totals it, and wins outright) or not (every row is its own slice, and they sum); anything short of that falls through unchanged to the existing ranking. The wave-5 regression ("GST $0.00 above HST $2.05") is still pinned by test and unaffected. This is a concrete instance of the cost the heuristic-only merge rule carries: every money-affecting parser improvement has to be built twice or it does nothing.

**Decided: the model moves from Claude Haiku 4.5 to Claude Sonnet 5, ahead of the accuracy evidence, on the owner's field report.** He reported real receipts coming back with wrong dates, wrong amounts, and wrong vendor names and asked for a smarter model. §7.3's own accuracy table cannot arbitrate that request - it says so in its own text: every number in it rests on 5 confirmed receipts from 2 vendors, too few to distinguish a good model from a lucky one. This is not the accuracy table concluding Haiku is insufficient; it is an owner's field report acted on because waiting for enough data to be sure would mean shipping known-bad extractions in the meantime. Cost, worked from the one measured run rather than re-estimated: the Aug 7 run priced Haiku 4.5 at $1/$5 per MTok in/out (5,281 input + 332 output tokens over 6 receipts, $0.0069 total, about $0.0012/receipt); Sonnet 5 prices at exactly double on both axes ($2/$10 per MTok), so the same request costs roughly $0.0023/receipt, holding the token counts fixed - an assumption the code's own comment flags as untested, since Sonnet's replies may not run the same length as Haiku's for this task. **What would settle this properly: `npm run parse-accuracy` re-run after weeks of Sonnet-era real use**, the same trigger §7.3 already names for the merge rule. The `model` stamp already recorded on every `llm_suggestions` row is what keeps Haiku-era and Sonnet-era records distinguishable in that comparison.

**Decided: behavioural telemetry, `user_events` (migration `0007_user-events.sql`) and `POST /api/events`.** The owner's own framing: "a user editing the total amount repeatedly signals the total-extraction path is unreliable" - §7.3's `parse-accuracy` only sees the final saved value, never the edits along the way. `action` (24 values: capture/confirm/field-edit/suggestion/receipt/list/image/option/export/session lifecycle events) and `field` (the 10 receipt fields) are fixed enumerations enforced by `z.enum` at the HTTP boundary, not free strings and not Postgres enums - a new value is a code change plus a client release, never a migration. **The central property, structural rather than promised: no event ever carries a field value.** `field_edited` records that `total` was edited, and how many times, never to what. **Rejected: a free-form `meta`/`properties`/`payload` column** - a bag that can carry a value eventually will, the day someone adds "just one more field" to debug something, and a schema that cannot express a value cannot leak one. **Rejected: a durable, outbox-style telemetry store on iOS** - the in-memory queue (cap 300, drop-oldest) is deliberately not the receipt outbox's disk-backed guarantee; a lost diagnostic event is acceptable, a lost receipt is not. **Rejected: an automatic pruning sweeper.** Retention is 180 days, long enough to compare parse quality across a few months of real use and short enough that an unswept table does not become the thing an accidental full read chokes on - but pruning is `npm run events:prune`, run by a person, not a background job; `npm run action-report` is the reader that makes the log worth keeping. `DELETE /api/me` now deletes a user's `user_events` rows in the same transaction as everything else - it has no foreign key to `receipts` (an event can legitimately name a receipt id that never synced, or was since deleted), but it is a child of `users` on the identical term: leaving a behavioural log behind a deletion would be a broken promise, and the kind of thing App Store review tests.

**Decided: an iOS export screen - the sixth - reversing §4.1a and §7.1, which put export on the web client only and said "resist adding a sixth."** That reasoning is not being relitigated: a year-end zip can reach the byte budget's ~890 MB peak, and generating one on the phone with the least storage, only to share it off again, is still the wrong default place to do it. The owner asked for it anyway, which is his call to make, and the trade is accepted rather than argued away - the implementation keeps the original concern real by construction rather than by promise: `ExportViewModel.downloadZip()` streams the finished zip to a temporary file through a `URLSession` download task and never holds it in memory, and all six job states (including the computed `expired` and `stale`) are handled so the screen cannot poll a dead job forever. It lives in Home's overflow menu, above Sign out and Delete account (least destructive first, the same ordering rule those two already follow).

**Three gaps found in the web client, one of them a place the spec recorded work as done that had not actually shipped.** (1) **The wave-7 gate report said the web client rendered the served merge "exactly as iOS renders it" - only the prefill half of that was true.** The amber unreviewed-suggestion marking and the arithmetic warning were never implemented on web at all; both are now built (`ReceiptForm.tsx`: `suggestedFields`, `arithmeticMismatch`, the amber `className` wiring). (2) **The detail screen prefilled a pending receipt from its row instead of from the served merge**, so a pending receipt opened from the table showed its suggested fields marked amber and *empty* - the amber promised a suggestion the form had thrown away - while the identical receipt opened through the confirm queue prefilled correctly. Fixed with one shared `draftForDisplay` rule (pending renders the merge, confirmed renders the row) that both screens now call, so the two paths cannot diverge again. (3) **The date-disagreement note did not clear when the field was touched**, contradicting §10A.1's "touching the field clears the tint and the note together" - it lived in the confirm queue's own JSX, disconnected from the touched-state the amber tint tracked. Fixed by moving both the date and the new HST note inside `ReceiptFieldsForm` itself, gated on the same `touched` set the amber tint reads, so the two cannot drift apart again by construction.

**Verification performed, stated precisely because the gate report (`docs/gates/product-feedback-2026-08-28.md`) is not this entry's job.** Server: 500 tests / 47 files green, `tsc --noEmit` clean, migrations read before running and applied to the local database only. iOS: 311 unit tests and 5 UI tests green on simulator; the zoom rewrite (backed by a real `UIScrollView` via `UIViewRepresentable`, fixing a `ScrollView` that proposed an unbounded size to `.scaledToFit()` and a zoom floor of 1 that made zooming out impossible) verified by screenshot. Web: 68 tests / 8 files green, production build clean, `user_events` rows read back from Postgres and grepped for the exact values typed into the form, finding none. **The split-HST prompt was checked against the live model on two real API calls (~$0.007), returning 260 cents for both the split-line receipt and the double-counting trap** - the strongest verification available short of real receipts, but two synthetic inputs, not a re-run of `parse-accuracy` over real use.

**Deployed the same day, on the owner's instruction, and recorded rather than summarised.** A `pg_dump` of production was taken first and **verified by restoring it** into a scratch database and matching row counts (`users 2, receipts 78, receipt_images 78, export_jobs 0`) - `~/.kept/backups/kept-prod-20260828-premigration-0006-0007.dump`. Production held **78 receipts, not the 53** `CLAUDE.md` recorded on 2026-08-27: real use continued between the two readings, the same lesson the 2026-08-26 migration entry recorded about a row count being a reading with a timestamp rather than a state.

**Migrations ran before the deploy, not after, and the ordering was a decision.** Runbook §2's default is to migrate *after* deploying when a migration only adds things - and both of these only add (two nullable columns; one new table). But the new code cannot run without them: the ORM selects `tip_cents` on every receipt read, and `POST /api/events` inserts into `user_events`. Deploying first would have left the API broken against its own schema for the length of the migration. Migrating first was safe in the other direction because both changes are backward-compatible with the machine-v6 code that was still serving: a nullable column it never selects and a table it never touches. `fly ssh console -C "npm run db:migrate"` was **not** the path used, and not only because of the tunnel failure recorded 2026-08-26 - the deployed image did not yet contain `0006`/`0007`, so the documented in-machine command could not have applied them. Runbook §2's laptop fallback against Neon's **direct** (non-`-pooler`) endpoint is what ran.

**Verified against the artifact, not the exit code.** Post-migration reads of the real schema: `tip_cents` and `other_fees_cents` present on `receipts` as nullable integers, `user_events` present with its `(user_id, occurred_at)` index and its `users` foreign key, `receipts_confirmed_complete_ck` unchanged, and all 78 receipts intact with no value backfilled into either new column. `fly deploy` then rolled the machine to **version 7**, health check passing, and the boot log printed `Receipt parse model: claude-sonnet-5` - the new `RECEIPT_PARSE_MODEL` resolution working in production, unset and therefore defaulted. Through Cloudflare, `GET /api/me` answers **401** with `Cache-Control: no-store`, `POST /api/events` answers 401 (registered, behind session auth), and `keptapp-api.fly.dev` still answers **403** directly - the edge secret is still doing its job, so the origin has not been left reachable around the limiter. The Pages redeploy went out in the same session: `keptapp.net` serves the new bundle (hash matched against the local build), the redesigned stylesheet, and a privacy page carrying the usage-data disclosure and its 180-day window - differing from the built file only by Cloudflare's email obfuscation of the contact address, as `web/README.md` documents.

**What is still not done, and is the owner's.** The **App Store Connect privacy label** has not been refiled to match `PrivacyInfo.xcprivacy`'s new Product Interaction entry (linked, not tracking, Analytics purpose) - the ruling and its gate are the next paragraph. **No iOS build carrying today's work has been produced or uploaded**: the phones still run 1.0 (2), which predates every field, screen and event in this entry, and which keeps working against the deployed API because the two new receipt fields are absent-tolerant and the new `suggestions.hstCents.disagreement` key is one its decoder ignores. All of this lands while the 1.0 (1) App Store resubmission is still pending (2026-08-26 entry below): the demo recording, the Sign in with Apple `.p8`, and the Resolution Center reply remain first in the queue, and the R2 `kept-backups` token remains unminted and unrelated to any of it.

**Decided the same day, on the owner's ruling: the telemetry ships, and the privacy label is refiled to match it - but not before the pending resubmission.** The options weighed were holding telemetry out of the next build entirely, shipping it web-only (no manifest change, no refiling, but data from the client used least), and refiling the label so the iOS build can carry it. The owner chose the third and deferred its execution: **the label refiling is an owner action item, sequenced behind the 1.0 (1) demo recording, the Sign in with Apple `.p8`, and the Resolution Center reply.** The consequence to hold onto is a gate, not a preference - **no build carrying `PrivacyInfo.xcprivacy`'s Product Interaction entry may be submitted to App Review until the App Store Connect label declares it too.** A manifest and a label that disagree is the failure §11's original filing established the word-for-word discipline to prevent, and it is the kind of mismatch a reviewer checks. Tracked in `CLAUDE.md`'s status section and in `docs/gates/product-feedback-2026-08-28.md` §5.

**Decided: the parse model becomes configurable rather than hardcoded** (`RECEIPT_PARSE_MODEL`, defaulting to `claude-sonnet-5`; Runbook §0). The reasoning is the same one that makes this model change unusual in the first place - it was made on a field report, ahead of the accuracy table - so the way it gets settled is to be able to move the model against real production traffic without a deploy, and let `npm run parse-accuracy` compare the populations afterwards. The sweep's `model` dependency is **required, not defaulted**: the stamp on a stored record exists to name the model that actually produced it, and a default there would let a configured model quietly write records crediting a different one, corrupting exactly the comparison the variable exists to enable. **Rejected: validating the id against a list of known models** - that list needs maintaining every time Anthropic ships one, and a stale allowlist would refuse the exact upgrade this variable exists to allow; a typo instead surfaces as parse failures with the bad id recorded, and the entrypoint prints the resolved id at boot.

**Spec amended in this commit:** §4.2 (server-parse row: model, cost), §5 (`receipts`' two columns, `user_events` and its retention), §6 (`POST /api/events`, the options route's `vendors`, create/update fields), §7.1 (six screens, Home's Export menu item), §7.2 (field order, the four-term arithmetic check), §7.3 (prompt v4, the model, split HST in both parsers, the HST disagreement flag), §7A (the redesign, the amber/arithmetic gap closed), §8 (14 columns), §10A.1 (the HST note), §10B (telemetry retention, what account deletion now destroys), §12 (the foreign-currency note), the update log; `CLAUDE.md` alongside.

## 2026-08-26 - Build 1.0 (2) is on TestFlight: uploaded from the command line, and the Apple key is sequenced before the resubmission

*Recorded 2026-08-27, for an upload that completed 2026-08-26 at 23:53. Latest of the four entries under this date.*

**Done, recorded rather than decided.** `CURRENT_PROJECT_VERSION` went 1 → 2 on the Kept target's Debug and Release configurations (commit `7a92cd4`; the test targets were left at 1, being neither archived nor uploaded), and the build was archived, distribution-signed and uploaded to App Store Connect. Processing completed, the build joined the **Internal Testers** group without manual assignment, and TestFlight now offers it to both testers - 2 invites, 0 installs at the time of writing. This fires the trigger the *"the second user is on TestFlight"* entry below left open: *"she picks up 1.0 (2) as an ordinary TestFlight update once it ships and is added to the group."* It has shipped and she is in the group.

**This is a TestFlight upload and nothing more. Nothing was submitted to App Review**, and the Resolution Center reply drafted 2026-08-25 is still unsent.

**No App Store Connect API key was needed, and the org does not have one.** Users and Access → Integrations offers only a *Request Access* button - API access has never been enabled on this account, and enabling it was deliberately not done. `xcodebuild -exportArchive … -allowProvisioningUpdates` instead minted **cloud-managed** distribution signing against the account's existing session, producing `Apple Distribution: 8C9D (<team-id>)` and an *iOS Team Store Provisioning Profile*. Passing `destination=upload` in the export options plist uploaded in the same step, with `manageAppVersionAndBuildNumber=false` so Xcode could not rewrite the build number. Commands and traps: `ios/CLAUDE.md`.

**Two traps found the honest way, both of which make a broken build look shippable.** First, `security find-identity -v -p codesigning` lists **only** "Apple Development" even when cloud-managed distribution signing is available - its absence there was read as "no distribution certificate exists" and that read was wrong, and it is why this session first reported itself blocked on credentials it did not need. Second, and worse, **`xcodebuild archive` succeeds while producing a development-signed archive** (`get-task-allow=true`, `ProvisionedDevices` present); distribution signing is applied at *export*, not at archive, so an `** ARCHIVE SUCCEEDED **` on its own is no evidence of an uploadable artifact. Both were caught by inspecting the exported `.ipa` - `codesign -dvvv` and the embedded profile - rather than by trusting exit codes, which is §10's rule doing its job. Also noted: App Store Connect's web UI has no build-upload control at all; *Build Uploads* is a monitoring view, and binaries arrive only through Xcode, Transporter, `altool` or the API.

**Decided: the Sign in with Apple `.p8` is minted before the resubmission, not before this upload.** The three `APPLE_*` variables are still unset, so account deletion deletes the account and revokes nothing - confirmed in the code rather than taken from the Runbook: unset, `resolveAppleSignInKey` returns null and the entrypoint says so at boot; per deletion, `revokeAppleTokens` returns a reason string rather than throwing, the account is deleted in full, and `console.error("Account deleted without revoking Apple tokens: …")` fires after the commit. That is the best-effort design §10B describes, working as specified, and it correctly did not block a TestFlight build going to two known testers. It should not survive to App Review: the reviewer will test account deletion specifically, and the observable trace of the gap is the app remaining listed under the tester's Apple ID. **Rejected: minting it before this upload** - it would have held the second user's update behind an owner action in the developer portal for no benefit to her, since revocation matters to the reviewer, not to the two people already using the app.

**Still the owner's, in order:** the demo recording on a physical device; the Sign in with Apple key and its three Fly secrets; then the Resolution Center reply and resubmission. Approval, the unlisted conversion and pressing Release still sit behind all of it. The R2 `kept-backups` token remains unminted and unrelated to any of this.

## 2026-08-26 - The field reduction is deployed: migration 0005 ran from a laptop, and production held five receipts, not one

*Recorded 2026-08-26, as `CLAUDE.md`'s status section was slimmed into this log. Same day as, and later than, the two entries below.*

**Done, recorded rather than decided.** `fly deploy` rolled the API to **machine v6** and the Cloudflare Pages redeploy went out in the same session, which is what the field-reduction entry below required of them - the old web bundle's `isBusiness` filter would have 400ed against the new API. A manual `pg_dump` preceded the migration and sits at `~/.kept/backups/kept-prod-20260826.dump`.

**The migration did not run the documented way, and the reason is recorded rather than smoothed over.** `fly ssh console -C "npm run db:migrate"` established its tunnel and then timed out probing the internal API. Migration 0005 instead ran from the owner's laptop against Neon's **direct** (non-`-pooler`) endpoint - the same `DATABASE_URL` the backup had just proven could reach production.

**The tunnel was chased later the same day and is still unexplained - but it is not simply blocked UDP.** The first guess was UDP/51820, the usual cause and the one `fly doctor` itself suggests. That guess is wrong, or at least incomplete: WireGuard-over-websockets was enabled and the agent log confirms it genuinely connected over `wss://yyz2.gateway.6pn.dev:443/`, and the probe failed identically over TCP/443. `fly doctor` reports authentication and agent PASSED and the gateway ping FAILED with "no response from gateway received" - the tunnel's control path establishes every time and the data path never does. Ruled out by test, not by assumption: the stale flyctl agent (upgraded 0.4.83 → 0.4.93 mid-session), the peer itself (`fly wireguard reset`, fresh peer and keys), ProtonVPN's transparent-proxy and WireGuard system extensions (quit entirely, no change), the macOS application firewall (disabled), TLS interception (the gateway presents a self-signed `O=fly.dev` certificate, which is what it is supposed to present, and which also explains a benign `curl` CA error), and Fly's own status (all operational; the YYZ 6PN incident was 2026-08-19 and resolved). One unresolved observation, recorded because it would produce exactly this symptom if real: the agent's logged `WireGuardState.localpublic` equals `config.yml`'s `localprivate` and differs from its `localpublic`, reproducibly across fresh peers - most likely a cosmetic quirk in how flyctl serializes that struct, unproven either way because deriving the public key from the private key was refused as a handling of key material. The decisive test - the same commands from a different network - was set up and abandoned when the iPhone hotspot would not hold a connection. **Consequence for the Runbook: §2's `fly ssh console -C "npm run db:migrate"` cannot be assumed to work from this machine, and the direct-endpoint path above is what actually ran.** Post-migration read: the three columns dropped, the CHECK constraint down from four terms to three, every core field intact.

**Production held five receipts, not one.** Four confirmed and one pending across the two users, ahead of the `users 2, receipts 1` the TestFlight entry below recorded that morning: real use continued between the two readings and nothing logged it. The honest lesson is that a row count in a status doc is a reading with a timestamp, never a state. The migration discarded the supplier tax number and the business flag on all five; the stored images keep the printed numbers, as the field-reduction entry said they would.

## 2026-08-26 - First-use product feedback: the receipt slims to the fields a person actually fills, and the list and export grow the conveniences

**The ruling, from the owner's product feedback after the first real use.** A receipt is **Date, Vendor, Subtotal, HST, Total, Category, Payment, Notes** (plus image, currency, status, and the immutable suggestion records). Removed at every layer - schema, API, export, both clients: the **supplier's GST/HST registration number** (`vendor_tax_number`), **`other_tax_cents`**, and **business-vs-personal** (`is_business`). This knowingly amends §3, which is exactly what §3 says such a change is: a spec change, not an implementation decision. Constraint 1 keeps its core - **HST is its own field, never folded into the total** - and loses the registration-number clause; constraint 3 (business-vs-personal at capture time) is retired outright, and the constraints renumber from four to three. The trade, stated: the export loses the `vendor_gst_hst_number` and `business_or_personal` columns, and the CRA-documentation role the registration number played is carried by the stored receipt image, where the number stays printed - the field was a per-capture transcription cost duplicating what the image already holds, weighed against the success test's "captured in under a minute".

**Answered before removing it: why "other tax" existed at all.** It arrived with the original wave-0 schema (commit `1370809`, 2026-08-05), never as a later addition, with three jobs: keep tips and non-HST amounts **out of the HST field** so the input-tax-credit figure stays pure (§5's own note), feed §7.2's arithmetic check (`subtotal + hst + other_tax = total`), and carry a foreign receipt's non-HST tax (§12 leaned on it for "a US receipt with no HST line"). Removing it costs none of the first job - HST purity was the constraint's core and stands - and re-shapes the other two: the arithmetic check becomes `subtotal + hst = total`, so a tipped or foreign receipt now shows the non-blocking amber prompt-to-look. That is the warning doing precisely what it was designed to do ("a prompt to look, not a rule"); it is not a defect, and it is the accepted consequence.

**Decided: the shipped 1.0 (1) build keeps working, by two named shims with one removal trigger.** The request schemas are strict (`z.strictObject`), and the second user's installed TestFlight build sends `isBusiness`, `vendorTaxNumber` and `otherTaxCents` on create and PATCH - and decodes `suggestions.vendorTaxNumber` through a non-optional struct key. So: (1) create/update **accept the three legacy body keys and discard them**, never storing anything; (2) every receipt response keeps a **null-valued `suggestions.vendorTaxNumber` (`{value: null, source: null}`)**. Both are commented and pinned by test as transitional, removed when no installed build sends or decodes them. On her build the removed fields simply render as stated absences. **Rejected: the same tolerance for the web client's `isBusiness` list *filter*** - silently ignoring a filter returns data the user asked to exclude, which is a lie rather than a shim; the deployed web bundle instead redeploys to Pages alongside the API deploy (both are the owner's, in the same session).

**Decided: categories and payment methods become reusable by derivation, not by a table.** `GET /api/receipts/options` serves the user's own distinct non-null values over non-deleted receipts (pending included), most recently used first, capped at 100 each; both clients render them as pick-or-type. Category stays **free text** - the no-enum, no-taxonomy rule is untouched, and a picker over the user's own history is a convenience, not a vocabulary. No normalization: the same-day ruling on the doubled-space category stands - the values are the user's own data. **Rejected: a categories/payments table** - it brings a management surface (rename, delete, merge) nobody asked for and a synchronization question the derivation structurally cannot have.

**Decided: the export zip gains `receipts-{label}.json`; there is no format picker.** The feedback asked for "Excel plus other formats" - Excel and CSV have both been in the zip since wave 2, so the addition is JSON: the same 12-column dataset in a third encoding, one row source feeding all three writers, money as decimal strings, and the 2026-08-15 formula-fidelity rule untouched for the CSV and XLSX. **Rejected: a format picker** - a job parameter and UI whose only effect would be subtracting files from a zip that already carries all three.

**Decided: the list grows sort and two filters, and the default sort - already the receipt date - becomes pinned rather than incidental.** `GET /api/receipts` gains `sort` (`purchasedAt` default | `capturedAt` | `total` | `vendor`) and `order` (`desc` default), plus exact-match `category` and `paymentMethod` filters; the `isBusiness` filter goes with its column. Rows with a null sort key order last in either direction; cursors encode the sort they were minted under and a mismatched cursor is refused, because a cursor is a position in one specific ordering. The server has ordered by `purchased_at` since wave 1 - the feedback's "default sort by receipt date, not capture date" was already true at the API and is now also the stated, tested default rather than a happenstance - and iOS gains the search/sort/filter UI it never had, the web table the sort controls it never had.

**Decided: editing after confirmation is a feature, stated, not a loophole.** `PATCH /api/receipts/:id` has permitted editing confirmed rows since wave 1; the only lock in the system was an iOS view-level guard hiding the form. Both clients now expose editing on confirmed receipts through the same form and the same PATCH. Constraint 2 is untouched: amber-until-touched marks *unconfirmed suggestions*, so a confirmed receipt's edit form carries no amber - a human revising values a human already confirmed. The one refusal stands: a confirmed receipt may not end up without a total.

**What the production migration will discard, stated before it runs.** Migration 0005 drops the three columns. Production's one receipt - the second user's - carries `is_business = true` and a supplier tax number; both values are discarded the moment the owner runs the migration there. The receipt image keeps the printed number. The deploy and migration are the owner's, per the standing production rule, and the shims above are what let her un-updated app keep capturing in the meantime.

**Also swept along:** the LLM parse schema and prompt stop extracting the tax number (**prompt v3**; stored v2 records stay untouched and `parse-accuracy` stops scoring the field, so §7.3's merge sentence becomes "vendor comes from the LLM"); the iOS heuristic parser drops its registration-number regex; the web privacy page stops naming the registration number in its collected-data list (the App Store privacy label's declared *categories* are unchanged - amounts and tax figures were and remain "other financial info" - so no label refiling is needed).

**Spec amended in this commit:** §3 (four constraints become three), §5 (`receipts` table, indexes, the CHECK, §5.2 deleted), §6 (route table: list params, the options route, PATCH), §7.1, §7.2 (field order, save gate, arithmetic check), §7.3 (heuristics, merge, prompt v3), §7A, §8 (12 columns, the JSON file), §10A.1, §12, the update log; `CLAUDE.md` (constraints, engineering rules, status).

## 2026-08-26 - the second user is on TestFlight, ahead of App Store approval; production has a second real user

**What happened, recorded rather than decided.** With Apple's review of build 1.0 (1) still unresolved (rejected 2026-08-22, the reply drafted 2026-08-25 but not yet submitted), the owner asked whether the second user could start using Kept before approval. TestFlight internal testing needs no Beta App Review and is a separate track from the App Store listing - an App Store rejection does not pull a TestFlight build - so this could run ahead of, not instead of, the pending resubmission.

She was invited to App Store Connect as a **Marketing**-role user, scoped to **Kept Receipts only** (the account also holds Poker Range Trainer, unrelated, which she was not given access to). The App Store Connect invitation email did not arrive on the first send - most likely Gmail filtering, never conclusively diagnosed - and was resent once before she received and accepted it. She was then added to the existing **Internal Testers** TestFlight group, which already carried build 1.0 (1). She installed TestFlight and Kept Receipts on her iPhone, signed into production with the same Apple Account the invitation targeted (`[redacted]`, confirmed by the owner to be the account her phone already used), and captured a receipt.

This changes the sequence the 2026-08-22 entry below recorded ("What remains before the second user installs: Apple approves the review... The owner presses Release; the App Store link goes to the second user"). That sequence still describes what has to happen for the public App Store listing; it no longer describes when the second user herself gets access, which has already happened.

**Verified against production, read-only, from the owner's own request.** `users 2, receipts 1, receipt_images 1, export_jobs 0` - up from `users 1, receipts 0`, the reading recorded 2026-08-18 and re-read unchanged 2026-08-20. The new user row was created 2026-08-26T03:15:51Z. Her receipt (vendor, amounts and purchase date redacted, `status = confirmed`, `is_business = true`, a supplier tax number present) and its one image (sha256 present, R2 object key namespaced under her user id) both carry her `user_id` - isolation holds on the first real second user the system has had. `ocr_suggestions` and `llm_suggestions` are both populated on the row: the server-side LLM parse sweep ran against a real production receipt for the first time.

**What this leaves open, not closed by this entry.**
- The nightly backup pipeline (`docs/DECISIONS.md` 2026-08-20, "Step 17 executed to the token boundary") is installed but not running - the R2 `kept-backups` token is still unminted. Her receipt and its image currently survive nothing worse than Neon's 6-hour PITR window (`history_retention_seconds: 21600`, read from the project).
- The restore drill's image leg, deferred in that same 2026-08-20 entry "until the first receipt with an image lands in production," has had its trigger fire and has not yet been re-run.
- She is on build 1.0 (1), which has no in-app account deletion; she picks up 1.0 (2) as an ordinary TestFlight update once it ships and is added to the group.
- Her `category` value on the one receipt carries a doubled internal space (`"Office  Expenses"`) - free text by design (§5.2), left as her data; the owner will mention typing it consistently rather than the system normalizing it.

## 2026-08-25 - App Review rejected 1.0 (1); in-app account deletion is built, at every layer

**What happened.** Apple rejected build 1.0 (1) under **Guideline 2.1 - Information Needed**: the review needs a screen recording of the app in use, and that recording has to include the account-deletion flow. Kept had none. It creates accounts (Sign in with Apple, the only way in), which puts it squarely inside **Guideline 5.1.1(v)**: *"If your app supports account creation, you must also offer account deletion within the app."* Apple's own account-deletion page adds the shape it has to take - *"Offer to delete the entire account record, along with associated personal data… only offering to temporarily deactivate or disable an account is insufficient"* - and its FAQ adds: *"Apps that support Sign in with Apple should use the Sign in with Apple REST API to revoke user tokens."*

**Decided: `DELETE /api/me` hard-deletes, and it is the only hard delete in the system.**
Every other delete here is soft, because §10B's retention rule protects a person from losing a tax record by accident: `DELETE /api/receipts/:id` tombstones the row and keeps the bytes for CRA's six years.
That rule is about accidents. This is not one - it is the record's own owner deliberately destroying their whole account, twice-confirmed in the client - and a tombstoned account does not satisfy "delete the entire account record" and would not be honest to the person who asked.
So the endpoint deletes every `receipt_images`, `receipts` and `export_jobs` row the user owns, tombstoned rows included, then the `users` row, in one transaction; then their objects out of storage.
Rejected: soft-deleting the account and calling it deletion (Apple names that as insufficient in as many words); and a delayed/queued deletion (permitted by Apple if disclosed, but it needs a disclosure, a job and a way to see it, to buy nothing at three users).
**What the endpoint deliberately does not claim:** that every copy is gone. The nightly off-site `pg_dump` (Runbook §4) holds prior snapshots that age out on their own schedule. That is retention working as designed, and the deletion path says so in a comment rather than implying otherwise.

**Decided: storage is erased after the commit, best-effort, with failures counted and logged.**
Storage has no transaction to join, so one of the two orders has to lose. Rows-then-objects means the worst case is unreferenced bytes whose keys begin with a user id no session can ever present again. Objects-then-rows means a failed commit leaves live rows pointing at images that are gone - a person still signed in, looking at receipts whose photos have vanished. The first is an orphan; the second is a lie told to a user.
Stored keys are re-validated on the way out (`isIssuedObjectKey` / `isIssuedExportKey`) before anything is deleted, for the same reason the detail route re-validates before presigning: a key we did not issue may name another account's object, and deleting it would be worse than leaving it. One that fails is skipped and reported.
`ObjectStorage` gained `delete`, whose contract is that deleting an absent key **succeeds** - the exact opposite of `download`'s rule, and stated at the interface. There, absence is a fact a caller must act on; here it is the outcome being asked for, and an upload that never finished is the ordinary case, not a failed deletion.

**Decided: revocation is real, and it is best-effort - the deletion is never blocked on Apple.**
The server stores nothing revocable: sign-in verifies an identity token and throws it away, deliberately, because a stored refresh token is a credential to guard for the life of the account. So the iOS client runs a **fresh Sign in with Apple authorization at deletion time** and sends the resulting `authorizationCode` (Apple's bound: single-use, five minutes) in the DELETE body; the server exchanges it at `/auth/token` for the refresh token and revokes that at `/auth/revoke`, authenticating both with a freshly minted ES256 client-secret JWT.
Order: revoke first, then delete. Revocation is the only step still retryable afterwards - it removes the app's authorization, and a person who signs in again simply re-authorizes.
A revocation that fails does **not** stop the deletion. Apple's own guidance is explicit: *"If you don't have the user's refresh token, access token, or authorization code, you must still fulfill the user's account deletion request."* Refusing to delete an account because `appleid.apple.com` answered 400 would deny the person the very thing 5.1.1(v) grants them. Every way it can not-happen - no key configured, no code sent, Apple refused - gets its own error-level log line, because an app that quietly stops revoking is indistinguishable from one that never did.
Dismissing Apple's sheet **cancels** the whole deletion: it is the last point at which a person can change their mind. Any other re-authorization failure proceeds without a code.

**Decided: the revocation key is NOT boot-blocking in production.**
`ANTHROPIC_API_KEY` is, and this is deliberately not that. Round 2's lesson, recorded in §10B: making a boot-blocking requirement out of a permission a third party grants (`HeadBucket` against R2) traded a P1 for a P0. The Sign in with Apple key exists only if Apple's portal has issued it, which is that exact shape.
Unconfigured, the process announces at boot that revocation is **DISABLED** and names the three variables; each deletion logs it again. All three or none - a partial set throws at startup naming what is missing, the same rule `STORAGE_*` follows, because "revocation is off" and "revocation is misconfigured" look identical from outside and only one of them is a decision.
⚠ **the owner's, before the next production deploy:** create a *Sign in with Apple* key in the developer portal, download its `.p8` (Apple allows this once), and set `APPLE_TEAM_ID`, `APPLE_SIGN_IN_KEY_ID` and `APPLE_SIGN_IN_PRIVATE_KEY` as Fly secrets. `APPLE_CLIENT_ID` already holds the value the revoker needs as `client_id`: native iOS authorization uses the **bundle id** as its client identifier, and a Services ID there earns `invalid_client`.

**The one leg that stays unverified, and it is flagged rather than buried.** Nothing automated can prove Apple *accepts* the client secret - that needs the real endpoint with a real portal key and a real Apple account. What is proven: the two-step call shape, the exact client-secret JWT (header `alg`/`kid`, claims `iss`/`iat`/`exp`/`aud`/`sub`, verified against the public half of a locally generated P-256 key), that no `redirect_uri` is sent (native authorization provided none, and Apple's rule is to include it only if the original request did), and that every failure mode arrives as `AppleRevocationError` rather than as something the route would not recognise. The first real revocation happens the first time a person deletes an account against production.

**Decided: the web client deletes without a code.**
It runs no native re-authorization, so it has nothing revocable to hand over; the body field is optional and its absence is logged. The App Store requirement is iOS's, and the web client gets the same destructive action so the two do not disagree about what an account is.

**Verified against the running server, not the suite.** `npm run dev`, a fresh `dev:deletegate` user, a receipt captured through the real API with its bytes PUT to MinIO through the real presigned URL, then `DELETE /api/me`: 204; the same session token 401s afterwards; the still-signature-valid presigned image URL answers `NoSuchKey`; the `dev:gate` fixtures (one user, three receipts, three images, one export job) are byte-for-byte untouched. The boot line and the per-deletion log line both read as written.

**Spec amended in this commit:** §6 (the route table), §5 (`users`), §10B (retention - what account deletion revokes and what it does not claim), §7.1 (the Home menu), §7A (the web client's account area), the update log.

## 2026-08-22 - Ship day: build 1.0 (1) is submitted for review and the unlisted request is filed

On the owner's instruction ("ship as soon as possible; identity linkage must not block it"), after the pre-ship security pass (`docs/security/pass-2026-08-22.md`) found nothing blocking. Every action below ran in the owner's signed-in sessions and was read back from the page after saving, not trusted from the flow's own confirmations.

**Decided: the visibility question resolves to unlisted, not paid.**
The owner asked whether App Store visibility could be limited to the family, and to make the app paid if not.
The option exists and was the plan of record all along: unlisted distribution - approved through normal review, then reachable only by direct link, absent from search, browse, charts, and listings.
Rejected: a paid app, on both of the question's own axes - a price does not hide an app (it stays fully searchable, it only charges strangers who find it), and going paid requires the Paid Applications Agreement plus banking and tax setup, the opposite of "as soon as possible".
The standing caveats stand: unlisted is not private (in-app auth and per-user isolation are the real protection, as they always were), and the conversion is permanent for this record.

**Decided: the privacy contact is the owner's own email, published on the live page.**
His ruling: the app may be linked to his identity for now, and changing the associated identity later must not block shipping today. Swapping it later is one page edit and one Pages re-upload.

**Decided: availability is Canada only.**
Factual (the business is Canadian, both users are in Canada), it shrinks exposure in the same direction as unlisted, and it sidesteps the EU Digital Services Act trader-status declaration - a legal attestation that is the owner's to make, not an agent's, and that a Canada-only app does not need. If EU availability is ever wanted, the DSA declaration comes first.

**Decided: manual release.**
The app must never sit publicly searchable between review approval and the unlisted conversion; release is pressed after the conversion is in place.

**Done, recorded rather than decided** - the App Store Connect completion this required: Content Rights declared (no third-party content), Copyright "2026 8C9D", price confirmed Free ($0.00 read from the price table), the privacy policy URL `https://keptapp.net/privacy` saved into App Privacy, and the listing the distribution-day session had already prepared (screenshots, description, keywords, support URL, review notes stating unlisted intent, sign-in-required correctly off for a Sign in with Apple-only app) verified in place. Submitted: **1.0 Waiting for Review** ("1 Item Submitted", up to 48 hours). The unlisted request was filed from the owner's Account Holder session with honest answers (1 organization, 2 people, 2 unmanaged devices, Canada, internal full-time staff) and answered "Thank you for your submission."

**What remains before the second user installs:** Apple approves the review; Apple approves the unlisted request (the record then converts automatically); the owner presses Release; the App Store link goes to the second user. If Apple declines the unlisted request, the fallback decision - release publicly-but-obscure in Canada, or hold - is the owner's, on the facts of Apple's answer.

## 2026-08-21 - Wave 7 built and gated locally: the web client exists, and the API opened exactly two seams for it

Full record: `docs/gates/wave-7.md`. The decisions, so they outlive the report:

**Decided: the web client is Vite + React + TypeScript (strict), two runtime dependencies, no router, no component or state library.**
§7A's "static build to Cloudflare Pages" and "density over friendliness" want the boring default with the fewest moving parts; five views switched by plain state need no router, and everything the client knows is one fetch away because the server owns every rule (§4.1a).
Rejected: anything that would tempt a second implementation of domain logic - the client renders the served merge, the served statuses, the served refusal sentences.

**Decided: the web session is the same bearer JWT iOS carries, held in localStorage - not a cookie.**
The trade, stated: a script-readable token on a page that loads no third-party script anywhere a token exists (Apple's sign-in JS is confined to the signed-out screen), against an httpOnly cookie that would hand the API a second authentication path - CSRF defences, SameSite semantics, a divergence between clients - to carry forever.
30-day expiry; every 401 degrades to the sign-in screen.
Rejected: a runtime-configurable API address. The bundle bakes `https://api.keptapp.net` for the same reason the iOS Release build does (wave 6): a client that can be pointed elsewhere is a control with one dangerous use.

**Decided: the verifier accepts a set of Apple audiences, and CORS grants exact configured origins or nothing.**
`APPLE_WEB_CLIENT_ID` and `WEB_ORIGIN` are optional: unset - today's production - the deployed behaviour is byte-for-byte pre-wave-7 (iOS audience only, no CORS surface at all). The audience logic is proven against locally-generated keys; origin reflection dies by mutation. CORS sits below the edge secret (a preflight arrives through Cloudflare like any request) and grants no credentials.

**Decided: local web dev signs in with a pasted token from `npm run dev:session-token`, and the affordance is compiled out of production builds.**
Sign in with Apple for web needs a Services ID with a verified domain - a production artifact no localhost has. The script signs with the `SESSION_JWT_SECRET` the dev server itself reads from `.env.local`, so it wields only the authority the operator already holds; it refuses `NODE_ENV=production` and non-local databases, and the production bundle carries zero instances of the dev entry (asserted against the built artifact, with positive controls, wave-6 style).
Rejected: any server-side flag that weakens the verifier - the "no bypass reachable from configuration" property stands untouched.

**Decided: the backlog upload sets business-or-personal per batch before anything uploads, dates each receipt to the upload day, and reports a duplicate as a duplicate.**
The drop is §6A's capture moment, so constraint 3 puts the choice there, unpreselected (§5.2: no default at any layer - the dropzone is disabled until a person chooses).
The upload-day date is the same capture-day fallback the iOS confirm screen prefills, guarded the same way (constraint 2: pending until a person confirms every field against the image).
The 409 `duplicate_image` renders "already uploaded - an identical file is attached to one of your receipts" - round 4 §2.2's forward constraint honoured: on this path a duplicate is a user-facing fact, never a lost 201.
No OCR runs on web uploads, deliberately: they carry no suggestions, the sweep never sees them (no stored OCR text), and their fields get typed in the confirm queue. §6A's "narrower than it sounds", kept narrow.

**Found by predicting before measuring: R2 needs a bucket CORS rule for the browser's presigned PUT.**
Flagged as the likeliest gate failure before any browser started; MinIO's permissive default let the gate pass, and the R2 difference became `web/README.md` deploy step 3 instead of a production incident. iOS never sees this (URLSession sends no Origin), which is exactly why it would have been found in production otherwise.

**Spec amended in this commit:** §7A (built-and-gated status), §4.2 (web stack line), the update log. Production enablement - Services ID, the two Fly secrets, the R2 CORS rule, the Pages deploy - is the owner's, listed in `web/README.md` and wave-7 §4.

## 2026-08-21 - CI's first run never started: GitHub refused the job on account billing

*Recorded 2026-08-26, filed under the date it happened. The fact was measured on 2026-08-21 and had lived only in `CLAUDE.md`'s status section until that section was slimmed.*

**What happened, recorded rather than decided.** The push that landed `.github/workflows/server.yml` triggered the workflow and GitHub refused to start the job: *"recent account payments have failed or your spending limit needs to be increased."* The entry below closes on the sentence that the first real run "is the artifact that closes this entry's loop" - that artifact does not exist. The workflow is still verified only by YAML parse and by the local rehearsal of its exact steps, and stays **unvalidated on GitHub's runners** until the billing state is fixed and a run actually executes. Recorded rather than left implicit because a CI that has never run and a CI that runs green look identical from inside the repository.

## 2026-08-21 - CI exists: the backend suite on push, run against the same compose file dev runs

**Decided: §10B's "GitHub Actions running the backend suite on push" is built as one workflow that starts `server/docker-compose.yml` and runs `npm ci`, `npm run typecheck`, `npm test` on an Ubuntu runner, Node 24 to match dev.**
The suite needs no secrets in CI: `ANTHROPIC_API_KEY` is absent by construction (the LLM tests run against fakes, the same posture deploy-prep enforced on its own processes), the integration tests create their own test database, and the storage tests create their own bucket - all verified by rehearsing the workflow's exact steps locally from a clean `npm ci` (354 green).

**Rejected: GitHub service containers.**
They would be a second spelling of the services the compose file already commits - different images or different flags drifting independently of what dev runs - and the `services:` syntax cannot carry MinIO's `server /data` command line without switching to a differently-packaged image, which is exactly the divergence. The framework's rule 5 (no second environment shape) decides this.

**Rejected: a unit-only CI.**
The integration half is where the isolation gate and the log-hygiene invariant live; a CI that skips them certifies style, not behaviour.

**Rejected: iOS in CI.**
It needs a macOS runner and signing surface for a suite every gate runs anyway; the spec scoped CI to the backend deliberately, and that scoping stands.

**Stated rather than smoothed over:** a workflow cannot be executed from this machine. It is verified by YAML parse and by the local rehearsal of its exact steps; its first real run happens on the next push to GitHub, and that run is the artifact that closes this entry's loop.

## 2026-08-20 - Production-readiness round 4: the post-deploy pass runs on the owner's instruction, and nine of the eleven close

**Decided: the 2026-08-15 deferral's "waits for production evidence or a new P1" gains its third trigger retroactively - The owner asking.**
This session's instruction was to close the remaining gaps, production-touching steps included, so the round ran now rather than waiting for an incident.
Ledger: `PROD-READINESS-ROUND-4.md`. Scope grew twice over any prior round: `ios/` was read for the first time (PR-6's remedy lives there), and the fixes deploy to production at the end of the pass rather than waiting on a separate ask.

**Nine of the eleven carried findings are closed; the two that need production-scale evidence stay open with their triggers intact.**
Fixed: PR-5 (graceful SIGTERM/SIGINT drain, exit 0, capped inside Fly's 5 s `kill_timeout`), PR-10 (a production `db:migrate` with no `DATABASE_URL` now refuses naming the variable instead of dialling a localhost that is not there - and the pre-fix behaviour measured worse than the ledger said: drizzle-kit printed no cause at all), N-1 (all five direct-`Pool` dev scripts through `createDb`, plus a routing test so a sixth script cannot regress it), N-2 (the `JSON.parse` failure's cause is rebuilt at the throw site - name and byte offset kept, V8's quoted snippet of model output dropped - leaving `errorSummary`'s blast radius untouched, which was round 3's whole objection), N-5 (pre-routing refusals log `route:"refused:edge-secret"` / `"refused:body-limit"`; `"unmatched"` now means a 404 and nothing else), N-4 all three (the deprecated `routePath` getter replaced by the `hono/route` helper; object absence expressed as the `ObjectStorage` contract - a single exported `ObjectNotFoundError` the adapter translates once, deleting the byte-identical predicate twins; the round-1 hand-wrapped artifact block annotated as a rendering), and N-3 (the delete-first-then-recapture ordering documented in Runbook §6 and spec §5).

**Decided: PR-6 is closed by verification, not by change - and the server keeps its 409.**
The open half was always "check `OutboxController`'s classification of 409 before PR-5/PR-6 are called closed," and no round was allowed to read `ios/`.
Read now: the outbox catches `duplicate_image` on the create step and only there, counts the receipt server-confirmed, and removes the item - RULING 4's "reconcile, don't re-send," implemented since wave 5 and pinned by `testRelaunchAfterKillBetweenCreateAndCleanupLandsOn409AndCountsSaved`.
Rejected: RULING 4's alternative of answering the existing receipt instead of 409 - it would change a documented response code to solve a problem the client demonstrably does not have.
⚠ Carried forward to wave 7: the web client's multi-file upload must not inherit 409-as-saved - there a duplicate is a user-facing fact, not a lost 201.

**Decided: PR-13's "the fix is a forbidden major downgrade" was true of npm's offered fix and not of the finding.**
`tsx` and `drizzle-kit` are things the deployed machine genuinely runs, so they are `dependencies`, and the image installs `--omit=dev`: vitest, vite, adm-zip and the type packages leave the production image with nothing downgraded.
Verified against the built artifact: the new image carries `tsx` and `drizzle-kit`, no `vitest`/`vite`, and boots to a 401-with-`no-store` `/api/me` the wave-6 §1.2 way.

**Decided: the dependency advisories with non-breaking fixes are taken; the rest is accepted with its reachability stated.**
`npm audit fix` clears the `nanoid` high (vitest chain).
`uuid` is overridden to ^11.1.1 under exceljs - exceljs calls only `uuid.v4`, the advisory is v3/v5/v6 with a caller-supplied buffer, and the export suite is green on the override.
The four remaining moderates are the esbuild dev-server chain under drizzle-kit: nothing in any environment starts that server, npm's only fix is a drizzle-kit major downgrade, and after PR-13 the chain no longer ships in the production image.

**Still deferred, trigger re-verified rather than re-argued: R2-3 and PR-9(b).**
Both wait on a realistic fiscal-year export to measure, and production holds zero receipts (read this round).
The 2026-08-15 triggers stand verbatim.

**Spec §10B amended in this commit** (post-deploy status, request-log labels); the per-finding evidence, mutation tables, residuals recorded by this round's own work (among them: zod's `unrecognized_keys` echoes a model-invented key name; `verifyRestore` conflates absence with unreachability the way the export path no longer does), and the gate are in the ledger.

## 2026-08-20 - Step 17 executed to the token boundary: the scheduled backup is installed, rehearsed, and drilled against production

**Decided: the scheduled backup runs from the owner's Mac against the direct (non-`-pooler`) Neon endpoint.**
The app keeps the pooled endpoint; `pg_dump` gets the direct one, because PgBouncer's transaction pooling does not provide the session semantics `pg_dump` needs.
The production `DATABASE_URL` was read from the Fly machine's environment and piped into `~/.kept/backup.env` without ever being printed - the pooled hostname's `-pooler` segment stripped in the shell.
Rejected: putting the pooled URL in `backup.env` for consistency with the Runbook's table (it describes the app's variable, not the backup's needs).

**Decided: the launchd agent is loaded now, before its R2 token exists, so its nightly failure is loud rather than its absence silent.**
Until the token is pasted, every 02:00 run writes the refusal - naming exactly the two empty variables - to `~/Library/Logs/kept-backup.log`.
A live `launchctl start` verified the whole chain (plist → zsh → env file → PATH → npm → tsx → refusal); the alternative, leaving the agent unloaded until the token exists, makes forgetting the token indistinguishable from never having installed anything.

**Decided: the R2 token scoped to `kept-backups` stays the owner's, measured rather than assumed.**
Creating it from this machine was attempted and is not possible: the connected Cloudflare MCP credential is refused on the token APIs (error 9109), wrangler's OAuth scopes do not cover token management, and R2 temporary credentials require a parent token scoped to the target bucket, which is the thing that does not exist.
It is one dashboard task (R2 → Manage R2 API Tokens → Object Read & Write → bucket `kept-backups`), then two paste operations, `launchctl start`, and the §4 drill against the scheduled dump's file.

**Executed, and what the execution taught.**
PG16 client tools installed (`pg_dump`/`pg_restore` 16.15, matching the database).
The full `db:backup` path - dump, upload, re-read size check, sha256 - ran end to end against the dev database and a local MinIO `kept-backups` bucket, and the uploaded bytes were re-downloaded and re-hashed to the same digest.
The §4 restore drill ran against a manual production dump: all four row counts verified (`users 1, receipts 0, receipt_images 0, export_jobs 0`), and the verifier then refused overall success because production holds zero images - the vacuity guard doing its job, not a failure; the drill's image leg re-runs after the first receipt with an image lands in production.
Three operational facts were learned by real failure and are recorded in Runbook §4: `backup.env` values must be quoted (the Neon URL carries `&` and the file is sourced by zsh), the file must carry `PATH` (launchd inherits almost none; keg-only Homebrew `postgresql@16` and nvm-managed `npm` are on none of it), and a cross-role restore needs `pg_restore --no-owner --no-privileges` (a Neon dump carries `neondb_owner`/`neon_superuser`, which a scratch database lacks - the wave-6 drill restored same-role and never saw the 12 ownership errors this one measured).

**Spec §10B amended in this commit** (the scheduled-dump status line); `docs/Runbook.md` §1 and §4, `docs/gates/wave-6.md` §3, and the plist template's header carry the same state.

## 2026-08-18 - Distribution day: the App Store record is "Kept Receipts", and wave-6 steps 14-16 are done

**Decided: the App Store record is named "Kept Receipts", because "Kept" is already taken as an App Store name.**
App id 6802835941, SKU `com.arthurzhang.kept`, primary language English (Canada).
The home-screen name is unchanged - `CFBundleDisplayName` stays "Kept" - and the bundle identifier was never in question.
Rejected: filing a name claim (no trademark exists to claim on) and renaming the product (the name belongs to the product, not the store listing; almost nobody sees an unlisted listing).

**Decided: the app icon is a generated placeholder, shipped rather than blocked on.**
Apple's upload validator rejected the first archive: the asset catalog's `AppIcon` slot was empty and `CFBundleIconName` unset - a gap no gate had caught, because nothing before distribution ever needed an icon.
A 1024px icon (white zigzag-edged receipt, green check, deep green ground) was generated in code and wired in, and `CFBundleIconName` joined both plists; the plist-parity tests hold.
Replaceable whenever real branding is wanted.

**Decided: `ITSAppUsesNonExemptEncryption` is declared `false` in both plists.**
The app implements no encryption of its own - TLS belongs to the OS - so every future build skips the export-compliance question.
Build 1's question was answered in the portal instead ("none of the algorithms"), since it was uploaded before the key existed.

**Done, recorded rather than decided:** the privacy label was filed and published matching `PrivacyInfo.xcprivacy` word for word (six types, all linked to identity, none used for tracking, purpose App Functionality); build 1.0 (1) was uploaded via `xcodebuild -exportArchive` with automatic signing; a TestFlight internal group with automatic distribution delivers it; and step 16's end-to-end proof ran on 2026-08-18 - the TestFlight build on the owner's phone signed into production through Cloudflare → Fly → Neon, and the production database read back `users 1, receipts 0`.
Before the install, the owner ruled the dev data disposable: the dev database and MinIO bucket were wiped to zero, the dev app uninstalled from the phone, and its one unsynced receipt deliberately discarded - both environments now start from zero, which makes "production starts empty, nothing migrates" true in the strongest sense.

**Still open:** step 17 (the scheduled `pg_dump` to `kept-backups`, restore-verified) and step 18 (the unlisted submission), with 18 additionally gated on the Account Holder accepting the updated Apple Developer Program License Agreement and on a privacy policy URL that does not yet exist.

## 2026-08-16 - First deploy day: the four decisions made at the console, reconstructed 2026-08-21

*Reconstructed from `docs/Runbook.md` §1's dated markers and `docs/gates/wave-6.md` §3's dated corrections, five days late: on deploy day the current-state docs were amended and this log was not - the doc-ownership rule's failure mode running in the opposite direction from the Aug 7-8 case it was written for. Filed under the date the decisions were made, per the ordering rule above.*

**Decided: the Fly app is `keptapp-api`, because `kept-api` was taken by an unrelated app on that platform.**
`fly.toml` updated; the client is unaffected because it reaches `https://api.keptapp.net`, never the Fly hostname - the platform-internal name is invisible to everything but the operator.
Rejected: contesting or waiting on the name. Same shape as the App Store's "Kept Receipts" ruling two days later: a registrar's namespace is not worth blocking a ship date over when the product's own name is untouched.

**Decided: `ANTHROPIC_API_KEY` joins the first `fly secrets set` - LLM parsing is on from the first deploy.**
The wave-6 step 8 command had omitted it.
Rejected: enabling the sweep later as a separate step. Production refusing to start without the key (Runbook §0) was already the recorded posture - "unset in production the server refuses, because the alternative is silent feature loss" - and a first deploy that carved out an exception to it would have made dev and production diverge on day one.

**Decided: Neon stays on the Free plan, and retention rests entirely on the scheduled dump.**
The 6-hour PITR history window is an oops-window, no part of the six-year retention story (wave-6 §1.4) - a fact that holds on every plan, so paying for a longer window buys convenience, not retention.
The project was created on Postgres 16 to match dev's `postgres:16`, keeping the §4 restore drill valid across environments.
Rejected: a paid plan as a substitute for the dump; wave-6 §3 step 6 said "do the dump either way", and the dump is step 17.

**Decided: backups land in a second R2 bucket, `kept-backups`, in the same Cloudflare account as the images, under no lifecycle rule.**
Accepted caveat, stated at the time: a Cloudflare account compromise reaches both the receipt images and the dumps.
Rejected: a destination at a separate provider - stricter against that one failure, at the price of a second account, a second credential, and a second set of billing and lifecycle behaviour to operate; at three users the operational surface costs more than the marginal isolation buys.

**Done, recorded rather than decided:** wave-6 §3 steps 1-13 executed in order - accounts, zone, R2 bucket and token, Neon, `fly launch`/secrets/deploy/migrate, proxied DNS with the one rate-limiting rule and the edge-secret Transform Rule, and the confirmations: `https://api.keptapp.net/api/me` → 401 with `no-store` through Cloudflare, and `storage:probe-keys` against real R2 serving the control read while refusing all eight traversal spellings (probe objects deleted the same day). The R2 answer closed the one question wave 6 recorded as measured-on-MinIO-only.

## 2026-08-15 - Production-readiness round 4 is deferred: the remaining backlog waits for production evidence

**Decided: there is no fourth desk-review round before the first deploy.**
The deploy-prep triage (`DEPLOY-PREP.md` §1) re-read all thirteen carried items against the round ledgers and asked one question of each: does it get worse, or become unfixable, once real user data is in production, or does it block the first deploy itself.
The answer left one deploy-blocker (PR-8, fixed this pass), one reserved decision (R2-2, decided this pass), and eleven items that lose nothing by waiting.
Those eleven carry exactly as documented, deferred to a post-deploy pass informed by what production actually measures.

**Why deploying is now the higher-yield move.**
Two independent sweeps have re-verified this backlog and found no further P1s in it: round 2 re-checked round 1's fifteen carried candidates line by line and all survived as P2 or P3, and round 3 re-checked eighteen and moved no severity.
Round 3 already had to draw its work list from the P2s to have work to do.
The deploy-prep triage classified every remaining item as one that does not worsen with real user data, and several cannot be fixed honestly without production: PR-9(b)'s timeout must be set above a measured worst case, and the measurement - `generateExport` against the deployed Neon at a realistic row count - cannot exist before the deploy; R2-3 is unfixable from inside the repository (machine size or export architecture), and zero receipts exist at first deploy, so there is no real export size to weigh either change against; PR-6's remedy needs `ios/` (RULING 4), which no server-side round may touch.

**What reopens this - triggers, not vibes.**

- PR-9(b) reopens once production holds a realistic fiscal-year export to measure `generateExport`'s row query and image loop against; the timeout is then set above the measured worst case, never at a round number.
- R2-3 reopens when production exports are large enough to measure: the first real fiscal-year export's size and peak memory decide between a machine-size change and an export-architecture change, the only two fixes round 3 names - and it reopens before any raise of the 256 MiB export budget, which is what bounds a single export under the ~1120 MiB heap ceiling today.
- PR-6 reopens with the first pass allowed to read `ios/`, where its remedy lives.
- Any production incident traceable to a carried finding reopens that finding immediately, at the incident's severity rather than the filed one.
- A new P1, found by any future sweep or surfaced by production, reopens a full round, not just the one finding.

**Rejected: a fourth pre-deploy desk round over the same backlog.**
The recurring lesson of rounds 2 and 3 is that each round's real finds came from a new lens, not from re-grinding the carried list: round 2's one P1 came from asking whether anything was *there* rather than whether configuration was well-shaped, and round 3's two new finds came from asking what the repository asserts in prose and nowhere else.
Re-verifying the carried list, by contrast, produced agreement and nothing else - round 3 recorded its own 18-for-18 re-verification as "a weaker result than it sounds" because agreement between two sweeps a day apart is cheap.
A fourth pass over the same list buys more of that agreement at the cost of delaying the deploy that produces the evidence the deferred items are waiting on.

**What carries, so this entry is self-contained** - eleven items, one-liners from `DEPLOY-PREP.md` §1:

- PR-5 - no SIGTERM drain: in-flight requests severed on every deploy.
- PR-6 - a severed-but-committed create retried gets 409.
- PR-10 - `drizzle.config.ts` falls back to localhost.
- PR-13 - production image ships dev dependencies.
- N-1 - five dev scripts build their own `Pool` without PR-1's error listener.
- N-2 - `errorSummary`'s `JSON.parse` branch leaks ~10 chars of model output to the log.
- N-3 - duplicate-image index makes re-capturing the same paper order-dependent.
- N-4 - three hygiene items (deprecated `routePath`, duplicated `isMissingObject`, a re-wrapped artifact quote).
- N-5 - pre-routing refusals log `route: "unmatched"`.
- R2-3 - V8 heap ceiling (~1120 MiB) vs the 891 MiB export measurement.
- PR-9(b) - no statement timeout; post-deploy by construction.

With them travel round 3's three not-yet-findings observations (`PROD-READINESS-ROUND-3.md` §8) and the `nanoid` dev-chain advisory that deploy-prep's gate surfaced and flagged rather than fixed (`DEPLOY-PREP.md` §5), so the post-deploy pass starts from them rather than rediscovering them.

## 2026-08-15 - The export CSV is not mutated to defend a spreadsheet

**Decided: R2-2's remedy is no remedy - a free-text field beginning `=`, `+`, `-` or `@` is exported byte-for-byte, in both files, and the decision is pinned by tests rather than left as an omission.**
This closes the ruling rounds 2 and 3 both surfaced (RULING 5): whether the export should mutate values to stop a spreadsheet reading them as formulas.

**The trade, stated in full.**
The CSV is an accountant-facing tax artifact whose spec-stated purpose is import into accounting software, and import parsers do not evaluate formulas.
Every available defence mutates the data: the standard `'` prefix would arrive in the books as part of the vendor's name, silently, permanently, and in the artifact whose whole job is to be the same data.
The artifact a human opens is the XLSX (spec §8, "XLSX is primary"), and ExcelJS stores a formula-shaped string as a string cell, never a formula - measured in round 2 and now pinned by a test that fails if an ExcelJS upgrade changes it.
So the choice was between a wrong cell for a human who opens the CSV against its stated purpose, and a wrong string for the software the file is actually for - and a corrupted tax record is the project's top-of-scale harm, while a `#NAME?` cell is recoverable by opening the XLSX sitting beside it in the same zip.

**Why the injection vector is thinner here than the CWE-1236 default.**
Constraint 2 means no OCR value saves without a human confirming it, so a hostile vendor name crafted onto a receipt must survive the confirm screen's editable form before it can reach an export - the exported strings are not attacker-controlled pass-through, they are human-reviewed fields.
And per-user isolation means the only data in a person's export is their own.

**Rejected: defending the CSV only.**
It is the only artifact at risk, but the prefix lands exactly in the import path, which is the one consumer the mutation harms.

**Rejected: a second, defended CSV beside the faithful one.**
Two files claiming to be the same data is how the wrong one gets imported.

**Pinned by tests** (`tests/unit/writeFiles.test.ts`): the CSV preserves leading `=`, `+`, `-` and `@` unchanged, and the XLSX stores the same value as a string cell - each verified by mutating the writer and watching the test die.

## 2026-08-15 - The health check is liveness only, and it deliberately does not ask about the database

**Decided: `GET /health` exists, it answers a constant `200 {"status":"ok"}` from the process itself, it touches neither backing service, and `fly.toml` points an HTTP check at it every 30 seconds.**
This settles PR-8, which round 3 struck on scope (RULING 8): a health check worth having needed a new endpoint, and the deploy-prep pass is the first one allowed to add it.
The endpoint is registered ahead of the edge-secret middleware, because Fly's checker probes the machine directly and cannot carry the Cloudflare header - `fly.toml` is committed, so putting `EDGE_SHARED_SECRET` in a check header would commit a secret.

**Rejected: a check that re-asks R2-1's question at runtime** - pinging the database or storage on every probe.
Three reasons, weighed in the open rather than left as an accident.
First, Neon autosuspends after minutes of idleness and a probe every 30 seconds would keep the compute awake permanently, converting a health check into a standing bill - the same reasoning that set the LLM sweep's interval at six hours; probing rarely instead just wakes the compute on every probe and buys constant churn for no suspend savings.
Second, a restart is the only remedy a failed check can trigger, and a restart cannot fix a dead backing service: the machine comes back up into the boot probes, which refuse to bind the port until both services answer, so the crash-loop those probes produce is already the visible signal for that failure - a runtime re-ask would add cost without adding a remedy.
Third, an unauthenticated route must not tell an outside observer which backing service is up; a liveness answer is a constant, so there is structurally nothing to disclose and no failure shape to differentiate.

**Rejected: pointing a check at an existing route.**
`GET /api/me` answers 401 unauthenticated, which Fly reads as failure, and nothing else answers 2xx without a session - this is why PR-8 sat unresolved for three rounds.

**What the check therefore detects and what it forgoes, stated.**
It detects a dead or wedged process, an unbound port, and an event loop that cannot produce a response - the failures a restart actually fixes.
It forgoes detecting a backing service that dies after a successful boot; that gap is covered by the request log's 500s and the client's honest-failure UI, and re-asking it at boot is what R2-1 already does.
The check's `grace_period` of 60 seconds covers the boot probes' worst case (five 5-second database attempts a second apart, then a 10-second storage cap).

**The wiring is pinned by tests**: the route answers without the edge secret, consults neither backing service (an app whose `db` and `storage` throw on any use still answers), and `fly.toml`'s check block names the same path - each verified by mutating the code and watching the test die.

## 2026-08-11 - Production-readiness round 3: the backlog nobody was allowed to fix, and five sentences that outlived the code they described

**A third staged, adversarially reviewed hardening pass over `server/` only**, on branch `prod-readiness/round-3`, cut from round 2's branch rather than from `main`.
Same constraints: no features, no new endpoint, table, column or config key, nothing deployed, no remote, no Anthropic API call, `ios/` untouched.
Ledger at `PROD-READINESS-ROUND-3.md`, review trail at `reviews/round3/`; rounds 1 and 2 are left intact.
**This entry is again the exception to the per-commit doc-ownership rule**, honoured once here with its spec amendment in the same commit.

**The rule that changed, and why.** Rounds 1 and 2 each froze a P0/P1-only work list and documented every P2, on the reasoning that a hardening pass should not spend itself on small things.
Two independent sweeps have now re-verified the same backlog and found no further P1s in it, so this round drew its list from the P2s instead, capped at eight, on the thesis that what is left is an accumulation of small things nobody was allowed to fix rather than one large thing nobody has found.
**Eighteen candidates carried in and eighteen survived re-verification, none struck as fabricated and no severity moved.**
That is a weaker result than it sounds and was recorded as such: agreement between two sweeps a day apart is cheap.

**Eight findings frozen, eight resolved, one commit each, every fix shipped with a test that dies when the behaviour is removed.**
Ordered smallest blast radius first: the storage refusal named the wrong permission (**R3-1**); the request log answered the wrong question (**R3-2**); the image soft-delete would overwrite an older tombstone (**PR-11**); export download URLs were the third dereference site and the only one not re-validated (**PR-4**); a genuine token with a non-uuid subject answered 500 instead of 401 (**PR-12**); the pool armed no connect timer, so a checkout against a black-holed host waited forever (**PR-9a**); the production image ran as root (**PR-7**, `DEPLOY-CONFIG`); and nothing required TLS on `DATABASE_URL` though the same function required it of `STORAGE_ENDPOINT` eight lines earlier (**R2-4**).

**Two of the eight were found by this round rather than inherited, and both are the same shape: a sentence in this repository describing behaviour the code does not have.**
Round 1's blind spot was existence and round 2's was that its own new code had no test; fired as a lens, the question "what does this codebase assert in prose and nowhere else" found a refusal message telling an operator to check a permission the previous round's fix existed to avoid needing, citing a ledger file the Dockerfile does not copy into the image, and a request-log field documented in three places as "whether a session was presented" that in fact reported whether authentication succeeded, so a client sending no token and a client whose every token was rejected logged identical lines.

**Then the same lens, turned on this round, found five more instances in its own output.**
This is the part worth carrying.
A docstring was falsified by the commit editing the file eight lines above it and left standing; R2-4's cited measurement (`pool.options.ssl === undefined`) **did not discriminate**, because `Pool` never parses the connection string and reports `undefined` for correct URLs too; the refusal of `sslmode=prefer` and `allow` was justified as current `pg` behaviour when it is true only of a future major version; this ledger claimed in the present tense that this entry already existed; and the export refusal was described as logging through `errorSummary`, which it does not.
All five were prose, none was a runtime defect, and all five are corrected.
**The method a round uses to audit other people's work is not automatically applied to its own.**

**Rejected: copying `assertIssuedObjectKey`'s throw into the export path.**
The obvious fix for PR-4 was the one its sibling already uses, and it would have relocated the blast radius rather than bounded it: `GET /api/export` maps the dereference over up to fifty rows inside a `Promise.all`, so one hand-edited row would have failed the entire history list and made every other export unreachable through the only route that lists them.
Measured rather than argued - replacing the refusal with a throw returns **500 for the whole list**.
The export path refuses per job, logs the refusal naming the job and withholding the key, and returns a null download URL for that job alone.
The isolation guarantee is identical; what differs is what one corrupt row costs.

**Rejected: adding a health check to `fly.toml` (PR-8), on scope rather than on severity.**
A check worth adding must re-ask R2-1's question, and no route can answer it: `GET /api/me` returns 401, which Fly reads as failure, and nothing answers 2xx unauthenticated.
The honest remedy is a new endpoint, which is the feature line this run may not cross, and it is also an unauthenticated route reporting whether the database is up.
Surfaced as a ruling instead.

**Deferred inside a frozen finding: PR-9's statement timeout.**
The connect timeout was set; the statement timeout was not, and the reason is receipt data.
One number applies to every query in the process, `generateExport` reads a whole fiscal year and streams every image through one connection, and nothing here has measured that against a realistic row count.
A value guessed low truncates an export rather than failing a request, so the honest move was to leave it open with the measurement named.

**One defect of this round's own making was caught inside the pass that caused it**: R3-2's first test passed its rejected-token leg and failed its no-token leg against unmutated code, because the log-capture helper reset per test while the reader returned the first line it could parse, so the second capture re-read the first capture's output.
**No assertion that could not fail was shipped**; the project's running count stays at eight.
The final reviewer re-ran every mutation independently and confirmed all ten new tests die when their behaviour is removed.

**Gates: 299 tests green across 31 files (289 at baseline), `tsc --noEmit` clean, `npm audit` 6 moderate, `drizzle-kit check` clean, and the real entrypoint answering `GET /api/me` with 401 and `Cache-Control: no-store`.**

**Everything else is documented and unfixed, by the run's own rule.** Twelve P2/P3 findings carry to round 4: PR-5, PR-6, PR-8, PR-10, PR-13, N-1, N-2, N-3, N-4, N-5, R2-2, R2-3, plus PR-9's deferred statement-timeout half.

**Still the owner's, and none implemented here:** R-1's existence check at capture time, the orphaned-object policy, the scheduled `pg_dump` destination and the Neon plan, what a replayed create should be told, whether the export CSV should be mutated to defend a spreadsheet, whether any of the three branches merges to `main` (none is; `main` is still at `ca82907`), confirming at first deploy that the R2 token can read from its bucket, and one new item - **what a health check should ask, given that no route can answer it.**

## 2026-08-11 - Production-readiness round 2: the checks all asked whether configuration was well-formed, and none asked whether anything was there

**A second staged, adversarially reviewed hardening pass over `server/` only**, on branch `prod-readiness/round-2`, cut from round 1's branch rather than from `main`.
Same constraints: no features, no new endpoints, tables, columns or config keys, nothing deployed, no remote, no Anthropic API call, `ios/` untouched.
Ledger at `PROD-READINESS-ROUND-2.md`, review trail at `reviews/round2/`; round 1's files are left intact.
**This entry is again the exception to the per-commit doc-ownership rule**, honoured once here with its spec amendment in the same commit.

**Round 1's backlog was re-verified rather than inherited, and the frozen list came out at exactly one P1.**
Fifteen carried candidates were re-checked line by line; all survived as P2 or P3, none was struck as fabricated, and two new P2s were found (a CSV whose fields a spreadsheet reads as formulas, and a 2 GB machine sized in RSS against a V8 heap ceiling measured at 1120 MiB).
Two severity moves are worth recording because both went *against* having work to do: **PR-5 was proposed for elevation to P1 and the elevation was withdrawn** when following the argument through showed the receipt is already committed when the retry is refused, and **N-2's leak was measured smaller than round 1 feared** - zod 4 reports types and key names, never values, so the exposure is the ten characters of `JSON.parse`'s `SyntaxError` and nothing more.

**The one P1: the entrypoint validated that configuration was present and production-shaped, and never that either backing service answered.**
`pg` connects lazily and object storage was probed only on the local-development branch, so a wrong `DATABASE_URL` password produced a process that printed `Kept API listening`, held the port, and answered 500 to every authenticated request - while **passing the deploy check the project documents in three places**, because `GET /api/me` returns 401 before opening a connection.
Round 1's own weakness was named as auditing the create path for ownership and idempotency and never for existence; run as a lens over the rest of the system, the same shape appeared here.
Fixed by probing both services before `serve()` and refusing to bind the port otherwise.

**Rejected: probing once.** The deployment target autosuspends, so a cold Neon compute is the expected first connection rather than a fault; the database probe retries five times a second apart, each attempt with its own timeout because the pool's connect timeout is unset and means "wait forever".

**Rejected: `HeadBucket` for the storage probe** - and this is the correction worth carrying. A boot-blocking check makes whatever call it issues into a deploy requirement, and nothing in this project has ever issued `HeadBucket` against R2, whose token is provisioned as "read and write" on one bucket. A token that could serve every request in the app but not answer that call would have refused to boot: a P0 traded for a P1. The probe now **reads a key that cannot exist and treats `NoSuchKey` as the answer** - the same permission `download` already needs on the export path.

**Two P1 regressions were introduced by this round's own fix and repaired inside it**, which is the part of the run worth remembering.
The storage probe shipped **with no timeout**, so a host that accepts a TCP connection and never answers left the boot pending indefinitely with zero bytes of output, no port bound and no exit - strictly worse than the defect it closed. And the refusal line rendered the parsed database *name*, which for a `DATABASE_URL` that lost its `postgres://` prefix is where the userinfo lands - so **the line whose own comment said it withheld the URL "because DATABASE_URL carries the password" printed the password.**
Both were found by reviewers, not by the builder.

**Two assertions that could not fail were found and closed, plus one behaviour shipped with no test at all - all three this round's own.**
The project's running count of assertions that could not fail is now eight.
A gutted storage probe left the suite at 287/287; forcing the retry defaults to one attempt with no delay left it at 287/287; and the entrypoint tests inherited a shell with no `STORAGE_*`, so every spawned child took the local-MinIO branch and the entire configured-storage block could be deleted with the suite green.
**All three were found by mutation, none by reading.** The standing lesson: a test that passes an override for the value under test does not pin the default that production uses.

**Deferred, unchanged and still the owner's:** the orphaned-object policy, the scheduled `pg_dump` destination and the Neon plan, R-1's existence check at capture time, what a replayed create should be told, whether the CSV should be mutated to defend a spreadsheet, whether either branch merges to `main`, and one new item - confirming at first deploy that the R2 token can read from its bucket, since the server now refuses to boot without it.

**Everything else is documented and unfixed, by the run's own rule.** Eighteen P2/P3 findings carry to round 3.

## 2026-08-10 - Production-readiness sweep of the server: four findings, and the one that would have taken the API down

**A staged, adversarially reviewed hardening pass over `server/` only.**
No features, no new endpoints, tables, columns or config keys, nothing deployed, no remote, and no Anthropic API call.
`ios/` was out of scope by construction: the reviewer's contract requires re-running verification independently, and §10.2 records that SwiftUI view-layer behaviour is executed by no test - a reviewer cannot discharge that contract against it.
Full ledger and review trail at `PROD-READINESS.md` and `reviews/` in the repo root, deliberately outside `docs/` because they record one run rather than a living document.
**This entry is the exception to the per-commit doc-ownership rule**, taken knowingly: twenty hardening commits would have produced twenty log entries and buried the log, so the rule is honoured once, here, with its spec amendment in the same commit.

**The work list was frozen after an adversarial review of the ledger itself, at four P1s and no P0.**
Thirteen findings were catalogued; the reviewer upheld all thirteen, struck none, and added one the ledger had missed.
Ten P2s are documented and deliberately unfixed.
**Freezing the list before writing code is the load-bearing part**, and it held: every later finding - including several the reviewers were right about - went to NEXT ROUND rather than being swept into the run.

**1. A terminated idle Postgres connection killed the whole API.**
`createDb` built a `Pool` with no `error` listener, so `pg` re-emitting an idle client's error was an unhandled `'error'` event - an uncaught exception.
Measured against the real entrypoint: one `pg_terminate_backend` on one idle connection, and the process exited with `code: '57P01'` and the port went dead.
**The trigger is routine, which is what makes it the worst of the four:** Neon's compute autosuspends when idle, which at three users is most of the time, and every failover and connection reap does the same thing.
Ranked **P1 rather than P0** because it is loud rather than silent and loses no receipt - the outbox holds an unsent capture - and because Fly restarts the machine, which is a fact this run **could not verify** and therefore filed as an assumption rather than asserting. If that assumption is wrong it is a P0.
Also removed as a side effect: the pre-fix crash dump printed the pg client's `connectionParameters`, **including the database password**.

**2. The LLM parse sweep printed receipts to the log, two lines below a comment promising it never would.**
`console.error(failure.error)` on a raw error. The `try` around the parse also spans the `UPDATE` that writes the record, and drizzle builds a statement's bound parameters **into the error's own message** - so a failed write printed the whole parsed record.
Reproduced: vendor, GST/HST number and three amounts, on stdout.
**This is the Aug 6 ruling's own class, reintroduced on Aug 8 in a module written after it**, with a green suite the entire time - because exactly one test in 263 looked at what was printed.
So the fix arrived with the assertion that was missing: a `logHygiene` suite that pins "server logs carry no receipt contents" against the sweep's real drain rather than a re-implementation of its reporting.
⚠ **Closed on the database branch only.** `errorSummary` redacts *database* errors specifically; a parse error's own message and cause chain pass through, and the parser's real failure carries a `SyntaxError` cause quoting the first characters of the model's output. Recorded as NEXT ROUND, not claimed as fixed.

**3. Nothing was logged at the request boundary at all.**
Three lines at boot and then silence - no rate, no latency, no status codes, nothing for a 400, 401, 403, 404, 409 or 413.
`fly logs` after "the app says it can't sync" showed the boot banner and nothing else.
Now one structured line per request, carrying **no path, no query string, no user id, no headers, no bodies** - the route *pattern*, the status, the duration, and whether a session was presented.
That set is not squeamishness: `?q=` is vendor names the person typed, and a user id is the first segment of every one of their object keys.

**4. A receipt whose image was never uploaded jammed every export of its period, with a message naming nothing.**
Found by the reviewer, not by the ledger, which had audited the create path twice - for ownership and for idempotency - and never for **existence**.
`isIssuedObjectKey` validates a key's shape; nothing checks the object is there, so an interrupted presigned PUT followed by a create the client still sent leaves a receipt pointing at nothing. The export then failed with `The specified key does not exist.` - no receipt, no vendor, no date, and no way to find the row.
**Only the diagnosability half was taken.** An existence check at create would convert a broken export into a **refused capture**, which is the wrong direction when the paper is usually already in the bin - a receipt row with no image still holds the vendor, the date, the total and the HST. That half is deferred as a ruling, not done quietly.

**The rejection is the most useful thing in this run, so it is recorded rather than smoothed over.**
The first version of fix 4 told the person to *"open that receipt and re-attach its photo"*.
**No endpoint in this server can do that** - `updateReceiptSchema` has no `image` key and `/upload-url` mints a fresh uuid on every call. A reviewer rejected it.
A message that names an impossible remedy is worse than the storage error it replaced, because it is confidently wrong.
Two further defects came out of the same rejection and its re-review, and the second is the one that would have hurt: the fix caught **every** download failure, so a storage timeout or a refused credential would have been reported as "this receipt's photo never uploaded" - telling someone to delete a receipt over a network blip. Only a genuine `NoSuchKey` is now described as one, and the test fake was corrected in the same change because it threw a nameless `Error` and would have let the conflation pass.
A third review then caught the corrected message **leading with the destructive step**: "delete that receipt" as the first instruction, in the one commit no single-stage reviewer had seen. It now leads with the remedy that keeps the receipt.

**What the reviews caught that the suite could not, which is the pattern worth keeping.**
Five reviews returned findings and one returned REJECT; none of them was a rubber stamp.
Among them: a test of mine that **passed with the behaviour deleted** - an in-process assertion that "the process survived", which vitest's own uncaught-exception handling makes unfalsifiable. It is now asserted across a process boundary, because an exit code read from outside is the only witness that cannot be intercepted. That is the sixth instance of this project's recurring anti-pattern, and the first one caught in the same session that wrote it.
Also caught: a changed line with no assertion pointed at it, a dead setup block under a comment claiming it mattered, an assertion written against a test fake's wording rather than the real client's, and two NUL bytes this run wrote into its own ledger.

**Not fixed, and stated so the absences are decisions.**
Ten P2s including no SIGTERM drain, the image container running as root, no health check in `fly.toml`, no pool timeouts, and export zip keys not re-validated on read - the third dereference site, where the Aug 6 ruling said "both".
NEXT ROUND carries five more found after the freeze.
Unchanged and still the largest gap between retention as written and as implemented: **the scheduled `pg_dump` has no destination** (wave-6 §3 step 17), and Neon Free's history window is six hours.
Sixteen of wave-6 §3's eighteen steps remain the owner's; nothing in this run superseded any of them.

Suites: server **276** (was 263; 13 added, one rewritten), `tsc --noEmit` clean, `npm audit` unchanged at 6 moderate.
Every added test was run in its failing direction, and the two that pass either way say so in place.
Guardrail 7, with one stated deviation: the entrypoint was started the real way and answered a real `GET /api/me` with 401 and `Cache-Control: no-store`, but **with `ANTHROPIC_API_KEY` withheld**, because `index.ts` kicks the parse sweep at startup and this run was prohibited from calling that API. Every path that reaches Anthropic is therefore UNVERIFIED here.

## 2026-08-09 - The Done button is ours, because SwiftUI's never arrived

**`ToolbarItemGroup(placement: .keyboard)` installs nothing through the confirm screen's presentation.**
The Aug 8 entry below called the Done button built; it was not, and the device said so twice before the reason was found.
Established on a physical iPhone running iOS 26.x, entered the way a person enters it - Home → pending row → detail → "Confirm this receipt", which presents the form in a `fullScreenCover` (`ReceiptDetailView`).
Proven three ways over fifteen focus events across five fields: the responder had no `inputAccessoryView`, no `inputAccessoryViewController`, and there was no host view anywhere in the `UITextEffectsWindow` - whose container heights, 318 for the decimal pads and 345 for the alphabetic keyboards, were bare keyboard heights with nothing added.
`@FocusState` was not the problem and was ruled out separately: the amber cleared on every field touched, and the amber clears off the same `focusedField` the toolbar condition read.

**Whether a host is installed at all is not deterministic across sessions**, which is why this took three runs to see.
One device run found `RootUIView (0, 0, 430, 0)` - a host present and collapsed to zero height; two later runs on the same build found no host at all.
Recorded as a finding rather than resolved, because two contradictory observations of one binary is itself the finding.
The mechanism turned up later, on the simulator: **SwiftUI installs an empty zero-size `RootUIView` as `inputAccessoryView` whether or not any keyboard toolbar is declared**, and overwrites the property again on every body update.
So "the field already has an accessory view" is always true and says nothing, and whether that empty host is still attached when observed is a race.
From the thumb's point of view the two readings are the same defect: no Done button with hittable area, ever.

**The bar is now hung on the first responder in UIKit, and it is self-healing rather than install-once.**
The first responder was the one thing reliable in every observation - found every time, in the recognizer's window every time, always the right field - so that is what the bar attaches to.
It is re-asserted on begin-editing, on every text change, and on keyboard frame changes, because SwiftUI puts its empty host back on each body update; the bar is only re-presented when it is showing for a different field or is off screen, so a keystroke does not flicker the keyboard.
Rejected: making the toolbar group's content unconditional. That is the same idea a third time - it corrects the *inputs* to a group whose output is never installed, which is exactly what 54286b6 did and why it did not work.
This keeps the file's existing premise, stated there since the tap recognizer landed: this screen's keyboard reality is expressed in UIKit because SwiftUI cannot express it here.

**`EditableField.needsDoneButton` is deleted; the question is read off the keyboard the field raises.**
A numeric pad has no return key and a text view's return key inserts a newline - both are properties of the keyboard, not facts to restate per field.
This is the part that matters: **the enum had to be hand-synced with the view, and it drifted.**
`54286b6` exists because other tax shipped a decimal pad nothing could close - it had no focus value, so the toolbar had nothing to key off. A list maintained by hand is a list that will be wrong again the next time a field is added.
`usesDecimalPad` stays, because the view still has to choose a keyboard.

**Verification, because this class of bug is invisible to the suite.**
A `KeptUITests` target now exists - the first in the project - asserting `isHittable` on the Done button for all five keyboards with no exit, that pressing it dismisses, that the bar survives typing, and that the single-line fields still get no bar.
`isHittable` is the assertion that matters: it is false both for an absent bar and for a 430×0 one, and true only when a person could press it.
A DEBUG-only acceptance check logs PASS/FAIL per focus on device, and **`-KeptZeroHeightDoneBar` is a negative control that installs the bar collapsed** - the exact shape that read as success - so the check is seen to fail rather than assumed to work. On the simulator it does: 15 PASS with a 402×44 bar, 2 FAIL under the control.
It writes to three sinks - the unified log, stdout, and a file in the app's Documents directory. **The file sink exists because backgrounding kills the `devicectl` console every time, once by SIGKILL**, so the one state whose evidence was most likely to be lost was the background round trip; each line carries a pid, because if iOS kills a backgrounded app then reopening it is a cold launch wearing a resume's clothes and the round trip was never exercised at all.

**The device pass, on the detail entry (`ReceiptDetailView`'s `fullScreenCover`), physical iPhone / iOS 26.x.**
All five keyboards with no exit pass with a 430×44 bar, Done hit-testable: total, HST, subtotal, other tax, notes.
Both entry states pass - `entry=cold` and `entry=warm` (a field-to-field move with the keyboard already up).
The background round trip passes and is a **genuine resume**, same pid across a 37-second gap, not a disguised cold launch.
Vendor and tax number correctly get no bar, and pressing Done dismisses.
**Two instrument defects were found and fixed during the pass, neither in the bar**: looking the Done control up by `accessibilityIdentifier` reported "no control" for a bar that was demonstrably on screen, because `UIBarButtonItem` reaches the view layer through accessibility, which is live under XCUITest and not in a plain device run - it now walks for a `UIControl`; and fields that correctly got *no* bar produced no log line at all, making the control against "a bar on everything" indistinguishable from a field nobody tapped - every focus now reports, and a bar on a self-dismissing field is an explicit FAIL.

⚠ **Two verifications are open, and the fix is not fully verified until they run.**
**(1) The negative control has never run on device** - only on the simulator. Until it does, the device PASS lines rest on a check that has not been seen to fail on that hardware, which is the same standing as an untested assertion.
**(2) The capture path has never been exercised from any angle.** `VNDocumentCameraViewController` → `ConfirmQueueView` presents the same form through a different presentation, and this whole defect was presentation-dependent.
So: **verified on the detail entry, unverified on the capture entry.**
⚠ **Green CI is not proof.** The UI tests run on a 26.3.1 simulator; the defect was on 26.5.2 hardware, and the same build behaved differently between sessions there. The device matrix - cold launch, warm keyboard, background round trip, cover reopened, and both the detail and capture entry paths - stays manual.
⚠ **One thing the check no longer asserts**, stated rather than quietly dropped: that `inputAccessoryView` still points at our bar at an arbitrary instant. It often does not, because SwiftUI overwrites it continuously. The invariant kept is that the bar on screen is ours and pressable, and that the property is restored before UIKit next queries it; a clobber is still logged as a note rather than hidden.

## 2026-08-08 - The confirm screen's keyboard has three ways out

**No field may raise a keyboard the person cannot put away without knowing a gesture.**
The defect (device pass): tapping HST - or any money field - raises a decimal pad, which has no return key and had no toolbar, so there was no visible exit; the pad also covers the Save button, and the everyday order of work leaves a money field focused last, so a person who had finished the receipt could not reach the one tap the screen exists for.
On a screen whose brief is a five-second task ending in one tap (§7.2, §10A.1), an undocumented gesture is the whole task failing.

**Three dismissals, deliberately overlapping.**
**(1) A keyboard toolbar with a Done button on every keyboard that has no exit of its own** - the four money fields (total, HST, subtotal, other tax), whose decimal pad has no return key, and notes, whose return key inserts a newline because it is a vertical-axis field.
The rule was first scoped to the numeric fields on the premise that text keyboards have a return key; that premise simply fails for notes, so the property is `needsDoneButton` - which keyboard can be closed from inside itself - and not `usesDecimalPad`, which is a question about the keyboard type and stays its own switch.
Still not offered over the single-line text fields: their return key does dismiss, and an accessory bar they do not need costs form height on the screen that can least afford it.
**(2) A tap anywhere that is not a text field.**
**(3) Any scroll of the form** (`.immediately`).
Rejected for (3): `.interactively`, which only pays out when the drag starts over the keyboard - another gesture to know about, which is the defect, not the fix.

**Save is reached by dismissing on scroll, not by insetting the form.**
Reaching Save is a scroll, and that scroll is what uncovers it; the focused field's own visibility is already handled by the scroll view's keyboard avoidance.
Rejected: adding a bottom inset so Save clears the keyboard - it keeps a keyboard-height hole on screen while typing, and still asks the person to reach past the pad to a button sitting above it.

**Tap-to-dismiss is a UIKit gesture recognizer, not a SwiftUI `TapGesture`.**
A `TapGesture` on the Form races the tapped field's own focus: moving from one money field to the next would sometimes dismiss instead of moving, and a tap inside the focused field to reposition the cursor would close the keyboard outright.
A recognizer can be asked per touch whether the touch landed on a text input and stand down when it did, which is the actual rule; it sets `cancelsTouchesInView = false`, so it changes nothing else on the screen, and it comes off the window with the view.
Kept to one small file so §10.2's untestable surface stays thin.

**"Other tax" gained a focus value and did not gain an amber tint.**
It carries no suggestion (§7.2) and never has, but as the one money field with no focus value it was a decimal pad the Done button could not have closed; focus and tint are now separate questions - `EditableField.usesDecimalPad` and `EditableField.suggestion` - rather than one enum doing both jobs.

**Checked, nothing to fix: the receipt detail screen.**
Its fields are read-only (`FieldRow` renders text), and its "Confirm this receipt" button presents the same `ConfirmReceiptView`, so it inherits all three dismissals.
The only other text input in the app is the DEBUG-only server-settings field, whose URL keyboard has a return key and which is compiled out of shipped builds.

⚠ Test honesty (§10.2): the four tests added pin the *wiring* - that the decimal-pad set is exactly the four money fields, that Done is offered to exactly those four plus notes, that each focusable field maps to the suggestion it clears and no other, and that every amber-carrying field except the date is still reachable by focus.
None of them execute the toolbar, the recognizer, or the scroll modifier: deleting `.scrollDismissesKeyboard`, the `.background`, or the toolbar group leaves the suite green.
Only a device pass confirms the keyboard actually goes away.

## 2026-08-08 - Pending receipts render the served merge on every screen

**On a pending receipt, the Home list row and the receipt detail screen render the §7.3 merge by the confirm screen's prefill rule: a served suggestion outranks the row's copy of the field, and the row fills only fields no suggestion covers.**
The defect (same-day device pass): one receipt read two different ways depending on the screen - the confirm form rendered the merge's "Food Basics" and corrected date while the list row and detail screen rendered the row's "Basics", the bare tax number, and a misparsed 2011 date - so the merge's corrections were invisible outside the confirm screen.
This applies the ruling the confirm screen already established (the entry below) rather than adding a new branch: a pending row's stored values are the capture-time heuristic snapshot, and the served merge supersedes them.
**A confirmed receipt renders its row everywhere; the merge never overrides a confirmed value.**
Confirmed receipts are still swept and still served suggestions - only `parse-accuracy` consumes those.
Rejected: rendering the merge on confirmed receipts too - the row holds what a human confirmed, and constraint 2 makes that the record.
The selection lives once, in a `Receipt` extension (`ReceiptDisplay.swift`) shared by both screens and pinned by unit test; fields the merge does not cover (other tax, business/personal, category, payment, notes) always render the row.
**Checked, both stay: the detail screen's "Not recorded" and the confirm form's "Not found".**
They are two components in two contexts - the detail screen states what Kept has for a field, while the form's placeholder sits exactly where typing the missing value is the remedy - but the stored-vs-parsed distinction is carried by the components' contexts, not stated by any rule in the code; recorded here so it is a decision rather than an accident.
⚠ Test honesty (§10.2): the extension's selection is pinned by unit test, but the views reading `display*` instead of the raw fields is SwiftUI body content no unit test executes - reverting a row to `receipt.vendor` would stay green.
The device pass is the real evidence, exactly as it was for the confirm screen's own rendering.

## 2026-08-08 - iOS confirm screen renders the served merge

**The confirm screen now renders the `suggestions` field the API serves - the §7.3 merge - and no longer reads the detail route's raw `ocrSuggestions`, which stays in the response for the shipped client.**
The suggestion set is the injected thing: one form serves all three routes (queue, detail, capture-time), each construction handing it the set that exists for it - the server merge for a stored receipt, the on-device parse alone for a capture-time confirm, where no server row and therefore no merge or disagreement flag can exist.
Rejected: a branch inside the view deciding which record to read - a form that knows its routes is how one screen becomes three.

**Where a served suggestion and the row's copy of a field both exist, the suggestion wins the prefill; a value only on the row prefills without amber.**
The row's field values on a pending receipt are the capture-time heuristic snapshot, and the served merge supersedes them (the LLM's "Food Basics" over the row's "Basics"); rendering the row copy would un-take the merge decision client-side.
A value only on the row was written by something other than a parser, so it is not a machine suggestion and carries no amber; rows with no suggestion set at all (neither parser ever saw them) keep the value-presence proxy.

**On a date disagreement the field keeps its amber and carries an inline note; the note gets the arithmetic warning's exact treatment.**
Same amber, inside the field, never red - a prompt to look, not a rule - and touching the field clears the tint and the note together, because touched means a human looked and decided.
Rejected: a separate dismissal or any persistence for the note - the marking's whole design is "touching clears it", and a second mechanism would make the screen noisier for a signal that only ever asks for one look.

**Provenance is not shown in the UI.**
The amber already means unverified; a source badge would ask the user to adjudicate parser internals and make a screen designed to start loud and go quiet noisier.
The client deliberately does not even decode the per-field `source` marker - provenance stays in the API for diagnostics.

**A money field the merge serves absent prefills empty, so the form's "Not found" placeholder states the absence** - checked against the served `{value: null, source: null}` shape by decode test, per §10A.1's stated-absence rule and §7.3's no-fallthrough amendment.

## 2026-08-08 - Merge correction (the owner): money fields have no fallthrough

**For the money fields - total, subtotal, HST - the heuristic is the only source the merge serves: if the heuristic has no value, the field is absent, never filled from `llm_suggestions`.**
Fallthrough is unchanged for vendor, tax number and date.
Rejected: the fallthrough semantic the wiring shipped (the entry below), under which a heuristic-absent amount was served from the LLM with `llm` provenance.
Why the original ruling did not cover this: "amounts from the heuristic" rested on both paths scoring 100% on money, which only covers cases where both produced a value and says nothing about the LLM on amounts the heuristic misses - exactly when fallthrough fires.
The first wild instance, on clean input, was a digit transposition: "SUBTOTAL 43.49" parsed as 3449 cents and served with `llm` provenance, because the heuristic found no subtotal to outrank it (the live-run evidence in the entry below).
§7.2's arithmetic check is only a partial net: it needs all three of subtotal, HST and total present, so a receipt missing two of them gets no check at all.
An absent amount is visible and costs one keystroke; a wrong amount that passes unflagged reaches an accountant.
**The LLM's money values still get stored in `llm_suggestions` - this changes what the merge serves, not what is recorded - and `parse-accuracy` keeps scoring them, since that comparison is how this ruling gets revisited on more data.**
Checked at the time of the change, data untouched: two receipts in the dev database carried an llm-sourced amount through the merge, both synthetic-user rows, one of them the soft-deleted 3449 receipt itself; no real-user receipt was affected.

## 2026-08-08 - LLM parse wired in: sweep + domain-layer merge

**The server-side parse runs as a sweep over rows, kicked at startup, after captures, and on a long interval - not inline in the create route.**
Rejected: parsing inside the create request - a restart would lose an in-flight parse, and a model outage or slow response would block or fail a capture, breaking the success test.
The row itself is the job state (`ocr_raw_text` present, `llm_suggestions` null), the same reasoning as export jobs being rows rather than process memory; the null-only guarded UPDATE makes concurrent sweeps idempotent, with the losing writer counting the row superseded.

**Confirmed receipts are swept too.**
A confirmed receipt cannot benefit from suggestions, but its parse grows the accuracy set - which is what the merge rule's n=5 caveat needs before it can be treated as settled.

**The merge is a pure function in the domain layer, served on every receipt response with per-field provenance and the date-disagreement flag; clients render, never decide.**
Rejected: merging in the client - §4.1's rule exists because a rule implemented in Swift is a rule written twice once the web client lands.
Two semantics settled beyond the ruled merge: when the ruled source found nothing for a field, the other side's value is served with its provenance stated (a rejectable suggestion beats an empty field, and constraint 2 makes that safe); on a date disagreement the heuristic's value is the prefill because it is the deterministic side - the flag, not the prefill choice, carries the signal.

**`ANTHROPIC_API_KEY` is required at production boot; a runtime model failure degrades to heuristic-only.**
A missing key in production is silent feature loss, so `productionEnv.ts` refuses to start; a missing key in dev disables the sweep with a stated line; a failing API call at runtime leaves the row null for a later sweep and never touches the capture path.

**The retry is capped: after 3 failed attempts the sweep writes an explicit failure record into `llm_suggestions` - model, promptVersion, requestedAt of the final attempt, the error, the attempt count, and `suggestions: null`.**
Rejected: unbounded retry - every attempt bills the API, and with kicks on every capture plus the interval, a receipt whose text persistently fails validation re-bills forever; fine at six receipts, a real leak once the backlog lands.
Rejected: capping in memory alone - the failure would live only in a log, invisible in the data, and the row would re-bill up to the cap again on every restart with nothing ever recording that the model cannot parse it.
The record is what stops the null-guard re-selecting the row, and it makes the failure a queryable fact; `parse-accuracy` scores it as "the LLM produced nothing" (missed / absent-right per field), deliberately distinct from a receipt the LLM was never run on, which carries no record and never enters the LLM table.
Attempts are counted per process; the backfill's single manual pass carries no counter and never abandons - it exits loudly instead.
Re-parsing an abandoned row means clearing the column by hand, a deliberate act.

**Evidence from the live verification run, recorded rather than footnoted: the model misread a printed subtotal of 43.49 as 3449 cents.**
The wiring run against the real dev server and the real API (create 201 in 63 ms, sweep record landed seconds later) included a receipt whose text printed "SUBTOTAL 43.49"; the parse returned 3449 - a plausible off-by-transposition, served with `llm` provenance because the heuristic had no subtotal to outrank it.
That is the probe's "fails plausibly where the heuristic fails visibly" caveat occurring in the wild, unprompted, on clean input - not under a deliberately degraded probe.
It is why every LLM-sourced value stays amber until touched with no trust shortcut, and it goes in this log as evidence for the next reading of the accuracy table.

**`parse-llm-backfill` stays, as a thin wrapper over the sweep core, guard intact.**
Rejected: deleting it - running one loud, exit-coded parse pass from a laptop without starting a server is still useful (a claimed or seeded local database).
Rejected: dropping its `assertLocalDatabase` guard - production's parsing is now the server's own job, so the script has even less reason to aim at production, not more.
Its old "refuse loudly when the column is already set" behaviour is retired: with two legitimate writers, a superseded row is a counted outcome, not a design breach.

## 2026-08-08 - DECISIONS ordering (the owner): newest-first by decision date

**This file is ordered newest-first by decision date: a new entry is inserted at the top, never at the bottom, and a late-reconstructed entry files under the date the decision was made, not the date it was written.**
Within a day, newer decisions sit above older ones; "append-only" continues to govern content - entries are never rewritten or removed - not position.
The rule is stated in the file header, mirrored in `CLAUDE.md` beside the doc-ownership rule, and the whole file was reordered to match (commit 9b138c0), every entry's wording preserved except the founding entry's positional cross-references, which now name the entries they point at.
Rejected: **the status quo it replaces - three regimes and no stated rule** (newest-first from the top down through the Aug 5 Wave-0 gate entry, oldest-first through the remaining Aug 5 wave entries, and the four LLM entries appended at the very bottom, out of order among themselves).
Rejected: **oldest-first throughout** - the most recent decision is the one a reader needs first, and the file is read far more often than it is written.
Why the stated home matters: a convention with no stated home means whichever end of the file you look at is the convention, which is how the four LLM entries ended up at the bottom with the Aug 7 founding entry filed after the Aug 8 merge rule it precedes.

## 2026-08-08 - Doc ownership: a DECISIONS entry and its spec amendment land in the same commit

**Standing rule, now in `CLAUDE.md`: when a decision is appended to this file, `docs/Kept-Build-Spec.md` is amended in the same commit.**
`DECISIONS.md` is the append-only log of how we got here; the spec is the current state.
Neither is optional and neither substitutes for the other.
**The failure mode it exists to prevent just happened:** the Aug 7-8 LLM-parse decisions reached this log while the spec went on describing the Textract / Document AI upgrade path - a path not taken - for three days, because the prompts said "append a DECISIONS entry" without saying "amend the spec".
A prompt that names only the log must still produce both.
The catch-up is commit 3093bd6 (§4.2, §4.3, §5, §7.2, §7.3, §10A.1 amended, update-log entry added); this entry's own spec reflection is the §10.1 bullet added alongside it.

## 2026-08-08 - LLM merge rule (the owner)

**Prompt v2: the verbatim-vendor rule lives in the vendor field's schema description, with branch and store numbers, addresses, and phone numbers excluded.**
Rejected: the first draft's placement in the shared system prompt, and its "including store numbers" wording, which folded "Store #1234" into the Food Basics vendor.
Why: scoped to the one field that transcribes, the rule went 15/15 against confirmed vendors in the n=3 reparse; the stored v1 records stay untouched and distinguishable by their absent promptVersion field.

**The merge rule, decided on the n=3 evidence.**
Amounts come from the heuristic: both paths scored 100% on the money fields, and the heuristic is free, offline, and deterministic.
Vendor and tax number come from the LLM: 15/15 vendor matches under prompt v2, and 100% against the heuristics' 80% on tax number.
Date trusts neither source alone: the heuristic is deterministically wrong on an ambiguous DateTime line, and the LLM is wrong on roughly 1 of 3 runs over the same line.
When the two disagree on date, the confirm screen keeps the field amber and marks it as needing attention - disagreement between two independent parsers over the same text is free signal, and this is the field that decides the fiscal year.
All LLM-sourced values stay amber until touched; no trust shortcut.

**Re-attribution, recorded honestly: yesterday's date regression was first read as a prompt effect, and the n=3 run shows it is nondeterminism.**
The revised prompt - with the vendor rule scoped out of the system prompt entirely - still produced 2011-07-26 on one of three runs, so the v1 backfill's correct date was partly luck, not a property of the old prompt.

⚠ All of this rests on 5 receipts from 2 vendors. Provisional; re-run parse-accuracy after weeks of real use before treating any of it as settled.

## 2026-08-07 - First real LLM parse run (the owner)

**The LLM backfill's first real Anthropic API run: 6/6 receipts parsed by claude-haiku-4-5 against the dev database, 5,281 input and 332 output tokens, $0.0069 total.**
No request errored and no parse came back all-null.
One came close: the Synthetic Vendor Two receipt returned only a total, which is consistent with its sparse synthetic text rather than a pipeline fault.

**The accuracy listing's headline is a regression, not a win: on the vendor field the LLM scored 40% against the heuristics' 80%.**
On three of the four Noodle House receipts the heuristic kept the confirmed "Noodle House (BCE)" while the LLM dropped the "(BCE)" suffix - cases where the heuristics were right and the LLM is wrong.
The LLM won every Food Basics disagreement (vendor "Basics" vs "Food Basics", the garbled date 2011-07-26 vs 2026-07-11, the missing R prefix on the tax number), and both paths were perfect on the money fields.
The provisional warning is showing: 5 receipts from 2 vendors cannot distinguish a good model from a lucky one, so the spec's §7.3 upgrade question stays open until a re-run after real use.

**`npm run parse-llm-probe` (a one-off script, deliberately not a test) showed the pipeline's output tracks the raw text and nothing else.**
A digit-rotated copy of the Food Basics receipt's ocr_raw_text moved 5 of 6 fields (date, total, subtotal, HST, tax number); vendor stayed put because the corruption touches only digits.
Rejected: making it a CI test - it costs money and is nondeterministic, so it runs once and its outcome is recorded here instead.
Limitation: this is a one-shot manual check on one receipt, not a standing guarantee; nothing re-verifies the property as the pipeline changes.
⚠ On deliberately corrupted input the model returned a plausible invented date (2022-03-18) from an invalid string rather than null, and misread a scrambled amount by one digit.
That is the honest limit of this path: on degraded input the LLM fails plausibly where the heuristic fails visibly.
Design consequence for the server-parse step: LLM-sourced values stay amber until touched, with no trust shortcut.

## 2026-08-07 - The LLM parse path (the owner) - founding entry, reconstructed 2026-08-08

Recorded a day late: this decision produced the code in commits 62699f2 and 3034356 and predates the "First real LLM parse run" and "LLM merge rule" entries, but was never logged - the gap the 2026-08-08 doc-ownership entry exists to prevent.
Sourced from that code and from the two entries that do exist; anything not recoverable from them is marked unrecorded rather than inferred.

**Decided: a second parser, server-side - Claude Haiku 4.5 over the stored `ocr_raw_text`, text only, writing an immutable `llm_suggestions` record beside `ocr_suggestions`.**
The on-device heuristics stay; the LLM augments rather than replaces, and `npm run parse-accuracy` scores the two paths separately against what the human confirmed.
**The model only ever sees `ocr_raw_text` - never a field a person typed** (the owner's ruling, stated as such in the code): the request is built by a pure function whose one input is the raw text, so a builder taking the whole receipt row would put the ruling one refactor away from silently false, and a test asserts what leaves the building.
Every schema field is required and nullable - null is the stated "not printed on this receipt", and an absent key would be indistinguishable from a forgotten one.
The reply is validated before anything stores it: structured outputs guarantee the shape, but the values still cross a trust boundary - a non-calendar date or an unstorable amount is refused loudly, never quietly corrected.
The system prompt states Canadian-receipt domain facts (HST/GST are one CRA program; cross-check multiply-printed dates; tax numbers carry letter prefixes), not step-by-step heuristics - the model's judgment over the text is the point, and the on-device heuristics already do rule-following.

Rejected: **a vision model over the receipt image.**
The recoverable reason is the standing constraint rather than a model comparison: the image never leaves the phone, so the server has only the text to parse (§4.3's resolution note states this as why the image-parsing products stayed rejected at upgrade time).
Whether a vision parse was also weighed on accuracy or cost is unrecorded.
Rejected: **an on-device LLM.**
Why is unrecorded - nothing in the code or the existing entries states the reasoning.
Rejected: **the cloud expense parsers §7.3 had named as the upgrade path (AWS Textract AnalyzeExpense, Google Document AI, Azure Document Intelligence).**
They parse the image server-side, which the same image-never-leaves-the-phone constraint rules out; §7.3's original objection also stands, because on-device Vision remains the only OCR and capture stays instant and offline.

**Why Haiku 4.5:** the task is structured extraction over roughly 30 lines of text, and the accuracy table arbitrates whether a larger model is ever warranted - not taste.
The cost estimate the code carried at decision time ("roughly a quarter of a cent per receipt") measured at about 0.12¢ on the first real run ($0.0069 across 6 receipts, entry above); the comment now carries the measured figure.
Whether other providers or model tiers were compared before settling on Haiku is unrecorded.

**Why the backfill ran before the server-side parse:** sequenced deliberately so `parse-accuracy` could score the model against already-confirmed receipts before anything ships to a client.
The backfill is local-database-only under the same guard as `db:seed` and `db:claim` - not because it deletes anything, but because it sends receipt text to an external API and writes to tax records, and pointing it at production should be a decision someone makes deliberately, not a `DATABASE_URL` that happened to be exported.
Constraint 2 is untouched by any of this: the LLM adds suggestions, never confirmations.

## 2026-08-07 - Secret-exposure audit: nothing leaked, and the ignore rule is the load-bearing control

Audited the full history for committed secrets: the repo has no git remote, no env file was ever committed on any ref including unreachable objects, and every credential-shaped value in history resolves to a test fixture, a documentation placeholder, or the by-design local dev password.
The ignore rule predates the file it protects: `.env.local` was in the Wave 0 skeleton's `.gitignore`, two hours before `server/.env.local` first existed.
Verdict: no credential in this repo is to be treated as leaked, and nothing was rotated.
**A gitleaks pre-commit hook now guards commits, tracked in `.githooks/` and wired via `git config core.hooksPath .githooks` (Runbook §0), falsified in both directions.**
⚠ Stated rather than smoothed over: gitleaks' protection is shape-based, so it covers `ANTHROPIC_API_KEY` well and opaque secrets like `SESSION_SECRET` only weakly - a fake key missing the real format's exact tail sailed through until the shape matched.
The ignore rule, not the hook, is the load-bearing control.

## 2026-08-07 - Wave 6: the deployment exists as configuration, and the backup is tested

Recorded as one entry because the pieces depend on each other: the privacy label could not be written until the deployment named where data goes, and the rate limiter could not be shaped until something sat in front of the origin.
**Nothing was deployed and nothing was submitted to Apple.** No secret was seen, generated, stored or printed.

**A shipped build reaches exactly one address, and cannot be redirected. `ServerConfig` splits into a `ServerEnvironment`: production is `https://api.keptapp.net` and does not read the stored override at all; development keeps `http://localhost:3000` and the settings sheet.**
Rejected: **keeping the settings sheet in Release** (the owner's ruling, and the reasoning generalizes now that the ATS exception is gone: an `http://` address can no longer carry cleartext, so what remains is *redirection* - a control on every installed phone that sends the session bearer token, and every request made with it, to an address of the holder's choosing, under a link anyone can install from).
Rejected: **a build setting or `.xcconfig` holding the URL** - making the production address configurable is precisely what must not be true of it.
Rejected: **`#if DEBUG` at each call site** in favour of one compile-time branch in `ServerEnvironment.current`, so both environments stay exercisable from a test build - which is always the Debug one.
Cost taken knowingly: moving the API to another host now needs an app update.
⚠ Stated rather than smoothed over: `localhost:3000` still appears twice in the Release binary, as the development case's literal and as an example inside an error message. Both are dead - nothing in Release constructs `.development`, and the message's only caller is compiled out - and fencing the enum case would spread conditional compilation through a switch to delete a string, the same trade the `INFOPLIST_PREPROCESS` ruling already rejected. **A string constant is not an affordance**, but the honest claim is "no reachable path to localhost", not "no localhost in the binary".

**The origin refuses to serve unless Cloudflare put it there: `EDGE_SHARED_SECRET` in an `x-kept-edge-secret` header, compared in constant time ahead of every route.**
Rejected: **relying on the edge alone** - Fly gives every app a public `*.fly.dev` hostname, so §10B's rate limiter at the edge would guard one door of a two-door building, and a limiter that can be walked around is the decorative-control pattern this project caught at wave 3.
Rejected: **requiring the secret** - the origin has to answer before Cloudflare can be pointed at it, so a required secret makes the first deploy impossible. Optional, with its absence a checklist step rather than a footnote.
Rejected: an IP allowlist of Cloudflare's ranges (a list that changes, maintained by nobody here).

**Production configuration is checked at startup, not at the first request that needed it (`src/productionEnv.ts`, under `NODE_ENV=production` only).**
Rejected: **letting the existing checks stand alone.** They cover missing variables; they say nothing about four configurations under which the server would happily *run* while being quietly wrong - no `STORAGE_*` at all (which silently falls back to a MinIO that does not exist on a Fly machine), a plain-http storage endpoint (presigned URLs inherit it, so receipt images cross the network in the clear - the audit's N5), a loopback `DATABASE_URL`, and a session secret too short for HS256's security argument.
Rejected: **checking everywhere** - `npm run dev` would then demand R2 credentials to serve a laptop, and the pressure to weaken the check would land on the production case. It is the mirror image of `assertLocalDatabase`: that one keeps destructive dev scripts *off* remote databases, this one keeps the server *off* local ones.
Verified by making the real Docker image refuse each one, not only by unit test.

**The Dockerfile runs `tsx` on the TypeScript, with dev dependencies installed.**
Rejected: **a compiled build step** - it produces a second code shape that exists only in production, which is framework §9.3 rule 5's exact failure and has cost this project eight times. It also keeps `drizzle-kit` on the machine, so `fly ssh console -C "npm run db:migrate"` works from where the database is reachable. At one always-on machine the startup cost is nothing.
Also decided: **`auto_stop_machines = "off"`** - a cold start on pull-to-refresh would read as the honest 10-second timeout wave 5 put in front of people; scale-to-zero saves dollars and spends the success test.

**§10B's tested backup restore has now been run, and the verifier was falsified.**
`npm run db:verify-restore` compares row counts source-vs-restored and then follows every live image row in the *restored* database out into object storage, re-hashing the bytes against the digest that row carries.
Rejected: **checking that the object key resolves** - a key that resolves proves an object is there, and only the digest proves it is the *right* object. Rejected: **restoring into the live database to check a backup**, which is a destructive test of a non-destructive property.
Run against the dev database, which holds real captured receipts and their real stored bytes: 3/9/4/0 rows, four images all re-hashing, dev database left exactly as found.
Then damaged deliberately: it reports a deleted row, a corrupted digest and a missing object, and exits 1. It also refuses when both URLs name the same database, and **refuses to report success when the restored database holds no images** - a restore verified against zero images has verified nothing, which is the vacuous-assertion shape the August audit found in the isolation suite.

**⚠ A §10B assumption that only became checkable once a provider was chosen.** §10B says "managed Postgres with point-in-time recovery", and **Neon's history window is 6 hours on the Free plan** (7 days on Launch, 30 on Scale). That answers "I ran the wrong thing twenty minutes ago"; it is **not** a six-year retention story. Retention rests on the scheduled dump, which is now a checklist item rather than an implication.

**The privacy manifest ships and the label is written out word for word.**
Six data types - other financial info, photos or videos, other user content, user ID, email address, name - **all linked to identity, none for tracking**, plus `NSPrivacyAccessedAPICategoryUserDefaults` with reason `CA92.1`.
Rejected: **declaring only the three the review named** (financial info, user content, identifiers) - the server also stores the Apple relay email and, when Apple provides it, the display name. Declaring less than is stored would be the flattering answer and the false one.

**R2's key normalization is still unmeasured, and is now one command instead of an assumption.**
`npm run storage:probe-keys` probes nine spellings against a planted victim object, with a control that proves it can observe a leak and a refusal to report anything if the control fails. Against MinIO it reproduces the audit exactly: leading slash and double leading slash serve the victim's bytes, every dot-segment spelling refused.
Rejected: **inferring R2's behaviour from MinIO's** - the audit was explicit that one normalization class already goes the opposite way, so either result would be unfounded. Nothing in the API depends on the answer: keys are matched whole on write and re-checked on read.

**A test that could not fail for the case it existed for - found by falsifying it, and the lesson is not about this test.**
`testEverySettingsScreenReferenceIsFencedOutOfReleaseBuilds` searched for `ServerSettingsView` outside a `#if DEBUG` region. Unfencing the settings *button* left it passing, because the button's line says `Button("Server settings")` and never names the type - so the falsification produced a Release build with a **visible button whose sheet is compiled out**, a dead control shipped, and the test guarding exactly that said nothing.
It now checks the user-facing label as well as the type, and its "still exists in Debug" pair does too, so neither can guard an absence.
**The general form: an assertion aimed at how a thing is *built* rather than at the thing a person *sees* tracks the author's mental model of the code - which is where the defect already is.** Second instance of the August audit's N3 in a different costume. When a test guards a user-visible property, assert the user-visible string.

**A measurement method note, on the same theme.** The first `strings` check of the Release binary read the Debug `Kept` executable as its comparison and got zero hits for a control string - that binary is a 58 KB stub, with the code in a separate `Kept.debug.dylib`. Reading the wrong file would have produced a comfortable and meaningless "nothing there". The control is what caught it, which is the same discipline the probe script now enforces on itself.

Suites: **server 214** (was 201), **iOS 194** (was 177), `tsc --noEmit` clean, zero iOS warnings; every new test falsified in both directions.
Guardrail 7 twice: the real entrypoint (no stale listener on port 3000 for the first wave in five), and the production Docker image, which answered a real 401 with `Cache-Control: no-store` and a 403 with the edge secret set and no header.

## 2026-08-07 - One live export per user, and the method note behind the memory number

**Provisioning ratified: `shared-cpu-1x` at 2 GB** (§4.2), on the measurement recorded in the previous entry.

**One live export per user, enforced by a partial unique index, and refused rather than queued.**
Rejected: **deferring it** - it was originally written up as acceptable at three users, and the owner's correction is the better reasoning: **on a fixed 2 GB ceiling the relevant number is not how many users there are, it is how many exports can overlap**, and this removes the only path that doubles peak RSS. It is also cheap right now, while the export code is loaded.
Rejected: **queueing the second request** - a queue needs a worker, a fairness rule, and a way to cancel. Refusing needs one sentence, and the client already polls the running job, so the person can press Export again when it finishes. 409 `export_already_running`.
Rejected: **a check in the handler**, which cannot be made race-free. Generation runs *after* the 202 response, so no transaction spans the thing being serialized, and Postgres takes no lock on rows that do not exist yet - two taps of Export would pass the check twice and start two generations. The invariant has to live where the state lives, so it is a partial unique index on `export_jobs (user_id) WHERE status IN ('queued','running')`, and the insert's unique violation becomes the 409 (the same `isUniqueViolation` shape wave 4 used for duplicate images). Migration `0003_one-active-export-per-user`.

**⚠ The index needed a companion, and it is not optional.**
A job whose process dies leaves its row `running` forever, and the index reads *stored* status - so on its own the constraint would convert a single crash into a permanent, silent lockout of that user's exports.
`POST /api/export` now retires jobs past the staleness windows before inserting, using the same two clocks and constants `reportedStatus` already reports `stale` with, so a client can never be told "stale, re-run it" by one rule and blocked by another.
This does write back to a row the §8 design deliberately left computed, and that is consistent rather than in tension: a job whose process died *did* fail, so the row is more truthful afterwards, not less. What changed is that the fact now has to be durable, because an index cannot read a computed status.
Both halves are tested and both were falsified: removing the reap fails the lockout test, and dropping the index makes two concurrent exports succeed.

**One pre-existing test asserted a state that is now impossible**, and was moved rather than weakened.
`reports a job stranded in running as stale on a longer clock` inserted two concurrent `running` jobs for one user to compare the two clocks. The second job now belongs to a second user: both assertions survive intact - the clock depends on a job's age and status, not on its owner - and the comparison is still needed, since a rule that called every running job stale would satisfy the first assertion alone.

**Method note, recorded because the number it produced is now sizing hardware.**
The export memory measurement could not use the project's shared `fakeObjectStorage`: it retains every uploaded object in a `Map`, so measuring against it would have counted roughly 250 MiB of the double's own retention as the export's cost and produced a figure that was mostly test harness.
It used a double that generates incompressible bytes on demand and discards uploads, which is what R2 actually does.
**This is framework §9.3 rule 5 again** - a test double diverging from production in exactly the load-bearing dimension - and the first instance where the divergence would have corrupted a *measurement* rather than a test.
That distinction is the part worth keeping: **a failing test is red, while a plausible wrong number is not**, so a double that is merely convenient becomes dangerous the moment something is provisioned from what it reports.
(Instance count: this is the eighth on Kept. The owner's note said six, which counts the five recorded before this session's two configuration assertions were added.)

## 2026-08-06 - The owner's rulings on the security review, applied

Every open finding from `docs/security/review-2026-08.md` and `docs/security/audit-2026-08.md` was ruled on and implemented.
Recorded as one entry because the rulings were made together and several depend on each other.

**Deployment target: Node on Fly.io for the origin, with Cloudflare proxying in front of it. R2 and Neon unchanged.**
Rejected: **Cloudflare Workers, which was this same day's first ruling and was reversed within the hour.**
Also rejected: a Worker origin with export generation moved to a Container or queue consumer (real work to buy a property nothing needs), and cutting the export budget to fit a 128 MB isolate (it would refuse longer periods to satisfy a platform we chose voluntarily).

**The reversal is the part worth keeping.**
The first ruling picked Workers because Hono was chosen at §4.2 partly for Workers portability, so the bet should be cashed, and because it puts the §10B rate limiter at the edge.
Writing that into the spec is what surfaced the disqualifying fact - checked against Cloudflare's documentation rather than assumed: **a Workers isolate is capped at 128 MB on both the free and paid plans, per *isolate* and shared across concurrent requests, not per request.**
`DEFAULT_EXPORT_LIMITS` is **256 MiB**, so the budget alone was double the ceiling before accounting for the zip existing twice during assembly.
**the owner's reasoning on reversing: forcing a memory-heavy export onto a 128 MB isolate was buying portability we do not need at three users.**
Cloudflare in front of a Node origin still supplies the edge rate limiter and DDoS protection that motivated the choice; only the origin's runtime changed, and `@hono/node-server`, `pg`, `archiver` and `exceljs` all stay as they are with no export rewrite.
Workers is not foreclosed - it becomes available if `buildZip` ever streams to R2 instead of buffering - but nothing needs it today.

**The export budget under a Node origin: measured, not argued.**
Predicted first, per the standing rule, and the prediction was wrong in the direction that matters, which is why it was measured.
A 250 MiB export (25 images just under the budget, against a storage double producing incompressible bytes on demand and discarding uploads, the way R2 behaves) peaked at **891 MiB RSS, 693 MiB above baseline - about 2.8x the payload**, against a prediction of roughly 2x.
The multiplier is structural: `buildZip` accumulates the archive's output chunks and then `Buffer.concat`s them, so a fully-assembled incompressible zip exists twice, alongside the image buffer in flight.
**Conclusion: the budget is sound but it sizes the machine.** Roughly 1 GB carries a single export with little margin, so **2 GB is the provision** - within `shared-cpu-1x`, since Fly's ceiling is 2 GB per shared CPU.
⚠ Nothing serializes concurrent exports, so two at once doubles this. Acceptable at three users; the first thing to revisit if that changes.
The measurement was a one-off (a 250 MiB allocation has no business in `npm test`) and is reproducible from this description.

**The Debug and Release `Info.plist` are separate files, and a test asserts it.**
Rejected: one plist with `INFOPLIST_PREPROCESS` conditionals (obscure, and a preprocessor in a plist is a worse thing to inherit than a duplicated key); and shipping the exception on the argument that `NSAllowsLocalNetworking` only relaxes local and link-local hosts (true, and still wrong - `ServerConfig` accepts any `http://` host, so a Release build would carry bearer-token traffic in cleartext to any LAN address typed into the settings sheet).
Why the test matters more than the split: this defect lived **entirely in a build setting** and no runtime test could ever have caught it.
`InfoPlistConfigurationTests` reads the source tree and `project.pbxproj` and asserts the shipping plist has no ATS keys, that Debug still has them (deleting the affordance would also make the first assertion pass), that the two files agree on every other key, and that the two configurations point at different files.
Verified by restoring the pre-fix state: all four assertions fail.
The cost taken knowingly: two files that must agree, which is what the third assertion is for.

**Outbox files write with `.completeFileProtection`, and a locked read is no longer mistaken for a lost receipt.**
Rejected: leaving the iOS default (`completeUntilFirstUserAuthentication`, which stops protecting after the first unlock following a boot - in practice, always) on files holding the vendor, tax number, every amount, the payment method, the notes, the full OCR text and the receipt image itself.
**⚠ The ruling was safe on its stated reasoning and unsafe as a literal edit, which is worth recording.**
The drain constraint is indeed unchanged - the keychain is already `WhenUnlocked`, so the drain cannot run locked.
But `FileOutboxStore.imageData` mapped *any* read failure to `OutboxMissingImageError`, which the controller treats as **permanent** and reports to the person as "the saved image could not be read back from this phone".
With complete protection, a locked read raises exactly that failure, so the edit as stated would have converted a healthy receipt on a locked phone into an unrecoverable one.
A locked read now throws `OutboxLockedError` and classifies as `.retryLater`, next to the keychain case that already had this shape.
`loadAll` fails the whole load rather than counting healthy items as unreadable, which keeps `hasLoadedOnce` false so the next foreground retries.
Tested with a scripted locked read asserting `waitingToRetry`.
Unverifiable, stated as a limit: the simulator does not enforce data protection, so the protection class is asserted as configuration (framework §9.3 rule 5, sixth instance).

**`renderError` strips database detail unconditionally, and so does anything that stores an error message.**
Rejected: keeping the raw log for diagnostic power now that the int4 bound removed the trigger.
Why: the bound removed *a* trigger, not the class - any future failed query prints the same way, and the error monitor §10B plans is what turns a terminal on the owner's Mac into an exfiltration path.
**⚠ The review's own recommended fix would not have worked, which is the useful part.**
It proposed logging `error.message` and the constructor name instead of the object.
But `DrizzleQueryError`'s constructor builds its message as `` `Failed query: ${query}\nparams: ${params}` `` - the bound parameters are **inside `error.message`**, not merely on a side property, and they are in `error.stack` too, whose first line is name + message.
So redaction had to be structural rather than textual: an error carrying any database-error marker is described by its schema-identifying fields alone (`code`, `constraint`, `table`, ...), never its message, stack or properties.
Our own errors keep their message and frames, because that text is ours.
**Found while implementing, and fixed under the same ruling:** `runExportJob` stored `error.message` in `export_jobs.error`, which `GET /api/export/:id` **returns to the client** and the export screen renders.
A failed query there would have handed a client the SQL and its bound parameters.
That column is now redacted too, with the over-redaction direction tested - the size-limit message, which is written to be read by the person who hit it, still passes through.

**`db:seed` and `db:claim` refuse any database that is not on this machine.**
Rejected: guarding only `db:seed` (both rewrite tax records, and `db:claim` was already being edited); and comparing against a known dev URL rather than requiring loopback (the deployment target is Neon, whose hostnames are remote by construction, so loopback-only cannot be argued with in the moment someone exports a `DATABASE_URL` to try something).
A `.local` mDNS name is refused too: it names *a* machine on the network, not necessarily this one.
The URL-identity helpers moved to `src/db/databaseUrl.ts` and wave 4's `assertSeparateTestDatabase` now shares them rather than keeping a second copy of the same parsing.
Verified on the real script, not only in unit tests: `DATABASE_URL=<neon-shaped> npm run db:seed` throws at module load, before the pool is constructed, and exits 1.

**`db:claim` refuses receipts that carry image rows.**
Rejected: rewriting `object_key` to the new owner's prefix - the bytes in storage stay at the old key, so the row would point at an object that does not exist, which is a quiet wrong answer in place of a loud refusal.
Why refusing costs nothing: seed data creates no image rows at all, so this refuses nothing the script is used for.
It closes the state the audit reached by hand - a receipt owned by one user whose image key names another.

**`cents()` is narrowed to the int4 range; the test that asserted otherwise is replaced, not deleted.**
Rejected: leaving the domain wider than its storage on the principle that the domain should not know about storage.
Why: a value the type calls valid money and the database cannot store is not a storage detail, it is a contradiction, and where it surfaced was a 500 that logged the whole receipt.
The bounds now live in `domain/money.ts` and `schemas.ts` imports them, so the HTTP boundary cannot stop short of what the column accepts.
The superseded assertion (`cents(MAX_SAFE_INTEGER)` is accepted) encoded deliberate intent, so its replacement says so in place rather than vanishing.

**Export zips move to `exports/{userId}/{jobId}/...`.**
Rejected: one lifecycle rule per user (three today, and silently one more at every sign-up, remembered by nobody) and object tags at upload.
Why: S3 and R2 lifecycle rules match a **literal** prefix, so `{userId}/exports/...` cannot express §10B's rule at all - no single prefix selects every user's exports without also selecting their receipt images, which must never expire.
Pre-existing zips keep the old layout and fall outside the rule; there are none outside dev.
**The general lesson: a retention rule written against a path that varies per user is not a rule, it is a description**, and this one survived two gate reviews because nobody wrote it out as the bucket would receive it.

**Stored object keys are re-validated on read, in both places one is dereferenced.**
Rejected: write-time validation alone.
Why: it says "we issued every key we accepted", which is not the same as "we issued every key we are about to hand out" - rows change by paths that are not the create route.
`assertIssuedObjectKey` now runs in the detail route before presigning and in `generateExport` before downloading, and throws (a 500, correctly - no client caused it) rather than returning false.
The key shapes moved to `src/storage/objectKeys.ts` so the layout an isolation rule and a retention rule are both written against is stated in one place.
Falsified: removing the check makes the new isolation test return **200 with a presigned URL naming another user's namespace**, which is exactly what the audit produced by hand.

**`npm run dev` names a stale listener on port 3000.**
Rejected: leaving `EADDRINUSE`, which reports the wrong fact.
Found four times across waves 3-6, and the risk was never the failed start - it is that **a stale server serves the code it was started with**, so a measurement taken against it looks exactly like a passing one.
The message names the pid, when it started, and the full argv, and says plainly what that means for anything measured against the port.
Verified by starting two servers.

**Deferred, recorded as open rather than closed.**
The **orphaned-object policy**: an image uploaded whose create never completed, inert today - unguessable keys under the uploader's own prefix, no endpoint lists them, no lifecycle rule touches them - but it should be a written policy rather than an absence.
And **per-request token pinning**: `OutboxController` re-checks ownership, then `APIClient` re-reads the token from the keychain, and the window between them requires a full Apple sign-in to complete in microseconds.
That change lands in the drain's session handling, which the wave-5 reviewer named the weakest code in the wave.

Suites after these changes: **server 195** (was 169), **iOS 177** (was 170), `tsc --noEmit` clean, zero iOS warnings.
Every new test was falsified in both directions.
Guardrail 7 re-run: `npm run dev` from the real entrypoint, one real `GET /api/me` answering 401 with `Cache-Control: no-store`.

## 2026-08-06 - Adversarial audit of the security review: money is bounded at the storable range, not the safe-integer one

**`centsSchema` bounds every money field to the Postgres `int4` range (-2 147 483 648 to 2 147 483 647), so an unstorable amount is a 400 naming the field instead of a 500.**
Rejected: the status quo (`Number.isSafeInteger` only - it accepts up to 2^53 while every money column is `integer`, so `totalCents: 2147483648` passed validation, failed inside the insert, and became an unhandled error); widening the columns to `bigint` (a migration on tax data to permit amounts above $21 million, which no receipt in this project will ever carry); and catching the range error in the create handler (it would fix one call site of a boundary defect that belongs at the boundary - PATCH had it too).
Why this outranked everything else the audit found: the unhandled error is what makes `renderError` print a raw `DrizzleQueryError`, and **drizzle attaches a `params` array carrying every bound parameter of the statement**. A single ordinary authenticated request with a large number in it dumped vendor, tax number, category, payment method, private notes and the full OCR text into the log in plaintext, measured against the running server.
**This breaks the prior review's finding 5 in two ways, both recorded because the reasoning is the useful part.** It had ranked the log exposure low on "no reachable trigger", having checked that "every text column is `text` with no length ceiling to violate" - which examined the string columns and never looked at the integer ones. And it hunted Postgres's `detail: 'Failing row contains (...)'`, which is `undefined` in this error; the leak rides drizzle's wrapper instead, which fires on *any* failed query rather than only on constraint violations. A fix aimed at `detail` would have missed it entirely.
**Left for a ruling:** `domain/money.ts`'s `cents()` still accepts any safe integer and `money.test.ts:15-17` asserts that it does, so the domain contract and the storage column genuinely disagree. The HTTP boundary is fixed because an API that 500s on input it just validated is unambiguously a bug; narrowing the domain means changing a test that encodes deliberate intent, which is a finding to report rather than something to rewrite in passing.

**The `Cache-Control` middleware moves outermost, ahead of `bodyLimit`.**
Rejected: the ordering from the previous entry (`bodyLimit` first). Its `onError` answers 413 without calling the next handler, so the cache middleware never ran and the 413 went out with no `no-store` - verified against the running server, where the 401 carried the header and the 413 did not. "Every API response" has to include the ones no route ever saw. The existing tests asserted a 200 and a 401, both of which pass through a route; the new one asserts the 413 and fails if the order is restored.

**The isolation suite's cross-user download assertion is rewritten against a response that can actually carry a leak.**
Rejected: `expect(ownList.text()).not.toContain(bObjectKey)` - it passed for two reasons that were not isolation (A owned no receipts, and the list projection carries no object keys at all), so the headline assertion of the cross-user-object test could not fail. A now creates its own receipt and the assertion moved to its detail response, the one place presigned URLs appear. Falsified by removing the receipt-id and user-id scoping from the detail route's image query.

**Three claims narrowed rather than broken.** (1) The object-key whole-string match is a **write-time gate only** - reads presign whatever `object_key` the row holds with no re-check, and `db:claim` moves receipts between users without touching `object_key`, so a claimed receipt carries a key under the original user's prefix. Inert today (seed rows have no stored bytes, no API route can move a receipt) and it needs database access, so it ranks below a hostile authenticated user - but "we issued every key in the system" is currently enforceable on writes alone. (2) The 1 MiB limit clears every legitimate body - re-derived independently at ~623 KiB - but it is **not** "derived from the schemas" as stated: `identityToken` carries no maximum, so on the one unauthenticated route the cap is the only bound. (3) MinIO refuses every dot-segment traversal, as the review found - **but a leading-slash key normalizes and serves the victim's bytes (200)**. The review's "latent, not live" rested on the storage layer collapsing dot segments; that is a property of the spellings tested, not of the layer, and a different spelling class resolves. Unreachable through the API, and it says nothing about R2 either way.

**Upheld under attack:** no auth-middleware bypass across 22 request targets, 10 methods, 10 `Authorization` variants, absolute-form, HTTP/1.0 and CL.TE/TE.TE smuggling; the object-key predicate against 21 crafted keys; soft-delete exclusion on all 9 read sites (the review said 12, having counted writes); no hard delete anywhere in the API, and `ObjectStorage` has no delete operation at all; and all five iOS claims, with the ATS-ships-in-Release blocker confirmed from `project.pbxproj` lines 278-279 and 301-302 directly.
**The body limit is real, not theatre** - the specific suspicion. Chunked bodies with no `Content-Length` take hono's streaming branch and abort at the cap: six concurrent 50 MB posts moved RSS 55 → 83 MB and stopped. 1 500 stalled connections left memory flat and legitimate requests answering in 1-6 ms; the consumable resource is file descriptors, not memory.
**Reported, not fixed:** `db:seed` issues three unconditional deletes against whatever `DATABASE_URL` names, with no equivalent of wave 4's `assertSeparateTestDatabase` guard - an operator footgun on the one thing §10B calls non-deferrable. **The wave-6 no-go stands, on its stated reasons.**

## 2026-08-06 - Security review, second pass: request bodies are bounded, and the first pass's blind spot named

**Every request body is capped at 1 MiB by `bodyLimit` (from hono itself - no new dependency), mounted app-wide ahead of all routes, answering 413 in the app's own error envelope.**
Rejected: no limit (the status quo - `POST /api/auth/apple` is the one route reachable without a session, so anyone holding the unlisted install link could make the server buffer arbitrary bytes before verification could reject them; measured against the real server, six concurrent 50 MB posts took resident memory from 285 MB to 654 MB and left it there, each request dutifully returning a correct 401); a limit on the auth route alone (the same buffering exists on every route, and one rule is one thing to reason about); a *chosen* round number (the value must not be able to refuse a request the schemas accept); and streaming the body (real work for a case a cap solves, the same reasoning §8's export budget already settled).
Why 1 MiB specifically: images never transit the API, so every body is JSON the schemas already bound - `ocrRawText` at 100 000 characters, `notes` at 5 000, all other strings under 1 400 together. zod counts characters and JSON can spend six bytes on one (`\uXXXX`), putting the worst legitimate case near 640 KB. **The limit is derived, not picked**, and a test sends a create at exactly that worst case to prove the cap cannot reject a real request - it fails if the limit is ever tightened below what the schemas allow.
Verified after the fix against the real entrypoint: the same six concurrent 50 MB posts leave memory flat at 265 MB, and a 5 MB body is refused in 9 ms.

**Rate limiting is re-ranked from low to moderate, and still not built.**
The first pass called it low priority because the auth endpoint is not brute-forceable - which answered a question about credentials and never asked the adjacent one about resources. The body cap bounds what one request costs; nothing bounds how many arrive, and each well-formed attempt still buys a signature verification. Still not built for the reason already recorded: the limiter's shape needs a deployment to name what identifies a client, and there is no deployment. It should land *with* the deployment, at the edge if the API ends up behind Cloudflare.

**The lesson, recorded because it generalizes.** A review that only *reads* finds only the defects visible in a line of code. The absence of a control has no source line to inspect, so availability and resource-consumption defects are invisible to reading by construction - this one took sending 50 MB and watching a memory number move. Operational form: for every externally reachable entry point, ask not only "is what it does correct" but "what does it cost, who can make it cost that, and what bounds it", and answer the second by measuring. Offered as a framework §9.3 candidate, tagged `Kept` only, on one observation.
Also cleared on this pass, by probe rather than by reading: no auth-middleware bypass across 17 path spellings and 8 methods; `web/` is genuinely empty (one `.gitkeep`), so wave 7 has no surface yet; CORS is unconfigured, which is fail-safe for native clients today and becomes a wave-7 decision - an explicit origin allowlist, never `*`, since `*` plus a bearer token is how a hostile page reads someone's receipts.

## 2026-08-06 - Consolidated security review: object keys are matched whole, not by prefix

**`POST /api/receipts` accepts an `image.objectKey` only if it matches the entire shape the upload-url route issues - `{userId}/yyyy/mm/{uuid}.{ext}` - and the issuing route asserts its own output against the same predicate.**
Rejected: the prefix test it replaces (`startsWith(userId + "/")`, from wave 1 - it admits dot segments, so `{userIdA}/../{userIdB}/2026/03/theirs.jpg` passes while naming B's namespace, and the detail route would then presign a download for it); rejecting only keys containing `..` (a denylist against a normalization behaviour nobody here controls, and it would still admit every other unissued shape); and normalizing the key server-side before storing it (silently rewriting what a client sent is the quiet-wrong-answer pattern - refusing states the fact).
Why: verified in both directions. Reverting the fix makes the new regression test fail with a 201, so the API genuinely accepted such keys. But five traversal spellings probed against the real MinIO all failed - three on `SignatureDoesNotMatch`, two on `NoSuchKey` - because the AWS SDK collapses dot segments when building the URL while signing the uncollapsed key, so **nothing leaked and this was latent, not live**. It is fixed anyway because the only thing between a prefix check and a cross-user read was normalization behaviour in the layer beneath, which is the exact trust that produced the wave-5 CFNetwork cache diagnostic and the `URL.path()` encoding defect - and R2's behaviour here is untested, since no R2 credentials exist.
The extension list in the validator is read from the same map the issuing route uses, so the pair cannot drift; the whole-string match is what makes "we issued every key in the system" an enforceable statement rather than a description.

**Algorithm pinning on the session JWT is load-bearing, and now proven so.**
Recorded because the falsification was more informative than the assertion: removing `algorithms: ["HS256"]` does not admit a forged token - jose's key-type check still refuses an RS256 token against a symmetric key - but it refuses it by raising a `TypeError` rather than a `JOSEError`, which `verify` deliberately rethrows, turning an algorithm-substitution attempt into a 500 instead of a clean 401. The pin is what keeps the rejection quiet and correct.
Also added: `alg: none`, and five malformed `tv` claims (`"0"`, `1.5`, `null`, `true`, an object) that differ from a valid token in that claim alone.

**Issuer and audience are deliberately absent from the session token.**
Rejected: adding `iss`/`aud` to satisfy the checklist. Why: they exist to stop a token minted for one party being replayed at another, and this secret signs exactly one token type for exactly one verifier - the claims would assert something already true by construction. The trigger to revisit is a second token type sharing the secret (a download token, a web session with a different lifetime), not distribution. The Apple identity token, which does cross a trust boundary, checks both.

**Wave 6 is no-go, on distribution work rather than on a breach.**
The isolation core holds and is now proven by test, including cross-user object access. What blocks the wave: there is no deployed server (the app defaults to `http://localhost:3000`), the single `Info.plist` serves both Debug and Release so `NSAllowsLocalNetworking` and `NSLocalNetworkUsageDescription` would ship, and there is no privacy manifest and no honest privacy label - which cannot be written until the deployment exists, because where the data goes is what the label declares.
Seven findings are recorded and left for a ruling rather than decided unilaterally: the outbox files' data-protection class (the only finding whose subject is the receipt data itself, and one that changes the `beginBackgroundTask` drain path the wave-5 gate closed without running), the rate limiter's shape (undecidable before a deployment names what identifies a client), whether database `detail` is stripped from error logs, the export key layout (§10B's `{userId}/exports/...` lifecycle rule is not expressible - S3 and R2 match literal prefixes, and that one varies per user), the orphaned-object policy, and per-request token pinning.
Full record: `docs/security/review-2026-08.md`.

## 2026-08-06 - Wave-5 offline pass (the owner): a 10-second request timeout, and the USB confound on the record

**The API session's `timeoutIntervalForRequest` is 10 seconds (asserted by the transport-configuration test).**
Rejected: the 60-second default (on the genuinely-offline device run it read as a hang - a person pulling to refresh in a store must get a fast honest failure, not a minute of spinner), an even shorter value (a slow cellular handshake can legitimately take several seconds; 10 answers while someone is still looking without failing marginal-signal requests that would have succeeded), and a separate longer-timeout session for the outbox's image PUT (unnecessary: this is an idle timer that resets whenever bytes move, so a slow-but-progressing upload is never cut by it - only a genuine stall is, and a stalled background upload *should* fail fast into backoff).
The outbox question answered in the same stroke: its upload-url, PUT, and create all ride the same `URLSessionTransport`, so its first attempt had the identical 60-second hang and the same one-line fix covers it.

**The USB confound, recorded as a correction.** Every earlier "offline" run was invalid: a phone tethered by the dev cable can reach the Mac's server with both radios off, so no offline failure could ever surface - unplugging was the missing variable, found by the owner. This partially re-attributes the offline diagnostic one entry down: the cached responses were real, the missing `Cache-Control` contract was real, and the cache-free transport is what made today's honest timeout possible - but the decisive mechanism behind that day's "no error" was most likely USB reachability, not a cache hit, and the two produced identical observations. Fifth instance of framework §9.3 candidate rule 5, and the most expensive kind: the environment divergence didn't just hide a defect, it invalidated the *test itself* while every observable looked like a pass.

**Verified on the genuinely-offline device run:** honest refresh failure with retry and a stated-unavailable pending count; capture-confirm-save returning to Home with live outbox status; automatic retry with backoff, unprompted; queue survival across force-quit while offline; automatic drain and list arrival on reconnect. **Stated gap: one receipt only - multi-item queue drain and cross-item ordering remain device-unverified** (covered by unit tests, not by the §6 gate's three-receipt run, which still stands ahead).

## 2026-08-06 - Wave-5 offline diagnostic (the owner): the API transport carries no HTTP cache, and the server says so

**Client: `URLSessionTransport` uses a session with `urlCache = nil` and `requestCachePolicy = .reloadIgnoringLocalCacheData` (either alone suffices; both are set so neither is load-bearing). Server: every API response carries `Cache-Control: no-store`, applied as app-wide middleware. Tests on both sides: the iOS suite asserts the transport's configuration (the configuration IS the behaviour - no request-level simulator test can see CFNetwork's cache), and the server suite asserts the header on a 200 and a 401.**
Rejected: client-only (the very next client would re-discover this the same way; the header states the contract at the source), server-only (a client's explicit cache policy should not depend on every server being configured right), and `.ephemeral` session configuration (discards cookies and credentials storage too - broader than the defect, and the two explicit settings say precisely what is meant).
Why: with both radios off, pull-to-refresh in the app showed no error and a current-looking empty list. The device's own cache database (`Library/Caches/…/Cache.db`) held the post-wipe list response verbatim; CFNetwork had heuristically cached it - Hono sent no cache directive - and served it offline as a fresh 200. Stale receipt-detail responses with expired presigned image URLs and a stale pending badge ride the same mechanism.
**The lesson, per the owner, is not about error handling.** The app's own error path was verified correct at the same time: a network failure drops the rows and shows the failure view with the reason and a Retry, and an empty list does not suppress it. The masking lived **below** the app - the transport reported success because, as far as it knew, the request succeeded. The trap is trusting the layer beneath to behave as the code above assumes: URLSession's default is a component with its own policy, and an unconfigured default is still a decision. Fourth instance of the framework's §9.3 candidate rule 5 - a production-environment behaviour (CFNetwork cache heuristics) that no simulator unit test exercised, alongside the fabricated Vision geometry, the unloaded `.env.local`, and the space-free test path.

## 2026-08-06 - Wave-5 airplane-mode run (the owner): the outbox store checks paths unencoded, and store tests walk a space-bearing path

**Both `fileExists` checks in FileOutboxStore use `path(percentEncoded: false)`, and the store test suite's temporary directory deliberately contains a space.**
Rejected: `URL.path()` bare (the defect: it percent-encodes by default, production lives under "Application Support", and the encoded string names a path that does not exist - so remove's idempotency guard answered "already gone" and returned success without ever removing, and loadAll's commit-file check misfiled every healthy item as unreadable at launch; three uploaded-and-created receipts left three undeleted directories and a false "2 saved receipts could not be read" on Home); the deprecated `.path` property (works, but the modern API with the explicit argument states the intent); and keeping the space-free test directory (the suite was green through the whole failure - reverting the fix now fails all 8 store tests, verified both ways).
Why: diagnosed entirely from the device evidence before any code moved (the owner's instruction): all three "unreadable" item.json files pulled off the phone decoded perfectly, each at `uploaded` with a matching server row - nothing was lost and nothing was unreadable; the cleanup and the visibility check were lying about the same paths.
**The masking casualty, named:** items invisible to loadAll never re-entered the queue, so their retried creates never ran - and the 409 duplicate-image self-heal, built precisely to absorb replayed uploads, could not reach the very items it existed for. A masked read defeated the recovery machinery downstream of it; the "N could not be read" note was the only symptom that survived, and it pointed away from the truth.
**The general lesson (third instance; recorded in the framework, §9.3 candidate rule 5):** the test environment differed from production in exactly the dimension that mattered - fabricated Vision geometry (wave 4), `.env.local` never loaded by the real entry point (wave 3), and now a test path without the space production paths carry.

## 2026-08-06 - Wave-5 device re-test (the owner): column de-skew in row assembly

**The row assembler estimates the receipt-wide vertical skew of the amount column (median of each amount fragment's delta to its nearest other-column neighbour, zero under 3 samples) and removes it before band-merging; emitted rows keep the measured geometry.**
Rejected: any pairing rule change without geometry in hand (the owner's instruction, and the wave-4 fabricated-fixture lesson - the diagnosis came from `vision-dump` over the exact uploaded bytes); tightening or loosening the band threshold (the Food Court dump proves no threshold works - the amount column measured ~0.013 above its labels against a ~0.022 row pitch, so each amount's *nearest* label was genuinely the wrong one, and the tax block "GST $0.00 / HST $2.05 / Total $17.84" assembled as "GST $2.05 / HST $17.84" with both ends orphaned); nearest-center or stable matching (same defeat - proximity itself lies under skew); and full sequence-alignment assignment (correct in principle, heavyweight against §7.3's humble-heuristic doctrine, and unnecessary once the skew - which is one coherent camera/curl artifact, not per-row noise - is removed).
Why: both real receipts to date show a coherent column offset (Food Court +0.013, Noodle House -0.008 - opposite signs, so the fixture pair covers both), and the median-of-nearest-deltas estimator is robust because most nearest pairings are true pairings even when the tax block's are not. Three different wrong HST suggestions from one paper (0.00, then 17.84 - the total - into the input tax credit field) were all this one structural misread.
Stated limits: a skew at or beyond a full row pitch shifts every pairing by one row and is undetectable by any local geometry - the human confirming each value (constraint 2) remains the real floor. The total heuristic was re-checked for the reverse mispairing per the owner: it survived even the broken assembly here because "largest across total-labelled lines" plus the receipt's redundant contiguous `TOTAL: $ 17.84` line made it insensitive to losing one pairing; its residual exposure is an *inflating* mispair (a larger neighbour amount attaching to a Total label), which the de-skew now covers in the partial-pitch case and full-pitch skew still could defeat - accepted under the same constraint-2 floor.

## 2026-08-06 - Wave-5 device step 1 (the owner): HST/GST label priority

**Tax labels are ranked, never lumped: non-zero HST > non-zero GST > non-zero TAX > zero HST > zero GST > zero TAX; topmost within a tier; total-mentioning TAX lines stay excluded.**
Rejected: the wave-4 shape (one `HST|GST` pattern, first match - The owner's Food Court receipt printed "GST: $0.00" above "HST: $2.05" and the GST zero landed in the HST field, the input tax credit, where a wrong-but-plausible 0.00 gets ticked past while an absence demands attention); summing HST and GST rows (invents a number no row printed); and pure label priority without the zero demotion (its mirror image - "HST $0.00" above a charged GST row in a non-harmonized province - reproduces the identical bug the other way around).
Why: HST is the more specific label and the harmonized amount already contains the federal part, so when both are non-zero - a receipt charging the tax twice - the HST row wins and the arithmetic warning surfaces the mess. A lone GST row still suggests into the field: GST and HST are one CRA program, claimed on the same return line. An explicit zero beside a non-zero sibling label is a shadow of the sibling program; an all-zero tax block is a genuinely exempt receipt, whose zero is the honest suggestion.

**The same audit ran over every heuristic that could face several labelled candidates.** Subtotal moved from first to **bottom-most** matching row (section subtotals print above the summary block; the summary subtotal is what the arithmetic check compares; single-subtotal receipts unaffected; flagged as evidence-free until a real multi-subtotal receipt lands in the accuracy table). Left deliberate as-is, now with the reasoning recorded: total (largest across all total-labelled lines - "largest" already resolves multiplicity), date (first parseable, top-third preferred - wave-4 tested), vendor (topmost-of-near-tallest band - wave-4 second pass), tax number (topmost match - the supplier prints its own number in the header block, above any other party's).

**The fixture debt is stated, not papered over.** The Food Court scan was never queued (the step-1 session ended without a completed Save, by design losing only the in-memory scan), so its bytes exist nowhere to re-run Vision over - the wave-4 rule demands real geometry, and there is none to be had. The fix carries rule tests over synthetic rows, explicitly labelled as such, and the real-dump fixture lands when the re-test uploads the receipt. `ios/Tools/vision-dump.swift` is now a committed tool (smoke-tested against the stored wave-4 receipt) so that dump is one command.

## 2026-08-06 - Wave-5 gate ratification (the owner)

**Ratified: §7.4's worker is app-lifecycle-driven, with no OS background execution.**
Rejected: adding `BGTaskScheduler` for literal background upload.
Why: real background execution buys latency nobody perceives; the foreground-driven drain plus the ~30-second backgrounding grant covers the actual usage pattern, and the keychain posture stays `WhenUnlocked` as a direct consequence.

**Rejected: capture returning to Home without the confirm screen. A single capture goes scan → confirm again; the confirm screen is now local-backed and its Save is a durable outbox write.**
Rejected on the owner's reading of his own kickoff: "return to Home immediately" meant *don't block on the network*, never *don't show the screen*. Online is the common case, and charging every receipt a badge tap to serve the rare offline one adds friction to the common path while manufacturing a pending queue that §1's success test exists to avoid.
The implementation honors both halves: after scanning one page, on-device OCR prefills the §7.2 form from local data (image included - no server row exists yet), and **Save writes the confirmed receipt into the outbox** - a disk-only, immediately-returning operation; the drain later uploads it and creates the row already `confirmed`, so it never joins the pending queue. "Later" queues it pending instead, so leaving the screen never costs the scan. **Batch mode keeps the wave-5 shape** - many pages queue pending immediately and are worked down through the confirm queue afterwards, which is correct for a stack and wrong for one receipt.
Also rejected: waiting for the upload before showing the confirm screen (a network wait on the capture path is what §7.4 abolishes; offline it becomes an indefinite spinner), and confirming against the server row post-upload as wave 4 did (re-introduces connectivity into the moment of capture).
Supersedes, in part, the wave-4 "single capture is a batch of one" decision: the *enqueue path* stays one path (everything goes through the outbox), but the *confirm timing* now splits by page count - which is the distinction that decision's "one path" argument actually cared about.
Stated cost: a scan is in memory only while the confirm screen is up; the app dying right then loses it, and the paper is still in the person's hand. The §7.4 guarantee anchors at Save, not at scan - same as the paper-based reality it replaces.

## 2026-08-06 - Wave 5

**The keychain stays `WhenUnlocked`; the outbox drains only while the app runs in the foreground (plus the ~30-second `beginBackgroundTask` tail after backgrounding).**
Rejected: widening accessibility to `AfterFirstUnlock` for background upload (the wave-3 reversal would have been re-reversed for nothing: no code path reads the token while the device is locked, because none runs then), `BGTaskScheduler` processing tasks, and a background `URLSession` (both add the app's most complex machinery - state restoration across process death by the session daemon - to save latency nobody is waiting on).
Why: the kickoff's own usage analysis holds - a person scans, pockets the phone, and the app has minutes to hours. With signal, the upload finishes in the foreground seconds or the backgrounding tail; without signal, background execution could not upload either. The receipt's safety never depends on upload timing - that is what the durable queue is for. A drain overtaken by the device locking fails the keychain read as a retryable error and the next foreground finishes the job. If a later wave adds real background upload, the accessibility question reopens with an actual requirement attached, and the save path still re-asserts accessibility so installs migrate on the next save.

**Strict concurrency checking is on (`SWIFT_STRICT_CONCURRENCY = complete`) in Swift 5 language mode, whole target.**
Rejected: full Swift 6 language mode (its remaining changes are annotation ceremony against §10's legibility mandate - the data-race checking is the part with three waves of defect evidence behind it), a separate Swift-6 module for the outbox alone (a hand-written framework target in the pbxproj to isolate what a build setting already isolates), and staying at minimal checking (the wave-3 deferral, now outweighed: the interleave class recurred in waves 3 AND 4, found by review each time, never by the compiler or the suite).
Why: in Swift 5 mode `complete` emits the full Swift 6 data-race diagnostics as warnings, and the project's zero-warnings discipline makes warnings blocking - so the compiler now catches the recurring defect class while the code keeps its Swift 5 shape. The pre-existing codebase surfaced ~30 diagnostics, fixed structurally (Sendable protocols, a Sendable APIClient, value-typed Vision output) except six cached `Regex` statics marked `nonisolated(unsafe)` with the immutability argument stated inline.

**Saving a capture writes image bytes and a minimal record to disk; OCR runs in the drain, not on the save path.**
Rejected: OCR at enqueue (a sixty-page backlog scan would hold the person for a minute of recognition against §7.4's "return to Home immediately"), and never persisting the parse (re-running OCR on every retry burns battery for identical output).
Why: the save path's only job is durability, and disk writes are milliseconds. The drain runs OCR once per receipt, persists the result on the item, and every later attempt reuses it.

**The outbox is a per-item directory under Application Support: image first, `item.json` written atomically last as the commit point.**
Rejected: Core Data/SQLite (a database for a queue of a dozen items whose payload is a JPEG is machinery without a reader), UserDefaults (wrong for blobs, wrong durability story), and a single queue file (every item update rewrites every item; one corruption loses the whole queue).
Why: the commit point makes partial enqueues detectable, items fail independently, and `item.json` stays human-readable for diagnosing a stuck queue by hand. Application Support is in device backups, which tax records want. A directory without `item.json` - the process died between the two writes, a save the person was never told failed - is counted into the "could not be read" note and kept, never deleted (the first draft swept these silently; the reviewer called it a second deletion path, and it was).

**Each item persists a step machine - captured → parsed → uploaded(objectKey) - re-written after every completed step.**
Rejected: restarting items from scratch on relaunch (re-uploads bytes already in storage and re-runs OCR), and persisting nothing mid-item (a kill between the PUT and the create repeats the PUT; between create and cleanup it double-creates).
Why: a kill at any boundary resumes instead of repeats. The one unavoidable replay - create succeeded, cleanup did not - lands on the server's 409 `duplicate_image`, which the drain counts as saved: the wave-4 ruling extended to the queue, for the same reason (the receipt exists; punishing recovery would fail the batch).

**Failures classify four ways, in one place: 409 → saved; 401 → wait for sign-in; network/5xx/408/429/locked-keychain → retry with backoff; any other 4xx and a missing image file → block for a human.**
Rejected: retrying everything (a permanent 400 would head-block the FIFO queue forever - kickoff §3 forbids exactly this), failing anything permanently on its own (a queued receipt silently dying is the one unforgivable outcome), and per-call-site error handling (the drain is where a swallowed failure is invisible by construction, so classification is a single audited function).
Why: blocked items surface on Home with the server's reason and two human actions - retry and discard (discard confirms first and is the only deletion path in the whole outbox). A connectivity-shaped failure stops the pass, since it is almost always queue-wide; an OCR failure defers only its own item, because it never is (reviewer finding - one unreadable page must not stall a backlog behind it). Backoff doubles 2s → 5min, reset by any trigger: foreground, connectivity restored, fresh capture, sign-in, manual retry, or a completed upload.

**Outbox items carry the capturing user's id, read from the session JWT's `sub` claim; the drain uploads only the signed-in user's items.**
Rejected: a separate stored user id (a second source of truth beside the token, with a migration for the existing install), asking `/api/me` at enqueue (capture must work offline), and no scoping (user A's queued receipts would upload into user B's account after an account switch - a constraint-4 violation the server cannot detect, since the create is authenticated as B).
Why: the client's own token already names its user; decoding the payload locally makes no trust decision (the server verifies every request cryptographically regardless). Items from another account are held and stated on Home, never dropped, never uploaded.

**After a capture the app returns straight to Home; the wave-4 auto-transition into the confirm queue is removed.**
Rejected: keeping the immediate confirm flow by waiting for the outbox to land the fresh captures (a network wait on the capture path is what §7.4 exists to abolish; offline it becomes an indefinite spinner or a two-mode UX), and a hybrid online-fast-path (two code paths through capture was rejected in wave 4 and is no better now).
Why: the kickoff is explicit - "on save, write to a local queue and return to Home immediately". Confirmation is one tap away (the pending badge, or the receipt's own detail screen) once the upload lands, seconds later when there is signal. Cost stated honestly: the everyday connected capture now takes one more tap to reach the confirm screen than wave 4's device-verified flow. Flagged for ratification at the gate.

**OCR failures retry up to 3 attempts (persisted on the item), then the receipt uploads with empty suggestions.**
Rejected: blocking the receipt on OCR (its safety outranks its prefill; the confirm screen already handles empty suggestions), and unlimited OCR retries (a genuinely corrupt image would head-block the queue forever).
Why: Vision failing can be transient (memory pressure) or permanent (broken bytes); a bounded retry distinguishes them cheaply, and the count persists so relaunches do not reset the meter. The fallback date is the capture day - recorded at enqueue - not the upload day, which after an offline weekend can differ.

## 2026-08-06 - Wave-4 gate review, second pass (the owner)

**Vendor is the topmost line within 15% of the tallest letter-bearing line in the top quarter, not the single tallest.**
Rejected: keeping single-tallest (the winner between same-size header lines is Vision height jitter - the same paper flipped between name and street address across two scans), running the vendor heuristic on pre-assembly fragments (the attributed cause, disproven against the artifact: the assembler had left both header lines untouched, and fragments would truncate a split name), and position-only rules (a genuinely logo-sized name below a tagline should win, and under the band rule it still does).
Why: same-size print makes "largest" a measurement artifact; "the name prints above the address" is the signal that survives jitter. Diagnosed by dumping Vision's real geometry from the stored image rather than guessing.

**Labels also match against a despaced copy of the row, fenced by letters rather than word boundaries.**
Rejected: word-boundary matching on despaced text (digits are word characters, so "Total15.25" never matches \btotal\b - found when the first attempt's test failed), and loosening the raw-text rules (despacing alone would misread "SUB TOTAL" and "TOTAL SAVINGS"; the raw word-boundary match still governs deliberate spacing).
Why: Vision split "Total" into "Tot al" on the real receipt, and a mid-word split is invisible to any within-word match; the despaced pass recovers exactly those.

**The parser fixture is Vision's real measurements verbatim, not invented geometry.**
Rejected: patching the invented fixture (it had passed while the device regressed - fabricated heights hid what Vision actually reports, which is what let the vendor regression through a fixture that did assert vendor).
Why: the fixture's job is to reproduce reality; the real dump carries all three parser lessons at once (wide-gap columns, jittered heights, a mid-word split).

**A pending receipt's detail screen carries a "Confirm this receipt" button opening the same confirm form.**
Rejected: leaving the header-badge queue as the only route (the owner's finding: tapping a pending receipt was a dead end), and a sixth screen or inline editing on detail (the confirm form already exists and §7.1's five-screen rule stands).
Why: the receipt in front of you should be confirmable where you are; the queue remains the batch route, and both paths run through the identical tested model.

## 2026-08-06 - Wave-4 gate review (the owner)

**The parser assembles printed rows from Vision fragments before any heuristic runs; `ocr_raw_text` stores the assembled rows.**
Rejected: per-heuristic cross-observation matching (the same band-pairing logic duplicated six times), and shipping raw fragments in `ocr_raw_text` (a future re-parse would inherit the unpairable-columns problem the fix exists to solve).
Why: on the first real thermal receipt, "Subtotal"/"13.50" and "HST"/"1.76" were separate observations across a wide gap - unmatchable by any within-one-string heuristic - while every contiguous field parsed; merging fragments whose vertical centers sit within half the taller fragment's height, ordered left to right, makes the §7.3 heuristics see what the paper shows. Stated limit: validated against one sample; the accuracy table re-checks it (spec §7.3 note).

**The queue's done screen appears only when the sitting handled more than one receipt or set one aside; a single confirm returns straight to Home.**
Rejected: the wave-4 shape (a "Queue clear" screen after every queue run - a success modal on the everyday single-capture path, which §10A.1 forbids; the owner's finding), and dropping the summary entirely (a worked-down batch and set-asides genuinely have something to say).
Why: the recap earns a screen only when there is something to recap.

**Confirm-screen and Home layout: the business/personal row keeps default list insets; the capture button's label is an explicit HStack.**
Rejected: zero row insets under the choice buttons (put their rounded strokes on the row's clip bounds, cutting them flat - The owner's finding), and `Label` for the capture button (inside a `List`, `Label` reserves a leading icon column and renders left-shifted).
Why: both were found on device; the full-bleed zero-inset treatment remains only on the image row, which has no strokes to clip.

**The ten-receipt accuracy session is waived; the per-field table accrues through real use.**
Rejected: blocking the gate on a staged capture session.
Why: the owner's call at the gate - `parse-accuracy` reads every confirmed receipt with a suggestion record, so ordinary use produces the same table with better variety; the number remains the §7.3 trigger data either way.

## 2026-08-06 - Wave 4

**Integration tests run against `kept_test` (TEST_DATABASE_URL), and the setup refuses a config that resolves to the dev database.**
Rejected: the shared dev database (the wave-3 "known tradeoff", corrected by the wave-4 kickoff), and comparing raw URL strings.
Why: `npm test` emptied every table, destroying the signed-in device user before each hand-tested wave; the guard compares host, port, and database name so differing credentials cannot disguise the same database, and a unit test proves the refusal.

**`total_cents` and `is_business` are nullable while `pending`; a CHECK constraint plus route validation make confirmed rows complete.**
Rejected: local drafts confirmed before any create (loses a sixty-receipt backlog scan to an app kill, contradicts §6A's "each becomes its own pending receipt"), and fabricated fallbacks (a guessed total is tax-data corruption; a defaulted `is_business` is the exact thing §5.2 forbids).
Why: batch mode's pending rows must be able to state what the parser could not read and what no human has chosen; constraints 2 and 3 hold through `status` - pending rows never export, confirming still requires the explicit choice - and `is_business` still has no default at any layer.

**When no date parses, the client sends the capture day as the date suggestion; `purchased_at` stays NOT NULL.**
Rejected: a nullable `purchased_at` (NULLs poison the keyset row-comparison cursor, silently dropping rows from pages), and refusing to create the receipt (blocks the whole batch on its worst page).
Why: most single captures happen the day of purchase, the confirm screen presents the date amber like every suggestion, and a wrong-looking date on a backlog receipt is exactly what the queue exists to fix. Wave 7's PDF upload path has no capture-day story and needs its own answer.

**`ocr_suggestions` jsonb records the parser's output verbatim at create and is immutable; `npm run parse-accuracy` compares it with confirmed fields.**
Rejected: a hand-maintained spreadsheet (the kickoff explicitly bars it), an in-app accuracy screen (a sixth screen for a one-wave measurement), and re-running the parser over stored raw text (the heuristics need line positions, which raw text does not keep).
Why: confirming receipts is the recording - the report reads suggestions against what the human went on to save, prints per-field accuracy plus every correction, and refuses when the real user is missing or ambiguous, in the db:claim mould. Stated limit: a wrong suggestion the human accepted counts as correct, because the confirmed value is the only truth available.

**Scanned pages are created as pending receipts immediately, then confirmed via a queue over server-side pending rows; single capture is a batch of one.**
Rejected: two code paths (immediate confirm for single capture, queue for batches).
Why: one path means the scan is durable server-side the moment it lands - abandoning the confirm queue loses nothing - and a batch scanned now and a backlog pending from last week are worked down by the same queue (§6A.3). Until the wave-5 outbox, a mid-batch network failure stops at the failing page with retry; pages already saved stay saved.

**A 409 `duplicate_image` during batch save counts as saved and the batch continues.**
Rejected: surfacing it as a failure.
Why: byte-identical bytes already attached to one of the user's receipts means the receipt exists - the common cause is a retry after a create whose response was lost, and failing the batch for it would punish recovery.

**Amber marks prefilled suggestions only; focusing or editing a field clears it permanently; the date is always amber initially.**
Rejected: marking absent fields amber (an absence is a stated fact, not a suggestion to review), and clearing only on edit (a correct suggestion would never clear).
Why: §10A.1's design - the screen starts loud and goes quiet as the person works down it; the date is always prefilled (parsed or capture-day fallback), so it always starts amber.

**The confirm queue's "Later" sets a receipt aside client-side for the sitting; nothing is written server-side.**
Rejected: a server-side snooze state.
Why: the receipt simply stays pending - the §5.2a badge keeps nagging, which is the design - and the queue just stops re-offering it until reopened.

## 2026-08-05 - Wave-3 gate review (the owner)

**`GET /api/receipts` returns `pendingCount`; the iOS 200-row probe is deleted.**
Rejected: a dedicated count endpoint (more API surface for one integer), and keeping the probe (honest but heavy, and it saturates at "200+" exactly when the backlog is largest).
Why: the badge's number rides the response both clients already fetch; it is user-wide and filter-independent because the badge means "receipts awaiting confirmation", not "pending rows on this page".

**Local object storage is MinIO in docker-compose, behind the real S3-compatible adapter.**
Rejected: a filesystem stub (does not exercise the presigned path, which is the part that will actually break), and deferring storage to deployment (wave 4's capture flow cannot run against a server that cannot store).
Why: one adapter serves MinIO locally and R2 in deployment; the dev default auto-creates its bucket so a clean checkout serves images with no ceremony, and `STORAGE_*` env repoints it (`npm run storage:init` creates the bucket for custom endpoints, e.g. the Mac's .local name so a phone can reach presigned URLs).

**Presigned PUT URLs sign the content-type header.**
Rejected: the SDK default (only `host` is signed), under which the upload-url schema's jpeg/png/pdf restriction was decorative - any bytes under any declared type would store.
Why: found by the integration test asserting a mismatched PUT fails; the signature now binds the PUT to the type the client declared and the server validated.

**The device-test reassignment SQL became `npm run db:claim`.**
Rejected: leaving it as a documented psql snippet in the gate report.
Why: it is dev tooling that will run every time a fresh device user needs data; the script refuses loudly when the real user is missing or ambiguous, and moves receipts and their denormalized image rows in one transaction.

**iOS: ReceiptListModel reaches the API only through GuardedReceiptLoader.**
Rejected: the wave-3 shape - a generation counter captured and re-checked by convention at every await (my own gate report named it the weakest code: nothing enforced the discipline on future awaits).
Why: the model holds no raw API reference, so a bare unguarded await is unrepresentable; every response arrives as an Outcome whose `.superseded` case the compiler forces callers to handle, and waves 4-5 add more async to exactly this class.

**`npm run dev` loads `.env.local` via node --env-file, creating the file if absent.**
Rejected: relying on shell-sourced environment (the wave-0 status quo; nothing loaded the file the docs told the owner to fill).
Why: found during device verification when the server died mid-run - 110 tests were green while the real entry point was unrunnable from a clean checkout, because tests inject config and never execute src/index.ts.

**Standing rule (framework guardrail 7, mirrored in CLAUDE.md): every gate starts the real server the real way and lands one real request.**
Rejected: treating a green dependency-injected suite as evidence the system starts.
Why: injection discipline makes the entry point structurally untested - the better the tests, the bigger the blind spot - so gate closure now requires the production start command, from a clean checkout, and one real response, recorded in the gate report.

## 2026-08-05 - Wave 3

**The Xcode project file is hand-written using filesystem-synchronized groups (Xcode 16+ format).**
Rejected: XcodeGen or Tuist (a new tool dependency, and the kickoff bars global installs), and the classic pbxproj that lists every file (rots on every file add, a standing merge hazard).
Why: synchronized root groups make the on-disk folders the source of truth, so adding a Swift file never touches the project file again.

**Swift 5 language mode, not Swift 6 strict concurrency.**
Rejected: SWIFT_VERSION = 6.
Why: the codebase is a teaching text (§10.1) and strict concurrency's annotation ceremony would obscure the code it decorates; async/await and @MainActor isolation are still used throughout, so the migration later is additive, not corrective.

**Models depend on a KeptAPI protocol; APIClient is its one production implementation.**
Rejected: view models on the concrete APIClient (every model test would build HTTP responses), and a client with per-endpoint request/decode logic (the kickoff's call-site-per-endpoint ban).
Why: transport-level behaviour (token attachment, error mapping, decoding) is proven once in APIClientTests against a stubbed transport; model tests script the protocol and stay about model decisions.

**Session state is one enum (signedOut / signingIn / signedIn); a 401 on any authenticated call and a missing keychain token both funnel into the same rejected-session path.**
Rejected: boolean flags, and treating sign-in's own 401 (a rejected Apple identity token) as a session death.
Why: the two flavours of 401 mean different things - one ends a session, the other fails a sign-in attempt - and conflating them would tear down nothing on a failed sign-in yet show the wrong message.

**Session token in the keychain as a generic password with kSecAttrAccessibleWhenUnlocked.**
Rejected: UserDefaults (barred by the kickoff - a plaintext plist in unencrypted backups), and AfterFirstUnlock accessibility (my first choice, reversed by the reviewer pass: loosening a security posture for the wave-5 background outbox before it exists is speculative generality applied to security).
Why: WhenUnlocked is the strictest class the app's current foreground-only reads allow; the save path re-asserts accessibility on update, so wave 5 can widen it with one constant and existing installs migrate on their next save.

**Pending count comes from a probe query (status=pending, limit 200) and is typed exact / atLeast / unknown.**
Rejected: counting pending rows in loaded pages only (a silent undercount, the error-masking pattern), adding a server count endpoint this wave (server changes are out of wave-3 scope; flagged in the gate report instead), and coupling the probe to the list fetch (my first shape, reversed by the reviewer pass: a failed badge count was taking down a successfully loaded list).
Why: the server has no count endpoint; one maximum-size page gives an exact count up to 200, an honest "200+" beyond, and a stated "unavailable" when the probe fails - never a quiet zero.

**purchasedAt stays a yyyy-mm-dd String in the model, formatted by one UTC-pinned formatter.**
Rejected: decoding it as Date (invents a midnight and a timezone the receipt never had, and shifts a day west of Greenwich), and a custom CalendarDate type (weight without a second consumer; reconsider when the wave-4 confirm form edits dates).
Why: the API's calendar date survives round trips untouched, and display formatting pins UTC on both parse and render.

**Server address is UserDefaults-configurable in-app, defaulting to http://localhost:3000.**
Rejected: a build-setting-only base URL (repointing a device build means rebuilding), and .env-style config (no such mechanism on iOS).
Why: the simulator reaches a local server with zero setup, and a device on the same network is a settings-sheet edit away; ATS is relaxed for local networking only, revisited at distribution.

## 2026-08-05 - Wave-2 gate review, second pass (the owner)

**`stale` also covers `running` jobs older than 30 minutes.**
Rejected: the first pass's queued-only rule (the owner's own, revised on my flag).
Why: a crash mid-run strands a poller identically to a crash before the claim; both clocks run from `created_at` since the claim follows creation within milliseconds, and 30 minutes is far above anything the byte budget permits.

**The export byte budget stands alone; `maxReceipts` removed.**
Rejected: keeping a row-count limit alongside the byte cap.
Why: row count is a worse-measured proxy for the same memory bound - ten thousand small receipts and two thousand large ones are the same problem, and only bytes see that - and it could refuse an export that would have fit, the wrong failure for the one artifact the accountant needs.

## 2026-08-05 - Cross-wave observation

**Runtime predictions have been consistently pessimistic; the real friction has landed at dependency seams every wave.**
Evidence: wave 1 predicted drizzle error-wrapping and zod message failures - all passed; the one failure was a jose API misuse in my own test.
Wave 2 predicted CSV assertion and archiver behavioral failures - all 105 tests passed first run; the two stumbles were compile-time dependency changes (archiver 8 dropping its factory API, exceljs typings predating Node's generic Buffer).
How to apply: spend prediction effort on dependency upgrade notes and API surfaces at the seams (read the changelog of a newly added or majored dependency before writing against it), and trust the tested-runtime paths more.

## 2026-08-05 - Wave-2 gate review (the owner)

**`whose` is documented as existing for accountant-side merging.**
Rejected: leaving the column's purpose unstated (it read as redundant and would eventually be "cleaned up").
Why: constancy within a file is the design - it is what makes a combined workbook of two people's exports unambiguous.

**Export zips are artifacts, not records; the exports storage prefix gets a 30-day lifecycle expiry.**
Rejected: keeping zips forever as records.
Why: receipts and images are the retained records and a zip is regenerable from them; the job row keeps its period, and past the window a job reports `expired` - re-runnable, not downloadable.

**`GET /api/export` (own jobs, newest first) added now.**
Rejected: deferring the job list to wave 7.
Why: cheapest while the export code is loaded; the web export screen needs a history list regardless.

**In-memory zip assembly is guarded by row-count and byte budgets (10 000 receipts / 256 MiB defaults) that fail the job with an actionable reason.**
Rejected: building streaming assembly.
Why: with the backlog and six-year retention a year's zip can reach gigabytes; an explicit "export a shorter period" refusal is a far better outcome than an OOM crash, and streaming is real complexity for a case a shorter period solves.

**A job stranded in `queued` past five minutes reports a computed `stale` status.**
Rejected: a background sweeper process and any new state.
Why: the only problem was a client polling forever; a computed status solves exactly that, and nothing is written back - the row stays the truthful history.

## 2026-08-05 - Wave 2

**Export jobs persist in an `export_jobs` table, not process memory.**
Rejected: an in-memory job map.
Why: a restart must not lose a running year-end export; rows also give the polling endpoint failure reasons for free.

**The export request is `{fiscalYearEndingIn}` XOR `{periodStart, periodEnd}`.**
Rejected: fiscal-only (blocks the §12 quarterly affordance) and range-only (pushes the fiscal derivation to clients, against §5.1's derive-at-request-time rule).
Why: both spec statements are satisfied, and the range shape is the seam a quarterly picker plugs into.

**Zip label: the calendar year when the period is exactly Jan 1 to Dec 31, otherwise the explicit range.**
Rejected: always labelling with the period's end year.
Why: calling a Mar-31 fiscal year "Receipts-2026" would mislabel nine months of 2025; a range names itself honestly.

**XLSX money cells are numeric with a `0.00` format; CSV money is a decimal string; both derive from integer cents via string assembly.**
Rejected: string money in the XLSX (does not sum in Excel) and cents÷100 floating-point division.
Why: the accountant gets cells that behave like money while no value in the pipeline ever passes through a float.

**A missing image fails the export loudly; the reason is recorded on the job.**
Rejected: skipping the row or shipping the zip without the file.
Why: a silent gap in an accountant's zip is the error-masking failure mode §10 exists to prevent.

**Zip assembly is in-memory.**
Rejected: streaming to storage.
Why: legibility wins at this scale; the seam to change it is one function (`buildZip`), noted in place.

**Dependencies: archiver 8 (class API) and exceljs at runtime; adm-zip as a test-only dependency for zip inspection.**
Rejected: hand-rolling zip reading in tests.
Why: the suite must open the artifact it produced; adm-zip stays out of the runtime dependency tree.

## 2026-08-05 - Wave-1 gate review (the owner)

**Create and update handlers use explicit field maps, not spreads of the parsed body.**
Rejected: spreading the strict-schema output into the insert/update (my wave-1 shape).
Why: the spread silently drops a schema key with no matching column - an invisible failure - whereas a forgotten line in an explicit map is at least visible in review; §10's rule is explicit beats concise.

**`noUncheckedIndexedAccess` enabled.**
Rejected: leaving it off with per-site care.
Why: every `rows[0]` was typed as always-present; enabling it now, while the codebase is small, converts a class of latent 500s into compile errors.

**`GET /api/receipts` is paged: keyset cursor on `(purchased_at, created_at, id)` descending, limit default 50 / max 200.**
Rejected: unbounded lists ("fine at three users") and offset pagination.
Why: the §6A backlog import makes lists large on day one, and keyset cursors stay stable under concurrent inserts, which is exactly the backlog-import condition.

**`users.token_version`, carried as the JWT `tv` claim, checked on every verify.**
Rejected: unrevocable 30-day JWTs.
Why: bumping the integer revokes all of a user's sessions at the cost of one indexed read per request; tokens without the claim are invalid by construction.

## 2026-08-05 - Wave 1

**`users.display_name` becomes nullable.**
Rejected: NOT NULL with an empty-string default at sign-in.
Why: Apple provides the person's name only on first authorization, only client-side, and possibly not at all; an empty-string default is exactly the silently-defaulted-value anti-pattern the quality rules ban.

**`receipt_images` gains `deleted_at`; the `(user_id, sha256)` unique becomes partial (`WHERE deleted_at IS NULL`); DELETE stamps image rows with the receipt in one transaction.**
Rejected: hard-deleting image rows on receipt delete (breaks retention), and keeping the full unique (delete-then-recapture of the same file would 409 forever against an invisible row).
Why: surfaced by the wave-1 reviewer pass; the partial index keeps rows for CRA retention while freeing the duplicate slot.

**Validation with zod, JWTs with jose; no other new runtime dependencies.**
Rejected: hand-rolled validators (verbose, and a second validation style would inevitably appear) and hand-rolled JWT handling (signature verification is not code to write oneself).
Why: both are the boring standard choices; jose's remote JWK set also handles Apple's key rotation, which the kickoff explicitly required.

**The Apple test bypass is injection-only.**
Rejected: an env var or config flag selecting a fake verifier.
Why: the kickoff demands the bypass be structurally impossible in production; `createApp` takes a verifier as a value, the production entrypoint always constructs the real one, and no configuration value can swap them - tests build their own app with a fake.

**Export routes answer 501 until wave 2.**
Rejected: an in-memory job store now.
Why: §6 specifies job id + polling but §5 defines no job store; that design decision belongs to wave 2 (an `export_jobs` table is the likely answer, since losing job state on restart mid-year-end-export is the wrong failure mode), and an honest 501 keeps the auth surface final without pretending.

**`GET /api/receipts` gained a `status` filter beyond §6's list.**
Rejected: leaving the confirm queue to client-side filtering of full lists.
Why: §6A's "next unconfirmed receipt" queue on both clients needs the server to answer "pending only" directly.

**Object keys are prefixed `{userId}/` and creates reject keys outside the session user's prefix.**
Rejected: accepting any object key (would let a receipt point at, and later presign a download for, another user's stored object).
Why: closes the one path where client-supplied input could cross the isolation boundary.

## 2026-08-05 - Wave-0 gate decisions (applied at start of wave 1)

**`receipts.deleted_at timestamptz NULL` added for soft delete.**
Rejected: hard delete, and a `deleted` enum status.
Why: §6 specifies a soft-delete endpoint and §10B makes retention (CRA six years) non-deferrable, but the wave-0 schema had no column to express it; a nullable timestamp records when, keeps `status` about the confirm workflow, and non-null rows are excluded from every list, count, and export.

**`receipt_images.user_id uuid NOT NULL` (FK to users) denormalized; unique `(user_id, sha256)` replaces `(receipt_id, sha256)`.**
Rejected: the original per-receipt unique, and enforcing user-scoped uniqueness through a join or application code.
Why: the per-receipt constraint only prevented the same image twice on one receipt, which is nobody's failure mode; a constraint that needs a join is not a constraint.
Scope honesty (recorded in the spec): the hash catches re-uploaded identical files, never a re-scanned paper receipt; near-duplicate detection on date+vendor+total is v2.

**`receipts.status` gains `DEFAULT 'pending'`.**
Rejected: no default (the wave-0 as-written reading).
Why: unlike `is_business`, status is a system state rather than a concealed human choice, and defaulting to `pending` is fail-closed because pending rows never export.

**`updated_at` is maintained by a Postgres trigger.**
Rejected: handler code and ORM hooks (`$onUpdate`).
Why: a field whose freshness depends on every future handler remembering it silently rots.

**`receipts.vendor` becomes nullable.**
Rejected: NOT NULL with a placeholder string.
Why: an illegible vendor is a real outcome; a forced placeholder corrupts the field for everyone reading it later.
