import type { ObjectStorage } from "../../src/storage/objectStorage.js";

/**
 * Presigning without a cloud: returns recognizable fake URLs that embed the
 * object key, so tests can assert the right key was signed.
 */
export function fakeObjectStorage(): ObjectStorage {
  return {
    async presignUpload(objectKey: string) {
      return `https://fake-r2.test/upload/${objectKey}`;
    },
    async presignDownload(objectKey: string) {
      return `https://fake-r2.test/download/${objectKey}`;
    },
  };
}
