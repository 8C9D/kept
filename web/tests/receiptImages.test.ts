import { describe, expect, it } from "vitest";
import { ApiError, type KeptApi } from "../src/api.js";
import { sortedByPage, addReceiptPage, replaceReceiptPage } from "../src/receiptImages.js";

/**
 * Add-a-page / replace-a-page (proposal #6, 2026-08-28), pinned the same
 * way upload.test.ts pins the create path: the request sequence is
 * presign -> PUT -> tell the API, a failed PUT never reaches the API (the
 * one thing that stops recreating the §8 sharp edge this feature repairs),
 * and a 409 duplicate_image surfaces the server's own message rather than
 * invented wording.
 */

const IMAGE_BYTES = new TextEncoder().encode("fake bytes").buffer as ArrayBuffer;

const file = {
  name: "page-2.jpg",
  type: "image/jpeg",
  bytes: async () => IMAGE_BYTES,
};

const WRITE_RESULT = {
  id: "img-1",
  page: 2,
  downloadUrl: "https://storage.test/get",
  createdAt: "2026-08-28T00:00:00.000Z",
};

function fakeApi(overrides: {
  addReceiptImage?: (id: string, body: unknown) => Promise<typeof WRITE_RESULT>;
  replaceReceiptImage?: (
    id: string,
    page: number,
    body: unknown,
  ) => Promise<typeof WRITE_RESULT>;
  calls?: string[];
  seenBodies?: unknown[];
}): KeptApi {
  return {
    uploadUrl: async () => {
      overrides.calls?.push("uploadUrl");
      return {
        objectKey: "user-1/2026/08/def.jpg",
        uploadUrl: "https://storage.test/put",
      };
    },
    addReceiptImage: async (id: string, body: unknown) => {
      overrides.calls?.push("addReceiptImage");
      overrides.seenBodies?.push(body);
      if (overrides.addReceiptImage !== undefined) {
        return overrides.addReceiptImage(id, body);
      }
      return WRITE_RESULT;
    },
    replaceReceiptImage: async (id: string, page: number, body: unknown) => {
      overrides.calls?.push("replaceReceiptImage");
      overrides.seenBodies?.push(body);
      if (overrides.replaceReceiptImage !== undefined) {
        return overrides.replaceReceiptImage(id, page, body);
      }
      return { ...WRITE_RESULT, page };
    },
  } as unknown as KeptApi;
}

function stubFetch(status: number, calls?: string[]): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls?.push("PUT");
    return new Response(null, { status });
  };
  return () => {
    globalThis.fetch = original;
  };
}

describe("addReceiptPage", () => {
  it("presigns, PUTs, then calls the API with exactly {objectKey, sha256}", async () => {
    const calls: string[] = [];
    const seenBodies: unknown[] = [];
    const restore = stubFetch(200, calls);
    try {
      const outcome = await addReceiptPage(
        fakeApi({ calls, seenBodies }),
        "receipt-1",
        file,
      );
      expect(outcome).toEqual({ state: "ok" });
      expect(calls).toEqual(["uploadUrl", "PUT", "addReceiptImage"]);
      const body = seenBodies[0] as { objectKey: string; sha256: string };
      expect(Object.keys(body).sort()).toEqual(["objectKey", "sha256"]);
      expect(body.objectKey).toBe("user-1/2026/08/def.jpg");
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      restore();
    }
  });

  it("does not call the API when the storage PUT fails", async () => {
    const calls: string[] = [];
    const restore = stubFetch(403, calls);
    try {
      const outcome = await addReceiptPage(fakeApi({ calls }), "receipt-1", file);
      expect(outcome).toEqual({
        state: "failed",
        detail: "storage answered 403 to the upload",
      });
      // The one thing that prevents recreating the §8 sharp edge: bytes
      // that never landed must never be told to the API.
      expect(calls).toEqual(["uploadUrl", "PUT"]);
    } finally {
      restore();
    }
  });

  it("surfaces the server's own duplicate_image message, not invented wording", async () => {
    const restore = stubFetch(200);
    try {
      const outcome = await addReceiptPage(
        fakeApi({
          addReceiptImage: () => {
            throw new ApiError(
              409,
              "duplicate_image",
              "An identical image is already attached to one of your receipts",
            );
          },
        }),
        "receipt-1",
        file,
      );
      expect(outcome).toEqual({
        state: "duplicate",
        detail: "An identical image is already attached to one of your receipts",
      });
    } finally {
      restore();
    }
  });

  it("refuses an unsupported type before anything uploads", async () => {
    const calls: string[] = [];
    const outcome = await addReceiptPage(
      fakeApi({ calls }),
      "receipt-1",
      { name: "page.heic", type: "image/heic", bytes: async () => IMAGE_BYTES },
    );
    expect(outcome.state).toBe("unsupported");
    expect(calls).toEqual([]);
  });
});

describe("replaceReceiptPage", () => {
  it("presigns, PUTs, then calls the API with the page and exactly {objectKey, sha256}", async () => {
    const calls: string[] = [];
    const seenBodies: unknown[] = [];
    const restore = stubFetch(200, calls);
    try {
      const outcome = await replaceReceiptPage(
        fakeApi({ calls, seenBodies }),
        "receipt-1",
        2,
        file,
      );
      expect(outcome).toEqual({ state: "ok" });
      expect(calls).toEqual(["uploadUrl", "PUT", "replaceReceiptImage"]);
      const body = seenBodies[0] as { objectKey: string; sha256: string };
      expect(Object.keys(body).sort()).toEqual(["objectKey", "sha256"]);
    } finally {
      restore();
    }
  });

  it("does not call the API when the storage PUT fails", async () => {
    const calls: string[] = [];
    const restore = stubFetch(500, calls);
    try {
      const outcome = await replaceReceiptPage(
        fakeApi({ calls }),
        "receipt-1",
        1,
        file,
      );
      expect(outcome).toEqual({
        state: "failed",
        detail: "storage answered 500 to the upload",
      });
      expect(calls).toEqual(["uploadUrl", "PUT"]);
    } finally {
      restore();
    }
  });

  it("surfaces the server's own duplicate_image message on a replace too", async () => {
    const restore = stubFetch(200);
    try {
      const outcome = await replaceReceiptPage(
        fakeApi({
          replaceReceiptImage: () => {
            throw new ApiError(
              409,
              "duplicate_image",
              "An identical image is already attached to one of your receipts",
            );
          },
        }),
        "receipt-1",
        1,
        file,
      );
      expect(outcome).toEqual({
        state: "duplicate",
        detail: "An identical image is already attached to one of your receipts",
      });
    } finally {
      restore();
    }
  });
});

describe("sortedByPage", () => {
  it("orders pages ascending regardless of input order", () => {
    const images = [
      { page: 3, downloadUrl: "https://x/3" },
      { page: 1, downloadUrl: "https://x/1" },
      { page: 2, downloadUrl: "https://x/2" },
    ];
    expect(sortedByPage(images).map((i) => i.page)).toEqual([1, 2, 3]);
  });

  it("does not mutate the input array", () => {
    const images = [
      { page: 2, downloadUrl: "https://x/2" },
      { page: 1, downloadUrl: "https://x/1" },
    ];
    const original = [...images];
    sortedByPage(images);
    expect(images).toEqual(original);
  });
});
