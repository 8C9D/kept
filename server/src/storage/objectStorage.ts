/**
 * The image store boundary. Images travel client ↔ storage directly via
 * presigned URLs and never transit the API server (spec §6); export
 * generation is the one server-side reader (it must bundle every image
 * into the zip) and writer (the finished zip itself).
 *
 * The interface is defined here and tested against a fake; the Cloudflare
 * R2 implementation arrives when credentials exist (deployment work, after
 * the local waves).
 *
 * ⚠ Bucket requirement for the real adapter: a 30-day lifecycle expiry on
 * the literal prefix `exports/` and nothing else (spec §10B; the shapes are
 * in objectKeys.ts). Export zips are artifacts, not records - regenerable
 * from the retained receipts and images - and the API already reports jobs
 * past that window as "expired". Receipt images live under `{userId}/...`
 * and must NOT be under any lifecycle rule.
 */
export interface ObjectStorage {
  /** A URL the client can PUT the image bytes to, valid briefly. */
  presignUpload(objectKey: string, contentType: string): Promise<string>;
  /** A URL the client can GET the image bytes from, valid briefly. */
  presignDownload(objectKey: string): Promise<string>;
  /** Server-side write, used for generated export zips. */
  upload(
    objectKey: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<void>;
  /** Server-side read, used to bundle images into an export. */
  download(objectKey: string): Promise<Uint8Array>;
}

/**
 * Placeholder wired into the production entrypoint until the R2 adapter
 * exists. Throwing on first use is deliberate: a loud failure at the call
 * site, not a broken URL handed silently to a client.
 */
export function unconfiguredObjectStorage(): ObjectStorage {
  const fail = (): never => {
    throw new Error(
      "Object storage is not configured; the R2 adapter does not exist yet",
    );
  };
  return {
    presignUpload: async () => fail(),
    presignDownload: async () => fail(),
    upload: async () => fail(),
    download: async () => fail(),
  };
}
