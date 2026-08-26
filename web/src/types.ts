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
 * The served merge still carries a `vendorTaxNumber` key - a transitional
 * shim for the shipped iOS 1.0 (1) build, which decodes it non-optionally
 * (2026-08-26 contract §2). It is served as an absence and this client does
 * not type it: an extra JSON key is harmless here.
 */
export interface MergedSuggestions {
  vendor: MergedSuggestion<string>;
  purchasedAt: MergedDateSuggestion;
  totalCents: MergedSuggestion<number>;
  hstCents: MergedSuggestion<number>;
  subtotalCents: MergedSuggestion<number>;
}

export type ReceiptStatus = "pending" | "confirmed";

export interface Receipt {
  id: string;
  purchasedAt: string;
  capturedAt: string;
  vendor: string | null;
  subtotalCents: number | null;
  hstCents: number | null;
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
 * GET /api/receipts/options: the signed-in user's own past category and
 * payment-method values, most recently used first. Suggestions for reuse -
 * both fields stay free text, and neither list is a taxonomy.
 */
export interface ReceiptOptions {
  categories: string[];
  paymentMethods: string[];
}
