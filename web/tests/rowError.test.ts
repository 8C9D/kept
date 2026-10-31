import { describe, expect, it } from "vitest";
import { rowErrorAfterSave, type RowError } from "../src/views/ReceiptsTable.js";

describe("rowErrorAfterSave - a success only clears the error it answers", () => {
  const refusedTotal: RowError = { field: "totalCents", message: "refused" };

  it("records which field a failed save was about", () => {
    expect(rowErrorAfterSave(null, { totalCents: 2222 }, "refused")).toEqual(
      refusedTotal,
    );
  });

  it("keeps a failure when a different field then saves", () => {
    // The defect: the refused total stayed in its cell, unsaved, and the good
    // HST behind it wiped the only message saying so.
    expect(rowErrorAfterSave(refusedTotal, { hstCents: 222 }, null)).toBe(
      refusedTotal,
    );
  });

  it("clears it when that field saves", () => {
    expect(rowErrorAfterSave(refusedTotal, { totalCents: 1500 }, null)).toBeNull();
  });

  it("lets a newer failure replace an older one", () => {
    expect(rowErrorAfterSave(refusedTotal, { vendor: "x" }, "no")).toEqual({
      field: "vendor",
      message: "no",
    });
  });

  it("clears a mistyped amount on the next good save - that cell already reverted", () => {
    const mistyped: RowError = { field: null, message: "not an amount" };
    expect(rowErrorAfterSave(mistyped, { hstCents: 222 }, null)).toBeNull();
  });

  it("stays empty when nothing was wrong", () => {
    expect(rowErrorAfterSave(null, { hstCents: 222 }, null)).toBeNull();
  });
});
