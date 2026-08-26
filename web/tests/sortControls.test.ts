import { describe, expect, it } from "vitest";
import { describeOrder } from "../src/views/ReceiptsTable.js";

/**
 * The sort controls pass `sort` and `order` straight to the server; the
 * one thing this client decides is what the order button says, and "newest
 * first" is wrong on a vendor column.
 */
describe("describeOrder", () => {
  it("speaks of time for the two date keys", () => {
    expect(describeOrder("purchasedAt", "desc")).toContain("newest first");
    expect(describeOrder("purchasedAt", "asc")).toContain("oldest first");
    expect(describeOrder("capturedAt", "desc")).toContain("newest first");
  });

  it("speaks of size for the total and of letters for the vendor", () => {
    expect(describeOrder("total", "desc")).toContain("largest first");
    expect(describeOrder("total", "asc")).toContain("smallest first");
    expect(describeOrder("vendor", "asc")).toContain("A to Z");
    expect(describeOrder("vendor", "desc")).toContain("Z to A");
  });
});
