import { describe, expect, it } from "vitest";
import { listQuery } from "../src/api.js";

/**
 * The server's list schema is strict - an unknown key or an empty q is a
 * 400 - so the one place that builds the query string has to translate
 * "no filter" into "no parameter", never into an empty one.
 */
describe("listQuery", () => {
  it("sends nothing for no filters", () => {
    expect(listQuery({}, null)).toBe("");
  });

  it("sends exactly the set filters", () => {
    const query = listQuery(
      {
        from: "2026-01-01",
        to: "2026-12-31",
        status: "pending",
        category: "meals",
        paymentMethod: "visa",
      },
      null,
    );
    const params = new URLSearchParams(query);
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-12-31");
    expect(params.get("status")).toBe("pending");
    expect(params.get("category")).toBe("meals");
    expect(params.get("paymentMethod")).toBe("visa");
    expect([...params.keys()].sort()).toEqual([
      "category",
      "from",
      "paymentMethod",
      "status",
      "to",
    ]);
  });

  it("has no business/personal filter to send - the field is gone", () => {
    const query = listQuery({ status: "confirmed" }, null);
    expect(query).not.toContain("isBusiness");
  });

  it("drops a blank search instead of sending q= to a min(1) schema", () => {
    expect(listQuery({ q: "   " }, null)).toBe("");
    expect(listQuery({ q: " thai " }, null)).toBe("q=thai");
  });

  it("drops blank category and payment filters the same way", () => {
    expect(listQuery({ category: "   ", paymentMethod: "" }, null)).toBe("");
    expect(listQuery({ category: " meals " }, null)).toBe("category=meals");
    expect(listQuery({ paymentMethod: " visa " }, null)).toBe(
      "paymentMethod=visa",
    );
  });

  it("sends sort and order only when chosen - the server has the defaults", () => {
    expect(listQuery({}, null)).toBe("");
    expect(listQuery({ sort: "total", order: "asc" }, null)).toBe(
      "sort=total&order=asc",
    );
    expect(listQuery({ order: "desc" }, null)).toBe("order=desc");
  });

  it("carries the cursor last, after the sort it was minted under", () => {
    expect(listQuery({}, "abc123")).toBe("cursor=abc123");
    expect(listQuery({ sort: "vendor", order: "asc" }, "abc123")).toBe(
      "sort=vendor&order=asc&cursor=abc123",
    );
  });
});
