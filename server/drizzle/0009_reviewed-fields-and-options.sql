-- 2026-09-01. Additive: two nullable-or-defaulted columns on `receipts` and
-- one new table. Nothing is dropped, no constraint is tightened, and every
-- statement below is safe against the currently deployed build - which reads
-- neither column and does not know the table exists.
--
-- ⚠ ORDERING: this migration must run BEFORE the deploy that reads
-- `receipt_field_options`. The backfill at the bottom is what puts the
-- existing users' vocabulary into the table, and `GET /api/receipts/options`
-- in the new build reads the TABLE rather than re-deriving from `receipts`.
-- Deploying first would serve both users an empty options list - every
-- category, payment method and vendor they have ever typed, gone from the
-- pick-list - until this ran. The reverse order is harmless: the old build
-- ignores a table it never queries.
CREATE TABLE "receipt_field_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_field_options_user_id_field_value_uq" UNIQUE("user_id","field","value"),
	CONSTRAINT "receipt_field_options_field_ck" CHECK (field in ('vendor', 'category', 'payment_method'))
);
--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "reviewed_fields" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "ocr_source" text;--> statement-breakpoint
ALTER TABLE "receipt_field_options" ADD CONSTRAINT "receipt_field_options_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_field_options_user_id_field_last_used_at_idx" ON "receipt_field_options" USING btree ("user_id","field","last_used_at" desc);--> statement-breakpoint
-- The backfill, hand-written: everything the old query-over-`receipts`
-- version of GET /api/receipts/options would have served, materialised as
-- rows so the new version serves the same vocabulary on its first request.
--
-- One statement per field rather than a UNION, because each needs its own
-- GROUP BY. `max(created_at)` over the receipts carrying a value is exactly
-- the recency the retired query ordered by, so the first options list after
-- this migration comes back in the order the person last saw.
--
-- Soft-deleted receipts are excluded, matching the `visibleTo` scoping the
-- retired query used. That is a one-time reading of history, not the new
-- rule: from here on a delete leaves the option alone (see the table's
-- comment in src/db/schema.ts), because removing an option is now its own
-- endpoint rather than a side effect of destroying a retained tax record.
INSERT INTO "receipt_field_options" ("user_id", "field", "value", "last_used_at")
SELECT "user_id", 'vendor', "vendor", max("created_at")
FROM "receipts"
WHERE "deleted_at" IS NULL AND "vendor" IS NOT NULL
GROUP BY "user_id", "vendor";--> statement-breakpoint
INSERT INTO "receipt_field_options" ("user_id", "field", "value", "last_used_at")
SELECT "user_id", 'category', "category", max("created_at")
FROM "receipts"
WHERE "deleted_at" IS NULL AND "category" IS NOT NULL
GROUP BY "user_id", "category";--> statement-breakpoint
INSERT INTO "receipt_field_options" ("user_id", "field", "value", "last_used_at")
SELECT "user_id", 'payment_method', "payment_method", max("created_at")
FROM "receipts"
WHERE "deleted_at" IS NULL AND "payment_method" IS NOT NULL
GROUP BY "user_id", "payment_method";
