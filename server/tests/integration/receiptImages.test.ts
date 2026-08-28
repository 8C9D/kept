import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receiptImages } from "../../src/db/schema.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * Proposal #6 (2026-08-28): "add a page" and "replace an image" - the two
 * routes that let bytes be attached to a receipt that already exists,
 * which is the seam wave 1's `page` column always had and nothing wrote to
 * until now, and the only fix for the §8 sharp edge (a receipt whose image
 * never finished uploading, which used to be repairable only by deleting
 * the whole receipt and losing its vendor, date, total and HST).
 */
const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;
let receiptId: string;

/** A valid page-1 create, uploaded through the real upload-url shape. */
async function createReceipt(sha: string): Promise<string> {
  const response = await harness.request(
    token,
    "POST",
    "/api/receipts",
    receiptBody({ image: imageFor(userId, sha) }),
  );
  expect(response.status).toBe(201);
  const created = (await response.json()) as { id: string };
  return created.id;
}

async function detailImages(
  asToken: string,
  id: string,
): Promise<{ page: number; downloadUrl: string }[]> {
  const response = await harness.request(
    asToken,
    "GET",
    `/api/receipts/${id}`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    images: { page: number; downloadUrl: string }[];
  };
  return body.images;
}

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("images-owner"));
  receiptId = await createReceipt("1".repeat(64));
});

describe("POST /api/receipts/:id/images", () => {
  it("assigns page 2 then page 3, never taking a page number from the request", async () => {
    const second = await harness.request(
      token,
      "POST",
      `/api/receipts/${receiptId}/images`,
      imageFor(userId, "2".repeat(64)),
    );
    expect(second.status).toBe(201);
    expect((await second.json()) as { page: number }).toMatchObject({
      page: 2,
    });

    const third = await harness.request(
      token,
      "POST",
      `/api/receipts/${receiptId}/images`,
      imageFor(userId, "3".repeat(64)),
    );
    expect(third.status).toBe(201);
    expect((await third.json()) as { page: number }).toMatchObject({
      page: 3,
    });

    // Readable afterwards through the existing detail route.
    const images = await detailImages(token, receiptId);
    expect(images.map((image) => image.page)).toEqual([1, 2, 3]);
    for (const image of images) {
      expect(image.downloadUrl).toContain(userId);
    }
  });

  it("ignores a client-supplied page number entirely", async () => {
    const response = await harness.request(
      token,
      "POST",
      `/api/receipts/${receiptId}/images`,
      // A strict schema refuses an unknown key outright - proving the
      // server never even parses a client-chosen page, let alone honours
      // one.
      { ...imageFor(userId, "9".repeat(64)), page: 99 },
    );
    expect(response.status).toBe(400);
  });

  it("404s on a receipt that does not exist", async () => {
    const response = await harness.request(
      token,
      "POST",
      `/api/receipts/${randomUUID()}/images`,
      imageFor(userId, "4".repeat(64)),
    );
    expect(response.status).toBe(404);
  });

  it("404s on another user's receipt, exactly like the detail route", async () => {
    const other = await harness.signIn("images-outsider");
    const response = await harness.request(
      other.token,
      "POST",
      `/api/receipts/${receiptId}/images`,
      imageFor(other.userId, "5".repeat(64)),
    );
    expect(response.status).toBe(404);

    // And nothing was added to the receipt the attacker doesn't own.
    const images = await detailImages(token, receiptId);
    expect(images).toHaveLength(1);
  });

  it("refuses a duplicate sha256 with a comprehensible 409, not a raw constraint violation", async () => {
    // The same bytes already attached, live, as page 1.
    const response = await harness.request(
      token,
      "POST",
      `/api/receipts/${receiptId}/images`,
      imageFor(userId, "1".repeat(64)),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("duplicate_image");
    expect(body.error.message).toMatch(/already attached/i);
    // No SQLSTATE, no constraint name, no raw driver text.
    expect(body.error.message).not.toMatch(/23505|constraint|duplicate key/i);

    // And nothing was inserted: the receipt still has only its one page.
    const images = await detailImages(token, receiptId);
    expect(images).toHaveLength(1);
  });

  it("refuses an objectKey that was not issued for this user", async () => {
    const response = await harness.request(
      token,
      "POST",
      `/api/receipts/${receiptId}/images`,
      {
        objectKey: `${randomUUID()}/2026/03/${randomUUID()}.jpg`,
        sha256: "6".repeat(64),
      },
    );
    expect(response.status).toBe(400);
  });
});

describe("PUT /api/receipts/:id/images/:page", () => {
  it("replaces page 1 in place: the page number survives, the old row is soft-deleted and kept", async () => {
    const beforeRows = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, receiptId));
    expect(beforeRows).toHaveLength(1);
    const oldRow = beforeRows[0];
    expect(oldRow?.deletedAt).toBeNull();

    const replacement = imageFor(userId, "7".repeat(64));
    const response = await harness.request(
      token,
      "PUT",
      `/api/receipts/${receiptId}/images/1`,
      replacement,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { page: number; id: string };
    expect(body.page).toBe(1);
    expect(body.id).not.toBe(oldRow?.id);

    // Readable afterwards, still at page 1, alongside no other page - a
    // replace does not renumber or duplicate anything.
    const images = await detailImages(token, receiptId);
    expect(images.map((image) => image.page)).toEqual([1]);

    // Retention: the old row is KEPT, deleted_at stamped, never removed -
    // the same rule every other delete in this codebase follows.
    const allRows = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, receiptId));
    expect(allRows).toHaveLength(2);
    const stillOldRow = allRows.find((row) => row.id === oldRow?.id);
    const newRow = allRows.find((row) => row.id === body.id);
    expect(stillOldRow?.deletedAt).not.toBeNull();
    expect(stillOldRow?.objectKey).toBe(oldRow?.objectKey);
    expect(stillOldRow?.sha256).toBe("1".repeat(64));
    expect(newRow?.deletedAt).toBeNull();
    expect(newRow?.page).toBe(1);
    expect(newRow?.objectKey).toBe(replacement.objectKey);
    expect(newRow?.sha256).toBe("7".repeat(64));
  });

  it("leaves other pages on the receipt untouched", async () => {
    const addedSecond = await harness.request(
      token,
      "POST",
      `/api/receipts/${receiptId}/images`,
      imageFor(userId, "8".repeat(64)),
    );
    expect(addedSecond.status).toBe(201);

    await harness.request(
      token,
      "PUT",
      `/api/receipts/${receiptId}/images/1`,
      imageFor(userId, "9".repeat(64)),
    );

    const images = await detailImages(token, receiptId);
    expect(images.map((image) => image.page)).toEqual([1, 2]);
  });

  it("lets the identical bytes that used to occupy this page be re-uploaded once the old row is tombstoned", async () => {
    // Delete-first-then-capture (spec §5 / Runbook §6), applied to one page
    // instead of a whole receipt: re-uploading page 1's own former bytes -
    // a fresh object key (a new presigned upload), the SAME sha256 - must
    // succeed, because the soft-delete of the OLD row and the insert of the
    // new one happen in the same transaction, freeing the (user_id, sha256)
    // slot before the new row claims it.
    const freshObjectKey = imageFor(userId, "irrelevant").objectKey;
    const sameBytesAsPage1 = "1".repeat(64);

    const response = await harness.request(
      token,
      "PUT",
      `/api/receipts/${receiptId}/images/1`,
      { objectKey: freshObjectKey, sha256: sameBytesAsPage1 },
    );
    expect(response.status).toBe(200);
  });

  it("still refuses a sha256 that is identical to a DIFFERENT live image, with a comprehensible error", async () => {
    await createReceipt("b".repeat(64)); // its page-1 sha is "b".repeat(64)

    const response = await harness.request(
      token,
      "PUT",
      `/api/receipts/${receiptId}/images/1`,
      imageFor(userId, "b".repeat(64)), // otherReceipt's live page-1 sha
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("duplicate_image");
    expect(body.error.message).toMatch(/already attached/i);

    // Nothing was replaced: the original row is still live at page 1.
    const rows = await harness.db
      .select()
      .from(receiptImages)
      .where(
        and(eq(receiptImages.receiptId, receiptId), eq(receiptImages.page, 1)),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
    expect(rows[0]?.sha256).toBe("1".repeat(64));
  });

  it("404s replacing a page that does not exist on this receipt", async () => {
    const response = await harness.request(
      token,
      "PUT",
      `/api/receipts/${receiptId}/images/5`,
      imageFor(userId, "c".repeat(64)),
    );
    expect(response.status).toBe(404);
  });

  it("400s a malformed page number rather than treating it as not-found", async () => {
    for (const page of ["0", "-1", "abc", "1.5"]) {
      const response = await harness.request(
        token,
        "PUT",
        `/api/receipts/${receiptId}/images/${page}`,
        imageFor(userId, "d".repeat(64)),
      );
      expect(response.status).toBe(400);
    }
  });

  it("404s on a receipt that does not exist", async () => {
    const response = await harness.request(
      token,
      "PUT",
      `/api/receipts/${randomUUID()}/images/1`,
      imageFor(userId, "e".repeat(64)),
    );
    expect(response.status).toBe(404);
  });

  it("404s on another user's receipt, exactly like the detail route - and changes nothing", async () => {
    const other = await harness.signIn("images-outsider-2");
    const response = await harness.request(
      other.token,
      "PUT",
      `/api/receipts/${receiptId}/images/1`,
      imageFor(other.userId, "f".repeat(64)),
    );
    expect(response.status).toBe(404);

    const images = await detailImages(token, receiptId);
    expect(images).toHaveLength(1);
    expect(images[0]?.page).toBe(1);
  });

  it("refuses an objectKey that was not issued for this user", async () => {
    const response = await harness.request(
      token,
      "PUT",
      `/api/receipts/${receiptId}/images/1`,
      {
        objectKey: `${randomUUID()}/2026/03/${randomUUID()}.jpg`,
        sha256: "1".repeat(64),
      },
    );
    expect(response.status).toBe(400);
  });
});
