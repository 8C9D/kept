import { ZipArchive } from "archiver";
import { once } from "node:events";
import { PassThrough, addAbortSignal, type Readable } from "node:stream";
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
  type DownloadedObject,
  type ObjectStorage,
} from "../storage/objectStorage.js";
import type { ExportRow } from "./exportRows.js";
import { writeCsv, writeJson, writeXlsx } from "./writeFiles.js";

export interface ExportPeriod {
  start: string; // ISO yyyy-mm-dd, inclusive
  end: string;
}

/**
 * An export that cannot finish must be refused with a clear reason - an
 * explicit failure the user can act on (export a shorter period), never a job
 * left to run out of road. With the backlog and six-year retention, a full year
 * can genuinely reach gigabytes.
 *
 * Bytes are the only limit: a row count would be a worse-measured proxy for
 * the same bound, and could refuse an export that would have fit - the wrong
 * failure for the one artifact the accountant needs.
 *
 * ⚠ What the bound is FOR changed when assembly stopped being in memory, and
 * that is why the number moved. At 256 MiB it was a memory budget: the zip was
 * built in this process, peaked at 891 MiB of RSS, and a single large object
 * could kill the API for both users before the check even ran. Assembly is now
 * a stream from storage to storage (`streamZipToStorage`), so memory no longer
 * scales with the export. Measured through `runExportJob` against MinIO, from a
 * 250 MiB idle process: peak RSS 345 MiB for 250 MiB of images, 382 MiB for one
 * 1 GiB object, 438 MiB for 4.3 GiB - and the old code on the same harness took
 * 1128 MiB and 1636 MiB for the first two. What remains above idle is garbage
 * waiting for a collection, not retained data: RSS fell back to around 200 MiB
 * mid-job in the 4.3 GiB run.
 *
 * What an export still spends in proportion to its size is TIME, against the
 * 30-minute `STALE_RUNNING_AFTER_MINUTES` clock in routes/exports.ts, after
 * which a job is written off as dead whether or not it is still working. 4 GiB
 * reaches that clock only below about 2.3 MiB/s between the origin and storage.
 * The two numbers are a pair: raising this one means re-checking that one.
 */
export interface ExportLimits {
  maxTotalBytes: number;
  /**
   * How long one object may send nothing before it is given up on: from the
   * moment its bytes are asked for, and between any two chunks. A store that
   * stops mid-object never errors and never ends, so without this an export
   * would hold its socket and wait forever.
   */
  objectStallMs: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxTotalBytes: 4 * 1024 * 1024 * 1024, // 4 GiB
  objectStallMs: 60_000,
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
  limits: Partial<ExportLimits> = {},
): Promise<{ objectKey: string; receiptCount: number }> {
  const { maxTotalBytes, objectStallMs } = {
    ...DEFAULT_EXPORT_LIMITS,
    ...limits,
  };
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

  // Measured in bytes rather than in JavaScript string length, which
  // undercounts every non-ASCII vendor name. Every page counts, since every
  // page is bytes in the zip (proposal #6).
  const budget = exportBudget(maxTotalBytes);
  budget.spend(
    xlsx.byteLength + Buffer.byteLength(csv) + Buffer.byteLength(json),
  );

  const objectKey = exportObjectKey(
    input.userId,
    input.jobId,
    `Receipts-${label}.zip`,
  );
  await streamZipToStorage(deps.storage, objectKey, async (zip) => {
    await zip.addData(`receipts-${label}.xlsx`, Buffer.from(xlsx));
    await zip.addData(`receipts-${label}.csv`, csv);
    await zip.addData(`receipts-${label}.json`, json);
    // One at a time, each finished before the next is opened (see `addObject`):
    // the loop's `await` is what keeps a year of receipts from being a year of
    // open sockets.
    for (const image of imagesToBundle) {
      const stalled =
        `Storage stopped sending the image for receipt ${image.receiptId} ` +
        `page ${image.page}, so this export could not finish. Run it again.`;
      const object = await openImage(
        deps.storage,
        image,
        objectStallMs,
        stalled,
      );
      try {
        // Refused here, with the size in hand and before a byte has moved,
        // whenever the store stated one. `spend` below still counts what
        // really arrives, which is the whole check when it did not.
        if (object.contentLength !== null) {
          budget.refuseBeyond(object.contentLength);
        }
        await zip.addObject(image.filename, object.body, {
          onChunk: (byteLength) => budget.spend(byteLength),
          stallMs: objectStallMs,
          stalled,
        });
      } finally {
        // A refusal above never read this body. An open body is an open
        // socket, and destroying one that already ended does nothing.
        object.body.destroy();
      }
    }
  });
  return { objectKey, receiptCount: rows.length };
}

/**
 * The byte budget (`ExportLimits`). Two questions rather than one, because
 * they are asked at two moments: `refuseBeyond` before an object is read, when
 * its size is known and nothing has been spent, and `spend` as bytes actually
 * arrive, which is the only answer when the store states no size.
 */
function exportBudget(maxTotalBytes: number) {
  let spent = 0;
  const refuseBeyond = (bytes: number): void => {
    if (spent + bytes > maxTotalBytes) {
      throw new Error(
        `Export exceeds the ${Math.floor(maxTotalBytes / (1024 * 1024))} MiB size limit; export a shorter period`,
      );
    }
  };
  return {
    refuseBeyond,
    spend(bytes: number): void {
      refuseBeyond(bytes);
      spent += bytes;
    },
  };
}

/**
 * Open one image for reading, bounded by the stall window, and turn "it is not
 * there" into the sentence a person can act on.
 *
 * The bound is a race rather than a timeout on the request, because the
 * `ObjectStorage` boundary has no way to cancel a read. The cost of that is the
 * `.then` below: a read that loses and later succeeds hands back a live socket
 * with nobody holding it, so it is destroyed on arrival. Its rejection is
 * swallowed only because the race has already reported the same promise's
 * outcome - when it lost, nothing is left that could care.
 */
async function openImage(
  storage: ObjectStorage,
  image: { receiptId: string; page: number; objectKey: string },
  stallMs: number,
  stalled: string,
): Promise<DownloadedObject> {
  const opening = storage.downloadStream(image.objectKey);
  let watchdog: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      opening,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(stalled)), stallMs);
      }),
    ]);
  } catch (error) {
    void opening.then(
      (object) => object.body.destroy(),
      () => undefined,
    );
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
    //
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
  } finally {
    clearTimeout(watchdog);
  }
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

/** What `fill` is given: the two ways an entry gets into the zip. */
export interface ZipEntries {
  /**
   * The spreadsheets and the JSON: already in memory, and deflated, because
   * text compresses and these are small enough for it to cost nothing.
   */
  addData(name: string, data: Buffer | string): Promise<void>;
  /**
   * One object, deflated at level 1 like the rest of the archive. An image is
   * already compressed, so this saves nothing, and it is still not stored:
   * a streamed STORED entry carries a data descriptor, a shape some unzip
   * tools refuse (Java's `ZipInputStream` is documented to), and this zip is
   * the one file that leaves for a machine nobody here can test. A deflated
   * entry with a descriptor is the shape every tool reads, and level 1 on
   * incompressible bytes costs next to nothing.
   *
   * ⚠ Resolves when the entry is FINISHED, and the caller waits for it before
   * opening the next object. archiver would happily take a dozen streams at
   * once and queue them, but a queued stream is an open GetObject that is
   * reading nothing, and enough of those exhausts the SDK's socket pool - with
   * the entry that would free one waiting behind them.
   */
  addObject(name: string, body: Readable, watch: ObjectWatch): Promise<void>;
}

interface ObjectWatch {
  onChunk(byteLength: number): void;
  stallMs: number;
  stalled: string;
}

/**
 * Stream a zip straight into object storage: nothing is assembled here, and
 * the bytes in this process at any moment are one multipart part plus what the
 * streams between source and upload are holding.
 *
 * The shape is what makes it safe, and it has exactly one thing to wait on:
 * `uploaded`. Everything that can go wrong - the store refusing a part, an
 * image failing mid-body, the archive erroring, `fill` throwing - goes through
 * `fail`, and `fail` destroys `output`, which is the stream `uploadStream` is
 * reading. So every failure ends the upload, the upload aborts itself, and
 * `uploaded` settles having done so; by the time this rejects, no object and
 * no multipart upload are left behind.
 *
 * ⚠ Two shapes this deliberately does not have. There is no promise that
 * rejects on an archive error while something else is being awaited - the
 * previous version had one, and an unhandled rejection there would have killed
 * the process for both users. Every promise here has its rejection consumed
 * where it is created. And `fail` must never `archive.abort()`: that ENDS the
 * archive, which ends `output` cleanly, which an upload would complete as a
 * truncated zip that looks finished. A failed export has to look failed all the
 * way down, so `output` is destroyed with the error and the archive is simply
 * abandoned.
 *
 * The upload starts before anything is written so that backpressure exists
 * from the first byte: it is the reader, and without it the archive has nowhere
 * to push and `fill` would be feeding a buffer.
 *
 * Exported so the failure path can be driven directly: no entry name
 * `generateExport` builds can make the archive itself error.
 */
export async function streamZipToStorage(
  storage: ObjectStorage,
  objectKey: string,
  fill: (zip: ZipEntries) => Promise<void>,
): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const output = new PassThrough();
  const stop = new AbortController();
  const { signal } = stop;

  // The first failure is the one reported; whatever it then knocks over
  // arrives here second and changes nothing.
  const fail = (error: unknown): void => {
    if (signal.aborted) {
      return;
    }
    stop.abort(error);
    output.destroy(
      error instanceof Error ? error : new Error("Export assembly failed"),
    );
    archive.destroy();
  };
  archive.on("error", fail);
  archive.on("warning", fail); // a warning is a corrupt-archive risk, not a log line
  output.on("error", fail);

  const uploaded = storage
    .uploadStream(objectKey, output, "application/zip")
    .catch(fail);
  archive.pipe(output);

  const zip: ZipEntries = {
    async addData(name, data) {
      signal.throwIfAborted();
      const appended = once(archive, "entry", { signal });
      archive.append(data, { name });
      await appended;
    },

    async addObject(name, body, watch) {
      // ⚠ This order. `addAbortSignal` on a signal that has already fired
      // destroys `body` with an error while nothing is listening to it yet,
      // and an unheard 'error' event takes the process down. The caller's
      // `finally` destroys it quietly instead.
      signal.throwIfAborted();
      // Destroys `body` on failure, which is what releases a read parked in
      // `copyObject` waiting for bytes that are no longer wanted.
      addAbortSignal(signal, body);
      // ⚠ Our own stream, never `body` itself. archiver pipes whatever it is
      // given through an internal PassThrough, and `pipe` does not forward
      // errors: a source that failed mid-body would leave that entry open
      // forever and the job hanging. Here the source's failure surfaces in
      // `copyObject`, where it can fail the export.
      const entry = new PassThrough();
      const finished = once(archive, "entry", { signal });
      archive.append(entry, { name });
      // `all`, so `finished` has a handler however `copyObject` ends.
      await Promise.all([copyObject(body, entry, watch, signal), finished]);
    },
  };

  void (async () => {
    await fill(zip);
    await archive.finalize();
  })().catch(fail);

  await uploaded;
  if (signal.aborted) {
    throw signal.reason;
  }
}

/**
 * Copy one object into its zip entry, with the stall watchdog armed only while
 * this is waiting on the SOURCE.
 *
 * ⚠ That is why this is a loop and not a `pipeline`. When the upload is the
 * slow side, backpressure stops the reads, and a watchdog on bytes passing
 * through would then fire on a healthy object because a part was taking a while
 * to store. Pulling chunk by chunk separates the two: the timer runs across the
 * wait for the next chunk and is off across the wait for the sink. A stuck
 * upload is the storage adapter's to bound (`MULTIPART_REQUEST_TIMEOUT_MS`).
 */
async function copyObject(
  body: Readable,
  entry: PassThrough,
  { onChunk, stallMs, stalled }: ObjectWatch,
  signal: AbortSignal,
): Promise<void> {
  const onStall = () => body.destroy(new Error(stalled));
  let watchdog = setTimeout(onStall, stallMs);
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      clearTimeout(watchdog);
      onChunk(chunk.byteLength);
      if (!entry.write(chunk)) {
        await once(entry, "drain", { signal });
      }
      watchdog = setTimeout(onStall, stallMs);
    }
  } finally {
    clearTimeout(watchdog);
  }
  entry.end();
}
