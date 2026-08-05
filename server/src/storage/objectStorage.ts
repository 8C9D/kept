/**
 * The image store boundary. Images travel client ↔ storage directly via
 * presigned URLs and never transit the API server (spec §6).
 *
 * Wave 1 defines the interface and tests against a fake; the Cloudflare R2
 * implementation arrives with wave 2, when credentials exist.
 */
export interface ObjectStorage {
  /** A URL the client can PUT the image bytes to, valid briefly. */
  presignUpload(objectKey: string, contentType: string): Promise<string>;
  /** A URL the client can GET the image bytes from, valid briefly. */
  presignDownload(objectKey: string): Promise<string>;
}

/**
 * Placeholder wired into the production entrypoint until wave 2. Throwing
 * on first use is deliberate: a loud failure at the call site, not a broken
 * URL handed silently to a client.
 */
export function unconfiguredObjectStorage(): ObjectStorage {
  const fail = (): never => {
    throw new Error(
      "Object storage is not configured; the R2 adapter is wave-2 work",
    );
  };
  return {
    presignUpload: async () => fail(),
    presignDownload: async () => fail(),
  };
}
