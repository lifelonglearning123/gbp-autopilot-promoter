CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" text NOT NULL,
	"title" text NOT NULL,
	"handle" text,
	"country" text,
	"subscribers" integer,
	"video_count" integer,
	"description" text,
	"recent_videos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"found_by" text,
	"status" text DEFAULT 'new' NOT NULL,
	"kind" text,
	"fit_score" integer,
	"uses_ghl" boolean,
	"qualify_notes" text,
	"links" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agency_id" uuid,
	"ghl_contact_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"target" text NOT NULL,
	"message" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"ghl_task_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creators" ADD CONSTRAINT "creators_agency_id_agencies_id_fk" FOREIGN KEY ("agency_id") REFERENCES "public"."agencies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_tasks" ADD CONSTRAINT "outreach_tasks_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creators_channel_idx" ON "creators" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "creators_status_idx" ON "creators" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outreach_tasks_due_idx" ON "outreach_tasks" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "outreach_tasks_creator_idx" ON "outreach_tasks" USING btree ("creator_id");