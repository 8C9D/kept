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
 * that fires on every receipt is wallpaper rather than signal).
 */
export interface MergedAmountSuggestion extends MergedSuggestion<number> {
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
  totalCents: MergedSuggestion<number>;
  hstCents: MergedAmountSuggestion;
  subtotalCents: MergedSuggestion<number>;
  /**
   * Merged heuristic-only, like the other amounts (2026-08-28 tip/other-fees
   * split of the retired `other_tax_cents`). There is deliberately no
   * `otherFeesCents` suggestion here - "other fees" is a residual with no
   * consistent printed label, so no heuristic can match it. It is a human-
   * entered field and never starts amber.
   */
  tipCents: MergedSuggestion<number>;
}

export type ReceiptStatus = "pending" | "confirmed";

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
}

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
}

/**
 * POST /api/events - the behavioural-telemetry vocabulary
 * (server/src/domain/userEvents.ts, EVENT_ACTIONS/EVENT_FIELDS/
 * EVENT_CLIENTS; server/src/http/schemas.ts, `userEventSchema`/
 * `postEventsSchema`). Transcribed as literal unions rather than `string`,
 * same reasoning as everywhere else in this file: an action or field name
 * outside this list should fail to compile here, long before src/events.ts
 * could send it and have the server's own `z.enum` refuse it as a strict
 * 400. This client (2026-08-28) uses a subset of the full vocabulary - the
 * rest (capture_*, image_*, confirm_deferred, account_deleted) names
 * actions this client cannot honestly produce (no camera, no native
 * re-auth) or was not asked to instrument yet.
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
