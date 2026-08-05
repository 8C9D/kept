import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receipts } from "../../src/db/schema.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("receipts-user"));
});

function bodyWithImage(overrides: Record<string, unknown> = {}) {
  const { sha, ...fields } = overrides;
  return receiptBody({
    image: imageFor(userId, (sha as string | undefined) ?? "1".repeat(64)),
    ...fields,
  });
}

describe("POST /api/receipts", () => {
  it("creates a receipt and its page-1 image row", async () => {
    const response = await harness.request(
      token,
      "POST",
      "/api/receipts",
      bodyWithImage(),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as Record<string, unknown>;
    expect(created.vendor).toBe("Test Vendor");
    expect(created.status).toBe("pending"); // column default, not sent
    expect(created.currency).toBe("CAD"); // column default, not sent
    // Internal columns stay internal.
    expect(created).not.toHaveProperty("userId");
    expect(created).not.toHaveProperty("deletedAt");

    const detail = await harness.request(
      token,
      "GET",
      `/api/receipts/${created.id}`,
    );
    const withImages = (await detail.json()) as {
      images: { page: number; downloadUrl: string }[];
    };
    expect(withImages.images).toHaveLength(1);
    expect(withImages.images[0]?.page).toBe(1);
    expect(withImages.images[0]?.downloadUrl).toContain(userId);
  });

  it("round-trips money exactly as integer cents", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({
        subtotalCents: 999999999,
        hstCents: 1,
        otherTaxCents: 0,
        totalCents: 1000000000,
      }),
    );
    const created = (await response.json()) as { id: string };

    // Through the API...
    const fetched = await harness.request(
      token,
      "GET",
      `/api/receipts/${created.id}`,
    );
    const body = (await fetched.json()) as Record<string, unknown>;
    expect(body.subtotalCents).toBe(999999999);
    expect(body.hstCents).toBe(1);
    expect(body.otherTaxCents).toBe(0);
    expect(body.totalCents).toBe(1000000000);

    // ...and in the database itself, still integers.
    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, created.id));
    expect(rows[0]?.totalCents).toBe(1000000000);
    expect(rows[0]?.subtotalCents).toBe(999999999);
  });

  it("answers 400, not 500, to a body that is not JSON at all", async () => {
    const response = await harness.app.request("/api/receipts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{this is not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("rejects fractional cents - floats never reach the database", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ totalCents: 113.5 }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("integer number of cents");
  });

  it("rejects a receipt with no explicit isBusiness choice", async () => {
    const body = bodyWithImage();
    delete (body as Record<string, unknown>).isBusiness;
    const response = await harness.request(token, "POST", "/api/receipts", body);
    expect(response.status).toBe(400);
  });

  it("rejects a receipt with no total", async () => {
    const body = bodyWithImage();
    delete (body as Record<string, unknown>).totalCents;
    const response = await harness.request(token, "POST", "/api/receipts", body);
    expect(response.status).toBe(400);
  });

  it("accepts numbers that do not reconcile - the server never blocks on arithmetic", async () => {
    // subtotal + hst != total; legitimate receipts do this (spec §7.2).
    // The warning itself is the confirm screen's job, client-side.
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ subtotalCents: 10000, hstCents: 1300, totalCents: 99999 }),
    );
    expect(response.status).toBe(201);
  });

  it("accepts a receipt with a null vendor", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ vendor: null }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { vendor: string | null };
    expect(created.vendor).toBeNull();
  });

  it("answers 409 when the same user re-uploads an identical file", async () => {
    const sha = "e".repeat(64);
    const first = await harness.request(token, "POST", "/api/receipts",
      receiptBody({ image: imageFor(userId, sha) }),
    );
    expect(first.status).toBe(201);

    const second = await harness.request(token, "POST", "/api/receipts",
      receiptBody({ image: imageFor(userId, sha) }),
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("duplicate_image");
  });

  it("allows different users to hold byte-identical images", async () => {
    const sha = "f".repeat(64);
    const mine = await harness.request(token, "POST", "/api/receipts",
      receiptBody({ image: imageFor(userId, sha) }),
    );
    expect(mine.status).toBe(201);

    const other = await harness.signIn("other-receipts-user");
    const theirs = await harness.request(other.token, "POST", "/api/receipts",
      receiptBody({ image: imageFor(other.userId, sha) }),
    );
    expect(theirs.status).toBe(201);
  });
});

describe("GET /api/receipts filters", () => {
  beforeEach(async () => {
    const fixtures = [
      { purchasedAt: "2026-01-10", vendor: "Staples", isBusiness: true, sha: "01" },
      { purchasedAt: "2026-02-10", vendor: "Loblaws", isBusiness: false, sha: "02" },
      { purchasedAt: "2026-03-10", vendor: "Shell", isBusiness: true, notes: "client trip", sha: "03" },
    ];
    for (const fixture of fixtures) {
      const { sha, ...fields } = fixture;
      const response = await harness.request(token, "POST", "/api/receipts",
        bodyWithImage({ ...fields, sha: sha.repeat(32) }),
      );
      expect(response.status).toBe(201);
    }
  });

  it("filters by date range, inclusive of its bounds", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?from=2026-02-10&to=2026-03-10",
    );
    const body = (await response.json()) as { receipts: { vendor: string }[] };
    expect(body.receipts.map((r) => r.vendor).sort()).toEqual([
      "Loblaws",
      "Shell",
    ]);
  });

  it("filters by business vs personal", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?isBusiness=false",
    );
    const body = (await response.json()) as { receipts: { vendor: string }[] };
    expect(body.receipts.map((r) => r.vendor)).toEqual(["Loblaws"]);
  });

  it("searches vendor, category, and notes together", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?q=client",
    );
    const body = (await response.json()) as { receipts: { vendor: string }[] };
    expect(body.receipts.map((r) => r.vendor)).toEqual(["Shell"]);
  });

  it("treats LIKE wildcards in the search term as literals", async () => {
    const response = await harness.request(token, "GET", "/api/receipts?q=%25");
    const body = (await response.json()) as { receipts: unknown[] };
    expect(body.receipts).toHaveLength(0);
  });

  it("lists newest purchase first", async () => {
    const response = await harness.request(token, "GET", "/api/receipts");
    const body = (await response.json()) as { receipts: { vendor: string }[] };
    expect(body.receipts.map((r) => r.vendor)).toEqual([
      "Shell",
      "Loblaws",
      "Staples",
    ]);
  });

  it("rejects an unknown query parameter", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?userId=abc",
    );
    expect(response.status).toBe(400);
  });

  it("pages with a cursor and terminates with a null cursor", async () => {
    // Three fixtures exist; page size two → one full page, then one row.
    const first = await harness.request(token, "GET", "/api/receipts?limit=2");
    const firstPage = (await first.json()) as {
      receipts: { vendor: string }[];
      nextCursor: string | null;
    };
    expect(firstPage.receipts.map((r) => r.vendor)).toEqual([
      "Shell",
      "Loblaws",
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await harness.request(
      token,
      "GET",
      `/api/receipts?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor as string)}`,
    );
    const secondPage = (await second.json()) as {
      receipts: { vendor: string }[];
      nextCursor: string | null;
    };
    expect(secondPage.receipts.map((r) => r.vendor)).toEqual(["Staples"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("rejects a junk cursor with 400", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?cursor=%21%21not-a-cursor",
    );
    expect(response.status).toBe(400);
  });
});

describe("PATCH /api/receipts/:id", () => {
  it("updates only the provided fields and bumps updated_at", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage(),
    );
    const receipt = (await created.json()) as {
      id: string;
      updatedAt: string;
    };

    // Timestamps serialize at millisecond precision; a tiny pause keeps the
    // strictly-greater assertion from tying on a fast machine.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { status: "confirmed", hstCents: 1400 },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.status).toBe("confirmed");
    expect(updated.hstCents).toBe(1400);
    expect(updated.vendor).toBe("Test Vendor"); // untouched
    // The database trigger, not handler code, moved updated_at forward.
    expect(new Date(updated.updatedAt as string).getTime()).toBeGreaterThan(
      new Date(receipt.updatedAt).getTime(),
    );
  });

  it("rejects an empty update", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage(),
    );
    const receipt = (await created.json()) as { id: string };
    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      {},
    );
    expect(response.status).toBe(400);
  });

  it("404s on a malformed receipt id rather than erroring", async () => {
    const response = await harness.request(token, "PATCH",
      "/api/receipts/not-a-uuid",
      { vendor: "X" },
    );
    expect(response.status).toBe(404);
  });
});
