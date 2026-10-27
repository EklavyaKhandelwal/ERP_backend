CREATE TABLE "appraisal_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"cycle" text NOT NULL,
	"status" text DEFAULT 'Self Assessment' NOT NULL,
	"self_rating" numeric(2, 1),
	"self_comments" text,
	"goals_achieved" text,
	"manager_rating" numeric(2, 1),
	"manager_comments" text,
	"overall_rating" numeric(2, 1),
	"completed_by_user_id" uuid,
	"completed_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appraisal_reviews" ADD CONSTRAINT "appraisal_reviews_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appraisal_reviews" ADD CONSTRAINT "appraisal_reviews_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "appraisal_reviews_employee_cycle_idx" ON "appraisal_reviews" USING btree ("employee_id","cycle");