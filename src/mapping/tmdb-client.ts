import { Config } from '../config.js';
import { fetchWithHeaders } from '../helpers/fetch.js';
import { tmdbArtworkType, type Artwork } from './artworks.js';

export type TmdbEpisode = {
  seasonNumber: number;
  number: number;
  absoluteNumber: number | null;
  name: string | null;
  overview: string | null;
  aired: string | null;
  image: string | null;
};

export type TmdbData = {
  id: number;
  mediaType: 'tv' | 'movie';
  status: string | null;
  image: string | null;
  overview: string | null;
  episodes: TmdbEpisode[];
  artworks: Artwork[];
  // Full provider response, including TMDB images/translations/credits and
  // every field added by TMDB later. The normalized fields above are only
  // the public indexing contract.
  raw: Record<string, unknown>;
};

function image(path: unknown, size = 'original'): string | null {
  return typeof path === 'string' && path ? `${Config.tmdb.imageBaseUrl}/${size}${path}` : null;
}

async function tmdbGet(path: string): Promise<any> {
  if (!Config.tmdb.apiKey) throw new Error('TMDB_API_KEY is not set');
  const res = await fetchWithHeaders(`${Config.tmdb.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${Config.tmdb.apiKey}`, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`TMDB GET ${path} failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

function artworks(images: any): Artwork[] {
  const groups: Array<[any[], 'poster' | 'backdrop' | 'logo']> = [
    [images?.posters ?? [], 'poster'],
    [images?.backdrops ?? [], 'backdrop'],
    [images?.logos ?? [], 'logo']
  ];
  return groups.flatMap(([items, kind]) =>
    items
      .map((item): Artwork | null => {
        const url = image(item.file_path);
        if (!url) return null;
        return {
          url,
          thumbnail: image(item.file_path, 'w500'),
          width: typeof item.width === 'number' ? item.width : null,
          height: typeof item.height === 'number' ? item.height : null,
          language: typeof item.iso_639_1 === 'string' ? item.iso_639_1 : null,
          type: tmdbArtworkType(kind),
          source: 'tmdb' as const,
          providerType: kind,
          score: typeof item.vote_average === 'number' ? item.vote_average : null,
          includesText: null
        };
      })
      .filter((item): item is Artwork => item !== null)
  );
}

async function fetchTvEpisodes(id: number, seasons: any[]): Promise<TmdbEpisode[]> {
  const seasonNumbers = seasons.map((season) => season?.season_number).filter((n): n is number => Number.isInteger(n) && n >= 0);
  const results = await Promise.all(
    seasonNumbers.map(async (seasonNumber) => {
      const season = await tmdbGet(`/tv/${id}/season/${seasonNumber}`);
      return (season.episodes ?? []).map((episode: any) => ({
        seasonNumber: episode.season_number ?? seasonNumber,
        number: episode.episode_number,
        absoluteNumber: null,
        name: episode.name ?? null,
        overview: episode.overview ?? null,
        aired: episode.air_date ?? null,
        image: image(episode.still_path, 'original')
      } satisfies TmdbEpisode));
    })
  );
  // TMDB does not expose an absolute-number field. Derive the conventional
  // absolute order from positive-numbered seasons (never its season-zero
  // specials) so anime-lists mappings with tmdbseason="a" still work.
  const episodes = results.flat().sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
  let absolute = 0;
  return episodes.map((episode) => ({
    ...episode,
    absoluteNumber: episode.seasonNumber > 0 ? ++absolute : null
  }));
}

/** Fetches the complete TMDB object plus artworks, translations and episode data. */
export async function fetchTmdb(id: number, mediaType: 'tv' | 'movie'): Promise<TmdbData> {
  const raw = await tmdbGet(`/${mediaType}/${id}?append_to_response=images,translations,external_ids,credits&include_image_language=en,null`);
  const episodes = mediaType === 'tv' ? await fetchTvEpisodes(id, raw.seasons ?? []) : [];
  return {
    id,
    mediaType,
    status: raw.status ?? null,
    image: image(raw.poster_path),
    overview: raw.overview ?? null,
    episodes,
    artworks: artworks(raw.images),
    raw
  };
}
