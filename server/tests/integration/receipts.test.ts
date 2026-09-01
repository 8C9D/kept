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
    expect(body.totalCents).toBe(1000000000);

    // ...and in the database itself, still integers.
    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, created.id));
    expect(rows[0]?.totalCents).toBe(1000000000);
    expect(rows[0]?.subtotalCents).toBe(999999999);
  });

  /**
   * 2026-08-28 product feedback: tips and other fees are their own fields,
   * finer-grained than the single `other_tax_cents` column the 2026-08-26
   * reduction removed. Same round-trip guarantee as every other money field.
   */
  it("creates a receipt carrying tip and other fees, and round-trips both", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ tipCents: 2000, otherFeesCents: 500, totalCents: 13800 }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as Record<string, unknown>;
    expect(created.tipCents).toBe(2000);
    expect(created.otherFeesCents).toBe(500);

    const detail = await harness.request(token, "GET", `/api/receipts/${created.id}`);
    const body = (await detail.json()) as Record<string, unknown>;
    expect(body.tipCents).toBe(2000);
    expect(body.otherFeesCents).toBe(500);

    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, created.id as string));
    expect(rows[0]?.tipCents).toBe(2000);
    expect(rows[0]?.otherFeesCents).toBe(500);
  });

  it("stores no tip or other fees when neither is sent - absent, not zero", async () => {
    const response = await harness.request(token, "POST", "/api/receipts", bodyWithImage());
    const created = (await response.json()) as Record<string, unknown>;
    expect(created.tipCents).toBeNull();
    expect(created.otherFeesCents).toBeNull();
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
  // bound parameter of the statement - vendor, notes, OCR text.
  // Each money field is checked, because one shared schema definition is
  // exactly the thing that can be edited to cover only some of them.
  it.each([
    ["totalCents", 2_147_483_648],
    ["subtotalCents", 2_147_483_648],
    ["hstCents", 2_147_483_648],
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
  // parser found, so its total may be absent - but only while pending. A
  // confirmed receipt always has one (schema + DB constraint). Since the
  // 2026-08-26 field reduction the total is the whole of "complete".

  it("rejects a confirmed receipt with no total", async () => {
    const body = bodyWithImage({ status: "confirmed" });
    delete (body as Record<string, unknown>).totalCents;
    const response = await harness.request(token, "POST", "/api/receipts", body);
    expect(response.status).toBe(400);
  });

  it("accepts a confirmed receipt carrying nothing but a total - no business choice exists to make", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ status: "confirmed" }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as Record<string, unknown>;
    expect(created.status).toBe("confirmed");
    // The three retired fields are gone from the wire, not nulled.
    expect(created).not.toHaveProperty("isBusiness");
    expect(created).not.toHaveProperty("vendorTaxNumber");
    expect(created).not.toHaveProperty("otherTaxCents");
  });

  it("accepts a pending receipt with no total", async () => {
    const body = bodyWithImage();
    delete (body as Record<string, unknown>).totalCents;
    const response = await harness.request(token, "POST", "/api/receipts", body);
    expect(response.status).toBe(201);
    const created = (await response.json()) as Record<string, unknown>;
    expect(created.status).toBe("pending");
    expect(created.totalCents).toBeNull();
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
      tipCents: null,
      // Prompt v5's two fields (2026-09-01): the client sent neither and
      // the stored record states both as the absences they are, so no later
      // reader has to tell "key absent" from "parser found nothing".
      otherFeesCents: null,
      paymentMethod: null,
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
      { purchasedAt: "2026-01-10", vendor: "Staples", category: "office supplies", paymentMethod: "visa", sha: "01" },
      { purchasedAt: "2026-02-10", vendor: "Loblaws", category: "groceries", paymentMethod: "debit", sha: "02" },
      { purchasedAt: "2026-03-10", vendor: "Shell", category: "fuel", paymentMethod: "visa", notes: "client trip", sha: "03" },
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

  it("filters by category, matching the stored free text exactly", async () => {
    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?category=${encodeURIComponent("office supplies")}`,
    );
    const body = (await response.json()) as { receipts: { vendor: string }[] };
    expect(body.receipts.map((r) => r.vendor)).toEqual(["Staples"]);
  });

  it("filters by payment method", async () => {
    const response = await harness.request(token, "GET", "/api/receipts?paymentMethod=visa");
    const body = (await response.json()) as { receipts: { vendor: string }[] };
    expect(body.receipts.map((r) => r.vendor)).toEqual(["Shell", "Staples"]);
  });

  it("does not case-fold the category filter: the value is the user's own text", async () => {
    // The 2026-08-26 ruling. /options offers these strings back verbatim,
    // so a filter that normalized would answer differently from what it
    // offered - and "Office Supplies" is a value the person did not use.
    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?category=${encodeURIComponent("Office Supplies")}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { receipts: unknown[] };
    expect(body.receipts).toHaveLength(0);
  });

  it("rejects the retired isBusiness filter rather than ignoring it", async () => {
    // Deliberate (2026-08-26): silently accepting a filter and returning
    // rows it asked to exclude is worse than refusing. The deployed web
    // bundle sends this until Pages is redeployed.
    const response = await harness.request(token, "GET", "/api/receipts?isBusiness=false");
    expect(response.status).toBe(400);
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

  it("sets tip and other fees via PATCH, then clears both with an explicit null", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage(),
    );
    const receipt = (await created.json()) as { id: string };

    const withValues = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { tipCents: 2000, otherFeesCents: 500 },
    );
    expect(withValues.status).toBe(200);
    const updated = (await withValues.json()) as Record<string, unknown>;
    expect(updated.tipCents).toBe(2000);
    expect(updated.otherFeesCents).toBe(500);

    // Explicit null clears; the field's own presence in the body is what
    // distinguishes this from "omitted, leave unchanged" (same rule as
    // every other nullable field on this route).
    const cleared = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { tipCents: null, otherFeesCents: null },
    );
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as Record<string, unknown>;
    expect(clearedBody.tipCents).toBeNull();
    expect(clearedBody.otherFeesCents).toBeNull();

    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receipt.id));
    expect(rows[0]?.tipCents).toBeNull();
    expect(rows[0]?.otherFeesCents).toBeNull();
  });

  it("leaves tip and other fees unchanged when the PATCH omits them", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ tipCents: 2000, otherFeesCents: 500 }),
    );
    const receipt = (await created.json()) as { id: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { vendor: "Corrected Vendor" },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.vendor).toBe("Corrected Vendor");
    expect(updated.tipCents).toBe(2000);
    expect(updated.otherFeesCents).toBe(500);
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

  it("confirms a bare pending receipt once the total arrives - nothing else is required", async () => {
    const body = bodyWithImage();
    delete (body as Record<string, unknown>).totalCents;
    const created = await harness.request(token, "POST", "/api/receipts", body);
    const receipt = (await created.json()) as { id: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { status: "confirmed", totalCents: 4520 },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.status).toBe("confirmed");
    expect(updated.totalCents).toBe(4520);
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

  it("edits a receipt that is already confirmed, deliberately", async () => {
    // Confirming is not a lock: a human who mistyped a total fixes it here,
    // and the row stays confirmed. Stated rather than incidental (spec §7).
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ status: "confirmed" }),
    );
    const receipt = (await created.json()) as { id: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { totalCents: 4520, vendor: "Corrected Vendor" },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.status).toBe("confirmed");
    expect(updated.totalCents).toBe(4520);
    expect(updated.vendor).toBe("Corrected Vendor");
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

/**
 * ⚠ TRANSITIONAL (2026-08-26 field reduction). Build 1.0 (1) is installed on
 * the second user's phone and cannot be updated from here: it sends three fields this
 * server no longer has columns for, and it decodes one suggestion key this
 * server no longer computes. Both shims exist so her installed app keeps
 * working, and both are pinned here so removing either is a deliberate act
 * with a failing test attached.
 *
 * Removal trigger for all of it: no installed build sends or decodes them.
 */
describe("the shipped iOS 1.0 (1) compatibility shims", () => {
  const legacyFields = {
    vendorTaxNumber: "123456789RT0001",
    otherTaxCents: 250,
    isBusiness: true,
  };

  it("accepts a create carrying the retired fields and stores none of them", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ ...legacyFields, status: "confirmed" }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as Record<string, unknown>;
    expect(created).not.toHaveProperty("vendorTaxNumber");
    expect(created).not.toHaveProperty("otherTaxCents");
    expect(created).not.toHaveProperty("isBusiness");

    // Not merely absent from the response: absent from the row. Read back
    // through the driver, which returns every column the table has.
    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, created.id as string));
    const stored = rows[0] as unknown as Record<string, unknown>;
    expect(stored).not.toHaveProperty("vendor_tax_number");
    expect(stored).not.toHaveProperty("vendorTaxNumber");
    expect(stored).not.toHaveProperty("otherTaxCents");
    expect(stored).not.toHaveProperty("isBusiness");
  });

  it("accepts a PATCH carrying the retired fields, including the explicit nulls that client sends", async () => {
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ sha: "c1".repeat(32) }),
    );
    const receipt = (await created.json()) as { id: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      {
        status: "confirmed",
        totalCents: 4520,
        vendorTaxNumber: null,
        otherTaxCents: null,
        isBusiness: null,
      },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    // The real fields still applied; the retired ones changed nothing.
    expect(updated.status).toBe("confirmed");
    expect(updated.totalCents).toBe(4520);
    expect(updated).not.toHaveProperty("isBusiness");
  });

  it("answers a PATCH of nothing but retired fields with the row as it stands", async () => {
    // The degenerate shape: an old client saving only the business choice.
    // An empty UPDATE is a driver error and a 400 would break that save, so
    // the honest answer is the unchanged receipt.
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ sha: "c2".repeat(32), vendor: "Unchanged Vendor" }),
    );
    const receipt = (await created.json()) as { id: string; updatedAt: string };

    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { isBusiness: false },
    );
    expect(response.status).toBe(200);
    const updated = (await response.json()) as Record<string, unknown>;
    expect(updated.vendor).toBe("Unchanged Vendor");
    // Nothing changed, so nothing moved updated_at either.
    expect(updated.updatedAt).toBe(receipt.updatedAt);
  });

  it("still refuses a key that is genuinely unknown", async () => {
    // The tolerance is three named fields, not a hole in the strict schema.
    // A user id is the key this refusal exists for (spec §6).
    const create = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ sha: "c3".repeat(32), userId: "smuggled" }),
    );
    expect(create.status).toBe(400);

    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ sha: "c4".repeat(32) }),
    );
    const receipt = (await created.json()) as { id: string };
    const patch = await harness.request(token, "PATCH",
      `/api/receipts/${receipt.id}`,
      { userId: "smuggled" },
    );
    expect(patch.status).toBe(400);
  });

  it("still type-checks the retired fields rather than waving anything through", async () => {
    const response = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ sha: "c5".repeat(32), otherTaxCents: 12.5 }),
    );
    expect(response.status).toBe(400);
  });

  it("serves suggestions.vendorTaxNumber as a stated absence on every read path", async () => {
    // The shipped client decodes this key with a NON-optional struct field:
    // omitting it fails the decode of the whole receipt, so the list and
    // the detail screen would both come up empty on her phone.
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({
        sha: "c6".repeat(32),
        ocrSuggestions: {
          vendor: "SCANNED VENDOR",
          totalCents: 11300,
          // The old client still extracts one, and the immutable record
          // still stores what it said...
          vendorTaxNumber: "123456789RT0001",
        },
      }),
    );
    expect(created.status).toBe(201);
    const receipt = (await created.json()) as {
      id: string;
      suggestions: Record<string, unknown>;
    };
    // ...but the merge no longer reads it, so what is served is the shim.
    expect(receipt.suggestions.vendorTaxNumber).toEqual({
      value: null,
      source: null,
    });

    const detail = await harness.request(token, "GET", `/api/receipts/${receipt.id}`);
    const detailBody = (await detail.json()) as {
      suggestions: Record<string, unknown>;
      ocrSuggestions: Record<string, unknown>;
    };
    expect(detailBody.suggestions.vendorTaxNumber).toEqual({
      value: null,
      source: null,
    });
    // The verbatim parser record is untouched: it is what §7.3 measures.
    expect(detailBody.ocrSuggestions.vendorTaxNumber).toBe("123456789RT0001");

    const list = await harness.request(token, "GET", "/api/receipts");
    const listBody = (await list.json()) as {
      receipts: { id: string; suggestions: Record<string, unknown> }[];
    };
    const listed = listBody.receipts.find((r) => r.id === receipt.id);
    expect(listed?.suggestions.vendorTaxNumber).toEqual({
      value: null,
      source: null,
    });
  });

  it("serves no suggestions at all for a receipt neither parser ever saw", async () => {
    // The shim must not manufacture a suggestion set: null in, null out is
    // a different fact from "both parsers ran and found nothing".
    const created = await harness.request(token, "POST", "/api/receipts",
      bodyWithImage({ sha: "c7".repeat(32) }),
    );
    const receipt = (await created.json()) as { suggestions: unknown };
    expect(receipt.suggestions).toBeNull();
  });
});
