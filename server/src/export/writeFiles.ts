import ExcelJS from "exceljs";
import { centsToDecimalString, type Cents } from "../domain/money.js";
import { EXPORT_COLUMN_HEADERS, type ExportRow } from "./exportRows.js";

/**
 * The XLSX is what the accountant opens (spec §8). Money cells are numeric
 * with a two-decimal format so they sum and sort like money in Excel; the
 * number is produced from the integer-cents decimal string, not from
 * dividing cents by 100 in floating point.
 */
export async function writeXlsx(rows: ExportRow[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Receipts");

  const header = sheet.addRow([...EXPORT_COLUMN_HEADERS]);
  header.font = { bold: true };

  for (const row of rows) {
    const added = sheet.addRow([
      row.receiptId,
      row.date,
      row.vendor,
      row.vendorGstHstNumber,
      moneyCell(row.subtotalCents),
      moneyCell(row.hstCents),
      moneyCell(row.otherTaxCents),
      moneyCell(row.totalCents),
      row.currency,
      row.category,
      row.paymentMethod,
      row.businessOrPersonal,
      row.whose,
      row.imageFilename,
      row.notes,
    ]);
    // Columns 5-8 are the four money columns (1-based, matching the header
    // order above).
    for (const column of [5, 6, 7, 8]) {
      added.getCell(column).numFmt = "0.00";
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

function moneyCell(value: Cents | null): number | null {
  if (value === null) {
    return null;
  }
  return Number(centsToDecimalString(value));
}

/**
 * The CSV carries the same data for import into accounting software
 * (spec §8). Money stays a decimal string end to end; a null field is an
 * empty cell.
 */
export function writeCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_COLUMN_HEADERS.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.receiptId,
        row.date,
        row.vendor ?? "",
        row.vendorGstHstNumber ?? "",
        row.subtotalCents === null ? "" : centsToDecimalString(row.subtotalCents),
        row.hstCents === null ? "" : centsToDecimalString(row.hstCents),
        row.otherTaxCents === null ? "" : centsToDecimalString(row.otherTaxCents),
        centsToDecimalString(row.totalCents),
        row.currency,
        row.category ?? "",
        row.paymentMethod ?? "",
        row.businessOrPersonal,
        row.whose ?? "",
        row.imageFilename,
        row.notes ?? "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** RFC 4180: quote when needed, double any embedded quotes. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
