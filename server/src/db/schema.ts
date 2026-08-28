import { sql } from "drizzle-orm";
import {
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";
import type { LlmSuggestionRecord } from "../domain/llmSuggestions.js";
import type {
  EventAction,
  EventClient,
  EventField,
} from "../domain/userEvents.js";

export const receiptStatus = pgEnum("receipt_status", ["pending", "confirmed"]);

export const exportJobStatus = pgEnum("export_job_status", [
  "queued",
  "running",
  "complete",
  "failed",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  appleSub: text("apple_sub").notNull().unique(),
  email: text("email"),
  // Nullable for the same reason vendor is: Apple hands the client a name
  // only on first authorization and may hand nothing; a placeholder would
  // corrupt the field.
  displayName: text("display_name"),
  // Stamped into every session JWT and compared on verification; bumping it
  // revokes all of a user's outstanding sessions at once.
  tokenVersion: integer("token_version").notNull().default(0),
  fiscalYearEndMonth: smallint("fiscal_year_end_month").notNull().default(12),
  fiscalYearEndDay: smallint("fiscal_year_end_day").notNull().default(31),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    purchasedAt: date("purchased_at").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    // Nullable: an illegible vendor is a real outcome, and a forced
    // placeholder corrupts the field (spec §5).
    vendor: text("vendor"),
    subtotalCents: integer("subtotal_cents"),
    hstCents: integer("hst_cents"),
    // Gratuity: a printed or handwritten tip line. Nullable on the same rule
    // every other money field follows - absent means "no such line on this
    // receipt", never a fabricated zero. Brought back 2026-08-28 as its own
    // field, finer-grained than the lumped other_tax_cents the 2026-08-26
    // reduction removed (docs/DECISIONS.md that date, "First-use product
    // feedback").
    tipCents: integer("tip_cents"),
    // Every non-HST charge that is neither subtotal nor tip: delivery fees,
    // service charges, bottle deposits, environmental levies, and a foreign
    // receipt's non-HST tax (a US receipt's state sales tax has no other
    // home). Same nullability rule as tip. Restores what other_tax_cents
    // used to carry for the arithmetic check, split out rather than
    // relumped - see checkReceiptArithmetic.
    otherFeesCents: integer("other_fees_cents"),
    // Nullable while pending (wave 4): a batch-scanned receipt whose total
    // the parser could not read is stored with the absence stated, never a
    // fabricated amount. The check constraint below guarantees a confirmed
    // receipt always has one.
    totalCents: integer("total_cents"),
    currency: char("currency", { length: 3 }).notNull().default("CAD"),
    category: text("category"),
    paymentMethod: text("payment_method"),
    notes: text("notes"),
    // Soft delete: non-null rows are excluded from every list, count, and
    // export. CRA retention makes hard deletes off the table (spec §10B).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Defaulting to 'pending' is fail-closed: pending rows never export.
    status: receiptStatus("status").notNull().default("pending"),
    ocrRawText: text("ocr_raw_text"),
    // What the on-device parser suggested at capture, verbatim and
    // immutable: no route updates it. Comparing it with the fields a human
    // went on to confirm is how per-field parse accuracy is measured
    // (spec §7.3's wave-4 number), with no bookkeeping by anyone.
    ocrSuggestions: jsonb("ocr_suggestions").$type<OcrFieldSuggestions>(),
    // What the server-side LLM parse suggested from ocr_raw_text, verbatim
    // and immutable like ocr_suggestions: written once (backfill script now,
    // the create path's async parse later), updated by no route. The pair
    // of records is what lets parse-accuracy score the two paths separately
    // (ruled Aug 7, 2026).
    llmSuggestions: jsonb("llm_suggestions").$type<LlmSuggestionRecord>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Maintained by a Postgres trigger (drizzle/0001), not handler code.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("receipts_user_id_purchased_at_idx").on(t.userId, t.purchasedAt),
    index("receipts_user_id_status_idx").on(t.userId, t.status),
    // The database's own guarantee that confirming is never partial: the
    // route validates first for a clean 400, this backstops everything else.
    // The total is all that remains of "complete" since the 2026-08-26 field
    // reduction retired the business-or-personal choice.
    check(
      "receipts_confirmed_complete_ck",
      sql`status <> 'confirmed' OR total_cents IS NOT NULL`,
    ),
  ],
);

/**
 * Export generation runs asynchronously behind a job id + polling contract
 * (spec §6). Jobs are rows, not process memory: a restart must not lose a
 * running year-end export.
 */
export const exportJobs = pgTable(
  "export_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: exportJobStatus("status").notNull().default("queued"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    // Where the finished zip landed in object storage; null until complete.
    objectKey: text("object_key"),
    // Why the job failed; null unless status is 'failed'.
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("export_jobs_user_id_created_at_idx").on(t.userId, t.createdAt),
    /**
     * One live export per user, enforced by the database rather than by a
     * check in the handler.
     *
     * Generation runs *after* the 202 response, so the thing that has to be
     * held for the duration is the job row's own status - a transaction
     * cannot span it, and a read-then-insert in the handler is racy no
     * matter how it is written, because Postgres takes no lock on rows that
     * do not exist yet. Two taps of Export land two rows and two concurrent
     * generations.
     *
     * That matters for memory, not for tidiness: an export at the 256 MiB
     * budget was measured peaking at ~890 MB RSS (roughly 2.8x its payload,
     * since the assembled zip exists twice), and the origin is provisioned
     * at a fixed 2 GB. One at a time fits; two does not.
     *
     * ⚠ A crashed job leaves its row 'running' forever, which this index
     * would otherwise turn into a permanent lockout for that user. The
     * export route reaps rows past their staleness window before inserting;
     * the two are a pair, and neither is safe alone.
     */
    uniqueIndex("export_jobs_one_active_per_user_uq")
      .on(t.userId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export const receiptImages = pgTable(
  "receipt_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    // Denormalized so the duplicate-image constraint can be user-scoped;
    // a constraint that needs a join is not a constraint (spec §5).
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    page: smallint("page").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    // Stamped when the owning receipt is soft-deleted. The row is kept for
    // retention, exactly like the receipt's.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial, like the sha256 index just below (2026-08-28, migration
    // 0008, proposal #6 - "add a page, replace an image"). Originally a
    // plain unique constraint (wave 1); replacing an image soft-deletes the
    // live row at a page and inserts a new one at the SAME page number, and
    // a plain unique on (receipt_id, page) would refuse that insert - a
    // tombstoned row still occupies its slot forever, the identical defect
    // wave 1 already found and fixed once on the sha256 index below. This
    // migration applies the same fix to the other index that needed it.
    uniqueIndex("receipt_images_receipt_id_page_uq")
      .on(t.receiptId, t.page)
      .where(sql`deleted_at IS NULL`),
    // Partial: only live images occupy a duplicate slot. Otherwise deleting
    // a receipt and re-capturing the same file would 409 forever against a
    // row the user can no longer see.
    uniqueIndex("receipt_images_user_id_sha256_uq")
      .on(t.userId, t.sha256)
      .where(sql`deleted_at IS NULL`),
  ],
);

/**
 * Behavioural telemetry (the owner's 2026-08-28 ask, docs/DECISIONS.md that
 * date): what people DID, never what they typed. See domain/userEvents.ts
 * for the vocabularies, the privacy rule this table exists to enforce
 * structurally, and why `action`/`field`/`client` are `text` rather than
 * Postgres enums.
 *
 * No `meta`/`properties`/`payload` column, deliberately and permanently -
 * see domain/userEvents.ts's file header. This is the one schema decision
 * in this table that must never be "fixed" by a future patch that adds one
 * back to unblock some one-off debugging need.
 */
export const userEvents = pgTable(
  "user_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // Not ON DELETE CASCADE, on the same reasoning as every other table
    // here: DELETE /api/me states the deletion order in the route rather
    // than leaving it to the database (routes/me.ts).
    //
    // When it happened ON THE CLIENT, which may be much earlier than
    // received_at below: the iOS client is offline-first and batches, so a
    // sync after a week in airplane mode arrives as a burst of old
    // occurred_at values received in the same second. Bounded at the
    // schema boundary (http/schemas.ts), not here - see
    // domain/userEvents.ts's isOccurredAtInBounds.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // When the SERVER got it. Keeping both, rather than only occurred_at, is
    // what makes an offline batch legible as a batch instead of a pile of
    // events that all look like they happened simultaneously - and it is
    // what events:prune keys retention off (domain/userEvents.ts,
    // eventRetentionCutoff), for the same reason.
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    client: text("client").notNull().$type<EventClient>(),
    // Which build produced the event; without this a behaviour change
    // across app versions is invisible in the log.
    appVersion: text("app_version"),
    action: text("action").notNull().$type<EventAction>(),
    field: text("field").$type<EventField>(),
    // Deliberately NO foreign key. An event log must never refuse to record
    // because the row it mentions is not there: the iOS client queues
    // events offline alongside receipts that have not uploaded yet, so an
    // event can legitimately name a receipt id the server has never seen
    // (not yet synced) or will never see again (since deleted). A foreign
    // key would turn either case into a 500 or a 400 on what is supposed to
    // be a fire-and-forget write. This column is a weak reference, resolved
    // by whoever reads the log later (action-report joins it only when it
    // chooses to), and the log stays correctly scoped to one user by
    // user_id regardless of whether receipt_id resolves to anything.
    receiptId: uuid("receipt_id"),
    durationMs: integer("duration_ms"),
    // How many times a field was edited before save, for example - the
    // signal the owner named ("a user editing the total amount repeatedly
    // signals the total-extraction path is unreliable").
    count: integer("count"),
  },
  (t) => [index("user_events_user_id_occurred_at_idx").on(t.userId, t.occurredAt)],
);
