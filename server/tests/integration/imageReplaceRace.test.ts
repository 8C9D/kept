import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptImages, receipts } from "../../src/db/schema.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * PUT /api/receipts/:id/images/:page against DELETE /api/receipts/:id, with
 * real concurrency against real Postgres.
 *
 * The replace used to take no lock on the receipt, and DELETE's image UPDATE
 * cannot see another transaction's uncommitted insert. So a replace in flight
 * across a delete committed a live image onto a deleted receipt: a restore that
 * finds nothing stamped alongside the receipt and 500s forever, and a sha256
 * slot the person can no longer see holding its bytes hostage.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;
let shaCounter = 0;

function nextSha(): string {
  shaCounter += 1;
  return shaCounter.toString(16).padStart(64, "0");
}

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("image-race-user"));
});

async function createReceipt(): Promise<string> {
  const response = await harness.request(token, "POST", "/api/receipts", {
    ...receiptBody({ status: "confirmed" }),
    image: imageFor(userId, nextSha()),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

function replacePage(id: string): Promise<Response> {
  return harness.request(
    token,
    "PUT",
    `/api/receipts/${id}/images/1`,
    imageFor(userId, nextSha()),
  );
}

function deleteReceipt(id: string): Promise<Response> {
  return harness.request(token, "DELETE", `/api/receipts/${id}`);
}

function liveImages(id: string) {
  return harness.db
    .select()
    .from(receiptImages)
    .where(and(eq(receiptImages.receiptId, id), isNull(receiptImages.deletedAt)));
}

/**
 * What must hold however the two interleaved: a deleted receipt has no live
 * image, and it can be restored to exactly one live page 1.
 */
async function expectDeletedAndRestorable(id: string): Promise<void> {
  expect(await liveImages(id)).toHaveLength(0);

  const restored = await harness.request(
    token,
    "POST",
    `/api/receipts/${id}/restore`,
  );
  expect(restored.status).toBe(200);

  const live = await liveImages(id);
  expect(live.map((image) => image.page)).toEqual([1]);
}

describe("replacing a page while the receipt is being deleted", () => {
  it("queues the replace behind the receipt row, so the delete sees its insert", async () => {
    // The interleaving made deterministic, by holding the row the two routes
    // now queue on. `no key update` is deliberate: it is the lock an UPDATE of
    // `receipts` takes, and it does not conflict with the `for key share` the
    // image insert's foreign key takes. A stronger hold here would block the
    // old, lockless route on that FK and pass for the wrong reason - measured,
    // that is how this test first failed to tell the two apart.
    const id = await createReceipt();

    let releaseLock = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockTaken = () => {};
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const holder = harness.db.transaction(async (tx) => {
      await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(eq(receipts.id, id))
        .for("no key update");
      lockTaken();
      await lockHeld;
    });
    await taken;

    let replaceSettled = false;
    const replace = replacePage(id).then((response) => {
      replaceSettled = true;
      return response;
    });
    let deletion: Promise<Response>;
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(replaceSettled).toBe(false);
      deletion = deleteReceipt(id);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      // Released on failure too, or every later test waits on this row.
      releaseLock();
      await holder;
    }

    expect((await replace).status).toBe(200);
    expect((await deletion).status).toBe(204);
    await expectDeletedAndRestorable(id);
  });

  it("answers 404 when the delete got there first, and touches no image", async () => {
    const id = await createReceipt();
    expect((await deleteReceipt(id)).status).toBe(204);
    const before = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, id));

    expect((await replacePage(id)).status).toBe(404);

    const after = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, id));
    expect(after).toEqual(before);
  });

  it("re-reads the receipt after waiting, so a delete that commits first wins", async () => {
    // Predicted: `visibleTo` is re-evaluated against the committed row once
    // the lock is granted, and the replace answers 404 rather than resurrecting
    // an image on a receipt that was deleted while it queued.
    const id = await createReceipt();

    let commitDelete = () => {};
    const deleteMayCommit = new Promise<void>((resolve) => {
      commitDelete = resolve;
    });
    let lockTaken = () => {};
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const deletedAt = new Date();
    const inFlightDelete = harness.db.transaction(async (tx) => {
      await tx
        .update(receipts)
        .set({ deletedAt })
        .where(eq(receipts.id, id));
      lockTaken();
      await deleteMayCommit;
      await tx
        .update(receiptImages)
        .set({ deletedAt })
        .where(eq(receiptImages.receiptId, id));
    });
    await taken;

    const replace = replacePage(id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    commitDelete();
    await inFlightDelete;

    expect((await replace).status).toBe(404);
    await expectDeletedAndRestorable(id);
  });

  it("holds under real concurrency, whichever side wins each race", async () => {
    // Nothing arranged: both requests fired together, many times over. A
    // single round can fall either way and pass by luck, and this is the test
    // that found the same-millisecond stamp collision below.
    for (let round = 0; round < 40; round++) {
      const id = await createReceipt();

      const [replaced, deleted] = await Promise.all([
        replacePage(id),
        deleteReceipt(id),
      ]);

      expect(deleted.status).toBe(204);
      expect([200, 404]).toContain(replaced.status);
      await expectDeletedAndRestorable(id);
    }
  }, 60_000);
});

describe("a replace and a delete in the same millisecond", () => {
  /**
   * Restore finds "the images this delete retired" by equality with the
   * receipt's stamp. Sharing a millisecond used to give the superseded image
   * that stamp as well, so restore revived both and collided on
   * `(receipt_id, page)`: a 409 that could never clear. Freezing the clock
   * makes that the deterministic case rather than an occasional one.
   */
  it("keeps a superseded image out of the restore", async () => {
    const id = await createReceipt();
    const originalImage = (await liveImages(id))[0];

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      expect((await replacePage(id)).status).toBe(200);
      expect((await deleteReceipt(id)).status).toBe(204);
    } finally {
      vi.useRealTimers();
    }

    await expectDeletedAndRestorable(id);
    const live = await liveImages(id);
    // It is the replacement that came back, not the page it replaced.
    expect(live[0]?.id).not.toBe(originalImage?.id);
  });

  it("stamps each delete past every tombstone before it, across delete and restore cycles", async () => {
    const id = await createReceipt();

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        expect((await replacePage(id)).status).toBe(200);
        expect((await deleteReceipt(id)).status).toBe(204);
        const restored = await harness.request(
          token,
          "POST",
          `/api/receipts/${id}/restore`,
        );
        expect(restored.status).toBe(200);
        expect((await liveImages(id)).map((image) => image.page)).toEqual([1]);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the same queue, for restore", () => {
  it("holds a replace behind a restore rather than racing it", async () => {
    const id = await createReceipt();
    expect((await deleteReceipt(id)).status).toBe(204);

    for (let round = 0; round < 10; round++) {
      const [restored, replaced] = await Promise.all([
        harness.request(token, "POST", `/api/receipts/${id}/restore`),
        replacePage(id),
      ]);

      expect(restored.status).toBe(200);
      // A replace that arrived before the restore committed saw a deleted
      // receipt, and one that arrived after replaced page 1 of a live one.
      expect([200, 404]).toContain(replaced.status);
      expect((await liveImages(id)).map((image) => image.page)).toEqual([1]);

      expect((await deleteReceipt(id)).status).toBe(204);
      expect(await liveImages(id)).toHaveLength(0);
    }
  }, 30_000);
});
