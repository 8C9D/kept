/**
 * The image store boundary. Images travel client ↔ storage directly via
 * presigned URLs and never transit the API server (spec §6); export
 * generation is the one server-side reader (it must bundle every image
 * into the zip) and writer (the finished zip itself).
 *
 * The interface is defined here and tested against a fake; the Cloudflare
 * R2 implementation arrives when credentials exist (deployment work, after
 * the local waves).
 *
 * ⚠ Bucket requirement for the real adapter: a 30-day lifecycle expiry on
 * the literal prefix `exports/` and nothing else (spec §10B; the shapes are
 * in objectKeys.ts). Export zips are artifacts, not records - regenerable
 * from the retained receipts and images - and the API already reports jobs
 * past that window as "expired". Receipt images live under `{userId}/...`
 * and must NOT be under any lifecycle rule.
 */
export interface ObjectStorage {
  /** A URL the client can PUT the image bytes to, valid briefly. */
  presignUpload(objectKey: string, contentType: string): Promise<string>;
  /** A URL the client can GET the image bytes from, valid briefly. */
  presignDownload(objectKey: string): Promise<string>;
  /** Server-side write, used for generated export zips. */
  upload(
    objectKey: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<void>;
  /**
   * Server-side read, used to bundle images into an export.
   *
   * ⚠ Every adapter must honour one distinction here, and it is the contract
   * rather than a detail of any one implementation: an object that is not
   * there rejects with `ObjectNotFoundError` below, and nothing else does.
   * A timeout, a refused credential, a store that is down - each rejects as
   * itself, unchanged.
   *
   * The export path (spec §8) decides between "this receipt's photo never
   * finished uploading" and "storage did not answer" on exactly this
   * distinction, and the two lead to opposite advice: one of them tells a
   * person to delete a receipt. An adapter that reported a network blip as
   * absence would tell someone to destroy a record over it, which on a
   * project whose top severity is a lost receipt is the worst available
   * trade.
   */
  download(objectKey: string): Promise<Uint8Array>;
  /**
   * Server-side erase, used by account deletion (spec §6, `DELETE /api/me`)
   * and by nothing else. Receipt deletion is soft - CRA retention makes a
   * per-receipt hard delete off the table (§10B) - so this exists for the
   * one act that is not retention-governed: a person destroying their own
   * account, which App Store Guideline 5.1.1(v) requires be possible from
   * inside the app.
   *
   * ⚠ Idempotent by contract: deleting a key that is not there SUCCEEDS.
   * That is the opposite of `download`'s rule above, and deliberately so.
   * There, absence is a fact a caller must be able to act on - it decides
   * whether to tell a person to delete a receipt. Here, absence is the
   * outcome being asked for, and a deleter that threw on it would turn the
   * ordinary case (an upload that never finished, a re-run after a partial
   * failure) into a reported failure of the whole deletion.
   */
  delete(objectKey: string): Promise<void>;
}

/**
 * "That object is not there" - the one way anything in this codebase asks
 * that question, and the one answer an adapter may give to it.
 *
 * Stated here, on the boundary, rather than in each caller. Before this,
 * three separate predicates read an *S3* error's `name` for `NoSuchKey` /
 * `NotFound` - two of them byte-identical, and one of them in the export
 * layer, which is not supposed to know what store is underneath. A future
 * non-S3 adapter would have satisfied `ObjectStorage` in full and silently
 * lost the behaviour: its absence errors would carry some other name, the
 * export path would stop recognising them, and a missing photo would start
 * reporting as an unexplained failure. Naming the S3 spellings in the S3
 * adapter, once, and translating there is what makes that impossible.
 *
 * The original error is kept as `cause`, never swallowed: the store's own
 * answer is what a server-side log needs to tell `NoSuchKey` from a 404 the
 * SDK inferred from something else.
 */
export class ObjectNotFoundError extends Error {
  constructor(objectKey: string, options?: { cause?: unknown }) {
    super(`No object at ${objectKey}`, options);
    this.name = "ObjectNotFoundError";
  }
}

/**
 * Placeholder wired into the production entrypoint until the R2 adapter
 * exists. Throwing on first use is deliberate: a loud failure at the call
 * site, not a broken URL handed silently to a client.
 */
export function unconfiguredObjectStorage(): ObjectStorage {
  const fail = (): never => {
    throw new Error(
      "Object storage is not configured; the R2 adapter does not exist yet",
    );
  };
  return {
    presignUpload: async () => fail(),
    presignDownload: async () => fail(),
    upload: async () => fail(),
    download: async () => fail(),
    delete: async () => fail(),
  };
}
