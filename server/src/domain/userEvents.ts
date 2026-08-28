/**
 * The behavioural-telemetry vocabulary (the owner's 2026-08-28 ask: "learn
 * from usage ... a user editing the total amount repeatedly signals the
 * total-extraction path is unreliable"). §7.3 already scores parse
 * accuracy by comparing a stored suggestion against what a human
 * confirmed, but that only sees the final saved value - it cannot see the
 * four edits along the way. `user_events` (db/schema.ts) is the second
 * signal: not what was saved, but what someone DID.
 *
 * `action`, `field` and `client` are fixed enumerations, deliberately not
 * free strings and deliberately not Postgres enums - the columns that store
 * them are plain `text` (schema.ts). A new action name is a code change
 * here plus a client release, never a migration; the schema boundary
 * (http/schemas.ts, `z.enum` over these arrays) is what actually stops an
 * unlisted value from ever reaching a row, and it does that no less
 * strictly than a database enum would.
 *
 * The privacy rule this whole feature turns on: NOTHING here ever carries a
 * field VALUE. `field_edited` records that `total` was edited, and how many
 * times - never to what. There is deliberately no free-form `meta` /
 * `properties` / `payload` column anywhere on `user_events`: a bag that CAN
 * carry a value eventually WILL, the day someone adds "just one more field"
 * to debug something, and a schema that cannot express a value cannot leak
 * one. Kept holds its users' financial records under an App Store privacy
 * declaration; this is the line between usage telemetry and a second copy
 * of the receipts.
 */

export const EVENT_ACTIONS = [
  "capture_started",
  "capture_completed",
  "capture_cancelled",
  "confirm_opened",
  "confirm_saved",
  "confirm_deferred",
  "field_edited",
  "suggestion_accepted",
  "suggestion_overridden",
  "receipt_viewed",
  "receipt_edited",
  "receipt_deleted",
  "list_searched",
  "list_filtered",
  "list_sorted",
  "image_opened",
  "image_zoomed",
  "option_reused",
  "export_requested",
  "export_downloaded",
  "export_failed",
  "sign_in",
  "sign_out",
  "account_deleted",
] as const;

export type EventAction = (typeof EVENT_ACTIONS)[number];

/**
 * Which receipt field an action was about. A field like `notes` can be
 * named by `field_edited` (someone typed into it) even though it has no
 * suggestion to accept or override - the vocabulary is shared across every
 * field-scoped action, not owned by one of them.
 */
export const EVENT_FIELDS = [
  "total",
  "purchasedAt",
  "vendor",
  "hst",
  "subtotal",
  "tip",
  "otherFees",
  "category",
  "paymentMethod",
  "notes",
] as const;

export type EventField = (typeof EVENT_FIELDS)[number];

/** Which client produced the event. */
export const EVENT_CLIENTS = ["ios", "web"] as const;

export type EventClient = (typeof EVENT_CLIENTS)[number];

/**
 * `occurredAt` bounds (spec: "consider whether occurredAt needs bounds").
 *
 * The iOS client is offline-first and batches, so a wide-open past is
 * expected and not itself suspicious - someone's phone can sit in airplane
 * mode for weeks before the outbox flushes. What is NOT expected is a
 * timestamp from before Kept could possibly have produced one (an
 * uninitialized clock reporting the Unix epoch, a unit-conversion bug that
 * turns milliseconds into a year in the 1970s) or one from after the
 * request arrived by more than ordinary clock skew (a broken device clock,
 * or a client bug that sends a placeholder date). Both are junk, not signal,
 * and this endpoint's own rule - a strict failure is fine, losing telemetry
 * is the acceptable outcome - makes rejecting them the right default rather
 * than a silent clamp that would quietly mis-plot them on any report reading
 * `occurred_at`.
 *
 * The floor is a fixed calendar date rather than "N days before now": a
 * relative floor would keep sliding forward and eventually refuse a
 * genuinely old event still sitting in a phone's outbox, which is exactly
 * the offline-batching case this table exists to make legible. 2020-01-01
 * predates any version of Kept by years, so it costs nothing today and does
 * not need revisiting as the app ages.
 */
const OCCURRED_AT_FLOOR = new Date("2020-01-01T00:00:00.000Z");

/**
 * How far into the future an `occurredAt` may claim to be, relative to when
 * the server evaluates it. Generous enough to absorb an honestly wrong
 * device clock across time zones without needing a lookup, tight enough to
 * still catch a placeholder date (2099, an uninitialized far-future
 * sentinel).
 */
const OCCURRED_AT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export function isOccurredAtInBounds(
  occurredAt: Date,
  now: Date = new Date(),
): boolean {
  if (Number.isNaN(occurredAt.getTime())) {
    return false;
  }
  if (occurredAt.getTime() < OCCURRED_AT_FLOOR.getTime()) {
    return false;
  }
  return occurredAt.getTime() <= now.getTime() + OCCURRED_AT_FUTURE_SKEW_MS;
}

/**
 * Retention (spec §10B is about receipts and does not apply here - these
 * rows are diagnostic, not tax records). 180 days is long enough to compare
 * a parse-quality signal across a few months of real use, short enough that
 * a table nobody sweeps does not become the thing an accidental full-table
 * read chokes on.
 */
export const EVENT_RETENTION_DAYS = 180;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The oldest `received_at` a `user_events` row may have before
 * `npm run events:prune` removes it.
 *
 * Keyed to when the SERVER received the row, not when the event occurred on
 * the client (`received_at`'s own comment, schema.ts, explains why the two
 * are tracked separately). An offline-queued event delivered in a batch
 * weeks after it happened is exactly the kind of row this log exists to
 * make legible; pruning by `occurred_at` would delete freshly-arrived
 * diagnostic evidence before anyone had a chance to read it, which defeats
 * the entire point of carrying both timestamps.
 */
export function eventRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - EVENT_RETENTION_DAYS * MS_PER_DAY);
}
