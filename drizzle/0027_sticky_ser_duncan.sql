CREATE TABLE "payroll_record_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payroll_record_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"note" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "basic_salary_master" numeric(14, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "hra_master" numeric(14, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "special_allowance_master" numeric(14, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "bonus_master" numeric(14, 2) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "effective_work_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "loss_of_pay_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "bank_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "bank_account_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "pan_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "provident_fund_number" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "provident_fund_uan" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "other_details" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "payslip_status" text DEFAULT 'Draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payroll_records" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
UPDATE "payroll_records" AS "record"
SET
	"basic_salary_master" = "record"."basic_salary",
	"hra_master" = "record"."hra",
	"special_allowance_master" = "record"."special_allowance",
	"bonus_master" = "record"."bonus",
	"effective_work_days" = EXTRACT(DAY FROM (date_trunc('month', "run"."pay_period") + INTERVAL '1 month - 1 day'))::integer,
	"payslip_status" = 'Published',
	"published_at" = "record"."created_at"
FROM "payroll_runs" AS "run"
WHERE "run"."id" = "record"."run_id";--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "payslip_status" SET DEFAULT 'Draft';--> statement-breakpoint
ALTER TABLE "payroll_record_revisions" ADD CONSTRAINT "payroll_record_revisions_payroll_record_id_payroll_records_id_fk" FOREIGN KEY ("payroll_record_id") REFERENCES "public"."payroll_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_record_revisions" ADD CONSTRAINT "payroll_record_revisions_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_record_revisions_record_revision_idx" ON "payroll_record_revisions" USING btree ("payroll_record_id","revision");--> statement-breakpoint
CREATE INDEX "payroll_record_revisions_record_created_idx" ON "payroll_record_revisions" USING btree ("payroll_record_id","created_at");