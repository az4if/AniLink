import { pgTable, integer, text, jsonb, boolean, timestamp, doublePrecision, index, primaryKey } from 'drizzle-orm/pg-core';
import type { CatalogRelated } from '../mapping/aod.js';

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
  notifyMoeId: integer('notifymoe_id'),

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

/** TMDB TV and movie payloads. cacheKey is `${mediaType}:${tmdbId}`. */
export const tmdbCache = pgTable('tmdb_cache', {
  cacheKey: text('cache_key').primaryKey(),
  tmdbId: integer('tmdb_id').notNull(),
  mediaType: text('media_type').notNull(), // tv | movie
  rawData: jsonb('raw_data'),
  status: text('status'),
  lastScrapedAt: timestamp('last_scraped_at', { withTimezone: true })
});

/**
 * Optional local ani.zip source.  Keeping its complete record makes the
 * importer lossless: new fields in the archive are not discarded while the
 * mapping indexer continues to use the normalized IDs above.
 */
export const aniZipCache = pgTable('ani_zip_cache', {
  anidbId: integer('anidb_id').primaryKey().references(() => mapping.anidbId),
  rawData: jsonb('raw_data').notNull(),
  lastImportedAt: timestamp('last_imported_at', { withTimezone: true }).notNull().defaultNow(),
  // Remote API data is kept separate from a user-provided local archive so
  // each source remains lossless and independently refreshable.
  apiData: jsonb('api_data'),
  apiScrapedAt: timestamp('api_scraped_at', { withTimezone: true })
});

/** Full AniList media records, including dates, relation graph and airing state. */
export const anilistCache = pgTable('anilist_cache', {
  anilistId: integer('anilist_id').primaryKey(),
  rawData: jsonb('raw_data').notNull(),
  format: text('format'),
  status: text('status'),
  episodeCount: integer('episode_count'),
  nextEpisode: integer('next_episode'),
  lastScrapedAt: timestamp('last_scraped_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * A reviewable AniDB ↔ AniList segment. Direct IDs are confirmed mappings;
 * franchise relations are candidates only until provider evidence supports a
 * combined range. This avoids silently joining unrelated cours/specials.
 */
export const animeSegment = pgTable('anime_segment', {
  segmentKey: text('segment_key').primaryKey(), // `${anidbId}:${anilistId}`
  anidbId: integer('anidb_id').notNull().references(() => mapping.anidbId),
  anilistId: integer('anilist_id').notNull(),
  relationType: text('relation_type').notNull(), // SELF | PREQUEL | SEQUEL | SIDE_STORY | PARENT | ...
  format: text('format'), // TV | OVA | ONA | SPECIAL | MOVIE | ...
  title: text('title'),
  startDate: text('start_date'),
  endDate: text('end_date'),
  episodeStart: integer('episode_start'),
  episodeEnd: integer('episode_end'),
  confidence: integer('confidence').notNull(), // 0-100; direct mapping = 100
  evidence: jsonb('evidence').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
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

/**
 * What we last saw of each remote source, so an unchanged file is not
 * re-downloaded/re-processed and a suspiciously shrunken one is rejected.
 * `fingerprint` columns are only written after a source was fully processed;
 * `rowCount` is the baseline the size guard compares the next download against.
 */
export const sourceState = pgTable('source_state', {
  sourceKey: text('source_key').primaryKey(), // 'anime-list-master-xml' | 'fribb' | 'lists-anime' | 'lists-airing' | 'aod'
  etag: text('etag'),
  lastModified: text('last_modified'),
  contentHash: text('content_hash'), // sha256 of the body
  contentLength: integer('content_length'),
  rowCount: integer('row_count'),
  lastStatus: text('last_status'), // changed | unchanged | rejected | error
  lastError: text('last_error'),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastChangedAt: timestamp('last_changed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

/**
 * Hand-curated corrections applied to `mapping` after every sync (see
 * src/mapping/overrides.ts). One row per (anime, column). A `value` of
 * 'null' means "force this column empty". No foreign key on purpose: an override can
 * be filed for an AniDB id the sources have not delivered yet.
 */
export const mappingOverride = pgTable(
  'mapping_override',
  {
    anidbId: integer('anidb_id').notNull(),
    field: text('field').notNull(), // a key of OVERRIDABLE_FIELDS
    // JSON-encoded text ('98765', '"cowboy-bebop"', '[1,2]', 'null'), not jsonb: the
    // value's JSON type is part of the data (a numeric-looking slug must stay a
    // string) and a driver round-trip through jsonb can silently re-type it.
    // 'null' means "force this column empty".
    value: text('value').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.anidbId, table.field] })]
);

/**
 * cedya77/anime-offline-database, one row per upstream entry. Unlike `mapping`
 * this is NOT keyed on AniDB: ~60% of the dataset has no AniDB id, and those
 * titles are still reachable here by their AniList/MAL/Kitsu/... id. Replaced
 * wholesale on each changed download (rows from older downloads are deleted by
 * `source_hash`). Also gap-fills `mapping` and supplies fallback images.
 */
export const catalogEntry = pgTable(
  'catalog_entry',
  {
    key: text('key').primaryKey(), // e.g. 'anilist:1' -- first available id, see aod.ts
    anidbId: integer('anidb_id'),
    anilistId: integer('anilist_id'),
    malId: integer('mal_id'),
    kitsuId: integer('kitsu_id'),
    anisearchId: integer('anisearch_id'),
    livechartId: integer('livechart_id'),
    animePlanetId: text('anime_planet_id'),
    animeNewsNetworkId: integer('animenewsnetwork_id'),
    animeCountdownId: integer('animecountdown_id'),
    simklId: integer('simkl_id'),

    title: text('title').notNull(),
    type: text('type'), // TV | MOVIE | OVA | ONA | SPECIAL | UNKNOWN
    episodes: integer('episodes'), // null = unknown (upstream writes 0)
    status: text('status'), // FINISHED | ONGOING | UPCOMING | UNKNOWN
    season: text('season'), // WINTER | SPRING | SUMMER | FALL
    seasonYear: integer('season_year'),
    durationSeconds: integer('duration_seconds'),
    score: doublePrecision('score'), // community mean, 1-10
    picture: text('picture'), // null when upstream only had its shared placeholder
    thumbnail: text('thumbnail'),
    synonyms: text('synonyms').array().notNull(),
    studios: text('studios').array().notNull(),
    producers: text('producers').array().notNull(),
    tags: text('tags').array().notNull(),
    related: jsonb('related').$type<CatalogRelated>().notNull(),
    sources: text('sources').array().notNull(), // the provider URLs the ids were read from

    sourceHash: text('source_hash').notNull(), // sha256 of the download this row came from
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index('catalog_entry_anidb_idx').on(table.anidbId),
    index('catalog_entry_anilist_idx').on(table.anilistId),
    index('catalog_entry_mal_idx').on(table.malId),
    index('catalog_entry_kitsu_idx').on(table.kitsuId),
    index('catalog_entry_anisearch_idx').on(table.anisearchId),
    index('catalog_entry_livechart_idx').on(table.livechartId),
    index('catalog_entry_animeplanet_idx').on(table.animePlanetId),
    index('catalog_entry_hash_idx').on(table.sourceHash)
  ]
);
