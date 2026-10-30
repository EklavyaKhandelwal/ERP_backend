CREATE TABLE "resignations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"resignation_date" date NOT NULL,
	"notice_days" integer DEFAULT 30 NOT NULL,
	"proposed_last_day" date NOT NULL,
	"reason" text NOT NULL,
	"remarks" text NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"approved_last_day" date,
	"escalation_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignations" ADD CONSTRAINT "resignations_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resignations_one_pending_per_employee_idx" ON "resignations" USING btree ("employee_id") WHERE "resignations"."status" = 'Pending';