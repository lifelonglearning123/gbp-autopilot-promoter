ALTER TABLE "messages" ADD COLUMN "instantly_campaign_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "instantly_lead_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "pushed_at" timestamp with time zone;