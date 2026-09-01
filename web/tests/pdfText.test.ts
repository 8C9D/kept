import { describe, expect, it } from "vitest";
import {
  OCR_RAW_TEXT_MAX_CHARS,
  assembleDocumentText,
  assemblePageRows,
  type PdfTextItem,
} from "../src/pdfText.js";

/**
 * The PDF row assembler (2026-09-01). Every rule here is geometry, and
 * geometry is exactly what a unit test can pin without a PDF file: the
 * module takes the text-content items pdf.js already produced, so a plain
 * object literal stands in for a page.
 *
 * What is being protected: a receipt prints "Subtotal" on the left and
 * "13.50" on the right, and every server-side heuristic matches a label
 * and an amount within ONE string (`ReceiptRowAssembler.swift`'s own
 * comment - the wave-4 device receipt failed to parse subtotal and HST for
 * precisely this reason). A row assembler that split those two apart would
 * hand the parsers a document that looks complete and parses badly.
 */

/**
 * One text fragment. `transform` is pdf.js's 2-D matrix: index 4 is the x
 * of the origin, index 5 the baseline y. The three leading entries are
 * scale/skew and are never read by this module - they are here so the
 * literal has the shape pdf.js actually produces.
 */
function item(str: string, x: number, y: number, height = 10): PdfTextItem {
  return {
    str,
    transform: [height, 0, 0, height, x, y],
    height,
    width: str.length * (height / 2),
  };
}

describe("assemblePageRows", () => {
  it("joins a label and its amount across the page into one row", () => {
    // The whole reason this module exists: two fragments, one printed row.
    expect(
      assemblePageRows([item("14.35", 420, 700), item("TOTAL", 40, 700)]),
    ).toEqual(["TOTAL 14.35"]);
  });

  it("orders fragments within a row by x, not by the order pdf.js emitted them", () => {
    expect(
      assemblePageRows([
        item("BASICS", 120, 700),
        item("13.50", 420, 700),
        item("FOOD", 40, 700),
      ]),
    ).toEqual(["FOOD BASICS 13.50"]);
  });

  it("orders rows top to bottom, inverting PDF's upward y axis", () => {
    // PDF user space puts the origin at the bottom-left, so the LARGEST y
    // is the top of the page. Emitted here bottom-first to prove the sort
    // is doing the work.
    expect(
      assemblePageRows([
        item("TOTAL 14.35", 40, 600),
        item("Subtotal 12.70", 40, 640),
        item("FOOD BASICS", 40, 720),
      ]),
    ).toEqual(["FOOD BASICS", "Subtotal 12.70", "TOTAL 14.35"]);
  });

  it("bands fragments within half the taller fragment's height into one row", () => {
    // Height 10 -> tolerance 5. A 3pt baseline difference is one row (a
    // superscript, a differently-sized amount column); a 20pt one is two.
    expect(
      assemblePageRows([item("HST", 40, 700), item("1.65", 420, 703)]),
    ).toEqual(["HST 1.65"]);
    expect(
      assemblePageRows([item("HST", 40, 700), item("1.65", 420, 680)]),
    ).toEqual(["HST", "1.65"]);
  });

  it("measures the band against the TALLER fragment, as iOS does", () => {
    // A 40pt vendor name beside a 10pt fragment: tolerance is 20, so a
    // 12pt baseline difference still reads as one printed row. With the
    // smaller height it would have split.
    expect(
      assemblePageRows([item("FOOD BASICS", 40, 700, 40), item("®", 300, 712, 10)]),
    ).toEqual(["FOOD BASICS ®"]);
  });

  it("drops whitespace-only fragments and trims what it keeps", () => {
    // pdf.js emits these for inter-word and inter-column gaps; the join
    // supplies the single space itself.
    expect(
      assemblePageRows([
        item("  TOTAL ", 40, 700),
        item("   ", 200, 700),
        item(" 14.35", 420, 700),
      ]),
    ).toEqual(["TOTAL 14.35"]);
  });

  it("emits no row for a page of nothing but whitespace", () => {
    expect(assemblePageRows([item("   ", 40, 700), item("", 40, 680)])).toEqual([]);
  });

  it("drops a fragment with no position rather than dragging it to the origin", () => {
    // A malformed transform has no honest row to go in, and placing it at
    // (0,0) would corrupt whatever row genuinely sits at the bottom-left.
    const malformed: PdfTextItem = { str: "ghost", transform: [], height: 10, width: 5 };
    expect(assemblePageRows([item("TOTAL", 40, 700), malformed])).toEqual(["TOTAL"]);
  });
});

describe("assembleDocumentText", () => {
  it("separates pages with a blank line and rows with a single newline", () => {
    const result = assembleDocumentText([
      [item("FOOD BASICS", 40, 720), item("TOTAL 14.35", 40, 700)],
      [item("Page 2 of 2", 40, 720)],
    ]);
    expect(result.text).toBe("FOOD BASICS\nTOTAL 14.35\n\nPage 2 of 2");
    expect(result.lines).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("reports an empty document for a PDF with no text layer", () => {
    // A scanned receipt emailed as a PDF: real pages, no text items. The
    // caller turns this into "no text layer - type the fields" rather than
    // sending an empty ocrRawText.
    expect(assembleDocumentText([[], []])).toEqual({
      text: "",
      lines: 0,
      truncated: false,
    });
  });

  it("never emits a leading separator before the first row", () => {
    // An empty first page must not push a blank line onto the front.
    expect(assembleDocumentText([[], [item("TOTAL", 40, 700)]]).text).toBe("TOTAL");
  });

  it("caps at the server's limit on a ROW boundary, and says it truncated", () => {
    const long = "x".repeat(50_000);
    const result = assembleDocumentText([
      [item(long, 40, 720), item(long, 40, 700), item(long, 40, 680)],
    ]);
    // Two rows plus their separator would be 100_001 characters - one over
    // the server's `z.string().max(100_000)` - so the second row is
    // dropped whole rather than sliced. A half-row could read "TOTAL 14"
    // where the paper says "TOTAL 14.35".
    expect(result.text).toBe(long);
    expect(result.text.length).toBeLessThanOrEqual(OCR_RAW_TEXT_MAX_CHARS);
    expect(result.lines).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
