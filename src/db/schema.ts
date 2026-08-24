import { pgTable, integer, text, jsonb, boolean, timestamp } from 'drizzle-orm/pg-core';

/**
 * Source-of-truth mapping, one row per AniDB anime (~16,865 once fully seeded).
 * Populated from anime-list-master.xml (primary, has per-episode overrides)
 * + Fribb/anime-lists (fallback, reduced format) + lists-main (freshness only).
 */
export const mapping = pgTable('mapping', {
  anidbId: integer('anidb_id').primaryKey(),

  malId: integer('mal_id'),
  anilistId: integer('anilist_id'),
  kitsuId: integer('kitsu_id'),
  livechartId: integer('livechart_id'),
  anisearchId: integer('anisearch_id'),
  animePlanetId: text('anime_planet_id'), // slug, not numeric -- e.g. "cowboy-bebop"
  animeNewsNetworkId: integer('animenewsnetwork_id'),
  animeCountdownId: integer('animecountdown_id'),
  simklId: integer('simkl_id'),

  tvdbId: integer('tvdb_id'),
  tmdbTvId: integer('tmdb_tv_id'),
  tmdbMovieIds: integer('tmdb_movie_ids').array(),
  imdbIds: text('imdb_ids').array(),

  type: text('type'), // TV | MOVIE | OVA | ONA | SPECIAL | HENTAI | UNKNOWN
  title: text('title'), // from anime-list-master.xml's <n> -- single name, not localized

  // from lists-main's anime-airing.json -- a live snapshot of currently-airing
  // shows only. episodeProgress is "episodes aired so far" (nextEpisode - 1),
  // NOT a final/total episode count -- it goes stale the moment a show
  // finishes airing, and says nothing about shows that were never airing
  // during a given ingest run. Getting a reliable total for finished shows
  // is still an open problem, see README.
  airing: boolean('airing').notNull().default(false),
  episodeProgress: integer('episode_progress'),
  nextEpisodeAt: timestamp('next_episode_at', { withTimezone: true }),

  // simple offset model -- used when no per-episode override applies.
  // defaulttvdbseason/tmdbseason in the source XML is USUALLY an integer but
  // can literally be the string "a" (absolute numbering) -- so season is
  // nullable-int, paired with its own absolute flag, rather than trying to
  // cram "a" into an integer column.
  defaultTvdbSeason: integer('default_tvdb_season'),
  tvdbAbsolute: boolean('tvdb_absolute').notNull().default(false), // defaulttvdbseason="a"
  tvdbEpisodeOffset: integer('tvdb_episode_offset'),

  defaultTmdbSeason: integer('default_tmdb_season'),
  tmdbAbsolute: boolean('tmdb_absolute').notNull().default(false), // tmdbseason="a"
  tmdbEpisodeOffset: integer('tmdb_episode_offset'),

  // raw <mapping-list> entries from the XML, kept verbatim -- see resolver.ts
  // for how these take priority over the offset model above
  mappingList: jsonb('mapping_list').$type<MappingListEntry[]>(),

  // where this row's data came from, for debugging / trust weighting
  source: text('source').notNull().default('pending'), // anime-lists-xml | fribb | lists-main | pending

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

/** One entry from an XML <mapping-list>, either a season/range offset or an explicit episode-to-episode link. */
export type MappingListEntry = {
  anidbSeason: number; // 0 = specials, 1 = regular
  tvdbSeason: number | null;
  tmdbSeason: number | null;
  start?: number;
  end?: number;
  offset?: number;
  // explicit overrides, e.g. ";1-1;2-1;" -> anidb ep 1 & 2 both map to tvdb ep 1
  // or ";1-1+2;" -> anidb ep 1 maps to tvdb eps 1 AND 2
  explicit?: Record<number, number[]>;
};

/**
 * Raw TVDB series/episode cache. This is now the canonical episode data
 * source (not just enrichment) -- see README for why AniDB's live API was
 * dropped from the pipeline.
 */
export const tvdbCache = pgTable('tvdb_cache', {
  tvdbId: integer('tvdb_id').primaryKey(),
  rawData: jsonb('raw_data'),
  status: text('status'), // Continuing | Ended
  lastScrapedAt: timestamp('last_scraped_at', { withTimezone: true })
});

/** Final merged record -- this is what /mappings serves. Shape of `data` matches the README example. */
export const anime = pgTable('anime', {
  anidbId: integer('anidb_id').primaryKey().references(() => mapping.anidbId),
  anilistId: integer('anilist_id'),
  malId: integer('mal_id'),
  tvdbId: integer('tvdb_id'),
  data: jsonb('data'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

/** Resumable cursor state, so a job that gets interrupted (redeploy, crash, sleep) picks up where it left off. */
export const indexerState = pgTable('indexer_state', {
  jobName: text('job_name').primaryKey(), // 'anidb_reconcile' | 'tvdb_reconcile' | ...
  cursor: integer('cursor').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
