import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mirrorPath, sha256Hex } from "../../src/db/backupFiles.js";
import { mirrorImages, type BackupImageRow } from "../../src/db/backupMirror.js";
import { BackupLog } from "../../src/db/backupReport.js";
import { ObjectNotFoundError } from "../../src/storage/objectStorage.js";
import { memoryBackupTransport, type MemoryBackupTransport } from "../helpers/memoryBackupTransport.js";

/**
 * The image leg, row by row. The rule under test throughout is the one that
 * cannot be taken back afterwards: wrong bytes from the source must never reach
 * the mirror, whatever they replace.
 */

const SOURCE = "kept";
const USER = "6f3a1c1e-0d4b-4b7e-9a57-2f4b0e3f9a10";
const GOOD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const OTHER = new Uint8Array([9, 9, 9]);

function row(overrides: Partial<BackupImageRow> = {}): BackupImageRow {
  return {
    id: randomUUID(),
    userId: USER,
    objectKey: `${USER}/2026/10/${randomUUID()}.jpg`,
    sha256: sha256Hex(GOOD),
    deleted: false,
    ...overrides,
  };
}

describe("mirrorImages", () => {
  let localDir: string;
  let transport: MemoryBackupTransport;
  let log: BackupLog;
  let delays: number[];

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "kept-mirror-"));
    transport = memoryBackupTransport();
    log = new BackupLog();
    delays = [];
    // The log prints as it goes; the assertions read `log` directly.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const mirror = (...rows: BackupImageRow[]) =>
    mirrorImages(rows, {
      localDir,
      sourceBucket: SOURCE,
      transport,
      log,
      wait: async (ms) => {
        delays.push(ms);
      },
    });

  const inSource = (image: BackupImageRow, bytes: Uint8Array = GOOD) => {
    transport.objects.set(`${SOURCE}/${image.objectKey}`, bytes);
  };

  const inMirror = (image: BackupImageRow, bytes: Uint8Array) => {
    const path = mirrorPath(localDir, image.objectKey);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  };

  it("fetches an absent image, verifies it and writes it privately", async () => {
    const image = row();
    inSource(image);

    const outcome = await mirror(image);

    const path = mirrorPath(localDir, image.objectKey);
    expect(new Uint8Array(readFileSync(path))).toEqual(GOOD);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(outcome).toMatchObject({ alreadyMirrored: 0, fetched: 1 });
    expect(outcome.held).toEqual([image]);
    expect(log.failures).toEqual([]);
  });

  it("leaves no partial file behind", async () => {
    const image = row();
    inSource(image);
    await mirror(image);
    expect(readdirSync(dirname(mirrorPath(localDir, image.objectKey)))).toHaveLength(1);
  });

  it("skips a mirrored image that hashes to its row, without touching storage", async () => {
    const image = row();
    inMirror(image, GOOD);

    const outcome = await mirror(image);

    expect(transport.calls).toEqual([]);
    expect(outcome).toMatchObject({ alreadyMirrored: 1, fetched: 0 });
    expect(outcome.held).toEqual([image]);
  });

  it("reports a damaged mirror copy, then repairs it from the source", async () => {
    const image = row();
    inSource(image);
    const path = inMirror(image, OTHER);

    const outcome = await mirror(image);

    expect(log.warnings.join()).toContain(sha256Hex(OTHER));
    expect(log.failures).toEqual([]);
    expect(new Uint8Array(readFileSync(path))).toEqual(GOOD);
    expect(outcome.held).toEqual([image]);
  });

  it("writes nothing when the source's bytes are wrong", async () => {
    const image = row();
    inSource(image, OTHER);

    const outcome = await mirror(image);

    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]).toMatch(/^DIGEST /);
    expect(existsSync(mirrorPath(localDir, image.objectKey))).toBe(false);
    expect(outcome.held).toEqual([]);
  });

  it("never replaces what is on disk with wrong bytes from the source", async () => {
    const image = row();
    const wrongSource = new Uint8Array([7, 7, 7]);
    inSource(image, wrongSource);
    const path = inMirror(image, OTHER);

    await mirror(image);

    expect(log.failures[0]).toMatch(/^DIGEST /);
    expect(new Uint8Array(readFileSync(path))).toEqual(OTHER);
  });

  it("fails MISSING on a live row", async () => {
    const image = row();
    const outcome = await mirror(image);
    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]).toMatch(/^MISSING /);
    expect(log.warnings).toEqual([]);
    expect(outcome.held).toEqual([]);
  });

  it("only warns on MISSING behind a tombstone", async () => {
    const image = row({ deleted: true });
    await mirror(image);
    expect(log.failures).toEqual([]);
    expect(log.warnings.join()).toContain("MISSING on a tombstoned row");
  });

  it("does not retry MISSING: storage has answered", async () => {
    await mirror(row());
    expect(delays).toEqual([]);
    expect(transport.calls).toHaveLength(1);
  });

  it("still fails a tombstoned row whose bytes are WRONG: that is not absence", async () => {
    const image = row({ deleted: true });
    inSource(image, OTHER);
    await mirror(image);
    expect(log.failures[0]).toMatch(/^DIGEST /);
  });

  it("retries UNREACHABLE and recovers within three retries", async () => {
    const image = row();
    inSource(image);
    const blip = Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    transport.failNext(image.objectKey, blip, blip, blip);

    const outcome = await mirror(image);

    expect(delays).toEqual([1000, 2000, 4000]);
    expect(log.failures).toEqual([]);
    expect(outcome.fetched).toBe(1);
  });

  it("fails UNREACHABLE after the retries, and does not call it lost", async () => {
    const image = row();
    inSource(image);
    const blip = Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    transport.failNext(image.objectKey, blip, blip, blip, blip);

    await mirror(image);

    expect(transport.calls).toHaveLength(4);
    expect(log.failures[0]).toMatch(/^UNREACHABLE /);
    expect(log.failures[0]).toContain("may still be there");
  });

  it("fails UNREACHABLE even on a tombstoned row: only absence is excused", async () => {
    const image = row({ deleted: true });
    const blip = new Error("timeout");
    transport.failNext(image.objectKey, blip, blip, blip, blip);
    await mirror(image);
    expect(log.failures[0]).toMatch(/^UNREACHABLE /);
  });

  it.each([
    ["a traversal out of the mirror", `${USER}/../../../../etc/passwd`],
    ["another user's prefix", `11111111-1111-4111-8111-111111111111/2026/10/${randomUUID()}.jpg`],
    ["a leading slash", `/${USER}/2026/10/${randomUUID()}.jpg`],
    ["an extension never issued", `${USER}/2026/10/${randomUUID()}.exe`],
  ])("refuses %s before it goes near a path or storage", async (_label, objectKey) => {
    const image = row({ objectKey });

    const outcome = await mirror(image);

    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]).toContain(image.id);
    expect(log.failures[0]).not.toContain(objectKey);
    expect(transport.calls).toEqual([]);
    expect(readdirSync(localDir)).toEqual([]);
    expect(outcome.held).toEqual([]);
  });

  it("carries on past a failed row", async () => {
    const broken = row();
    const fine = row();
    inSource(fine);

    const outcome = await mirror(broken, fine);

    expect(log.failures).toHaveLength(1);
    expect(outcome.held).toEqual([fine]);
  });

  it("records a local failure against the row and carries on", async () => {
    const blocked = row();
    const fine = row();
    inSource(blocked);
    inSource(fine);
    // A file where the row's directory has to go: the write fails with ENOTDIR.
    writeFileSync(join(localDir, "images"), "in the way");

    const outcome = await mirror(blocked, fine);

    expect(log.failures).toHaveLength(2);
    expect(log.failures[0]).toContain("image ");
    expect(outcome.held).toEqual([]);
  });

  it("uses at most two lanes", async () => {
    transport = memoryBackupTransport({ delayMs: 5 });
    const images = Array.from({ length: 6 }, () => row());
    images.forEach((image) => inSource(image));

    await mirror(...images);

    expect(transport.maxConcurrent()).toBe(2);
  });

  it("treats contract-stated absence and nothing else as MISSING", async () => {
    const image = row();
    transport.failNext(image.objectKey, new ObjectNotFoundError(image.objectKey));
    await mirror(image);
    expect(log.failures[0]).toMatch(/^MISSING /);
  });
});
