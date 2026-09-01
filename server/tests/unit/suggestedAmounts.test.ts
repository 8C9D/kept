import { describe, expect, it } from "vitest";
import {
  SUGGESTED_AMOUNT_TOLERANCE_CENTS,
  validateSuggestedAmounts,
  type SuggestedAmounts,
} from "../../src/domain/suggestedAmounts.js";

/**
 * the owner's rule over a receipt's suggested amounts (2026-09-01): the total
 * must at least cover the subtotal, the tax, the tip and the fees. Every
 * case here is shaped after a receipt the 136-receipt diagnosis actually
 * found, or after one of the two legitimate shapes that make this a
 * merge-time withhold rather than a server-side rejection.
 *
 * The merge's use of the verdict is pinned separately, in
 * tests/unit/mergedSuggestions.test.ts.
 */

function amounts(overrides: Partial<SuggestedAmounts> = {}): SuggestedAmounts {
  return {
    subtotalCents: null,
    hstCents: null,
    tipCents: null,
    otherFeesCents: null,
    totalCents: null,
    ...overrides,
  };
}

const CONSISTENT = { withhold: [], reason: null };

describe("validateSuggestedAmounts", () => {
  describe("sets it has nothing to say about", () => {
    it("passes an empty set", () => {
      expect(validateSuggestedAmounts(amounts())).toEqual(CONSISTENT);
    });

    it("passes when there is no subtotal to sum against", () => {
      expect(
        validateSuggestedAmounts(amounts({ hstCents: 734, totalCents: 850 })),
      ).toEqual(CONSISTENT);
    });

    it("passes when there is no total to compare", () => {
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 21160, hstCents: 734 }),
        ),
      ).toEqual(CONSISTENT);
    });

    it("passes a total larger than its parts - an unprinted charge is not this rule's business", () => {
      // Only one direction of mismatch is impossible. A total ABOVE the sum
      // is an ordinary receipt with a line nobody extracted.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 1000, hstCents: 130, totalCents: 2000 }),
        ),
      ).toEqual(CONSISTENT);
    });
  });

  describe("sets that balance", () => {
    it("passes an exact subtotal + tax + tip + fees", () => {
      expect(
        validateSuggestedAmounts(
          amounts({
            subtotalCents: 1000,
            hstCents: 130,
            tipCents: 200,
            otherFeesCents: 99,
            totalCents: 1429,
          }),
        ),
      ).toEqual(CONSISTENT);
    });

    it("passes the card slip with no printed tax: AMOUNT + TIP = TOTAL", () => {
      // 20.33 charged tax-inclusive, 2.64 tip, 22.97 total.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 2033, tipCents: 264, totalCents: 2297 }),
        ),
      ).toEqual(CONSISTENT);
    });

    it("passes the one-cent gap three real receipts print", () => {
      // Noodle House: 13.50 + 1.76 = 15.26 against a printed 15.25. The
      // merchant rounded tax and total independently; nothing is wrong.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 1350, hstCents: 176, totalCents: 1525 }),
        ),
      ).toEqual(CONSISTENT);
    });

    it("passes at exactly the tolerance and fails one cent past it", () => {
      // The boundary stated as a property of the constant, so a future
      // change to the tolerance moves this test with it rather than
      // silently making it vacuous.
      const parts = 1000 + 130;
      const atEdge = parts - SUGGESTED_AMOUNT_TOLERANCE_CENTS;
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 1000, hstCents: 130, totalCents: atEdge }),
        ),
      ).toEqual(CONSISTENT);
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 1000, hstCents: 130, totalCents: atEdge - 1 }),
        ).reason,
      ).toBe("total-below-components");
    });
  });

  describe("sets that cannot all be true", () => {
    it("withholds the total when the tax corroborates the subtotal", () => {
      // Costco: "TOTAL DISCOUNT(S) $ 8.50" read as the total of a $218.94
      // purchase. 7.34 on 211.60 is 3.5% - a plausible partial-tax rate -
      // so those two stand and the total is the outlier.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 21160, hstCents: 734, totalCents: 850 }),
        ),
      ).toEqual({
        withhold: ["totalCents"],
        reason: "total-below-components",
      });
    });

    it("withholds the total when there is no tax line to corroborate with", () => {
      // A nonsense pair with no HST printed: nothing accuses the subtotal.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 986, totalCents: 325 }),
        ),
      ).toEqual({
        withhold: ["totalCents"],
        reason: "total-below-components",
      });
    });

    it("withholds both when the tax is not a plausible rate on the subtotal", () => {
      // 40% is not a Canadian rate, so the subtotal and the tax are already
      // inconsistent with each other and neither is worth serving.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 1000, hstCents: 400, totalCents: 500 }),
        ),
      ).toEqual({
        withhold: ["totalCents", "subtotalCents"],
        reason: "total-below-components",
      });
    });

    it("accepts 13% and 15% as rates, and refuses 17%", () => {
      // The ceiling is the widest real Canadian HST plus a rounding cent's
      // slack; a ratio past it is a misread number, not a tax rate.
      const impossible = (hstCents: number) =>
        validateSuggestedAmounts(
          amounts({ subtotalCents: 10_000, hstCents, totalCents: 1 }),
        ).withhold;
      expect(impossible(1300)).toEqual(["totalCents"]);
      expect(impossible(1500)).toEqual(["totalCents"]);
      expect(impossible(1700)).toEqual(["totalCents", "subtotalCents"]);
    });

    it("treats a negative tax as no corroboration at all", () => {
      // Below the 0% floor: a refund's sign on one field and not the other
      // is two numbers disagreeing, not a rate.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 1000, hstCents: -130, totalCents: 100 }),
        ).withhold,
      ).toEqual(["totalCents", "subtotalCents"]);
    });

    it("withholds both when the subtotal anchors no rate", () => {
      // A zero subtotal makes the ratio undefined, so a present tax
      // corroborates nothing.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 0, hstCents: 130, totalCents: -100 }),
        ).withhold,
      ).toEqual(["totalCents", "subtotalCents"]);
    });

    it("counts the tip and the fees among the parts, not just the tax", () => {
      // Each alone is enough to make the total impossible; neither is
      // optional in the sum.
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 1000, tipCents: 500, totalCents: 1000 }),
        ).reason,
      ).toBe("total-below-components");
      expect(
        validateSuggestedAmounts(
          amounts({ subtotalCents: 1000, otherFeesCents: 599, totalCents: 1000 }),
        ).reason,
      ).toBe("total-below-components");
    });
  });
});
