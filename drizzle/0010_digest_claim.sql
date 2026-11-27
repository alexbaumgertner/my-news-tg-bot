ALTER TABLE "digests" ADD COLUMN "status" text DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "digests" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_status_check" CHECK ("digests"."status" in ('claimed', 'sent', 'failed'));