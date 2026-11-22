import type { CatalogRelated, CatalogRow } from './aod.js';

/**
 * Pure helpers for serving catalog data. No DB access here -- routes load the
 * row and call these -- so the response shaping is unit tested directly.
 */

/** A catalog row as read back from the DB (adds the bookkeeping timestamp). */
export type CatalogRecord = CatalogRow & { updatedAt?: Date | string | null };

type Json = Record<string, unknown>;

/** The `catalog` block exposed on /mappings responses. */
export type CatalogBlock = {
  key: string;
  title: string;
  type: string | null;
  episodes: number | null;
  status: string | null;
  season: string | null;
  seasonYear: number | null;
  durationSeconds: number | null;
  score: number | null;
  picture: string | null;
  thumbnail: string | null;
  synonyms: string[];
  studios: string[];
  producers: string[];
  tags: string[];
  related: CatalogRelated;
  sources: string[];
};

export function toCatalogBlock(entry: CatalogRecord): CatalogBlock {
  return {
    key: entry.key,
    title: entry.title,
    type: entry.type,
    episodes: entry.episodes,
    status: entry.status,
    season: entry.season,
    seasonYear: entry.seasonYear,
    durationSeconds: entry.durationSeconds,
    score: entry.score,
    picture: entry.picture,
    thumbnail: entry.thumbnail,
    synonyms: entry.synonyms,
    studios: entry.studios,
    producers: entry.producers,
    tags: entry.tags,
    related: entry.related,
    sources: entry.sources
  };
}

/** Catalog column behind each /mappings lookup parameter that the catalog can answer. */
export const CATALOG_LOOKUP_FIELDS = {
  anidb_id: 'anidbId',
  mal_id: 'malId',
  anilist_id: 'anilistId',
  kitsu_id: 'kitsuId',
  anisearch_id: 'anisearchId',
  livechart_id: 'livechartId',
  animeplanet_id: 'animePlanetId'
} as const;

export type CatalogLookupName = keyof typeof CATALOG_LOOKUP_FIELDS;

export function isCatalogLookup(name: string): name is CatalogLookupName {
  return name in CATALOG_LOOKUP_FIELDS;
}

// `ids` keys in the public response -> catalog field.
const ID_FILL: Array<[string, keyof CatalogRow]> = [
  ['anidb', 'anidbId'], ['mal', 'malId'], ['anilist', 'anilistId'], ['kitsu', 'kitsuId'],
  ['livechart', 'livechartId'], ['anisearch', 'anisearchId'], ['animePlanet', 'animePlanetId'],
  ['animeNewsNetwork', 'animeNewsNetworkId'], ['animeCountdown', 'animeCountdownId'], ['simkl', 'simklId']
];

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Adds catalog data to an existing /mappings document WITHOUT overriding
 * anything a better source already provided: it only fills gaps (ids, title,
 * type, image, episode count) and attaches the `catalog` block. Returns a new
 * object; the input (which may be a cached DB document) is never mutated.
 */
export function overlayCatalog<T extends Json>(data: T, entry: CatalogRecord | null): T & { catalog: CatalogBlock | null } {
  if (!entry) return { ...data, catalog: null };

  const out: Json = { ...data };

  const ids: Json = { ...((data.ids as Json | undefined) ?? {}) };
  for (const [idKey, field] of ID_FILL) {
    if (isMissing(ids[idKey]) && !isMissing(entry[field])) ids[idKey] = entry[field];
  }
  out.ids = ids;

  if (isMissing(out.title)) out.title = entry.title;
  if (isMissing(out.type) && entry.type && entry.type !== 'UNKNOWN') out.type = entry.type;
  if (isMissing(out.image) && entry.picture) out.image = entry.picture;
  if (isMissing(out.episodeCount) && entry.episodes) out.episodeCount = entry.episodes;

  // Keep provenance: expose the catalog poster as an artwork, but only once.
  const artworks = Array.isArray(out.artworks) ? [...(out.artworks as Json[])] : [];
  if (entry.picture && !artworks.some((artwork) => artwork.source === 'aod')) {
    artworks.push({
      url: entry.picture,
      thumbnail: entry.thumbnail,
      width: null,
      height: null,
      language: null,
      type: 'poster',
      source: 'aod',
      providerType: 'picture',
      score: null,
      includesText: null
    });
  }
  out.artworks = artworks;

  out.catalog = toCatalogBlock(entry);
  return out as T & { catalog: CatalogBlock | null };
}

/**
 * /mappings response for a title that exists only in the catalog (no AniDB id,
 * so no `mapping` row). Same top-level shape as buildMappingResponse so clients
 * need no special case; everything we cannot know is honestly null/empty.
 */
export function buildCatalogResponse(entry: CatalogRecord) {
  const base = {
    ids: {
      anidb: entry.anidbId,
      mal: entry.malId,
      anilist: entry.anilistId,
      kitsu: entry.kitsuId,
      tvdb: null as number | null,
      tmdb: { tv: null as number | null, movie: [] as number[] },
      imdb: [] as string[],
      livechart: entry.livechartId,
      anisearch: entry.anisearchId,
      animePlanet: entry.animePlanetId,
      animeNewsNetwork: entry.animeNewsNetworkId,
      animeCountdown: entry.animeCountdownId,
      simkl: entry.simklId,
      notifyMoe: null as number | null
    },
    type: entry.type && entry.type !== 'UNKNOWN' ? entry.type : null,
    title: entry.title,
    airing: entry.status === 'ONGOING',
    episodeProgress: null as number | null,
    nextEpisodeAt: null as Date | null,
    description: null as string | null,
    image: entry.picture,
    episodes: [] as unknown[],
    titles: {} as Record<string, string>,
    episodeCount: entry.episodes,
    specialCount: null as number | null,
    artworks: [] as unknown[],
    anilist: null as unknown,
    relatedSpecials: [] as unknown[],
    providers: { tvdb: null, tmdb: null, aniZip: null, anilist: null },
    updatedAt: entry.updatedAt ?? null
  };
  return overlayCatalog(base as unknown as Json, entry);
}
