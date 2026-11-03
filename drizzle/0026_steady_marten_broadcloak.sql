ALTER TABLE "users" ADD COLUMN "phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "location" text DEFAULT 'Remote' NOT NULL;--> statement-breakpoint
UPDATE "users" AS "user"
SET
  "phone" = "employee"."phone",
  "date_of_birth" = "employee"."date_of_birth",
  "location" = "employee"."location"
FROM "employees" AS "employee"
WHERE "employee"."user_id" = "user"."id";--> statement-breakpoint
