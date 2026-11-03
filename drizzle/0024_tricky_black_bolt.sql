CREATE TABLE "resignation_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resignation_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"responsible_party" text DEFAULT '' NOT NULL,
	"due_date" date,
	"note" text DEFAULT '' NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resignation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resignation_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"description" text NOT NULL,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resignation_policies" ADD COLUMN "review_reminder_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "resignation_policy_history" ADD COLUMN "review_reminder_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "resignation_checklist_items" ADD CONSTRAINT "resignation_checklist_items_resignation_id_resignations_id_fk" FOREIGN KEY ("resignation_id") REFERENCES "public"."resignations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignation_checklist_items" ADD CONSTRAINT "resignation_checklist_items_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignation_events" ADD CONSTRAINT "resignation_events_resignation_id_resignations_id_fk" FOREIGN KEY ("resignation_id") REFERENCES "public"."resignations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resignation_events" ADD CONSTRAINT "resignation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resignation_checklist_application_item_idx" ON "resignation_checklist_items" USING btree ("resignation_id","item_key");--> statement-breakpoint
CREATE INDEX "resignation_checklist_application_idx" ON "resignation_checklist_items" USING btree ("resignation_id");--> statement-breakpoint
CREATE INDEX "resignation_events_application_created_idx" ON "resignation_events" USING btree ("resignation_id","created_at");--> statement-breakpoint
INSERT INTO "resignation_events" ("resignation_id", "event_type", "description", "actor_user_id", "created_at")
SELECT r."id", 'Submitted',
	'Resignation request submitted with a proposed last working day of ' || r."proposed_last_day" || '.',
	e."user_id", r."created_at"
FROM "resignations" r
INNER JOIN "employees" e ON e."id" = r."employee_id";--> statement-breakpoint
INSERT INTO "resignation_events" ("resignation_id", "event_type", "description", "actor_user_id", "created_at")
SELECT r."id", r."status",
	CASE WHEN r."status" = 'Approved'
		THEN 'Approved with confirmed last working day ' || COALESCE(r."approved_last_day", r."proposed_last_day") || '.'
		ELSE 'Rejected.'
	END || CASE WHEN COALESCE(r."review_note", '') = '' THEN '' ELSE ' HR note: ' || r."review_note" END,
	r."reviewed_by_user_id", r."reviewed_at"
FROM "resignations" r
WHERE r."status" <> 'Pending' AND r."reviewed_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "resignation_checklist_items" ("resignation_id", "item_key", "title")
SELECT r."id", checklist."item_key", checklist."title"
FROM "resignations" r
CROSS JOIN (VALUES
	('handover', 'Knowledge and work handover'),
	('company-property', 'Return company property'),
	('access-removal', 'Review and remove system access'),
	('final-paperwork', 'Complete final paperwork and clearance')
) AS checklist("item_key", "title")
WHERE r."status" = 'Approved';--> statement-breakpoint