import type {
  ExportJob,
  ListFilters,
  OcrSource,
  OptionField,
  Profile,
  ReceiptDetail,
  ReceiptImageWrite,
  ReceiptImageWriteResult,
  ReceiptList,
  ReceiptOptions,
  ReceiptPatch,
  ReceiptSummary,
  Receipt,
  ReviewedField,
  SignInResponse,
} from "./types.js";

/**
 * One address per build, deliberately not configurable at runtime - the
 * same ruling as the iOS ServerEnvironment (wave 6): a shipped client that
 * can be pointed at another server is a control with one dangerous use.
 * The dev build talks to the local dev server; the production build talks
 * to the deployed API and nothing else.
 */
export const API_ORIGIN = import.meta.env.DEV
  ? "http://localhost:3000"
  : "https://api.keptapp.net";

/** The server's error envelope, surfaced with its own words. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface UploadUrlResponse {
  objectKey: string;
  uploadUrl: string;
}

export interface CreateReceiptRequest {
  purchasedAt: string;
  capturedAt: string;
  image: { objectKey: string; sha256: string };
  /**
   * The extracted text the server's parsers work from - the iOS client has
   * always sent its Vision transcript here, and from 2026-09-01 this client
   * sends an emailed PDF's own text layer (`pdfText.ts`). Capped at the
   * server's own `z.string().max(100_000)` before it is sent, by
   * `OCR_RAW_TEXT_MAX_CHARS`.
   */
  ocrRawText?: string;
  /** Which extractor produced `ocrRawText`; the two always travel
   * together (`uploadOne`). */
  ocrSource?: OcrSource;
  /**
   * Accepted by the route (2026-09-01 contract) and deliberately never sent
   * by this client: a receipt being CREATED has had no field reviewed by
   * anyone - the file was dropped seconds ago and nobody has looked at a
   * box yet. Typed here so the contract is written down in one place, and
   * so a future create path that genuinely does carry reviewed fields (a
   * capture-and-confirm-in-one-screen flow) does not have to rediscover it.
   */
  reviewedFields?: ReviewedField[];
}

export type ExportRequest =
  | { fiscalYearEndingIn: number }
  | { periodStart: string; periodEnd: string };

/**
 * GET /api/receipts/possible-duplicates - proposal #8 (2026-08-28,
 * approved). Mirrors `possibleDuplicatesQuerySchema` (server/src/http/
 * schemas.ts) field for field: that schema is `z.strictObject`, so an
 * extra key this client might otherwise be tempted to add (a status
 * filter, a currency) is a 400, not a no-op - `possibleDuplicatesQuery`
 * below exists to be the one place that sends EXACTLY this shape and
 * nothing else. `totalCents` travels as a query-string integer, same
 * "money is integer cents" rule as everywhere else in this client.
 */
export interface PossibleDuplicateParams {
  purchasedAt: string;
  totalCents: number;
  vendor?: string;
  excludeId?: string;
}

/**
 * What a 401 interrupted, which decides what ending the session may cost.
 *
 * - `read`: the person asked to see something (opened a screen, pressed
 *   Load more). Nothing they typed depends on it, so the app signs out as it
 *   always has - that is the path a dead token takes on a fresh page load.
 * - `write`: the person pressed Save, or Confirm, or Delete, with their work
 *   on screen. Signing out here would unmount the very form holding it, so
 *   the app keeps the view mounted and asks for a new sign-in over the top
 *   (App.tsx's `resumeSession`).
 */
export type UnauthorizedAttempt = "read" | "write";

/**
 * Background calls (2026-10): lookups the person did not ask for, which run
 * from timers and effects while they are doing something else. Their 401
 * means exactly what the server said, and nothing more - it throws like any
 * other failure, for the caller to degrade over, and never touches the
 * session. A debounced duplicate check finding an expired token used to sign
 * the person out and destroy a half-typed form with Save never pressed.
 * `events.ts`'s `postEvents` keeps the same rule by not coming through here
 * at all.
 */
const BACKGROUND = { background: true } as const;

/**
 * The typed client. A thin seam: every method is one route, the shapes are
 * the server's, and nothing here retries, caches, or interprets - the
 * views decide what a failure means where the person can see it.
 */
export class KeptApi {
  constructor(
    private token: string,
    /** Called on a 401 from a request the person made themselves. */
    private readonly onUnauthorized: (attempt: UnauthorizedAttempt) => void,
  ) {}

  /**
   * Swaps in a fresh token for the same session. A mutable token rather than
   * a new `KeptApi` on purpose: every screen's load effect is keyed on this
   * object, so a new instance would re-fetch and overwrite the very draft a
   * re-sign-in exists to preserve.
   */
  renew(token: string): void {
    this.token = token;
  }

  static async signInWithApple(
    identityToken: string,
    displayName?: string,
  ): Promise<SignInResponse> {
    const response = await fetch(`${API_ORIGIN}/api/auth/apple`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identityToken,
        ...(displayName !== undefined && { displayName }),
      }),
    });
    return readJson<SignInResponse>(response);
  }

  me(): Promise<Profile> {
    return this.request<Profile>("GET", "/api/me");
  }

  /**
   * Destroys the account and every receipt in it (spec §6).
   *
   * No Apple authorization code goes with it: this client runs no native
   * Sign in with Apple re-authorization, so it has nothing revocable to
   * hand over. The server deletes the account either way - Apple's own
   * guidance - and records that the tokens were not revoked. The iOS client
   * is the one that supplies a code.
   */
  async deleteAccount(): Promise<void> {
    await this.request<void>("DELETE", "/api/me");
  }

  listReceipts(
    filters: ListFilters,
    cursor: string | null,
  ): Promise<ReceiptList> {
    const query = listQuery(filters, cursor);
    return this.request<ReceiptList>(
      "GET",
      `/api/receipts${query === "" ? "" : `?${query}`}`,
    );
  }

  receipt(id: string): Promise<ReceiptDetail> {
    return this.request<ReceiptDetail>("GET", `/api/receipts/${id}`);
  }

  /** The user's own past categories and payment methods, for reuse. */
  receiptOptions(): Promise<ReceiptOptions> {
    return this.request<ReceiptOptions>(
      "GET",
      "/api/receipts/options",
      undefined,
      BACKGROUND,
    );
  }

  /**
   * PATCH /api/receipts/options/:field (2026-09-01) - rename one of the
   * person's own reusable values everywhere it appears: the offered list
   * AND every receipt of theirs carrying exactly `from`. `receiptsUpdated`
   * is how many rows changed, which is the number the manage-values screen
   * shows back - a rename that says "12 receipts updated" is a different
   * event from one that says "0", and the person deserves to know which
   * one they just caused.
   *
   * Exact match, never normalized: the same 2026-08-26 free-text ruling
   * that governs the filters and `introducesNewValue`. "meals " and
   * "meals" are two values, and renaming one leaves the other alone.
   *
   * 404 when `from` is not one of the user's own values - the server will
   * not invent a rename over a value the person never used.
   */
  renameReceiptOption(
    field: OptionField,
    from: string,
    to: string,
  ): Promise<{ receiptsUpdated: number }> {
    return this.request<{ receiptsUpdated: number }>(
      "PATCH",
      `/api/receipts/options/${field}`,
      { from, to },
    );
  }

  /**
   * DELETE /api/receipts/options/:field?value= (2026-09-01) - drops the
   * value from the offered list ONLY.
   *
   * ⚠ Receipts keep their text. This is not a bulk clear and must never be
   * described as one: `category` is free text the person wrote on their own
   * records (engineering rule: never an enum, never a taxonomy), so the
   * list is a convenience over those records and deleting from it retracts
   * the suggestion, not the data. The confirmation this client shows says
   * exactly that.
   */
  async deleteReceiptOption(field: OptionField, value: string): Promise<void> {
    await this.request<void>(
      "DELETE",
      `/api/receipts/options/${field}?value=${encodeURIComponent(value)}`,
    );
  }

  /**
   * Proposal #3's running totals for whatever filter is currently applied -
   * the same filter shape GET /api/receipts takes, minus sort/order/paging
   * (an aggregate has no pages). `summaryQuery` shares its filter-parameter
   * assembly with `listQuery` below on purpose: two independent query
   * builders for the same filter shape is exactly how a summary and the
   * list beside it would quietly start disagreeing about what "the current
   * filter" means.
   */
  receiptSummary(filters: ListFilters): Promise<ReceiptSummary> {
    const query = summaryQuery(filters);
    return this.request<ReceiptSummary>(
      "GET",
      `/api/receipts/summary${query === "" ? "" : `?${query}`}`,
      undefined,
      BACKGROUND,
    );
  }

  /**
   * The account's whole pending count - the Confirm queue badge, which the
   * list route computes independent of its filters and paging, unlike
   * `ReceiptSummary.pendingCount` (scoped to the filter). This is that same
   * route asked for a single row, because the count is the only part wanted
   * and there is no route that serves it alone: a table that has to refresh
   * its badge after a save must not disturb the rows on screen to do it.
   */
  async pendingCount(): Promise<number> {
    const page = await this.request<ReceiptList>(
      "GET",
      "/api/receipts?status=pending&limit=1",
      undefined,
      BACKGROUND,
    );
    return page.pendingCount;
  }

  /**
   * The caller's own live receipts matching a date, total and (roughly) a
   * vendor - proposal #8's near-duplicate warning. A query, never a gate:
   * nothing on this client's side of the route ever refuses a save over
   * what this returns, only offers it as something worth a look.
   */
  possibleDuplicates(
    params: PossibleDuplicateParams,
  ): Promise<{ receipts: Receipt[] }> {
    const query = possibleDuplicatesQuery(params);
    return this.request<{ receipts: Receipt[] }>(
      "GET",
      `/api/receipts/possible-duplicates${query === "" ? "" : `?${query}`}`,
      undefined,
      BACKGROUND,
    );
  }

  updateReceipt(id: string, patch: ReceiptPatch): Promise<Receipt> {
    return this.request<Receipt>("PATCH", `/api/receipts/${id}`, patch);
  }

  async deleteReceipt(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/receipts/${id}`);
  }

  uploadUrl(
    contentType: "image/jpeg" | "image/png" | "application/pdf",
  ): Promise<UploadUrlResponse> {
    return this.request<UploadUrlResponse>("POST", "/api/receipts/upload-url", {
      contentType,
    });
  }

  createReceipt(body: CreateReceiptRequest): Promise<Receipt> {
    return this.request<Receipt>("POST", "/api/receipts", body);
  }

  /**
   * POST /api/receipts/:id/images - add a page to an existing receipt
   * (proposal #6, 2026-08-28). The bytes are already PUT to storage via
   * `uploadUrl` above; this only tells the API where they landed. The
   * server assigns the page number, never this client.
   */
  addReceiptImage(
    id: string,
    image: ReceiptImageWrite,
  ): Promise<ReceiptImageWriteResult> {
    return this.request<ReceiptImageWriteResult>(
      "POST",
      `/api/receipts/${id}/images`,
      image,
    );
  }

  /**
   * PUT /api/receipts/:id/images/:page - replace that page's bytes
   * (proposal #6, 2026-08-28): the repair path for the §8 sharp edge, so a
   * receipt whose image never finished uploading can be fixed without
   * losing its vendor, date, total or HST. The server soft-deletes the old
   * row and inserts a new one at the same page - retained, not erased.
   */
  replaceReceiptImage(
    id: string,
    page: number,
    image: ReceiptImageWrite,
  ): Promise<ReceiptImageWriteResult> {
    return this.request<ReceiptImageWriteResult>(
      "PUT",
      `/api/receipts/${id}/images/${page}`,
      image,
    );
  }

  startExport(body: ExportRequest): Promise<ExportJob> {
    return this.request<ExportJob>("POST", "/api/export", body);
  }

  /**
   * One job as it stands now - and, for a finished one, a download URL minted
   * for this request. Presigned URLs live five minutes, so this is the only
   * URL the export screen ever uses, fetched at the moment of the click.
   */
  exportJob(id: string): Promise<ExportJob> {
    return this.request<ExportJob>("GET", `/api/export/${id}`);
  }

  /** The same route on a timer, watching a job nobody is clicking on. */
  pollExportJob(id: string): Promise<ExportJob> {
    return this.request<ExportJob>(
      "GET",
      `/api/export/${id}`,
      undefined,
      BACKGROUND,
    );
  }

  exportJobs(): Promise<{ jobs: ExportJob[] }> {
    return this.request<{ jobs: ExportJob[] }>("GET", "/api/export");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    { background = false }: { background?: boolean } = {},
  ): Promise<T> {
    // Read once, for the comparison below: `renew` can swap the token while
    // this request is out, and a 401 on the old one says nothing about the new.
    const sentWith = this.token;
    const response = await fetch(`${API_ORIGIN}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${sentWith}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    // A request sent before the person signed in at the expiry banner comes
    // back 401 after they did. Acting on it would sign the renewed session out
    // and take the draft the banner exists to keep.
    if (response.status === 401 && !background && sentWith === this.token) {
      this.onUnauthorized(method === "GET" ? "read" : "write");
    }
    return readJson<T>(response);
  }
}

/**
 * The filter-only subset of the query string GET /api/receipts and GET
 * /api/receipts/summary both accept (the server's own
 * `receiptFilterQuerySchema`/`buildReceiptFilterConditions`, shared between
 * the two routes for the identical reason this is shared between their two
 * clients here: a filter assembled twice is a filter that can quietly drift,
 * and a summary that disagreed with the list sitting next to it is exactly
 * the failure proposal #3 names by name). `listQuery` adds sort/order/cursor
 * on top; `summaryQuery` stops here, because an aggregate has no pages or
 * order to carry.
 */
function filterQuery(filters: ListFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from !== undefined) params.set("from", filters.from);
  if (filters.to !== undefined) params.set("to", filters.to);
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.q !== undefined && filters.q.trim() !== "") {
    params.set("q", filters.q.trim());
  }
  // Category and payment method go verbatim, unlike `q` above. These two are
  // exact matches over the person's own stored text, picked from their own
  // list (the same ruling `introducesNewValue` states), so trimming a value
  // like "  Office   Supplies  " asked the server for a string no row holds:
  // zero rows and a $0 summary for a value the screen had just offered.
  // Whitespace alone still means "no filter" - the schema's min(1) would
  // accept it, but no person means it.
  if (filters.category !== undefined && filters.category.trim() !== "") {
    params.set("category", filters.category);
  }
  if (
    filters.paymentMethod !== undefined &&
    filters.paymentMethod.trim() !== ""
  ) {
    params.set("paymentMethod", filters.paymentMethod);
  }
  return params;
}

/**
 * Query-string assembly for the list route, exported for its unit test:
 * the server's schema is strict, so a key it does not know - or an empty
 * string where it requires min(1) - is a 400, and this is the one place
 * that translates "no filter" into "no parameter".
 */
export function listQuery(
  filters: ListFilters,
  cursor: string | null,
): string {
  const params = filterQuery(filters);
  // Sort and order have server defaults (purchasedAt, desc); an unset one
  // is left out entirely rather than restated, so the common query stays
  // the shortest thing that says what was asked for.
  if (filters.sort !== undefined) params.set("sort", filters.sort);
  if (filters.order !== undefined) params.set("order", filters.order);
  // Last, and never carried across a sort or filter change: the cursor
  // encodes the position of one particular ordered result set.
  if (cursor !== null) params.set("cursor", cursor);
  return params.toString();
}

/** Query-string assembly for GET /api/receipts/summary - `filterQuery`
 * alone, exported for its own unit test the same way `listQuery` is. */
export function summaryQuery(filters: ListFilters): string {
  return filterQuery(filters).toString();
}

/**
 * Query-string assembly for GET /api/receipts/possible-duplicates,
 * exported for its own unit test - same reasoning as `listQuery`/
 * `summaryQuery` above, sharper here because the server's schema is
 * strict (`PossibleDuplicateParams`'s own comment): this has to send
 * exactly `{purchasedAt, totalCents, vendor?, excludeId?}`, never an extra
 * key, and never an empty string standing in for an absent optional one.
 */
export function possibleDuplicatesQuery(params: PossibleDuplicateParams): string {
  const query = new URLSearchParams();
  query.set("purchasedAt", params.purchasedAt);
  query.set("totalCents", String(params.totalCents));
  if (params.vendor !== undefined) {
    query.set("vendor", params.vendor);
  }
  if (params.excludeId !== undefined) {
    query.set("excludeId", params.excludeId);
  }
  return query.toString();
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      "unreadable_response",
      `The server answered ${response.status} with an unreadable body`,
    );
  }
  if (!response.ok) {
    const envelope = payload as { error?: { code?: string; message?: string } };
    throw new ApiError(
      response.status,
      envelope.error?.code ?? "unknown_error",
      envelope.error?.message ?? `The server answered ${response.status}`,
    );
  }
  return payload as T;
}
