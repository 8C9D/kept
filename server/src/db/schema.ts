import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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
    vendorTaxNumber: text("vendor_tax_number"),
    subtotalCents: integer("subtotal_cents"),
    hstCents: integer("hst_cents"),
    otherTaxCents: integer("other_tax_cents"),
    totalCents: integer("total_cents").notNull(),
    currency: char("currency", { length: 3 }).notNull().default("CAD"),
    category: text("category"),
    paymentMethod: text("payment_method"),
    // No default at any layer: the client must send an explicit choice.
    isBusiness: boolean("is_business").notNull(),
    notes: text("notes"),
    // Soft delete: non-null rows are excluded from every list, count, and
    // export. CRA retention makes hard deletes off the table (spec §10B).
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Defaulting to 'pending' is fail-closed: pending rows never export.
    status: receiptStatus("status").notNull().default("pending"),
    ocrRawText: text("ocr_raw_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Maintained by a Postgres trigger (drizzle/0001), not handler code.
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("receipts_user_id_purchased_at_idx").on(t.userId, t.purchasedAt),
    index("receipts_user_id_is_business_idx").on(t.userId, t.isBusiness),
    index("receipts_user_id_status_idx").on(t.userId, t.status),
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
  (t) => [index("export_jobs_user_id_created_at_idx").on(t.userId, t.createdAt)],
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
    unique("receipt_images_receipt_id_page_uq").on(t.receiptId, t.page),
    // Partial: only live images occupy a duplicate slot. Otherwise deleting
    // a receipt and re-capturing the same file would 409 forever against a
    // row the user can no longer see.
    uniqueIndex("receipt_images_user_id_sha256_uq")
      .on(t.userId, t.sha256)
      .where(sql`deleted_at IS NULL`),
  ],
);
