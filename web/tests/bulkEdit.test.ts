import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api.js";
import {
  EMPTY_SELECTION,
  NO_TOTAL_REASON,
  WITHHELD_AMOUNTS_REASON,
  allLoadedSelected,
  categoryPatch,
  confirmPatch,
  describeBlocked,
  inlineEditPatch,
  partitionConfirmable,
  paymentMethodPatch,
  runBatch,
  toggleRow,
  toggleSelectAll,
} from "../src/bulkEdit.js";
import type { MergedSuggestions, Receipt } from "../src/types.js";

/**
 * Proposal #5, bulk edit on the web table
 * (docs/proposals/2026-08-28-ux-enhancements.md #5). Three things live in
 * bulkEdit.ts and get tested here without a component tree: selection
 * scope (never reaching past what the table has loaded), the concurrency-
 * limited batch runner (partial failure is the normal case, not the edge
 * case), and the patch-body builders (a bulk set must carry only the one
 * field it names).
 */

describe("selection", () => {
  it("toggleRow adds an unselected id and removes a selected one", () => {
    let selected = toggleRow(EMPTY_SELECTION, "a");
    expect(selected.has("a")).toBe(true);
    selected = toggleRow(selected, "a");
    expect(selected.has("a")).toBe(false);
  });

  it("toggleRow leaves other ids untouched", () => {
    const selected = toggleRow(new Set(["a", "b"]), "b");
    expect([...selected].sort()).toEqual(["a"]);
  });

  it("allLoadedSelected is false when the table has nothing loaded", () => {
    expect(allLoadedSelected([], EMPTY_SELECTION)).toBe(false);
    expect(allLoadedSelected([], new Set(["a"]))).toBe(false);
  });

  it("allLoadedSelected is true only once every loaded id is selected", () => {
    expect(allLoadedSelected(["a", "b"], new Set(["a"]))).toBe(false);
    expect(allLoadedSelected(["a", "b"], new Set(["a", "b"]))).toBe(true);
  });

  it("toggleSelectAll selects exactly the loaded ids - no more, no fewer", () => {
    const loaded = ["a", "b", "c"];
    const selected = toggleSelectAll(loaded, EMPTY_SELECTION);
    expect(selected).toEqual(new Set(loaded));
  });

  it("select-all scope never reaches past what is loaded, even with a stale extra id already selected", () => {
    // The brief's own risk: on a paged table, "select all" must not read
    // as "every receipt in my account." A prior selection carrying an id
    // outside the current page (e.g. left over from a narrower filter)
    // must not survive a select-all over the new, smaller loaded set - the
    // result is always exactly `loadedIds`, never a superset of it.
    const stale = new Set(["a", "z"]);
    const selected = toggleSelectAll(["a", "b"], stale);
    expect(selected).toEqual(new Set(["a", "b"]));
    expect(selected.has("z")).toBe(false);
  });

  it("toggleSelectAll clears the selection when every loaded row is already selected", () => {
    const loaded = ["a", "b"];
    const selected = toggleSelectAll(loaded, new Set(loaded));
    expect(selected.size).toBe(0);
  });

  it("toggleSelectAll on an empty table is a no-op (nothing to select)", () => {
    expect(toggleSelectAll([], EMPTY_SELECTION)).toEqual(EMPTY_SELECTION);
  });
});

describe("runBatch - the batch runner", () => {
  it("reports every id as succeeded when every worker call resolves", async () => {
    const result = await runBatch(["a", "b", "c"], async () => {
      /* succeeds */
    });
    expect(result.succeeded.sort()).toEqual(["a", "b", "c"]);
    expect(result.failed).toEqual([]);
  });

  it("partial failure: succeeded and failed are reported separately, by id, with why", async () => {
    const result = await runBatch(["a", "b", "c", "d"], async (id) => {
      if (id === "b" || id === "d") {
        throw new Error(`refused ${id}`);
      }
    });
    expect(result.succeeded.sort()).toEqual(["a", "c"]);
    expect(
      [...result.failed].sort((x, y) => x.id.localeCompare(y.id)),
    ).toEqual([
      { id: "b", reason: "refused b" },
      { id: "d", reason: "refused d" },
    ]);
  });

  it("a batch where everything fails still reports every id, never throws", async () => {
    const result = await runBatch(["a", "b"], async () => {
      throw new Error("nope");
    });
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(2);
  });

  it("a non-Error thrown value still produces a readable reason", async () => {
    const result = await runBatch(["a"], async () => {
      throw "just a string";
    });
    expect(result.failed).toEqual([{ id: "a", reason: "just a string" }]);
  });

  it("never runs more than `concurrency` workers at once", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    let active = 0;
    let maxActive = 0;
    const release: Array<() => void> = [];
    const worker = () =>
      new Promise<void>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        release.push(() => {
          active -= 1;
          resolve();
        });
      });

    const resultPromise = runBatch(ids, worker, 2);
    // Every lane's synchronous portion (through the first await) has
    // already run by this point - see runBatch's own comment on why.
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBe(2);

    while (release.length > 0 || active > 0) {
      if (release.length > 0) {
        release.shift()!();
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    const result = await resultPromise;
    expect(result.succeeded.sort()).toEqual([...ids].sort());
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("processes every id even with more concurrency than ids", async () => {
    const result = await runBatch(["a", "b"], async () => {}, 10);
    expect(result.succeeded.sort()).toEqual(["a", "b"]);
  });

  it("an empty id list resolves immediately with nothing to report", async () => {
    const result = await runBatch([], async () => {});
    expect(result).toEqual({ succeeded: [], failed: [] });
  });
});

/** What `partitionConfirmable` reads off a row. Pending, nothing withheld. */
function row(
  id: string,
  totalCents: number | null,
  overrides: Partial<Pick<Receipt, "status" | "suggestions">> = {},
): Pick<Receipt, "id" | "totalCents" | "status" | "suggestions"> {
  return { id, totalCents, status: "pending", suggestions: null, ...overrides };
}

function suggestions(overrides: Partial<MergedSuggestions>): MergedSuggestions {
  return {
    vendor: { value: null, source: null },
    purchasedAt: { value: null, source: null, disagreement: false },
    totalCents: { value: null, source: null },
    hstCents: { value: null, source: null, disagreement: false },
    subtotalCents: { value: null, source: null },
    tipCents: { value: null, source: null },
    ...overrides,
  };
}

const WITHHELD = { value: null, source: null, withheld: true };

describe("partitionConfirmable - the server's own total rule, checked client-side first", () => {
  it("blocks a row with no total and names the reason", () => {
    const { confirmable, blocked } = partitionConfirmable([
      row("has-total", 500),
      row("no-total", null),
    ]);
    expect(confirmable).toEqual(["has-total"]);
    expect(blocked).toEqual([{ id: "no-total", reason: NO_TOTAL_REASON }]);
  });

  it("a zero total is a real total, not an absence - confirmable", () => {
    const { confirmable, blocked } = partitionConfirmable([row("zero", 0)]);
    expect(confirmable).toEqual(["zero"]);
    expect(blocked).toEqual([]);
  });

  it("confirms everything when every selected row already has a total", () => {
    const rows = [row("a", 100), row("b", 200)];
    expect(partitionConfirmable(rows)).toEqual({
      confirmable: ["a", "b"],
      blocked: [],
    });
  });

  it("blocks a pending row with a withheld total even though the row holds one", () => {
    // The Costco slip: $218.94 stored as $8.50, the merge refusing to serve
    // it, and a bulk `{status: "confirmed"}` promoting the $8.50 anyway.
    const { confirmable, blocked } = partitionConfirmable([
      row("costco", 850, {
        suggestions: suggestions({ totalCents: { ...WITHHELD } }),
      }),
      row("fine", 500),
    ]);
    expect(confirmable).toEqual(["fine"]);
    expect(blocked).toEqual([{ id: "costco", reason: WITHHELD_AMOUNTS_REASON }]);
  });

  it("blocks on a withheld subtotal too, and on any other amount", () => {
    for (const key of [
      "subtotalCents",
      "hstCents",
      "tipCents",
      "otherFeesCents",
    ] as const) {
      const { blocked } = partitionConfirmable([
        row("r", 500, { suggestions: suggestions({ [key]: { ...WITHHELD } }) }),
      ]);
      expect(blocked).toEqual([{ id: "r", reason: WITHHELD_AMOUNTS_REASON }]);
    }
  });

  it("the reason tells the person to open the receipt", () => {
    expect(WITHHELD_AMOUNTS_REASON).toMatch(/open it/);
  });

  it("names the withheld reason when a row also has no total - it is the one with a remedy", () => {
    const { blocked } = partitionConfirmable([
      row("r", null, { suggestions: suggestions({ totalCents: { ...WITHHELD } }) }),
    ]);
    expect(blocked).toEqual([{ id: "r", reason: WITHHELD_AMOUNTS_REASON }]);
  });

  it("does not block a row whose flag is absent or false", () => {
    const { confirmable } = partitionConfirmable([
      row("absent", 500, { suggestions: suggestions({}) }),
      row("false", 500, {
        suggestions: suggestions({
          totalCents: { value: 500, source: "heuristic", withheld: false },
        }),
      }),
    ]);
    expect(confirmable).toEqual(["absent", "false"]);
  });

  it("does not block an already-confirmed row - the server serves the flag on those too", () => {
    // `withholdImpossibleAmounts` runs on every read regardless of status,
    // and the 409 is only for pending -> confirmed: blocking here would
    // report a failure for a receipt with nothing left to do.
    const { confirmable, blocked } = partitionConfirmable([
      row("done", 21894, {
        status: "confirmed",
        suggestions: suggestions({ totalCents: { ...WITHHELD } }),
      }),
    ]);
    expect(confirmable).toEqual(["done"]);
    expect(blocked).toEqual([]);
  });
});

describe("a row the client could not see coming still fails as that row", () => {
  it("surfaces amounts_need_review as the row's own failure and keeps going", async () => {
    // The row's suggestions were loaded before the LLM sweep landed, so
    // `partitionConfirmable` passed it and only the PATCH finds out.
    const refusal = new ApiError(
      409,
      "amounts_need_review",
      "Review the amounts on this receipt before confirming it.",
    );
    const result = await runBatch(["stale", "fine"], async (id) => {
      if (id === "stale") {
        throw refusal;
      }
    });
    expect(result.succeeded).toEqual(["fine"]);
    expect(result.failed).toEqual([{ id: "stale", reason: refusal.message }]);
  });
});

describe("describeBlocked - the line beside the Confirm button", () => {
  const noTotal = { id: "a", reason: NO_TOTAL_REASON };
  const withheld = { id: "b", reason: WITHHELD_AMOUNTS_REASON };

  it("states the count and the one reason", () => {
    expect(describeBlocked([noTotal], 3)).toBe(
      "1 of 3 selected will be skipped: 1 no total",
    );
    expect(describeBlocked([withheld], 3)).toBe(
      "1 of 3 selected will be skipped: 1 to open - amounts withheld",
    );
  });

  it("states both reasons, since they have different remedies", () => {
    expect(describeBlocked([noTotal, withheld], 5)).toBe(
      "2 of 5 selected will be skipped: 1 no total, 1 to open - amounts withheld",
    );
  });
});

describe("inlineEditPatch - what a table cell sends", () => {
  it("on a pending row, adds the edited field to the reviewed set", () => {
    // The defect: Total typed as 15.00 with no reviewedFields left the
    // parser's $14.35 winning, and Confirm PATCHed 1435 over the 1500.
    expect(
      inlineEditPatch(
        { status: "pending", reviewedFields: [] },
        { totalCents: 1500 },
      ),
    ).toEqual({ totalCents: 1500, reviewedFields: ["totalCents"] });
  });

  it("unions rather than replaces - the PATCH replaces the stored set outright", () => {
    expect(
      inlineEditPatch(
        { status: "pending", reviewedFields: ["vendor", "notes"] },
        { hstCents: 165 },
      ).reviewedFields,
    ).toEqual(["vendor", "hstCents", "notes"]);
  });

  it("sends the same set in the same order whatever was edited first", () => {
    expect(
      inlineEditPatch(
        { status: "pending", reviewedFields: ["totalCents"] },
        { vendor: "Staples" },
      ).reviewedFields,
    ).toEqual(["vendor", "totalCents"]);
  });

  it("marks a field cleared to null as reviewed too - that is a human's value", () => {
    expect(
      inlineEditPatch({ status: "pending", reviewedFields: [] }, { vendor: null }),
    ).toEqual({ vendor: null, reviewedFields: ["vendor"] });
  });

  it("on a confirmed row, sends the edit alone", () => {
    const patch = { totalCents: 1500 };
    expect(
      inlineEditPatch({ status: "confirmed", reviewedFields: ["vendor"] }, patch),
    ).toEqual(patch);
  });
});

describe("bulk patch bodies carry only the field being set", () => {
  it("categoryPatch sends category alone", () => {
    const patch = categoryPatch("Meals");
    expect(patch).toEqual({ category: "Meals" });
    expect(Object.keys(patch)).toEqual(["category"]);
  });

  it("categoryPatch trims and empties to null - the same rule TextCell applies per row", () => {
    expect(categoryPatch("  ")).toEqual({ category: null });
    expect(categoryPatch("  Meals  ")).toEqual({ category: "Meals" });
  });

  it("paymentMethodPatch sends paymentMethod alone", () => {
    const patch = paymentMethodPatch("Visa");
    expect(patch).toEqual({ paymentMethod: "Visa" });
    expect(Object.keys(patch)).toEqual(["paymentMethod"]);
  });

  it("paymentMethodPatch trims and empties to null", () => {
    expect(paymentMethodPatch("   ")).toEqual({ paymentMethod: null });
  });

  it("confirmPatch sends status alone - never a total or any other field", () => {
    expect(confirmPatch).toEqual({ status: "confirmed" });
    expect(Object.keys(confirmPatch)).toEqual(["status"]);
  });
});
