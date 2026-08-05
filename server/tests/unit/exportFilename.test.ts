import { describe, expect, it } from "vitest";
import {
  exportImageFilename,
  exportImagePath,
} from "../../src/domain/exportFilename.js";
import { InvalidDateError } from "../../src/domain/calendarDate.js";

const RECEIPT_ID = "3f9a1c2e-8b4d-4f6a-9c0d-1e2f3a4b5c6d";

describe("exportImageFilename", () => {
  it("follows {date}_{vendor-slug}_{short-id}.{ext}", () => {
    const name = exportImageFilename({
      purchasedAt: "2026-01-14",
      vendor: "Staples",
      receiptId: RECEIPT_ID,
      extension: "jpg",
    });
    expect(name).toBe("2026-01-14_Staples_3f9a1c2e.jpg");
  });

  it("slugs vendor names with spaces, accents, and symbols", () => {
    const name = exportImageFilename({
      purchasedAt: "2026-01-14",
      vendor: "Café Dépôt #12 (airport)",
      receiptId: RECEIPT_ID,
      extension: "jpg",
    });
    expect(name).toBe("2026-01-14_Cafe-Depot-12-airport_3f9a1c2e.jpg");
  });

  it("names a missing vendor explicitly rather than leaving a gap", () => {
    const name = exportImageFilename({
      purchasedAt: "2026-01-14",
      vendor: null,
      receiptId: RECEIPT_ID,
      extension: "jpg",
    });
    expect(name).toBe("2026-01-14_unknown-vendor_3f9a1c2e.jpg");
  });

  it("treats a vendor with no usable characters as missing", () => {
    const name = exportImageFilename({
      purchasedAt: "2026-01-14",
      vendor: "***",
      receiptId: RECEIPT_ID,
      extension: "jpg",
    });
    expect(name).toBe("2026-01-14_unknown-vendor_3f9a1c2e.jpg");
  });

  it("is deterministic: same receipt, same filename", () => {
    const input = {
      purchasedAt: "2026-01-14",
      vendor: "Staples",
      receiptId: RECEIPT_ID,
      extension: "jpg",
    };
    expect(exportImageFilename(input)).toBe(exportImageFilename(input));
  });

  it("differs between receipts even with identical date and vendor", () => {
    const a = exportImageFilename({
      purchasedAt: "2026-01-14",
      vendor: "Staples",
      receiptId: "11111111-2222-3333-4444-555555555555",
      extension: "jpg",
    });
    const b = exportImageFilename({
      purchasedAt: "2026-01-14",
      vendor: "Staples",
      receiptId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
      extension: "jpg",
    });
    expect(a).not.toBe(b);
  });

  it("refuses a malformed date rather than embedding it", () => {
    expect(() =>
      exportImageFilename({
        purchasedAt: "2026-02-30",
        vendor: "Staples",
        receiptId: RECEIPT_ID,
        extension: "jpg",
      }),
    ).toThrow(InvalidDateError);
  });
});

describe("exportImagePath", () => {
  it("places the file under calendar-based yyyy/mm", () => {
    const path = exportImagePath({
      purchasedAt: "2026-01-14",
      vendor: "Staples",
      receiptId: RECEIPT_ID,
      extension: "jpg",
    });
    expect(path).toBe("2026/01/2026-01-14_Staples_3f9a1c2e.jpg");
  });
});
