CREATE TABLE "controls" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "hold_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "alerted_at" timestamp with time zone;