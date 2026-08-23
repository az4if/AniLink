import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import type { MappingListEntry } from '../db/schema.js';

/**
 * Everything the resolver needs for one AniDB anime. This is the parsed,
 * normalized shape -- separate from the Drizzle row type so this file has
 * no dependency on the DB layer and can be unit tested standalone.
 */
export type MappingRow = {
  anidbId: number;
  tvdbId: number | null;
  tmdbTvId: number | null;
  tmdbMovieIds: number[];
  imdbIds: string[];
  name: string;

  defaultTvdbSeason: number | null;
  tvdbAbsolute: boolean;
  tvdbEpisodeOffset: number;

  defaultTmdbSeason: number | null;
  tmdbAbsolute: boolean;
  tmdbEpisodeOffset: number;

  mappingList: MappingListEntry[];
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => name === 'anime' || name === 'mapping'
});

/** "" -> null, "5" -> 5, "a" -> 'a' (caller decides what to do with 'a') */
function parseSeasonAttr(raw: unknown): number | 'a' | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const str = String(raw);
  if (str === 'a') return 'a';
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

function parseIntAttr(raw: unknown, fallback = 0): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseCsvIds(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Parses the `;1-5;2-6+7;` explicit-mapping text format documented in the
 * anime-lists README:
 *   - "1-5"   -> anidb ep 1 maps to this provider's ep 5
 *   - "2-6+7" -> anidb ep 2 spans this provider's eps 6 AND 7
 *   - "3-0"   -> anidb ep 3 has no equivalent on this provider (explicit non-match)
 * Multiple anidb episodes CAN map to the same destination episode (e.g.
 * "1-1;2-1;" -- two parts of one combined episode), so this always accumulates.
 */
function parseExplicitPairs(text: string | undefined): Record<number, number[]> {
  const result: Record<number, number[]> = {};
  if (!text) return result;

  for (const pair of text.split(';').map((s) => s.trim()).filter(Boolean)) {
    const [srcRaw, dstRaw] = pair.split('-');
    if (srcRaw === undefined || dstRaw === undefined) continue;
    const src = Number(srcRaw);
    const dsts = dstRaw.split('+').map(Number).filter((n) => Number.isFinite(n));
    if (!Number.isFinite(src) || dsts.length === 0) continue;
    result[src] = [...(result[src] ?? []), ...dsts];
  }
  return result;
}

function parseMappingListEntry(raw: any): MappingListEntry | null {
  const anidbSeason = parseIntAttr(raw['@_anidbseason'], NaN);
  if (!Number.isFinite(anidbSeason)) return null;

  const tvdbSeasonRaw = parseSeasonAttr(raw['@_tvdbseason']);
  const tmdbSeasonRaw = parseSeasonAttr(raw['@_tmdbseason']);

  const start = raw['@_start'] !== undefined && raw['@_start'] !== '' ? Number(raw['@_start']) : undefined;
  const end = raw['@_end'] !== undefined && raw['@_end'] !== '' ? Number(raw['@_end']) : undefined;
  const offset = raw['@_offset'] !== undefined && raw['@_offset'] !== '' ? Number(raw['@_offset']) : undefined;

  const text: string | undefined = typeof raw['#text'] === 'string' ? raw['#text'] : undefined;
  const explicit = parseExplicitPairs(text);

  return {
    anidbSeason,
    // 'a' shouldn't appear at the per-mapping level in practice, but guard anyway
    tvdbSeason: typeof tvdbSeasonRaw === 'number' ? tvdbSeasonRaw : null,
    tmdbSeason: typeof tmdbSeasonRaw === 'number' ? tmdbSeasonRaw : null,
    start,
    end,
    offset,
    explicit: Object.keys(explicit).length > 0 ? explicit : undefined
  };
}

function parseAnimeNode(raw: any): MappingRow {
  const anidbId = Number(raw['@_anidbid']);
  const tvdbId = raw['@_tvdbid'] !== '' && raw['@_tvdbid'] !== undefined ? Number(raw['@_tvdbid']) : null;
  const tmdbTvId = raw['@_tmdbtv'] !== '' && raw['@_tmdbtv'] !== undefined ? Number(raw['@_tmdbtv']) : null;

  const defaultTvdbSeasonRaw = parseSeasonAttr(raw['@_defaulttvdbseason']);
  const defaultTmdbSeasonRaw = parseSeasonAttr(raw['@_tmdbseason']);

  let mappingListRaw = raw['mapping-list']?.mapping ?? [];
  if (!Array.isArray(mappingListRaw)) mappingListRaw = [mappingListRaw];
  const mappingList = mappingListRaw
    .map(parseMappingListEntry)
    .filter((e: MappingListEntry | null): e is MappingListEntry => e !== null);

  return {
    anidbId,
    tvdbId: Number.isFinite(tvdbId as number) ? tvdbId : null,
    tmdbTvId: Number.isFinite(tmdbTvId as number) ? tmdbTvId : null,
    tmdbMovieIds: parseCsvIds(raw['@_tmdbid']).map(Number).filter(Number.isFinite),
    imdbIds: parseCsvIds(raw['@_imdbid']),
    name: typeof raw.name === 'string' ? raw.name : String(raw.name ?? ''),

    defaultTvdbSeason: typeof defaultTvdbSeasonRaw === 'number' ? defaultTvdbSeasonRaw : null,
    tvdbAbsolute: defaultTvdbSeasonRaw === 'a',
    tvdbEpisodeOffset: parseIntAttr(raw['@_episodeoffset'], 0),

    defaultTmdbSeason: typeof defaultTmdbSeasonRaw === 'number' ? defaultTmdbSeasonRaw : null,
    tmdbAbsolute: defaultTmdbSeasonRaw === 'a',
    tmdbEpisodeOffset: parseIntAttr(raw['@_tmdboffset'], 0),

    mappingList
  };
}

/** Parses a full anime-list-master.xml file into one MappingRow per AniDB anime. */
export function parseAnimeListXml(xmlContent: string): MappingRow[] {
  const doc = xmlParser.parse(xmlContent);
  const animeNodes = doc['anime-list']?.anime ?? [];
  return (animeNodes as any[]).map(parseAnimeNode);
}

export function parseAnimeListXmlFile(path: string): MappingRow[] {
  return parseAnimeListXml(readFileSync(path, 'utf-8'));
}
