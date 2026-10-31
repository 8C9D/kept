import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WranglerError,
  bucketReader,
  createBackupTransport,
  createWranglerTransport,
} from "../../src/db/backupTransport.js";
import { sha256Hex } from "../../src/db/backupFiles.js";
import { fetchRestoredImage } from "../../src/db/restoreImageCheck.js";
import { ObjectNotFoundError } from "../../src/storage/objectStorage.js";
import { createFakeWrangler, type FakeWrangler } from "../helpers/fakeWrangler.js";

/**
 * The wrangler adapter against a fake executable that behaves the way the
 * installed 4.124.0 CLI was measured to (tests/helpers/fakeWrangler.ts).
 *
 * The fake is what can be asserted here and it is not the real CLI against real
 * R2; what it proves is the adapter's half of the bargain: the exact argv, the
 * absent-vs-everything-else split, and no 0-byte file surviving a failure.
 */

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const BUCKET = "kept";
const KEY = "user-1/2026/10/photo.jpg";

describe("the wrangler transport", () => {
  let fake: FakeWrangler;
  let localDir: string;

  beforeEach(() => {
    fake = createFakeWrangler();
    localDir = mkdtempSync(join(tmpdir(), "kept-wrangler-local-"));
  });

  afterEach(() => {
    fake.close();
    rmSync(localDir, { recursive: true, force: true });
  });

  const transport = (timeoutMs?: number) =>
    createWranglerTransport({ localDir, env: fake.env(), timeoutMs });

  async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
    try {
      await work;
    } catch (error) {
      return error;
    }
    throw new Error("expected this to reject");
  }

  it("gets with exactly the documented argv", async () => {
    fake.store(BUCKET, KEY, BYTES);
    expect(await transport().get(BUCKET, KEY)).toEqual(BYTES);

    const [argv] = fake.argv();
    const [temp] = fake.tempFiles();
    expect(argv).toBe(`r2 object get ${BUCKET}/${KEY} --remote --file ${temp}`);
  });

  it("puts a file with exactly the documented argv", async () => {
    const file = join(localDir, "upload.bin");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, BYTES);

    await transport().put("kept-backups", "pg/kept.dump", { file }, "application/octet-stream");

    expect(fake.argv()).toEqual([
      `r2 object put kept-backups/pg/kept.dump --remote --file ${file} --content-type application/octet-stream`,
    ]);
    expect(fake.stored("kept-backups", "pg/kept.dump")).toEqual(BYTES);
    expect(fake.storedContentType("kept-backups", "pg/kept.dump")).toBe("application/octet-stream");
  });

  it("puts bytes through a temp file it then removes", async () => {
    await transport().put(BUCKET, KEY, { bytes: BYTES }, "image/jpeg");
    expect(fake.stored(BUCKET, KEY)).toEqual(BYTES);
    expect(fake.storedContentType(BUCKET, KEY)).toBe("image/jpeg");
    expect(readdirSync(localDir)).toEqual([]);
  });

  it("runs in BACKUP_LOCAL_DIR with metrics off, so no project config applies", async () => {
    fake.store(BUCKET, KEY, BYTES);
    await transport().get(BUCKET, KEY);
    const [line] = fake.envLog();
    // realpath: on macOS the temp directory is reached through a symlink.
    const { realpathSync } = await import("node:fs");
    expect(line).toBe(`cwd=${realpathSync(localDir)} metrics=false`);
  });

  it("classifies the CLI's absence message as ObjectNotFoundError", async () => {
    const error = await rejectionOf(transport().get(BUCKET, KEY));
    expect(error).toBeInstanceOf(ObjectNotFoundError);
    // The contract keeps the store's own answer as the cause.
    expect((error as Error).cause).toBeInstanceOf(WranglerError);
  });

  it("deletes the 0-byte temp file a failed get leaves behind", async () => {
    await rejectionOf(transport().get(BUCKET, KEY));
    const [temp] = fake.tempFiles();
    expect(temp).toBeDefined();
    expect(existsSync(temp as string)).toBe(false);
    expect(readdirSync(localDir)).toEqual([]);
  });

  it("keeps a transient failure as itself, never as absence", async () => {
    fake.store(BUCKET, KEY, BYTES);
    fake.plan(["transient"]);
    const error = await rejectionOf(transport().get(BUCKET, KEY));
    expect(error).toBeInstanceOf(WranglerError);
    expect(error).not.toBeInstanceOf(ObjectNotFoundError);
    // The CLI's reason survives, without its colour codes.
    expect((error as WranglerError).detail).toBe(
      "exited with code 1: Failed to fetch /r2/objects - 500: Internal Server Error;",
    );
    expect(readdirSync(localDir)).toEqual([]);
  });

  it("recovers on the next call after a transient failure", async () => {
    fake.store(BUCKET, KEY, BYTES);
    fake.plan(["transient"]);
    await rejectionOf(transport().get(BUCKET, KEY));
    expect(await transport().get(BUCKET, KEY)).toEqual(BYTES);
  });

  it("reports wrangler being absent as a failure, not as a missing object", async () => {
    const reader = createWranglerTransport({ localDir, env: { PATH: "/nonexistent" } });
    const error = await rejectionOf(reader.get(BUCKET, KEY));
    expect(error).toBeInstanceOf(WranglerError);
    expect((error as WranglerError).detail).toBe("is not on PATH");
  });

  it("does not trust exit 0: an empty file fails the digest check, not the mirror", async () => {
    fake.store(BUCKET, KEY, BYTES);
    fake.plan(["empty"]);
    const fetched = await fetchRestoredImage(bucketReader(transport(), BUCKET), {
      objectKey: KEY,
      sha256: sha256Hex(BYTES),
    });
    expect(fetched.label).toBe("DIGEST");
    expect("bytes" in fetched).toBe(false);
  });

  it("deletes with exactly the documented argv", async () => {
    fake.store(BUCKET, KEY, BYTES);
    await transport().delete(BUCKET, KEY);
    expect(fake.argv()).toEqual([`r2 object delete ${BUCKET}/${KEY} --remote`]);
    await expect(transport().get(BUCKET, KEY)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("treats deleting an absent key as success, which is the CLI's own exit 0", async () => {
    await expect(transport().delete(BUCKET, "not/there.jpg")).resolves.toBeUndefined();
  });

  it("keeps a failed delete as itself, with wrangler's reason", async () => {
    fake.store(BUCKET, KEY, BYTES);
    fake.planDeletes(["transient"]);
    const error = await rejectionOf(transport().delete(BUCKET, KEY));
    expect(error).toBeInstanceOf(WranglerError);
    expect((error as WranglerError).detail).toContain("500: Internal Server Error");
    expect(error).not.toBeInstanceOf(ObjectNotFoundError);
  });

  it("feeds MISSING and UNREACHABLE through to the shared classification", async () => {
    const image = { objectKey: KEY, sha256: sha256Hex(BYTES) };
    const reader = bucketReader(transport(), BUCKET);

    expect((await fetchRestoredImage(reader, image)).label).toBe("MISSING");

    fake.plan(["transient"]);
    const unreachable = await fetchRestoredImage(reader, image);
    expect(unreachable.label).toBe("UNREACHABLE");
    expect(unreachable.failure).toContain("Internal Server Error");
  });

  it("does not hang on a wrangler that never returns", async () => {
    // A hung CLI, as distinct from a failing one.
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(join(fake.binDir, "wrangler"), "#!/bin/sh\nexec sleep 30\n");
    chmodSync(join(fake.binDir, "wrangler"), 0o755);

    const error = await rejectionOf(transport(100).get(BUCKET, KEY));
    expect(error).toBeInstanceOf(WranglerError);
    expect((error as WranglerError).detail).toContain("was stopped after 100 ms");
    expect(readdirSync(localDir)).toEqual([]);
  });
});

describe("createBackupTransport", () => {
  it("builds the s3 transport with no wrangler anywhere near it", async () => {
    // A server that accepts and answers garbage: all this asserts is that a get
    // goes to the configured endpoint and rejects as itself, not as absence.
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
      socket.end("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("no port");
    }
    try {
      const transport = createBackupTransport({
        transport: "s3",
        localDir: "/unused",
        endpoint: `http://127.0.0.1:${address.port}`,
        accessKeyId: "key",
        secretAccessKey: "secret",
      });
      await expect(transport.get("kept", "absent")).rejects.not.toBeInstanceOf(ObjectNotFoundError);
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    }
  }, 30_000);
});
