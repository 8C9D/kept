import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EXPORTS_PREFIX,
  assertIssuedObjectKey,
  exportObjectKey,
  isIssuedExportKey,
  isIssuedObjectKey,
  receiptImageObjectKey,
} from "../../src/storage/objectKeys.js";
import { STARTUP_PROBE_KEY } from "../../src/storage/s3ObjectStorage.js";

/**
 * The startup probe issues a `GetObject` for a key it expects to be absent,
 * and its whole safety rests on that key never naming a real object. Until
 * this file that rested on a sentence in a comment: the constant could have
 * been changed to `{uuid}/2026/08/{uuid}.jpg` and the entire suite stayed
 * green, while a boot probe read - and an operator reading the refusal
 * blamed - somebody's receipt photo.
 *
 * So the claim is checked against the key validators themselves rather than
 * restated. And "no user id collides" is checked by enumeration, not by one
 * example: `isIssuedObjectKey` can only return true for a user id that is a
 * prefix of the key ending at a `/`, so every such prefix is a candidate and
 * all of them are tried. The last case proves the enumerators can actually
 * find an owner, because a disjointness test whose search is broken passes
 * for the wrong reason.
 */

/**
 * Every user id for which `isIssuedObjectKey(objectKey, userId)` could get
 * past its `startsWith` guard - which is every prefix that ends at a slash.
 * Any other user id fails on the prefix alone.
 */
function candidateUserIds(objectKey: string): string[] {
  return slashIndexes(objectKey).map((index) => objectKey.slice(0, index));
}

/**
 * Every (userId, jobId) pair `isIssuedExportKey` could get past its
 * `startsWith` guard for. Empty unless the key opens with the literal
 * `exports/` prefix, which is the disjointness the two families are built on.
 */
function candidateExportOwners(
  objectKey: string,
): Array<{ userId: string; jobId: string }> {
  if (!objectKey.startsWith(EXPORTS_PREFIX)) {
    return [];
  }
  const rest = objectKey.slice(EXPORTS_PREFIX.length);
  const indexes = slashIndexes(rest);
  const owners: Array<{ userId: string; jobId: string }> = [];
  for (const first of indexes) {
    for (const second of indexes) {
      if (second <= first) {
        continue;
      }
      owners.push({
        userId: rest.slice(0, first),
        jobId: rest.slice(first + 1, second),
      });
    }
  }
  return owners;
}

function slashIndexes(value: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "/") {
      indexes.push(index);
    }
  }
  return indexes;
}

describe("the startup probe key is disjoint from every key this system issues", () => {
  it("is not a receipt-image key for ANY user id, not merely for a real one", () => {
    const candidates = candidateUserIds(STARTUP_PROBE_KEY);
    // Not vacuous: the probe key has a slash, so there is something to try.
    expect(candidates.length).toBeGreaterThan(0);
    for (const userId of candidates) {
      expect(isIssuedObjectKey(STARTUP_PROBE_KEY, userId)).toBe(false);
    }
    // And for a signed-in user's actual id, which is the case the probe runs
    // beside.
    expect(isIssuedObjectKey(STARTUP_PROBE_KEY, randomUUID())).toBe(false);
  });

  it("is refused by the assertion the read paths actually call", () => {
    // `assertIssuedObjectKey` is what the receipt detail route and export
    // generation use; the predicate above is only half the surface.
    for (const userId of [...candidateUserIds(STARTUP_PROBE_KEY), randomUUID()]) {
      expect(() => assertIssuedObjectKey(STARTUP_PROBE_KEY, userId)).toThrow(
        /does not match the shape issued/,
      );
    }
  });

  it("is not an export key for ANY user id and job id", () => {
    // Export keys are pinned to one literal prefix - that is what makes the
    // §10B lifecycle rule expressible - so a key that does not open with it
    // has no candidate owners at all.
    expect(STARTUP_PROBE_KEY.startsWith(EXPORTS_PREFIX)).toBe(false);
    for (const { userId, jobId } of candidateExportOwners(STARTUP_PROBE_KEY)) {
      expect(isIssuedExportKey(STARTUP_PROBE_KEY, userId, jobId)).toBe(false);
    }
  });

  it("opens with a character neither issued family can start with", () => {
    // The mechanism behind the two cases above, stated where it can fail: a
    // receipt-image key starts with a uuid and an export key with `exports/`,
    // so a leading dot belongs to neither.
    expect(STARTUP_PROBE_KEY.startsWith(".")).toBe(true);
    expect(receiptImageObjectKey(randomUUID(), new Date(), randomUUID(), "image/jpeg")).not.toMatch(
      /^\./,
    );
    expect(EXPORTS_PREFIX.startsWith(".")).toBe(false);
  });

  it("can find the owner of a key that IS issued, so the disjointness above is a real search", () => {
    // Without this, every assertion in this file would also pass with an
    // enumerator that returned nothing and a validator that always said false.
    const userId = randomUUID();
    const jobId = randomUUID();

    const imageKey = receiptImageObjectKey(
      userId,
      new Date("2026-08-20T12:00:00Z"),
      randomUUID(),
      "image/jpeg",
    );
    expect(candidateUserIds(imageKey)).toContain(userId);
    expect(isIssuedObjectKey(imageKey, userId)).toBe(true);

    const exportKey = exportObjectKey(userId, jobId, "Receipts-2026.zip");
    expect(candidateExportOwners(exportKey)).toContainEqual({ userId, jobId });
    expect(isIssuedExportKey(exportKey, userId, jobId)).toBe(true);
  });
});
