CREATE TABLE IF NOT EXISTS "anime" (
	"anidb_id" integer PRIMARY KEY NOT NULL,
	"anilist_id" integer,
	"mal_id" integer,
	"tvdb_id" integer,
	"data" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "indexer_state" (
	"job_name" text PRIMARY KEY NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mapping" (
	"anidb_id" integer PRIMARY KEY NOT NULL,
	"mal_id" integer,
	"anilist_id" integer,
	"kitsu_id" integer,
	"livechart_id" integer,
	"anisearch_id" integer,
	"anime_planet_id" text,
	"animenewsnetwork_id" integer,
	"animecountdown_id" integer,
	"simkl_id" integer,
	"tvdb_id" integer,
	"tmdb_tv_id" integer,
	"tmdb_movie_ids" integer[],
	"imdb_ids" text[],
	"type" text,
	"title" text,
	"airing" boolean DEFAULT false NOT NULL,
	"episode_progress" integer,
	"next_episode_at" timestamp with time zone,
	"default_tvdb_season" integer,
	"tvdb_absolute" boolean DEFAULT false NOT NULL,
	"tvdb_episode_offset" integer,
	"default_tmdb_season" integer,
	"tmdb_absolute" boolean DEFAULT false NOT NULL,
	"tmdb_episode_offset" integer,
	"mapping_list" jsonb,
	"source" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tvdb_cache" (
	"tvdb_id" integer PRIMARY KEY NOT NULL,
	"raw_data" jsonb,
	"status" text,
	"last_scraped_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "anime" ADD CONSTRAINT "anime_anidb_id_mapping_anidb_id_fk" FOREIGN KEY ("anidb_id") REFERENCES "public"."mapping"("anidb_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
