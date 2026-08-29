CREATE TABLE IF NOT EXISTS "ani_zip_cache" (
	"anidb_id" integer PRIMARY KEY NOT NULL,
	"raw_data" jsonb NOT NULL,
	"last_imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tmdb_cache" (
	"cache_key" text PRIMARY KEY NOT NULL,
	"tmdb_id" integer NOT NULL,
	"media_type" text NOT NULL,
	"raw_data" jsonb,
	"status" text,
	"last_scraped_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ani_zip_cache" ADD CONSTRAINT "ani_zip_cache_anidb_id_mapping_anidb_id_fk" FOREIGN KEY ("anidb_id") REFERENCES "public"."mapping"("anidb_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
