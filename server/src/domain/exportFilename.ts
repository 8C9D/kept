import { parseIsoDate } from "./calendarDate.js";

/**
 * Export image filenames follow `{date}_{vendor-slug}_{short-id}.{ext}`
 * (spec §8): deterministic, sortable by date, and collision-free because the
 * short id is derived from the receipt's uuid rather than a counter.
 */
export function exportImageFilename(input: {
  purchasedAt: string; // ISO yyyy-mm-dd
  vendor: string | null;
  receiptId: string; // uuid
  extension: string; // without the dot, e.g. "jpg"
}): string {
  const date = input.purchasedAt;
  parseIsoDate(date); // reject malformed dates loudly rather than embed them
  const slug = vendorSlug(input.vendor);
  const shortId = input.receiptId.replaceAll("-", "").slice(0, 8);
  return `${date}_${slug}_${shortId}.${input.extension}`;
}

/**
 * The path inside the export zip's images/ folder. Calendar-based YYYY/MM,
 * never fiscal-based (spec §5.1): a changed fiscal year end must re-slice
 * queries, not move files.
 */
export function exportImagePath(input: {
  purchasedAt: string;
  vendor: string | null;
  receiptId: string;
  extension: string;
}): string {
  const date = parseIsoDate(input.purchasedAt);
  const month = String(date.month).padStart(2, "0");
  return `${date.year}/${month}/${exportImageFilename(input)}`;
}

/**
 * Reduce a vendor name to filename-safe characters. Diacritics are stripped
 * via Unicode decomposition ("Café" → "Cafe"); every other run of unsafe
 * characters collapses to a single hyphen.
 */
function vendorSlug(vendor: string | null): string {
  if (vendor === null) {
    return "unknown-vendor";
  }
  const slug = vendor
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "") // combining marks left by NFKD
    .replaceAll(/[^A-Za-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" ? "unknown-vendor" : slug;
}
