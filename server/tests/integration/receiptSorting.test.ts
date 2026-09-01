import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { receiptImages, receipts } from "../../src/db/schema.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * GET /api/receipts sorting (2026-08-26). Four keys, both directions, and a
 * keyset cursor that has to agree with whichever ordering it was minted
 * under - the two are one mechanism, and a page boundary that disagrees
 * with the ORDER BY silently drops or repeats rows.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

interface ListResponse {
  receipts: { id: string }[];
  nextCursor: string | null;
  pendingCount: number;
}

let token: string;
let userId: string;
/** Fixture label -> receipt id, so a null-vendor row is still nameable. */
let ids: Record<string, string>;

/**
 * Five receipts whose four sort keys each order them differently, including
 * one with no total and one with no vendor - the rows that decide where
 * "absent" goes.
 */
const FIXTURES = [
  {
    label: "alpha",
    purchasedAt: "2026-01-10",
    capturedAt: "2026-05-03T10:00:00Z",
    totalCents: 300,
    vendor: "Alpha",
  },
  {
    label: "bravo",
    purchasedAt: "2026-03-10",
    capturedAt: "2026-05-01T10:00:00Z",
    totalCents: 100,
    vendor: "Bravo",
  },
  {
    label: "charlie",
    purchasedAt: "2026-02-10",
    capturedAt: "2026-05-02T10:00:00Z",
    totalCents: 200,
    vendor: "Charlie",
  },
  {
    label: "no-total",
    purchasedAt: "2026-04-10",
    capturedAt: "2026-05-04T10:00:00Z",
    totalCents: null,
    vendor: "Zulu",
  },
  {
    label: "no-vendor",
    purchasedAt: "2026-05-10",
    capturedAt: "2026-05-05T10:00:00Z",
    totalCents: 400,
    vendor: null,
  },
] as const;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("sorting-user"));
  ids = {};
  for (const [index, fixture] of FIXTURES.entries()) {
    const { label, ...fields } = fixture;
    const body = receiptBody({
      ...fields,
      image: imageFor(userId, (index + 1).toString(16).padStart(64, "0")),
    });
    if (fields.totalCents === null) {
      // A null total is only storable while pending, which is exactly the
      // backlog row this case exists to place.
      delete (body as Record<string, unknown>).totalCents;
    }
    const response = await harness.request(token, "POST", "/api/receipts", body);
    expect(response.status).toBe(201);
    ids[label] = ((await response.json()) as { id: string }).id;
  }
});

async function list(query: string): Promise<string[]> {
  const response = await harness.request(token, "GET", `/api/receipts?${query}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as ListResponse;
  return body.receipts.map(labelOf);
}

/**
 * A cursor nobody's server minted, presented against the sort it names.
 * Cursors are opaque to clients, which is a promise about what they may
 * assume - not an assumption that only this server ever writes one.
 */
async function presentForged(cursor: {
  sort: string;
  order: string;
  sortKeyNull: boolean;
  sortKey: string | null;
}): Promise<Response> {
  const encoded = Buffer.from(
    JSON.stringify({
      ...cursor,
      createdAt: new Date().toISOString(),
      id: ids.alpha,
    }),
    "utf8",
  ).toString("base64url");
  return harness.request(
    token,
    "GET",
    `/api/receipts?sort=${cursor.sort}&order=${cursor.order}&cursor=${encodeURIComponent(encoded)}`,
  );
}

function labelOf(receipt: { id: string }): string {
  const found = Object.entries(ids).find(([, id]) => id === receipt.id);
  if (found === undefined) {
    throw new Error(`Listed a receipt no fixture created: ${receipt.id}`);
  }
  return found[0];
}

describe("GET /api/receipts sort", () => {
  it("orders by receipt date, newest first, when nothing is asked for", async () => {
    expect(await list("")).toEqual([
      "no-vendor",
      "no-total",
      "bravo",
      "charlie",
      "alpha",
    ]);
  });

  it("gives the explicit default the byte-identical ordering", async () => {
    // The default is not merely "some sensible order": it is the order the
    // shipped clients already page through, and asking for it by name must
    // not produce a different list.
    expect(await list("sort=purchasedAt&order=desc")).toEqual(await list(""));
  });

  it("orders by receipt date ascending", async () => {
    expect(await list("sort=purchasedAt&order=asc")).toEqual([
      "alpha",
      "charlie",
      "bravo",
      "no-total",
      "no-vendor",
    ]);
  });

  it("orders by capture date, which is a different order from receipt date", async () => {
    expect(await list("sort=capturedAt&order=desc")).toEqual([
      "no-vendor",
      "no-total",
      "alpha",
      "charlie",
      "bravo",
    ]);
    expect(await list("sort=capturedAt&order=asc")).toEqual([
      "bravo",
      "charlie",
      "alpha",
      "no-total",
      "no-vendor",
    ]);
  });

  it("orders by total, with the receipt that has none placed last either way", async () => {
    // An absent total is not a small one. Postgres's own default would put
    // it first under DESC and last under ASC, which makes "last" mean two
    // different rows depending on which arrow the person tapped.
    expect(await list("sort=total&order=desc")).toEqual([
      "no-vendor",
      "alpha",
      "charlie",
      "bravo",
      "no-total",
    ]);
    expect(await list("sort=total&order=asc")).toEqual([
      "bravo",
      "charlie",
      "alpha",
      "no-vendor",
      "no-total",
    ]);
  });

  it("orders by vendor, with the unreadable-vendor receipt last either way", async () => {
    expect(await list("sort=vendor&order=asc")).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "no-total",
      "no-vendor",
    ]);
    expect(await list("sort=vendor&order=desc")).toEqual([
      "no-total",
      "charlie",
      "bravo",
      "alpha",
      "no-vendor",
    ]);
  });

  it("rejects a sort key that is not a column anyone can sort by", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?sort=notes",
    );
    expect(response.status).toBe(400);
  });

  it("rejects a direction that is not asc or desc", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?order=sideways",
    );
    expect(response.status).toBe(400);
  });

  it("still reports the user-wide pending count whatever the sort", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?sort=total&order=asc&limit=1",
    );
    const body = (await response.json()) as ListResponse;
    expect(body.pendingCount).toBe(FIXTURES.length);
  });
});

describe("the list cursor under a sort", () => {
  /** Walks every page of one ordering and returns the labels in order. */
  async function pageThrough(query: string, limit: number): Promise<string[]> {
    const labels: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const suffix: string =
        cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const response = await harness.request(
        token,
        "GET",
        `/api/receipts?${query}&limit=${limit}${suffix}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as ListResponse;
      labels.push(...body.receipts.map(labelOf));
      cursor = body.nextCursor;
      if (cursor === null) {
        return labels;
      }
    }
    throw new Error("Paging did not terminate");
  }

  it.each([
    ["purchasedAt", "desc"],
    ["purchasedAt", "asc"],
    ["capturedAt", "desc"],
    ["total", "asc"],
    ["total", "desc"],
    ["vendor", "asc"],
    ["vendor", "desc"],
  ])("pages %s %s to exactly the unpaged order", async (sort, order) => {
    const query = `sort=${sort}&order=${order}`;
    expect(await pageThrough(query, 2)).toEqual(await list(query));
  });

  it("carries a page boundary across the divide into the keyless rows", async () => {
    // The boundary that a naive keyset gets wrong: page 2 of `total asc`
    // ends on the last row that HAS a total, so page 3 must be the row that
    // has none - not an empty page, and not that row repeated.
    const first = await harness.request(
      token,
      "GET",
      "/api/receipts?sort=total&order=asc&limit=4",
    );
    const firstPage = (await first.json()) as ListResponse;
    expect(firstPage.receipts.map(labelOf)).toEqual([
      "bravo",
      "charlie",
      "alpha",
      "no-vendor",
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const second = await harness.request(
      token,
      "GET",
      `/api/receipts?sort=total&order=asc&limit=4&cursor=${encodeURIComponent(firstPage.nextCursor as string)}`,
    );
    const secondPage = (await second.json()) as ListResponse;
    expect(secondPage.receipts.map(labelOf)).toEqual(["no-total"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("refuses a cursor presented against a different sort key", async () => {
    // Replaying it would hand back a slice of a list nobody asked for, and
    // it would look like data rather than like an error.
    const first = await harness.request(
      token,
      "GET",
      "/api/receipts?sort=total&order=desc&limit=2",
    );
    const cursor = ((await first.json()) as ListResponse).nextCursor as string;
    expect(cursor).not.toBeNull();

    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?sort=vendor&order=desc&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_request");
  });

  it("refuses a cursor presented against the opposite direction", async () => {
    const first = await harness.request(
      token,
      "GET",
      "/api/receipts?sort=total&order=desc&limit=2",
    );
    const cursor = ((await first.json()) as ListResponse).nextCursor as string;

    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?sort=total&order=asc&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(400);
  });

  it("refuses a cursor from the default sort when an explicit sort is asked for", async () => {
    const first = await harness.request(token, "GET", "/api/receipts?limit=2");
    const cursor = ((await first.json()) as ListResponse).nextCursor as string;

    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?sort=vendor&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(400);
  });

  it("accepts its own cursor replayed against the sort it names", async () => {
    // The over-refusing direction: a rule that compared the raw query
    // strings would reject this, since the first request never spelled the
    // default out.
    const first = await harness.request(token, "GET", "/api/receipts?limit=2");
    const cursor = ((await first.json()) as ListResponse).nextCursor as string;

    const response = await harness.request(
      token,
      "GET",
      `/api/receipts?sort=purchasedAt&order=desc&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ListResponse;
    expect(body.receipts.map(labelOf)).toEqual(["bravo", "charlie"]);
  });

  it("still rejects a junk cursor with 400", async () => {
    const response = await harness.request(
      token,
      "GET",
      "/api/receipts?cursor=%21%21not-a-cursor",
    );
    expect(response.status).toBe(400);
  });

  it("rejects a well-formed cursor whose sort key contradicts its null flag", async () => {
    // A hand-crafted cursor is still client input. This one would otherwise
    // reach the keyset comparison with two incompatible answers to "did the
    // last row have a value?".
    const response = await presentForged({
      sort: "total",
      order: "desc",
      sortKeyNull: true,
      sortKey: "100",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a cursor claiming a keyless row on a column that has no keyless rows", async () => {
    const response = await presentForged({
      sort: "purchasedAt",
      order: "desc",
      sortKeyNull: true,
      sortKey: null,
    });
    expect(response.status).toBe(400);
  });

  /**
   * The route casts a cursor's sort key back to the sorted column's own type
   * inside the query (`::date`, `::timestamptz`, `::integer`). A key that
   * cannot be cast is client junk, and Postgres finding it mid-SELECT makes
   * it a 500 - so the shape of the key is checked at decode time, where the
   * answer is the 400 every other malformed cursor already gets.
   */
  it.each([
    ["total", "abc", "not a number at all"],
    ["total", "1e9", "a float literal Number() would have accepted"],
    ["total", " 12", "a padded number Number() would have accepted"],
    ["total", "999999999999", "past the storable cents range"],
    ["purchasedAt", "not-a-date", "not a date at all"],
    ["purchasedAt", "2026-02-30", "a date that is not on any calendar"],
    ["capturedAt", "yesterday", "not a timestamp"],
    ["vendor", "v".repeat(201), "longer than the column allows"],
  ])(
    "refuses a %s cursor whose key is %s (%s) with 400, never 500",
    async (sort, sortKey) => {
      const response = await presentForged({
        sort,
        order: "desc",
        sortKeyNull: false,
        sortKey,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_request");
    },
  );

  it("still continues a page from a cursor the server itself minted", async () => {
    // The over-refusing direction: a key check that was too strict would
    // reject the server's own cursors and end pagination at page one.
    const first = await harness.request(
      token,
      "GET",
      "/api/receipts?sort=total&order=desc&limit=2",
    );
    const cursor = ((await first.json()) as ListResponse).nextCursor as string;
    expect(cursor).not.toBeNull();

    const second = await harness.request(
      token,
      "GET",
      `/api/receipts?sort=total&order=desc&limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as ListResponse;
    expect(body.receipts.map(labelOf)).toEqual(["charlie", "bravo"]);
  });

  /**
   * Case-insensitive vendor sorting (2026-09-01): the route sorts and
   * compares by `lower(vendor)` rather than by the raw column, so the order
   * does not depend on the collation the database was created with (see
   * LIST_SORTS.vendor's comment - `C` puts every capital first, `en_US.utf8`
   * already folds case, and both are ordinary setups).
   *
   * ⚠ **A note on what this suite can and cannot prove here.** The
   * docker-compose database is `en_US.utf8`, so `ORDER BY vendor` and
   * `ORDER BY lower(vendor)` already agree on the ordering cases below -
   * asserting the order alone would pass against either implementation. The
   * property that is genuinely under test, and that a page boundary
   * actually depends on, is that the ORDER BY and the keyset comparison use
   * the SAME expression: every case pages at a limit small enough to put a
   * boundary between two vendors that differ only in case, including the
   * pair `lower()` makes exactly EQUAL, where the keyset has to fall
   * through to the (created_at, id) tiebreak or drop a row.
   */
  describe("vendor sorting, case-insensitively", () => {
    /**
     * Mixed capitalisation, including two spellings of one vendor -
     * "Apple" and "apple" are one string to `lower()` and two to the raw
     * column, which is the boundary the keyset has to survive.
     */
    const MIXED_CASE = [
      "amazon",
      "apple",
      "Apple",
      "BEST BUY",
      "costco",
      "Dell",
    ];

    /**
     * ⚠ The order of "apple" before "Apple" in the array above is load
     * bearing, and it is what makes this suite discriminating on an
     * `en_US.utf8` database. Each fixture is stamped with a `created_at` in
     * array order, oldest first, so "apple" is the OLDER of the pair:
     *
     *   - `ORDER BY vendor` (en_US) makes case a tertiary difference and
     *     puts the lowercase one first: apple, then Apple.
     *   - `ORDER BY lower(vendor)` makes them EQUAL, so the (created_at, id)
     *     DESC tiebreak decides - newest first: Apple, then apple.
     *
     * Reverse the pair and the two agree again, which is exactly the trap
     * this comment exists to stop a later edit walking into.
     */
    async function captureMixedCase(): Promise<void> {
      // The fixture receipts are cleared first: this suite is about vendor
      // order alone, and five extra rows would only make the expectations
      // harder to read.
      await harness.db.delete(receiptImages);
      await harness.db.delete(receipts);
      ids = {};
      for (const [index, vendor] of MIXED_CASE.entries()) {
        const response = await harness.request(token, "POST", "/api/receipts", {
          ...receiptBody({ vendor }),
          image: imageFor(userId, `c${String(index)}`.padStart(64, "0")),
        });
        expect(response.status).toBe(201);
        const id = ((await response.json()) as { id: string }).id;
        ids[vendor] = id;
        // Stamped rather than relied upon: two HTTP round-trips are
        // microseconds apart, and an ordering that leans on that is a flake.
        await harness.db
          .update(receipts)
          .set({ createdAt: new Date(Date.UTC(2026, 7, 26, 9, index, 0)) })
          .where(eq(receipts.id, id));
      }
    }

    async function vendorsOf(query: string): Promise<string[]> {
      const response = await harness.request(
        token,
        "GET",
        `/api/receipts?${query}`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        receipts: { vendor: string | null }[];
      };
      return body.receipts.map((receipt) => receipt.vendor ?? "(none)");
    }

    beforeEach(captureMixedCase);

    it("groups vendors by lower(vendor), whatever their capitalisation", async () => {
      // What a `C`-collation database would give from the raw column:
      // ["Apple", "BEST BUY", "Dell", "amazon", "apple", "costco"] - every
      // capital ahead of every lowercase, the two Apples split apart.
      const ascending = await vendorsOf("sort=vendor&order=asc");
      expect(ascending.map((vendor) => vendor.toLowerCase())).toEqual([
        "amazon",
        "apple",
        "apple",
        "best buy",
        "costco",
        "dell",
      ]);
      const descending = await vendorsOf("sort=vendor&order=desc");
      expect(descending.map((vendor) => vendor.toLowerCase())).toEqual([
        "dell",
        "costco",
        "best buy",
        "apple",
        "apple",
        "amazon",
      ]);
    });

    it("treats two spellings of one vendor as tied, breaking on recency", async () => {
      // The case that separates `lower(vendor)` from the raw column on an
      // en_US database (see captureMixedCase's comment): the pair is EQUAL,
      // so the (created_at, id) DESC tiebreak orders it - newest first -
      // rather than the collation's lowercase-first tertiary rule.
      expect(await vendorsOf("sort=vendor&order=asc")).toEqual([
        "amazon",
        "Apple",
        "apple",
        "BEST BUY",
        "costco",
        "Dell",
      ]);
    });

    it("carries a page boundary that falls between two spellings of one vendor", async () => {
      // Page two ends on one of the two Apples - which `lower()` makes
      // EQUAL to the other, so the keyset can only get past it via the
      // (created_at, id) tiebreak. A comparison on the raw column would
      // repeat or drop the second one.
      const pages: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const suffix: string =
          cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
        const response = await harness.request(
          token,
          "GET",
          `/api/receipts?sort=vendor&order=asc&limit=2${suffix}`,
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          receipts: { vendor: string }[];
          nextCursor: string | null;
        };
        pages.push(...body.receipts.map((r) => r.vendor));
        cursor = body.nextCursor;
        if (cursor === null) {
          break;
        }
      }
      // Every fixture exactly once, in the unpaged order.
      expect([...pages].sort()).toEqual([...MIXED_CASE].sort());
      expect(pages).toEqual(await vendorsOf("sort=vendor&order=asc"));
    });

    it.each([1, 2, 3])(
      "pages the whole list at limit %i to exactly the unpaged order",
      async (limit) => {
        for (const order of ["asc", "desc"] as const) {
          const query = `sort=vendor&order=${order}`;
          const labels: string[] = [];
          let cursor: string | null = null;
          for (let page = 0; page < 20; page += 1) {
            const suffix: string =
              cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
            const response = await harness.request(
              token,
              "GET",
              `/api/receipts?${query}&limit=${String(limit)}${suffix}`,
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
              receipts: { vendor: string }[];
              nextCursor: string | null;
            };
            labels.push(...body.receipts.map((r) => r.vendor));
            cursor = body.nextCursor;
            if (cursor === null) {
              break;
            }
          }
          expect(labels).toEqual(await vendorsOf(query));
        }
      },
    );

    it("still places a vendorless receipt last in both directions", async () => {
      const response = await harness.request(token, "POST", "/api/receipts", {
        ...receiptBody({ vendor: null }),
        image: imageFor(userId, "e".repeat(64)),
      });
      expect(response.status).toBe(201);

      expect((await vendorsOf("sort=vendor&order=asc")).at(-1)).toBe("(none)");
      expect((await vendorsOf("sort=vendor&order=desc")).at(-1)).toBe("(none)");
    });
  });

  it("keeps a sorted page inside the caller's own receipts", async () => {
    const other = await harness.signIn("sorting-other-user");
    const response = await harness.request(other.token, "POST", "/api/receipts", {
      ...receiptBody({ vendor: "Someone Else", totalCents: 9999 }),
      image: imageFor(other.userId, "f".repeat(64)),
    });
    expect(response.status).toBe(201);

    // labelOf throws on any row no fixture of this user created, so a leak
    // fails here rather than passing as an extra entry.
    expect(await list("sort=total&order=desc")).toHaveLength(FIXTURES.length);
  });
});
