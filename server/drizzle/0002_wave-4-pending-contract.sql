ALTER TABLE "receipts" ALTER COLUMN "total_cents" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ALTER COLUMN "is_business" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "receipts" ADD COLUMN "ocr_suggestions" jsonb;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_confirmed_complete_ck" CHECK (status <> 'confirmed' OR (total_cents IS NOT NULL AND is_business IS NOT NULL));