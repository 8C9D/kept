/**
 * The text layer of an emailed PDF receipt, reassembled into the rows a
 * person would read off the page (2026-09-01).
 *
 * Why this exists: spec §6A consequence 2 - "the email backlog is a folder
 * of PDFs on a laptop" - and until now a dropped PDF became a pending
 * receipt with no text and therefore no suggestions at all, so every field
 * was typed by hand. An emailed receipt is not a photograph: it usually
 * carries a real text layer, exact and noise-free, and the one thing
 * standing between that text and the server's LLM sweep was nobody
 * extracting it. This module is that extraction's pure half - the browser
 * hands it the text-content items pdf.js already produced and gets back the
 * string that travels as `ocrRawText` with `ocrSource: 'pdf-text'`.
 *
 * ⚠ Nothing here parses a receipt. It produces TEXT, exactly as the iOS
 * client's Vision recognizer does; the server's parsers are the authority
 * on what an amount or a vendor is (CLAUDE.md: HST arithmetic, validation
 * and everything else domain-shaped is the backend's, deliberately, so a
 * second client does not reimplement it). The row assembly below is the
 * same kind of pre-parse geometry work `ReceiptRowAssembler.swift` does on
 * iOS, for the same reason.
 *
 * Pure and DOM-free on purpose: it takes items, not a file, so the row
 * rules are unit-testable without a PDF and without pdf.js. The pdf.js
 * loading is `pdfTextLayer.ts`, a thin wrapper over this.
 */

/**
 * The slice of pdf.js's own `TextItem` this module reads - structurally
 * compatible with it, so `pdfTextLayer.ts` passes its items straight
 * through, and constructible in a test as a plain object literal.
 *
 * `transform` is the item's 2-D transformation matrix `[a, b, c, d, e, f]`:
 * `e` (index 4) is the x of the text's origin and `f` (index 5) its
 * baseline y, both in PDF user space.
 */
export interface PdfTextItem {
  str: string;
  transform: readonly number[];
  /** The item's height in the same space as `transform[5]`. */
  height: number;
  width: number;
}

/** The server's own `ocrRawText` bound (`z.string().max(100_000)`,
 * server/src/http/schemas.ts). Sending more is a 400, not a truncation the
 * server performs for us, so this module is where the cap is applied. */
export const OCR_RAW_TEXT_MAX_CHARS = 100_000;

export interface PdfExtractedText {
  /** The assembled rows, pages separated by a blank line. Empty string for
   * a PDF with no text layer at all - a scanned image, which the browser
   * cannot read and which this client deliberately does not OCR. */
  text: string;
  /** How many printed rows the text carries - what the upload view reports
   * ("text extracted, N lines"), so the person can tell a real text layer
   * from a near-empty one at a glance. */
  lines: number;
  /** True when the cap above stopped the assembly early. Reported rather
   * than silently swallowed: a truncated receipt is still worth parsing,
   * but the person should not be told the whole document was read. */
  truncated: boolean;
}

/**
 * Fragments whose baselines sit within this multiple of the taller
 * fragment's height belong to the same printed row - the same band-merge
 * tolerance `ReceiptRowAssembler.swift` uses on iOS, and for the same
 * reason: a receipt prints a label on the left and its amount on the right,
 * and every §7.3 heuristic matches a label and an amount within ONE string.
 * Split across two rows they can never meet.
 *
 * Deliberately NOT accompanied by iOS's column de-skew: that step corrects
 * a photograph's perspective, and a PDF text layer has no perspective - the
 * baselines are the typesetter's own coordinates, exact.
 */
const ROW_BAND_TOLERANCE = 0.5;

interface PositionedFragment {
  text: string;
  x: number;
  y: number;
  height: number;
}

function positioned(item: PdfTextItem): PositionedFragment | null {
  const text = item.str.trim();
  if (text === "") {
    // pdf.js emits whitespace-only items for inter-word and inter-column
    // gaps. They carry no reading, and the join below supplies the single
    // space between fragments anyway.
    return null;
  }
  const x = item.transform[4];
  const y = item.transform[5];
  if (x === undefined || y === undefined) {
    // A malformed transform - no position, so no row this fragment could
    // honestly be placed in. Dropped rather than guessed at zero, which
    // would drag it to the top-left of the page and corrupt two rows.
    return null;
  }
  return { text, x, y, height: item.height };
}

/**
 * One page's items -> the printed rows, top to bottom.
 *
 * PDF user space puts the origin at the BOTTOM-left and grows y upward, so
 * "top of the page first" is descending y - the inversion this sort is.
 * Within a row, fragments are ordered by ascending x (left to right) and
 * joined with a single space.
 */
export function assemblePageRows(items: readonly PdfTextItem[]): string[] {
  const fragments = items
    .map(positioned)
    .filter((fragment): fragment is PositionedFragment => fragment !== null)
    .sort((a, b) => b.y - a.y);

  const rows: PositionedFragment[][] = [];
  for (const fragment of fragments) {
    const current = rows[rows.length - 1];
    if (current !== undefined && belongsToRow(fragment, current)) {
      current.push(fragment);
      continue;
    }
    rows.push([fragment]);
  }

  return rows
    .map((row) =>
      [...row]
        .sort((a, b) => a.x - b.x)
        .map((fragment) => fragment.text)
        .join(" ")
        .trim(),
    )
    .filter((row) => row !== "");
}

/** The band test: the fragment's baseline against the row's running mean
 * baseline, tolerated by half the taller of (this fragment, the tallest
 * fragment already in the row) - iOS's rule exactly. A zero-height
 * fragment (some generators emit one) therefore joins only a row whose own
 * fragments are equally height-less and sit on the identical baseline,
 * which for a text layer is the right answer rather than a guess. */
function belongsToRow(
  fragment: PositionedFragment,
  row: readonly PositionedFragment[],
): boolean {
  const center = row.reduce((sum, entry) => sum + entry.y, 0) / row.length;
  const tallest = Math.max(...row.map((entry) => entry.height));
  const tolerance = ROW_BAND_TOLERANCE * Math.max(fragment.height, tallest);
  return Math.abs(fragment.y - center) <= tolerance;
}

/**
 * Every page's items -> the one string the create request carries. Pages
 * are separated by a blank line: a receipt emailed as a two-page PDF is
 * one receipt, and the page break is context the parsers can use rather
 * than a document boundary.
 *
 * The cap is applied at a ROW boundary, never mid-row: slicing a row in
 * half could leave "TOTAL 14" where the paper says "TOTAL 14.35", and a
 * plausible wrong number is worse than a short document (constraint 2
 * still has a human confirm every value, but the suggestion it starts from
 * should not be one this client manufactured by cutting a string).
 */
export function assembleDocumentText(
  pages: readonly (readonly PdfTextItem[])[],
): PdfExtractedText {
  const parts: string[] = [];
  let length = 0;
  let lines = 0;
  let truncated = false;

  for (const page of pages) {
    const rows = assemblePageRows(page);
    for (const [rowIndex, row] of rows.entries()) {
      // A blank line at a page boundary, a single newline between rows,
      // and nothing before the very first row of the document.
      const separator = parts.length === 0 ? "" : rowIndex === 0 ? "\n\n" : "\n";
      if (length + separator.length + row.length > OCR_RAW_TEXT_MAX_CHARS) {
        truncated = true;
        break;
      }
      parts.push(separator, row);
      length += separator.length + row.length;
      lines += 1;
    }
    if (truncated) {
      break;
    }
  }

  return { text: parts.join(""), lines, truncated };
}
