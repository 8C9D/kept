import type { ObjectStorage } from "../../src/storage/objectStorage.js";

/**
 * In-memory object storage. Presigned URLs are recognizable fakes that
 * embed the object key so tests can assert the right key was signed;
 * upload/download work against a Map so export generation runs for real.
 */
export interface FakeObjectStorage extends ObjectStorage {
  /** Test-side inspection of what was stored. */
  objects: Map<string, Uint8Array>;
}

export function fakeObjectStorage(): FakeObjectStorage {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async presignUpload(objectKey: string) {
      return `https://fake-r2.test/upload/${objectKey}`;
    },
    async presignDownload(objectKey: string) {
      return `https://fake-r2.test/download/${objectKey}`;
    },
    async upload(objectKey: string, data: Uint8Array) {
      objects.set(objectKey, data);
    },
    async download(objectKey: string) {
      const data = objects.get(objectKey);
      if (data === undefined) {
        // The real R2 client errors on a missing key; the fake must too,
        // or tests could never see the failure path.
        throw new Error(`No such object: ${objectKey}`);
      }
      return data;
    },
  };
}
