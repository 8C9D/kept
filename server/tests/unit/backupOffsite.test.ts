import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mirrorObjectKey } from "../../src/db/backupConfig.js";
import { mirrorPath, sha256Hex } from "../../src/db/backupFiles.js";
import type { BackupImageRow } from "../../src/db/backupMirror.js";
import {
  backupDestination,
  deleteVerified,
  ledgerFile,
  contentTypeForKey,
  formatManifest,
  isIssuedManifestKey,
  ledgerEntry,
  ledgerKeysOf,
  ledgerOwners,
  ledgerWithoutUser,
  parseLedger,
  parseManifest,
  pushImagesOffsite,
  pushManifest,
  uploadVerified,
} from "../../src/db/backupOffsite.js";
import { BackupLog } from "../../src/db/backupReport.js";
import { memoryBackupTransport, type MemoryBackupTransport } from "../helpers/memoryBackupTransport.js";

const USER = "6f3a1c1e-0d4b-4b7e-9a57-2f4b0e3f9a10";
const SHA = "a".repeat(64);
const BUCKET = "kept-backups";
const BYTES = new Uint8Array([1, 2, 3, 4]);

function issuedKey(extension = "jpg"): string {
  return `${USER}/2026/10/${randomUUID()}.${extension}`;
}

describe("backupDestination", () => {
  it("is the bucket under wrangler, and the store as well under s3", () => {
    expect(backupDestination({ transport: "wrangler", localDir: "/x", bucket: BUCKET })).toBe(BUCKET);
    expect(
      backupDestination({
        transport: "s3",
        localDir: "/x",
        bucket: BUCKET,
        endpoint: "http://localhost:9000",
        accessKeyId: "a",
        secretAccessKey: "b",
      }),
    ).toBe(`localhost:9000-${BUCKET}`);
  });
});

describe("deleteVerified", () => {
  const noWait = () => Promise.resolve();
  const KEY = "pg/kept-20261001-060000.dump";

  it("removes an object and proves it", async () => {
    const transport = memoryBackupTransport();
    transport.objects.set(`${BUCKET}/${KEY}`, BYTES);
    expect(await deleteVerified({ transport, bucket: BUCKET, key: KEY }, noWait)).toBeUndefined();
    expect(transport.objects.size).toBe(0);
  });

  it("calls absent a success, so a prune can run again from the top", async () => {
    const transport = memoryBackupTransport();
    expect(await deleteVerified({ transport, bucket: BUCKET, key: KEY }, noWait)).toBeUndefined();
  });

  it("does not believe a delete that reported success and changed nothing", async () => {
    const transport = memoryBackupTransport();
    transport.objects.set(`${BUCKET}/${KEY}`, BYTES);
    transport.ignoreDeletes(KEY);
    const failure = await deleteVerified({ transport, bucket: BUCKET, key: KEY }, noWait);
    expect(failure).toContain("still there after the delete");
  });

  it("retries a transient failure and then succeeds", async () => {
    const transport = memoryBackupTransport();
    transport.objects.set(`${BUCKET}/${KEY}`, BYTES);
    transport.failNext(KEY, new Error("blip"), new Error("blip"));
    expect(await deleteVerified({ transport, bucket: BUCKET, key: KEY }, noWait)).toBeUndefined();
    expect(transport.calls.filter(({ verb }) => verb === "delete")).toHaveLength(3);
  });

  it("does not read a read-back that failed as absence", async () => {
    const transport = {
      ...memoryBackupTransport(),
      get: () => Promise.reject(new Error("storage did not answer")),
    };
    const failure = await deleteVerified({ transport, bucket: BUCKET, key: KEY }, noWait);
    expect(failure).toContain("storage did not answer");
  });
});

describe("the ledger's lines, per user", () => {
  const OTHER = "11111111-2222-4333-8444-555555555555";
  const key = issuedKey();
  const otherKey = `${OTHER}/2026/10/${randomUUID()}.jpg`;
  const text = `${key}\t${SHA}\n${otherKey}\t${SHA}\n`;

  it("names every owner, a line torn mid-append included", () => {
    const torn = `${text}${USER}/2026/10/half-writ`;
    expect([...ledgerOwners(torn)].sort()).toEqual([OTHER, USER].sort());
  });

  it("ignores a first segment that is not a user id", () => {
    expect(ledgerOwners(`../2026/10/x.jpg\t${SHA}\n`).size).toBe(0);
  });

  it("finds one user's keys and nobody else's", () => {
    expect(ledgerKeysOf(text, USER)).toEqual([key]);
    expect(ledgerKeysOf(text, OTHER)).toEqual([otherKey]);
  });

  it("removes one user's lines and leaves the rest byte for byte", () => {
    const garbage = "not a ledger line";
    expect(ledgerWithoutUser(`${text}${garbage}\n`, USER)).toBe(`${otherKey}\t${SHA}\n${garbage}\n`);
  });

  it("does not take a user id that merely starts the same", () => {
    const longer = `${USER}0/2026/10/x.jpg\t${SHA}\n`;
    expect(ledgerWithoutUser(longer, USER)).toBe(longer);
  });
});

describe("parseLedger", () => {
  it("reads key and sha256 pairs", () => {
    const key = issuedKey();
    const { entries, ignoredLines } = parseLedger(`${key}\t${SHA}\n`);
    expect(entries.has(ledgerEntry(key, SHA))).toBe(true);
    expect(ignoredLines).toBe(0);
  });

  it("treats an empty ledger as empty", () => {
    expect(parseLedger("").entries.size).toBe(0);
  });

  it("counts a key with a different digest as not uploaded", () => {
    const key = issuedKey();
    const { entries } = parseLedger(`${key}\t${SHA}\n`);
    expect(entries.has(ledgerEntry(key, "b".repeat(64)))).toBe(false);
  });

  it("ignores a line cut short by a crash mid-append, so that image re-uploads", () => {
    const whole = issuedKey();
    const cut = issuedKey();
    const { entries, ignoredLines } = parseLedger(
      `${whole}\t${SHA}\n${cut}\t${SHA.slice(0, 20)}`,
    );
    expect(entries.size).toBe(1);
    expect(entries.has(ledgerEntry(cut, SHA))).toBe(false);
    expect(ignoredLines).toBe(1);
  });

  it.each([
    ["no digest", "some-key"],
    ["too many columns", `key\t${SHA}\textra`],
    ["no key", `\t${SHA}`],
    ["a digest that is not hex", `key\t${"z".repeat(64)}`],
  ])("ignores a line with %s", (_label, line) => {
    expect(parseLedger(`${line}\n`).ignoredLines).toBe(1);
  });
});

describe("the manifest", () => {
  const rows: BackupImageRow[] = [
    { id: "1", userId: USER, objectKey: issuedKey(), sha256: SHA, deleted: false },
    { id: "2", userId: USER, objectKey: issuedKey("pdf"), sha256: "b".repeat(64), deleted: true },
  ];

  it("round-trips key, digest and the deleted flag", () => {
    const { rows: parsed, problems } = parseManifest(formatManifest(rows));
    expect(problems).toEqual([]);
    expect(parsed).toEqual(
      rows.map(({ objectKey, sha256, deleted }) => ({ objectKey, sha256, deleted })),
    );
  });

  it("states its columns on the first line", () => {
    expect(formatManifest(rows).split("\n")[0]).toBe("object_key\tsha256\tdeleted");
  });

  it("keeps one line per row even when a stored key holds a tab or a newline", () => {
    const hostile = { ...rows[0]!, objectKey: "a\tb\nc\\d" };
    const text = formatManifest([hostile]);
    expect(text.trimEnd().split("\n")).toHaveLength(2);
    expect(text).toContain("a\\tb\\nc\\\\d");
    // Readable as a row, and refused as a key by the only reader that matters.
    const { rows: parsed } = parseManifest(text);
    expect(isIssuedManifestKey(parsed[0]!.objectKey)).toBe(false);
  });

  it("refuses a file that is not a manifest", () => {
    expect(() => parseManifest("key\tsha\n")).toThrowError(/not a backup manifest/);
  });

  it("names unreadable rows by line, without repeating them, and keeps the rest", () => {
    const text = `${formatManifest(rows)}garbage line\n`;
    const { rows: parsed, problems } = parseManifest(text);
    expect(parsed).toHaveLength(2);
    expect(problems).toEqual(["manifest line 4 is not a readable row"]);
  });

  it("is written locally and off-site, and verified", async () => {
    const localDir = mkdtempSync(join(tmpdir(), "kept-manifest-"));
    try {
      mkdirSync(join(localDir, "manifests"));
      const transport = memoryBackupTransport();
      const log = new BackupLog();
      const key = "manifests/kept-20261031-060000.tsv";
      await pushManifest(rows, { localDir, bucket: BUCKET, key, transport, log });

      const local = readFileSync(join(localDir, key));
      expect(new Uint8Array(local)).toEqual(transport.objects.get(`${BUCKET}/${key}`));
      expect(transport.contentTypes.get(`${BUCKET}/${key}`)).toBe("text/tab-separated-values");
      expect(transport.calls.map(({ verb }) => verb)).toEqual(["put", "get"]);
      expect(log.failures).toEqual([]);
    } finally {
      rmSync(localDir, { recursive: true, force: true });
    }
  });
});

describe("isIssuedManifestKey", () => {
  it("accepts what the issuer produces", () => {
    expect(isIssuedManifestKey(issuedKey())).toBe(true);
    expect(isIssuedManifestKey(issuedKey("pdf"))).toBe(true);
  });

  it("refuses a dot-dot owner, which isIssuedObjectKey alone would pin to itself", () => {
    expect(isIssuedManifestKey(`../2026/10/${randomUUID()}.jpg`)).toBe(false);
    expect(isIssuedManifestKey(`./2026/10/${randomUUID()}.jpg`)).toBe(false);
  });

  it("refuses an owner that is not shaped like a user id", () => {
    expect(isIssuedManifestKey(`exports/2026/10/${randomUUID()}.jpg`)).toBe(false);
  });

  it("refuses an export key", () => {
    expect(isIssuedManifestKey(`exports/${USER}/job/Receipts-2026.zip`)).toBe(false);
  });
});

describe("contentTypeForKey", () => {
  it("reads the issuing map backwards", () => {
    expect(contentTypeForKey("a.jpg")).toBe("image/jpeg");
    expect(contentTypeForKey("a.png")).toBe("image/png");
    expect(contentTypeForKey("a.pdf")).toBe("application/pdf");
  });
});

describe("uploadVerified", () => {
  let transport: MemoryBackupTransport;

  beforeEach(() => {
    transport = memoryBackupTransport();
  });

  const upload = (overrides: Partial<Parameters<typeof uploadVerified>[0]> = {}) =>
    uploadVerified(
      {
        transport,
        bucket: BUCKET,
        key: "pg/kept.dump",
        body: { bytes: BYTES },
        contentType: "application/octet-stream",
        sha256: sha256Hex(BYTES),
        ...overrides,
      },
      async () => {},
    );

  it("puts, then reads back, then says nothing", async () => {
    expect(await upload()).toBeUndefined();
    expect(transport.calls.map(({ verb }) => verb)).toEqual(["put", "get"]);
  });

  it("fails an object that does not read back to the digest, after retrying", async () => {
    const failure = await upload({ sha256: "c".repeat(64) });
    expect(failure).toContain("stored object hashes to");
    expect(transport.calls.filter(({ verb }) => verb === "put")).toHaveLength(4);
  });

  it("recovers from a transient failure", async () => {
    transport.failNext("pg/kept.dump", new Error("blip"));
    expect(await upload()).toBeUndefined();
  });

  it("gives up on a store that stays down, saying what happened", async () => {
    const down = new Error("connection refused");
    transport.failNext("pg/kept.dump", down, down, down, down);
    expect(await upload()).toContain("connection refused");
  });
});

describe("pushImagesOffsite", () => {
  let localDir: string;
  let transport: MemoryBackupTransport;
  let log: BackupLog;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "kept-offsite-"));
    transport = memoryBackupTransport();
    log = new BackupLog();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const push = (rows: BackupImageRow[]) =>
    pushImagesOffsite(rows, {
      localDir,
      bucket: BUCKET,
      destination: BUCKET,
      transport,
      log,
      wait: async () => {},
    });

  const mirrored = (): BackupImageRow => {
    const row = {
      id: randomUUID(),
      userId: USER,
      objectKey: issuedKey(),
      sha256: sha256Hex(BYTES),
      deleted: false,
    };
    const path = mirrorPath(localDir, row.objectKey);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, BYTES);
    return row;
  };

  const ledger = () => readFileSync(join(localDir, ledgerFile(BUCKET)), "utf8");

  it("uploads, verifies and only then records each image", async () => {
    const image = mirrored();

    expect(await push([image])).toEqual({ uploaded: 1, alreadyOffsite: 0 });

    const key = mirrorObjectKey(image.objectKey);
    expect(transport.objects.get(`${BUCKET}/${key}`)).toEqual(BYTES);
    expect(transport.contentTypes.get(`${BUCKET}/${key}`)).toBe("image/jpeg");
    expect(ledger()).toBe(`${image.objectKey}\t${image.sha256}\n`);
  });

  it("keeps a ledger per destination, so a new bucket gets every image", async () => {
    const image = mirrored();
    await push([image]);
    transport.calls.length = 0;

    const pushed = await pushImagesOffsite([image], {
      localDir,
      bucket: "another-bucket",
      destination: "another-bucket",
      transport,
      log,
      wait: async () => {},
    });

    expect(pushed).toEqual({ uploaded: 1, alreadyOffsite: 0 });
    expect(
      transport.objects.has(`another-bucket/${mirrorObjectKey(image.objectKey)}`),
    ).toBe(true);
  });

  it("never lets a destination name a path", () => {
    expect(ledgerFile("minio.example:9000-kept/backups")).toBe(
      "offsite-ledger-minio.example_9000-kept_backups.tsv",
    );
  });

  it("skips what the ledger lists, without touching storage", async () => {
    const image = mirrored();
    await push([image]);
    transport.calls.length = 0;

    expect(await push([image])).toEqual({ uploaded: 0, alreadyOffsite: 1 });
    expect(transport.calls).toEqual([]);
  });

  it("does not record an image whose verification failed", async () => {
    const image = mirrored();
    const down = new Error("down");
    const key = mirrorObjectKey(image.objectKey);
    transport.failNext(key, down, down, down, down);

    expect(await push([image])).toEqual({ uploaded: 0, alreadyOffsite: 0 });

    expect(log.failures[0]).toContain("off-site image");
    expect(existsSync(join(localDir, ledgerFile(BUCKET)))).toBe(false);
  });

  it("re-uploads everything after a lost ledger, harmlessly", async () => {
    const image = mirrored();
    await push([image]);
    rmSync(join(localDir, ledgerFile(BUCKET)));

    expect(await push([image])).toEqual({ uploaded: 1, alreadyOffsite: 0 });
    expect(log.failures).toEqual([]);
  });

  it("warns about unreadable ledger lines and re-uploads those images", async () => {
    const image = mirrored();
    writeFileSync(join(localDir, ledgerFile(BUCKET)), `${image.objectKey}\ttruncated`);

    expect(await push([image])).toEqual({ uploaded: 1, alreadyOffsite: 0 });
    expect(log.warnings.join()).toContain("1 unreadable line(s)");
  });

  it("re-uploads an image whose digest no longer matches its ledger entry", async () => {
    const image = mirrored();
    await push([image]);
    const changed = { ...image, sha256: sha256Hex(new Uint8Array([5])) };
    writeFileSync(mirrorPath(localDir, image.objectKey), new Uint8Array([5]));

    expect(await push([changed])).toEqual({ uploaded: 1, alreadyOffsite: 0 });
  });
});
