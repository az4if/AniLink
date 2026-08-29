import type { schema } from '../db/index.js';
import type { InferSelectModel } from 'drizzle-orm';

type MappingDbRow = InferSelectModel<typeof schema.mapping>;

/**
 * Builds the public /mappings response shape directly from a `mapping` row.
 * This is the "no merged TVDB data yet" shape -- ids, type, title, and
 * airing status are all real, but `description`, `image`, and `episodes`
 * are honestly empty rather than faked, since they need a TVDB fetch that
 * hasn't happened for this title (either `TVDB_API_KEY` isn't set, or
 * `POST /indexer/tvdb/*` hasn't run for it yet -- see merge.ts).
 *
 * `mappings.routes.ts` prefers the richer `anime.data` (populated by
 * merge.ts's mergeTvdbIntoAnime()) over this whenever it exists; this stays
 * as the fallback for anything not merged yet.
 */
export function buildMappingResponse(row: MappingDbRow) {
  return {
    ids: {
      anidb: row.anidbId,
      mal: row.malId,
      anilist: row.anilistId,
      kitsu: row.kitsuId,
      tvdb: row.tvdbId,
      tmdb: { tv: row.tmdbTvId, movie: row.tmdbMovieIds ?? [] },
      imdb: row.imdbIds ?? [],
      livechart: row.livechartId,
      anisearch: row.anisearchId,
      animePlanet: row.animePlanetId,
      animeNewsNetwork: row.animeNewsNetworkId,
      animeCountdown: row.animeCountdownId,
      simkl: row.simklId,
      notifyMoe: row.notifyMoeId
    },
    type: row.type,
    title: row.title,
    airing: row.airing,
    episodeProgress: row.episodeProgress,
    nextEpisodeAt: row.nextEpisodeAt,
    // pending a provider fetch + merge engine -- see docstring above
    description: null as string | null,
    image: null as string | null,
    episodes: [] as unknown[],
    titles: {} as Record<string, string>,
    episodeCount: null as number | null,
    specialCount: null as number | null,
    artworks: [] as unknown[],
    providers: { tvdb: null, tmdb: null, aniZip: null },
    updatedAt: row.updatedAt
  };
}
