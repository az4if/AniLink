import { sql } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { runChunked, type YieldCtx } from './chunked-runner.js';
import { loadSource } from './source-state.js';
import type { SourceSyncOptions } from './guarded-source.js';

const SOURCE_KEY = 'fribb';

export type FribbEntry = {
  anidb_id?: number;
  anilist_id?: number;
  mal_id?: number;
  kitsu_id?: number;
  livechart_id?: number;
  anisearch_id?: number;
  simkl_id?: number;
  animenewsnetwork_id?: number;
  animecountdown_id?: number;
  'anime-planet_id'?: string;
  type?: string;
  // These four ARE used, but only as a gap-fill (COALESCE) -- XML's
  // per-episode mapping-list is richer than anything a flat season+offset
  // pair can express, so it always wins when both sources have a value.
  // Fribb only fills in anime the XML pass left completely unmapped.
  tvdb_id?: number;
  themoviedb_id?: { tv?: number; movie?: number[] };
  imdb_id?: string[];
  season?: { tvdb?: number; tmdb?: number };
  episode_offset?: { tvdb?: number; tmdb?: number };
};

function parseFribbJson(text: string): FribbEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('Fribb-format mapping JSON is not an array -- unexpected format');
  return parsed as FribbEntry[];
}

const hasAnidbId = (e: FribbEntry): e is FribbEntry & { anidb_id: number } => typeof e.anidb_id === 'number';

function excluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/** COALESCE(current column value, incoming value) -- fills a gap, never overwrites. */
function coalesceExcluded(column: unknown, excludedColumn: string) {
  return sql`COALESCE(${column}, ${excluded(excludedColumn)})`;
}

/** Pure transform, exported so it can be unit tested without a DB connection. */
export function toFribbDbRow(e: FribbEntry & { anidb_id: number }) {
  return {
    anidbId: e.anidb_id,
    anilistId: e.anilist_id ?? null,
    malId: e.mal_id ?? null,
    kitsuId: e.kitsu_id ?? null,
    livechartId: e.livechart_id ?? null,
    anisearchId: e.anisearch_id ?? null,
    simklId: e.simkl_id ?? null,
    animeNewsNetworkId: e.animenewsnetwork_id ?? null,
    animeCountdownId: e.animecountdown_id ?? null,
    animePlanetId: e['anime-planet_id'] ?? null,
    type: e.type ?? null,
    // gap-fill candidates -- see coalesceExcluded() usage below
    tvdbId: e.tvdb_id ?? null,
    tmdbTvId: e.themoviedb_id?.tv ?? null,
    tmdbMovieIds: e.themoviedb_id?.movie && e.themoviedb_id.movie.length > 0 ? e.themoviedb_id.movie : null,
    imdbIds: e.imdb_id && e.imdb_id.length > 0 ? e.imdb_id : null,
    defaultTvdbSeason: e.season?.tvdb ?? null,
    tvdbEpisodeOffset: e.episode_offset?.tvdb ?? null,
    defaultTmdbSeason: e.season?.tmdb ?? null,
    tmdbEpisodeOffset: e.episode_offset?.tmdb ?? null
  };
}

/**
 * Backfills from a Fribb-format anime-list-full.json onto `mapping`. Only
 * touches entries that carry an anidb_id -- everything else in that file
 * (AniList/MAL-only entries with no AniDB association) is outside our
 * AniDB-anchored catalog and skipped. Resumable/yield-aware, see
 * chunked-runner.ts.
 *
 * Two different update behaviors in one pass:
 *  - id fields (anilist/mal/kitsu/livechart/...) + type: always overwritten
 *    -- XML doesn't have these at all, Fribb is authoritative for them.
 *  - tvdb/tmdb/imdb/season/offset: gap-filled via COALESCE only -- XML's
 *    mapping-list is richer than these flat fields, so XML always wins
 *    when it has a value; Fribb only fills anime XML left unmapped.
 */
export async function ingestFribb(
  entries?: FribbEntry[],
  ctx?: YieldCtx,
  options: SourceSyncOptions = {}
): Promise<{ total: number; skippedNoAnidbId: number; added: number[]; done: boolean; skipped?: string }> {
  let all: FribbEntry[];
  let commit: (() => Promise<void>) | null = null;

  if (entries !== undefined) {
    all = entries;
  } else {
    // The size guard counts only entries with an AniDB id: those are the ones this pass uses.
    const loaded = await loadSource({
      key: SOURCE_KEY,
      url: Config.sources.fribbJsonUrl,
      label: 'Fribb-format mapping JSON',
      force: options.force,
      parse: parseFribbJson,
      count: (parsed) => parsed.filter(hasAnidbId).length
    });
    if (loaded.skipped) return { total: 0, skippedNoAnidbId: 0, added: [], done: true, skipped: loaded.reason };
    all = loaded.data;
    commit = loaded.commit;
  }
  const withAnidbId = all.filter(hasAnidbId);

  const result = await runChunked(
    'mapping-fribb',
    withAnidbId,
    500,
    (e) => e.anidb_id,
    async (chunk) => {
      await db
        .insert(schema.mapping)
        .values(chunk.map(toFribbDbRow))
        .onConflictDoUpdate({
          target: schema.mapping.anidbId,
          set: {
            anilistId: excluded('anilist_id'),
            malId: excluded('mal_id'),
            kitsuId: excluded('kitsu_id'),
            livechartId: excluded('livechart_id'),
            anisearchId: excluded('anisearch_id'),
            simklId: excluded('simkl_id'),
            animeNewsNetworkId: excluded('animenewsnetwork_id'),
            animeCountdownId: excluded('animecountdown_id'),
            animePlanetId: excluded('anime_planet_id'),
            type: excluded('type'),

            // gap-fill only -- see docstring above
            tvdbId: coalesceExcluded(schema.mapping.tvdbId, 'tvdb_id'),
            tmdbTvId: coalesceExcluded(schema.mapping.tmdbTvId, 'tmdb_tv_id'),
            tmdbMovieIds: coalesceExcluded(schema.mapping.tmdbMovieIds, 'tmdb_movie_ids'),
            imdbIds: coalesceExcluded(schema.mapping.imdbIds, 'imdb_ids'),
            defaultTvdbSeason: coalesceExcluded(schema.mapping.defaultTvdbSeason, 'default_tvdb_season'),
            tvdbEpisodeOffset: coalesceExcluded(schema.mapping.tvdbEpisodeOffset, 'tvdb_episode_offset'),
            defaultTmdbSeason: coalesceExcluded(schema.mapping.defaultTmdbSeason, 'default_tmdb_season'),
            tmdbEpisodeOffset: coalesceExcluded(schema.mapping.tmdbEpisodeOffset, 'tmdb_episode_offset')
            // mappingList / tvdbAbsolute / tmdbAbsolute / source still
            // deliberately untouched -- Fribb's reduced format has no
            // equivalent for per-episode overrides or absolute numbering
            // at all, so there's nothing correct to gap-fill them with.
          }
        });
    },
    ctx
  );

  if (result.done && commit) await commit();

  console.log(`[fribb-ingest] ${result.processed}/${withAnidbId.length} processed, ${result.added.length} new, done=${result.done}`);
  return { total: withAnidbId.length, skippedNoAnidbId: all.length - withAnidbId.length, added: result.added, done: result.done };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestFribb()
    .then((result) => {
      console.log(`[fribb-ingest] done`, result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[fribb-ingest] failed:', err);
      process.exit(1);
    });
}
