CREATE TABLE "employee_leave_balances" (
	"id" serial PRIMARY KEY NOT NULL,
	"employee_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"annual_balance" integer NOT NULL,
	"annual_total" integer NOT NULL,
	"sick_balance" integer NOT NULL,
	"sick_total" integer NOT NULL,
	"casual_balance" integer NOT NULL,
	"casual_total" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_leave_balances" ADD CONSTRAINT "employee_leave_balances_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_leave_balances_employee_year_idx" ON "employee_leave_balances" USING btree ("employee_id","year");--> statement-breakpoint
INSERT INTO "employee_leave_balances" (
	"employee_id",
	"year",
	"annual_balance",
	"annual_total",
	"sick_balance",
	"sick_total",
	"casual_balance",
	"casual_total"
)
SELECT
	"id",
	EXTRACT(YEAR FROM CURRENT_DATE)::integer,
	"annual_leave",
	"annual_leave_total",
	"sick_leave",
	"sick_leave_total",
	"casual_leave",
	"casual_leave_total"
FROM "employees"
ON CONFLICT ("employee_id", "year") DO NOTHING;