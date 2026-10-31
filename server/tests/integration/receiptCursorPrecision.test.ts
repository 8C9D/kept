import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * `created_at` carries microseconds and a JavaScript Date does not.
 *
 * The list's cursor used to be written from the Date, so it named an instant
 * up to 999 microseconds earlier than its own row, and the keyset comparison
 * then dropped every row sharing that sort key and that millisecond. A batch
 * import through one transaction is exactly that shape. Nothing errors and
 * nothing is flagged: the receipts are simply absent from the list.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;
let shaCounter = 0;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("cursor-precision-user"));
});

async function create(fields: Record<string, unknown> = {}): Promise<string> {
  shaCounter += 1;
  const response = await harness.request(token, "POST", "/api/receipts", {
    ...receiptBody(fields),
    image: imageFor(userId, shaCounter.toString(16).padStart(64, "0")),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function setCreatedAt(id: string, timestamp: string): Promise<void> {
  await harness.db.execute(
    sql`update receipts set created_at = ${timestamp}::timestamptz where id = ${id}::uuid`,
  );
}

interface ListPage {
  receipts: { id: string }[];
  nextCursor: string | null;
}

/** Walks every page; bounded so a cursor that never ends fails, not hangs. */
async function walk(query: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const parts = [query, `limit=${limit}`];
    if (cursor !== null) {
      parts.push(`cursor=${encodeURIComponent(cursor)}`);
    }
    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?${parts.filter((part) => part !== "").join("&")}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListPage;
    seen.push(...body.receipts.map((receipt) => receipt.id));
    cursor = body.nextCursor;
    if (cursor === null) {
      return seen;
    }
  }
  throw new Error("Cursor walk did not terminate");
}

/** Five receipts sharing a sort key and a millisecond, newest first. */
async function sameMillisecondRows(
  fields: Record<string, unknown> = {},
): Promise<string[]> {
  const stamps = [
    "2026-08-16T12:00:00.123900Z",
    "2026-08-16T12:00:00.123700Z",
    "2026-08-16T12:00:00.123500Z",
    "2026-08-16T12:00:00.123300Z",
    "2026-08-16T12:00:00.123100Z",
  ];
  const ids: string[] = [];
  for (const stamp of stamps) {
    const id = await create(fields);
    await setCreatedAt(id, stamp);
    ids.push(id);
  }
  return ids;
}

describe("the list cursor keeps created_at's microseconds", () => {
  it.each([
    ["the default sort", "", { purchasedAt: "2026-03-15" }],
    ["sort=total", "sort=total", { totalCents: 500 }],
    ["sort=vendor", "sort=vendor", { vendor: "Same Vendor" }],
    ["sort=capturedAt", "sort=capturedAt", { capturedAt: "2026-03-15T18:30:00Z" }],
    // Null keys are the branch that compares on the tiebreak alone.
    ["a null-keyed group under sort=total", "sort=total", { totalCents: null }],
  ])("walks rows differing only in microseconds under %s", async (_name, query, fields) => {
    const expected = await sameMillisecondRows(fields);

    // Page size 1 puts a boundary between every pair of rows.
    expect(await walk(query, 1)).toEqual(expected);
    expect(await walk(query, 2)).toEqual(expected);
  });

  it("writes the row's own instant into the cursor, in full", async () => {
    const [newest] = await sameMillisecondRows();
    const response = await harness.request(token, "GET", "/api/receipts?limit=1");
    const body = (await response.json()) as ListPage;
    expect(body.receipts[0]?.id).toBe(newest);

    const cursor = JSON.parse(
      Buffer.from(body.nextCursor as string, "base64url").toString("utf8"),
    ) as { createdAt: string };
    expect(cursor.createdAt).toBe("2026-08-16T12:00:00.123900Z");
  });

  it("still decodes a cursor minted before this existed", async () => {
    // A phone can hold one across the deploy. It resumes exactly where it
    // always did, which is the point: it is honoured rather than refused.
    const older = await create();
    await setCreatedAt(older, "2026-08-16T11:00:00.000000Z");
    const newer = await create();
    await setCreatedAt(newer, "2026-08-16T13:00:00.000000Z");

    const legacyCursor = Buffer.from(
      JSON.stringify({
        sort: "purchasedAt",
        order: "desc",
        sortKeyNull: false,
        sortKey: "2026-03-15",
        createdAt: "2026-08-16T12:00:00.123Z",
        id: randomUUID(),
      }),
      "utf8",
    ).toString("base64url");

    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?cursor=${encodeURIComponent(legacyCursor)}`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as ListPage;
    expect(body.receipts.map((receipt) => receipt.id)).toEqual([older]);
  });
});
