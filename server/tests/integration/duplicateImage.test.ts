import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * `existingReceiptId` on a create's `duplicate_image`.
 *
 * The case it exists for: iOS loses a create's response, retries, and gets the
 * 409 - and with no id it cannot attach a multi-page capture's other pages, so
 * it blocks the item and asks a person to do it by hand
 * (OutboxController.swift). The id is new response data leaving this server on
 * a collision, which is why most of this file is about whose id it can be.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

const SHA = "ab".repeat(32);

interface DuplicateBody {
  error: { code: string; message: string; existingReceiptId?: string };
}

let mine: { token: string; userId: string };
let theirs: { token: string; userId: string };

beforeEach(async () => {
  await harness.resetDatabase();
  mine = await harness.signIn("duplicate-image-mine");
  theirs = await harness.signIn("duplicate-image-theirs");
});

async function create(
  owner: { token: string; userId: string },
  sha256: string = SHA,
): Promise<Response> {
  return harness.request(owner.token, "POST", "/api/receipts", {
    ...receiptBody(),
    image: imageFor(owner.userId, sha256),
  });
}

async function createdId(response: Response): Promise<string> {
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function expectDuplicate(response: Response): Promise<DuplicateBody> {
  expect(response.status).toBe(409);
  const body = (await response.json()) as DuplicateBody;
  expect(body.error.code).toBe("duplicate_image");
  return body;
}

describe("POST /api/receipts duplicate_image", () => {
  it("names the caller's own receipt that holds the digest", async () => {
    const id = await createdId(await create(mine));

    const body = await expectDuplicate(await create(mine));

    expect(body.error.existingReceiptId).toBe(id);
    // The fields every shipped client decodes are untouched.
    expect(body.error.message).toBe(
      "An identical image is already attached to one of your receipts",
    );
  });

  it("can never surface another user's receipt, even holding the same bytes", async () => {
    const theirId = await createdId(await create(theirs));
    // Same digest, different user: the index is per-user, so this is no
    // collision at all - not a 409 that happens to hide the id.
    const myId = await createdId(await create(mine));
    expect(myId).not.toBe(theirId);

    const mineAgain = await expectDuplicate(await create(mine));
    expect(mineAgain.error.existingReceiptId).toBe(myId);
    const theirsAgain = await expectDuplicate(await create(theirs));
    expect(theirsAgain.error.existingReceiptId).toBe(theirId);
  });

  it("names the live receipt, never a soft-deleted one that once held the digest", async () => {
    const deleted = await createdId(await create(mine));
    expect(
      (await harness.request(mine.token, "DELETE", `/api/receipts/${deleted}`))
        .status,
    ).toBe(204);
    const live = await createdId(await create(mine));

    const body = await expectDuplicate(await create(mine));

    expect(body.error.existingReceiptId).toBe(live);
  });

  it("names a receipt whose matching image is a later page", async () => {
    const id = await createdId(await create(mine, "cd".repeat(32)));
    const added = await harness.request(
      mine.token,
      "POST",
      `/api/receipts/${id}/images`,
      imageFor(mine.userId, SHA),
    );
    expect(added.status).toBe(201);

    const body = await expectDuplicate(await create(mine));

    expect(body.error.existingReceiptId).toBe(id);
  });

  it("cannot be used to overwrite code or message", async () => {
    // renderError spreads `extra` beneath them; a stray key must lose.
    const { ApiError, renderError } = await import("../../src/http/errors.js");
    const rendered = renderError(
      new ApiError(409, "real_code", "real message", {
        code: "spoofed",
        message: "spoofed",
        kept: true,
      }),
      { json: (body: unknown) => Response.json(body) } as never,
    );
    expect(await rendered.json()).toEqual({
      error: { code: "real_code", message: "real message", kept: true },
    });
  });
});

describe("the other duplicate_image routes keep their shape", () => {
  it("adds nothing to the add-page 409", async () => {
    await createdId(await create(mine));
    const other = await createdId(await create(mine, "cd".repeat(32)));

    const response = await harness.request(
      mine.token,
      "POST",
      `/api/receipts/${other}/images`,
      imageFor(mine.userId, SHA),
    );

    const body = await expectDuplicate(response);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
  });

  it("adds nothing to the replace-page 409", async () => {
    await createdId(await create(mine));
    const other = await createdId(await create(mine, "cd".repeat(32)));

    const response = await harness.request(
      mine.token,
      "PUT",
      `/api/receipts/${other}/images/1`,
      imageFor(mine.userId, SHA),
    );

    const body = await expectDuplicate(response);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
  });
});
