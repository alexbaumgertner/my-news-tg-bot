ALTER TABLE "stories" ADD COLUMN "last_item_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "representative_item_id" bigint;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_representative_item_id_items_id_fk" FOREIGN KEY ("representative_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stories_user_last_item_idx" ON "stories" USING btree ("user_id","last_item_at");