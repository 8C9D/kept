import { createHash } from "node:crypto";
import {
  ObjectNotFoundError,
  type ObjectStorage,
} from "../storage/objectStorage.js";

/**
 * The image leg of the restore drill, one row at a time - extracted from
 * `verifyRestore.ts` so it can be tested, because the script itself runs
 * on import and a drill whose classification is wrong misleads exactly the
 * person it exists to reassure.
 *
 * Four verdicts, and the distinction between the last two is the point
 * (round 4 §4a): the drill used to label every download failure `MISSING`,
 * conflating "the backup lost this image" with "storage did not answer" -
 * the same absence-vs-unreachable conflation N-4(b) removed from the
 * export path, surviving here in the operator script. On drill day that
 * conflation reads as "the backup is bad" when the truth may be a network
 * blip; during a real restore it aims the operator at re-capturing or
 * writing off records that are still safe in the bucket. The question is
 * asked of the ObjectStorage contract, never of an S3 error's name.
 */
export interface RestoredImageRow {
  objectKey: string;
  sha256: string;
}

export type RestoredImageVerdict =
  /** The bytes are there and hash to the row's own digest. */
  | { label: "ok"; failure?: undefined }
  /** The bytes are there and are the wrong bytes - the worst verdict. */
  | { label: "DIGEST"; failure: string }
  /** Storage answered: there is no object behind this row. */
  | { label: "MISSING"; failure: string }
  /**
   * Storage did not answer. The object may be there; this run cannot say,
   * and must not claim the backup lost it.
   */
  | { label: "UNREACHABLE"; failure: string };

export async function checkRestoredImage(
  storage: Pick<ObjectStorage, "download">,
  image: RestoredImageRow,
): Promise<RestoredImageVerdict> {
  let bytes: Uint8Array;
  try {
    bytes = await storage.download(image.objectKey);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      return {
        label: "MISSING",
        failure:
          `${image.objectKey}: absent from storage` +
          `${causeName(error) === undefined ? "" : ` (${causeName(error)})`}`,
      };
    }
    return {
      label: "UNREACHABLE",
      failure:
        `${image.objectKey}: storage did not answer (${errorName(error)}) - ` +
        `the object may still be there; this run proves nothing about it ` +
        `either way`,
    };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== image.sha256) {
    return {
      label: "DIGEST",
      failure: `${image.objectKey}: stored bytes hash to ${digest}, row says ${image.sha256}`,
    };
  }
  return { label: "ok" };
}

/**
 * The store's own error name off the `cause` the adapter is contracted to
 * keep - `NoSuchKey` vs a 404 the SDK inferred - because "absent" alone is
 * less actionable than "absent, and here is what the store said".
 */
function causeName(error: ObjectNotFoundError): string | undefined {
  const cause = error.cause;
  if (typeof cause === "object" && cause !== null && "name" in cause) {
    const name = (cause as { name: unknown }).name;
    if (typeof name === "string" && name !== "") {
      return name;
    }
  }
  return undefined;
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name !== "") {
    return error.name;
  }
  return `non-Error value thrown (${typeof error})`;
}
