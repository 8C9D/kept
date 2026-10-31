/**
 * Whether the backup has run lately, decided from the bucket alone.
 *
 * Everything that reports on the backup is the backup reporting on itself, and a
 * job that never starts reports nothing: that is how it failed silently from
 * 2026-08-20 for weeks. This asks the only witness that does not depend on the
 * laptop being awake, the bucket, and it has no Cloudflare types in it so that the
 * deciding can be tested without a Worker around it. `index.ts` is the Worker.
 */

/** The part of an `R2Object` this reads. Never parsed out of the key: see below. */
export interface ListedObject {
  key: string;
  size: number;
  uploaded: Date;
}

export interface ListedPage {
  objects: ListedObject[];
  truncated: boolean;
  cursor?: string;
}

/** The part of an `R2Bucket` this needs, which is also all it can be handed. */
export interface BucketLister {
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<ListedPage>;
}

/** R2's own ceiling for one page. */
export const PAGE_LIMIT = 1000;

export const DEFAULT_MAX_AGE_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Both halves, because the job can get a dump off-site and then fail on the images,
 * and only the manifest, written last, is left stale by that. A fresh dump over a
 * stale manifest is therefore an alert and not a footnote.
 */
const WATCHED = [
  { label: "dump", prefix: "pg/" },
  { label: "manifest", prefix: "manifests/" },
] as const;

/**
 * ⚠ `NaN` is why this is not a plain `Number(value)`. A typo here would make every
 * `age > limit` comparison false, and a switch that can no longer trip looks exactly
 * like a healthy backup. So anything but a positive number throws, and that reaches
 * the same alert path as a bucket that cannot be read.
 */
export function parseMaxAgeHours(value: string | undefined): number {
  if (value === undefined || value === "") {
    return DEFAULT_MAX_AGE_HOURS;
  }
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(`MAX_AGE_HOURS is "${value}"; it must be a positive number of hours.`);
  }
  return hours;
}

/**
 * The most recently uploaded object under a prefix, across every page.
 *
 * R2's `uploaded` date and never the stamp in the key, so nothing is left out for
 * being named differently: a hand-run `pg/kept-20261002-manual-231052.dump` counts,
 * and sorts where it was uploaded rather than where its name falls. Pages are walked
 * on `truncated` as R2's docs insist, because a page can hold fewer than the limit
 * and still have more behind it. A listing that claims more and gives no way to it
 * throws: stopping there would report an old object as the newest.
 */
export async function newestObject(
  bucket: BucketLister,
  prefix: string,
): Promise<ListedObject | undefined> {
  let newest: ListedObject | undefined;
  let cursor: string | undefined;
  do {
    const page: ListedPage = await bucket.list({
      prefix,
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const object of page.objects) {
      if (newest === undefined || object.uploaded.getTime() > newest.uploaded.getTime()) {
        newest = object;
      }
    }
    if (page.truncated && (page.cursor === undefined || page.cursor === cursor)) {
      throw new Error(`The listing of ${prefix} is truncated with no way to continue it.`);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return newest;
}

export interface Finding {
  label: string;
  prefix: string;
  newest?: { key: string; ageHours: number; bytes: number };
  problems: string[];
}

export interface FreshnessReport {
  healthy: boolean;
  maxAgeHours: number;
  findings: Finding[];
}

export function assessNewest(
  watched: { label: string; prefix: string },
  newest: ListedObject | undefined,
  now: Date,
  maxAgeHours: number,
): Finding {
  const { label, prefix } = watched;
  if (newest === undefined) {
    return { label, prefix, problems: [`no ${label} at all under ${prefix}`] };
  }
  const ageHours = (now.getTime() - newest.uploaded.getTime()) / HOUR_MS;
  const problems: string[] = [];
  if (ageHours > maxAgeHours) {
    problems.push(
      `the newest ${label} is ${ageHours.toFixed(1)} hours old, over the ${maxAgeHours}-hour limit`,
    );
  }
  if (newest.size === 0) {
    problems.push(`the newest ${label} is 0 bytes`);
  }
  return {
    label,
    prefix,
    newest: { key: newest.key, ageHours, bytes: newest.size },
    problems,
  };
}

export async function checkBackups(
  bucket: BucketLister,
  now: Date,
  maxAgeHours: number,
): Promise<FreshnessReport> {
  const findings: Finding[] = [];
  for (const watched of WATCHED) {
    findings.push(
      assessNewest(watched, await newestObject(bucket, watched.prefix), now, maxAgeHours),
    );
  }
  return {
    healthy: findings.every((finding) => finding.problems.length === 0),
    maxAgeHours,
    findings,
  };
}

export interface AlertText {
  subject: string;
  text: string;
}

const WHAT_TO_DO = "On the laptop: npm run db:backup-status";

function findingLine({ label, newest }: Finding): string {
  return newest === undefined
    ? `${label}: none`
    : `${label}: ${newest.key}, ${newest.ageHours.toFixed(1)} hours old, ${newest.bytes} bytes`;
}

/** Keys, ages and sizes, and no receipt contents: there are none in a listing. */
export function formatAlert(report: FreshnessReport): AlertText {
  const problems = report.findings.flatMap((finding) => finding.problems);
  return {
    subject: `Kept backup alert: ${problems[0] ?? "something is wrong"}`,
    text: [
      "The Kept backup looks unhealthy.",
      "",
      ...problems.map((problem) => `- ${problem}`),
      "",
      ...report.findings.map(findingLine),
      "",
      WHAT_TO_DO,
      "",
    ].join("\n"),
  };
}

export function formatCheckFailedAlert(reason: string): AlertText {
  return {
    subject: "Kept backup alert: the backup could not be checked",
    text: [
      "The check of the Kept backup failed, so nothing is known about its freshness.",
      "",
      `- ${reason}`,
      "",
      WHAT_TO_DO,
      "",
    ].join("\n"),
  };
}

/** The one line a healthy run logs. */
export function formatHealthyLine(report: FreshnessReport): string {
  return `Kept backup fresh: ${report.findings.map(findingLine).join("; ")}`;
}
