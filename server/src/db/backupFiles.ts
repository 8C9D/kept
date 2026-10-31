import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The local half of the backup: tax records on a laptop. Every directory is
 * 700 and every file 600, whatever the umask, and nothing appears under its
 * final name until it is whole - a half-written file with the right name is
 * what a later run would otherwise read as a good copy.
 */

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Chmods as well as creating, because `mkdir`'s mode only applies to a
 * directory it creates. An existing 755 BACKUP_LOCAL_DIR would otherwise stay
 * readable by every account on the machine.
 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function writeFileAtomically(path: string, data: Uint8Array | string): Promise<void> {
  const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
  try {
    await writeFile(partial, data, { mode: 0o600 });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** The bytes at `path`, or undefined when nothing is there. */
export async function readIfPresent(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    // Absent is a state this job acts on. Anything else (a permissions
    // failure, an I/O error) is a real problem and rejects as itself.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Where an image lives in the mirror. The key must already be validated. */
export function mirrorPath(localDir: string, objectKey: string): string {
  return join(localDir, "images", objectKey);
}
