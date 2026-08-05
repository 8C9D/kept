import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listExportableReceipts } from "../../src/db/receiptQueries.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

/**
 * listExportableReceipts is the query wave 2's export generation must build
 * on. The exclusions proven here are the gate's "nothing pending or deleted
 * can reach an accountant" property.
 */
describe("listExportableReceipts", () => {
  let token: string;
  let userId: string;

  const YEAR_2026 = { start: "2026-01-01", end: "2026-12-31" };

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token, userId } = await harness.signIn("export-user"));
  });

  async function createReceipt(fields: Record<string, unknown>, sha: string) {
    const response = await harness.request(token, "POST", "/api/receipts",
      receiptBody({ image: imageFor(userId, sha.repeat(32)), ...fields }),
    );
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
  }

  it("includes only confirmed receipts - pending never exports", async () => {
    await createReceipt({ vendor: "Confirmed", status: "confirmed" }, "0a");
    await createReceipt({ vendor: "Pending", status: "pending" }, "0b");
    await createReceipt({ vendor: "Defaulted" }, "0c"); // status omitted → pending

    const rows = await listExportableReceipts(harness.db, userId, YEAR_2026);
    expect(rows.map((r) => r.vendor)).toEqual(["Confirmed"]);
  });

  it("excludes soft-deleted receipts even when confirmed", async () => {
    const kept = await createReceipt(
      { vendor: "Kept", status: "confirmed" },
      "0d",
    );
    const deleted = await createReceipt(
      { vendor: "Deleted", status: "confirmed" },
      "0e",
    );
    await harness.request(token, "DELETE", `/api/receipts/${deleted.id}`);

    const rows = await listExportableReceipts(harness.db, userId, YEAR_2026);
    expect(rows.map((r) => r.id)).toEqual([kept.id]);
  });

  it("excludes other users' receipts", async () => {
    await createReceipt({ vendor: "Mine", status: "confirmed" }, "0f");
    const other = await harness.signIn("other-export-user");
    const theirs = await harness.request(other.token, "POST", "/api/receipts",
      receiptBody({
        status: "confirmed",
        image: imageFor(other.userId, "1a".repeat(32)),
      }),
    );
    expect(theirs.status).toBe(201);

    const rows = await listExportableReceipts(harness.db, userId, YEAR_2026);
    expect(rows.map((r) => r.vendor)).toEqual(["Mine"]);
  });

  it("respects the period bounds inclusively", async () => {
    await createReceipt(
      { vendor: "LastYear", status: "confirmed", purchasedAt: "2025-12-31" },
      "1b",
    );
    await createReceipt(
      { vendor: "JanFirst", status: "confirmed", purchasedAt: "2026-01-01" },
      "1c",
    );
    await createReceipt(
      { vendor: "DecLast", status: "confirmed", purchasedAt: "2026-12-31" },
      "1d",
    );
    await createReceipt(
      { vendor: "NextYear", status: "confirmed", purchasedAt: "2027-01-01" },
      "1e",
    );

    const rows = await listExportableReceipts(harness.db, userId, YEAR_2026);
    expect(rows.map((r) => r.vendor)).toEqual(["JanFirst", "DecLast"]);
  });
});
