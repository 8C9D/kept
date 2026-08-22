import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkRestoredImage } from "../../src/db/restoreImageCheck.js";
import { ObjectNotFoundError } from "../../src/storage/objectStorage.js";

/**
 * The restore drill's image-leg classification (round 4 §4a). The drill
 * used to label every download failure MISSING; these tests pin the
 * distinction the export path already carries: absence is the
 * ObjectStorage contract's ObjectNotFoundError and nothing else, and a
 * storage failure that is not absence must never claim the backup lost an
 * image. The fakes below answer the way the contract requires - a non-S3
 * "adapter" throwing ObjectNotFoundError for absence and itself for
 * anything else - which is the same shape tests/helpers/fakeObjectStorage
 * proves for the app paths.
 */

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const DIGEST = createHash("sha256").update(BYTES).digest("hex");
const ROW = { objectKey: "user-1/2026/08/photo.jpg", sha256: DIGEST };

describe("checkRestoredImage", () => {
  it("passes bytes that hash to the row's own digest", async () => {
    const verdict = await checkRestoredImage(
      { download: async () => BYTES },
      ROW,
    );
    expect(verdict.label).toBe("ok");
    expect(verdict.failure).toBeUndefined();
  });

  it("fails wrong bytes as DIGEST, with both hashes named", async () => {
    const wrongBytes = new Uint8Array([9, 9, 9]);
    const verdict = await checkRestoredImage(
      { download: async () => wrongBytes },
      ROW,
    );
    expect(verdict.label).toBe("DIGEST");
    expect(verdict.failure).toContain(ROW.sha256);
    expect(verdict.failure).toContain(
      createHash("sha256").update(wrongBytes).digest("hex"),
    );
  });

  it("reports contract-stated absence as MISSING, keeping the store's own answer", async () => {
    const verdict = await checkRestoredImage(
      {
        download: async () => {
          throw new ObjectNotFoundError(ROW.objectKey, {
            cause: Object.assign(new Error("no such key"), {
              name: "NoSuchKey",
            }),
          });
        },
      },
      ROW,
    );
    expect(verdict.label).toBe("MISSING");
    expect(verdict.failure).toContain("absent from storage");
    // The store's own spelling survives via the cause the adapter keeps -
    // "absent" alone is less actionable than "absent, and the store said
    // NoSuchKey".
    expect(verdict.failure).toContain("NoSuchKey");
  });

  it("reports any other failure as UNREACHABLE, never as a lost image", async () => {
    // A timeout is the realistic shape: the object may be fine, and a
    // MISSING verdict here would read as "the backup lost this image" on
    // the one day someone is deciding whether to trust the backup.
    const timeout = Object.assign(new Error("socket timed out"), {
      name: "TimeoutError",
    });
    const verdict = await checkRestoredImage(
      {
        download: async () => {
          throw timeout;
        },
      },
      ROW,
    );
    expect(verdict.label).toBe("UNREACHABLE");
    expect(verdict.failure).toContain("storage did not answer");
    expect(verdict.failure).toContain("TimeoutError");
    expect(verdict.failure).toContain("may still be there");
    // And it does not use the word that means "the backup lost it".
    expect(verdict.failure).not.toContain("absent");
  });
});
