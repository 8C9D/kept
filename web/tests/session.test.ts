import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, KeptApi, type UnauthorizedAttempt } from "../src/api.js";
import { sameSessionUser } from "../src/session.js";
import { describeSignInError } from "../src/views/SignIn.js";

/**
 * What a 401 is allowed to cost (2026-10). The rule used to be one line - any
 * 401 signs out - and that one line let a debounced duplicate lookup wipe a
 * half-typed form with Save never pressed. There are three cases now, and
 * they are decided here, in the seam, not in the screens.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer401(): { calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "expired" } }),
      { status: 401 },
    );
  });
  return { calls };
}

function apiSpy(): { api: KeptApi; attempts: UnauthorizedAttempt[] } {
  const attempts: UnauthorizedAttempt[] = [];
  return {
    api: new KeptApi("session-jwt", (attempt) => attempts.push(attempt)),
    attempts,
  };
}

describe("a background call's 401 never touches the session", () => {
  const backgroundCalls: [string, (api: KeptApi) => Promise<unknown>][] = [
    [
      "possibleDuplicates",
      (api) => api.possibleDuplicates({ purchasedAt: "2026-08-21", totalCents: 100 }),
    ],
    ["receiptOptions", (api) => api.receiptOptions()],
    ["receiptSummary", (api) => api.receiptSummary({})],
    ["pendingCount", (api) => api.pendingCount()],
    ["pollExportJob", (api) => api.pollExportJob("job-1")],
  ];

  for (const [name, call] of backgroundCalls) {
    it(`${name} reports the failure to its caller and nothing else`, async () => {
      answer401();
      const { api, attempts } = apiSpy();
      await expect(call(api)).rejects.toBeInstanceOf(ApiError);
      expect(attempts).toEqual([]);
    });
  }
});

describe("the person's own read ends the session", () => {
  const reads: [string, (api: KeptApi) => Promise<unknown>][] = [
    ["listReceipts", (api) => api.listReceipts({}, null)],
    ["receipt", (api) => api.receipt("r-1")],
    ["me", (api) => api.me()],
    ["exportJobs", (api) => api.exportJobs()],
    ["exportJob", (api) => api.exportJob("job-1")],
  ];

  for (const [name, call] of reads) {
    it(`${name} reports a read`, async () => {
      answer401();
      const { api, attempts } = apiSpy();
      await expect(call(api)).rejects.toBeInstanceOf(ApiError);
      expect(attempts).toEqual(["read"]);
    });
  }
});

describe("the person's own write keeps their work on screen", () => {
  const writes: [string, (api: KeptApi) => Promise<unknown>][] = [
    ["updateReceipt", (api) => api.updateReceipt("r-1", { vendor: "Staples" })],
    ["deleteReceipt", (api) => api.deleteReceipt("r-1")],
    ["startExport", (api) => api.startExport({ fiscalYearEndingIn: 2026 })],
    ["renameReceiptOption", (api) => api.renameReceiptOption("vendor", "a", "b")],
    ["uploadUrl", (api) => api.uploadUrl("image/jpeg")],
  ];

  for (const [name, call] of writes) {
    it(`${name} reports a write`, async () => {
      answer401();
      const { api, attempts } = apiSpy();
      // Still a rejection: the screen's catch is what leaves the form alone.
      await expect(call(api)).rejects.toBeInstanceOf(ApiError);
      expect(attempts).toEqual(["write"]);
    });
  }
});

describe("KeptApi.renew", () => {
  it("sends the new token on the same instance, which is what keeps a draft mounted", async () => {
    const { calls } = answer401();
    const { api } = apiSpy();
    await api.me().catch(() => undefined);
    api.renew("fresh-jwt");
    await api.me().catch(() => undefined);
    expect(calls[0]?.[1].headers).toMatchObject({
      Authorization: "Bearer session-jwt",
    });
    expect(calls[1]?.[1].headers).toMatchObject({
      Authorization: "Bearer fresh-jwt",
    });
  });
});

describe("KeptApi.pendingCount", () => {
  it("asks the list route for one row and returns only the account-wide count", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({ receipts: [], nextCursor: null, pendingCount: 7 }),
        { status: 200 },
      );
    });
    await expect(new KeptApi("t", vi.fn()).pendingCount()).resolves.toBe(7);
    expect(calls[0]).toContain("/api/receipts?status=pending&limit=1");
  });
});

/** A token with the same shape the server issues; nothing here verifies it. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${encode({ alg: "HS256" })}.${encode(claims)}.signature`;
}

describe("sameSessionUser - who the expiry banner may hand the screen back to", () => {
  const SAME_PERSON = "6f1d2c34-0a7b-4f7e-9c11-2e6a1b3d4c5e";
  const SOMEONE_ELSE = "0b9e8d7c-1234-4abc-8def-0123456789ab";

  it("is true for two tokens with one subject, whatever else differs", () => {
    expect(
      sameSessionUser(
        jwt({ sub: SAME_PERSON, tv: 1, iat: 1 }),
        jwt({ sub: SAME_PERSON, tv: 2, iat: 2 }),
      ),
    ).toBe(true);
  });

  it("is false for a different person", () => {
    expect(sameSessionUser(jwt({ sub: SAME_PERSON }), jwt({ sub: SOMEONE_ELSE }))).toBe(
      false,
    );
  });

  it("is false for anything it cannot read - costing a draft, never exposing one", () => {
    expect(sameSessionUser("not-a-jwt", "not-a-jwt")).toBe(false);
    expect(sameSessionUser("a.%%%.c", "a.%%%.c")).toBe(false);
    expect(sameSessionUser(jwt({}), jwt({}))).toBe(false);
    expect(sameSessionUser(jwt({ sub: 42 }), jwt({ sub: 42 }))).toBe(false);
  });

  it("reads a base64url payload - the alphabet real tokens use", () => {
    // A subject whose encoding is forced through "-" and "_".
    const sub = "??>>??>>";
    expect(sameSessionUser(jwt({ sub }), jwt({ sub }))).toBe(true);
  });
});

describe("describeSignInError", () => {
  it("says something useful for the server's 503 apple_unavailable", () => {
    const text = describeSignInError(
      new ApiError(503, "apple_unavailable", "Apple sign-in is unavailable"),
    );
    expect(text).toMatch(/try again/i);
    expect(text).toMatch(/Apple/);
  });

  it("keeps the server's own words for any other refusal", () => {
    expect(describeSignInError(new ApiError(401, "invalid_token", "No."))).toBe("No.");
  });

  it("treats closing Apple's popup as a cancel, not a failure", () => {
    expect(describeSignInError({ error: "popup_closed_by_user" })).toBeNull();
    expect(describeSignInError({ error: "user_cancelled_authorize" })).toBeNull();
  });

  it("names any other Apple failure", () => {
    expect(describeSignInError({ error: "invalid_client" })).toBe(
      "Apple sign-in failed: invalid_client",
    );
  });
});

describe("a 401 from before a renewal", () => {
  it("does not end the session it did not belong to", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      () => new Promise<Response>((resolve) => (answer = resolve)),
    );
    const attempts: string[] = [];
    const api = new KeptApi("expired", (attempt) => attempts.push(attempt));

    const stale = api.receipt("00000000-0000-4000-8000-000000000000");
    api.renew("fresh");
    answer(
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
      }),
    );

    await expect(stale).rejects.toThrow();
    expect(attempts).toEqual([]);
  });
});
