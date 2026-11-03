CREATE TABLE "resignation_policies" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"notice_days" integer DEFAULT 30 NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resignation_policy_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"notice_days" integer NOT NULL,
	"changed_by_user_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resignations" ADD COLUMN "approved_notice_days" integer;--> statement-breakpoint
ALTER TABLE "resignation_policies" ADD CONSTRAINT "resignation_policies_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignation_policy_history" ADD CONSTRAINT "resignation_policy_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;