import type {
  ExportJob,
  ListFilters,
  Profile,
  ReceiptDetail,
  ReceiptImageWrite,
  ReceiptImageWriteResult,
  ReceiptList,
  ReceiptOptions,
  ReceiptPatch,
  ReceiptSummary,
  Receipt,
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
}

export type ExportRequest =
  | { fiscalYearEndingIn: number }
  | { periodStart: string; periodEnd: string };

/**
 * The typed client. A thin seam: every method is one route, the shapes are
 * the server's, and nothing here retries, caches, or interprets - the
 * views decide what a failure means where the person can see it.
 */
export class KeptApi {
  constructor(
    private readonly token: string,
    /** Called on any 401: the session is over and the app signs out. */
    private readonly onUnauthorized: () => void,
  ) {}

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
    return this.request<ReceiptOptions>("GET", "/api/receipts/options");
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

  exportJob(id: string): Promise<ExportJob> {
    return this.request<ExportJob>("GET", `/api/export/${id}`);
  }

  exportJobs(): Promise<{ jobs: ExportJob[] }> {
    return this.request<{ jobs: ExportJob[] }>("GET", "/api/export");
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      this.onUnauthorized();
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
  if (filters.category !== undefined && filters.category.trim() !== "") {
    params.set("category", filters.category.trim());
  }
  if (
    filters.paymentMethod !== undefined &&
    filters.paymentMethod.trim() !== ""
  ) {
    params.set("paymentMethod", filters.paymentMethod.trim());
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
