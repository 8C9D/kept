import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJobs, receiptImages } from "../../src/db/schema.js";
import { generateExport } from "../../src/export/generateExport.js";
import {
  EXPORTS_PREFIX,
  receiptImageObjectKey,
} from "../../src/storage/objectKeys.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

interface JobResponse {
  id: string;
  status: "queued" | "running" | "complete" | "failed";
  periodStart: string;
  periodEnd: string;
  error: string | null;
  downloadUrl: string | null;
}

/** Poll the job until it settles; the suite must never hang on a dead job. */
async function pollUntilSettled(
  token: string,
  jobId: string,
): Promise<JobResponse> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await harness.request(
      token,
      "GET",
      `/api/export/${jobId}`,
    );
    expect(response.status).toBe(200);
    const job = (await response.json()) as JobResponse;
    if (job.status === "complete" || job.status === "failed") {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Export job ${jobId} never settled`);
}

/** Create a receipt whose image bytes actually exist in fake storage. */
async function createReceiptWithImage(
  token: string,
  userId: string,
  sha: string,
  fields: Record<string, unknown>,
): Promise<{ id: string }> {
  const objectKey = imageFor(userId, sha).objectKey;
  await harness.storage.upload(
    objectKey,
    new TextEncoder().encode(`synthetic image bytes ${sha}`),
    "image/jpeg",
  );
  const response = await harness.request(token, "POST", "/api/receipts", {
    ...receiptBody(fields),
    image: { objectKey, sha256: sha },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

describe("the export pipeline", () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token, userId } = await harness.signIn("export-owner", "Synthetic User A"));
  });

  it("produces a zip whose spreadsheet rows click through to their images", async () => {
    const included = await createReceiptWithImage(token, userId, "a1".repeat(32), {
      purchasedAt: "2026-01-14",
      vendor: "Café Dépôt",
      subtotalCents: 10000,
      hstCents: 1300,
      tipCents: 2000,
      otherFeesCents: 500,
      totalCents: 11300,
      category: "office supplies",
      paymentMethod: "visa",
      status: "confirmed",
    });
    const nullFields = await createReceiptWithImage(token, userId, "a2".repeat(32), {
      purchasedAt: "2026-02-20",
      vendor: null,
      subtotalCents: null,
      hstCents: null,
      totalCents: 4200,
      status: "confirmed",
    });
    // Excluded rows: pending, soft-deleted, out of period, other user.
    await createReceiptWithImage(token, userId, "a3".repeat(32), {
      vendor: "Pending Vendor",
      status: "pending",
    });
    const deleted = await createReceiptWithImage(token, userId, "a4".repeat(32), {
      vendor: "Deleted Vendor",
      status: "confirmed",
    });
    await harness.request(token, "DELETE", `/api/receipts/${deleted.id}`);
    await createReceiptWithImage(token, userId, "a5".repeat(32), {
      vendor: "Out Of Period",
      purchasedAt: "2025-06-01",
      status: "confirmed",
    });
    const other = await harness.signIn("export-other");
    await createReceiptWithImage(other.token, other.userId, "a6".repeat(32), {
      vendor: "Someone Else",
      status: "confirmed",
    });

    const started = await harness.request(token, "POST", "/api/export", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    expect(started.status).toBe(202);
    const { id: jobId } = (await started.json()) as JobResponse;

    const job = await pollUntilSettled(token, jobId);
    expect(job.error).toBeNull();
    expect(job.status).toBe("complete");
    expect(job.downloadUrl).not.toBeNull();

    // The zip the download URL points at, fetched from storage directly.
    const zipKey = decodeURIComponent(
      (job.downloadUrl as string).replace("https://fake-r2.test/download/", ""),
    );
    expect(zipKey).toBe(`exports/${userId}/${jobId}/Receipts-2026.zip`);
    // The property behind the layout, not just the string: §10B's 30-day
    // expiry is a bucket lifecycle rule, and those match a literal prefix.
    // Every user's zips must sit under one, and no receipt image may.
    expect(zipKey.startsWith(EXPORTS_PREFIX)).toBe(true);
    expect(receiptImageObjectKey(userId, new Date(), randomUUID(), "image/jpeg")
      .startsWith(EXPORTS_PREFIX)).toBe(false);
    const zip = new AdmZip(Buffer.from(await harness.storage.download(zipKey)));
    const entryNames = zip.getEntries().map((entry) => entry.entryName);
    expect(entryNames).toContain("receipts-2026.xlsx");
    expect(entryNames).toContain("receipts-2026.csv");
    expect(entryNames).toContain("receipts-2026.json");

    // CSV: exact header, only the two confirmed in-period rows, money as
    // decimal strings, nulls as empty cells.
    const csv = zip.readAsText("receipts-2026.csv");
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "receipt_id,date,vendor,subtotal,hst,tip,other_fees,total,currency,category,payment_method,whose,image_filename,pages,notes",
    );
    expect(lines).toHaveLength(3); // header + 2 rows
    const includedLine = lines.find((line) => line.startsWith(included.id));
    expect(includedLine).toBeDefined();
    expect(includedLine).toContain("Café Dépôt");
    expect(includedLine).toContain("100.00,13.00,20.00,5.00,113.00,CAD");
    expect(includedLine).toContain("visa,Synthetic User A,images/2026/01/");
    // Single-page receipt: pages reads 1, right after image_filename.
    expect(includedLine).toMatch(/\.jpg,1,$/);
    const nullLine = lines.find((line) => line.startsWith(nullFields.id));
    // vendor, subtotal, hst empty; tip and other_fees also empty (never set
    // on this fixture) - five empty cells before the total.
    expect(nullLine).toContain(",,,,,42.00,CAD");
    expect(nullLine).toContain("unknown-vendor");
    expect(nullLine).toMatch(/\.jpg,1,$/);
    expect(csv).not.toContain("Pending Vendor");
    expect(csv).not.toContain("Deleted Vendor");
    expect(csv).not.toContain("Out Of Period");
    expect(csv).not.toContain("Someone Else");

    // JSON: the same rows again, keyed by the same columns. Money stays a
    // decimal string so nothing downstream turns integer cents into a
    // float; an absent value is null rather than an empty string, which is
    // the one thing this encoding can say that the CSV cannot.
    const json = JSON.parse(zip.readAsText("receipts-2026.json")) as Record<
      string,
      unknown
    >[];
    expect(json).toHaveLength(2);
    expect(Object.keys(json[0] ?? {})).toEqual(lines[0]?.split(","));
    const includedJson = json.find((r) => r.receipt_id === included.id);
    expect(includedJson).toMatchObject({
      date: "2026-01-14",
      vendor: "Café Dépôt",
      subtotal: "100.00",
      hst: "13.00",
      tip: "20.00",
      other_fees: "5.00",
      total: "113.00",
      currency: "CAD",
      category: "office supplies",
      payment_method: "visa",
      whose: "Synthetic User A",
      pages: "1", // a digit string, matching the CSV's own rendering
      notes: null,
    });
    const nullJson = json.find((r) => r.receipt_id === nullFields.id);
    expect(nullJson).toMatchObject({
      vendor: null,
      subtotal: null,
      hst: null,
      tip: null,
      other_fees: null,
      total: "42.00",
      pages: "1",
    });
    // The retired columns are gone from every encoding, not blanked.
    for (const retired of [
      "vendor_gst_hst_number",
      "other_tax",
      "business_or_personal",
    ]) {
      expect(lines[0]).not.toContain(retired);
      expect(Object.keys(json[0] ?? {})).not.toContain(retired);
    }

    // XLSX: same headers, numeric money with a two-decimal format.
    const workbook = new ExcelJS.Workbook();
    const xlsxEntry = zip.readFile("receipts-2026.xlsx");
    expect(xlsxEntry).not.toBeNull();
    // exceljs's typings predate Node's generic Buffer type; the runtime
    // accepts any Buffer, so the cast bridges the declaration gap only.
    await workbook.xlsx.load(
      Buffer.from(xlsxEntry as Uint8Array) as unknown as Parameters<
        typeof workbook.xlsx.load
      >[0],
    );
    const sheet = workbook.getWorksheet("Receipts");
    expect(sheet).toBeDefined();
    const headerValues = (sheet?.getRow(1).values as unknown[]).slice(1);
    expect(headerValues).toEqual(lines[0]?.split(","));
    const firstDataRow = sheet?.getRow(2);
    expect(firstDataRow?.getCell(8).value).toBe(113); // total, numeric
    expect(firstDataRow?.getCell(8).numFmt).toBe("0.00");
    expect(firstDataRow?.getCell(6).value).toBe(20); // tip, numeric
    expect(firstDataRow?.getCell(7).value).toBe(5); // other_fees, numeric
    expect(firstDataRow?.getCell(14).value).toBe(1); // pages, numeric, single page
    expect(firstDataRow?.getCell(14).numFmt).not.toBe("0.00");

    // Every image_filename cell resolves to a real entry in images/, and
    // the bytes are the ones uploaded for that receipt.
    for (const line of lines.slice(1)) {
      const imageFilename = line?.split(",").find((field) =>
        field.startsWith("images/"),
      );
      expect(imageFilename).toBeDefined();
      const entry = zip.getEntry(imageFilename as string);
      expect(entry).not.toBeNull();
    }
    const includedImage = includedLine
      ?.split(",")
      .find((field) => field.startsWith("images/"));
    const imageBytes = zip.readFile(includedImage as string);
    expect(new TextDecoder().decode(imageBytes as Buffer)).toBe(
      `synthetic image bytes ${"a1".repeat(32)}`,
    );
  });

  /**
   * Proposal #6 (2026-08-28): "a multi-page receipt whose page 2 never
   * reaches the accountant is worse than no multi-page support at all."
   * Every live page must be a real file in the zip, image_filename must
   * keep naming page 1 unsuffixed, and pages must read the true count.
   */
  it("bundles every page of a multi-page receipt, naming page 1 unsuffixed and every later page with a _p{n} suffix", async () => {
    const receipt = await createReceiptWithImage(
      token,
      userId,
      "e1".repeat(32),
      {
        purchasedAt: "2026-04-02",
        vendor: "Hotel Foo",
        totalCents: 30000,
        status: "confirmed",
      },
    );

    // Add pages 2 and 3 through the real route under test, uploading real
    // bytes for each so the zip has something genuine to bundle.
    for (const sha of ["e2".repeat(32), "e3".repeat(32)]) {
      const objectKey = imageFor(userId, sha).objectKey;
      await harness.storage.upload(
        objectKey,
        new TextEncoder().encode(`synthetic image bytes ${sha}`),
        "image/jpeg",
      );
      const added = await harness.request(
        token,
        "POST",
        `/api/receipts/${receipt.id}/images`,
        { objectKey, sha256: sha },
      );
      expect(added.status).toBe(201);
    }

    const started = await harness.request(token, "POST", "/api/export", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    const { id: jobId } = (await started.json()) as JobResponse;
    const job = await pollUntilSettled(token, jobId);
    expect(job.status).toBe("complete");
    expect(job.error).toBeNull();

    const zipKey = decodeURIComponent(
      (job.downloadUrl as string).replace("https://fake-r2.test/download/", ""),
    );
    const zip = new AdmZip(Buffer.from(await harness.storage.download(zipKey)));
    const entryNames = zip.getEntries().map((entry) => entry.entryName);

    const page1 = "images/2026/04/2026-04-02_Hotel-Foo_" +
      receipt.id.replaceAll("-", "").slice(0, 8) + ".jpg";
    const page2 = "images/2026/04/2026-04-02_Hotel-Foo_" +
      receipt.id.replaceAll("-", "").slice(0, 8) + "_p2.jpg";
    const page3 = "images/2026/04/2026-04-02_Hotel-Foo_" +
      receipt.id.replaceAll("-", "").slice(0, 8) + "_p3.jpg";
    expect(entryNames).toContain(page1);
    expect(entryNames).toContain(page2);
    expect(entryNames).toContain(page3);

    expect(
      new TextDecoder().decode(zip.readFile(page1) as Buffer),
    ).toBe(`synthetic image bytes ${"e1".repeat(32)}`);
    expect(
      new TextDecoder().decode(zip.readFile(page2) as Buffer),
    ).toBe(`synthetic image bytes ${"e2".repeat(32)}`);
    expect(
      new TextDecoder().decode(zip.readFile(page3) as Buffer),
    ).toBe(`synthetic image bytes ${"e3".repeat(32)}`);

    // One spreadsheet row for the receipt, not three - image_filename still
    // names page 1 only, and pages carries the true count.
    const csv = zip.readAsText("receipts-2026.csv");
    const lines = csv.trimEnd().split("\r\n");
    const row = lines.find((line) => line.startsWith(receipt.id));
    expect(row).toBeDefined();
    expect(row).toContain(page1);
    expect(row).not.toContain(page2);
    expect(row).not.toContain(page3);
    expect(row).toMatch(new RegExp(`${page1.replace(/\//g, "\\/").replace(/\./g, "\\.")},3,$`));

    const json = JSON.parse(zip.readAsText("receipts-2026.json")) as Record<
      string,
      unknown
    >[];
    const jsonRow = json.find((r) => r.receipt_id === receipt.id);
    expect(jsonRow).toMatchObject({ image_filename: page1, pages: "3" });
  });

  it("derives the period from the user's fiscal year settings", async () => {
    await harness.request(token, "PATCH", "/api/me", {
      fiscalYearEndMonth: 3,
      fiscalYearEndDay: 31,
    });
    const started = await harness.request(token, "POST", "/api/export", {
      fiscalYearEndingIn: 2026,
    });
    expect(started.status).toBe(202);
    const job = (await started.json()) as JobResponse;
    expect(job.periodStart).toBe("2025-04-01");
    expect(job.periodEnd).toBe("2026-03-31");

    const settled = await pollUntilSettled(token, job.id);
    expect(settled.status).toBe("complete");
    // Not a calendar year, so the label names the range honestly.
    expect(settled.downloadUrl).toContain(
      "Receipts-2025-04-01_to_2026-03-31.zip",
    );
  });

  it("records a loud failure when an image is missing from storage, naming the receipt and page that caused it", async () => {
    // Created via the API but its bytes never uploaded: generation must
    // fail and say why, not ship a zip with a broken click-through.
    //
    // The reachable trigger is not a hostile user. It is a presigned PUT
    // that failed or was interrupted, followed by a create the client still
    // sent - the create route validates the key's shape, never its
    // existence. One such row jams every export of its period, so the
    // message has to be enough to find and fix the row: the storage layer's
    // own answer ("No such object" / R2's `NoSuchKey`) names no receipt, no
    // vendor and no date, and leaves the person stuck.
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ status: "confirmed", purchasedAt: "2026-03-15" }),
      image: imageFor(userId, "b1".repeat(32)),
    });
    expect(response.status).toBe(201);
    const { id: receiptId } = (await response.json()) as { id: string };

    const started = await harness.request(token, "POST", "/api/export", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    const { id: jobId } = (await started.json()) as JobResponse;
    const job = await pollUntilSettled(token, jobId);

    expect(job.status).toBe("failed");
    expect(job.downloadUrl).toBeNull();
    // The row is findable, and now so is the page...
    expect(job.error).toContain(receiptId);
    expect(job.error).toMatch(/page 1/);
    // ...and it leads with the REPAIR (proposal #6, 2026-08-28:
    // PUT /api/receipts/:id/images/:page can now replace just this page's
    // bytes), which did not exist when this message was first written and
    // is why "delete and recapture" used to be the only remedy at all.
    expect(job.error).toMatch(/replace/i);
    const replaceAt = job.error?.search(/replace/i) ?? -1;
    const deleteIt = job.error?.indexOf("If the paper is gone") ?? -1;
    expect(replaceAt).toBeGreaterThan(-1);
    expect(deleteIt).toBeGreaterThan(replaceAt);
    // Losing nothing is stated explicitly, and it is what makes replace the
    // better option than the old delete-and-recapture path.
    expect(job.error).toMatch(
      /without losing the receipt's vendor, date, total or HST/,
    );
    // Deleting and recapturing is still named, second, as the fallback for
    // someone who would rather start over or whose paper is gone - with its
    // cost attached rather than erased.
    expect(job.error).toMatch(/delete the receipt and capture it again/);
    expect(job.error).toMatch(/let\s+the export run without it/);
    // The storage layer's own text does not reach the export screen. Asserted
    // against the object key rather than the fake's wording: the key is what
    // the real client's failure could carry, and it is a user id plus a path.
    expect(job.error).not.toContain(userId);
    expect(job.error).not.toMatch(/\.jpg/);
    // No receipt field beyond the id and page: this string is also logged,
    // and the §10B invariant is that server logs carry no receipt contents.
    expect(job.error).not.toContain("2026-03-15");
    expect(job.error).not.toContain("Test Vendor");
  });

  it("reports storage being unreachable as that, not as a missing photo", async () => {
    // The dangerous conflation: a timeout, a refused credential or an R2
    // outage described as "this receipt's photo never uploaded" tells the
    // person to delete a receipt over a transient failure. On a project
    // whose top severity is a lost receipt, that is the worst available
    // trade, so only a genuinely absent object gets the missing-photo text.
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ status: "confirmed" }),
      image: imageFor(userId, "b2".repeat(32)),
    });
    expect(response.status).toBe(201);

    // No bytes are planted: the stub below replaces `download` outright, so
    // whether the object exists is irrelevant to what this test asserts.
    // (An earlier draft planted them under a comment claiming it mattered;
    // deleting that block changed nothing, which is how it was caught.)
    const originalDownload = harness.storage.download;
    harness.storage.download = async () => {
      const error = new Error("connect ETIMEDOUT 1.2.3.4:443");
      error.name = "TimeoutError";
      throw error;
    };
    try {
      const started = await harness.request(token, "POST", "/api/export", {
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
      });
      const { id: jobId } = (await started.json()) as JobResponse;
      const job = await pollUntilSettled(token, jobId);

      expect(job.status).toBe("failed");
      expect(job.error).toContain("ETIMEDOUT");
      // Not described as a data problem, and not telling anyone to delete.
      expect(job.error).not.toMatch(/never finished uploading/);
      expect(job.error).not.toMatch(/delete/i);
    } finally {
      harness.storage.download = originalDownload;
    }
  });

  it("hides other users' export jobs behind 404", async () => {
    const started = await harness.request(token, "POST", "/api/export", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    const { id: jobId } = (await started.json()) as JobResponse;
    await pollUntilSettled(token, jobId);

    const other = await harness.signIn("export-snoop");
    const response = await harness.request(
      other.token,
      "GET",
      `/api/export/${jobId}`,
    );
    expect(response.status).toBe(404);
  });

  /**
   * One export at a time per user, because an export at the budget peaks
   * near 890 MB RSS and the origin is provisioned at a fixed 2 GB - two at
   * once does not fit. The live job is inserted directly rather than
   * started through the API: a real one can finish in milliseconds here,
   * which would make the assertion race.
   */
  describe("one live export per user", () => {
    async function insertJob(
      owner: string,
      status: "queued" | "running" | "complete",
      createdAt: Date,
    ) {
      const [job] = await harness.db
        .insert(exportJobs)
        .values({
          userId: owner,
          status,
          periodStart: "2026-01-01",
          periodEnd: "2026-12-31",
          createdAt,
        })
        .returning();
      return job;
    }

    function startExport() {
      return harness.request(token, "POST", "/api/export", {
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
      });
    }

    it("refuses a second export while one is running, with a reason", async () => {
      await insertJob(userId, "running", new Date());

      const response = await startExport();

      expect(response.status).toBe(409);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("export_already_running");
      expect(body.error.message).toMatch(/already running/i);
    });

    it("refuses a second export while one is still queued", async () => {
      await insertJob(userId, "queued", new Date());
      expect((await startExport()).status).toBe(409);
    });

    /**
     * The over-blocking direction. A constraint that also refused exports
     * after a finished one would be worse than the problem it solves.
     */
    it("accepts a new export once the previous one has finished", async () => {
      await insertJob(userId, "complete", new Date());
      expect((await startExport()).status).toBe(202);
    });

    it("never lets one user's export block another's", async () => {
      const other = await harness.signIn("export-other");
      await insertJob(other.userId, "running", new Date());

      expect((await startExport()).status).toBe(202);
    });

    /**
     * The lockout this index would otherwise create. A process that dies
     * mid-run leaves its row 'running' forever, and the stored status is
     * what the index reads - so without the reap, one crash would end that
     * user's ability to export, permanently and silently.
     */
    it("is not blocked forever by a job whose process died", async () => {
      const abandoned = await insertJob(
        userId,
        "running",
        new Date(Date.now() - 31 * 60 * 1000),
      );

      expect((await startExport()).status).toBe(202);

      const [reaped] = await harness.db
        .select()
        .from(exportJobs)
        .where(eq(exportJobs.id, abandoned!.id));
      expect(reaped!.status).toBe("failed");
      expect(reaped!.error).toMatch(/stopped before it finished/i);
      expect(reaped!.completedAt).not.toBeNull();
    });

    it("does not retire a job that is merely slow", async () => {
      // Inside the 30-minute running window: still live, still blocking.
      await insertJob(userId, "running", new Date(Date.now() - 5 * 60 * 1000));
      expect((await startExport()).status).toBe(409);
    });
  });

  it("rejects a period with start after end", async () => {
    const response = await harness.request(token, "POST", "/api/export", {
      periodStart: "2026-12-31",
      periodEnd: "2026-01-01",
    });
    expect(response.status).toBe(400);
  });

  it("refuses an export over the size budget with an actionable reason", async () => {
    await createReceiptWithImage(token, userId, "d1".repeat(32), {
      status: "confirmed",
    });
    const period = { start: "2026-01-01", end: "2026-12-31" };
    await expect(
      generateExport(
        { db: harness.db, storage: harness.storage },
        { jobId: "11111111-2222-3333-4444-555555555555", userId, period },
        { maxTotalBytes: 10 },
      ),
    ).rejects.toThrow(/size limit.*shorter period/);
  });

  /**
   * The export is the second place a stored key is dereferenced, and the
   * worse of the two to get wrong: a receipt detail leaks a URL, a zip
   * leaks the bytes themselves into a file that leaves the building. Same
   * hand-edited row as the isolation suite's read-time test, because no API
   * route can produce this state.
   */
  it("refuses to bundle an image whose stored key names another owner", async () => {
    const receipt = await createReceiptWithImage(token, userId, "d2".repeat(32), {
      status: "confirmed",
    });
    const foreignKey = `00000000-0000-4000-8000-000000000000/2026/01/${randomUUID()}.jpg`;
    await harness.db
      .update(receiptImages)
      .set({ objectKey: foreignKey })
      .where(eq(receiptImages.receiptId, receipt.id));

    await expect(
      generateExport(
        { db: harness.db, storage: harness.storage },
        {
          jobId: "99999999-8888-7777-6666-555555555555",
          userId,
          period: { start: "2026-01-01", end: "2026-12-31" },
        },
      ),
    ).rejects.toThrow(/does not match the shape issued/);
  });

  it("reports a completed job past the storage lifecycle as expired and re-runnable", async () => {
    await createReceiptWithImage(token, userId, "d3".repeat(32), {
      status: "confirmed",
    });
    const started = await harness.request(token, "POST", "/api/export", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    const { id: jobId } = (await started.json()) as JobResponse;
    const done = await pollUntilSettled(token, jobId);
    expect(done.status).toBe("complete");

    // Age the job past the 30-day download lifetime.
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await harness.db
      .update(exportJobs)
      .set({ completedAt: thirtyOneDaysAgo })
      .where(eq(exportJobs.id, jobId));

    const response = await harness.request(token, "GET", `/api/export/${jobId}`);
    const job = (await response.json()) as JobResponse;
    expect(job.status).toBe("expired");
    expect(job.downloadUrl).toBeNull();
    // The period survives, so the client can re-run it directly.
    expect(job.periodStart).toBe("2026-01-01");
    expect(job.periodEnd).toBe("2026-12-31");
  });

  it("reports a job stranded in queued as stale so clients stop polling", async () => {
    // A row inserted directly, never picked up - the crashed-before-claim
    // case. Its createdAt is aged past the stale threshold.
    const sixMinutesAgo = new Date(Date.now() - 6 * 60 * 1000);
    const inserted = await harness.db
      .insert(exportJobs)
      .values({
        userId,
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        createdAt: sixMinutesAgo,
      })
      .returning({ id: exportJobs.id });
    const jobId = inserted[0]?.id as string;

    const response = await harness.request(token, "GET", `/api/export/${jobId}`);
    const job = (await response.json()) as JobResponse;
    expect(job.status).toBe("stale");
    expect(job.downloadUrl).toBeNull();
  });

  it("reports a job stranded in running as stale on a longer clock", async () => {
    // The crashed-mid-run case: claimed but never finished. Thirty-one
    // minutes old is past the running threshold; a fresh running job is not.
    //
    // The two jobs belong to two users because one live export per user is
    // now a database constraint, so a single user cannot hold both. Both
    // assertions survive the move - the clock that reportedStatus applies
    // depends on the job's age and status, not on who owns it - and the
    // pair still has to be compared, since a rule that called every
    // running job stale would satisfy the first assertion alone.
    const stranded = await harness.db
      .insert(exportJobs)
      .values({
        userId,
        status: "running",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        createdAt: new Date(Date.now() - 31 * 60 * 1000),
      })
      .returning({ id: exportJobs.id });
    const second = await harness.signIn("export-fresh-runner");
    const fresh = await harness.db
      .insert(exportJobs)
      .values({
        userId: second.userId,
        status: "running",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        createdAt: new Date(Date.now() - 6 * 60 * 1000), // past queued's 5 min, under running's 30
      })
      .returning({ id: exportJobs.id });

    const strandedResponse = await harness.request(
      token,
      "GET",
      `/api/export/${stranded[0]?.id}`,
    );
    expect(((await strandedResponse.json()) as JobResponse).status).toBe(
      "stale",
    );

    const freshResponse = await harness.request(
      second.token,
      "GET",
      `/api/export/${fresh[0]?.id}`,
    );
    expect(((await freshResponse.json()) as JobResponse).status).toBe(
      "running",
    );
  });

  it("lists the caller's own jobs, newest first, and nobody else's", async () => {
    for (const period of ["2024", "2025"]) {
      const response = await harness.request(token, "POST", "/api/export", {
        periodStart: `${period}-01-01`,
        periodEnd: `${period}-12-31`,
      });
      const { id } = (await response.json()) as JobResponse;
      await pollUntilSettled(token, id);
    }
    const other = await harness.signIn("export-lister");
    const otherStarted = await harness.request(other.token, "POST", "/api/export", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    await pollUntilSettled(
      other.token,
      ((await otherStarted.json()) as JobResponse).id,
    );

    const response = await harness.request(token, "GET", "/api/export");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: JobResponse[] };
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs.map((job) => job.periodStart)).toEqual([
      "2025-01-01",
      "2024-01-01",
    ]);
    for (const job of body.jobs) {
      expect(job.status).toBe("complete");
      expect(job.downloadUrl).not.toBeNull();
    }
  });

  it("refuses to presign an export key naming another user's prefix", async () => {
    // PR-4, and an unfulfilled 2026-08-06 ruling: "stored object keys are
    // re-validated on read, in both places one is dereferenced". There are
    // three places, and the export download URL was the one with no check.
    //
    // No route can produce this row, so it is hand-edited, exactly as the
    // August 2026 audit reached it. That is the whole point of a read-time
    // check: write-time validation cannot speak for rows a migration, a dev
    // script or a bug changed later.
    //
    // Falsification, predicted then run:
    //   Predicted: with `isIssuedExportKey` removed from downloadUrlFor, this
    //   fails on `expect(job.downloadUrl).toBeNull()`, with a presigned URL
    //   naming the victim's prefix.
    //   Actual: exactly that, at :688 - "expected
    //   'https://fake-r2.test/download/exports...' to be null". The URL that
    //   came back is the leak, rendered. No gap.
    const started = await harness.request(token, "POST", "/api/export", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    const { id } = (await started.json()) as JobResponse;
    await pollUntilSettled(token, id);

    const victimId = "00000000-0000-4000-8000-000000000000";
    const foreignKey = `${EXPORTS_PREFIX}${victimId}/${id}/Receipts-2026.zip`;
    await harness.db
      .update(exportJobs)
      .set({ objectKey: foreignKey })
      .where(eq(exportJobs.id, id));

    // The refusal is supposed to be LOUD as well as safe: the whole reason
    // downloadUrlFor returns null instead of throwing is that the log line,
    // not the status code, is the "fail loudly" half of objectKeys.ts's rule.
    // Deleting the console.error would leave every other assertion here
    // passing and turn an explicit refusal into a silent null, so it is
    // asserted (REVIEW-FINAL F-7).
    const refusals: string[] = [];
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        refusals.push(args.map((a) => String(a)).join(" "));
      });
    let detail: Response;
    try {
      detail = await harness.request(token, "GET", `/api/export/${id}`);
    } finally {
      errorSpy.mockRestore();
    }
    expect(detail.status).toBe(200);
    const job = (await detail.json()) as JobResponse;

    const refusal = refusals.find((line) => line.includes("did not issue"));
    expect(refusal).toBeDefined();
    // Names the job, so the row is findable...
    expect(refusal).toContain(id);
    // ...and withholds the key itself, because a key naming another user's
    // prefix IS that user's id, and this line goes to the machine's log.
    expect(refusal).not.toContain(victimId);
    // Still reported complete - the job DID complete. What is refused is the
    // URL, which is the only thing that would have leaked.
    expect(job.status).toBe("complete");
    expect(job.downloadUrl).toBeNull();
  });

  it("contains a corrupt export key to its own job instead of failing the whole history list", async () => {
    // REVIEW-0 RV3-E. `GET /api/export` maps downloadUrlFor over up to 50 rows
    // inside a Promise.all, so copying assertIssuedObjectKey's throw would have
    // relocated the blast radius rather than bounded it: one hand-edited row
    // would take down the only route that lists a user's exports, making every
    // OTHER export unreachable. This is the case that pins the containment.
    //
    // Falsification, predicted then run:
    //   Predicted: replacing the refusal in downloadUrlFor with a throw fails
    //   this on `expect(response.status).toBe(200)`, receiving 500.
    //   Actual: exactly that, at :726 - "expected 500 to be 200". No gap, and
    //   it is the measurement that settles RV3-E: a throw here really does
    //   take the whole history list down, rather than the one bad row.
    const ids: string[] = [];
    for (const period of ["2024", "2025"]) {
      const response = await harness.request(token, "POST", "/api/export", {
        periodStart: `${period}-01-01`,
        periodEnd: `${period}-12-31`,
      });
      const { id } = (await response.json()) as JobResponse;
      await pollUntilSettled(token, id);
      ids.push(id);
    }

    // Exactly one of the two rows is corrupted.
    const [corruptedId, healthyId] = ids as [string, string];
    await harness.db
      .update(exportJobs)
      .set({
        objectKey: `${EXPORTS_PREFIX}00000000-0000-4000-8000-000000000000/${corruptedId}/Receipts-2024.zip`,
      })
      .where(eq(exportJobs.id, corruptedId));

    const response = await harness.request(token, "GET", "/api/export");
    // The list still answers. This is the assertion RV3-E is about.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: JobResponse[] };
    expect(body.jobs).toHaveLength(2);

    const corrupted = body.jobs.find((j) => j.id === corruptedId);
    const healthy = body.jobs.find((j) => j.id === healthyId);
    // The bad row loses its URL...
    expect(corrupted?.downloadUrl).toBeNull();
    // ...and the good one keeps its own, which is the containment claim.
    expect(healthy?.downloadUrl).not.toBeNull();
  });
});
