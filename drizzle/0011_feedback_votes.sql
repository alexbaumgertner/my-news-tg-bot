CREATE TABLE "weight_adjustments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "weight_adjustments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint NOT NULL,
	"dimension" text NOT NULL,
	"key" text NOT NULL,
	"multiplier" real NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weight_adjustments_user_dim_key_uq" UNIQUE("user_id","dimension","key"),
	CONSTRAINT "weight_adjustments_dimension_check" CHECK ("weight_adjustments"."dimension" in ('topic', 'source'))
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "story_id" bigint;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "topics" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "source_id" bigint;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_digest_item_uq" UNIQUE("user_id","digest_item_id");--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_kind_check" CHECK ("feedback"."kind" in ('up', 'down'));