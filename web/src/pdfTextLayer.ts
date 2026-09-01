import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  assembleDocumentText,
  type PdfExtractedText,
  type PdfTextItem,
} from "./pdfText.js";

/**
 * The pdf.js half of the PDF text extraction (2026-09-01) - loading a
 * document and asking each page for its text content. Every rule about what
 * a ROW is lives in `pdfText.ts`, which is pure and knows nothing about
 * pdf.js; this file is the thin wrapper that feeds it.
 *
 * ⚠ Import this module only through a dynamic `import()` (see
 * `upload.ts`'s `extractPdfTextLazily`). It is the one heavyweight
 * dependency in this client - roughly a third of a megabyte gzipped, worker
 * included - and a person uploading photographs must never download it.
 * Vite splits it into its own chunk on the strength of that dynamic import;
 * a static import anywhere would fold it back into the entry bundle.
 *
 * The worker is a same-origin asset URL, which is what keeps this inside
 * the shipped CSP (`public/_headers`: `default-src 'self'`, which
 * `worker-src` falls back to). pdf.js only wraps a worker in a blob: URL
 * when `workerSrc` is CROSS-origin - it is not here, so nothing needs a
 * blob: grant. `?url` makes Vite emit the worker as its own hashed asset
 * and hand back its path, rather than inlining or bundling it.
 */
GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Every page's text, assembled into printed rows. Returns an empty
 * `text` (and zero `lines`) for a PDF with no text layer - a scanned
 * receipt emailed as a PDF - which the caller reports as such rather than
 * pretending an empty document was read. Throws whatever pdf.js throws for
 * a file it cannot open at all (a corrupt or password-protected PDF); the
 * caller decides what that means for the upload, and deliberately does not
 * swallow it.
 */
export async function extractPdfText(
  bytes: ArrayBuffer,
): Promise<PdfExtractedText> {
  // A copy, not the caller's buffer: pdf.js transfers what it is given to
  // the worker, which DETACHES the original. The same bytes are also the
  // ones that were PUT to storage, and a detached ArrayBuffer read later
  // would be an empty one - a bug that would show up as a zero-byte image
  // rather than as an extraction failure.
  const loading = getDocument({
    data: new Uint8Array(bytes.slice(0)),
    // Nothing here renders a page, so nothing needs a font face installed
    // in the document. Off by default in this configuration, stated
    // explicitly so a future change to the shipped CSP's `font-src` cannot
    // silently start mattering to an upload.
    disableFontFace: true,
  });
  const document = await loading.promise;
  try {
    const pages: PdfTextItem[][] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      // `getTextContent()` interleaves text items with marked-content
      // markers (structure tags, which carry no text); only the former has
      // a `str`. Copied into this client's own `PdfTextItem` rather than
      // passed through, so `pdfText.ts` depends on a shape THIS repo
      // declares - pdf.js is an implementation detail of one file, not of
      // the row rules.
      pages.push(
        content.items.flatMap((item) =>
          "str" in item
            ? [
                {
                  str: item.str,
                  transform: item.transform,
                  height: item.height,
                  width: item.width,
                },
              ]
            : [],
        ),
      );
      // Releases the page's own parsed objects as the loop walks a long
      // document; the whole document is destroyed below regardless.
      page.cleanup();
    }
    return assembleDocumentText(pages);
  } finally {
    // Terminates the worker. Without this every dropped PDF would leave one
    // running for the life of the tab, and a backlog drop is dozens of
    // files in a row.
    await loading.destroy();
  }
}
