/**
 * Every key this system puts in object storage, and the shapes they must
 * take. One module because the *layout* is the thing under review: an
 * isolation rule and a retention rule are both written against these
 * prefixes, and neither can be checked if the strings are built in the
 * routes that happen to need them.
 *
 * Two families, and they are deliberately disjoint at the first segment:
 *
 *   receipt images   {userId}/yyyy/mm/{uuid}.{ext}
 *   export zips      exports/{userId}/{jobId}/{filename}.zip
 *
 * §10B requires a 30-day lifecycle expiry on export zips and *no lifecycle
 * rule at all* on receipt images. S3 and R2 lifecycle rules match a literal
 * prefix, so the earlier layout - `{userId}/exports/...` - could not
 * express that: `{userId}` varies per user, and no single literal prefix
 * selects every user's exports without also selecting their receipt images.
 * Hoisting `exports/` to the front makes the rule one literal prefix, for
 * every user, forever.
 */

/** The one literal prefix a bucket lifecycle rule is written against. */
export const EXPORTS_PREFIX = "exports/";

/**
 * The upload content types the API issues keys for, and the extension each
 * one lands under. The create route validates against this same map, so an
 * extension the issuer can produce and the validator would refuse cannot
 * exist.
 */
export const EXTENSION_BY_CONTENT_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
} as const;

export type UploadContentType = keyof typeof EXTENSION_BY_CONTENT_TYPE;

/**
 * Where a newly uploaded receipt image goes: under the owner's id, in a
 * calendar-based folder (spec §5.1), named by a uuid so the key is
 * unguessable (spec §10B).
 */
export function receiptImageObjectKey(
  userId: string,
  capturedAt: Date,
  uuid: string,
  contentType: UploadContentType,
): string {
  const year = capturedAt.getUTCFullYear();
  const month = String(capturedAt.getUTCMonth() + 1).padStart(2, "0");
  return `${userId}/${year}/${month}/${uuid}.${EXTENSION_BY_CONTENT_TYPE[contentType]}`;
}

/** Where a generated export zip goes. See EXPORTS_PREFIX above for why. */
export function exportObjectKey(
  userId: string,
  jobId: string,
  filename: string,
): string {
  return `${EXPORTS_PREFIX}${userId}/${jobId}/${filename}`;
}

/**
 * Exactly the keys `receiptImageObjectKey` produces for this user, and
 * nothing else.
 *
 * A prefix test (`startsWith(userId + "/")`) is not enough. It admits dot
 * segments - `{userIdA}/../{userIdB}/2026/03/theirs.jpg` starts with A's
 * prefix but names B's namespace - and whether such a key resolves into
 * another user's objects is then decided by the storage layer's path
 * normalization rather than by us. The August 2026 audit measured exactly
 * how unreliable that is: against MinIO, dot-segment spellings all fail,
 * but a *leading slash* normalizes the other way and serves the victim's
 * bytes with a 200. Same layer, same class of input, opposite outcome - so
 * "the storage layer collapses it" is not a property anything can rest on,
 * and R2's behaviour is untested besides. A whole-string match settles it
 * here instead.
 */
export function isIssuedObjectKey(objectKey: string, userId: string): boolean {
  const prefix = `${userId}/`;
  if (!objectKey.startsWith(prefix)) {
    return false;
  }
  if (!ISSUED_KEY_REMAINDER.test(objectKey.slice(prefix.length))) {
    return false;
  }
  // The extensions come from the same map the issuing route uses, so the
  // two cannot drift apart.
  return Object.values(EXTENSION_BY_CONTENT_TYPE).some((extension) =>
    objectKey.endsWith(`.${extension}`),
  );
}

/** `yyyy/mm/{uuid}.{extension}` - what follows the user prefix. */
const ISSUED_KEY_REMAINDER =
  /^\d{4}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z]+$/;

/**
 * The export half of the same question, on the way *out* of the database.
 *
 * The 2026-08-06 ruling was "stored object keys are re-validated on read, in
 * both places one is dereferenced". There are **three** places: the receipt
 * detail route, export generation, and the export download URL - and the third
 * had no check at all, so this is an unfulfilled ruling as much as a hardening
 * step.
 *
 * Stricter than `isIssuedObjectKey`, because it can afford to be. A receipt
 * image key can only be pinned to its owner, since the caller does not know
 * which uuid or which month to expect. An export key is dereferenced from the
 * job row itself, so the user id AND the job id are both in hand, and the whole
 * string is checked against exactly what `exportObjectKey` would have produced
 * for that row. There is no wildcard segment.
 *
 * The filename is the only varying part, and `generateExport` builds it from
 * `periodLabel`, which emits either `yyyy` or `yyyy-mm-dd_to_yyyy-mm-dd` over
 * dates that are already `isoDateSchema`-validated and cannot contain a slash.
 */
export function isIssuedExportKey(
  objectKey: string,
  userId: string,
  jobId: string,
): boolean {
  const prefix = `${EXPORTS_PREFIX}${userId}/${jobId}/`;
  if (!objectKey.startsWith(prefix)) {
    return false;
  }
  return ISSUED_EXPORT_FILENAME.test(objectKey.slice(prefix.length));
}

/** `Receipts-2026.zip`, or `Receipts-2025-04-01_to_2026-03-31.zip`. */
const ISSUED_EXPORT_FILENAME =
  /^Receipts-(\d{4}|\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2})\.zip$/;

/**
 * The same check on the way *out* of the database, before a stored key is
 * turned into a presigned URL or a download.
 *
 * ⚠ Validating on write is not enough, and the August 2026 audit proved it
 * by hand-editing one row: the detail route presigned whatever `object_key`
 * the row held and returned a URL naming another user's namespace. Write-
 * time validation says "we issued every key we accepted"; it cannot say
 * "we issued every key we are about to hand out", because rows can change
 * by paths that are not the create route - a migration, a dev script, a
 * future admin tool, a bug.
 *
 * This throws rather than returning false: a stored key that we did not
 * issue is a data-integrity failure, not a client error, and the only safe
 * responses are to fail the request loudly and leave a log line. It renders
 * as a 500, which is correct - nobody's request caused it.
 */
export function assertIssuedObjectKey(objectKey: string, userId: string): void {
  if (!isIssuedObjectKey(objectKey, userId)) {
    // The key itself is deliberately absent from the message: it is about
    // to be logged, and if it names another user's prefix, that prefix is
    // their user id. The receipt-image row is findable from the request.
    throw new Error(
      "Stored object key does not match the shape issued for its owner; " +
        "refusing to hand out a URL for it",
    );
  }
}
