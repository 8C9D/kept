import { describe, expect, it } from "vitest";
import {
  accuracyPercent,
  classifyField,
  measureAccuracy,
  type MeasuredReceipt,
} from "../../src/domain/parseAccuracy.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";

const emptySuggestions: OcrFieldSuggestions = {
  vendor: null,
  purchasedAt: null,
  totalCents: null,
  hstCents: null,
  subtotalCents: null,
  vendorTaxNumber: null,
};

function receipt(
  id: string,
  suggestions: Partial<OcrFieldSuggestions>,
  confirmed: Partial<MeasuredReceipt["confirmed"]>,
): MeasuredReceipt {
  return {
    id,
    suggestions: { ...emptySuggestions, ...suggestions },
    confirmed: { ...emptySuggestions, ...confirmed },
  };
}

describe("classifyField", () => {
  it("is a match when the human kept the suggestion", () => {
    expect(classifyField("totalCents", 4520, 4520)).toBe("match");
  });

  it("is a mismatch when the human changed the value", () => {
    expect(classifyField("totalCents", 4520, 4526)).toBe("mismatch");
  });

  it("is a mismatch when the human removed a suggested value", () => {
    expect(classifyField("hstCents", 1300, null)).toBe("mismatch");
  });

  it("is a miss when the parser found nothing but a value existed", () => {
    expect(classifyField("vendor", null, "Staples")).toBe("missed");
  });

  it("is correctly absent when there was genuinely nothing to find", () => {
    expect(classifyField("vendorTaxNumber", null, null)).toBe("correctlyAbsent");
  });

  it("compares money exactly - one cent off is a mismatch", () => {
    expect(classifyField("subtotalCents", 10000, 10001)).toBe("mismatch");
  });

  it("compares vendors ignoring case and whitespace styling", () => {
    expect(classifyField("vendor", "STAPLES  #123", "Staples #123")).toBe("match");
    expect(classifyField("vendor", "Staples", "Walmart")).toBe("mismatch");
  });

  it("compares tax numbers ignoring internal spacing", () => {
    expect(
      classifyField("vendorTaxNumber", "123456789 RT 0001", "123456789RT0001"),
    ).toBe("match");
  });

  it("compares dates exactly", () => {
    expect(classifyField("purchasedAt", "2026-01-14", "2026-01-14")).toBe("match");
    expect(classifyField("purchasedAt", "2026-01-14", "2026-01-15")).toBe("mismatch");
  });
});

describe("measureAccuracy", () => {
  it("tallies every field across receipts and lists each correction", () => {
    const report = measureAccuracy([
      receipt(
        "aaaaaaaa-0000-0000-0000-000000000001",
        { totalCents: 4520, vendor: "Staples" },
        { totalCents: 4520, vendor: "Staples" },
      ),
      receipt(
        "aaaaaaaa-0000-0000-0000-000000000002",
        { totalCents: 9999, hstCents: 1300 },
        { totalCents: 11300, hstCents: 1300, vendor: "Walmart" },
      ),
    ]);

    expect(report.receiptCount).toBe(2);
    const byField = new Map(report.tallies.map((tally) => [tally.field, tally]));
    expect(byField.get("totalCents")).toMatchObject({ match: 1, mismatch: 1 });
    expect(byField.get("hstCents")).toMatchObject({ match: 1, correctlyAbsent: 1 });
    expect(byField.get("vendor")).toMatchObject({ match: 1, missed: 1 });
    // Fields nobody suggested and nobody filled: correctly absent twice.
    expect(byField.get("vendorTaxNumber")).toMatchObject({ correctlyAbsent: 2 });

    // In field-declaration order within a receipt: vendor before total.
    expect(report.mismatches).toEqual([
      {
        receiptId: "aaaaaaaa-0000-0000-0000-000000000002",
        field: "vendor",
        verdict: "missed",
        suggested: null,
        confirmed: "Walmart",
      },
      {
        receiptId: "aaaaaaaa-0000-0000-0000-000000000002",
        field: "totalCents",
        verdict: "mismatch",
        suggested: 9999,
        confirmed: 11300,
      },
    ]);
  });

  it("counts a correct absence as accuracy, and reports the percentage", () => {
    const report = measureAccuracy([
      receipt("a", { totalCents: 100 }, { totalCents: 100 }),
      receipt("b", {}, {}),
      receipt("c", { totalCents: 5 }, { totalCents: 6 }),
      receipt("d", {}, { totalCents: 7 }),
    ]);
    const total = report.tallies.find((tally) => tally.field === "totalCents");
    expect(total).toMatchObject({
      match: 1,
      correctlyAbsent: 1,
      mismatch: 1,
      missed: 1,
    });
    if (total === undefined) throw new Error("totalCents tally missing");
    expect(accuracyPercent(total)).toBe(50);
  });

  it("reports no data as null, never a fake zero percent", () => {
    const report = measureAccuracy([]);
    expect(report.receiptCount).toBe(0);
    for (const tally of report.tallies) {
      expect(accuracyPercent(tally)).toBeNull();
    }
  });
});
