import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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

  it("records a loud failure when an image is missing from storage, naming the receipt that caused it", async () => {
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
    // The row is findable...
    expect(job.error).toContain(receiptId);
    // ...and the remedy named is one this server can actually perform. There
    // is no way to re-attach an image to an existing receipt: the PATCH
    // schema has no `image` key and `/upload-url` mints a fresh key every
    // call. So the message must not say "re-attach" - an earlier draft did,
    // and it sent the person looking for a control that does not exist.
    expect(job.error).toMatch(/Delete that receipt, then capture it again/);
    expect(job.error).not.toMatch(/re-attach/i);
    // And it states the cost rather than leaving the person to discover that
    // deleting drops the receipt from every export.
    expect(job.error).toMatch(/without\s+that receipt in it/);
    // The storage layer's own text does not reach the export screen. Asserted
    // against the object key rather than the fake's wording: the key is what
    // the real client's failure could carry, and it is a user id plus a path.
    expect(job.error).not.toContain(userId);
    expect(job.error).not.toMatch(/\.jpg/);
    // No receipt field beyond the id: this string is also logged, and the
    // §10B invariant is that server logs carry no receipt contents.
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
});
