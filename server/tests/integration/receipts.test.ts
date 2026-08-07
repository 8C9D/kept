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

  // Every money column is a Postgres integer, so an amount above int4 is
  // unstorable. Before this bound it passed validation and failed inside
  // the insert instead: a 500, and an unhandled-error log carrying every
  // bound parameter of the statement - vendor, tax number, notes, OCR text.
  // Each money field is checked, because one shared schema definition is
  // exactly the thing that can be edited to cover only some of them.
  it.each([
    ["totalCents", 2_147_483_648],
    ["subtotalCents", 2_147_483_648],
    ["hstCents", 2_147_483_648],
    ["otherTaxCents", 2_147_483_648],
    ["totalCents", -2_147_483_649],
  ])("rejects %s of %d as unstorable, with a 400 not a 500", async (field, value) => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ [field as string]: value }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("storable amount range");
  });

  it("still accepts an amount at the storable boundary", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ totalCents: 2_147_483_647, subtotalCents: -2_147_483_648 }),
    );
    expect(response.status).toBe(201);
  });

  it("rejects an unstorable amount on update too", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ sha: "9".repeat(64) }),
    );
    const { id } = (await created.json()) as { id: string };
    const response = await harness.request(token, "PATCH",
      `/api/receipts/${id}`, { totalCents: 2_147_483_648 },
    );
    expect(response.status).toBe(400);
  });

  // Wave 4: a batch-scanned receipt is created pending with whatever the
  // parser found, so total and the business choice may be absent - but only
  // while pending. Confirmed always requires both (schema + DB constraint).

  it("rejects a confirmed receipt with no explicit isBusiness choice", async () => {
    const body = bodyWithImage({ status: "confirmed" });
    delete (body as Record<string, unknown>).isBusiness;
    const response = await harness.request(token, "POST", "/api/receipts", body);
    expect(response.status).toBe(400);
  });

  it("rejects a confirmed receipt with no total", async () => {
    const body = bodyWithImage({ status: "confirmed" });
    delete (body as Record<string, unknown>).totalCents;
    const response = await harness.request(token, "POST", "/api/receipts", body);
    expect(response.status).toBe(400);
  });

  it("accepts a pending receipt with no total and no business choice", async () => {
    const body = bodyWithImage();
    delete (body as Record<string, unknown>).totalCents;
    delete (body as Record<string, unknown>).isBusiness;
    const response = await harness.request(token, "POST", "/api/receipts", body);
    expect(response.status).toBe(201);
    const created = (await response.json()) as Record<string, unknown>;
    expect(created.status).toBe("pending");
    expect(created.totalCents).toBeNull();
    expect(created.isBusiness).toBeNull();
  });

  it("stores the parser's suggestions verbatim, absent keys as null", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({
        ocrSuggestions: { totalCents: 11300, vendor: "Test Vendor" },
      }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };

    const expectedStored = {
      vendor: "Test Vendor",
      purchasedAt: null,
      totalCents: 11300,
      hstCents: null,
      subtotalCents: null,
      vendorTaxNumber: null,
    };
    const rows = await harness.db
      .select({ ocrSuggestions: receipts.ocrSuggestions })
      .from(receipts)
      .where(eq(receipts.id, created.id));
    expect(rows[0]?.ocrSuggestions).toEqual(expectedStored);

    // The detail route hands the record back: the confirm screen marks
    // exactly the fields the parser suggested, not whatever happens to be
    // non-null (wave-4 reviewer pass).
    const detail = await harness.request(token, "GET", `/api/receipts/${created.id}`);
    const body = (await detail.json()) as { ocrSuggestions: unknown };
    expect(body.ocrSuggestions).toEqual(expectedStored);
  });

  it("enforces confirmed-completeness in the database itself, not only the routes", async () => {
    // Bypass the API on purpose: the check constraint is the guarantee that
    // no future handler can write a confirmed receipt with no total.
    // Drizzle wraps the pg error, so the constraint name is found by
    // walking the cause chain (same shape isUniqueViolation handles).
    const failure = await harness.db
      .insert(receipts)
      .values({
        userId,
        purchasedAt: "2026-03-15",
        capturedAt: new Date(),
        totalCents: null,
        isBusiness: true,
        status: "confirmed",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    const constraints: unknown[] = [];
    let current: unknown = failure;
    while (current instanceof Error) {
      constraints.push((current as Error & { constraint?: unknown }).constraint);
      current = current.cause;
    }
    expect(constraints).toContain("receipts_confirmed_complete_ck");
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

describe("GET /api/receipts pendingCount", () => {
  it("counts the user's pending receipts regardless of paging and filters", async () => {
    // Two pending (the column default), one confirmed.
    for (const overrides of [
      { sha: "a1".repeat(32) },
      { sha: "a2".repeat(32), purchasedAt: "2026-03-16" },
      { sha: "a3".repeat(32), status: "confirmed" },
    ]) {
      const response = await harness.request(token, "POST", "/api/receipts",
        bodyWithImage(overrides),
      );
      expect(response.status).toBe(201);
    }

    // One row on the page, but the badge count is the user-wide truth.
    const paged = await harness.request(token, "GET", "/api/receipts?limit=1");
    expect(((await paged.json()) as { pendingCount: number }).pendingCount).toBe(2);

    // A confirmed-only filter must not bend the count either.
    const filtered = await harness.request(
      token,
      "GET",
      "/api/receipts?status=confirmed",
    );
    expect(((await filtered.json()) as { pendingCount: number }).pendingCount).toBe(2);
  });

  it("excludes soft-deleted receipts and other users' receipts", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ sha: "b1".repeat(32) }),
    );
    const { id } = (await created.json()) as { id: string };

    // Another user's pending receipt must never leak into my count.
    const other = await harness.signIn("pending-count-other-user");
    await harness.request(other.token, "POST", "/api/receipts",
      receiptBody({ image: imageFor(other.userId, "b2".repeat(32)) }),
    );

    const before = await harness.request(token, "GET", "/api/receipts");
    expect(((await before.json()) as { pendingCount: number }).pendingCount).toBe(1);

    await harness.request(token, "DELETE", `/api/receipts/${id}`);
    const after = await harness.request(token, "GET", "/api/receipts");
    expect(((await after.json()) as { pendingCount: number }).pendingCount).toBe(0);
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

  // Wave 4: the confirm screen's save is a PATCH to status=confirmed, and
  // confirming an incomplete receipt must fail with the missing field named.

  it("confirms a bare pending receipt once total and the choice arrive", async () => {
    const body = bodyWithImage();
    delete (body as Record<string, unknown>).totalCents;
    delete (body as Record<string, unknown>).isBusiness;
    const created = await harness.request(token, "POST", "/api/receipts", body);
    const receipt = (await created.json()) as { id: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { status: "confirmed", totalCents: 4520, isBusiness: false },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.status).toBe("confirmed");
    expect(updated.totalCents).toBe(4520);
    expect(updated.isBusiness).toBe(false);
  });

  it("refuses to confirm a receipt that would end up with no total", async () => {
    const body = bodyWithImage();
    delete (body as Record<string, unknown>).totalCents;
    const created = await harness.request(token, "POST", "/api/receipts", body);
    const receipt = (await created.json()) as { id: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { status: "confirmed" },
    );
    expect(response.status).toBe(400);
    const failure = (await response.json()) as {
      error: { message: string };
    };
    expect(failure.error.message).toMatch(/total/);
  });

  it("refuses to confirm a receipt with no business-or-personal choice", async () => {
    const body = bodyWithImage();
    delete (body as Record<string, unknown>).isBusiness;
    const created = await harness.request(token, "POST", "/api/receipts", body);
    const receipt = (await created.json()) as { id: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { status: "confirmed" },
    );
    expect(response.status).toBe(400);
    const failure = (await response.json()) as {
      error: { message: string };
    };
    expect(failure.error.message).toMatch(/business-or-personal/);
  });

  it("refuses to null the total out of a confirmed receipt", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ status: "confirmed" }),
    );
    const receipt = (await created.json()) as { id: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { totalCents: null },
    );
    expect(response.status).toBe(400);
  });

  it("rejects any attempt to rewrite the parser's suggestion record", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ ocrSuggestions: { totalCents: 11300 } }),
    );
    const receipt = (await created.json()) as { id: string };

    // Strict schema: ocrSuggestions is not an updatable key at all.
    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { ocrSuggestions: { totalCents: 1 } },
    );
    expect(response.status).toBe(400);
  });
});
