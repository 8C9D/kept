ALTER TABLE "receipts" DROP CONSTRAINT "receipts_confirmed_complete_ck";--> statement-breakpoint
DROP INDEX "receipts_user_id_is_business_idx";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "vendor_tax_number";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "other_tax_cents";--> statement-breakpoint
ALTER TABLE "receipts" DROP COLUMN "is_business";--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_confirmed_complete_ck" CHECK (status <> 'confirmed' OR total_cents IS NOT NULL);