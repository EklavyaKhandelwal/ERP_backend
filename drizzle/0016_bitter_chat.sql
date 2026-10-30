ALTER TABLE "timesheet_entries" ADD COLUMN "daily_descriptions" jsonb DEFAULT '{"mon":"","tue":"","wed":"","thu":"","fri":"","sat":"","sun":""}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "work_completed" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "next_week_focus" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "timesheets" ADD COLUMN "blockers" text DEFAULT '' NOT NULL;