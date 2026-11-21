import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createSessionTokens } from "../../src/auth/session.js";
import type { Db } from "../../src/db/client.js";
import type { ObjectStorage } from "../../src/storage/objectStorage.js";
import { fakeAppleVerifier } from "../helpers/fakeAppleVerifier.js";
import { createTestHarness, TEST_SESSION_SECRET } from "../helpers/testApp.js";

const EDGE_SECRET = "edge-secret-value-for-tests-0123456789";

const fronted = createTestHarness({ edgeSharedSecret: EDGE_SECRET });
afterAll(() => fronted.close());

/**
 * The one route the production container's healthcheck probes
 * (ops/prod/docker-compose.prod.yml; Fly's HTTP check until 2026-10-02). Its
 * contract, decided 2026-08-15 (docs/DECISIONS.md): liveness only - a
 * constant 200 from the process itself, reachable without the edge secret
 * the healthcheck cannot carry, touching neither backing service so it can never keep
 * Neon's autosuspending compute awake and never tells an outside observer
 * which backing service is up.
 */
describe("GET /health", () => {
  it("answers 200 with the constant body, unauthenticated", async () => {
    const response = await fronted.app.request("/health", {
      headers: { "x-kept-edge-secret": EDGE_SECRET },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  // The healthcheck probes from inside the container, not through
  // Cloudflare, and the compose file is committed so a check header cannot
  // carry the secret. If the route slides below the edge-secret middleware,
  // every probe answers 403 and Docker marks the container unhealthy.
  it("answers without the edge secret, which the healthcheck cannot carry", async () => {
    const response = await fronted.app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("keeps the no-store contract like every other response", async () => {
    const response = await fronted.app.request("/health");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  // The check runs every 30 seconds forever. One that touched the database
  // would never let Neon's autosuspend fire, and one that touched storage
  // would bill a probe per interval - so the handler must consult neither.
  // Proved structurally: an app whose db and storage throw on ANY use still
  // answers, so the handler cannot be reading either.
  it("touches neither the database nor object storage", async () => {
    const explode = (name: string) =>
      new Proxy(
        {},
        {
          get() {
            throw new Error(`GET /health must never touch ${name}`);
          },
        },
      );
    const app = createApp({
      db: explode("the database") as unknown as Db,
      appleVerifier: fakeAppleVerifier(),
      sessionTokens: createSessionTokens(TEST_SESSION_SECRET),
      storage: explode("object storage") as unknown as ObjectStorage,
    });
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  // The other half lives in the production compose file: the endpoint
  // without the healthcheck is a route nothing probes, and the healthcheck
  // without the endpoint fails every probe. Pin the wiring so neither half
  // can be removed alone with the suite green.
  it("is what the production compose healthcheck points at", () => {
    const compose = readFileSync(
      fileURLToPath(new URL("../../ops/prod/docker-compose.prod.yml", import.meta.url)),
      "utf8",
    );
    expect(compose).toContain("healthcheck:");
    expect(compose).toContain("fetch('http://127.0.0.1:3000/health')");
  });
});
