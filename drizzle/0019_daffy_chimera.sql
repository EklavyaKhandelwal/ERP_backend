CREATE TABLE "attendance_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attendance_record_id" uuid NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"previous_clock_in_at" timestamp with time zone NOT NULL,
	"previous_clock_out_at" timestamp with time zone,
	"new_clock_in_at" timestamp with time zone NOT NULL,
	"new_clock_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"clock_in_at" timestamp with time zone NOT NULL,
	"clock_out_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_attendance_record_id_attendance_records_id_fk" FOREIGN KEY ("attendance_record_id") REFERENCES "public"."attendance_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_adjustments" ADD CONSTRAINT "attendance_adjustments_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_adjustments_record_created_idx" ON "attendance_adjustments" USING btree ("attendance_record_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_one_open_per_employee_idx" ON "attendance_records" USING btree ("employee_id") WHERE "attendance_records"."clock_out_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_employee_clock_in_idx" ON "attendance_records" USING btree ("employee_id","clock_in_at");