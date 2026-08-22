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
      { from: "2026-01-01", to: "2026-12-31", isBusiness: true, status: "pending" },
      null,
    );
    const params = new URLSearchParams(query);
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-12-31");
    expect(params.get("isBusiness")).toBe("true");
    expect(params.get("status")).toBe("pending");
    expect([...params.keys()].sort()).toEqual(["from", "isBusiness", "status", "to"]);
  });

  it("sends isBusiness=false as the string the server's schema expects", () => {
    expect(listQuery({ isBusiness: false }, null)).toBe("isBusiness=false");
  });

  it("drops a blank search instead of sending q= to a min(1) schema", () => {
    expect(listQuery({ q: "   " }, null)).toBe("");
    expect(listQuery({ q: " thai " }, null)).toBe("q=thai");
  });

  it("carries the cursor when paging", () => {
    expect(listQuery({}, "abc123")).toBe("cursor=abc123");
  });
});
