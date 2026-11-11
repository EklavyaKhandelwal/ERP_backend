CREATE TABLE "sales_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" text NOT NULL,
	"industry" text DEFAULT '' NOT NULL,
	"website" text DEFAULT '' NOT NULL,
	"linkedin_url" text DEFAULT '' NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"owner_employee_id" uuid NOT NULL,
	"status" text DEFAULT 'Prospect' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"type" text NOT NULL,
	"activity_date" date NOT NULL,
	"remarks" text NOT NULL,
	"next_follow_up_date" date,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"designation" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"linkedin_url" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"name" text NOT NULL,
	"service_interest" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'New' NOT NULL,
	"assigned_employee_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"contact_id" uuid,
	"name" text NOT NULL,
	"service_required" text NOT NULL,
	"stage" text DEFAULT 'Prospecting' NOT NULL,
	"expected_closing_date" date,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_technologies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sales_access" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_accounts" ADD CONSTRAINT "sales_accounts_owner_employee_id_employees_id_fk" FOREIGN KEY ("owner_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_accounts" ADD CONSTRAINT "sales_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_account_id_sales_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sales_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_contact_id_sales_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."sales_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_contacts" ADD CONSTRAINT "sales_contacts_account_id_sales_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sales_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_account_id_sales_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sales_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_contact_id_sales_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."sales_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_assigned_employee_id_employees_id_fk" FOREIGN KEY ("assigned_employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_notes" ADD CONSTRAINT "sales_notes_account_id_sales_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sales_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_notes" ADD CONSTRAINT "sales_notes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_account_id_sales_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sales_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_opportunities" ADD CONSTRAINT "sales_opportunities_contact_id_sales_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."sales_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_technologies" ADD CONSTRAINT "sales_technologies_account_id_sales_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."sales_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_accounts_owner_status_idx" ON "sales_accounts" USING btree ("owner_employee_id","status");--> statement-breakpoint
CREATE INDEX "sales_accounts_name_idx" ON "sales_accounts" USING btree ("company_name");--> statement-breakpoint
CREATE INDEX "sales_activities_account_date_idx" ON "sales_activities" USING btree ("account_id","activity_date");--> statement-breakpoint
CREATE INDEX "sales_contacts_account_idx" ON "sales_contacts" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sales_leads_account_idx" ON "sales_leads" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "sales_notes_account_created_idx" ON "sales_notes" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "sales_opportunities_account_idx" ON "sales_opportunities" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_technologies_account_name_idx" ON "sales_technologies" USING btree ("account_id","name");