import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receipts } from "../../src/db/schema.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * GET /api/receipts/options - the values this person has used before, so
 * neither client has to ask them to retype "office supplies" for the
 * fortieth time (2026-08-26), or "Staples #4021" for the fortieth time
 * (2026-08-28, `vendors`). Category and payment method stay free text;
 * vendor stays a transcription. What changes is that the free text they
 * already wrote is offered back.
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
  ({ token, userId } = await harness.signIn("options-user"));
});

let shaCounter = 0;

/**
 * Creates through the real route, then stamps `created_at` so recency is a
 * fixture rather than a race: two HTTP round-trips are microseconds apart,
 * and an ordering test that leans on that is a flake waiting to happen.
 */
async function capture(
  sessionToken: string,
  owner: string,
  fields: Record<string, unknown>,
  createdAt?: Date,
): Promise<string> {
  shaCounter += 1;
  const sha = shaCounter.toString(16).padStart(64, "0");
  const response = await harness.request(sessionToken, "POST", "/api/receipts", {
    ...receiptBody(fields),
    image: imageFor(owner, sha),
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  if (createdAt !== undefined) {
    await harness.db
      .update(receipts)
      .set({ createdAt })
      .where(eq(receipts.id, id));
  }
  return id;
}

function at(minute: number): Date {
  return new Date(Date.UTC(2026, 7, 26, 9, minute, 0));
}

describe("GET /api/receipts/options", () => {
  it("serves the user's own past categories, payment methods and vendors", async () => {
    await capture(token, userId, {
      category: "groceries",
      paymentMethod: "cash",
      vendor: "Loblaws",
    });
    await capture(token, userId, {
      category: "office supplies",
      paymentMethod: "visa",
      vendor: "Staples",
    });

    const response = await harness.request(token, "GET", "/api/receipts/options");
    expect(response.status).toBe(200);
    const body = (await response.json()) as OptionsResponse;
    expect([...body.categories].sort()).toEqual([
      "groceries",
      "office supplies",
    ]);
    expect([...body.paymentMethods].sort()).toEqual(["cash", "visa"]);
    expect([...body.vendors].sort()).toEqual(["Loblaws", "Staples"]);
  });

  it("orders each list by most recent use, not alphabetically", async () => {
    // What someone used yesterday is what they are most likely to use
    // again; alphabetical order buries it under a year of one-offs.
    await capture(token, userId, { category: "groceries", paymentMethod: "cash", vendor: "Loblaws" }, at(1));
    await capture(token, userId, { category: "office supplies", paymentMethod: "visa", vendor: "Staples" }, at(2));
    // Re-using "groceries" (and Loblaws) later moves both back to the front...
    await capture(token, userId, { category: "groceries", paymentMethod: "cash", vendor: "Loblaws" }, at(3));
    await capture(token, userId, { category: null, paymentMethod: "visa", vendor: null }, at(4));
    await capture(token, userId, { category: "fuel", paymentMethod: null, vendor: "Shell" }, at(5));

    const body = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(body.categories).toEqual(["fuel", "groceries", "office supplies"]);
    expect(body.paymentMethods).toEqual(["visa", "cash"]);
    expect(body.vendors).toEqual(["Shell", "Loblaws", "Staples"]);
  });

  it("counts a value typed on a receipt that is still pending", async () => {
    // A category chosen at capture is a category the person chose, whether
    // or not they have got round to confirming the receipt.
    const body = receiptBody({ category: "pending category", vendor: "Pending Vendor" });
    delete (body as Record<string, unknown>).totalCents;
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...body,
      image: imageFor(userId, "aa".repeat(32)),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { status: string }).status).toBe("pending");

    const options = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(options.categories).toEqual(["pending category"]);
    expect(options.vendors).toEqual(["Pending Vendor"]);
  });

  it("forgets a value that survives only on a deleted receipt", async () => {
    await capture(token, userId, { category: "kept", vendor: "Kept Vendor" });
    const removed = await capture(token, userId, { category: "removed", vendor: "Removed Vendor" });
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${removed}`)).status,
    ).toBe(204);

    const options = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(options.categories).toEqual(["kept"]);
    expect(options.vendors).toEqual(["Kept Vendor"]);
  });

  it("never shows one user the values another user typed", async () => {
    await capture(token, userId, { category: "mine", paymentMethod: "my card", vendor: "My Vendor" });
    const other = await harness.signIn("options-other-user");
    await capture(other.token, other.userId, {
      category: "theirs",
      paymentMethod: "their card",
      vendor: "Their Vendor",
    });

    const mine = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(mine.categories).toEqual(["mine"]);
    expect(mine.paymentMethods).toEqual(["my card"]);
    expect(mine.vendors).toEqual(["My Vendor"]);

    const theirs = (await (
      await harness.request(other.token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(theirs.categories).toEqual(["theirs"]);
    expect(theirs.paymentMethods).toEqual(["their card"]);
    expect(theirs.vendors).toEqual(["Their Vendor"]);
  });

  it("answers empty lists for someone who has captured nothing", async () => {
    const body = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(body).toEqual({
      categories: [],
      paymentMethods: [],
      vendors: [],
      vendorDefaults: {},
    });
  });

  it("hands back the free text unnormalized, doubled spaces and all", async () => {
    // The 2026-08-26 ruling on the second user's doubled-space category: these are the
    // person's own values. A list that tidied them would also stop matching
    // the exact-match filter it exists to feed. Vendor is a transcription
    // rather than a chosen label, but the same rule applies (2026-08-28).
    await capture(token, userId, {
      category: "  Office   Supplies  ",
      vendor: "  Staples  #4021  ",
    });
    const body = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(body.categories).toEqual(["  Office   Supplies  "]);
    expect(body.vendors).toEqual(["  Staples  #4021  "]);
  });

  it("is reachable as a literal path, not swallowed by the /:id route", async () => {
    // GET /api/receipts/:id answers 404 to anything that is not a uuid, so
    // a route order that let it match first would turn this endpoint into a
    // permanent 404 with nothing else failing.
    const response = await harness.request(token, "GET", "/api/receipts/options");
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("categories");
  });

  it("refuses without a session", async () => {
    const response = await harness.request(null, "GET", "/api/receipts/options");
    expect(response.status).toBe(401);
  });
});

/**
 * GET /api/receipts/options's `vendorDefaults` (proposal #2, 2026-08-28):
 * per vendor, the category and payment method to prefill from that
 * vendor's history. Confirmed-only, deliberately - see
 * `vendorDefaultCandidates`'s own comment in routes/receipts.ts for why
 * that differs from `vendors`/`categories`/`paymentMethods` above, which
 * count a pending receipt's value on purpose.
 */
describe("GET /api/receipts/options vendorDefaults", () => {
  it("sources a default from the vendor's most recent confirmed receipt", async () => {
    await capture(
      token,
      userId,
      { vendor: "Loblaws", category: "groceries", paymentMethod: "cash", status: "confirmed" },
      at(1),
    );
    await capture(
      token,
      userId,
      { vendor: "Loblaws", category: "household", paymentMethod: "visa", status: "confirmed" },
      at(2),
    );

    const options = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(options.vendorDefaults.Loblaws).toEqual({
      category: "household",
      paymentMethod: "visa",
    });
  });

  it("selects category and payment method independently, each from its own most recent qualifying receipt", async () => {
    // The most recent Loblaws receipt sets a payment method but leaves
    // category blank; an older one had a category. The default for each
    // field comes from the most recent receipt THAT HAS that field, not
    // from one single "most recent receipt" for the vendor.
    await capture(
      token,
      userId,
      { vendor: "Loblaws", category: "groceries", paymentMethod: null, status: "confirmed" },
      at(1),
    );
    await capture(
      token,
      userId,
      { vendor: "Loblaws", category: null, paymentMethod: "debit", status: "confirmed" },
      at(2),
    );

    const options = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(options.vendorDefaults.Loblaws).toEqual({
      category: "groceries",
      paymentMethod: "debit",
    });
  });

  it("is absent for a vendor that only has pending receipts", async () => {
    // A pending receipt's category may be an unreviewed guess - it counts
    // toward the /options pick-list (this file's tests above), but never
    // sources a default that prefills a DIFFERENT receipt sight unseen.
    const body = receiptBody({
      vendor: "Pending Vendor",
      category: "guessed category",
      paymentMethod: "guessed method",
    });
    delete (body as Record<string, unknown>).totalCents;
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...body,
      image: imageFor(userId, "bb".repeat(32)),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { status: string }).status).toBe("pending");

    const options = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(options.vendors).toContain("Pending Vendor");
    expect(options.vendorDefaults).not.toHaveProperty("Pending Vendor");
  });

  it("is absent for a vendor whose confirmed receipts never set category or payment method", async () => {
    await capture(
      token,
      userId,
      { vendor: "Bare Vendor", category: null, paymentMethod: null, status: "confirmed" },
    );

    const options = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(options.vendors).toContain("Bare Vendor");
    expect(options.vendorDefaults).not.toHaveProperty("Bare Vendor");
  });

  it("excludes a soft-deleted receipt from sourcing a default", async () => {
    await capture(
      token,
      userId,
      { vendor: "Staples", category: "office supplies", paymentMethod: "visa", status: "confirmed" },
      at(1),
    );
    const laterButDeleted = await capture(
      token,
      userId,
      { vendor: "Staples", category: "electronics", paymentMethod: "amex", status: "confirmed" },
      at(2),
    );
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${laterButDeleted}`)).status,
    ).toBe(204);

    const options = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(options.vendorDefaults.Staples).toEqual({
      category: "office supplies",
      paymentMethod: "visa",
    });
  });

  it("never sources one user's default from another user's receipts", async () => {
    await capture(
      token,
      userId,
      { vendor: "Shared Name Co", category: "mine", paymentMethod: "my card", status: "confirmed" },
    );
    const other = await harness.signIn("vendor-defaults-other-user");
    await capture(
      other.token,
      other.userId,
      { vendor: "Shared Name Co", category: "theirs", paymentMethod: "their card", status: "confirmed" },
    );

    const mine = (await (
      await harness.request(token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(mine.vendorDefaults["Shared Name Co"]).toEqual({
      category: "mine",
      paymentMethod: "my card",
    });

    const theirs = (await (
      await harness.request(other.token, "GET", "/api/receipts/options")
    ).json()) as OptionsResponse;
    expect(theirs.vendorDefaults["Shared Name Co"]).toEqual({
      category: "theirs",
      paymentMethod: "their card",
    });
  });
});
