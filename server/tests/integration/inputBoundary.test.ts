import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  receiptFieldOptions,
  receipts,
  userEvents,
  users,
} from "../../src/db/schema.js";
import { MAX_STORABLE_CENTS } from "../../src/domain/money.js";
import type { ParseOcrText } from "../../src/routes/receipts.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * Input the validators used to wave through and Postgres then refused. Each of
 * these was a 500, and on a create it landed AFTER the image had uploaded.
 *
 * The rulings differ by who can do something about it. An iOS outbox item has
 * no edit path, so what it sends must not be refused over something no human
 * typed or chose: U+0000 is stripped, a parser's overflow becomes null. A date
 * in year zero is a person's or a client's mistake and is a plain 400.
 */

const parsedTexts: string[] = [];
const parseOcrText: ParseOcrText = {
  model: "test-model",
  async parse(ocrRawText) {
    parsedTexts.push(ocrRawText);
    return {
      vendor: null,
      purchasedAt: null,
      totalCents: null,
      hstCents: null,
      subtotalCents: null,
      tipCents: null,
      otherFeesCents: null,
      paymentMethod: null,
      vendorTaxNumber: null,
    };
  },
};

const harness = createTestHarness({ parseOcrText });
afterAll(() => harness.close());

let token: string;
let userId: string;
let shaCounter = 0;

beforeEach(async () => {
  await harness.resetDatabase();
  parsedTexts.length = 0;
  ({ token, userId } = await harness.signIn("input-boundary-user"));
});

function createBody(fields: Record<string, unknown>) {
  shaCounter += 1;
  return {
    ...receiptBody(fields),
    image: imageFor(userId, shaCounter.toString(16).padStart(64, "0")),
  };
}

function post(fields: Record<string, unknown>): Promise<Response> {
  return harness.request(token, "POST", "/api/receipts", createBody(fields));
}

async function createdRow(fields: Record<string, unknown>) {
  const response = await post(fields);
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  const rows = await harness.db
    .select()
    .from(receipts)
    .where(eq(receipts.id, id));
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Test receipt row is missing");
  }
  return row;
}

describe("U+0000 in free text", () => {
  it("is stripped from every text field of a create, and the row stores the rest", async () => {
    const row = await createdRow({
      vendor: "Tim\u0000 Hortons",
      category: "co\u0000ffee",
      paymentMethod: "vi\u0000sa",
      notes: "morn\u0000ing",
      ocrRawText: "TOTAL\u0000 4.50",
      ocrSuggestions: {
        vendor: "TIM\u0000",
        paymentMethod: "\u0000VISA",
        vendorTaxNumber: "12\u00003",
      },
    });

    expect(row.vendor).toBe("Tim Hortons");
    expect(row.category).toBe("coffee");
    expect(row.paymentMethod).toBe("visa");
    expect(row.notes).toBe("morning");
    expect(row.ocrRawText).toBe("TOTAL 4.50");
    expect(row.ocrSuggestions).toMatchObject({
      vendor: "TIM",
      paymentMethod: "VISA",
      vendorTaxNumber: "123",
    });
  });

  it("is stripped from a PATCH", async () => {
    const row = await createdRow({});

    const response = await harness.request(
      token,
      "PATCH",
      `/api/receipts/${row.id}`,
      { vendor: "Sta\u0000ples", notes: "\u0000", ocrRawText: "a\u0000b" },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { vendor: string; notes: string };
    expect(body.vendor).toBe("Staples");
    expect(body.notes).toBe("");
  });

  it("turns a label that was nothing but U+0000 into an absence, never a 400", async () => {
    // Stripping alone would leave "", which `.min(1)` refuses - the exact
    // stranded outbox item this exists to prevent.
    const row = await createdRow({
      vendor: "\u0000",
      category: "\u0000\u0000",
      paymentMethod: "\u0000",
      ocrSuggestions: { vendor: "\u0000" },
    });

    expect(row.vendor).toBeNull();
    expect(row.category).toBeNull();
    expect(row.paymentMethod).toBeNull();
    expect(row.ocrSuggestions).toMatchObject({ vendor: null });
  });

  it("still refuses an empty label a client really sent", async () => {
    expect((await post({ vendor: "" })).status).toBe(400);
  });

  it("measures length after stripping, so a clean value at the limit fits", async () => {
    const row = await createdRow({ vendor: `${"a".repeat(200)}\u0000` });
    expect(row.vendor).toHaveLength(200);

    expect((await post({ vendor: "a".repeat(201) })).status).toBe(400);
  });

  it.each([
    ["q on the list", "/api/receipts?q=sta%00ples"],
    ["category on the list", "/api/receipts?category=of%00fice"],
    ["paymentMethod on the list", "/api/receipts?paymentMethod=vi%00sa"],
    ["q on the summary", "/api/receipts/summary?q=sta%00ples"],
    ["category on the summary", "/api/receipts/summary?category=of%00fice"],
    [
      "vendor on possible-duplicates",
      "/api/receipts/possible-duplicates?purchasedAt=2026-03-15&totalCents=100&vendor=sta%00ples",
    ],
  ])("is stripped from %s, which still answers", async (_name, path) => {
    const response = await harness.request(token, "GET", path);
    expect(response.status).toBe(200);
  });

  it("matches the stripped filter text, not a 500 and not nothing", async () => {
    await createdRow({ vendor: "Staples", status: "confirmed" });

    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?q=sta%00ples",
    );

    const body = (await response.json()) as { receipts: unknown[] };
    expect(body.receipts).toHaveLength(1);
  });

  it("is stripped from the rename and delete option routes", async () => {
    await createdRow({ category: "office" });

    const renamed = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/category",
      { from: "off\u0000ice", to: "sup\u0000plies" },
    );
    expect(renamed.status).toBe(200);
    const stored = await harness.db
      .select({ value: receiptFieldOptions.value })
      .from(receiptFieldOptions)
      .where(eq(receiptFieldOptions.field, "category"));
    expect(stored.map((row) => row.value)).toEqual(["supplies"]);

    const deleted = await harness.request(
      token,
      "DELETE",
      "/api/receipts/options/category?value=sup%00plies",
    );
    expect(deleted.status).toBe(204);
  });

  it("is stripped from a display name, on sign-in and on PATCH /api/me", async () => {
    const response = await harness.request(null, "POST", "/api/auth/apple", {
      identityToken: "apple-token:nul-name-sub",
      displayName: "Av\u0000ery",
    });
    expect(response.status).toBe(200);
    const created = await harness.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.appleSub, "nul-name-sub"));
    expect(created[0]?.displayName).toBe("Avery");

    const patched = await harness.request(token, "PATCH", "/api/me", {
      displayName: "Na\u0000me",
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { displayName: string }).displayName).toBe(
      "Name",
    );
  });

  it("is stripped from an event's appVersion", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [
        {
          action: "confirm_opened",
          occurredAt: new Date().toISOString(),
          client: "ios",
          appVersion: "1.0\u0000 (5)",
        },
      ],
    });

    expect(response.status).toBe(202);
    const rows = await harness.db
      .select({ appVersion: userEvents.appVersion })
      .from(userEvents);
    expect(rows[0]?.appVersion).toBe("1.0 (5)");
  });

  it("is stripped before the capture-time parse sees the text", async () => {
    const response = await harness.request(token, "POST", "/api/receipts/parse", {
      ocrRawText: "TOTAL\u0000 4.50",
      capturedAt: "2026-03-15T18:30:00Z",
    });

    expect(response.status).toBe(200);
    expect(parsedTexts).toEqual(["TOTAL 4.50"]);
  });

  it("refuses a list cursor whose vendor key carries one, rather than binding it", async () => {
    // A cursor is re-bound as it arrived, so stripping cannot help it, and no
    // stored vendor can hold this character: it is a forged position.
    const cursor = Buffer.from(
      JSON.stringify({
        sort: "vendor",
        order: "asc",
        sortKeyNull: false,
        sortKey: "sta\u0000ples",
        createdAt: "2026-08-16T12:00:00.123456Z",
        id: "00000000-0000-4000-8000-000000000000",
      }),
      "utf8",
    ).toString("base64url");

    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?sort=vendor&order=asc&cursor=${cursor}`,
    );

    expect(response.status).toBe(400);
  });
});

describe("year 0000", () => {
  it.each([
    ["purchasedAt on a create", () => post({ purchasedAt: "0000-06-15" })],
    [
      "capturedAt on a create",
      () => post({ capturedAt: "0000-06-15T12:00:00Z" }),
    ],
    [
      "capturedAt whose offset lands it in year zero",
      () => post({ capturedAt: "0001-01-01T00:00:00+14:00" }),
    ],
    [
      "capturedAt whose offset lands it past year 9999",
      () => post({ capturedAt: "9999-12-31T23:59:59-01:00" }),
    ],
    [
      "the list's from filter",
      () => harness.request(token, "GET", "/api/receipts?from=0000-01-01"),
    ],
    [
      "the list's to filter",
      () => harness.request(token, "GET", "/api/receipts?to=0000-12-31"),
    ],
    [
      "the summary's from filter",
      () =>
        harness.request(token, "GET", "/api/receipts/summary?from=0000-01-01"),
    ],
    [
      "possible-duplicates",
      () =>
        harness.request(
          token,
          "GET",
          "/api/receipts/possible-duplicates?purchasedAt=0000-01-01&totalCents=100",
        ),
    ],
    [
      "an export period",
      () =>
        harness.request(token, "POST", "/api/export", {
          periodStart: "0000-01-01",
          periodEnd: "0000-12-31",
        }),
    ],
  ])("is a 400 in %s", async (_name, send) => {
    const response = await send();
    expect(response.status).toBe(400);
  });

  it("is a 400 in a PATCH, on both dates", async () => {
    const row = await createdRow({});
    for (const body of [
      { purchasedAt: "0000-06-15" },
      { capturedAt: "0000-06-15T12:00:00Z" },
    ]) {
      const response = await harness.request(
        token,
        "PATCH",
        `/api/receipts/${row.id}`,
        body,
      );
      expect(response.status).toBe(400);
    }
  });

  it.each([
    ["createdAt", { createdAt: "0000-06-15T12:00:00Z" }, "purchasedAt", "2026-03-15"],
    ["a purchasedAt sort key", {}, "purchasedAt", "0000-06-15"],
    ["a capturedAt sort key", {}, "capturedAt", "0000-06-15T12:00:00Z"],
  ])("is a 400 in a cursor's %s", async (_name, stamps, sort, sortKey) => {
    const cursor = Buffer.from(
      JSON.stringify({
        sort,
        order: "desc",
        sortKeyNull: false,
        sortKey,
        createdAt: "2026-08-16T12:00:00.123456Z",
        id: "00000000-0000-4000-8000-000000000000",
        ...stamps,
      }),
      "utf8",
    ).toString("base64url");

    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?sort=${sort}&cursor=${cursor}`,
    );

    expect(response.status).toBe(400);
  });

  it("leaves year 0001 and year 9999 alone, which Postgres can store", async () => {
    const row = await createdRow({
      purchasedAt: "0001-01-01",
      capturedAt: "9999-12-31T23:59:59Z",
    });
    expect(row.purchasedAt).toBe("0001-01-01");
    expect(row.capturedAt.getUTCFullYear()).toBe(9999);
  });
});

describe("a parser's amount outside the storable range", () => {
  const OVERFLOW = MAX_STORABLE_CENTS + 1;

  it("becomes null, and the human-corrected create still lands", async () => {
    const row = await createdRow({
      totalCents: 11300,
      status: "confirmed",
      ocrSuggestions: {
        totalCents: OVERFLOW,
        hstCents: -OVERFLOW - 1,
        subtotalCents: Number.MAX_SAFE_INTEGER,
        tipCents: 2 ** 53,
        otherFeesCents: OVERFLOW,
      },
    });

    expect(row.totalCents).toBe(11300);
    expect(row.ocrSuggestions).toMatchObject({
      totalCents: null,
      hstCents: null,
      subtotalCents: null,
      tipCents: null,
      otherFeesCents: null,
    });
  });

  it("does the same for a parser's text and dates the columns would refuse", async () => {
    const row = await createdRow({
      totalCents: 11300,
      status: "confirmed",
      ocrSuggestions: {
        vendor: "x".repeat(201),
        purchasedAt: "2026-02-30",
        paymentMethod: "y".repeat(101),
        vendorTaxNumber: "z".repeat(51),
      },
    });

    expect(row.totalCents).toBe(11300);
    expect(row.ocrSuggestions).toMatchObject({
      vendor: null,
      purchasedAt: null,
      paymentMethod: null,
      vendorTaxNumber: null,
    });
  });

  it("keeps every amount that fits, verbatim, for the accuracy measurement", async () => {
    const row = await createdRow({
      ocrSuggestions: {
        totalCents: MAX_STORABLE_CENTS,
        hstCents: -500,
        subtotalCents: 0,
      },
    });

    expect(row.ocrSuggestions).toMatchObject({
      totalCents: MAX_STORABLE_CENTS,
      hstCents: -500,
      subtotalCents: 0,
    });
  });

  it("drops a fractional amount rather than storing a float", async () => {
    const row = await createdRow({ ocrSuggestions: { totalCents: 42.5 } });
    expect(row.ocrSuggestions).toMatchObject({ totalCents: null });
  });

  it("still refuses a value that is not a number: a broken client, not a bad read", async () => {
    expect(
      (await post({ ocrSuggestions: { totalCents: "1234" } })).status,
    ).toBe(400);
  });

  it("holds the human's own amount to the full rule", async () => {
    expect((await post({ totalCents: OVERFLOW })).status).toBe(400);
  });
});
