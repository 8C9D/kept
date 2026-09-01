import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receiptFieldOptions, receipts } from "../../src/db/schema.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * PATCH and DELETE on /api/receipts/options/:field (2026-09-01): renaming a
 * remembered value everywhere it appears, and forgetting one without
 * touching the receipts that carry it.
 *
 * The two exist because until this date the vocabulary was derived from
 * `receipts` and could not be edited at all: a vendor transcribed as
 * "Loblwas" on eleven receipts was eleven edits, and the misspelling went on
 * offering itself back the whole time.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

interface OptionsResponse {
  categories: string[];
  paymentMethods: string[];
  vendors: string[];
  vendorDefaults: Record<
    string,
    { category: string | null; paymentMethod: string | null }
  >;
}

let token: string;
let userId: string;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("option-editing-user"));
});

let shaCounter = 0;

async function capture(
  sessionToken: string,
  owner: string,
  fields: Record<string, unknown>,
): Promise<string> {
  shaCounter += 1;
  const sha = shaCounter.toString(16).padStart(64, "0");
  const response = await harness.request(sessionToken, "POST", "/api/receipts", {
    ...receiptBody(fields),
    image: imageFor(owner, sha),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function optionsFor(sessionToken: string): Promise<OptionsResponse> {
  const response = await harness.request(
    sessionToken,
    "GET",
    "/api/receipts/options",
  );
  expect(response.status).toBe(200);
  return (await response.json()) as OptionsResponse;
}

/** One receipt's stored column, read straight out of the table. */
async function storedVendor(id: string): Promise<string | null> {
  const rows = await harness.db
    .select({ vendor: receipts.vendor })
    .from(receipts)
    .where(eq(receipts.id, id));
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No receipt ${id}`);
  }
  return row.vendor;
}

describe("PATCH /api/receipts/options/:field", () => {
  it("renames the option and every receipt carrying it", async () => {
    const first = await capture(token, userId, { vendor: "Loblwas" });
    const second = await capture(token, userId, { vendor: "Loblwas" });
    const untouched = await capture(token, userId, { vendor: "Staples" });

    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "Loblwas", to: "Loblaws" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receiptsUpdated: 2 });

    expect(await storedVendor(first)).toBe("Loblaws");
    expect(await storedVendor(second)).toBe("Loblaws");
    expect(await storedVendor(untouched)).toBe("Staples");

    const options = await optionsFor(token);
    expect([...options.vendors].sort()).toEqual(["Loblaws", "Staples"]);
  });

  it("renames a category and a payment method the same way", async () => {
    const receipt = await capture(token, userId, {
      category: "grocries",
      paymentMethod: "vsa",
    });

    expect(
      (
        await harness.request(token, "PATCH", "/api/receipts/options/category", {
          from: "grocries",
          to: "groceries",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.request(
          token,
          "PATCH",
          "/api/receipts/options/paymentMethod",
          { from: "vsa", to: "visa" },
        )
      ).status,
    ).toBe(200);

    const options = await optionsFor(token);
    expect(options.categories).toEqual(["groceries"]);
    expect(options.paymentMethods).toEqual(["visa"]);

    const rows = await harness.db
      .select({
        category: receipts.category,
        paymentMethod: receipts.paymentMethod,
      })
      .from(receipts)
      .where(eq(receipts.id, receipt));
    expect(rows[0]).toEqual({ category: "groceries", paymentMethod: "visa" });
  });

  /**
   * The rewrite deliberately does NOT use `visibleTo`: a soft-deleted
   * receipt is a retained record that can come back through
   * POST /:id/restore, and one restored after a rename must not reintroduce
   * the misspelling the person removed.
   */
  it("rewrites pending, confirmed and soft-deleted receipts alike", async () => {
    const pending = await capture(token, userId, { vendor: "Loblwas" });
    const confirmed = await capture(token, userId, {
      vendor: "Loblwas",
      status: "confirmed",
    });
    const deleted = await capture(token, userId, { vendor: "Loblwas" });
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${deleted}`)).status,
    ).toBe(204);

    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "Loblwas", to: "Loblaws" },
    );
    expect(await response.json()).toEqual({ receiptsUpdated: 3 });

    expect(await storedVendor(pending)).toBe("Loblaws");
    expect(await storedVendor(confirmed)).toBe("Loblaws");
    expect(await storedVendor(deleted)).toBe("Loblaws");

    // And the restored receipt carries the corrected name, which is the
    // point of including tombstoned rows.
    expect(
      (await harness.request(token, "POST", `/api/receipts/${deleted}/restore`))
        .status,
    ).toBe(200);
    expect(await storedVendor(deleted)).toBe("Loblaws");
  });

  it("merges into an existing option rather than colliding with it", async () => {
    const typo = await capture(token, userId, { vendor: "Loblwas" });
    const correct = await capture(token, userId, { vendor: "Loblaws" });

    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "Loblwas", to: "Loblaws" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receiptsUpdated: 1 });

    // One row survives, not two, and the unique constraint was never hit.
    const rows = await harness.db
      .select()
      .from(receiptFieldOptions)
      .where(
        and(
          eq(receiptFieldOptions.userId, userId),
          eq(receiptFieldOptions.field, "vendor"),
        ),
      );
    expect(rows.map((row) => row.value)).toEqual(["Loblaws"]);
    expect(await storedVendor(typo)).toBe("Loblaws");
    expect(await storedVendor(correct)).toBe("Loblaws");
  });

  it("keeps the later recency when two options merge", async () => {
    // The typo was used most recently; the merged value inherits that,
    // because the value it now stands for genuinely was used then.
    await harness.db.insert(receiptFieldOptions).values([
      {
        userId,
        field: "category",
        value: "old spelling",
        lastUsedAt: new Date(Date.UTC(2026, 7, 30)),
      },
      {
        userId,
        field: "category",
        value: "new spelling",
        lastUsedAt: new Date(Date.UTC(2026, 7, 1)),
      },
    ]);

    expect(
      (
        await harness.request(token, "PATCH", "/api/receipts/options/category", {
          from: "old spelling",
          to: "new spelling",
        })
      ).status,
    ).toBe(200);

    const rows = await harness.db
      .select()
      .from(receiptFieldOptions)
      .where(eq(receiptFieldOptions.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("new spelling");
    expect(rows[0]?.lastUsedAt).toEqual(new Date(Date.UTC(2026, 7, 30)));
  });

  it("answers 200 with zero for a rename to the same value", async () => {
    await capture(token, userId, { vendor: "Loblaws" });
    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "Loblaws", to: "Loblaws" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receiptsUpdated: 0 });
    expect((await optionsFor(token)).vendors).toEqual(["Loblaws"]);
  });

  it("matches the stored value verbatim, doubled spaces and all", async () => {
    // The 2026-08-26 free-text ruling: `from` names a value that is already
    // stored. Trimming it would make exactly the values most in need of a
    // rename the ones that cannot be renamed.
    const receipt = await capture(token, userId, {
      category: "  Office   Supplies  ",
    });
    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/category",
      { from: "  Office   Supplies  ", to: "Office Supplies" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receiptsUpdated: 1 });
    expect((await optionsFor(token)).categories).toEqual(["Office Supplies"]);

    const rows = await harness.db
      .select({ category: receipts.category })
      .from(receipts)
      .where(eq(receipts.id, receipt));
    expect(rows[0]?.category).toBe("Office Supplies");
  });

  it("404s an option this user does not have", async () => {
    await capture(token, userId, { vendor: "Loblaws" });
    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "Never Used", to: "Something" },
    );
    expect(response.status).toBe(404);
  });

  it("400s a field that is not one of the three", async () => {
    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/notes",
      { from: "a", to: "b" },
    );
    expect(response.status).toBe(400);
  });

  it("400s an empty or whitespace-only rename target", async () => {
    await capture(token, userId, { vendor: "Loblaws" });
    for (const to of ["", "   "]) {
      const response = await harness.request(
        token,
        "PATCH",
        "/api/receipts/options/vendor",
        { from: "Loblaws", to },
      );
      expect(response.status).toBe(400);
    }
  });

  it("400s a rename target longer than the receipt column allows", async () => {
    await capture(token, userId, { paymentMethod: "visa" });
    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/paymentMethod",
      { from: "visa", to: "v".repeat(101) },
    );
    expect(response.status).toBe(400);
  });

  it("400s an unexpected key, like every other schema here", async () => {
    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "a", to: "b", userId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(response.status).toBe(400);
  });

  it("refuses without a session", async () => {
    const response = await harness.request(
      null,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "a", to: "b" },
    );
    expect(response.status).toBe(401);
  });

  it("never renames another user's option or another user's receipts", async () => {
    const mine = await capture(token, userId, { vendor: "Shared Name Co" });
    const other = await harness.signIn("option-editing-other-user");
    const theirs = await capture(other.token, other.userId, {
      vendor: "Shared Name Co",
    });

    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "Shared Name Co", to: "Renamed Co" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receiptsUpdated: 1 });

    expect(await storedVendor(mine)).toBe("Renamed Co");
    expect(await storedVendor(theirs)).toBe("Shared Name Co");
    expect((await optionsFor(token)).vendors).toEqual(["Renamed Co"]);
    expect((await optionsFor(other.token)).vendors).toEqual(["Shared Name Co"]);
  });

  it("404s rather than reaching across accounts for an option it cannot see", async () => {
    const other = await harness.signIn("option-editing-stranger");
    await capture(other.token, other.userId, { vendor: "Theirs Only" });

    const response = await harness.request(
      token,
      "PATCH",
      "/api/receipts/options/vendor",
      { from: "Theirs Only", to: "Mine Now" },
    );
    expect(response.status).toBe(404);
    expect((await optionsFor(other.token)).vendors).toEqual(["Theirs Only"]);
  });
});

describe("DELETE /api/receipts/options/:field", () => {
  it("forgets the option and leaves every receipt alone", async () => {
    const receipt = await capture(token, userId, { category: "one-off" });

    const response = await harness.request(
      token,
      "DELETE",
      "/api/receipts/options/category?value=one-off",
    );
    expect(response.status).toBe(204);
    expect((await optionsFor(token)).categories).toEqual([]);

    // The receipt is a retained tax record; "stop suggesting this" says
    // nothing about it.
    const rows = await harness.db
      .select({ category: receipts.category })
      .from(receipts)
      .where(eq(receipts.id, receipt));
    expect(rows[0]?.category).toBe("one-off");
  });

  it("re-adds the value when a later save uses it again", async () => {
    await capture(token, userId, { category: "one-off" });
    expect(
      (
        await harness.request(
          token,
          "DELETE",
          "/api/receipts/options/category?value=one-off",
        )
      ).status,
    ).toBe(204);
    expect((await optionsFor(token)).categories).toEqual([]);

    await capture(token, userId, { category: "one-off" });
    expect((await optionsFor(token)).categories).toEqual(["one-off"]);
  });

  it("404s a value this user never used", async () => {
    const response = await harness.request(
      token,
      "DELETE",
      "/api/receipts/options/category?value=never",
    );
    expect(response.status).toBe(404);
  });

  it("400s a missing or empty value", async () => {
    expect(
      (await harness.request(token, "DELETE", "/api/receipts/options/category"))
        .status,
    ).toBe(400);
    expect(
      (
        await harness.request(
          token,
          "DELETE",
          "/api/receipts/options/category?value=",
        )
      ).status,
    ).toBe(400);
  });

  it("400s a field that is not one of the three", async () => {
    const response = await harness.request(
      token,
      "DELETE",
      "/api/receipts/options/notes?value=x",
    );
    expect(response.status).toBe(400);
  });

  it("refuses without a session", async () => {
    const response = await harness.request(
      null,
      "DELETE",
      "/api/receipts/options/category?value=x",
    );
    expect(response.status).toBe(401);
  });

  it("never deletes another user's option", async () => {
    await capture(token, userId, { category: "shared label" });
    const other = await harness.signIn("option-deleting-other-user");
    await capture(other.token, other.userId, { category: "shared label" });

    expect(
      (
        await harness.request(
          token,
          "DELETE",
          "/api/receipts/options/category?value=shared%20label",
        )
      ).status,
    ).toBe(204);

    expect((await optionsFor(token)).categories).toEqual([]);
    expect((await optionsFor(other.token)).categories).toEqual(["shared label"]);
  });
});
