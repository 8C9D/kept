import { Readable } from "node:stream";
import {
  ObjectNotFoundError,
  type ObjectStorage,
} from "../../src/storage/objectStorage.js";

/**
 * In-memory object storage. Presigned URLs are recognizable fakes that
 * embed the object key so tests can assert the right key was signed; the
 * reads and writes work against a Map so export generation runs for real.
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
        // The real adapter errors on a missing key; the fake must too, or
        // tests could never see the failure path - and it must answer with
        // the same thing, because callers distinguish "the object is not
        // there" from "storage did not answer" and the two lead to opposite
        // advice. This used to be an Error with `name = "NoSuchKey"`, which
        // was this fake spelling S3's dialect: the contract is now
        // ObjectNotFoundError (see ObjectStorage.download), and this fake is
        // the non-S3 adapter that proves the contract does not depend on
        // which store is underneath.
        throw new ObjectNotFoundError(objectKey);
      }
      return data;
    },
    async downloadStream(objectKey: string) {
      const data = objects.get(objectKey);
      if (data === undefined) {
        // The same contract as `download` above: absence is decided here,
        // up front, never as an error on the stream.
        throw new ObjectNotFoundError(objectKey);
      }
      return {
        body: Readable.from([Buffer.from(data)], { objectMode: false }),
        contentLength: data.byteLength,
      };
    },
    async uploadStream(objectKey: string, body: Readable) {
      // Stored only once the stream has ended: a stream that errors rejects
      // out of this loop and leaves nothing behind, which is the all-or-nothing
      // contract the real adapter keeps by aborting the multipart upload.
      const chunks: Uint8Array[] = [];
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
      }
      objects.set(objectKey, Buffer.concat(chunks));
    },
    async listKeys(prefix: string) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
    async delete(objectKey: string) {
      // Absent is success, per the ObjectStorage contract: the real adapter
      // gets that from S3's own 204-either-way, and a fake that threw would
      // let a test pass that production would fail.
      objects.delete(objectKey);
    },
  };
}
