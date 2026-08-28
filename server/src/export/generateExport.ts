import { ZipArchive, type Archiver } from "archiver";
import { PassThrough } from "node:stream";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { listExportableReceipts } from "../db/receiptQueries.js";
import { receiptImages, users } from "../db/schema.js";
import { exportImagePath } from "../domain/exportFilename.js";
import { cents } from "../domain/money.js";
import {
  assertIssuedObjectKey,
  exportObjectKey,
} from "../storage/objectKeys.js";
import {
  ObjectNotFoundError,
  type ObjectStorage,
} from "../storage/objectStorage.js";
import type { ExportRow } from "./exportRows.js";
import { writeCsv, writeJson, writeXlsx } from "./writeFiles.js";

export interface ExportPeriod {
  start: string; // ISO yyyy-mm-dd, inclusive
  end: string;
}

/**
 * Assembly happens in memory (see buildZip), so an export that cannot fit
 * must be refused with a clear reason - an explicit failure the user can
 * act on (export a shorter period), never an OOM crash. With the backlog
 * and six-year retention, a full year can genuinely reach gigabytes.
 *
 * Bytes are the only limit: a row count would be a worse-measured proxy
 * for the same memory bound, and could refuse an export that would have
 * fit - the wrong failure for the one artifact the accountant needs.
 *
 * The byte budget is deliberately well under available memory: during
 * assembly the images exist roughly twice (downloaded buffers plus the
 * archive's output).
 */
export interface ExportLimits {
  maxTotalBytes: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxTotalBytes: 256 * 1024 * 1024, // 256 MiB
};

interface GenerateExportDependencies {
  db: Db;
  storage: ObjectStorage;
}

/**
 * Build the complete export zip (spec §8) for one user and period and put
 * it in object storage. Returns where it landed.
 *
 * Contents: the XLSX (what the accountant opens), the CSV (what imports),
 * the JSON (the same rows for anything that would rather parse than guess),
 * and every image under images/yyyy/mm/ with filenames the spreadsheets'
 * image_filename column points at - the click-through from row to paper is
 * the point of the folder.
 */
export async function generateExport(
  deps: GenerateExportDependencies,
  input: { jobId: string; userId: string; period: ExportPeriod },
  limits: ExportLimits = DEFAULT_EXPORT_LIMITS,
): Promise<{ objectKey: string; receiptCount: number }> {
  const userRows = await deps.db
    .select({ displayName: users.displayName })
    .from(users)
    .where(eq(users.id, input.userId));
  const user = userRows[0];
  if (user === undefined) {
    throw new Error(`Export for nonexistent user ${input.userId}`);
  }

  const receipts = await listExportableReceipts(
    deps.db,
    input.userId,
    input.period,
  );

  // Every LIVE page of every exportable receipt, in one query - not just
  // page 1 (proposal #6, 2026-08-28: "a receipt whose page 2 never reaches
  // the accountant is worse than no multi-page support at all"). Ordered by
  // page so each receipt's images arrive page-1-first, which is what lets
  // the loop below pick page 1 out with a single `find`.
  const imagesByReceipt = new Map<
    string,
    { page: number; objectKey: string }[]
  >();
  if (receipts.length > 0) {
    const imageRows = await deps.db
      .select({
        receiptId: receiptImages.receiptId,
        page: receiptImages.page,
        objectKey: receiptImages.objectKey,
      })
      .from(receiptImages)
      .where(
        and(
          inArray(
            receiptImages.receiptId,
            receipts.map((receipt) => receipt.id),
          ),
          eq(receiptImages.userId, input.userId),
          isNull(receiptImages.deletedAt),
        ),
      )
      .orderBy(asc(receiptImages.page));
    for (const image of imageRows) {
      const forReceipt = imagesByReceipt.get(image.receiptId);
      if (forReceipt === undefined) {
        imagesByReceipt.set(image.receiptId, [
          { page: image.page, objectKey: image.objectKey },
        ]);
      } else {
        forReceipt.push({ page: image.page, objectKey: image.objectKey });
      }
    }
  }

  // One entry per FILE the zip will carry, not per receipt: a three-page
  // receipt contributes one spreadsheet row (below) but three of these. The
  // spreadsheet's own imageFilename is unaffected either way - it always
  // names page 1 (spec §8) - so a receipt that has only ever had one page
  // produces exactly the entries it always has.
  interface ImageToBundle {
    receiptId: string;
    page: number;
    objectKey: string;
    filename: string; // path inside the zip, e.g. images/2026/01/x.jpg
  }
  const imagesToBundle: ImageToBundle[] = [];
  const rows: ExportRow[] = [];
  for (const receipt of receipts) {
    const images = imagesByReceipt.get(receipt.id) ?? [];
    const page1 = images.find((image) => image.page === 1);
    if (page1 === undefined) {
      // Every receipt is created with a page-1 image, so a missing one is a
      // data-integrity failure - the export must fail loudly rather than
      // ship an accountant a broken click-through. This check is unchanged
      // by proposal #6: it is still keyed to page 1 specifically, since
      // that is the page the spreadsheet's own imageFilename column names.
      throw new Error(`Receipt ${receipt.id} has no page-1 image`);
    }
    // The export is the other place a stored key is dereferenced, so every
    // page asks the same ownership question the detail route does. A zip is
    // exactly the wrong artifact to discover a mislabelled key in: it
    // leaves the server and lands in an accountant's inbox.
    for (const image of images) {
      assertIssuedObjectKey(image.objectKey, input.userId);
    }
    // Only confirmed receipts export, and the receipts_confirmed_complete_ck
    // constraint guarantees a confirmed receipt has a total. Null here means
    // that guarantee broke, and the job must fail loudly rather than hand an
    // accountant an invented amount.
    if (receipt.totalCents === null) {
      throw new Error(`Confirmed receipt ${receipt.id} is missing its total`);
    }
    rows.push({
      receiptId: receipt.id,
      date: receipt.purchasedAt,
      vendor: receipt.vendor,
      subtotalCents:
        receipt.subtotalCents === null ? null : cents(receipt.subtotalCents),
      hstCents: receipt.hstCents === null ? null : cents(receipt.hstCents),
      tipCents: receipt.tipCents === null ? null : cents(receipt.tipCents),
      otherFeesCents:
        receipt.otherFeesCents === null ? null : cents(receipt.otherFeesCents),
      totalCents: cents(receipt.totalCents),
      currency: receipt.currency,
      category: receipt.category,
      paymentMethod: receipt.paymentMethod,
      whose: user.displayName,
      // Page 1 keeps its existing, un-suffixed name (spec §8): passing
      // page: 1 through exportImagePath is a no-op for the filename, which
      // is what makes this byte-identical to every export before this
      // feature existed.
      imageFilename: `images/${exportImagePath({
        purchasedAt: receipt.purchasedAt,
        vendor: receipt.vendor,
        receiptId: receipt.id,
        extension: extensionOf(page1.objectKey),
        page: 1,
      })}`,
      pages: images.length,
      notes: receipt.notes,
    });
    for (const image of images) {
      imagesToBundle.push({
        receiptId: receipt.id,
        page: image.page,
        objectKey: image.objectKey,
        // Page 1 gets the identical path just computed for imageFilename;
        // every later page sits beside it in the same images/yyyy/mm/
        // folder with a `_p{page}` suffix on the same deterministic pattern.
        filename: `images/${exportImagePath({
          purchasedAt: receipt.purchasedAt,
          vendor: receipt.vendor,
          receiptId: receipt.id,
          extension: extensionOf(image.objectKey),
          page: image.page,
        })}`,
      });
    }
  }

  const label = periodLabel(input.period);
  const xlsx = await writeXlsx(rows);
  const csv = writeCsv(rows);
  const json = writeJson(rows);

  // The budget is checked before each append, so the refusal lands before
  // the memory is spent, not after. Measured in bytes rather than in
  // JavaScript string length, which undercounts every non-ASCII vendor name.
  // Every page counts, since every page is bytes in the zip (proposal #6).
  let totalBytes =
    xlsx.byteLength + Buffer.byteLength(csv) + Buffer.byteLength(json);
  const zip = await buildZip(async (archive) => {
    archive.append(Buffer.from(xlsx), { name: `receipts-${label}.xlsx` });
    archive.append(csv, { name: `receipts-${label}.csv` });
    archive.append(json, { name: `receipts-${label}.json` });
    for (const image of imagesToBundle) {
      // Named, because the storage layer's own answer is not actionable. A
      // receipt can point at an object that was never uploaded - the create
      // route validates the key's *shape*, and a presigned PUT that failed
      // or was interrupted before the create still leaves a row behind. The
      // raw failure is `NoSuchKey: The specified key does not exist.`, which
      // reaches the export screen naming no receipt, no vendor and no date,
      // so the person is told their year-end export is broken and given no
      // way to find the row that broke it.
      //
      // Still fatal, deliberately: a missing image is a data-integrity
      // failure, and shipping an accountant a zip whose click-through is
      // silently absent is worse than refusing (see the page-1 check above).
      let bytes;
      try {
        bytes = await deps.storage.download(image.objectKey);
      } catch (error) {
        // ⚠ Only a genuinely absent object is described as one. Storage can
        // also time out, refuse credentials, or be down, and reporting any of
        // those as "this receipt's photo is missing" would tell someone to
        // act destructively on a receipt over a network blip - the worst
        // available trade on a project whose top severity is a lost receipt.
        // Everything else rethrows unchanged and reports as what it was.
        //
        // The question is asked of the ObjectStorage contract, not of an S3
        // error's `name`: this layer must not know which store is underneath,
        // and an adapter that answered absence some other way would silently
        // turn every missing photo into an unexplained failure here.
        if (!(error instanceof ObjectNotFoundError)) {
          throw error;
        }
        throw new Error(
          // Leads with the REPAIR now, not with deletion (proposal #6,
          // 2026-08-28): PUT /api/receipts/:id/images/:page can replace
          // just this page's bytes without touching the receipt's vendor,
          // date, total or HST, which an earlier version of this message
          // could not offer because that route did not exist yet - the
          // only remedy was deleting the whole receipt and losing all four.
          // Deleting is still named, second, with its cost attached, for
          // the person who would rather start over or whose paper is gone.
          //
          // The ordering inside the delete-and-recapture path is not a
          // preference: an identical re-captured photo is refused while the
          // old receipt is still live, because the duplicate-image index
          // only frees its slot once that row is tombstoned.
          `Receipt ${image.receiptId} has no image in storage for page ` +
            `${image.page}, so this export cannot be completed - that ` +
            `page's photo never finished uploading. Replace that page's ` +
            `image to repair it without losing the receipt's vendor, ` +
            `date, total or HST. If you would rather start over, delete ` +
            `the receipt and capture it again; deleting it first is what ` +
            `lets an identical photo be accepted. If the paper is gone, ` +
            `deleting the receipt will let the export run without it.`,
          { cause: error },
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(
          `Export exceeds the ${Math.floor(limits.maxTotalBytes / (1024 * 1024))} MiB size limit; export a shorter period`,
        );
      }
      archive.append(Buffer.from(bytes), { name: image.filename });
    }
  });

  const objectKey = exportObjectKey(
    input.userId,
    input.jobId,
    `Receipts-${label}.zip`,
  );
  await deps.storage.upload(objectKey, zip, "application/zip");
  return { objectKey, receiptCount: rows.length };
}

/**
 * "Receipts-2026" when the period is exactly calendar 2026; otherwise the
 * explicit range, so a Mar-31 fiscal year or a quarterly slice names
 * itself honestly.
 */
function periodLabel(period: ExportPeriod): string {
  const calendarYear = period.start.slice(0, 4);
  if (
    period.start === `${calendarYear}-01-01` &&
    period.end === `${calendarYear}-12-31`
  ) {
    return calendarYear;
  }
  return `${period.start}_to_${period.end}`;
}

function extensionOf(objectKey: string): string {
  const lastDot = objectKey.lastIndexOf(".");
  if (lastDot === -1 || lastDot === objectKey.length - 1) {
    throw new Error(`Object key has no file extension: ${objectKey}`);
  }
  return objectKey.slice(lastDot + 1);
}

/**
 * Run archiver into an in-memory buffer. Streaming to disk or storage
 * would matter at gigabyte scale; at this project's scale the simple
 * buffer wins on legibility, and the seam to change it is this one
 * function.
 */
async function buildZip(
  fill: (archive: Archiver) => Promise<void>,
): Promise<Uint8Array> {
  const archive = new ZipArchive();
  const chunks: Buffer[] = [];
  const output = new PassThrough();
  output.on("data", (chunk: Buffer) => chunks.push(chunk));

  const finished = new Promise<void>((resolve, reject) => {
    output.on("finish", resolve);
    archive.on("error", reject);
    archive.on("warning", reject); // a warning is a corrupt-archive risk, not a log line
  });

  archive.pipe(output);
  await fill(archive);
  await archive.finalize();
  await finished;
  return new Uint8Array(Buffer.concat(chunks));
}
