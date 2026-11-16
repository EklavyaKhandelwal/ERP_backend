ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_idx" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "sales_activities_follow_up_idx" ON "sales_activities" USING btree ("next_follow_up_date","account_id");