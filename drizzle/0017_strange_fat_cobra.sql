CREATE TABLE "leave_policies" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"annual_days" integer DEFAULT 20 NOT NULL,
	"sick_days" integer DEFAULT 10 NOT NULL,
	"casual_days" integer DEFAULT 6 NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_policy_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"annual_days" integer NOT NULL,
	"sick_days" integer NOT NULL,
	"casual_days" integer NOT NULL,
	"changed_by_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leave_policies" ADD CONSTRAINT "leave_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_policy_history" ADD CONSTRAINT "leave_policy_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;