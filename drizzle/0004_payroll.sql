CREATE TABLE "payroll_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"basic_salary" numeric(14, 2) NOT NULL,
	"hra" numeric(14, 2) DEFAULT 0 NOT NULL,
	"special_allowance" numeric(14, 2) DEFAULT 0 NOT NULL,
	"bonus" numeric(14, 2) DEFAULT 0 NOT NULL,
	"provident_fund" numeric(14, 2) DEFAULT 0 NOT NULL,
	"professional_tax" numeric(14, 2) DEFAULT 0 NOT NULL,
	"income_tax" numeric(14, 2) DEFAULT 0 NOT NULL,
	"total_earnings" numeric(14, 2) NOT NULL,
	"total_deductions" numeric(14, 2) NOT NULL,
	"net_pay" numeric(14, 2) NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"payment_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_period" date NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payroll_runs_pay_period_unique" UNIQUE("pay_period")
);
--> statement-breakpoint
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD CONSTRAINT "payroll_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_records_run_employee_idx" ON "payroll_records" USING btree ("run_id","employee_id");