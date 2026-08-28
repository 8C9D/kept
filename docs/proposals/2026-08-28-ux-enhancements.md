# UX enhancements — proposed 2026-08-28, six approved and built, four still open

**Status, updated 2026-08-28 (same day, second pass):** The owner approved **#1 through #6**, and they are **built** — see each item below for where. **Nothing here is deployed**: it is uncommitted working-tree code, and migration `0008` (proposal #6) has been applied to the local database only. **#7 through #10 remain unbuilt and awaiting a decision** — nothing below has ruled on them either way.
Written alongside the 2026-08-28 product-feedback build, which implemented what the owner asked for; this is the answer to the open question in that feedback ("propose other UX enhancements worth adding"). Record of what was decided and rejected in building #1-#6: `docs/DECISIONS.md` 2026-08-28 (filed as its own entry, above the product-feedback entry). Verification: `docs/gates/product-feedback-2026-08-28.md`.

Each proposal states what it is, why it earns its place against the success test — *a receipt is captured in under a minute and never thought about again* — what it costs, and what it risks. Approved items become a `DECISIONS.md` entry and a spec amendment before any code is written, per the doc-ownership rule.

Ordered by my estimate of value per unit of work, highest first.

---

## 1 · Derive the one missing amount, as a suggestion

**Approved and built, 2026-08-28 — not deployed.** `server/src/domain/arithmetic.ts`'s `deriveMissingAmount` is the canonical rule, mirrored live on both clients (`ios/Kept/Confirm/ReceiptArithmetic.swift`, `web/src/views/ReceiptForm.tsx`'s own `deriveMissingAmount`) plus the reconciliation-split affordance below. Spec: §7.2, §10A.1. Decisions and rejections: `docs/DECISIONS.md` 2026-08-28.

**What.** On the confirm screen, when exactly one of `subtotal · hst · tip · other fees · total` is blank and the other four are filled, offer the arithmetic answer as a one-tap fill. When all five are filled but do not reconcile, offer to put the difference into tip (the usual cause on a restaurant bill) or into other fees.

**Why.** This is the direct answer to the complaint that motivated the tips field: the numbers mismatch, and the person is left doing mental arithmetic against a paper slip. It converts the advisory amber warning from "something is wrong, good luck" into "here is the number, is it right?".

**Why it does not violate constraint 2.** The derived value arrives as a suggestion in an editable field, amber until touched, exactly like an OCR value. Nothing saves without a human looking at it. The rule this must not become is auto-filling silently on save.

**Cost.** Small. The arithmetic already lives in `server/src/domain/arithmetic.ts`; this is a second function beside it and one affordance per client.

**Risk.** A person taps the fill without reading it and stores an amount the receipt does not print. Mitigation: the filled field goes amber and stays amber, and the affordance says what it is doing ("Tip = total − subtotal − HST − fees") rather than just appearing.

---

## 2 · Vendor-remembered defaults for category and payment

**Approved and built, 2026-08-28 — not deployed.** `GET /api/receipts/options`'s `vendorDefaults` key (`server/src/routes/receipts.ts`'s `vendorDefaultCandidates`), confirmed-receipts-only per the risk noted below, mirrored on both clients (`ios/Kept/Confirm/ConfirmReceiptModel.swift`'s `applyVendorDefaultIfAvailable`, `web/src/views/ReceiptForm.tsx`'s `vendorDefaultFill`). Spec: §6, §7.2. Decisions and rejections: `docs/DECISIONS.md` 2026-08-28.

**What.** When the vendor on the confirm screen matches one the user has used before, prefill category and payment method from that vendor's most recent confirmed receipt — amber, editable, dismissible.

**Why.** Category and payment are the two fields with no OCR path at all: today they are typed by hand on every single receipt. Spending is repetitive by vendor — the same coffee shop is the same category every time. This is the largest remaining chunk of the under-a-minute budget that is not already optimised.

**Cost.** Small-to-medium. The server already derives reusable option lists; this is the same query narrowed to one vendor, served on the options route or on the create response.

**Risk.** A wrong-but-plausible category is exactly the failure mode the LLM money rule exists to prevent — but a category is free text with no tax consequence, not an input tax credit. The consequence of a wrong category is a mislabelled row an accountant re-reads; the consequence of a wrong HST is a wrong claim. Different stakes, so a different rule is defensible here.

---

## 3 · Running totals for the current filter

**Approved and built, 2026-08-28 — not deployed.** `GET /api/receipts/summary` (`server/src/routes/receipts.ts`), rendered as a summary line on both clients (`ios/Kept/Screens/HomeView.swift`'s `SummaryRow`, `web/src/views/ReceiptsTable.tsx`'s `describeSummary`/`SummaryLine`). Spec: §6, §7.1, §7A. Decisions and rejections: `docs/DECISIONS.md` 2026-08-28.

**What.** A summary line above the list on both clients: count, total spent, total HST, for whatever filter is currently applied. New route `GET /api/receipts/summary` taking the same filter parameters as the list.

**Why.** The app can tell you every receipt you captured and cannot tell you what you spent. "How much HST can I claim this year" is the question the whole exercise exists to answer, and today it is answerable only by generating an export and opening a spreadsheet. On the web client, where the year-end pass happens, this is the single most useful thing that is missing.

**Cost.** Small on the server (one aggregate query, same filter builder as the list), small on each client.

**Risk.** The number invites being read as a tax figure. Copy must say it excludes pending receipts, and it must exclude them, matching the export's rule exactly — a summary that counted pending rows would disagree with the export it sits above.

---

## 4 · An action-log report, so the logging pays for itself

**Approved and built, 2026-08-28 — not deployed.** `npm run action-report` already existed (built the same day, before this file's approval); this proposal is the two cuts added on top of it (`server/src/domain/actionReport.ts`'s `parsePathBreakdown`/`editHistograms`, printed by `server/src/db/actionReport.ts`). Spec: §5. Decisions and rejections: `docs/DECISIONS.md` 2026-08-28.

**What.** `npm run action-report`: which fields get edited after being suggested, which get edited more than once in a session, how often a suggestion is accepted untouched, per field, per parse path.

**Why.** The owner's stated reason for wanting action logging is exactly this question — *a user editing the total repeatedly signals the total-extraction path is unreliable*. Logging without a reader is a table that grows. This is also the mechanism that would let the §7.3 merge rule be revisited on real evidence rather than on the n=5 sample the spec flags as provisional.

**Cost.** Small. It is a script beside `parse-accuracy`, reading the new table, with no UI at all.

**Risk.** None material. It reads a table nobody else reads.

---

## 5 · Bulk edit on the web table

**Approved and built, 2026-08-28 — not deployed, and narrower than proposed.** `web/src/bulkEdit.ts` (selection and the batch runner) plus `web/src/views/ReceiptsTable.tsx` (the UI). **Built without delete** — the risk paragraph below flagged it, and the decision was to leave it out rather than build the undelete path first; see `docs/DECISIONS.md` 2026-08-28. Spec: §7A.

**What.** Row selection with a checkbox column, then one action applied to the selection: set category, set payment method, confirm, delete.

**Why.** §7A's stated purpose for the web client is "reviewing and correcting many receipts at once", and today correcting many receipts means correcting one receipt many times. The backlog case — eighty PDFs dropped in at once, most of them the same category — is the one this was designed for and the one it currently serves worst.

**Cost.** Medium. Needs a batch PATCH route or a client-side loop over the existing one; the loop is honest at this scale and avoids a new endpoint with new failure semantics.

**Risk.** Bulk delete is the destructive one. Deletes are soft, so it is recoverable in principle, but there is no undelete UI today — either add one or leave delete out of the bulk set.

---

## 6 · Add a page to an existing receipt, and re-capture an image

**Approved and built, 2026-08-28 — not deployed.** `POST /api/receipts/:id/images` and `PUT /api/receipts/:id/images/:page` (`server/src/routes/receipts.ts`), migration `0008_receipt-images-page-partial.sql` (applied locally only), both clients' scan-then-upload screens (`ios/Kept/Screens/ReceiptImageUploadModel.swift`/`ReceiptImageUploadView.swift`, `web/src/receiptImages.ts`), and the export's `pages` column and per-page bundling. Spec: §5, §6, §7.1, §7A, §8. Decisions and rejections: `docs/DECISIONS.md` 2026-08-28.

**What.** On receipt detail, "add a page" and "replace the image".

**Why.** `receipt_images` has had a `page` column since wave 1 and nothing ever writes page 2. A hotel folio or a long restaurant bill is genuinely two pages. Separately, the documented sharp edge — a receipt whose image upload failed jams every export of its period, and the remedy is *delete the receipt and capture it again*, which loses the vendor, date, total and HST — exists only because there is no way to attach bytes to a receipt that already exists.

**Cost.** Medium. The create path's image handling is reusable; the duplicate-hash index and its delete-first ordering rule need re-reading against a new writer.

**Risk.** The `(user_id, sha256)` partial unique index is the thing to get right. Re-capturing the same paper produces different bytes and collides with nothing; re-uploading the same file collides, and the error must say so in the terms Runbook §6 already teaches.

---

## 7 · HST rate plausibility hint

**Status: unbuilt, awaiting a decision.** Not among the six the owner approved 2026-08-28; the narrow-scoping recommendation below stands unactioned.

**What.** A second advisory note beside the arithmetic one: when `hst / subtotal` is not within rounding distance of a Canadian rate (13% ON, 5% GST-only, 15% Atlantic, 0% exempt), say so inline.

**Why.** It catches the failure class the split-HST fix is about — half of a 13% split read as the whole tax reads as 5% or 8% and looks perfectly reasonable in isolation. It is free signal in the same family as the date-disagreement flag, and it needs no second parser.

**Cost.** Small.

**Risk.** Noise. A receipt with mixed taxable and zero-rated lines — a grocery bill, which is most receipts — legitimately shows an effective rate below 13%, so this would warn constantly on exactly the receipts people capture most. **My recommendation is to scope it to receipts where the effective rate is close to a component of a split (near 5% or near 8%) rather than to flag every non-13% receipt**, or to skip it.

---

## 8 · Near-duplicate detection at confirm time

**Status: unbuilt, awaiting a decision.** Not among the six the owner approved 2026-08-28.

**What.** At confirm, if a live receipt already exists with the same vendor, same date and same total, say so and offer to open it.

**Why.** Already named in §11 as deferred to v2, with the reasoning that the sha256 constraint cannot catch a re-photographed paper. The failure it prevents is a duplicated expense claim, which is a real problem in an accountant's hands rather than a cosmetic one. The backlog pass — where the same receipt genuinely does get scanned twice — is when it bites.

**Cost.** Small: one indexed query at confirm time.

**Risk.** False positives are real and cheap to dismiss (two identical coffees on one day). It must warn, never block.

---

## 9 · Swipe actions and month grouping on the iOS list

**Status: unbuilt, awaiting a decision.** Not among the six the owner approved 2026-08-28.

**What.** Swipe a row to delete or to confirm; sticky month headers down the list.

**Why.** Ordinary iOS table affordances that the list does not have. With delete arriving on iOS in this build, swipe-to-delete is the gesture people will try first.

**Cost.** Small.

**Risk.** Swipe-to-delete on a tax record wants an undo. The delete is soft server-side, so an undo is a PATCH away, but nothing exposes it today.

---

## 10 · Export period presets

**Status: unbuilt, awaiting a decision.** Not among the six the owner approved 2026-08-28.

**What.** On the new iOS export screen and on the web one: "Last fiscal year", "This fiscal year to date", "Q1–Q4" alongside the explicit date range.

**Why.** §8 already derives the fiscal period server-side and §12 names a quarterly picker as the seam the explicit-range body exists for. The API needs nothing; this is UI over a capability that already shipped.

**Cost.** Small.

**Risk.** None material. A preset that computes the wrong boundary is the one thing to test, against a non-December fiscal year end.

---

## Deliberately not proposed

- **Auto-confirm on high-confidence extraction.** §3's design note forbids it by name, and it is the one "improvement" that would destroy the guarantee the whole app rests on.
- **A category taxonomy, CRA line mapping, or auto-categorization.** §2 non-goal, and the vendor-defaults proposal above is the version of this idea that does not become a vocabulary.
- **Sending the receipt image to the model.** The image never leaving the phone is a stated ruling (§7.3), not an implementation detail, and it is also what keeps the privacy label as declared.
- **Email ingestion.** §11, v2, unchanged.
