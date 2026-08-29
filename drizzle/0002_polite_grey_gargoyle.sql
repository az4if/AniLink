ALTER TABLE "ani_zip_cache" ADD COLUMN "api_data" jsonb;--> statement-breakpoint
ALTER TABLE "ani_zip_cache" ADD COLUMN "api_scraped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mapping" ADD COLUMN "notifymoe_id" integer;