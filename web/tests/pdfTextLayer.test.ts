import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * pdf.js itself is not under test, and its worker cannot run here. What is
 * under test is this file's one lifecycle promise: every loading task ends
 * in `destroy()`, including the one pdf.js could not open.
 */
const getDocument = vi.fn();
vi.mock("pdfjs-dist", () => ({
  getDocument,
  GlobalWorkerOptions: { workerSrc: "" },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "worker.js" }));

const { extractPdfText } = await import("../src/pdfTextLayer.js");

afterEach(() => {
  getDocument.mockReset();
});

function loadingTask(promise: Promise<unknown>) {
  const destroy = vi.fn(async () => undefined);
  getDocument.mockReturnValue({ promise, destroy });
  return destroy;
}

describe("extractPdfText - one worker per file, always released", () => {
  it("destroys the task when the PDF cannot be opened at all", async () => {
    // The leak: the rejecting await sat above the `try`, so a corrupt or
    // password-protected file never reached `destroy()` - one worker for the
    // life of the tab per bad file, in a backlog of dozens.
    const destroy = loadingTask(Promise.reject(new Error("PasswordException")));
    await expect(extractPdfText(new ArrayBuffer(4))).rejects.toThrow(
      "PasswordException",
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the task when a page fails partway through", async () => {
    const destroy = loadingTask(
      Promise.resolve({
        numPages: 1,
        getPage: async () => {
          throw new Error("bad page");
        },
      }),
    );
    await expect(extractPdfText(new ArrayBuffer(4))).rejects.toThrow("bad page");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys the task after a good read too", async () => {
    const destroy = loadingTask(Promise.resolve({ numPages: 0 }));
    await extractPdfText(new ArrayBuffer(4));
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
