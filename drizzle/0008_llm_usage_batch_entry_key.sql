ALTER TABLE "llm_usage" ADD COLUMN "batch_entry_key" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_user_batch_entry_uq" UNIQUE("user_id","batch_entry_key");