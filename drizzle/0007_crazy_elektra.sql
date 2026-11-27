CREATE TABLE "llm_batches" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "llm_batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"provider_batch_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"entries" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "llm_batches_user_provider_uq" UNIQUE("user_id","provider_batch_id"),
	CONSTRAINT "llm_batches_status_ck" CHECK ("llm_batches"."status" in ('pending', 'ended'))
);
--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "representative_item_id" bigint;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "score_failed_item_id" bigint;--> statement-breakpoint
CREATE INDEX "llm_batches_user_status_idx" ON "llm_batches" USING btree ("user_id","status");--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_representative_item_id_items_id_fk" FOREIGN KEY ("representative_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;