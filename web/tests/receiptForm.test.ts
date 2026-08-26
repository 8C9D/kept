import { describe, expect, it } from "vitest";
import {
  DraftError,
  draftFromPending,
  draftFromReceipt,
  patchFromDraft,
} from "../src/views/ReceiptForm.js";
import type { Receipt } from "../src/types.js";

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    id: "r-1",
    purchasedAt: "2026-08-21",
    capturedAt: "2026-08-21T12:00:00.000Z",
    vendor: null,
    subtotalCents: null,
    hstCents: null,
    totalCents: null,
    currency: "CAD",
    category: null,
    paymentMethod: null,
    notes: null,
    status: "pending",
    suggestions: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

describe("draftFromPending - the §7.3 display rule, as iOS renders it", () => {
  it("prefers the served suggestion and falls back to the row per field", () => {
    const row = receipt({
      vendor: "Basics",
      totalCents: null,
      suggestions: {
        vendor: { value: "Food Basics", source: "llm" },
        purchasedAt: { value: "2026-08-19", source: "both", disagreement: false },
        totalCents: { value: 11300, source: "llm" },
        hstCents: { value: null, source: null },
        subtotalCents: { value: null, source: null },
      },
    });
    const draft = draftFromPending(row);
    expect(draft.vendor).toBe("Food Basics");
    expect(draft.purchasedAt).toBe("2026-08-19");
    expect(draft.total).toBe("$113.00");
    // No suggestion for HST: the row's absence stands, stated as empty.
    expect(draft.hst).toBe("");
  });

  it("renders the row alone when no parser ever ran - the web-upload case", () => {
    const row = receipt({ vendor: "Typed Vendor" });
    const draft = draftFromPending(row);
    expect(draft.vendor).toBe("Typed Vendor");
    expect(draft.purchasedAt).toBe("2026-08-21");
  });
});

describe("patchFromDraft", () => {
  it("carries exactly what changed", () => {
    const row = receipt({ vendor: "Old", totalCents: 500 });
    const draft = {
      ...draftFromReceipt(row),
      vendor: "New Vendor",
      total: "12.34",
    };
    const patch = patchFromDraft(row, draft);
    expect(patch).toEqual({ vendor: "New Vendor", totalCents: 1234 });
  });

  it("sends an explicit null for a cleared nullable field", () => {
    const row = receipt({ category: "meals" });
    const draft = { ...draftFromReceipt(row), category: "  " };
    expect(patchFromDraft(row, draft)).toEqual({ category: null });
  });

  it("is empty for an untouched draft - the no-op submit sends nothing", () => {
    const row = receipt({ vendor: "Same", totalCents: 500, category: "meals" });
    expect(patchFromDraft(row, draftFromReceipt(row))).toEqual({});
  });

  it("carries every field the record still has, and only those", () => {
    const row = receipt();
    const patch = patchFromDraft(row, {
      purchasedAt: "2026-08-20",
      vendor: "Food Basics",
      subtotal: "100.00",
      hst: "13.00",
      total: "113.00",
      category: "groceries",
      paymentMethod: "visa",
      notes: "business kitchen",
    });
    // The 2026-08-26 reduction: no vendorTaxNumber, otherTaxCents or
    // isBusiness exists to send, on this or any other draft.
    expect(patch).toEqual({
      purchasedAt: "2026-08-20",
      vendor: "Food Basics",
      subtotalCents: 10000,
      hstCents: 1300,
      totalCents: 11300,
      category: "groceries",
      paymentMethod: "visa",
      notes: "business kitchen",
    });
  });

  it("names the field when money does not parse", () => {
    const row = receipt();
    const draft = { ...draftFromReceipt(row), hst: "abc" };
    expect(() => patchFromDraft(row, draft)).toThrow(DraftError);
    expect(() => patchFromDraft(row, draft)).toThrow(/HST/);
  });
});
