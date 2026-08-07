import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  LOCAL_DEV_STORAGE_CONFIG,
  type S3StorageConfig,
  resolveStorageConfig,
} from "./s3ObjectStorage.js";

/**
 * Does this object store resolve a key that names another user's namespace?
 *
 * The August 2026 audit measured MinIO's answer and it is not one answer: a
 * dot-segment walk fails every spelling, while a *leading slash* normalizes
 * away and serves the victim's bytes with a 200. Same layer, same class of
 * input, opposite outcome - so "the storage layer collapses traversal" is a
 * property of the spellings tested, not of the layer, and the audit was
 * explicit that this "tells us nothing about R2 either way".
 *
 * `isIssuedObjectKey` is what actually protects the API (a whole-string
 * match, so none of these spellings can be stored in the first place). This
 * script exists to replace an assumption about R2 with a measurement, which
 * the wave-6 kickoff asks for by name. Run it once against real R2:
 *
 *   STORAGE_ENDPOINT=... STORAGE_BUCKET=... STORAGE_ACCESS_KEY_ID=... \
 *   STORAGE_SECRET_ACCESS_KEY=... npm run storage:probe-keys
 *
 * With no STORAGE_* set it runs against the docker-compose MinIO, where the
 * expected result is the audit's: control 200, leading slash 200, every dot
 * segment refused.
 *
 * ⚠ It leaves two small objects behind, under a `probe-victim-*` prefix that
 * no user id and no lifecycle rule can collide with. Nothing in this project
 * deletes stored objects (spec §10B), and a diagnostic is a bad reason to
 * introduce the first deletion path. Remove them from the bucket by hand.
 */

interface ProbeResult {
  label: string;
  key: string;
  outcome: string;
  servedVictimBytes: boolean;
}

const VICTIM_BODY = "victim-bytes";
const ATTACKER_BODY = "attacker-bytes";

async function main(): Promise<void> {
  const config = resolveStorageConfig(process.env) ?? LOCAL_DEV_STORAGE_CONFIG;
  const client = makeClient(config);

  const victimUser = `probe-victim-${randomUUID()}`;
  const attackerUser = `probe-attacker-${randomUUID()}`;
  const victimKey = `${victimUser}/2026/08/${randomUUID()}.jpg`;
  const attackerKey = `${attackerUser}/2026/08/${randomUUID()}.jpg`;

  console.log(`Probing ${config.endpoint} bucket ${config.bucket}`);
  await put(client, config.bucket, victimKey, VICTIM_BODY);
  await put(client, config.bucket, attackerKey, ATTACKER_BODY);

  const spellings: Array<{ label: string; key: string }> = [
    // The control. If this does not serve the victim's bytes, the probe
    // cannot observe a leak and every "refused" below is meaningless.
    { label: "control: the victim's own key", key: victimKey },
    { label: "leading slash", key: `/${victimKey}` },
    { label: "double leading slash", key: `//${victimKey}` },
    { label: "dot-segment walk", key: `${attackerUser}/../${victimKey}` },
    { label: "dot-segment walk, encoded", key: `${attackerUser}/%2e%2e/${victimKey}` },
    {
      label: "dot-segment walk, double-encoded",
      key: `${attackerUser}/%252e%252e/${victimKey}`,
    },
    { label: "backslash walk", key: `${attackerUser}\\..\\${victimKey}` },
    { label: "single dot segment", key: `${attackerUser}/./../${victimKey}` },
    { label: "suffix walk out of a valid key", key: `${attackerKey}/../../../${victimKey}` },
  ];

  const results: ProbeResult[] = [];
  for (const spelling of spellings) {
    results.push(await probe(client, config.bucket, spelling.label, spelling.key));
  }

  console.log("");
  for (const result of results) {
    const marker = result.servedVictimBytes ? "SERVED VICTIM BYTES" : "refused";
    console.log(`  ${marker.padEnd(20)} ${result.label} -> ${result.outcome}`);
  }
  console.log("");

  const control = results[0];
  if (control === undefined || !control.servedVictimBytes) {
    // Refuse to report "nothing leaked" from a probe that could not have
    // seen a leak - the exact anti-pattern the audit found in the isolation
    // suite's cross-user assertion.
    throw new Error(
      "The control did not serve the victim's bytes, so this probe cannot " +
        "observe a leak and its results say nothing. Check credentials and " +
        "bucket before reading anything into the lines above.",
    );
  }

  const leaks = results.slice(1).filter((result) => result.servedVictimBytes);
  console.log(
    leaks.length === 0
      ? "No spelling resolved across the prefix boundary on this store."
      : `${leaks.length} spelling(s) resolved across the prefix boundary: ` +
          leaks.map((leak) => leak.label).join(", "),
  );
  console.log(
    `Leaving two probe objects behind under ${victimUser}/ and ${attackerUser}/ - ` +
      "delete them from the bucket by hand.",
  );
}

async function probe(
  client: S3Client,
  bucket: string,
  label: string,
  key: string,
): Promise<ProbeResult> {
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await response.Body?.transformToString();
    return {
      label,
      key,
      outcome: `200, body ${JSON.stringify(body ?? "")}`,
      servedVictimBytes: body === VICTIM_BODY,
    };
  } catch (error) {
    return { label, key, outcome: describe(error), servedVictimBytes: false };
  }
}

async function put(
  client: S3Client,
  bucket: string,
  key: string,
  body: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
  );
}

function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const named = error as { name: string; $metadata?: { httpStatusCode?: number } };
    return `${named.name} (${named.$metadata?.httpStatusCode ?? "no status"})`;
  }
  return String(error);
}

function makeClient(config: S3StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });
}

await main();
