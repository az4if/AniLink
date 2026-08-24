import type { schema } from '../db/index.js';
import type { InferSelectModel } from 'drizzle-orm';

type MappingDbRow = InferSelectModel<typeof schema.mapping>;

/**
 * Builds the public /mappings response shape directly from a `mapping` row.
 * This is the "we haven't merged TVDB data in yet" shape -- ids, type,
 * title, and airing status are all real. `description`, `image`, and
 * `episodes` are honestly empty rather than faked: those need the TVDB
 * fetcher + merge engine (not built yet, see README), and returning
 * plausible-looking placeholder text would be worse than a clear null.
 *
 * Once the merge engine exists and populates `anime.data` for a title, the
 * route should prefer that richer object over this one -- this function
 * stays as the fallback for anything not merged yet (which, right now, is
 * everything).
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
      simkl: row.simklId
    },
    type: row.type,
    title: row.title,
    airing: row.airing,
    episodeProgress: row.episodeProgress,
    nextEpisodeAt: row.nextEpisodeAt,
    // pending the TVDB fetcher + merge engine -- see docstring above
    description: null as string | null,
    image: null as string | null,
    episodes: [] as unknown[],
    updatedAt: row.updatedAt
  };
}
