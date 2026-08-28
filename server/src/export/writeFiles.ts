import ExcelJS from "exceljs";
import { centsToDecimalString, type Cents } from "../domain/money.js";
import { EXPORT_COLUMN_HEADERS, type ExportRow } from "./exportRows.js";

/**
 * The one place a receipt becomes export columns. All three writers below
 * read this and nothing else, so the XLSX, the CSV and the JSON are the same
 * dataset in three encodings by construction rather than by three
 * independently-maintained lists that happen to agree today.
 *
 * Keyed by header name: a column added to EXPORT_COLUMN_HEADERS without a
 * value here (or the reverse) is a compile error, not a silently short row.
 */
type ExportColumn = (typeof EXPORT_COLUMN_HEADERS)[number];

type ExportValue =
  | { kind: "text"; value: string | null }
  /** Integer cents, rendered per encoding: a number in the XLSX, a decimal string elsewhere. */
  | { kind: "money"; value: Cents | null };

function text(value: string | null): ExportValue {
  return { kind: "text", value };
}

function money(value: Cents | null): ExportValue {
  return { kind: "money", value };
}

function exportValues(row: ExportRow): Record<ExportColumn, ExportValue> {
  return {
    receipt_id: text(row.receiptId),
    date: text(row.date),
    vendor: text(row.vendor),
    subtotal: money(row.subtotalCents),
    hst: money(row.hstCents),
    tip: money(row.tipCents),
    other_fees: money(row.otherFeesCents),
    total: money(row.totalCents),
    currency: text(row.currency),
    category: text(row.category),
    payment_method: text(row.paymentMethod),
    whose: text(row.whose),
    image_filename: text(row.imageFilename),
    notes: text(row.notes),
  };
}

function orderedValues(row: ExportRow): ExportValue[] {
  const values = exportValues(row);
  return EXPORT_COLUMN_HEADERS.map((header) => values[header]);
}

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
    const values = orderedValues(row);
    const added = sheet.addRow(
      values.map((value) =>
        value.kind === "money" ? moneyCell(value.value) : value.value,
      ),
    );
    // Derived from the row itself rather than written out: a reordered or
    // renamed money column cannot leave the format on the wrong cell.
    values.forEach((value, index) => {
      if (value.kind === "money") {
        added.getCell(index + 1).numFmt = "0.00";
      }
    });
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
    lines.push(orderedValues(row).map(csvCell).map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/** An absent value is an empty cell; a CSV has no other way to say it. */
function csvCell(value: ExportValue): string {
  if (value.kind === "money") {
    return value.value === null ? "" : centsToDecimalString(value.value);
  }
  return value.value ?? "";
}

/** RFC 4180: quote when needed, double any embedded quotes. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/**
 * The JSON is the same dataset again, for anything that would rather parse
 * than guess at a CSV: an array of objects, keys in column order, values
 * rendered exactly as the CSV renders them - money as a decimal string, so
 * no consumer has to rediscover that these are integer cents, and no
 * float ever touches them.
 *
 * The one thing it says that a CSV cannot: an absent value is `null`, not
 * an empty string. Pretty-printed, because a person opening it in an editor
 * is a realistic use and the size cost is nothing beside the images.
 */
export function writeJson(rows: ExportRow[]): string {
  const objects = rows.map((row) => {
    const values = exportValues(row);
    return Object.fromEntries(
      EXPORT_COLUMN_HEADERS.map((header) => [header, jsonCell(values[header])]),
    );
  });
  return JSON.stringify(objects, null, 2);
}

function jsonCell(value: ExportValue): string | null {
  if (value.kind === "money") {
    return value.value === null ? null : centsToDecimalString(value.value);
  }
  return value.value;
}
