CREATE TABLE IF NOT EXISTS "anilist_cache" (
	"anilist_id" integer PRIMARY KEY NOT NULL,
	"raw_data" jsonb NOT NULL,
	"format" text,
	"status" text,
	"episode_count" integer,
	"next_episode" integer,
	"last_scraped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "anime_segment" (
	"segment_key" text PRIMARY KEY NOT NULL,
	"anidb_id" integer NOT NULL,
	"anilist_id" integer NOT NULL,
	"relation_type" text NOT NULL,
	"format" text,
	"title" text,
	"start_date" text,
	"end_date" text,
	"episode_start" integer,
	"episode_end" integer,
	"confidence" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "anime_segment" ADD CONSTRAINT "anime_segment_anidb_id_mapping_anidb_id_fk" FOREIGN KEY ("anidb_id") REFERENCES "public"."mapping"("anidb_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
