/**
 * Parser for cedya77/anime-offline-database (the maintained continuation of the
 * archived manami-project dataset). Pure: no DB, no network -- so it is unit
 * tested against real entries.
 *
 * Each upstream entry lists every provider URL it was merged from in `sources`.
 * We turn those URLs into typed IDs and keep the descriptive fields
 * (picture, synonyms, tags, ...) that nothing else in AniLink provides for
 * titles TVDB/TMDB/ani.zip do not cover.
 */

export type AodEntry = {
  sources: string[];
  title: string;
  type?: string;
  episodes?: number;
  status?: string;
  animeSeason?: { season?: string; year?: number | null };
  picture?: string;
  thumbnail?: string;
  duration?: { value?: number; unit?: string } | null;
  score?: { arithmeticGeometricMean?: number; arithmeticMean?: number; median?: number } | null;
  synonyms?: string[];
  studios?: string[];
  producers?: string[];
  relatedAnime?: string[];
  tags?: string[];
};

export type AodMeta = { lastUpdate: string | null; repository: string | null };

export type CatalogRelated = { anidb: number[]; anilist: number[]; mal: number[] };

/** One row of `catalog_entry` (minus DB bookkeeping columns). */
export type CatalogRow = {
  key: string;
  anidbId: number | null;
  anilistId: number | null;
  malId: number | null;
  kitsuId: number | null;
  anisearchId: number | null;
  livechartId: number | null;
  animePlanetId: string | null;
  animeNewsNetworkId: number | null;
  animeCountdownId: number | null;
  simklId: number | null;
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

type IdField =
  | 'anidbId' | 'anilistId' | 'malId' | 'kitsuId' | 'anisearchId' | 'livechartId'
  | 'animePlanetId' | 'animeNewsNetworkId' | 'animeCountdownId' | 'simklId';

type IdPattern = { field: IdField; pattern: RegExp; text?: boolean };

const HOST = String.raw`^https?:\/\/(?:www\.)?`;

// Shapes verified against the real 38k-entry dataset. Note animecountdown has
// no /anime/ segment and ANN uses a query string.
const ID_PATTERNS: IdPattern[] = [
  { field: 'anidbId', pattern: new RegExp(`${HOST}anidb\\.net\\/anime\\/(\\d+)\\/?$`) },
  { field: 'anilistId', pattern: new RegExp(`${HOST}anilist\\.co\\/anime\\/(\\d+)\\/?$`) },
  { field: 'malId', pattern: new RegExp(`${HOST}myanimelist\\.net\\/anime\\/(\\d+)\\/?$`) },
  { field: 'kitsuId', pattern: new RegExp(`${HOST}kitsu\\.(?:app|io)\\/anime\\/(\\d+)\\/?$`) },
  { field: 'anisearchId', pattern: new RegExp(`${HOST}anisearch\\.(?:com|de|es|fr|it|jp)\\/anime\\/(\\d+)`) },
  { field: 'livechartId', pattern: new RegExp(`${HOST}livechart\\.me\\/anime\\/(\\d+)\\/?$`) },
  { field: 'animePlanetId', pattern: new RegExp(`${HOST}anime-planet\\.com\\/anime\\/([^/?#]+)\\/?$`), text: true },
  { field: 'animeNewsNetworkId', pattern: new RegExp(`${HOST}animenewsnetwork\\.com\\/encyclopedia\\/anime\\.php\\?id=(\\d+)`) },
  { field: 'animeCountdownId', pattern: new RegExp(`${HOST}animecountdown\\.com\\/(\\d+)\\/?$`) },
  { field: 'simklId', pattern: new RegExp(`${HOST}simkl\\.com\\/anime\\/(\\d+)\\/?$`) }
];

export type ExtractedIds = Pick<CatalogRow, IdField>;

function emptyIds(): ExtractedIds {
  return {
    anidbId: null, anilistId: null, malId: null, kitsuId: null, anisearchId: null, livechartId: null,
    animePlanetId: null, animeNewsNetworkId: null, animeCountdownId: null, simklId: null
  };
}

/** Turns an entry's `sources` URLs into typed provider IDs. First URL per provider wins. */
export function extractIds(sources: readonly string[]): ExtractedIds {
  const ids = emptyIds();
  for (const url of sources) {
    if (typeof url !== 'string') continue;
    for (const { field, pattern, text } of ID_PATTERNS) {
      const match = pattern.exec(url);
      if (!match) continue;
      if (ids[field] !== null) break; // keep the first, ignore a conflicting duplicate
      if (text) {
        (ids as Record<IdField, number | string | null>)[field] = decodeURIComponent(match[1]);
      } else {
        const id = Number(match[1]);
        if (Number.isSafeInteger(id) && id > 0) (ids as Record<IdField, number | string | null>)[field] = id;
      }
      break;
    }
  }
  return ids;
}

/** AniList/MAL/AniDB ids of an entry's related anime -- the three providers AniLink keys on. */
export function extractRelated(urls: readonly string[] | undefined): CatalogRelated {
  const anidb = new Set<number>();
  const anilist = new Set<number>();
  const mal = new Set<number>();
  for (const url of urls ?? []) {
    const ids = extractIds([url]);
    if (ids.anidbId !== null) anidb.add(ids.anidbId);
    if (ids.anilistId !== null) anilist.add(ids.anilistId);
    if (ids.malId !== null) mal.add(ids.malId);
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return { anidb: sorted(anidb), anilist: sorted(anilist), mal: sorted(mal) };
}

// Priority for the row key: the providers with the most stable, dense numeric ids first.
const KEY_PRIORITY: Array<[IdField, string]> = [
  ['anilistId', 'anilist'], ['malId', 'mal'], ['anidbId', 'anidb'], ['kitsuId', 'kitsu'],
  ['anisearchId', 'anisearch'], ['livechartId', 'livechart'], ['simklId', 'simkl'],
  ['animeCountdownId', 'animecountdown'], ['animeNewsNetworkId', 'ann'], ['animePlanetId', 'animeplanet']
];

export function catalogKey(ids: ExtractedIds): string | null {
  for (const [field, prefix] of KEY_PRIORITY) {
    const value = ids[field];
    if (value !== null && value !== '') return `${prefix}:${value}`;
  }
  return null;
}

/** The dataset uses a shared no-picture image; it is not a real poster and must not be served as one. */
export function isPlaceholderImage(url: string | undefined | null): boolean {
  return typeof url === 'string' && /\/pics\/no_pic/i.test(url);
}

function cleanImage(url: string | undefined): string | null {
  if (typeof url !== 'string' || url.trim() === '' || isPlaceholderImage(url)) return null;
  return url;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

/** Maps one upstream entry to a catalog row. Returns null when the entry carries no usable id at all. */
export function toCatalogRow(entry: AodEntry): CatalogRow | null {
  const sources = strings(entry.sources);
  const ids = extractIds(sources);
  const key = catalogKey(ids);
  if (!key || typeof entry.title !== 'string' || entry.title.trim() === '') return null;

  const season = entry.animeSeason?.season;
  const year = entry.animeSeason?.year;
  const meanScore = entry.score?.arithmeticMean;

  return {
    key,
    ...ids,
    title: entry.title,
    type: entry.type ?? null,
    // The dataset writes 0 for "unknown number of episodes".
    episodes: typeof entry.episodes === 'number' && entry.episodes > 0 ? entry.episodes : null,
    status: entry.status ?? null,
    season: season && season !== 'UNDEFINED' ? season : null,
    seasonYear: typeof year === 'number' ? year : null,
    durationSeconds: entry.duration?.unit === 'SECONDS' && typeof entry.duration.value === 'number' ? entry.duration.value : null,
    score: typeof meanScore === 'number' ? Math.round(meanScore * 100) / 100 : null,
    picture: cleanImage(entry.picture),
    thumbnail: cleanImage(entry.thumbnail),
    synonyms: strings(entry.synonyms),
    studios: strings(entry.studios),
    producers: strings(entry.producers),
    tags: strings(entry.tags),
    related: extractRelated(entry.relatedAnime),
    sources
  };
}

export type ConvertedCatalog = { rows: CatalogRow[]; skippedNoId: number; duplicateKeys: number };

/**
 * Converts entries one at a time and de-duplicates by key (a duplicate key
 * would make a batched upsert fail outright). Lets the streaming importer drop
 * each raw entry as soon as it has been reduced, so memory holds the compact
 * rows only, not the raw ~60 MB dataset as well.
 */
export function createCatalogCollector() {
  const byKey = new Map<string, CatalogRow>();
  let skippedNoId = 0;
  let duplicateKeys = 0;
  return {
    add(entry: AodEntry): void {
      const row = toCatalogRow(entry);
      if (!row) skippedNoId++;
      else if (byKey.has(row.key)) duplicateKeys++;
      else byKey.set(row.key, row);
    },
    finish(): ConvertedCatalog {
      return { rows: [...byKey.values()], skippedNoId, duplicateKeys };
    }
  };
}

export function entriesToCatalogRows(entries: Iterable<AodEntry>): ConvertedCatalog {
  const collector = createCatalogCollector();
  for (const entry of entries) collector.add(entry);
  return collector.finish();
}

function isEntryLike(value: unknown): value is AodEntry {
  return typeof value === 'object' && value !== null && Array.isArray((value as { sources?: unknown }).sources);
}

function toMeta(value: Record<string, unknown>): AodMeta {
  return {
    lastUpdate: typeof value.lastUpdate === 'string' ? value.lastUpdate : null,
    repository: typeof value.repository === 'string' ? value.repository : null
  };
}

/** Single-document format: `anime-offline-database-minified.json` -> `{ ..., data: [entries] }`. */
export function parseAodDocument(text: string): { meta: AodMeta; entries: AodEntry[] } {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { data?: unknown }).data)) {
    throw new Error('anime-offline-database JSON has no "data" array -- unexpected format');
  }
  const doc = parsed as Record<string, unknown> & { data: unknown[] };
  return { meta: toMeta(doc), entries: doc.data.filter(isEntryLike) };
}

export type AodLine = { kind: 'entry'; entry: AodEntry } | { kind: 'meta'; meta: AodMeta } | { kind: 'skip' };

/**
 * One line of `anime-offline-database.jsonl`: a metadata line first, then one
 * anime per line. Anything with a `sources` array is an entry; any other
 * object is treated as metadata; blank lines are ignored. A line that is not
 * valid JSON throws -- a truncated download must fail loudly, not be half-ingested.
 */
export function parseAodLine(line: string): AodLine {
  const trimmed = line.trim();
  if (trimmed === '') return { kind: 'skip' };
  const parsed: unknown = JSON.parse(trimmed);
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'skip' };
  if (isEntryLike(parsed)) return { kind: 'entry', entry: parsed };
  return { kind: 'meta', meta: toMeta(parsed as Record<string, unknown>) };
}
