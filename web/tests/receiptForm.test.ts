import { describe, expect, it } from "vitest";
import {
  DraftError,
  arithmeticMismatch,
  dateDisagreementNote,
  draftForDisplay,
  draftFromPending,
  draftFromReceipt,
  hstDisagreementNote,
  patchFromDraft,
  summarizeFieldEdits,
  type ReceiptDraft,
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
    tipCents: null,
    otherFeesCents: null,
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

/** A blank draft, for the arithmetic-check tests, which never touch a Receipt. */
function draft(overrides: Partial<ReceiptDraft> = {}): ReceiptDraft {
  return {
    total: "",
    purchasedAt: "2026-08-21",
    vendor: "",
    hst: "",
    subtotal: "",
    tip: "",
    otherFees: "",
    category: "",
    paymentMethod: "",
    notes: "",
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
        hstCents: { value: null, source: null, disagreement: false },
        subtotalCents: { value: null, source: null },
        // Tip is merged heuristic-only, like the other amounts (2026-08-28).
        tipCents: { value: 1500, source: "heuristic" },
      },
    });
    const d = draftFromPending(row);
    expect(d.vendor).toBe("Food Basics");
    expect(d.purchasedAt).toBe("2026-08-19");
    expect(d.total).toBe("$113.00");
    // No suggestion for HST: the row's absence stands, stated as empty.
    expect(d.hst).toBe("");
    expect(d.tip).toBe("$15.00");
  });

  it("never suggests other fees - no such key exists in the merge", () => {
    // §7.3: "other fees" is a residual with no consistent printed label,
    // so no heuristic can match it - the merge has no otherFeesCents key
    // at all, and draftFromPending never overrides the row's own value.
    const row = receipt({
      otherFeesCents: 800,
      suggestions: {
        vendor: { value: null, source: null },
        purchasedAt: { value: "2026-08-19", source: "heuristic", disagreement: false },
        totalCents: { value: null, source: null },
        hstCents: { value: null, source: null, disagreement: false },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });
    expect(draftFromPending(row).otherFees).toBe("$8.00");
  });

  it("renders the row alone when no parser ever ran - the web-upload case", () => {
    const row = receipt({ vendor: "Typed Vendor" });
    const d = draftFromPending(row);
    expect(d.vendor).toBe("Typed Vendor");
    expect(d.purchasedAt).toBe("2026-08-21");
  });
});

describe("patchFromDraft", () => {
  it("carries exactly what changed", () => {
    const row = receipt({ vendor: "Old", totalCents: 500 });
    const d = {
      ...draftFromReceipt(row),
      vendor: "New Vendor",
      total: "12.34",
    };
    const patch = patchFromDraft(row, d);
    expect(patch).toEqual({ vendor: "New Vendor", totalCents: 1234 });
  });

  it("sends an explicit null for a cleared nullable field", () => {
    const row = receipt({ category: "meals" });
    const d = { ...draftFromReceipt(row), category: "  " };
    expect(patchFromDraft(row, d)).toEqual({ category: null });
  });

  it("is empty for an untouched draft - the no-op submit sends nothing", () => {
    const row = receipt({ vendor: "Same", totalCents: 500, category: "meals" });
    expect(patchFromDraft(row, draftFromReceipt(row))).toEqual({});
  });

  it("carries every field the record still has, and only those", () => {
    const row = receipt();
    const patch = patchFromDraft(row, {
      total: "113.00",
      purchasedAt: "2026-08-20",
      vendor: "Food Basics",
      hst: "13.00",
      subtotal: "100.00",
      tip: "0.00",
      otherFees: "5.00",
      category: "groceries",
      paymentMethod: "visa",
      notes: "business kitchen",
    });
    // The 2026-08-26 reduction sent no vendorTaxNumber, otherTaxCents or
    // isBusiness. The 2026-08-28 feedback put two named fields back in
    // that shape's place, and both are sent here alongside the rest.
    expect(patch).toEqual({
      purchasedAt: "2026-08-20",
      vendor: "Food Basics",
      subtotalCents: 10000,
      hstCents: 1300,
      tipCents: 0,
      otherFeesCents: 500,
      totalCents: 11300,
      category: "groceries",
      paymentMethod: "visa",
      notes: "business kitchen",
    });
  });

  it("sends an explicit null for a cleared tip and nothing for an untouched other-fees field", () => {
    // Predicted before running (CLAUDE.md: predict before verifying). A row
    // with a saved $5.00 tip and no other-fees line. The person clears the
    // tip box to empty and never touches other fees. Expected patch:
    // { tipCents: null } and nothing else - the clear is an explicit null
    // (parseMoneyInput("") -> null, which differs from the stored 500), and
    // other fees round-trips null -> "" -> null, so the !== check in
    // assignMoney finds no change and the key never appears at all.
    const row = receipt({ tipCents: 500, otherFeesCents: null });
    const edited = { ...draftFromReceipt(row), tip: "" };
    expect(patchFromDraft(row, edited)).toEqual({ tipCents: null });
  });

  it("names the field when tip or other fees does not parse", () => {
    const row = receipt();
    const badTip = { ...draftFromReceipt(row), tip: "abc" };
    expect(() => patchFromDraft(row, badTip)).toThrow(DraftError);
    expect(() => patchFromDraft(row, badTip)).toThrow(/tip/);
    const badOtherFees = { ...draftFromReceipt(row), otherFees: "abc" };
    expect(() => patchFromDraft(row, badOtherFees)).toThrow(/other fees/);
  });

  it("names the field when money does not parse", () => {
    const row = receipt();
    const d = { ...draftFromReceipt(row), hst: "abc" };
    expect(() => patchFromDraft(row, d)).toThrow(DraftError);
    expect(() => patchFromDraft(row, d)).toThrow(/HST/);
  });
});

describe("arithmeticMismatch - the live subtotal + HST + tip + other fees = total check", () => {
  it("reconciles the restaurant case that motivated this work", () => {
    // The concrete complaint that started this change: a tipped receipt
    // used to warn because the tip had nowhere to go.
    // $100 subtotal + $13 HST + $20 tip = $133 total.
    expect(
      arithmeticMismatch(
        draft({ subtotal: "100.00", hst: "13.00", tip: "20.00", total: "133.00" }),
      ),
    ).toBe(false);
  });

  it("reconciles over all four components, including other fees", () => {
    expect(
      arithmeticMismatch(
        draft({
          subtotal: "100.00",
          hst: "13.00",
          tip: "20.00",
          otherFees: "5.00",
          total: "138.00",
        }),
      ),
    ).toBe(false);
  });

  it("warns when the four components do not add up to total", () => {
    expect(
      arithmeticMismatch(
        draft({ subtotal: "100.00", hst: "13.00", tip: "20.00", total: "999.00" }),
      ),
    ).toBe(true);
  });

  it("treats a null HST, tip or other fees as zero, exactly as HST always did", () => {
    expect(arithmeticMismatch(draft({ subtotal: "50.00", total: "50.00" }))).toBe(
      false,
    );
  });

  it("has nothing to reconcile against without both subtotal and total", () => {
    expect(arithmeticMismatch(draft({ hst: "13.00", tip: "5.00" }))).toBe(false);
    expect(arithmeticMismatch(draft({ subtotal: "100.00" }))).toBe(false);
    expect(arithmeticMismatch(draft({ total: "100.00" }))).toBe(false);
  });

  it("suppresses the check on unparseable input rather than guessing mid-keystroke", () => {
    expect(
      arithmeticMismatch(draft({ subtotal: "10.00", total: "10.00", tip: "1." })),
    ).toBe(false);
  });
});

describe("draftForDisplay - which prefill rule a screen gets", () => {
  /**
   * The 2026-08-28 defect this exists to prevent: the detail screen called
   * `draftFromReceipt` unconditionally, so a pending receipt opened from the
   * table marked its suggested fields amber and left them empty - the amber
   * promising a suggestion the form had thrown away.
   */
  it("prefills a pending receipt from the served merge, not the row", () => {
    const row = receipt({
      status: "pending",
      vendor: null,
      totalCents: null,
      suggestions: {
        vendor: { value: "Noodle House (BCE)", source: "llm" },
        purchasedAt: { value: "2026-08-19", source: "both", disagreement: false },
        totalCents: { value: 4554, source: "heuristic" },
        hstCents: { value: 524, source: "heuristic", disagreement: false },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });
    const d = draftForDisplay(row);
    expect(d.vendor).toBe("Noodle House (BCE)");
    expect(d.total).toBe("$45.54");
    expect(d.hst).toBe("$5.24");
  });

  it("renders a confirmed receipt from the row, never from the merge", () => {
    const row = receipt({
      status: "confirmed",
      vendor: "What the human typed",
      totalCents: 1000,
      suggestions: {
        vendor: { value: "What the parser guessed", source: "llm" },
        purchasedAt: { value: "2020-01-01", source: "llm", disagreement: false },
        totalCents: { value: 9999, source: "heuristic" },
        hstCents: { value: null, source: null, disagreement: false },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });
    const d = draftForDisplay(row);
    expect(d.vendor).toBe("What the human typed");
    expect(d.total).toBe("$10.00");
    expect(d.purchasedAt).toBe("2026-08-21");
  });
});

describe("hstDisagreementNote - the HST disagreement inline note (2026-08-28)", () => {
  const NO_TOUCH = new Set<keyof ReceiptDraft>();

  function pendingWithHst(disagreement: boolean): Receipt {
    return receipt({
      status: "pending",
      suggestions: {
        vendor: { value: null, source: null },
        purchasedAt: { value: "2026-08-19", source: "heuristic", disagreement: false },
        totalCents: { value: null, source: null },
        hstCents: { value: 524, source: "heuristic", disagreement },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });
  }

  it("renders when the two parsers' HST reads disagree", () => {
    expect(hstDisagreementNote(pendingWithHst(true), NO_TOUCH)).toBe(true);
  });

  it("does not render when the two parsers agree", () => {
    expect(hstDisagreementNote(pendingWithHst(false), NO_TOUCH)).toBe(false);
  });

  it("clears once the HST field is touched - same as the amber tint (§10A.1)", () => {
    const touched = new Set<keyof ReceiptDraft>(["hst"]);
    expect(hstDisagreementNote(pendingWithHst(true), touched)).toBe(false);
  });

  it("touching a different field does not clear it", () => {
    const touched = new Set<keyof ReceiptDraft>(["vendor"]);
    expect(hstDisagreementNote(pendingWithHst(true), touched)).toBe(true);
  });

  it("never renders on a confirmed receipt, even if the stored flag is true", () => {
    const row = { ...pendingWithHst(true), status: "confirmed" as const };
    expect(hstDisagreementNote(row, NO_TOUCH)).toBe(false);
  });
});

describe("dateDisagreementNote - the field this note's treatment was ported from", () => {
  it("clears once the date field is touched, matching the HST note above", () => {
    // Predicted before writing (CLAUDE.md: predict before verifying): this
    // is the bug this same pass fixed - `dateDisagreementNote` used to be
    // computed with no touched check at all, so §10A.1's "touching a field
    // clears the tint and the note together" held for the tint but not the
    // note sitting right next to it.
    const row = receipt({
      status: "pending",
      suggestions: {
        vendor: { value: null, source: null },
        purchasedAt: { value: "2026-08-19", source: "heuristic", disagreement: true },
        totalCents: { value: null, source: null },
        hstCents: { value: null, source: null, disagreement: false },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });
    expect(dateDisagreementNote(row, new Set())).toBe(true);
    expect(dateDisagreementNote(row, new Set(["purchasedAt"]))).toBe(false);
  });
});

describe("summarizeFieldEdits - the save-time telemetry summaries (2026-08-28)", () => {
  it("counts three edits to total and one to vendor in a session", () => {
    const row = receipt();
    const { fieldEditCounts } = summarizeFieldEdits(row, [
      "total",
      "total",
      "vendor",
      "total",
    ]);
    expect(fieldEditCounts).toEqual([
      { field: "total", count: 3 },
      { field: "vendor", count: 1 },
    ]);
  });

  it("reports no suggestion outcomes when the receipt carried no suggestions", () => {
    const row = receipt();
    expect(summarizeFieldEdits(row, ["vendor"]).suggestionOutcomes).toEqual([]);
  });

  it("marks a suggested field accepted when never edited, overridden when it was", () => {
    const row = receipt({
      status: "pending",
      suggestions: {
        vendor: { value: "Food Basics", source: "llm" },
        purchasedAt: { value: "2026-08-19", source: "heuristic", disagreement: false },
        totalCents: { value: 1000, source: "heuristic" },
        hstCents: { value: null, source: null, disagreement: false },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });
    // Only vendor was touched - purchasedAt and total were left exactly as
    // suggested, so they read as accepted.
    const { suggestionOutcomes } = summarizeFieldEdits(row, ["vendor"]);
    expect(suggestionOutcomes).toEqual([
      { field: "vendor", accepted: false },
      { field: "purchasedAt", accepted: true },
      { field: "total", accepted: true },
    ]);
  });
});
