import type {
  ExportJob,
  ListFilters,
  Profile,
  ReceiptDetail,
  ReceiptList,
  ReceiptPatch,
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
  isBusiness: boolean;
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
 * Query-string assembly for the list route, exported for its unit test:
 * the server's schema is strict, so a key it does not know - or an empty
 * string where it requires min(1) - is a 400, and this is the one place
 * that translates "no filter" into "no parameter".
 */
export function listQuery(
  filters: ListFilters,
  cursor: string | null,
): string {
  const params = new URLSearchParams();
  if (filters.from !== undefined) params.set("from", filters.from);
  if (filters.to !== undefined) params.set("to", filters.to);
  if (filters.isBusiness !== undefined) {
    params.set("isBusiness", filters.isBusiness ? "true" : "false");
  }
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.q !== undefined && filters.q.trim() !== "") {
    params.set("q", filters.q.trim());
  }
  if (cursor !== null) params.set("cursor", cursor);
  return params.toString();
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
