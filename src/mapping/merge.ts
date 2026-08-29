import { arrayContains, eq, or, type InferSelectModel } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { reverseResolveRegular } from './resolver.js';
import { buildMappingResponse } from './response.js';
import type { MappingRow } from './xml-parser.js';
import type { TvdbEpisode, TvdbSeriesData } from './tvdb-client.js';
import type { TmdbData, TmdbEpisode } from './tmdb-client.js';
import type { AniZipData, AniZipEpisode } from './ani-zip-client.js';
import { uniqueArtworks } from './artworks.js';

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
  titleEn: string | null;
  overview: string | null;
  overviewEn: string | null;
  aired: string | null;
  image: string | null;
  titles?: Record<string, string>;
  anidbEpisodeId?: number | null;
  tvdbEpisodeId?: number | null;
  runtime?: number | null;
  rating?: number | null;
  summary?: string | null;
  airedUtc?: string | null;
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
      titleEn: ep.titleEn,
      overview: ep.overview,
      overviewEn: ep.overviewEn,
      aired: ep.aired,
      image: ep.image
    });
  }

  return out.sort((a, b) => a.number - b.number);
}

function buildAniZipEpisodes(episodes: AniZipEpisode[]): MergedEpisode[] {
  return episodes.map((episode) => ({
    number: episode.number,
    season: episode.seasonNumber ?? 1,
    episode: episode.episodeNumber ?? episode.number,
    absoluteNumber: episode.absoluteNumber,
    title: episode.titles.en ?? episode.titles['x-jat'] ?? episode.titles.ja ?? Object.values(episode.titles)[0] ?? null,
    titleEn: episode.titles.en ?? null,
    overview: episode.overview ?? episode.summary,
    overviewEn: episode.overview ?? episode.summary,
    aired: episode.aired,
    image: episode.image,
    titles: episode.titles,
    anidbEpisodeId: episode.anidbEpisodeId,
    tvdbEpisodeId: episode.tvdbEpisodeId,
    runtime: episode.runtime,
    rating: episode.rating,
    summary: episode.summary,
    airedUtc: episode.airedUtc
  }));
}

function enrichEpisodes(episodes: MergedEpisode[], source: AniZipData | null): MergedEpisode[] {
  if (!source) return episodes;
  const byNumber = new Map(source.episodes.map((episode) => [episode.number, episode]));
  return episodes.map((episode) => {
    const extra = byNumber.get(episode.number);
    if (!extra) return episode;
    return {
      ...episode,
      titles: extra.titles,
      anidbEpisodeId: extra.anidbEpisodeId,
      tvdbEpisodeId: extra.tvdbEpisodeId,
      runtime: extra.runtime,
      rating: extra.rating,
      summary: extra.summary,
      airedUtc: extra.airedUtc
    };
  });
}

/**
 * An airing feed's episodeProgress is the highest episode that is actually
 * available now. Providers often expose scheduled/future episodes early;
 * those must never reach the public index until the feed advances.
 */
function limitToAiredProgress(row: MappingDbRow, episodes: MergedEpisode[]): MergedEpisode[] {
  if (!row.airing || row.episodeProgress === null) return episodes;
  return episodes.filter((episode) => episode.number <= row.episodeProgress!);
}

/** TMDB has no native absolute-number field; tmdb-client derives a stable
 * positive-season absolute order for XML mappings that use it. */
export function buildTmdbEpisodes(row: MappingRow, episodes: TmdbEpisode[]): MergedEpisode[] {
  const out: MergedEpisode[] = [];
  for (const ep of episodes) {
    const number = row.tmdbAbsolute ? ep.absoluteNumber : reverseResolveRegular(row, { season: ep.seasonNumber, number: ep.number }, 'tmdb');
    if (number === null || number === undefined) continue;
    out.push({
      number,
      season: ep.seasonNumber,
      episode: ep.number,
      absoluteNumber: ep.absoluteNumber,
      title: ep.name,
      titleEn: null,
      overview: ep.overview,
      overviewEn: null,
      aired: ep.aired,
      image: ep.image
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

async function cacheFor(row: MappingDbRow) {
  const tvdb = row.tvdbId
    ? await db.query.tvdbCache.findFirst({ where: eq(schema.tvdbCache.tvdbId, row.tvdbId) })
    : undefined;
  const tmdbKeys = [
    ...(row.tmdbTvId ? [`tv:${row.tmdbTvId}`] : []),
    ...(row.tmdbMovieIds ?? []).map((id) => `movie:${id}`)
  ];
  const tmdb = await Promise.all(tmdbKeys.map((cacheKey) => db.query.tmdbCache.findFirst({ where: eq(schema.tmdbCache.cacheKey, cacheKey) })));
  const aniZip = await db.query.aniZipCache.findFirst({ where: eq(schema.aniZipCache.anidbId, row.anidbId) });
  return {
    tvdb: (tvdb?.rawData ?? null) as TvdbSeriesData | null,
    tmdb: tmdb.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry?.rawData)).map((entry) => entry.rawData as TmdbData),
    aniZip: (aniZip?.apiData ?? null) as AniZipData | null
  };
}

/** Rebuilds one public document from whichever provider caches are present. */
export async function remergeAnime(anidbId: number, freshTvdb?: TvdbSeriesData): Promise<void> {
  const row = await db.query.mapping.findFirst({ where: eq(schema.mapping.anidbId, anidbId) });
  if (!row) return;
  const cached = await cacheFor(row);
  const tvdb = freshTvdb ?? cached.tvdb;
  const tmdb = cached.tmdb.find((entry) => entry.mediaType === 'tv') ?? cached.tmdb[0] ?? null;
  const aniZip = cached.aniZip;
  if (!tvdb && !tmdb && !aniZip) return;

  const resolverRow = toResolverRow(row);
  // TVDB wins for metadata/episodes where it exists. TMDB is a true
  // fallback for the 56% without TVDB, while its artwork is retained in all
  // cases so clients can choose their preferred provider.
  const primary = tvdb ?? tmdb;
  const fallbackImage = aniZip?.artworks.find((artwork) => artwork.type === 'poster')?.url ?? aniZip?.artworks[0]?.url ?? null;
  const providerEpisodes = tvdb
    ? buildEpisodes(resolverRow, tvdb.episodes)
    : tmdb
      ? buildTmdbEpisodes(resolverRow, tmdb.episodes)
      : buildAniZipEpisodes(aniZip?.episodes ?? []);
  const data = {
    ...buildMappingResponse(row),
    title: aniZip?.titles.en ?? aniZip?.titles['x-jat'] ?? aniZip?.titles.ja ?? row.title,
    titles: aniZip?.titles ?? {},
    description: primary?.overview ?? null,
    image: primary?.image ?? fallbackImage,
    episodes: enrichEpisodes(limitToAiredProgress(row, providerEpisodes), aniZip),
    episodeCount: row.airing && row.episodeProgress !== null ? Math.min(aniZip?.episodeCount ?? row.episodeProgress, row.episodeProgress) : aniZip?.episodeCount ?? null,
    specialCount: aniZip?.specialCount ?? null,
    artworks: uniqueArtworks([...(tvdb?.artworks ?? []), ...cached.tmdb.flatMap((entry) => entry.artworks ?? []), ...(aniZip?.artworks ?? [])]),
    providers: {
      tvdb: tvdb ? { id: row.tvdbId, status: tvdb.status, cached: true } : null,
      tmdb: tmdb ? { id: tmdb.id, mediaType: tmdb.mediaType, status: tmdb.status, cached: true } : null,
      aniZip: aniZip ? { cached: true, episodeCount: aniZip.episodeCount, specialCount: aniZip.specialCount } : null
    }
  };

  await db
    .insert(schema.anime)
    .values({ anidbId: row.anidbId, anilistId: row.anilistId, malId: row.malId, tvdbId: row.tvdbId, data, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.anime.anidbId,
      set: { anilistId: row.anilistId, malId: row.malId, tvdbId: row.tvdbId, data, updatedAt: new Date() }
    });
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
  // `series` stays part of the signature for callers/tests and documents
  // which fresh payload triggered this remerge; the cache is the shared
  // source used to join TVDB and TMDB consistently.
  void series;
  await Promise.all(rows.map((row) => remergeAnime(row.anidbId, series)));
}

/** Re-merge every AniDB entry sharing a TMDB TV/movie record. */
export async function mergeTmdbIntoAnime(tmdbId: number, mediaType: 'tv' | 'movie'): Promise<void> {
  const where = mediaType === 'tv' ? eq(schema.mapping.tmdbTvId, tmdbId) : arrayContains(schema.mapping.tmdbMovieIds, [tmdbId]);
  const rows = await db.query.mapping.findMany({ where: or(where) });
  await Promise.all(rows.map((row) => remergeAnime(row.anidbId)));
}
