ALTER TABLE "digests" ADD COLUMN "digest_date" date;--> statement-breakpoint
ALTER TABLE "digests" ADD CONSTRAINT "digests_user_slot_date_uq" UNIQUE("user_id","kind","digest_date");