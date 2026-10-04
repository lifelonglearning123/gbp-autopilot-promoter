ALTER TABLE "agency_research" ADD COLUMN "raw_text" text;--> statement-breakpoint
ALTER TABLE "agency_research" ADD COLUMN "signals" jsonb DEFAULT '{}'::jsonb NOT NULL;