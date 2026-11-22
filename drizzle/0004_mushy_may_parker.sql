CREATE TABLE IF NOT EXISTS "catalog_entry" (
	"key" text PRIMARY KEY NOT NULL,
	"anidb_id" integer,
	"anilist_id" integer,
	"mal_id" integer,
	"kitsu_id" integer,
	"anisearch_id" integer,
	"livechart_id" integer,
	"anime_planet_id" text,
	"animenewsnetwork_id" integer,
	"animecountdown_id" integer,
	"simkl_id" integer,
	"title" text NOT NULL,
	"type" text,
	"episodes" integer,
	"status" text,
	"season" text,
	"season_year" integer,
	"duration_seconds" integer,
	"score" double precision,
	"picture" text,
	"thumbnail" text,
	"synonyms" text[] NOT NULL,
	"studios" text[] NOT NULL,
	"producers" text[] NOT NULL,
	"tags" text[] NOT NULL,
	"related" jsonb NOT NULL,
	"sources" text[] NOT NULL,
	"source_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mapping_override" (
	"anidb_id" integer NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mapping_override_anidb_id_field_pk" PRIMARY KEY("anidb_id","field")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_state" (
	"source_key" text PRIMARY KEY NOT NULL,
	"etag" text,
	"last_modified" text,
	"content_hash" text,
	"content_length" integer,
	"row_count" integer,
	"last_status" text,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_entry_anidb_idx" ON "catalog_entry" USING btree ("anidb_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_entry_anilist_idx" ON "catalog_entry" USING btree ("anilist_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_entry_mal_idx" ON "catalog_entry" USING btree ("mal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_entry_kitsu_idx" ON "catalog_entry" USING btree ("kitsu_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_entry_anisearch_idx" ON "catalog_entry" USING btree ("anisearch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_entry_livechart_idx" ON "catalog_entry" USING btree ("livechart_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_entry_animeplanet_idx" ON "catalog_entry" USING btree ("anime_planet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_entry_hash_idx" ON "catalog_entry" USING btree ("source_hash");