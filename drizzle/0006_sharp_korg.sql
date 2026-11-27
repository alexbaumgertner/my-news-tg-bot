ALTER TABLE "stories" ADD COLUMN "prefilter_status" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "prefilter_reason" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "prefilter_topics" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "prefilter_similarity" real;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "prefilter_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "stories_user_prefilter_idx" ON "stories" USING btree ("user_id","prefilter_status","id");--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_prefilter_status_ck" CHECK ("stories"."prefilter_status" is null or "stories"."prefilter_status" in ('passed', 'dropped'));