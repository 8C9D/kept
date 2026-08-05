import { describe, expect, it } from "vitest";
import { cents } from "../../src/domain/money.js";
import type { ExportRow } from "../../src/export/exportRows.js";
import { writeCsv } from "../../src/export/writeFiles.js";

function row(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    receiptId: "3f9a1c2e-8b4d-4f6a-9c0d-1e2f3a4b5c6d",
    date: "2026-01-14",
    vendor: "Staples",
    vendorGstHstNumber: "000000000RT0001",
    subtotalCents: cents(10000),
    hstCents: cents(1300),
    otherTaxCents: null,
    totalCents: cents(11300),
    currency: "CAD",
    category: "office supplies",
    paymentMethod: "visa",
    businessOrPersonal: "business",
    whose: "Synthetic User A",
    imageFilename: "images/2026/01/2026-01-14_Staples_3f9a1c2e.jpg",
    notes: null,
    ...overrides,
  };
}

describe("writeCsv", () => {
  it("emits the spec's columns in the spec's order", () => {
    const csv = writeCsv([row()]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "receipt_id,date,vendor,vendor_gst_hst_number,subtotal,hst,other_tax,total,currency,category,payment_method,business_or_personal,whose,image_filename,notes",
    );
    expect(lines[1]).toBe(
      "3f9a1c2e-8b4d-4f6a-9c0d-1e2f3a4b5c6d,2026-01-14,Staples,000000000RT0001,100.00,13.00,,113.00,CAD,office supplies,visa,business,Synthetic User A,images/2026/01/2026-01-14_Staples_3f9a1c2e.jpg,",
    );
  });

  it("quotes fields containing commas and doubles embedded quotes", () => {
    const csv = writeCsv([
      row({ vendor: 'Joe\'s "Best", Diner', notes: "line one\nline two" }),
    ]);
    expect(csv).toContain('"Joe\'s ""Best"", Diner"');
    expect(csv).toContain('"line one\nline two"');
  });

  it("renders null money as an empty cell, not zero", () => {
    const csv = writeCsv([
      row({ subtotalCents: null, hstCents: null, otherTaxCents: null }),
    ]);
    const dataLine = csv.trimEnd().split("\r\n")[1];
    // subtotal, hst, other_tax empty; total present.
    expect(dataLine).toContain(",,,,113.00,");
  });
});
