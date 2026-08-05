CREATE TYPE "public"."receipt_status" AS ENUM('pending', 'confirmed');--> statement-breakpoint
CREATE TABLE "receipt_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"page" smallint NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_images_receipt_id_page_uq" UNIQUE("receipt_id","page"),
	CONSTRAINT "receipt_images_receipt_id_sha256_uq" UNIQUE("receipt_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purchased_at" date NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"vendor" text NOT NULL,
	"vendor_tax_number" text,
	"subtotal_cents" integer,
	"hst_cents" integer,
	"other_tax_cents" integer,
	"total_cents" integer NOT NULL,
	"currency" char(3) DEFAULT 'CAD' NOT NULL,
	"category" text,
	"payment_method" text,
	"is_business" boolean NOT NULL,
	"notes" text,
	"status" "receipt_status" NOT NULL,
	"ocr_raw_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"apple_sub" text NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"fiscal_year_end_month" smallint DEFAULT 12 NOT NULL,
	"fiscal_year_end_day" smallint DEFAULT 31 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_apple_sub_unique" UNIQUE("apple_sub")
);
--> statement-breakpoint
ALTER TABLE "receipt_images" ADD CONSTRAINT "receipt_images_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipts_user_id_purchased_at_idx" ON "receipts" USING btree ("user_id","purchased_at");--> statement-breakpoint
CREATE INDEX "receipts_user_id_is_business_idx" ON "receipts" USING btree ("user_id","is_business");--> statement-breakpoint
CREATE INDEX "receipts_user_id_status_idx" ON "receipts" USING btree ("user_id","status");