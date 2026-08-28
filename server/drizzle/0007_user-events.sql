CREATE TABLE "user_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client" text NOT NULL,
	"app_version" text,
	"action" text NOT NULL,
	"field" text,
	"receipt_id" uuid,
	"duration_ms" integer,
	"count" integer
);
--> statement-breakpoint
ALTER TABLE "user_events" ADD CONSTRAINT "user_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_events_user_id_occurred_at_idx" ON "user_events" USING btree ("user_id","occurred_at");