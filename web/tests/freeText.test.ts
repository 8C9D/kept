import { describe, expect, it } from "vitest";
import { freeTextWrite, normalizedFreeText } from "../src/freeText.js";

describe("normalizedFreeText", () => {
  it("trims, and an empty box is no value rather than an empty string", () => {
    expect(normalizedFreeText("  Meals ")).toBe("Meals");
    expect(normalizedFreeText("")).toBeNull();
    expect(normalizedFreeText("   ")).toBeNull();
  });

  it("leaves whitespace inside the value alone", () => {
    expect(normalizedFreeText(" Office   Supplies ")).toBe("Office   Supplies");
  });
});

describe("freeTextWrite - a box only writes when the person changed it", () => {
  const UNTIDY = "  Office   Supplies  ";

  it("writes nothing for a box still holding the stored value, however untidy", () => {
    // Tabbing through a cell used to PATCH this trimmed.
    expect(freeTextWrite(UNTIDY, UNTIDY)).toBeUndefined();
  });

  it("writes nothing for an empty box over no stored value", () => {
    expect(freeTextWrite("", null)).toBeUndefined();
  });

  it("writes the trimmed text when the person changed it", () => {
    expect(freeTextWrite(" Meals ", UNTIDY)).toBe("Meals");
  });

  it("writes null, a real write, when the person cleared it", () => {
    expect(freeTextWrite("", "Meals")).toBeNull();
    expect(freeTextWrite("   ", "Meals")).toBeNull();
  });

  it("writes nothing when all the person added was surrounding whitespace", () => {
    expect(freeTextWrite("Meals ", "Meals")).toBeUndefined();
  });

  it("does write when trimming an edited box differs from an untidy stored value", () => {
    // They changed the box, so it is their text now, and it normalizes.
    expect(freeTextWrite("Office   Supplies", UNTIDY)).toBe("Office   Supplies");
  });
});
