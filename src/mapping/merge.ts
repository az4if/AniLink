import { eq, type InferSelectModel } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { reverseResolveRegular } from './resolver.js';
import { buildMappingResponse } from './response.js';
import type { MappingRow } from './xml-parser.js';
import type { TvdbEpisode, TvdbSeriesData } from './tvdb-client.js';

type MappingDbRow = InferSelectModel<typeof schema.mapping>;

/** Reshapes a `mapping` DB row (nullable columns) into the plain object resolver.ts expects (non-null offsets/lists, coalesced). */
function toResolverRow(row: MappingDbRow): MappingRow {
  return {
    anidbId: row.anidbId,
    tvdbId: row.tvdbId,
    tmdbTvId: row.tmdbTvId,
    tmdbMovieIds: row.tmdbMovieIds ?? [],
    imdbIds: row.imdbIds ?? [],
    name: row.title ?? '',
    defaultTvdbSeason: row.defaultTvdbSeason,
    tvdbAbsolute: row.tvdbAbsolute,
    tvdbEpisodeOffset: row.tvdbEpisodeOffset ?? 0,
    defaultTmdbSeason: row.defaultTmdbSeason,
    tmdbAbsolute: row.tmdbAbsolute,
    tmdbEpisodeOffset: row.tmdbEpisodeOffset ?? 0,
    mappingList: row.mappingList ?? []
  };
}

export type MergedEpisode = {
  number: number; // the canonical AniDB regular-episode number
  season: number; // TVDB season this episode actually lives in
  episode: number; // TVDB episode number within that season
  absoluteNumber: number | null;
  title: string | null;
  overview: string | null;
  aired: string | null;
  image: string | null;
};

/**
 * Builds the public episode list for one anime from TVDB's raw episode
 * list, translating each TVDB (season, episode) back into the AniDB
 * regular-episode number it corresponds to via reverseResolveRegular().
 *
 * Absolute-numbered shows (tvdbAbsolute) skip the resolver entirely --
 * TVDB's own `absoluteNumber` field on each episode IS the canonical
 * number for those, no arithmetic needed (see reverseResolveRegular's
 * docstring). Specials are excluded: the resolver is deliberately scoped
 * to regular episodes only (see CONTRIBUTING.md -- AniDB's
 * special/OVA/trailer numbering has no reverse-mappable TVDB equivalent,
 * not supported for v1).
 *
 * Exported (rather than folded into mergeTvdbIntoAnime) so it's directly
 * unit-testable without a live DB -- see test/merge.test.ts.
 */
export function buildEpisodes(row: MappingRow, episodes: TvdbEpisode[]): MergedEpisode[] {
  const out: MergedEpisode[] = [];

  for (const ep of episodes) {
    const number = row.tvdbAbsolute ? ep.absoluteNumber : reverseResolveRegular(row, { season: ep.seasonNumber, number: ep.number }, 'tvdb');
    if (number === null || number === undefined) continue;

    out.push({
      number,
      season: ep.seasonNumber,
      episode: ep.number,
      absoluteNumber: ep.absoluteNumber,
      title: ep.name,
      overview: ep.overview,
      aired: ep.aired,
      image: ep.image
    });
  }

  return out.sort((a, b) => a.number - b.number);
}

/**
 * Re-merges every `mapping` row pointing at `tvdbId` into `anime.data`
 * (the /mappings response shape, richer version) using freshly-fetched
 * TVDB data. Processes the full set rather than assuming one row per
 * tvdb_id -- more than one AniDB entry can share a tvdb_id (e.g. Ghost in
 * the Shell's several cuts, see tvdb-targets.ts), and each needs its own
 * merged row since resolver output depends on the AniDB-side mapping
 * (mapping-list, offset), not just the TVDB id.
 *
 * `mappings.routes.ts` already prefers `anime.data` over the plain
 * `mapping` row when present, so once this runs for a title, GET
 * /mappings for it starts returning description/image/episodes with no
 * route change needed.
 */
export async function mergeTvdbIntoAnime(tvdbId: number, series: TvdbSeriesData): Promise<void> {
  const rows = await db.query.mapping.findMany({ where: eq(schema.mapping.tvdbId, tvdbId) });

  for (const row of rows) {
    const resolverRow = toResolverRow(row);
    const data = {
      ...buildMappingResponse(row),
      description: series.overview,
      image: series.image,
      episodes: buildEpisodes(resolverRow, series.episodes)
    };

    await db
      .insert(schema.anime)
      .values({
        anidbId: row.anidbId,
        anilistId: row.anilistId,
        malId: row.malId,
        tvdbId: row.tvdbId,
        data,
        updatedAt: new Date()
      })
      .onConflictDoUpdate({
        target: schema.anime.anidbId,
        set: {
          anilistId: row.anilistId,
          malId: row.malId,
          tvdbId: row.tvdbId,
          data,
          updatedAt: new Date()
        }
      });
  }
}
