import {
  LOCAL_DEV_STORAGE_CONFIG,
  createBucketIfMissing,
  resolveStorageConfig,
} from "./s3ObjectStorage.js";

/**
 * `npm run storage:init` - create the configured bucket if missing.
 * Needed when STORAGE_ENDPOINT points somewhere the server's dev-default
 * startup does not auto-create for - e.g. the MinIO container addressed by
 * the Mac's .local name so an iPhone can reach presigned URLs.
 */
const config = resolveStorageConfig(process.env) ?? LOCAL_DEV_STORAGE_CONFIG;

createBucketIfMissing(config)
  .then(() => {
    console.log(
      `Bucket "${config.bucket}" is ready at ${config.endpoint}.`,
    );
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
