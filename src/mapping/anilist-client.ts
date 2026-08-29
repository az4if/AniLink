import { Config } from '../config.js';
import { fetchWithHeaders } from '../helpers/fetch.js';

type FuzzyDate = { year?: number | null; month?: number | null; day?: number | null } | null;

export type AniListRelation = {
  id: number;
  relationType: string;
  format: string | null;
  status: string | null;
  episodes: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  startDate: string | null;
  endDate: string | null;
  siteUrl: string | null;
};

export type AniListMedia = {
  id: number;
  idMal: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  synonyms: string[];
  format: string | null;
  status: string | null;
  episodes: number | null;
  duration: number | null;
  startDate: string | null;
  endDate: string | null;
  nextAiringEpisode: { episode: number; airingAt: number } | null;
  relations: AniListRelation[];
  siteUrl: string | null;
  raw: Record<string, unknown>;
};

const QUERY = `
query ($id: Int!) {
  Media(id: $id, type: ANIME) {
    id idMal title { romaji english native } synonyms format status episodes duration
    startDate { year month day } endDate { year month day }
    nextAiringEpisode { episode airingAt }
    siteUrl
    relations {
      edges {
        relationType
        node {
          id title { romaji english native } format status episodes
          startDate { year month day } endDate { year month day } siteUrl
        }
      }
    }
  }
}`;

function formatDate(date: FuzzyDate): string | null {
  if (!date?.year) return null;
  const month = String(date.month ?? 1).padStart(2, '0');
  const day = String(date.day ?? 1).padStart(2, '0');
  return `${String(date.year).padStart(4, '0')}-${month}-${day}`;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Fetches enough metadata to validate episode ranges without guessing them. */
export async function fetchAniListMedia(anilistId: number): Promise<AniListMedia> {
  const res = await fetchWithHeaders(Config.anilist.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { id: anilistId } })
  });
  if (!res.ok) throw new Error(`AniList media ${anilistId} failed: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data?: { Media?: Record<string, any> | null }; errors?: { message?: string }[] };
  const media = body.data?.Media;
  if (!media) throw new Error(`AniList media ${anilistId} returned no result: ${body.errors?.map((error) => error.message).join('; ') ?? 'unknown error'}`);

  return {
    id: media.id,
    idMal: numberOrNull(media.idMal),
    title: { romaji: textOrNull(media.title?.romaji), english: textOrNull(media.title?.english), native: textOrNull(media.title?.native) },
    synonyms: Array.isArray(media.synonyms) ? media.synonyms.filter((title): title is string => typeof title === 'string' && title.trim().length > 0) : [],
    format: textOrNull(media.format),
    status: textOrNull(media.status),
    episodes: numberOrNull(media.episodes),
    duration: numberOrNull(media.duration),
    startDate: formatDate(media.startDate),
    endDate: formatDate(media.endDate),
    nextAiringEpisode:
      numberOrNull(media.nextAiringEpisode?.episode) && numberOrNull(media.nextAiringEpisode?.airingAt)
        ? { episode: media.nextAiringEpisode.episode, airingAt: media.nextAiringEpisode.airingAt }
        : null,
    relations: (media.relations?.edges ?? [])
      .map((edge: any): AniListRelation | null => {
        const node = edge?.node;
        if (!numberOrNull(node?.id)) return null;
        return {
          id: node.id,
          relationType: textOrNull(edge.relationType) ?? 'OTHER',
          format: textOrNull(node.format),
          status: textOrNull(node.status),
          episodes: numberOrNull(node.episodes),
          title: { romaji: textOrNull(node.title?.romaji), english: textOrNull(node.title?.english), native: textOrNull(node.title?.native) },
          startDate: formatDate(node.startDate),
          endDate: formatDate(node.endDate),
          siteUrl: textOrNull(node.siteUrl)
        };
      })
      .filter((relation: AniListRelation | null): relation is AniListRelation => relation !== null),
    siteUrl: textOrNull(media.siteUrl),
    raw: media
  };
}
