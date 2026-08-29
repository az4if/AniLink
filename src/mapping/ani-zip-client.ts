import { Config } from '../config.js';
import { fetchWithHeaders } from '../helpers/fetch.js';
import type { Artwork } from './artworks.js';

export type AniZipTarget = { anidbId: number; lookup: 'anilist_id' | 'mal_id' | 'kitsu_id' | 'anidb_id'; value: number };

export type AniZipEpisode = {
  number: number;
  anidbEpisodeId: number | null;
  tvdbShowId: number | null;
  tvdbEpisodeId: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  absoluteNumber: number | null;
  titles: Record<string, string>;
  overview: string | null;
  summary: string | null;
  aired: string | null;
  airedUtc: string | null;
  runtime: number | null;
  rating: number | null;
  image: string | null;
};

export type AniZipData = {
  sourceUrl: string;
  anidbId: number | null;
  titles: Record<string, string>;
  mappings: {
    anilistId: number | null;
    malId: number | null;
    kitsuId: number | null;
    animePlanetId: string | null;
    anisearchId: number | null;
    livechartId: number | null;
    tvdbId: number | null;
    tmdbId: number | null;
    imdbId: string | null;
    notifyMoeId: number | null;
    type: string | null;
  };
  episodeCount: number | null;
  specialCount: number | null;
  episodes: AniZipEpisode[];
  artworks: Artwork[];
  raw: Record<string, unknown>;
};

function numberOrNull(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function titles(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0));
}

function artworkType(coverType: unknown): Artwork['type'] {
  const value = typeof coverType === 'string' ? coverType.toLowerCase() : '';
  if (value.includes('poster')) return 'poster';
  if (value.includes('logo')) return 'logo';
  if (value.includes('banner') || value.includes('fanart') || value.includes('background')) return 'background';
  return 'unknown';
}

/** Converts an API response without collapsing language, provider-ID or episode fields. */
export function normalizeAniZipApiData(raw: unknown, sourceUrl = Config.aniZip.apiUrl): AniZipData {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
  const mappings = data.mappings && typeof data.mappings === 'object' ? data.mappings : {};
  const episodes = data.episodes && typeof data.episodes === 'object' ? data.episodes : {};
  const images = Array.isArray(data.images) ? data.images : [];

  return {
    sourceUrl,
    anidbId: numberOrNull(mappings.anidb_id),
    titles: titles(data.titles),
    mappings: {
      anilistId: numberOrNull(mappings.anilist_id),
      malId: numberOrNull(mappings.mal_id),
      kitsuId: numberOrNull(mappings.kitsu_id),
      animePlanetId: textOrNull(mappings.animeplanet_id),
      anisearchId: numberOrNull(mappings.anisearch_id),
      livechartId: numberOrNull(mappings.livechart_id),
      tvdbId: numberOrNull(mappings.thetvdb_id),
      tmdbId: numberOrNull(mappings.themoviedb_id),
      imdbId: textOrNull(mappings.imdb_id),
      notifyMoeId: numberOrNull(mappings.notifymoe_id),
      type: textOrNull(mappings.type)
    },
    episodeCount: numberOrNull(data.episodeCount),
    specialCount: numberOrNull(data.specialCount),
    episodes: Object.entries(episodes)
      .map(([key, episode]): AniZipEpisode | null => {
        const value = episode && typeof episode === 'object' ? (episode as Record<string, unknown>) : {};
        const number = numberOrNull(key) ?? numberOrNull(value.episode);
        if (number === null || number <= 0) return null;
        return {
          number,
          anidbEpisodeId: numberOrNull(value.anidbEid),
          tvdbShowId: numberOrNull(value.tvdbShowId),
          tvdbEpisodeId: numberOrNull(value.tvdbId),
          seasonNumber: numberOrNull(value.seasonNumber),
          episodeNumber: numberOrNull(value.episodeNumber),
          absoluteNumber: numberOrNull(value.absoluteEpisodeNumber),
          titles: titles(value.title),
          overview: textOrNull(value.overview),
          summary: textOrNull(value.summary),
          aired: textOrNull(value.airDate) ?? textOrNull(value.airdate),
          airedUtc: textOrNull(value.airDateUtc),
          runtime: numberOrNull(value.runtime) ?? numberOrNull(value.length),
          rating: numberOrNull(value.rating),
          image: textOrNull(value.image)
        };
      })
      .filter((episode): episode is AniZipEpisode => episode !== null)
      .sort((a, b) => a.number - b.number),
    artworks: images
      .map((image: any): Artwork | null => {
        const url = textOrNull(image?.url);
        if (!url) return null;
        return {
          url,
          thumbnail: null,
          width: null,
          height: null,
          language: null,
          type: artworkType(image.coverType),
          source: 'ani-zip',
          providerType: textOrNull(image.coverType),
          score: null,
          includesText: null
        };
      })
      .filter((artwork): artwork is Artwork => artwork !== null),
    raw: data
  };
}

/**
 * api.ani.zip currently returns a JSON-encoded string for some responses.
 * Accept both that transport shape and a regular JSON object before
 * normalization, while retaining the complete provider payload.
 */
export function decodeAniZipPayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error('ani.zip returned a string that is not valid JSON');
  }
}

export async function fetchAniZip(target: AniZipTarget): Promise<AniZipData> {
  const url = new URL('/mappings', Config.aniZip.apiUrl);
  url.searchParams.set(target.lookup, String(target.value));
  const res = await fetchWithHeaders(url.toString());
  if (!res.ok) throw new Error(`ani.zip GET ${url.pathname}?${url.searchParams} failed: HTTP ${res.status} ${await res.text()}`);
  return normalizeAniZipApiData(decodeAniZipPayload(await res.json()), url.toString());
}
