/**
 * The API's shapes, transcribed from the server's own response builders -
 * `receiptResponse` (server/src/routes/receipts.ts), `jobResponse`
 * (exports.ts), `profileOf` (me.ts), `MergedSuggestions`
 * (domain/mergedSuggestions.ts). The server is the authority (spec §4.1a:
 * this client is a second view, not a second implementation); these types
 * exist so the compiler holds this client to what the server said.
 */

export type SuggestionSource = "heuristic" | "llm" | "both";

export interface MergedSuggestion<T> {
  value: T | null;
  source: SuggestionSource | null;
}

export interface MergedDateSuggestion extends MergedSuggestion<string> {
  disagreement: boolean;
}

/**
 * An amount the server's arithmetic rule can decline to serve (2026-09-01;
 * server/src/domain/suggestedAmounts.ts carries the rule and its reasoning).
 * `withheld: true` is NOT the same as a plain absence: `{value: null,
 * source: null}` means neither parser found anything, while this means one
 * of them found something the server declines to offer because the set of
 * amounts it belongs to is impossible - a total below the sum of its own
 * parts, the $218.94 Costco slip stored as $8.50 that the diagnosis over
 * 136 production receipts found. The raw values are deliberately not sent,
 * so there is nothing for a client to second-guess the rule with.
 *
 * Optional here where the server declares it required: older fixtures and
 * any response built before this date carry no such key, and an absent flag
 * reads exactly as `false` does at every site that consumes it. The two
 * fields it can ever be true for are the server's own `WithheldAmountField`
 * pair - total and subtotal.
 */
export interface WithholdableAmountSuggestion extends MergedSuggestion<number> {
  withheld?: boolean;
}

/**
 * An amount suggestion that also carries the disagreement flag, mirroring
 * the server's own `MergedAmountSuggestion` (domain/mergedSuggestions.ts).
 * The served `value`/`source` still follow the plain money rule - heuristic
 * or absent, never the LLM's - and `disagreement` is a read-only side
 * channel: true only when both parsers produced a value for this amount and
 * it differs from the heuristic's served one. Introduced for HST
 * (2026-08-28): it is the input tax credit, the one amount with a direct
 * tax consequence, and exactly the field a split-HST receipt corrupts - a
 * heuristic that reads one component of a printed 5%+8% split produces a
 * wrong-but-plausible number the arithmetic check cannot catch when the
 * subtotal is also missing. Not extended to total or subtotal in this pass
 * (server's own comment: every extra inline note costs attention, and one
 * that fires on every receipt is wallpaper rather than signal) - those two
 * gained the withholding flag above instead, which is a different question.
 */
export interface MergedAmountSuggestion extends WithholdableAmountSuggestion {
  disagreement: boolean;
}

/**
 * The served merge still carries a `vendorTaxNumber` key - a transitional
 * shim for the shipped iOS 1.0 (1) build, which decodes it non-optionally
 * (2026-08-26 contract §2). It is served as an absence and this client does
 * not type it: an extra JSON key is harmless here.
 */
export interface MergedSuggestions {
  vendor: MergedSuggestion<string>;
  purchasedAt: MergedDateSuggestion;
  /**
   * Total and subtotal carry the withholding flag as of 2026-09-01 - not a
   * disagreement flag (the August note above on why that stayed HST-only
   * still stands) but the arithmetic rule's, because these are the only two
   * fields it can ever suppress.
   */
  totalCents: WithholdableAmountSuggestion;
  hstCents: MergedAmountSuggestion;
  subtotalCents: WithholdableAmountSuggestion;
  /**
   * Merged heuristic-only, like the other amounts (2026-08-28 tip/other-fees
   * split of the retired `other_tax_cents`).
   */
  tipCents: MergedSuggestion<number>;
  /**
   * Added 2026-09-01, and the reversal of a sentence that stood here since
   * August: "there is deliberately no `otherFeesCents` suggestion - no
   * heuristic can match a residual with no consistent printed label." That
   * is still true of the HEURISTIC, and other fees is still absent on every
   * photographed receipt. What changed is the other parser: on a `pdf-text`
   * receipt, where the text layer has no OCR noise in it, the merge falls
   * through to the LLM for money, so this key can carry a value there. It
   * gets no exception for being new - same merge rule as every other amount.
   *
   * Optional here for the same reason `withheld` is: a response built before
   * this date has no such key, and an absent suggestion and an absent key
   * mean the same thing to every reader of it.
   */
  otherFeesCents?: MergedSuggestion<number>;
  /**
   * Added 2026-09-01, merged like `vendor` - LLM-preferred, heuristic
   * fallthrough. Not because a card brand resembles a vendor name, but
   * because the on-device parser has no rule for it at all and never will:
   * it is printed on ~80% of slips and was stored on 0 of 130 production
   * receipts, and reading "MASTERCARD" off a slip is a reading task rather
   * than a pattern match. Optional for the same reason as the key above.
   */
  paymentMethod?: MergedSuggestion<string>;
}

export type ReceiptStatus = "pending" | "confirmed";

/**
 * Which extractor produced a receipt's `ocrRawText` (2026-09-01).
 * `vision` is the iOS client's on-device text recognizer; `pdf-text` is
 * this client reading an emailed PDF's own text layer (`pdfText.ts`).
 * Null means no text was ever supplied - a web upload of a photograph, or
 * a scanned PDF with nothing to read.
 *
 * It matters to the server, not just as provenance: a `pdf-text` receipt's
 * text has no OCR noise in it, so the merge may serve the LLM's money
 * amounts where a `vision` receipt's would be withheld for want of a
 * heuristic. This client renders what it is served either way (§7.1) - it
 * does not branch on this field - but it does have to SEND it, because
 * nothing downstream can infer it.
 */
export type OcrSource = "vision" | "pdf-text";

/**
 * The fields a person has reviewed on a still-pending receipt (2026-09-01,
 * the "save for later" contract). Names are the server's own column-shaped
 * field names, not this client's draft keys - `ReceiptForm.tsx` owns the
 * one mapping between the two.
 *
 * What it buys: a pending receipt can now be half-finished on purpose. The
 * fields in this set are the human's, so the server stops serving a
 * `suggestions.<field>` for them and this client stops tinting them amber -
 * a receipt whose vendor and total were typed last Tuesday no longer
 * re-offers the parser's guesses for them next time it is opened. It is a
 * record of what was LOOKED at, never a confirmation: constraint 2 still
 * requires `status = 'confirmed'` before a receipt can leave the queue or
 * enter an export.
 */
export const REVIEWED_FIELDS = [
  "purchasedAt",
  "vendor",
  "subtotalCents",
  "hstCents",
  "tipCents",
  "otherFeesCents",
  "totalCents",
  "category",
  "paymentMethod",
  "notes",
] as const;
export type ReviewedField = (typeof REVIEWED_FIELDS)[number];

export interface Receipt {
  id: string;
  purchasedAt: string;
  capturedAt: string;
  vendor: string | null;
  subtotalCents: number | null;
  hstCents: number | null;
  /**
   * Gratuity (2026-08-28: reinstated as its own field, split out of the
   * `other_tax_cents` lump that was removed 2026-08-26 - see
   * docs/DECISIONS.md that date, "First-use product feedback").
   */
  tipCents: number | null;
  /**
   * Every non-HST charge that is neither subtotal nor tip - delivery,
   * service charges, deposits, environmental levies, a foreign receipt's
   * non-HST tax (2026-08-28, same split). Absent means "no such line on
   * this receipt", exactly like the other three amount fields.
   */
  otherFeesCents: number | null;
  totalCents: number | null;
  currency: string;
  category: string | null;
  paymentMethod: string | null;
  notes: string | null;
  status: ReceiptStatus;
  suggestions: MergedSuggestions | null;
  /**
   * The fields a human has already looked at on this receipt (2026-09-01).
   * Served on every receipt, empty for one nobody has reviewed a field of;
   * on a pending receipt the server ALSO omits `suggestions.<field>` for
   * each name in here, so the two agree by construction rather than by this
   * client remembering to prefer one over the other.
   */
  reviewedFields: ReviewedField[];
  ocrSource: OcrSource | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptImage {
  page: number;
  downloadUrl: string;
}

export interface ReceiptDetail extends Receipt {
  ocrRawText: string | null;
  images: ReceiptImage[];
}

/**
 * What POST /api/receipts/:id/images (add a page) and
 * PUT /api/receipts/:id/images/:page (replace a page) both take -
 * `receiptImageSchema` (server/src/http/schemas.ts), the exact shape
 * POST /api/receipts/upload-url issues and the create route's own `image`
 * key already uses. Proposal #6, 2026-08-28.
 */
export interface ReceiptImageWrite {
  objectKey: string;
  sha256: string;
}

/**
 * What both of those routes return (server's `imageResponse`,
 * routes/receipts.ts) - richer than the plain `ReceiptImage` the detail
 * route serves (an `id` and `createdAt` neither the list nor the detail
 * response carries), and deliberately not merged into it: the receipt
 * detail screen refreshes from GET /api/receipts/:id after either write
 * rather than hand-mutating this response into its images array, since the
 * server - not this client - is what assigns a new page's number.
 */
export interface ReceiptImageWriteResult {
  id: string;
  page: number;
  downloadUrl: string;
  createdAt: string;
}

export interface ReceiptList {
  receipts: Receipt[];
  nextCursor: string | null;
  pendingCount: number;
}

export type ExportStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "expired"
  | "stale";

export interface ExportJob {
  id: string;
  status: ExportStatus;
  periodStart: string;
  periodEnd: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  downloadUrl: string | null;
}

export interface Profile {
  id: string;
  displayName: string | null;
  email: string | null;
  fiscalYearEndMonth: number;
  fiscalYearEndDay: number;
}

export interface SignInResponse {
  token: string;
  user: { id: string; displayName: string | null; email: string | null };
}

/**
 * The fields a PATCH /api/receipts/:id accepts (updateReceiptSchema).
 * A confirmed receipt takes the same patch a pending one does - editing
 * after confirmation is the point, not an exception.
 */
export interface ReceiptPatch {
  purchasedAt?: string;
  vendor?: string | null;
  subtotalCents?: number | null;
  hstCents?: number | null;
  tipCents?: number | null;
  otherFeesCents?: number | null;
  totalCents?: number | null;
  currency?: string;
  category?: string | null;
  paymentMethod?: string | null;
  notes?: string | null;
  status?: ReceiptStatus;
  /**
   * Replaces the stored set outright - not a union the server computes
   * (2026-09-01 contract). The sender is the screen that knows what was
   * looked at, so it sends the whole set every time:
   * `reviewedFieldsForSave` (ReceiptForm.tsx) is the one place that builds
   * it, from the receipt's existing set unioned with this editing
   * session's touched fields.
   *
   * A PATCH carrying this and NO `status` is the "save for later" write -
   * the receipt stays pending and keeps its place in the queue.
   */
  reviewedFields?: ReviewedField[];
}

/**
 * The three reusable-value lists, as the manage-values routes name them in
 * their path (2026-09-01): `PATCH /api/receipts/options/:field` and
 * `DELETE /api/receipts/options/:field`. Singular, unlike the plural keys
 * of `ReceiptOptions` below, because the path names one field of a receipt
 * rather than one list.
 */
export type OptionField = "vendor" | "category" | "paymentMethod";

/** GET /api/receipts sort keys; the server defaults to purchasedAt/desc. */
export type ReceiptSort = "purchasedAt" | "capturedAt" | "total" | "vendor";
export type SortOrder = "asc" | "desc";

export interface ListFilters {
  from?: string | undefined;
  to?: string | undefined;
  status?: ReceiptStatus | undefined;
  q?: string | undefined;
  /** Exact-match over the stored free text, paired with ReceiptOptions. */
  category?: string | undefined;
  paymentMethod?: string | undefined;
  sort?: ReceiptSort | undefined;
  order?: SortOrder | undefined;
}

/**
 * GET /api/receipts/options: the signed-in user's own past category,
 * payment-method and vendor values, most recently used first. Suggestions
 * for reuse - every field stays free text, and none of the three lists is
 * a taxonomy. `vendors` added 2026-08-28, same derivation and ordering.
 */
export interface ReceiptOptions {
  categories: string[];
  paymentMethods: string[];
  vendors: string[];
  /**
   * Proposal #2 (2026-08-28, approved): per vendor, the category and
   * payment method to prefill from that vendor's most recent CONFIRMED
   * receipt - keyed by the exact vendor string, no normalization, same
   * free-text-in-free-text-out rule as the three lists above. The server's
   * own comment (`vendorDefaultCandidates`, routes/receipts.ts) is why this
   * is confirmed-only where `vendors` above counts pending receipts too: a
   * default PREFILLS a field on a *different* receipt without a human
   * having looked at that one yet, so sourcing it from an unreviewed
   * pending guess would risk compounding one unconfirmed value into a
   * second one. Category and payment are defensible to default this way
   * where an amount never would be (`deriveMissingAmount`'s own doc
   * comment): category is free text with no tax consequence - a wrong
   * default costs a mislabelled row an accountant re-reads, never a wrong
   * claim.
   *
   * A vendor absent from this map has no default to offer - omitted rather
   * than served as `{category: null, paymentMethod: null}`, which a client
   * would otherwise have to learn is not one.
   */
  vendorDefaults: Record<
    string,
    { category: string | null; paymentMethod: string | null }
  >;
}

/**
 * GET /api/receipts/summary (proposal #3, 2026-08-28, approved): the same
 * running-totals question a single receipt's arithmetic check answers,
 * asked over a whole filtered list. `confirmed` is the count and summed
 * money fields over confirmed rows only; `pendingCount` is that same
 * filter's pending rows, counted and nothing else - two numbers, never one
 * blended figure, so a client cannot fold a pending row's amount into a
 * total that reads as a finished claim (spec: nothing pending may appear in
 * an export, and a summary that disagreed with the export sitting next to
 * it would be exactly the failure the proposal names by name).
 */
export interface ReceiptSummary {
  confirmed: {
    count: number;
    subtotalCents: number;
    hstCents: number;
    tipCents: number;
    otherFeesCents: number;
    totalCents: number;
  };
  pendingCount: number;
}

/**
 * POST /api/events - the behavioural-telemetry vocabulary
 * (server/src/domain/userEvents.ts, EVENT_ACTIONS/EVENT_FIELDS/
 * EVENT_CLIENTS; server/src/http/schemas.ts, `userEventSchema`/
 * `postEventsSchema`). Transcribed as literal unions rather than `string`,
 * same reasoning as everywhere else in this file: an action or field name
 * outside this list should fail to compile here, long before src/events.ts
 * could send it and have the server's own `z.enum` refuse it as a strict
 * 400. This client uses a subset of the full vocabulary - the rest
 * (capture_*, image_*, account_deleted) names actions it cannot honestly
 * produce (no camera, no native re-auth) or was not asked to instrument
 * yet. `confirm_deferred` joined that subset on 2026-09-01 with "save for
 * later", which is exactly what iOS's confirm screen means by it
 * (ConfirmReceiptView.logDeferralIfConfirming): a pending receipt left
 * unconfirmed on purpose.
 */
export const EVENT_ACTIONS = [
  "capture_started",
  "capture_completed",
  "capture_cancelled",
  "confirm_opened",
  "confirm_saved",
  "confirm_deferred",
  "field_edited",
  "suggestion_accepted",
  "suggestion_overridden",
  "receipt_viewed",
  "receipt_edited",
  "receipt_deleted",
  "list_searched",
  "list_filtered",
  "list_sorted",
  "image_opened",
  "image_zoomed",
  "option_reused",
  "export_requested",
  "export_downloaded",
  "export_failed",
  "sign_in",
  "sign_out",
  "account_deleted",
] as const;
export type EventAction = (typeof EVENT_ACTIONS)[number];

/** Which receipt field an action was about - shared across every
 * field-scoped action, not owned by one of them. */
export const EVENT_FIELDS = [
  "total",
  "purchasedAt",
  "vendor",
  "hst",
  "subtotal",
  "tip",
  "otherFees",
  "category",
  "paymentMethod",
  "notes",
] as const;
export type EventField = (typeof EVENT_FIELDS)[number];

/** Which client produced the event - this one always sends "web". */
export const EVENT_CLIENTS = ["ios", "web"] as const;
export type EventClient = (typeof EVENT_CLIENTS)[number];

/**
 * One row of the batch POST /api/events sends. `userId` is named nowhere
 * here, on purpose, mirroring the server schema's own comment: the session
 * supplies it, never the body (CLAUDE.md, "An endpoint accepting a user id
 * as input is a bug"). There is likewise deliberately no payload/meta/
 * properties key - the privacy rule this whole feature turns on
 * (domain/userEvents.ts: "NOTHING here ever carries a field VALUE") is a
 * structural guarantee of this interface having no such field, not a
 * convention this client has to remember to keep; src/events.test.ts pins
 * it with a runtime assertion over what actually gets sent, not just this
 * type.
 */
export interface UserEvent {
  action: EventAction;
  /** ISO 8601 with an offset (`Date.prototype.toISOString()`'s "Z" counts) -
   * server/src/http/schemas.ts's `eventOccurredAt` requires one. */
  occurredAt: string;
  client: EventClient;
  appVersion?: string;
  field?: EventField;
  receiptId?: string;
  durationMs?: number;
  count?: number;
}

export interface PostEventsRequest {
  events: UserEvent[];
}

export interface PostEventsResponse {
  accepted: number;
}
