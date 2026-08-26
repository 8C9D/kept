import { describe, expect, it } from "vitest";
import { ApiError, type KeptApi } from "../src/api.js";
import {
  isoDateToday,
  sha256Hex,
  supportedContentType,
  uploadOne,
} from "../src/upload.js";

/**
 * The backlog upload path's decisions, pinned: a duplicate 409 is reported
 * as a duplicate (round 4 §2.2's forward constraint - the web client must
 * NOT inherit the iOS outbox's 409-as-saved), an unsupported type never
 * starts an upload, and the create carries the digest of what was actually
 * PUT.
 */

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 fake").buffer as ArrayBuffer;

function fakeApi(overrides: {
  createReceipt?: (body: unknown) => Promise<{ id: string }>;
  putStatus?: number;
  seenBodies?: unknown[];
}): KeptApi {
  return {
    uploadUrl: async () => ({
      objectKey: "user-1/2026/08/abc.pdf",
      uploadUrl: "https://storage.test/put",
    }),
    createReceipt: async (body: unknown) => {
      overrides.seenBodies?.push(body);
      if (overrides.createReceipt !== undefined) {
        return overrides.createReceipt(body);
      }
      return { id: "receipt-1" };
    },
  } as unknown as KeptApi;
}

function stubFetch(status: number): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status });
  return () => {
    globalThis.fetch = original;
  };
}

describe("supportedContentType", () => {
  it("accepts exactly the three types the upload-url route signs", () => {
    expect(supportedContentType("image/jpeg")).toBe("image/jpeg");
    expect(supportedContentType("image/png")).toBe("image/png");
    expect(supportedContentType("application/pdf")).toBe("application/pdf");
    expect(supportedContentType("image/heic")).toBeNull();
    expect(supportedContentType("")).toBeNull();
  });
});

describe("isoDateToday", () => {
  it("renders local yyyy-mm-dd with padding", () => {
    expect(isoDateToday(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(isoDateToday(new Date(2026, 11, 31))).toBe("2026-12-31");
  });
});

describe("uploadOne", () => {
  const file = {
    name: "receipt.pdf",
    type: "application/pdf",
    bytes: async () => PDF_BYTES,
  };

  it("creates a pending receipt carrying the digest of the uploaded bytes", async () => {
    const seenBodies: unknown[] = [];
    const restore = stubFetch(200);
    try {
      const outcome = await uploadOne(
        fakeApi({ seenBodies }),
        file,
        new Date(2026, 7, 21, 12, 0, 0),
      );
      expect(outcome).toEqual({ state: "created", receiptId: "receipt-1" });
      const body = seenBodies[0] as {
        purchasedAt: string;
        capturedAt: string;
        image: { sha256: string };
      };
      expect(body.purchasedAt).toBe("2026-08-21");
      expect(body.image.sha256).toBe(await sha256Hex(PDF_BYTES));
      // Nothing is asked before the drop any more: the create carries the
      // dates and the image, and no business-or-personal choice exists.
      expect(Object.keys(body).sort()).toEqual([
        "capturedAt",
        "image",
        "purchasedAt",
      ]);
    } finally {
      restore();
    }
  });

  it("reports the server's duplicate_image 409 as a duplicate, never as saved", async () => {
    const restore = stubFetch(200);
    try {
      const outcome = await uploadOne(
        fakeApi({
          createReceipt: () => {
            throw new ApiError(
              409,
              "duplicate_image",
              "An identical image is already attached to one of your receipts",
            );
          },
        }),
        file,
        new Date(),
      );
      expect(outcome).toEqual({ state: "duplicate" });
    } finally {
      restore();
    }
  });

  it("refuses an unsupported type before anything uploads", async () => {
    const outcome = await uploadOne(
      fakeApi({}),
      { name: "receipt.heic", type: "image/heic", bytes: async () => PDF_BYTES },
      new Date(),
    );
    expect(outcome.state).toBe("unsupported");
  });

  it("reports a storage refusal as a failure naming the status", async () => {
    const restore = stubFetch(403);
    try {
      const outcome = await uploadOne(fakeApi({}), file, new Date());
      expect(outcome).toEqual({
        state: "failed",
        detail: "storage answered 403 to the upload",
      });
    } finally {
      restore();
    }
  });
});
