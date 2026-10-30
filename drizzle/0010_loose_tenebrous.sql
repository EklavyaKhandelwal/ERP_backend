CREATE TABLE "admin_invite_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_invite_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_owner" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "has_completed_setup" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_invite_tokens" ADD CONSTRAINT "admin_invite_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_invite_tokens" ADD CONSTRAINT "admin_invite_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "users"
SET "is_owner" = true
WHERE "id" = (
	SELECT "id" FROM "users"
	WHERE "role" = 'admin'
	ORDER BY "created_at" ASC, "id" ASC
	LIMIT 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_owner_idx" ON "users" USING btree ("is_owner") WHERE "users"."is_owner" = true;