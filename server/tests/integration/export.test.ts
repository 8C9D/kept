import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { exportJobs } from "../../src/db/schema.js";
import { generateExport } from "../../src/export/generateExport.js";
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
      vendorTaxNumber: "000000000RT0001",
      subtotalCents: 10000,
      hstCents: 1300,
      totalCents: 11300,
      category: "office supplies",
      status: "confirmed",
    });
    const nullFields = await createReceiptWithImage(token, userId, "a2".repeat(32), {
      purchasedAt: "2026-02-20",
      vendor: null,
      subtotalCents: null,
      hstCents: null,
      totalCents: 4200,
      isBusiness: false,
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
    expect(zipKey).toBe(`${userId}/exports/${jobId}/Receipts-2026.zip`);
    const zip = new AdmZip(Buffer.from(await harness.storage.download(zipKey)));
    const entryNames = zip.getEntries().map((entry) => entry.entryName);
    expect(entryNames).toContain("receipts-2026.xlsx");
    expect(entryNames).toContain("receipts-2026.csv");

    // CSV: exact header, only the two confirmed in-period rows, money as
    // decimal strings, nulls as empty cells.
    const csv = zip.readAsText("receipts-2026.csv");
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "receipt_id,date,vendor,vendor_gst_hst_number,subtotal,hst,other_tax,total,currency,category,payment_method,business_or_personal,whose,image_filename,notes",
    );
    expect(lines).toHaveLength(3); // header + 2 rows
    const includedLine = lines.find((line) => line.startsWith(included.id));
    expect(includedLine).toBeDefined();
    expect(includedLine).toContain("Café Dépôt");
    expect(includedLine).toContain("100.00,13.00,,113.00,CAD");
    expect(includedLine).toContain("business,Synthetic User A,images/2026/01/");
    const nullLine = lines.find((line) => line.startsWith(nullFields.id));
    expect(nullLine).toContain(",,,,42.00,CAD");
    expect(nullLine).toContain("personal");
    expect(nullLine).toContain("unknown-vendor");
    expect(csv).not.toContain("Pending Vendor");
    expect(csv).not.toContain("Deleted Vendor");
    expect(csv).not.toContain("Out Of Period");
    expect(csv).not.toContain("Someone Else");

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

  it("records a loud failure when an image is missing from storage", async () => {
    // Created via the API but its bytes never uploaded: generation must
    // fail and say why, not ship a zip with a broken click-through.
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ status: "confirmed" }),
      image: imageFor(userId, "b1".repeat(32)),
    });
    expect(response.status).toBe(201);

    const started = await harness.request(token, "POST", "/api/export", {
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    const { id: jobId } = (await started.json()) as JobResponse;
    const job = await pollUntilSettled(token, jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("No such object");
    expect(job.downloadUrl).toBeNull();
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
    const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000);
    const stranded = await harness.db
      .insert(exportJobs)
      .values({
        userId,
        status: "running",
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        createdAt: thirtyOneMinutesAgo,
      })
      .returning({ id: exportJobs.id });
    const fresh = await harness.db
      .insert(exportJobs)
      .values({
        userId,
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
      token,
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
});
