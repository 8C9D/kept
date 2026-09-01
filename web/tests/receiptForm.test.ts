import { describe, expect, it } from "vitest";
import {
  DraftError,
  amountFloorNote,
  applyComponentEdit,
  arithmeticMismatch,
  checkAmountFloor,
  hstSuggestionChip,
  HST_RATE_CURRENCY,
  isComponentAmountField,
  patchChangesNothing,
  patchForConfirm,
  patchForSaveForLater,
  reviewedFieldsForSave,
  suggestDefaultRateHst,
  checkHstRatePlausibility,
  dateDisagreementNote,
  deriveMissingAmount,
  draftForDisplay,
  draftFromPending,
  draftFromReceipt,
  hstDisagreementNote,
  hstRateHintNote,
  patchFromDraft,
  reconciliationSuggestions,
  summarizeFieldEdits,
  vendorDefaultFill,
  withheldAmountsNote,
  type ReceiptDraft,
  type SuggestibleField,
} from "../src/views/ReceiptForm.js";
import type {
  MergedSuggestions,
  Receipt,
  ReceiptOptions,
  WithholdableAmountSuggestion,
} from "../src/types.js";

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
    reviewedFields: [],
    ocrSource: null,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * A served merge with every field an absence (2026-09-01). Eight keys now,
 * and spelling all eight out per case buries the one field each test below
 * is actually about - the older blocks in this file still write theirs
 * inline, which is also what proves the two new keys stayed optional.
 */
function merged(overrides: Partial<MergedSuggestions> = {}): MergedSuggestions {
  return {
    vendor: { value: null, source: null },
    purchasedAt: { value: null, source: null, disagreement: false },
    totalCents: { value: null, source: null },
    hstCents: { value: null, source: null, disagreement: false },
    subtotalCents: { value: null, source: null },
    tipCents: { value: null, source: null },
    otherFeesCents: { value: null, source: null },
    paymentMethod: { value: null, source: null },
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

  it("falls back to the row's own other fees when the merge carries no such key", () => {
    // The pre-2026-09-01 shape, kept as a fixture on purpose: until that
    // date the merge had no `otherFeesCents` key at all (no heuristic can
    // match a residual with no consistent printed label), and a response
    // built without one must still render the row's value rather than a
    // blank - which is also what pins the key as optional in types.ts.
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

describe("deriveMissingAmount - the live mirror of the server's function of the same name", () => {
  it("derives subtotal when it is the one blank field", () => {
    // $138.00 total = subtotal + $13.00 HST + $20.00 tip + $5.00 other fees.
    const result = deriveMissingAmount(
      draft({ hst: "13.00", tip: "20.00", otherFees: "5.00", total: "138.00" }),
    );
    expect(result).toEqual({
      field: "subtotal",
      cents: 10000,
      formula: expect.stringContaining("Subtotal"),
    });
  });

  it("derives HST when it is the one blank field", () => {
    const result = deriveMissingAmount(
      draft({ subtotal: "100.00", tip: "20.00", otherFees: "5.00", total: "138.00" }),
    );
    expect(result).toEqual({ field: "hst", cents: 1300, formula: expect.any(String) });
  });

  it("derives tip when it is the one blank field", () => {
    const result = deriveMissingAmount(
      draft({ subtotal: "100.00", hst: "13.00", otherFees: "5.00", total: "138.00" }),
    );
    expect(result).toEqual({ field: "tip", cents: 2000, formula: expect.any(String) });
  });

  it("derives other fees when it is the one blank field", () => {
    const result = deriveMissingAmount(
      draft({ subtotal: "100.00", hst: "13.00", tip: "20.00", total: "138.00" }),
    );
    expect(result).toEqual({ field: "otherFees", cents: 500, formula: expect.any(String) });
  });

  it("derives total when it is the one blank field - the sum, not a subtraction", () => {
    const result = deriveMissingAmount(
      draft({ subtotal: "100.00", hst: "13.00", tip: "20.00", otherFees: "5.00" }),
    );
    expect(result).toEqual({ field: "total", cents: 13800, formula: expect.any(String) });
  });

  it("names which field it is a suggestion for, not a bare number", () => {
    // The server's own point (arithmetic.ts): the field name in the result
    // is what lets a caller never confuse which field a value is for.
    const result = deriveMissingAmount(
      draft({ subtotal: "100.00", hst: "13.00", tip: "20.00", total: "138.00" }),
    );
    expect(result?.field).toBe("otherFees");
    expect(result?.formula).toContain("Other fees");
  });

  it("derives nothing when all five are already filled", () => {
    expect(
      deriveMissingAmount(
        draft({
          subtotal: "100.00",
          hst: "13.00",
          tip: "20.00",
          otherFees: "5.00",
          total: "138.00",
        }),
      ),
    ).toBeNull();
  });

  it("derives nothing when two or more fields are GENUINELY unknown", () => {
    // Subtotal and HST both blank: two real unknowns and one equation.
    // (Before the 2026-09-01 widening this test read "two or more fields
    // are blank" and used a blank other-fees line as one of the two - that
    // is no longer an unknown, and the case below is what the sentence
    // always meant.)
    expect(
      deriveMissingAmount(draft({ tip: "20.00", total: "138.00" })),
    ).toBeNull();
    expect(
      deriveMissingAmount(draft({ subtotal: "100.00", tip: "20.00" })),
    ).toBeNull();
  });

  describe("the 2026-09-01 widening - a blank tip or fee reads as no such line", () => {
    it("derives HST from a subtotal and a total alone - the contract's own example", () => {
      // {subtotal 1270, total 1435} -> HST 165. The commonest receipt
      // shape there is, and the one that derived nothing until this date.
      const result = deriveMissingAmount(
        draft({ subtotal: "12.70", total: "14.35" }),
      );
      expect(result).toEqual({
        field: "hst",
        cents: 165,
        formula: "HST = total − subtotal − tip − other fees",
      });
    });

    it("derives the total from a subtotal and an HST alone", () => {
      // {subtotal 1270, hst 165} -> total 1435.
      expect(
        deriveMissingAmount(draft({ subtotal: "12.70", hst: "1.65" }))?.cents,
      ).toBe(1435);
    });

    it("derives the subtotal from a total and an HST alone", () => {
      expect(
        deriveMissingAmount(draft({ hst: "1.65", total: "14.35" }))?.cents,
      ).toBe(1270);
    });

    it("still needs the other four to solve FOR a tip", () => {
      // Tip blank AND other fees blank, with a $25 shortfall on the table:
      // the pre-2026-09-01 rule stands for these two fields, because
      // "the tip is whatever balances these numbers" invents a gratuity.
      expect(
        deriveMissingAmount(
          draft({ subtotal: "100.00", hst: "13.00", total: "138.00" }),
        ),
      ).toBeNull();
      // With other fees filled in, tip is the one blank and is derivable
      // exactly as it always was.
      expect(
        deriveMissingAmount(
          draft({
            subtotal: "100.00",
            hst: "13.00",
            otherFees: "0.00",
            total: "138.00",
          }),
        ),
      ).toEqual({
        field: "tip",
        cents: 2500,
        formula: "Tip = total − subtotal − HST − other fees",
      });
    });

    it("still refuses a negative tip under the widened rule", () => {
      expect(
        deriveMissingAmount(
          draft({ subtotal: "100.00", hst: "13.00", otherFees: "5.00", total: "100.00" }),
        ),
      ).toBeNull();
    });
  });

  it("refuses a negative tip - the server's own named refusal", () => {
    // subtotal + hst + otherFees ($118) already exceeds total ($100), so
    // solving for tip would require -$18. NEVER_NEGATIVE_FIELDS refuses it
    // rather than inventing a number that looks like an answer.
    const result = deriveMissingAmount(
      draft({ subtotal: "100.00", hst: "13.00", otherFees: "5.00", total: "100.00" }),
    );
    expect(result).toBeNull();
  });

  it("refuses a negative other-fees amount the same way", () => {
    const result = deriveMissingAmount(
      draft({ subtotal: "100.00", hst: "13.00", tip: "5.00", total: "100.00" }),
    );
    expect(result).toBeNull();
  });

  it("allows a negative subtotal, HST or total - a refund receipt is real", () => {
    // Mirrors the server's own comment: negative money is allowed generally
    // (a refund), and only tip/otherFees are charges that can never run
    // negative. Every component zero except a negative total: subtotal
    // (the blank field) must come out -$50.00 to balance.
    const result = deriveMissingAmount(
      draft({ hst: "0.00", tip: "0.00", otherFees: "0.00", total: "-50.00" }),
    );
    expect(result).toEqual({ field: "subtotal", cents: -5000, formula: expect.any(String) });
  });

  it("refuses a result outside the storable cents range", () => {
    // subtotal ($21,474,836.47) + hst ($0.01) already exceeds
    // MAX_STORABLE_CENTS by one cent, so the derived total would too.
    const result = deriveMissingAmount(
      draft({ subtotal: "21474836.47", hst: "0.01", tip: "0.00", otherFees: "0.00" }),
    );
    expect(result).toBeNull();
  });

  it("derives nothing while a box is mid-keystroke unparseable", () => {
    expect(
      deriveMissingAmount(
        draft({ subtotal: "100.00", hst: "13.00", otherFees: "1.", total: "138.00" }),
      ),
    ).toBeNull();
  });
});

describe("reconciliationSuggestions - proposal #1's second offer, all five present but mismatched", () => {
  it("offers both a tip fix and an other-fees fix when the shortfall makes both non-negative", () => {
    // $100 subtotal + $13 HST + $5 tip + $0 other fees = $118, but the
    // receipt says $138 total - an $20 shortfall the person under-recorded
    // somewhere in tip or other fees.
    const result = reconciliationSuggestions(
      draft({ subtotal: "100.00", hst: "13.00", tip: "5.00", otherFees: "0.00", total: "138.00" }),
    );
    expect(result?.tip).toEqual({ field: "tip", cents: 2500, formula: expect.any(String) });
    expect(result?.otherFees).toEqual({
      field: "otherFees",
      cents: 2000,
      formula: expect.any(String),
    });
  });

  it("refuses only the half of the offer that would be a negative tip or fee", () => {
    // Solving for tip ($27) stays positive; solving for other fees instead
    // would require -$23, which is refused - the same rule
    // deriveMissingAmount enforces, reused rather than duplicated.
    const result = reconciliationSuggestions(
      draft({ subtotal: "100.00", hst: "13.00", tip: "50.00", otherFees: "0.00", total: "140.00" }),
    );
    expect(result?.tip).toEqual({ field: "tip", cents: 2700, formula: expect.any(String) });
    expect(result?.otherFees).toBeNull();
  });

  it("offers nothing when the five already reconcile", () => {
    expect(
      reconciliationSuggestions(
        draft({
          subtotal: "100.00",
          hst: "13.00",
          tip: "20.00",
          otherFees: "5.00",
          total: "138.00",
        }),
      ),
    ).toBeNull();
  });

  it("offers nothing when a field is blank - deriveMissingAmount is the offer for that case", () => {
    expect(
      reconciliationSuggestions(
        draft({ subtotal: "100.00", hst: "13.00", otherFees: "5.00", total: "138.00" }),
      ),
    ).toBeNull();
  });

  it("offers nothing while a box is mid-keystroke unparseable", () => {
    expect(
      reconciliationSuggestions(
        draft({ subtotal: "100.00", hst: "13.00", tip: "1.", otherFees: "5.00", total: "138.00" }),
      ),
    ).toBeNull();
  });
});

describe("vendorDefaultFill - proposal #2's live vendor default", () => {
  const NO_TOUCH = new Set<keyof ReceiptDraft>();
  const vendorDefaults: ReceiptOptions["vendorDefaults"] = {
    "Food Basics": { category: "groceries", paymentMethod: "visa" },
    "Cash Only Diner": { category: "meals", paymentMethod: null },
  };

  it("fills both fields when the vendor matches and both are empty", () => {
    const fill = vendorDefaultFill(
      draft({ vendor: "Food Basics" }),
      NO_TOUCH,
      vendorDefaults,
    );
    expect(fill).toEqual({ category: "groceries", paymentMethod: "visa" });
  });

  it("never overwrites a value the person already typed", () => {
    const fill = vendorDefaultFill(
      draft({ vendor: "Food Basics", category: "office supplies" }),
      NO_TOUCH,
      vendorDefaults,
    );
    expect(fill.category).toBeNull();
    expect(fill.paymentMethod).toBe("visa");
  });

  it("never re-applies to a field that has been touched, even if it is empty again", () => {
    const touched = new Set<keyof ReceiptDraft>(["category"]);
    const fill = vendorDefaultFill(draft({ vendor: "Food Basics" }), touched, vendorDefaults);
    expect(fill.category).toBeNull();
    expect(fill.paymentMethod).toBe("visa");
  });

  it("never overwrites a confirmed receipt's existing values - covered by the same empty-only rule", () => {
    // A confirmed receipt's draft carries its own stored category/payment
    // (draftFromReceipt), so this is the same "field is non-empty" check
    // as the typed-value case above, exercised against a value that came
    // from the row itself rather than a keystroke.
    const fill = vendorDefaultFill(
      draft({ vendor: "Food Basics", category: "meals", paymentMethod: "amex" }),
      NO_TOUCH,
      vendorDefaults,
    );
    expect(fill).toEqual({ category: null, paymentMethod: null });
  });

  it("offers nothing for a vendor with no stored default", () => {
    const fill = vendorDefaultFill(
      draft({ vendor: "Somewhere New" }),
      NO_TOUCH,
      vendorDefaults,
    );
    expect(fill).toEqual({ category: null, paymentMethod: null });
  });

  it("matches the vendor string exactly - no trim, no case fold", () => {
    expect(
      vendorDefaultFill(draft({ vendor: "food basics" }), NO_TOUCH, vendorDefaults),
    ).toEqual({ category: null, paymentMethod: null });
    expect(
      vendorDefaultFill(draft({ vendor: "Food Basics " }), NO_TOUCH, vendorDefaults),
    ).toEqual({ category: null, paymentMethod: null });
  });

  it("fills only the field the vendor has a default for", () => {
    // "Cash Only Diner" has a category default and no payment default.
    const fill = vendorDefaultFill(
      draft({ vendor: "Cash Only Diner" }),
      NO_TOUCH,
      vendorDefaults,
    );
    expect(fill).toEqual({ category: "meals", paymentMethod: null });
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

/**
 * Proposal #7's rate hint, mirrored from the server's own
 * `checkHstRatePlausibility` (server/src/domain/arithmetic.ts) - the same
 * boundary values as that function's own test suite
 * (server/tests/unit/arithmetic.test.ts), pinned again here so the two
 * cannot quietly drift apart.
 */
describe("checkHstRatePlausibility - mirrored from the server function of the same name", () => {
  it("is not applicable without a subtotal", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: null, hstCents: 800 }),
    ).toBe("not-applicable");
  });

  it("is not applicable without an HST amount", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: null }),
    ).toBe("not-applicable");
  });

  it("is not applicable with a zero subtotal - no rate to anchor", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 0, hstCents: 0 }),
    ).toBe("not-applicable");
  });

  it("is not applicable with a negative subtotal", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: -10000, hstCents: -800 }),
    ).toBe("not-applicable");
  });

  it("does not flag a legitimate 5% GST-only receipt", () => {
    // A lone GST row is a real tax - flagging near-5% would fire on every
    // GST-only-province receipt, and nothing here knows the province.
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 500 }),
    ).toBe("plausible");
  });

  it("does not flag a legitimate 13% Ontario receipt", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 1300 }),
    ).toBe("plausible");
  });

  it("does not flag a legitimate 15% Atlantic-province receipt", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 1500 }),
    ).toBe("plausible");
  });

  it("does not flag a genuinely exempt (0%) receipt", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 0 }),
    ).toBe("plausible");
  });

  it("flags an 8% receipt as looking like half a split", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 800 }),
    ).toBe("looks-like-half-split");
  });

  it("flags the exact lower boundary of the tolerance (7.75%)", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 775 }),
    ).toBe("looks-like-half-split");
  });

  it("does not flag just below the lower boundary (7.74%)", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 774 }),
    ).toBe("plausible");
  });

  it("flags the exact upper boundary of the tolerance (8.25%)", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 825 }),
    ).toBe("looks-like-half-split");
  });

  it("does not flag just above the upper boundary (8.26%)", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 10000, hstCents: 826 }),
    ).toBe("plausible");
  });

  it("holds the same boundary at a different subtotal scale", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: 100000, hstCents: 7750 }),
    ).toBe("looks-like-half-split");
    expect(
      checkHstRatePlausibility({ subtotalCents: 100000, hstCents: 7749 }),
    ).toBe("plausible");
  });

  /**
   * The boundary case a float implementation would get wrong, pinned.
   * $100.00 subtotal / $7.75 HST is exactly the lower edge (7.75%) and
   * MUST flag - but a naive float check computed the ordinary way,
   * `Math.abs(hstCents / subtotalCents - 0.08) <= 0.0025`, gets it wrong:
   *
   *   Math.abs(775 / 10000 - 0.08) === 0.0025000000000000022
   *
   * ...which is a hair OVER 0.0025 and would wrongly report "plausible" -
   * excluding the exact boundary the server's own test suite pins as
   * "looks-like-half-split". Integer cross-multiplication (this function,
   * and the server's) has no such edge: `775 * 10000` and `775 *
   * subtotalCents` are exact integers with nothing to round.
   */
  it("would be wrongly excluded by a naive float check at this exact boundary", () => {
    const subtotalCents = 10000;
    const hstCents = 775;
    const naiveFloatCheck =
      Math.abs(hstCents / subtotalCents - 0.08) <= 0.0025;
    expect(naiveFloatCheck).toBe(false); // the float bug, demonstrated
    expect(checkHstRatePlausibility({ subtotalCents, hstCents })).toBe(
      "looks-like-half-split",
    ); // the integer implementation gets it right
  });
});

describe("hstRateHintNote - proposal #7's live note, gated the same way as the disagreement notes", () => {
  const NO_TOUCH = new Set<keyof ReceiptDraft>();

  function pendingReceipt(): Receipt {
    return receipt({ status: "pending" });
  }

  it("renders when subtotal and HST land in the half-split band", () => {
    const d = draft({ subtotal: "$100.00", hst: "$7.75" });
    expect(hstRateHintNote(pendingReceipt(), d, NO_TOUCH)).toBe(true);
  });

  it("does not render for a plausible 13% receipt", () => {
    const d = draft({ subtotal: "$100.00", hst: "$13.00" });
    expect(hstRateHintNote(pendingReceipt(), d, NO_TOUCH)).toBe(false);
  });

  it("does not render with no subtotal or HST typed yet", () => {
    expect(hstRateHintNote(pendingReceipt(), draft(), NO_TOUCH)).toBe(false);
  });

  it("stays silent on a mid-keystroke unparseable box rather than guessing", () => {
    const d = draft({ subtotal: "$100.00", hst: "7." });
    expect(hstRateHintNote(pendingReceipt(), d, NO_TOUCH)).toBe(false);
  });

  it("clears once the HST field is touched, matching the disagreement notes", () => {
    const d = draft({ subtotal: "$100.00", hst: "$8.00" });
    const touched = new Set<keyof ReceiptDraft>(["hst"]);
    expect(hstRateHintNote(pendingReceipt(), d, touched)).toBe(false);
  });

  it("touching a different field does not clear it", () => {
    const d = draft({ subtotal: "$100.00", hst: "$8.00" });
    const touched = new Set<keyof ReceiptDraft>(["vendor"]);
    expect(hstRateHintNote(pendingReceipt(), d, touched)).toBe(true);
  });

  it("never renders on a confirmed receipt", () => {
    const d = draft({ subtotal: "$100.00", hst: "$8.00" });
    const confirmed = { ...pendingReceipt(), status: "confirmed" as const };
    expect(hstRateHintNote(confirmed, d, NO_TOUCH)).toBe(false);
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

describe("summarizeFieldEdits - client-applied sources folded into the save-time mechanism (2026-08-28, the owner's ruling)", () => {
  // The defect this section exists to catch: derived-amount fills
  // (proposal #1) and vendor defaults (proposal #2) used to fire
  // `suggestion_accepted` the instant a fill was applied, which could never
  // emit `overridden` for a fill someone went on to correct - structurally
  // always-accepted on this client, unlike iOS's save-time snapshot. Both
  // sources are now reported through `onSuggestionApplied` and scored here,
  // the same save-time mechanism `suggestedFields` (the server's OCR merge)
  // already used - `clientAppliedFields` is exactly what
  // `ReceiptFieldsForm`'s `onSuggestionApplied` callback accumulates.

  it("a derived-amount fill left alone at save reports accepted", () => {
    // A receipt with no server-sourced suggestions at all (suggestions:
    // null) - the outcome can only have come from the client-applied set,
    // proving this path does not depend on suggestedFields.
    const row = receipt({ suggestions: null });
    const clientApplied = new Set<SuggestibleField>(["otherFees"]);
    // Never edited after the fill landed.
    const { suggestionOutcomes } = summarizeFieldEdits(row, [], clientApplied);
    expect(suggestionOutcomes).toEqual([{ field: "otherFees", accepted: true }]);
  });

  it("a derived-amount fill subsequently edited reports overridden", () => {
    const row = receipt({ suggestions: null });
    const clientApplied = new Set<SuggestibleField>(["otherFees"]);
    // The person clicked Fill, then typed a correction into the same box -
    // `onFieldEdited` reports it exactly like any other keystroke.
    const { suggestionOutcomes } = summarizeFieldEdits(row, ["otherFees"], clientApplied);
    expect(suggestionOutcomes).toEqual([{ field: "otherFees", accepted: false }]);
  });

  it("a vendor default left alone at save reports accepted", () => {
    const row = receipt({ suggestions: null });
    const clientApplied = new Set<SuggestibleField>(["category"]);
    const { suggestionOutcomes } = summarizeFieldEdits(row, [], clientApplied);
    expect(suggestionOutcomes).toEqual([{ field: "category", accepted: true }]);
  });

  it("a vendor default subsequently edited reports overridden", () => {
    const row = receipt({ suggestions: null });
    const clientApplied = new Set<SuggestibleField>(["category"]);
    const { suggestionOutcomes } = summarizeFieldEdits(row, ["category"], clientApplied);
    expect(suggestionOutcomes).toEqual([{ field: "category", accepted: false }]);
  });

  it("unions server-sourced and client-applied fields without double-counting", () => {
    const row = receipt({
      status: "pending",
      suggestions: {
        vendor: { value: "Food Basics", source: "llm" },
        purchasedAt: { value: "2026-08-19", source: "heuristic", disagreement: false },
        totalCents: { value: null, source: null },
        hstCents: { value: null, source: null, disagreement: false },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });
    // "vendor" is server-suggested; "paymentMethod" only ever arrived via
    // the client-applied set. Both fields untouched.
    const clientApplied = new Set<SuggestibleField>(["paymentMethod"]);
    const { suggestionOutcomes } = summarizeFieldEdits(row, [], clientApplied);
    expect(suggestionOutcomes).toEqual(
      expect.arrayContaining([
        { field: "vendor", accepted: true },
        { field: "purchasedAt", accepted: true },
        { field: "paymentMethod", accepted: true },
      ]),
    );
    expect(suggestionOutcomes).toHaveLength(3);
  });

  it("defaults to an empty client-applied set when the caller passes none", () => {
    // logFieldEditTelemetry's third argument is optional; summarizeFieldEdits
    // must behave exactly as it did before this change when it is omitted.
    const row = receipt({ suggestions: null });
    expect(summarizeFieldEdits(row, ["vendor"]).suggestionOutcomes).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────
   2026-09-01: reviewed fields and "save for later", and the amount rules
   that came with them. Everything below is pure - the React component
   these feed is not under test here, the decisions it renders are.
   ──────────────────────────────────────────────────────────────────────── */

describe("reviewedFieldsForSave - what a save reports as looked at", () => {
  it("unions the receipt's stored set with this session's touched fields", () => {
    const row = receipt({ reviewedFields: ["vendor", "totalCents"] });
    expect(
      reviewedFieldsForSave(row, new Set(["hst", "category"])),
    ).toEqual(["vendor", "hstCents", "totalCents", "category"]);
  });

  it("never drops a field reviewed on an earlier visit", () => {
    // The PATCH replaces the stored set outright, so sending only today's
    // touches would silently un-review last week's - handing the parser
    // back a field it had already lost.
    const row = receipt({ reviewedFields: ["vendor", "notes"] });
    expect(reviewedFieldsForSave(row, new Set(["hst"]))).toEqual([
      "vendor",
      "hstCents",
      "notes",
    ]);
  });

  it("translates every draft key to the server's own field name", () => {
    const row = receipt();
    expect(
      reviewedFieldsForSave(
        row,
        new Set([
          "total",
          "purchasedAt",
          "vendor",
          "hst",
          "subtotal",
          "tip",
          "otherFees",
          "category",
          "paymentMethod",
          "notes",
        ]),
      ),
    ).toEqual([
      "purchasedAt",
      "vendor",
      "subtotalCents",
      "hstCents",
      "tipCents",
      "otherFeesCents",
      "totalCents",
      "category",
      "paymentMethod",
      "notes",
    ]);
  });

  it("orders by the vocabulary, not by the order fields were touched", () => {
    // A request body that varied with click order is one no test can pin.
    const row = receipt();
    expect(reviewedFieldsForSave(row, new Set(["notes", "vendor"]))).toEqual([
      "vendor",
      "notes",
    ]);
  });

  it("is empty when nothing has ever been reviewed", () => {
    expect(reviewedFieldsForSave(receipt(), new Set())).toEqual([]);
  });
});

describe("the two patch shapes - save for later versus confirm", () => {
  const row = receipt({ vendor: "Basics", totalCents: 1435 });
  const edited = draft({
    total: "$14.35",
    vendor: "Food Basics",
    purchasedAt: "2026-08-21",
  });

  it("save for later carries the edits and the reviewed set, and NO status", () => {
    const patch = patchForSaveForLater(row, edited, new Set(["vendor"]));
    expect(patch).toEqual({
      vendor: "Food Basics",
      reviewedFields: ["vendor"],
    });
    // The absence is the whole feature: a PATCH without `status` leaves
    // the receipt pending, in the queue, out of every export.
    expect("status" in patch).toBe(false);
  });

  it("confirm carries everything save-for-later does, plus status", () => {
    // The two stopped being "exactly one key apart" later on 2026-09-01,
    // when save-for-later narrowed to the reviewed fields' values - see the
    // `patchForSaveForLater - only the reviewed fields' values are written`
    // block below for the case where they genuinely differ. Nothing
    // untouched differs from the row in this fixture, so here they still
    // land one key apart, and confirm remains a superset by construction.
    const later = patchForSaveForLater(row, edited, new Set(["vendor"]));
    const confirmed = patchForConfirm(row, edited, new Set(["vendor"]));
    expect(confirmed).toMatchObject({ ...later, status: "confirmed" });
  });

  it("names the field when money does not parse, from either builder", () => {
    const bad = draft({ total: "twelve dollars" });
    expect(() => patchForSaveForLater(row, bad, new Set())).toThrow(DraftError);
    expect(() => patchForConfirm(row, bad, new Set())).toThrow(/total/);
  });
});

describe("patchChangesNothing - what the detail screen calls a no-op", () => {
  it("is true when only the already-stored reviewed set would be re-sent", () => {
    const row = receipt({ reviewedFields: ["vendor"] });
    expect(
      patchChangesNothing(row, { reviewedFields: ["vendor"] }),
    ).toBe(true);
  });

  it("is false when the reviewed set grew - marking a field reviewed is a change", () => {
    const row = receipt({ reviewedFields: ["vendor"] });
    expect(
      patchChangesNothing(row, { reviewedFields: ["vendor", "hstCents"] }),
    ).toBe(false);
  });

  it("is false whenever any field is in the patch", () => {
    const row = receipt({ reviewedFields: ["vendor"] });
    expect(
      patchChangesNothing(row, { vendor: "Staples", reviewedFields: ["vendor"] }),
    ).toBe(false);
    expect(patchChangesNothing(row, { status: "confirmed" })).toBe(false);
  });

  it("ignores the order the set arrives in", () => {
    const row = receipt({ reviewedFields: ["vendor", "hstCents"] });
    expect(
      patchChangesNothing(row, { reviewedFields: ["hstCents", "vendor"] }),
    ).toBe(true);
  });
});

describe("draftFromPending - a reviewed field is the human's, not the parser's", () => {
  const withSuggestions = (reviewedFields: Receipt["reviewedFields"]) =>
    receipt({
      reviewedFields,
      vendor: "Food Basics",
      totalCents: 1435,
      suggestions: {
        vendor: { value: "F00D BASlCS", source: "heuristic" },
        purchasedAt: { value: "2026-08-19", source: "both", disagreement: false },
        totalCents: { value: 9999, source: "heuristic" },
        hstCents: { value: null, source: null, disagreement: false },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });

  it("prefills a reviewed field from the row even when a suggestion is served", () => {
    // The server normally stops serving these at all; this is the belt to
    // that braces, and it is what keeps a value typed last Tuesday from
    // being overwritten by an OCR guess today.
    const d = draftFromPending(withSuggestions(["vendor", "totalCents"]));
    expect(d.vendor).toBe("Food Basics");
    expect(d.total).toBe("$14.35");
  });

  it("still prefers the suggestion for every field nobody has reviewed", () => {
    const d = draftFromPending(withSuggestions(["vendor"]));
    expect(d.vendor).toBe("Food Basics");
    expect(d.total).toBe("$99.99");
    expect(d.purchasedAt).toBe("2026-08-19");
  });

  it("never marks a reviewed field as carrying a suggestion at save time", () => {
    // `summarizeFieldEdits` reads the same amber-source set the tint does,
    // so a reviewed field producing no accepted/overridden outcome is the
    // testable half of "a reviewed field is never amber".
    const { suggestionOutcomes } = summarizeFieldEdits(
      withSuggestions(["vendor", "totalCents"]),
      [],
    );
    expect(suggestionOutcomes.map((outcome) => outcome.field).sort()).toEqual([
      "purchasedAt",
    ]);
  });
});

describe("suggestDefaultRateHst - the mirror of the server function of the same name", () => {
  it("computes 13% of a subtotal and the total it implies", () => {
    expect(suggestDefaultRateHst(1270)).toEqual({ hstCents: 165, totalCents: 1435 });
  });

  it("rounds half UP, in integers, never through a float", () => {
    // 50c at 13% is exactly 6.5c. Half-up is 7; banker's rounding - which
    // is what a naive float path can produce - would say 6.
    expect(suggestDefaultRateHst(50)).toEqual({ hstCents: 7, totalCents: 57 });
    // 46c at 13% is 5.98c -> 6c, ordinary rounding up from a non-half.
    expect(suggestDefaultRateHst(46)?.hstCents).toBe(6);
    // 30c at 13% is 3.9c -> 4c.
    expect(suggestDefaultRateHst(30)?.hstCents).toBe(4);
  });

  it("takes the rate as basis points, so no other rate is hard-coded", () => {
    // A GST-only province at 5%: $10.00 -> 50c.
    expect(suggestDefaultRateHst(1000, 500)).toEqual({
      hstCents: 50,
      totalCents: 1050,
    });
  });

  it("offers nothing for a zero or negative subtotal", () => {
    // No rate applies to nothing, and a refund's negative subtotal is not
    // a receipt anyone wants a suggested tax on.
    expect(suggestDefaultRateHst(0)).toBeNull();
    expect(suggestDefaultRateHst(-1270)).toBeNull();
  });

  it("stays in safe-integer arithmetic at the top of the storable range", () => {
    const result = suggestDefaultRateHst(2_147_483_647);
    expect(Number.isSafeInteger(result?.hstCents ?? NaN)).toBe(true);
  });
});

describe("checkAmountFloor - a total below the charges that make it up", () => {
  const amounts = (overrides: Partial<Parameters<typeof checkAmountFloor>[0]>) => ({
    subtotalCents: null,
    hstCents: null,
    tipCents: null,
    otherFeesCents: null,
    totalCents: null,
    ...overrides,
  });

  it("has nothing to compare without a subtotal or without a total", () => {
    expect(checkAmountFloor(amounts({ totalCents: 1435 }))).toBe("not-applicable");
    expect(checkAmountFloor(amounts({ subtotalCents: 1270 }))).toBe("not-applicable");
  });

  it("is satisfied when the total matches or exceeds its components", () => {
    expect(
      checkAmountFloor(amounts({ subtotalCents: 1270, hstCents: 165, totalCents: 1435 })),
    ).toBe("ok");
    // Above the sum is an ordinary receipt with a line this form has no
    // box for - the arithmetic warning's business, not this one's.
    expect(
      checkAmountFloor(amounts({ subtotalCents: 1270, totalCents: 1500 })),
    ).toBe("ok");
  });

  it("flags a total below the sum of subtotal, HST, tip and fees", () => {
    expect(
      checkAmountFloor(
        amounts({ subtotalCents: 1270, hstCents: 165, totalCents: 1300 }),
      ),
    ).toBe("total-below-components");
    expect(
      checkAmountFloor(
        amounts({ subtotalCents: 1270, tipCents: 300, totalCents: 1400 }),
      ),
    ).toBe("total-below-components");
  });

  it("counts a blank HST, tip or fee as zero, as every other check here does", () => {
    expect(
      checkAmountFloor(amounts({ subtotalCents: 1270, totalCents: 1270 })),
    ).toBe("ok");
  });
});

describe("amountFloorNote - the floor check over the live draft", () => {
  it("fires when the typed total is below the typed components", () => {
    expect(
      amountFloorNote(draft({ subtotal: "12.70", hst: "1.65", total: "13.00" })),
    ).toBe(true);
  });

  it("stays silent on a consistent receipt", () => {
    expect(
      amountFloorNote(draft({ subtotal: "12.70", hst: "1.65", total: "14.35" })),
    ).toBe(false);
  });

  it("stays silent on a mid-keystroke unparseable box rather than guessing", () => {
    expect(
      amountFloorNote(draft({ subtotal: "12.", hst: "1.65", total: "13.00" })),
    ).toBe(false);
  });
});

describe("applyComponentEdit - total tracks its components while consistent", () => {
  it("Flow A: leaves a total that came off the paper alone", () => {
    // OCR found the total and nothing else; typing a subtotal must not
    // overwrite the one figure the parsers get right most often.
    const next = applyComponentEdit(draft({ total: "$14.35" }), "subtotal", "12.70");
    expect(next.subtotal).toBe("12.70");
    expect(next.total).toBe("$14.35");
  });

  it("Flow B: fills a blank total from the components, then keeps it in step", () => {
    const first = applyComponentEdit(draft(), "subtotal", "12.70");
    expect(first.total).toBe("$12.70");
    const second = applyComponentEdit(first, "hst", "1.65");
    expect(second.total).toBe("$14.35");
  });

  it("Flow C: follows a corrected component while the total still agreed", () => {
    const next = applyComponentEdit(
      draft({ subtotal: "12.70", hst: "1.65", total: "14.35" }),
      "hst",
      "1.60",
    );
    expect(next.total).toBe("$14.30");
  });

  it("stops tracking the moment the total says something the components do not", () => {
    // $20.00 against components of $14.35: the total is the person's own
    // number now, and no keystroke elsewhere may quietly overwrite it.
    const next = applyComponentEdit(
      draft({ subtotal: "12.70", hst: "1.65", total: "20.00" }),
      "hst",
      "1.60",
    );
    expect(next.total).toBe("20.00");
  });

  it("leaves the total alone while the subtotal is blank - nothing to sum", () => {
    expect(applyComponentEdit(draft(), "hst", "1.65").total).toBe("");
    expect(
      applyComponentEdit(
        draft({ subtotal: "12.70", hst: "1.65", total: "14.35" }),
        "subtotal",
        "",
      ).total,
    ).toBe("14.35");
  });

  it("leaves the total alone while a box is mid-keystroke unparseable", () => {
    expect(
      applyComponentEdit(draft({ subtotal: "12.70", total: "12.70" }), "hst", "1.")
        .total,
    ).toBe("12.70");
  });

  it("tracks tip and other fees too, not just subtotal and HST", () => {
    const tipped = applyComponentEdit(
      draft({ subtotal: "100.00", hst: "13.00", total: "113.00" }),
      "tip",
      "20.00",
    );
    expect(tipped.total).toBe("$133.00");
    expect(applyComponentEdit(tipped, "otherFees", "5.00").total).toBe("$138.00");
  });

  it("never treats the total itself as a component", () => {
    // Editing the total changes nothing else, in either direction - the
    // total is the anchor, so it is not routed through this function at all.
    expect(isComponentAmountField("total")).toBe(false);
    expect(isComponentAmountField("subtotal")).toBe(true);
    expect(isComponentAmountField("vendor")).toBe(false);
  });
});

describe("hstSuggestionChip - the offer for a blank HST box", () => {
  it("offers the difference when a total is on the receipt", () => {
    // Flow A's second half: OCR total $14.35, subtotal typed as $12.70.
    expect(hstSuggestionChip(draft({ subtotal: "12.70", total: "14.35" }), "CAD")).toEqual({
      field: "hst",
      cents: 165,
      kind: "hst-from-total",
      formula: "HST = total − subtotal − tip − other fees",
    });
  });

  it("subtracts tip and other fees from that difference", () => {
    expect(
      hstSuggestionChip(
        draft({ subtotal: "100.00", tip: "20.00", otherFees: "5.00", total: "138.00" }), "CAD"
      )?.cents,
    ).toBe(1300);
  });

  it("falls back to the default rate when there is no total to subtract from", () => {
    expect(hstSuggestionChip(draft({ subtotal: "12.70" }), "CAD")).toEqual({
      field: "hst",
      cents: 165,
      kind: "hst-at-default-rate",
      formula: "HST at 13% of subtotal",
    });
  });

  it("falls back to the default rate when the difference is zero or negative", () => {
    // A total that already equals its subtotal says nothing about tax; a
    // total below it is evidence another box is wrong. Neither is an HST
    // amount anyone could act on, so the honest offer is the rate.
    expect(
      hstSuggestionChip(draft({ subtotal: "12.70", total: "12.70" }), "CAD")?.kind,
    ).toBe("hst-at-default-rate");
    expect(
      hstSuggestionChip(draft({ subtotal: "12.70", total: "10.00" }), "CAD")?.kind,
    ).toBe("hst-at-default-rate");
  });

  it("offers nothing once HST has a value - including a deliberate zero", () => {
    expect(hstSuggestionChip(draft({ subtotal: "12.70", hst: "1.65" }), "CAD")).toBeNull();
    expect(hstSuggestionChip(draft({ subtotal: "12.70", hst: "0" }), "CAD")).toBeNull();
  });

  it("offers nothing without a subtotal to work from", () => {
    expect(hstSuggestionChip(draft({ total: "14.35" }), "CAD")).toBeNull();
  });

  it("offers nothing on a zero or negative subtotal", () => {
    expect(hstSuggestionChip(draft({ subtotal: "0" }), "CAD")).toBeNull();
    expect(hstSuggestionChip(draft({ subtotal: "-12.70" }), "CAD")).toBeNull();
  });

  it("stays silent while a box is mid-keystroke unparseable", () => {
    expect(hstSuggestionChip(draft({ subtotal: "12.7O" }), "CAD")).toBeNull();
  });

  it("moves the total too when applied, through the tracking rule", () => {
    // The chip's own promise: "HST at 13% of subtotal" on a blank-total
    // draft means $12.70 becomes $12.70 + $1.65.
    const start = draft({ subtotal: "12.70" });
    const chip = hstSuggestionChip(start, "CAD");
    const next = applyComponentEdit(start, "hst", "$1.65");
    expect(chip?.cents).toBe(165);
    expect(next.total).toBe("$14.35");
  });
});

/* ────────────────────────────────────────────────────────────────────────
   2026-09-01, later the same day: a save-for-later that writes only what a
   human looked at, the withheld-amounts note, and the two suggestions the
   merge gained (payment method and other fees).
   ──────────────────────────────────────────────────────────────────────── */

describe("patchForSaveForLater - only the reviewed fields' values are written", () => {
  /**
   * The defect this whole block exists to catch. The form is PREFILLED from
   * the merge, so a save-for-later that diffed the whole draft wrote the
   * parser's guesses into the row for every field nobody touched - the
   * suggested total became the stored total, and stopped being a
   * suggestion. Constraint 2: no OCR value saves without a human confirming
   * it, and a save-for-later is by definition the moment nobody has.
   */
  const row = receipt({
    vendor: null,
    totalCents: null,
    suggestions: merged({
      vendor: { value: "Food Basics", source: "llm" },
      totalCents: { value: 1435, source: "heuristic" },
    }),
  });
  // Exactly what is on screen when the receipt opens, then one edit.
  const onScreen = draftFromPending(row);
  const edited = { ...onScreen, vendor: "Food Basics #12" };

  it("prefills both fields on screen - the precondition the rest of this block needs", () => {
    expect(onScreen.vendor).toBe("Food Basics");
    expect(onScreen.total).toBe("$14.35");
  });

  it("sends a touched vendor and NOT the untouched suggested total", () => {
    const patch = patchForSaveForLater(row, edited, new Set(["vendor"]));
    expect(patch).toEqual({
      vendor: "Food Basics #12",
      reviewedFields: ["vendor"],
    });
    expect("totalCents" in patch).toBe(false);
  });

  it("confirm still sends the total - accepting the whole form is the confirmation", () => {
    const patch = patchForConfirm(row, edited, new Set(["vendor"]));
    expect(patch).toEqual({
      vendor: "Food Basics #12",
      totalCents: 1435,
      reviewedFields: ["vendor"],
      status: "confirmed",
    });
  });

  it("sends nothing at all when the one edit was reverted to the row's value", () => {
    // Vendor touched, but typed back to nothing - the row's own state. The
    // reviewed set still grew, which is the change worth sending.
    const reverted = { ...onScreen, vendor: "" };
    expect(patchForSaveForLater(row, reverted, new Set(["vendor"]))).toEqual({
      reviewedFields: ["vendor"],
    });
  });

  it("carries a field reviewed on an earlier visit, not just today's touches", () => {
    // The reviewed set is a union across visits (`reviewedFieldsForSave`),
    // and the patch is limited by that union - so a field looked at last
    // week is still writable this week without being re-touched.
    const earlier = receipt({
      reviewedFields: ["totalCents"],
      totalCents: 1435,
      suggestions: merged({ vendor: { value: "Food Basics", source: "llm" } }),
    });
    const d = { ...draftFromPending(earlier), total: "$14.99" };
    expect(patchForSaveForLater(earlier, d, new Set())).toEqual({
      totalCents: 1499,
      reviewedFields: ["totalCents"],
    });
  });

  it("still refuses an unparseable amount in a field nobody reviewed", () => {
    // The money parser runs over every box before the narrowing, on
    // purpose: a form that quietly saved around a number it could not read
    // would be masking exactly the error it should be naming.
    const bad = { ...onScreen, hst: "abc" };
    expect(() => patchForSaveForLater(row, bad, new Set(["vendor"]))).toThrow(
      DraftError,
    );
    expect(() => patchForSaveForLater(row, bad, new Set(["vendor"]))).toThrow(/HST/);
  });

  it("never writes a suggested value into the row for a field left untouched", () => {
    // The general statement of the same rule, over every field the merge
    // can prefill at once: nothing is reviewed, so nothing is written.
    const suggestedEverywhere = receipt({
      suggestions: merged({
        vendor: { value: "Food Basics", source: "llm" },
        purchasedAt: { value: "2026-08-19", source: "both", disagreement: false },
        totalCents: { value: 1435, source: "heuristic" },
        hstCents: { value: 165, source: "heuristic", disagreement: false },
        subtotalCents: { value: 1270, source: "heuristic" },
        tipCents: { value: 0, source: "heuristic" },
        otherFeesCents: { value: 0, source: "llm" },
        paymentMethod: { value: "MASTERCARD", source: "llm" },
      }),
    });
    const patch = patchForSaveForLater(
      suggestedEverywhere,
      draftFromPending(suggestedEverywhere),
      new Set(),
    );
    expect(patch).toEqual({ reviewedFields: [] });
  });
});

describe("patchChangesNothing - the confirmed-receipt edit that sends no reviewed set", () => {
  it("calls an empty patch a no-op even on a receipt with a stored reviewed set", () => {
    // Predicted before running (CLAUDE.md: predict before verifying). A
    // confirmed receipt that was half-filled before it was confirmed still
    // carries `reviewedFields` on the row, while the confirmed-receipt edit
    // path builds its patch with `patchFromDraft` alone and sends no set at
    // all. Comparing that absence against the stored set reported "changed"
    // and put `PATCH {}` on the wire for every no-op save.
    const row = receipt({ status: "confirmed", reviewedFields: ["vendor"] });
    expect(patchChangesNothing(row, {})).toBe(true);
  });

  it("still calls an empty reviewed set against a stored non-empty one a change", () => {
    // Sending `reviewedFields: []` is a real instruction - un-review
    // everything - and is not the same as not sending the key.
    const row = receipt({ reviewedFields: ["vendor"] });
    expect(patchChangesNothing(row, { reviewedFields: [] })).toBe(false);
  });
});

describe("withheldAmountsNote - why an amount box is empty (2026-09-01)", () => {
  const NO_TOUCH = new Set<keyof ReceiptDraft>();
  const withheld = (): WithholdableAmountSuggestion => ({
    value: null,
    source: null,
    withheld: true,
  });

  function pending(overrides: Partial<MergedSuggestions>): Receipt {
    return receipt({ status: "pending", suggestions: merged(overrides) });
  }

  it("names the total when the total alone was withheld", () => {
    expect(
      withheldAmountsNote(pending({ totalCents: withheld() }), NO_TOUCH),
    ).toBe(
      "The amounts read from this receipt didn't add up, so the total was left blank - enter it from the paper.",
    );
  });

  it("names the subtotal when the subtotal alone was withheld", () => {
    expect(
      withheldAmountsNote(pending({ subtotalCents: withheld() }), NO_TOUCH),
    ).toBe(
      "The amounts read from this receipt didn't add up, so the subtotal was left blank - enter it from the paper.",
    );
  });

  it("names both, plurally, when both were withheld", () => {
    expect(
      withheldAmountsNote(
        pending({ totalCents: withheld(), subtotalCents: withheld() }),
        NO_TOUCH,
      ),
    ).toBe(
      "The amounts read from this receipt didn't add up, so the total and subtotal were left blank - enter them from the paper.",
    );
  });

  it("says nothing when nothing was withheld", () => {
    expect(
      withheldAmountsNote(
        pending({ totalCents: { value: 1435, source: "heuristic" } }),
        NO_TOUCH,
      ),
    ).toBeNull();
  });

  it("says nothing for a merge that predates the flag entirely", () => {
    // An older response carries no `withheld` key at all; an absent flag
    // must read as false rather than as anything else.
    const older = receipt({
      status: "pending",
      suggestions: {
        vendor: { value: null, source: null },
        purchasedAt: { value: null, source: null, disagreement: false },
        totalCents: { value: null, source: null },
        hstCents: { value: null, source: null, disagreement: false },
        subtotalCents: { value: null, source: null },
        tipCents: { value: null, source: null },
      },
    });
    expect(withheldAmountsNote(older, NO_TOUCH)).toBeNull();
  });

  it("says nothing on a receipt with no suggestions at all", () => {
    expect(withheldAmountsNote(receipt({ suggestions: null }), NO_TOUCH)).toBeNull();
  });

  it("never renders on a confirmed receipt", () => {
    const confirmed = {
      ...pending({ totalCents: withheld() }),
      status: "confirmed" as const,
    };
    expect(withheldAmountsNote(confirmed, NO_TOUCH)).toBeNull();
  });

  it("clears once the total is typed - §10A.1's rule for every note here", () => {
    expect(
      withheldAmountsNote(
        pending({ totalCents: withheld() }),
        new Set<keyof ReceiptDraft>(["total"]),
      ),
    ).toBeNull();
  });

  it("narrows to the field still blank when only one of the two was typed", () => {
    expect(
      withheldAmountsNote(
        pending({ totalCents: withheld(), subtotalCents: withheld() }),
        new Set<keyof ReceiptDraft>(["total"]),
      ),
    ).toBe(
      "The amounts read from this receipt didn't add up, so the subtotal was left blank - enter it from the paper.",
    );
  });

  it("touching an unrelated field does not clear it", () => {
    expect(
      withheldAmountsNote(
        pending({ totalCents: withheld() }),
        new Set<keyof ReceiptDraft>(["vendor"]),
      ),
    ).not.toBeNull();
  });
});

describe("draftFromPending - a withheld amount lands blank, from anywhere", () => {
  /**
   * The production case the server's rule was written from: a $218.94
   * Costco purchase stored as $8.50, because the parser took "TOTAL
   * DISCOUNT(S) $ 8.50" for the total while reading the subtotal and HST
   * off the same slip correctly. The server withholds the total and sends
   * no value for it - and the row holds that same $8.50, because the row IS
   * the capture-time heuristic snapshot. Falling through to the row would
   * put the withheld number straight back on screen.
   */
  const costco = receipt({
    totalCents: 850,
    subtotalCents: 21160,
    hstCents: 734,
    suggestions: merged({
      totalCents: { value: null, source: null, withheld: true },
      subtotalCents: { value: 21160, source: "heuristic" },
      hstCents: { value: 734, source: "heuristic", disagreement: false },
    }),
  });

  it("leaves the box empty rather than falling back to the row's own copy", () => {
    const d = draftFromPending(costco);
    expect(d.total).toBe("");
    // The two amounts that corroborated each other are still offered.
    expect(d.subtotal).toBe("$211.60");
    expect(d.hst).toBe("$7.34");
  });

  it("blanks a withheld subtotal on the same terms", () => {
    const both = receipt({
      totalCents: 850,
      subtotalCents: 21160,
      suggestions: merged({
        totalCents: { value: null, source: null, withheld: true },
        subtotalCents: { value: null, source: null, withheld: true },
      }),
    });
    const d = draftFromPending(both);
    expect(d.total).toBe("");
    expect(d.subtotal).toBe("");
  });

  it("is not amber - nothing was suggested, so nothing may promise it was", () => {
    // `summarizeFieldEdits` reads the same server-sourced set the tint
    // does, so a withheld field producing no accepted/overridden outcome is
    // the testable half of "a withheld amount is never amber".
    const { suggestionOutcomes } = summarizeFieldEdits(costco, []);
    expect(suggestionOutcomes.map((outcome) => outcome.field).sort()).toEqual([
      "hst",
      "subtotal",
    ]);
  });

  it("still lets a reviewed field's row value win over the blanking rule", () => {
    // A human's typed total is never blanked by anything. The server cannot
    // actually produce this pair (a reviewed field's suggestion is
    // suppressed before the arithmetic rule runs, so it withholds nothing),
    // which is exactly why the client's ordering has to be pinned rather
    // than assumed.
    const reviewed: Receipt = {
      ...costco,
      totalCents: 21894,
      reviewedFields: ["totalCents"],
    };
    expect(draftFromPending(reviewed).total).toBe("$218.94");
  });
});

describe("draftFromPending - the payment-method and other-fees suggestions (2026-09-01)", () => {
  it("prefills payment method from the merge when the row has none", () => {
    const row = receipt({
      paymentMethod: null,
      suggestions: merged({ paymentMethod: { value: "MASTERCARD", source: "llm" } }),
    });
    expect(draftFromPending(row).paymentMethod).toBe("MASTERCARD");
  });

  it("prefills other fees from the merge when the row has none", () => {
    const row = receipt({
      otherFeesCents: null,
      suggestions: merged({ otherFeesCents: { value: 250, source: "llm" } }),
    });
    expect(draftFromPending(row).otherFees).toBe("$2.50");
  });

  it("lets the row's own value win over the served suggestion, unlike vendor", () => {
    // Precedence, first leg: row value > served suggestion. Neither field
    // has ever had a capture-time heuristic write behind it, so a value in
    // the row is a human's - the §7.1 reason the merge outranks a pending
    // row's copy does not apply to these two.
    const row = receipt({
      paymentMethod: "Amex",
      otherFeesCents: 900,
      suggestions: merged({
        paymentMethod: { value: "MASTERCARD", source: "llm" },
        otherFeesCents: { value: 250, source: "llm" },
      }),
    });
    const d = draftFromPending(row);
    expect(d.paymentMethod).toBe("Amex");
    expect(d.otherFees).toBe("$9.00");
  });

  it("marks a served suggestion amber, exactly as vendor and tip are", () => {
    const row = receipt({
      suggestions: merged({
        paymentMethod: { value: "MASTERCARD", source: "llm" },
        otherFeesCents: { value: 250, source: "llm" },
      }),
    });
    const { suggestionOutcomes } = summarizeFieldEdits(row, []);
    expect(suggestionOutcomes.map((outcome) => outcome.field).sort()).toEqual([
      "otherFees",
      "paymentMethod",
    ]);
  });

  it("does not mark a field amber when the row's value won", () => {
    // Amber promises "an unreviewed suggestion is sitting in this box". The
    // box holds the row's value here, so the promise would be false.
    const row = receipt({
      paymentMethod: "Amex",
      otherFeesCents: 900,
      suggestions: merged({
        paymentMethod: { value: "MASTERCARD", source: "llm" },
        otherFeesCents: { value: 250, source: "llm" },
      }),
    });
    expect(summarizeFieldEdits(row, []).suggestionOutcomes).toEqual([]);
  });

  it("a reviewed payment method is the human's, suggestion or not", () => {
    const row = receipt({
      paymentMethod: "Amex",
      reviewedFields: ["paymentMethod"],
      suggestions: merged({ paymentMethod: { value: "MASTERCARD", source: "llm" } }),
    });
    expect(draftFromPending(row).paymentMethod).toBe("Amex");
    expect(summarizeFieldEdits(row, []).suggestionOutcomes).toEqual([]);
  });
});

describe("the vendor default never overrides a served payment-method suggestion", () => {
  // Precedence, second leg: served suggestion > vendor default. It falls
  // out of `vendorDefaultFill`'s own "empty and untouched only" rule rather
  // than needing a rule of its own - which is the point of pinning it here,
  // because that rule is the only thing holding the ordering up.
  const vendorDefaults: ReceiptOptions["vendorDefaults"] = {
    "Food Basics": { category: "groceries", paymentMethod: "visa" },
  };

  it("offers nothing for payment method once the merge has prefilled it", () => {
    const row = receipt({
      vendor: null,
      paymentMethod: null,
      suggestions: merged({
        vendor: { value: "Food Basics", source: "llm" },
        paymentMethod: { value: "MASTERCARD", source: "llm" },
      }),
    });
    const d = draftFromPending(row);
    expect(d.paymentMethod).toBe("MASTERCARD");
    const fill = vendorDefaultFill(d, new Set(), vendorDefaults);
    expect(fill.paymentMethod).toBeNull();
    // Category has no served suggestion, so the default still applies there.
    expect(fill.category).toBe("groceries");
  });

  it("still applies when the merge served no payment method", () => {
    const row = receipt({
      vendor: null,
      paymentMethod: null,
      suggestions: merged({ vendor: { value: "Food Basics", source: "llm" } }),
    });
    const fill = vendorDefaultFill(draftFromPending(row), new Set(), vendorDefaults);
    expect(fill).toEqual({ category: "groceries", paymentMethod: "visa" });
  });

  it("and the row's own value outranks both", () => {
    // Full precedence in one case: row "Amex" beats the served
    // "MASTERCARD", which beats the vendor default "visa".
    const row = receipt({
      vendor: null,
      paymentMethod: "Amex",
      suggestions: merged({
        vendor: { value: "Food Basics", source: "llm" },
        paymentMethod: { value: "MASTERCARD", source: "llm" },
      }),
    });
    const d = draftFromPending(row);
    expect(d.paymentMethod).toBe("Amex");
    expect(vendorDefaultFill(d, new Set(), vendorDefaults).paymentMethod).toBeNull();
  });
});

describe("the detail screen's redraw after a save-for-later (2026-09-01)", () => {
  /**
   * `ReceiptDetail.save()` redraws with `draftForDisplay({...receipt,
   * ...updated})`. It called `draftFromReceipt` until this date, which was
   * right while a save wrote the whole draft and wrong the moment
   * `patchForSaveForLater` narrowed to the reviewed fields: the row stopped
   * being the full picture, so redrawing from it alone emptied every box the
   * merge had prefilled and nobody had touched. The person clicked Save and
   * watched the suggested total disappear - data loss, as far as anyone
   * looking at the screen could tell, from the change that was supposed to
   * stop the parser's guesses being stored.
   *
   * The round trip, at the level the two pure functions see it.
   */
  const row = receipt({
    vendor: null,
    totalCents: null,
    suggestions: merged({
      vendor: { value: "Food Basics", source: "llm" },
      totalCents: { value: 1435, source: "heuristic" },
    }),
  });
  const edited = { ...draftFromPending(row), vendor: "Food Basics #12" };
  const patch = patchForSaveForLater(row, edited, new Set(["vendor"]));
  /**
   * What the server hands back for that PATCH: the vendor written, the
   * reviewed set stored, and the total still nothing but a suggestion -
   * because nothing wrote it. The vendor suggestion is gone, which is the
   * server's own rule (it stops serving one for a reviewed field).
   */
  const updated: Receipt = {
    ...row,
    vendor: patch.vendor ?? null,
    reviewedFields: patch.reviewedFields ?? [],
    suggestions: merged({ totalCents: { value: 1435, source: "heuristic" } }),
  };

  it("left the total unwritten - the precondition that makes the redraw matter", () => {
    expect("totalCents" in patch).toBe(false);
    expect(updated.totalCents).toBeNull();
  });

  it("keeps the untouched suggested total on screen rather than blanking it", () => {
    expect(draftForDisplay(updated).total).toBe("$14.35");
  });

  it("shows the row's value for the field just saved, never the parser's again", () => {
    expect(draftForDisplay(updated).vendor).toBe("Food Basics #12");
  });

  it("is what the old rule got wrong - the defect itself, pinned", () => {
    // The redraw this replaced. Kept as a test so the reason for the change
    // cannot be lost: `draftFromReceipt` still returns an empty total here,
    // and that is exactly what the person used to see after saving.
    expect(draftFromReceipt(updated).total).toBe("");
  });

  it("is safe only because a reviewed field's row value outranks any suggestion", () => {
    // The property the whole change rests on: even if the server DID go on
    // serving a suggestion for the field just typed, re-deriving the merge
    // cannot overwrite it - which is the fear the old rule was written
    // against, and is now handled a layer down.
    const stillServing: Receipt = {
      ...updated,
      suggestions: merged({
        vendor: { value: "F00D BASlCS", source: "heuristic" },
        totalCents: { value: 1435, source: "heuristic" },
      }),
    };
    expect(draftForDisplay(stillServing).vendor).toBe("Food Basics #12");
  });

  it("leaves the confirmed-receipt edit path byte-for-byte unchanged", () => {
    // `draftForDisplay` IS `draftFromReceipt` for a confirmed receipt, so
    // the edit-after-confirm redraw is the same function call it always was
    // - suggestions or no suggestions on the row.
    const confirmed: Receipt = {
      ...updated,
      status: "confirmed",
      totalCents: 1435,
    };
    expect(draftForDisplay(confirmed)).toEqual(draftFromReceipt(confirmed));
    expect(draftForDisplay(confirmed).total).toBe("$14.35");
  });
});

describe("hstSuggestionChip - the default-rate offer is CAD-only (2026-09-01)", () => {
  /**
   * Production started holding USD receipts alongside CAD. Ontario's 13% is
   * a fact about a Canadian sale; beside a USD total, a chip reading "HST at
   * 13% of subtotal" is not a weaker guess but an answer to a different
   * country's question - and a suggestion on this form may be many things,
   * never simply wrong.
   *
   * Only the rate offer is gated. `hst-from-total` applies no rate and
   * assumes no jurisdiction: it subtracts the numbers already on screen from
   * each other, which is arithmetic and true in every currency.
   */
  const noTotal = draft({ subtotal: "12.70" });
  const withTotal = draft({ subtotal: "12.70", total: "14.35" });

  it("offers the rate on a CAD receipt", () => {
    expect(hstSuggestionChip(noTotal, "CAD")).toEqual({
      field: "hst",
      cents: 165,
      kind: "hst-at-default-rate",
      formula: "HST at 13% of subtotal",
    });
  });

  it("offers nothing at all on a USD receipt with no total to subtract from", () => {
    // Not a different chip, and not a rate with a caveat attached - nothing.
    // The person types what the paper says, which is what they would have
    // had to do anyway.
    expect(hstSuggestionChip(noTotal, "USD")).toBeNull();
  });

  it("still offers the from-total difference on a USD receipt", () => {
    expect(hstSuggestionChip(withTotal, "USD")).toEqual({
      field: "hst",
      cents: 165,
      kind: "hst-from-total",
      formula: "HST = total − subtotal − tip − other fees",
    });
  });

  it("gives a USD receipt the identical from-total offer a CAD one gets", () => {
    // The sharpest statement of "currency gates one branch and not the
    // other": same draft, two currencies, same chip.
    expect(hstSuggestionChip(withTotal, "USD")).toEqual(
      hstSuggestionChip(withTotal, "CAD"),
    );
  });

  it("does not fall back to the rate when a USD receipt's difference is unusable", () => {
    // A total that equals its subtotal says nothing about tax, so the
    // from-total branch declines - and on a USD receipt there is nothing
    // behind it to fall through to. The CAD control shows the fallback that
    // is being withheld.
    const flat = draft({ subtotal: "12.70", total: "12.70" });
    expect(hstSuggestionChip(flat, "USD")).toBeNull();
    expect(hstSuggestionChip(flat, "CAD")?.kind).toBe("hst-at-default-rate");
  });

  it("gates on 'is it CAD', not on 'is it USD'", () => {
    // A third currency must be treated like USD, not like CAD: the rate
    // belongs to one jurisdiction, and everything else is outside it.
    expect(hstSuggestionChip(noTotal, "EUR")).toBeNull();
    expect(hstSuggestionChip(noTotal, "GBP")).toBeNull();
  });

  it("names the currency it gates on rather than spelling it at the call site", () => {
    expect(HST_RATE_CURRENCY).toBe("CAD");
    expect(hstSuggestionChip(noTotal, HST_RATE_CURRENCY)?.kind).toBe(
      "hst-at-default-rate",
    );
  });

  it("leaves the rate mirror itself currency-blind", () => {
    // `suggestDefaultRateHst` mirrors a server function that takes a rate in
    // basis points precisely so no one rate is baked into the arithmetic.
    // The jurisdiction question is the chip's, not that function's, and it
    // stays that way.
    expect(suggestDefaultRateHst(1270)).toEqual({ hstCents: 165, totalCents: 1435 });
  });
});
