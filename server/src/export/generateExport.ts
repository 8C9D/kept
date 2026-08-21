import { ZipArchive, type Archiver } from "archiver";
import { PassThrough } from "node:stream";
import { and, eq, inArray, isNull } from "drizzle-orm";
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
import { writeCsv, writeXlsx } from "./writeFiles.js";

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

  // Page-1 image per receipt, in one query. Every receipt is created with
  // an image, so a missing one is a data-integrity failure and the export
  // must fail loudly rather than ship an accountant a broken click-through.
  const imagesByReceipt = new Map<string, string>();
  if (receipts.length > 0) {
    const imageRows = await deps.db
      .select({
        receiptId: receiptImages.receiptId,
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
          eq(receiptImages.page, 1),
          isNull(receiptImages.deletedAt),
        ),
      );
    for (const image of imageRows) {
      imagesByReceipt.set(image.receiptId, image.objectKey);
    }
  }

  // Each entry pairs the spreadsheet row with where its image lives in
  // storage; the storage key is transport detail, not export data, so it
  // stays out of ExportRow itself.
  const bundle = receipts.map((receipt) => {
    const imageObjectKey = imagesByReceipt.get(receipt.id);
    if (imageObjectKey === undefined) {
      throw new Error(`Receipt ${receipt.id} has no page-1 image`);
    }
    // The export is the other place a stored key is dereferenced, so it
    // asks the same ownership question the detail route does. A zip is
    // exactly the wrong artifact to discover a mislabelled key in: it
    // leaves the server and lands in an accountant's inbox.
    assertIssuedObjectKey(imageObjectKey, input.userId);
    // Only confirmed receipts export, and the receipts_confirmed_complete_ck
    // constraint guarantees a confirmed receipt has both values. Null here
    // means that guarantee broke, and the job must fail loudly rather than
    // hand an accountant an invented amount.
    if (receipt.totalCents === null || receipt.isBusiness === null) {
      throw new Error(
        `Confirmed receipt ${receipt.id} is missing its total or business flag`,
      );
    }
    const row: ExportRow = {
      receiptId: receipt.id,
      date: receipt.purchasedAt,
      vendor: receipt.vendor,
      vendorGstHstNumber: receipt.vendorTaxNumber,
      subtotalCents:
        receipt.subtotalCents === null ? null : cents(receipt.subtotalCents),
      hstCents: receipt.hstCents === null ? null : cents(receipt.hstCents),
      otherTaxCents:
        receipt.otherTaxCents === null ? null : cents(receipt.otherTaxCents),
      totalCents: cents(receipt.totalCents),
      currency: receipt.currency,
      category: receipt.category,
      paymentMethod: receipt.paymentMethod,
      businessOrPersonal: receipt.isBusiness ? "business" : "personal",
      whose: user.displayName,
      imageFilename: `images/${exportImagePath({
        purchasedAt: receipt.purchasedAt,
        vendor: receipt.vendor,
        receiptId: receipt.id,
        extension: extensionOf(imageObjectKey),
      })}`,
      notes: receipt.notes,
    };
    return { row, imageObjectKey };
  });
  const rows = bundle.map((entry) => entry.row);

  const label = periodLabel(input.period);
  const xlsx = await writeXlsx(rows);
  const csv = writeCsv(rows);

  // The budget is checked before each append, so the refusal lands before
  // the memory is spent, not after.
  let totalBytes = xlsx.byteLength + csv.length;
  const zip = await buildZip(async (archive) => {
    archive.append(Buffer.from(xlsx), { name: `receipts-${label}.xlsx` });
    archive.append(csv, { name: `receipts-${label}.csv` });
    for (const { row, imageObjectKey } of bundle) {
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
        bytes = await deps.storage.download(imageObjectKey);
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
          // Leads with the remedy that KEEPS the receipt. An earlier draft
          // led with "delete that receipt", which reads as the instruction
          // and takes the vendor, the date, the total and the HST out of
          // every future export - the loss this whole finding exists to
          // avoid. Deleting is still named, because it is what unblocks a
          // year-end export when the paper is genuinely gone, and it is
          // named second with its cost attached.
          //
          // The ordering inside the keep-it path is not a preference: an
          // identical re-captured photo is refused while the old receipt is
          // still live, because the duplicate-image index only frees its
          // slot once that row is tombstoned.
          `Receipt ${row.receiptId} has no image in storage, so this export ` +
            `cannot be completed - its photo never finished uploading. ` +
            `If you still have the paper, delete that receipt and capture it ` +
            `again; deleting it first is what lets the same photo be ` +
            `accepted. If the paper is gone, deleting the receipt will let ` +
            `the export run without it.`,
          { cause: error },
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error(
          `Export exceeds the ${Math.floor(limits.maxTotalBytes / (1024 * 1024))} MiB size limit; export a shorter period`,
        );
      }
      archive.append(Buffer.from(bytes), { name: row.imageFilename });
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
