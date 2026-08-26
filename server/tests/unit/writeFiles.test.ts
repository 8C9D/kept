import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { cents } from "../../src/domain/money.js";
import type { ExportRow } from "../../src/export/exportRows.js";
import { writeCsv, writeJson, writeXlsx } from "../../src/export/writeFiles.js";

const HEADER =
  "receipt_id,date,vendor,subtotal,hst,total,currency,category,payment_method,whose,image_filename,notes";

function row(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    receiptId: "3f9a1c2e-8b4d-4f6a-9c0d-1e2f3a4b5c6d",
    date: "2026-01-14",
    vendor: "Staples",
    subtotalCents: cents(10000),
    hstCents: cents(1300),
    totalCents: cents(11300),
    currency: "CAD",
    category: "office supplies",
    paymentMethod: "visa",
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
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(
      "3f9a1c2e-8b4d-4f6a-9c0d-1e2f3a4b5c6d,2026-01-14,Staples,100.00,13.00,113.00,CAD,office supplies,visa,Synthetic User A,images/2026/01/2026-01-14_Staples_3f9a1c2e.jpg,",
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
    const csv = writeCsv([row({ subtotalCents: null, hstCents: null })]);
    const dataLine = csv.trimEnd().split("\r\n")[1];
    // subtotal and hst empty; total present.
    expect(dataLine).toContain(",,,113.00,");
  });
});

describe("writeJson", () => {
  it("emits one object per receipt, keyed by the spec's columns in order", () => {
    const json = writeJson([row()]);
    const parsed = JSON.parse(json) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(Object.keys(parsed[0] ?? {})).toEqual(HEADER.split(","));
    expect(parsed[0]).toEqual({
      receipt_id: "3f9a1c2e-8b4d-4f6a-9c0d-1e2f3a4b5c6d",
      date: "2026-01-14",
      vendor: "Staples",
      subtotal: "100.00",
      hst: "13.00",
      total: "113.00",
      currency: "CAD",
      category: "office supplies",
      payment_method: "visa",
      whose: "Synthetic User A",
      image_filename: "images/2026/01/2026-01-14_Staples_3f9a1c2e.jpg",
      notes: null,
    });
  });

  /**
   * Money is integer cents everywhere in this system, and a JSON number
   * would invite the one thing the rule exists to forbid: a consumer
   * treating 113.00 as a float. The decimal string is the same text the CSV
   * carries, so a reader that trusts either gets the same amount.
   */
  it("renders money as a decimal string, never a JSON number", () => {
    const parsed = JSON.parse(writeJson([row({ totalCents: cents(4554) })])) as {
      total: unknown;
    }[];
    expect(parsed[0]?.total).toBe("45.54");
    expect(typeof parsed[0]?.total).toBe("string");
  });

  /** The one thing JSON says that a CSV cannot: absent is not empty. */
  it("states an absent value as null rather than as an empty string", () => {
    const parsed = JSON.parse(
      writeJson([row({ vendor: null, subtotalCents: null, category: null })]),
    ) as Record<string, unknown>[];
    expect(parsed[0]?.vendor).toBeNull();
    expect(parsed[0]?.subtotal).toBeNull();
    expect(parsed[0]?.category).toBeNull();
  });

  it("is pretty-printed, because a person opening it in an editor is realistic", () => {
    expect(writeJson([row()])).toContain('\n  {\n    "receipt_id"');
  });

  it("carries the same values the CSV carries, cell for cell", () => {
    // The three files are one dataset in three encodings; the rendered
    // values are what makes that claim true rather than aspirational.
    const rows = [row(), row({ vendor: null, subtotalCents: null, notes: "x" })];
    const csvLines = writeCsv(rows).trimEnd().split("\r\n").slice(1);
    const json = JSON.parse(writeJson(rows)) as Record<string, unknown>[];
    const headers = HEADER.split(",");
    csvLines.forEach((line, index) => {
      const object = json[index] ?? {};
      expect(line.split(",")).toEqual(
        headers.map((header) => object[header] ?? ""),
      );
    });
  });
});

/**
 * R2-2, decided 2026-08-15 (docs/DECISIONS.md): the export does NOT mutate
 * fields a spreadsheet would read as formulas. The CSV is the import
 * artifact and a defensive prefix would become the vendor's name in the
 * accountant's books, silently and permanently; the artifact spec §8
 * designates for humans is the XLSX, which stores such a field as a string
 * cell. These tests make the decision executable in both directions:
 * anyone adding a quiet `'` prefix later fails the first, and an ExcelJS
 * upgrade that starts parsing leading `=` as a formula fails the second.
 */
describe("formula-shaped fields stay byte-faithful", () => {
  it("writes a leading =, +, - or @ into the CSV unchanged", () => {
    const csv = writeCsv([
      row({
        vendor: "=1+1",
        category: "+1+1",
        paymentMethod: "-Rogers Communications",
        notes: "@SUM(A1:A2)",
      }),
    ]);
    const fields = (csv.trimEnd().split("\r\n")[1] ?? "").split(",");
    expect(fields[2]).toBe("=1+1");
    expect(fields[7]).toBe("+1+1");
    expect(fields[8]).toBe("-Rogers Communications");
    expect(fields[11]).toBe("@SUM(A1:A2)");
  });

  it("stores the same field in the XLSX as a string cell, never a formula", async () => {
    const bytes = await writeXlsx([row({ vendor: "=1+1" })]);
    const workbook = new ExcelJS.Workbook();
    // exceljs's own typings predate @types/node's generic Buffer, so the
    // structurally-identical value needs its word taken for it.
    type LoadInput = Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as LoadInput);
    const sheet = workbook.getWorksheet("Receipts");
    if (sheet === undefined) {
      throw new Error("Receipts worksheet missing from the written XLSX");
    }
    const vendorCell = sheet.getRow(2).getCell(3);
    expect(vendorCell.type).toBe(ExcelJS.ValueType.String);
    expect(vendorCell.value).toBe("=1+1");
  });

  /**
   * The JSON writer needs no defence of its own - a JSON string is never a
   * formula to anything - but the same fixture is run through it so a future
   * "sanitize the export" change cannot quietly reach only two of the three.
   */
  it("writes the same field into the JSON unchanged", () => {
    const parsed = JSON.parse(writeJson([row({ vendor: "=1+1" })])) as {
      vendor: unknown;
    }[];
    expect(parsed[0]?.vendor).toBe("=1+1");
  });
});

describe("the XLSX money columns", () => {
  it("formats subtotal, hst and total as two-decimal numbers and nothing else", async () => {
    const bytes = await writeXlsx([row()]);
    const workbook = new ExcelJS.Workbook();
    type LoadInput = Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as LoadInput);
    const sheet = workbook.getWorksheet("Receipts");
    if (sheet === undefined) {
      throw new Error("Receipts worksheet missing from the written XLSX");
    }
    const dataRow = sheet.getRow(2);
    const formatted = HEADER.split(",")
      .map((_, index) => index + 1)
      .filter((column) => dataRow.getCell(column).numFmt === "0.00");
    // Columns 4, 5, 6: subtotal, hst, total.
    expect(formatted).toEqual([4, 5, 6]);
    expect(dataRow.getCell(6).value).toBe(113);
  });
});
