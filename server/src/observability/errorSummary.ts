/**
 * How an error becomes text - for a log line, or for the one error message
 * a client is shown. Separate from `http/errors.ts`, which decides how an
 * error becomes a *response*: the export job path needs this too, and it is
 * not an HTTP concern.
 *
 * ⚠ The whole point of this module is that a database error's own text is
 * never safe to reproduce. Three properties carry row values:
 *
 *   - drizzle's `DrizzleQueryError` takes `(query, params)` and builds its
 *     message as `Failed query: ${query}\nparams: ${params}` - so the bound
 *     parameters of the statement are *inside `error.message`*, not only on
 *     a side property. Logging `error.message` instead of the object, which
 *     is what the August 2026 review recommended, would have leaked exactly
 *     as much as logging the object did.
 *   - node-postgres's `DatabaseError` carries `detail` ("Failing row
 *     contains (...)"), `where`, and `internalQuery`.
 *   - both appear in `error.stack`, whose first line is name + message.
 *
 * So the rule here is structural rather than textual: an error carrying any
 * database-error marker is described by its *schema-identifying* fields
 * alone - never its message, never its stack, never its properties. The
 * August 2026 audit reached this through a receipt with an amount above
 * int4, which logged vendor, tax number, payment method and a private note
 * in plaintext. Bounding the amount removed that trigger; it did not remove
 * the class, and any future failed query would print the same way.
 */

/**
 * Properties only a database error carries. Every one of them can hold row
 * values, so their presence is what switches on redaction - matching on an
 * imported error class instead would miss a wrapper this project has not
 * met yet, and the failure mode of missing one is a silent leak.
 */
const DATABASE_ERROR_MARKERS = [
  "query",
  "params",
  "detail",
  "where",
  "internalQuery",
  "severity",
  "routine",
] as const;

/**
 * Fields that name schema objects rather than row values, and are worth
 * keeping: without a SQLSTATE and a table name, a redacted log line says
 * only "something failed", which is not enough to act on.
 */
const SAFE_DATABASE_FIELDS = [
  "code",
  "constraint",
  "table",
  "column",
  "schema",
  "dataType",
  "routine",
] as const;

/** A malformed cause chain must not spin; nothing legitimate nests deeper. */
const MAX_CAUSE_DEPTH = 5;

/**
 * What a client may be told about a failure it did not cause. Deliberately
 * says nothing: a database error's text is either internals (the SQL) or
 * row values (the parameters), and neither belongs in a response or in the
 * `export_jobs.error` column, which is rendered on the export screen.
 */
const OPAQUE_DATABASE_FAILURE = "A database error occurred";

/**
 * A redacted, multi-line description of an error and its cause chain, for
 * a server-side log. Our own errors keep their message and stack frames -
 * they are text this project wrote. Database errors keep neither.
 */
export function errorSummary(error: unknown): string {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === undefined || current === null) {
      break;
    }
    lines.push(depth === 0 ? describe(current) : `caused by ${describe(current)}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return lines.join("\n  ");
}

/**
 * The message an error may be shown as, or stored as. Same rule as above,
 * minus the stack: errors this project throws carry messages written to be
 * read (the export size limit names the fix), and a database error carries
 * nothing showable at all.
 */
export function redactedMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "An unexpected error occurred";
  }
  if (hasDatabaseErrorMarker(error)) {
    return OPAQUE_DATABASE_FAILURE;
  }
  return error.message;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    // Throwing a non-Error is a bug of ours, but the thrown value could be
    // anything at all - including a row object - so name its type only.
    return `non-Error value thrown (${typeof error})`;
  }
  const name = error.constructor?.name ?? error.name;
  if (hasDatabaseErrorMarker(error)) {
    const fields = safeDatabaseFields(error);
    const suffix = fields.length === 0 ? "" : ` ${fields.join(" ")}`;
    return `${name} [message and detail withheld]${suffix}`;
  }
  const frames = stackFrames(error);
  return frames === "" ? `${name}: ${error.message}` : `${name}: ${error.message}\n${frames}`;
}

function hasDatabaseErrorMarker(error: Error): boolean {
  const candidate = error as unknown as Record<string, unknown>;
  return DATABASE_ERROR_MARKERS.some(
    (marker) => candidate[marker] !== undefined,
  );
}

function safeDatabaseFields(error: Error): string[] {
  const candidate = error as unknown as Record<string, unknown>;
  return SAFE_DATABASE_FIELDS.flatMap((field) => {
    const value = candidate[field];
    return typeof value === "string" && value !== ""
      ? [`${field}=${value}`]
      : [];
  });
}

/**
 * Stack frames without the header line. `error.stack` starts with
 * `${name}: ${message}`, so keeping the whole string would reintroduce the
 * message this function's callers may have decided to withhold.
 */
function stackFrames(error: Error): string {
  if (typeof error.stack !== "string") {
    return "";
  }
  return error.stack
    .split("\n")
    .filter((line) => line.trimStart().startsWith("at "))
    .join("\n");
}
