ALTER TABLE "employees" ALTER COLUMN "salary" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "salary" SET DATA TYPE text USING "salary"::text;--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "bank_name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "bank_account_number" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "basic_salary_master" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "basic_salary_master" SET DATA TYPE text USING "basic_salary_master"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "hra_master" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "hra_master" SET DATA TYPE text USING "hra_master"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "special_allowance_master" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "special_allowance_master" SET DATA TYPE text USING "special_allowance_master"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "bonus_master" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "bonus_master" SET DATA TYPE text USING "bonus_master"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "basic_salary" SET DATA TYPE text USING "basic_salary"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "hra" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "hra" SET DATA TYPE text USING "hra"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "special_allowance" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "special_allowance" SET DATA TYPE text USING "special_allowance"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "bonus" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "bonus" SET DATA TYPE text USING "bonus"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "provident_fund" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "provident_fund" SET DATA TYPE text USING "provident_fund"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "professional_tax" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "professional_tax" SET DATA TYPE text USING "professional_tax"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "income_tax" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "income_tax" SET DATA TYPE text USING "income_tax"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "total_earnings" SET DATA TYPE text USING "total_earnings"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "total_deductions" SET DATA TYPE text USING "total_deductions"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "net_pay" SET DATA TYPE text USING "net_pay"::text;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "bank_name" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "bank_account_number" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "pan_number" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "provident_fund_number" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "payroll_records" ALTER COLUMN "provident_fund_uan" DROP DEFAULT;
