ALTER TABLE "appraisal_reviews" ADD COLUMN "self_challenges" text;--> statement-breakpoint
ALTER TABLE "appraisal_reviews" ADD COLUMN "next_goals" text;--> statement-breakpoint
ALTER TABLE "appraisal_reviews" ADD COLUMN "delivery_rating" integer;--> statement-breakpoint
ALTER TABLE "appraisal_reviews" ADD COLUMN "quality_rating" integer;--> statement-breakpoint
ALTER TABLE "appraisal_reviews" ADD COLUMN "ownership_rating" integer;--> statement-breakpoint
ALTER TABLE "appraisal_reviews" ADD COLUMN "collaboration_rating" integer;--> statement-breakpoint
ALTER TABLE "appraisal_reviews" ADD COLUMN "admin_comments" text;--> statement-breakpoint
UPDATE "appraisal_reviews" SET "status" = 'Admin Review' WHERE "status" = 'Manager Review';--> statement-breakpoint
UPDATE "notifications" SET "category" = 'appraisalCycleUpdates' WHERE "category" = 'appraisalDeadlines';--> statement-breakpoint
UPDATE "notification_preferences"
SET "preferences" = ("preferences" - 'appraisalDeadlines') || jsonb_build_object('appraisalCycleUpdates', "preferences"->'appraisalDeadlines')
WHERE "preferences" ? 'appraisalDeadlines';