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
  uuid,
} from "drizzle-orm/pg-core";

export const receiptStatus = pgEnum("receipt_status", ["pending", "confirmed"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  appleSub: text("apple_sub").notNull().unique(),
  email: text("email"),
  displayName: text("display_name").notNull(),
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
    vendor: text("vendor").notNull(),
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
    status: receiptStatus("status").notNull(),
    ocrRawText: text("ocr_raw_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("receipts_user_id_purchased_at_idx").on(t.userId, t.purchasedAt),
    index("receipts_user_id_is_business_idx").on(t.userId, t.isBusiness),
    index("receipts_user_id_status_idx").on(t.userId, t.status),
  ],
);

export const receiptImages = pgTable(
  "receipt_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => receipts.id),
    page: smallint("page").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("receipt_images_receipt_id_page_uq").on(t.receiptId, t.page),
    unique("receipt_images_receipt_id_sha256_uq").on(t.receiptId, t.sha256),
  ],
);
