import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ORIGIN, ApiError, KeptApi } from "../src/api.js";

/**
 * Account deletion from the web client. There is no DOM here (this suite is
 * the client's logic, deliberately), so what is under test is the request
 * itself: the method and path the server routes on, the bearer token, and
 * that a 204 with no body is a success rather than an unreadable response.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response): { calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return response;
  });
  return { calls };
}

describe("KeptApi.deleteAccount", () => {
  it("DELETEs /api/me with the session token and no body", async () => {
    const { calls } = stubFetch(new Response(null, { status: 204 }));
    const signOut = vi.fn();

    await new KeptApi("session-jwt", signOut).deleteAccount();

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_ORIGIN}/api/me`);
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({ Authorization: "Bearer session-jwt" });
    // No body at all, and so no Content-Type: this client runs no native
    // Sign in with Apple re-authorization, so it has no code to send, and
    // the server's schema accepts the absence.
    expect(init.body).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("treats the server's empty 204 as success, not an unreadable body", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(
      new KeptApi("session-jwt", vi.fn()).deleteAccount(),
    ).resolves.toBeUndefined();
  });

  it("surfaces a refusal in the server's own words", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          error: { code: "invalid_request", message: "Unrecognized key" },
        }),
        { status: 400 },
      ),
    );

    const error = await new KeptApi("session-jwt", vi.fn())
      .deleteAccount()
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_request");
    expect((error as ApiError).message).toBe("Unrecognized key");
  });
});
