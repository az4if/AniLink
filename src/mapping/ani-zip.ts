import AdmZip from 'adm-zip';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { runChunked, type YieldCtx } from './chunked-runner.js';

type ArchiveRecord = Record<string, unknown>;

export type AniZipEntry = {
  anidbId: number;
  title: string | null;
  type: string | null;
  anilistId: number | null;
  malId: number | null;
  tvdbId: number | null;
  tmdbTvId: number | null;
  tmdbMovieIds: number[];
  imdbIds: string[];
  raw: ArchiveRecord;
};

function asNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function pickNumber(entry: ArchiveRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = asNumber(entry[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickNumberArray(entry: ArchiveRecord, ...keys: string[]): number[] {
  for (const key of keys) {
    const value = entry[key];
    const values = Array.isArray(value) ? value.map(asNumber).filter((id): id is number => id !== null) : [asNumber(value)].filter((id): id is number => id !== null);
    if (values.length) return [...new Set(values)];
  }
  return [];
}

function pickStringArray(entry: ArchiveRecord, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = entry[key];
    const values = (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    if (values.length) return [...new Set(values)];
  }
  return [];
}

function pickTitle(entry: ArchiveRecord): string | null {
  const direct = ['title', 'name', 'romaji', 'english'].find((key) => typeof entry[key] === 'string');
  if (direct) return entry[direct] as string;
  const titles = entry.titles ?? entry.title;
  if (titles && typeof titles === 'object') {
    const record = titles as ArchiveRecord;
    for (const key of ['romaji', 'english', 'native', 'default']) if (typeof record[key] === 'string') return record[key] as string;
  }
  return null;
}

function pickType(entry: ArchiveRecord): string | null {
  const value = entry.type ?? entry.format;
  return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

/** Pure normalizer for common archive layouts; exported for fixture tests once ani.zip is available. */
export function normalizeAniZipRecord(raw: unknown): AniZipEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as ArchiveRecord;
  const anidbId = pickNumber(entry, 'anidb_id', 'anidbId', 'idAniDB', 'anidb');
  if (anidbId === null) return null;
  return {
    anidbId,
    title: pickTitle(entry),
    type: pickType(entry),
    anilistId: pickNumber(entry, 'anilist_id', 'anilistId', 'idAL', 'anilist'),
    malId: pickNumber(entry, 'mal_id', 'malId', 'idMal', 'mal'),
    tvdbId: pickNumber(entry, 'tvdb_id', 'tvdbId', 'thetvdb_id', 'thetvdbId'),
    tmdbTvId: pickNumber(entry, 'tmdb_tv_id', 'tmdbTvId', 'themoviedb_tv_id'),
    tmdbMovieIds: pickNumberArray(entry, 'tmdb_movie_ids', 'tmdbMovieIds', 'themoviedb_movie_ids'),
    imdbIds: pickStringArray(entry, 'imdb_ids', 'imdbIds', 'imdb_id', 'imdbId'),
    raw: entry
  };
}

function recordsFromJson(json: unknown): ArchiveRecord[] {
  if (Array.isArray(json)) return json.filter((entry): entry is ArchiveRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry));
  if (!json || typeof json !== 'object') return [];
  const root = json as ArchiveRecord;
  for (const key of ['data', 'anime', 'entries', 'items', 'records']) if (Array.isArray(root[key])) return recordsFromJson(root[key]);
  // Some exporters key the object by ID. Preserve each value and inject the
  // key as an AniDB candidate only when the row has no explicit one.
  const records: ArchiveRecord[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) records.push({ anidb_id: key, ...(value as ArchiveRecord) });
  }
  return records;
}

export function readAniZip(path = Config.sources.aniZipPath): AniZipEntry[] {
  if (!existsSync(path)) return [];
  const zip = new AdmZip(path);
  const jsonEntries = zip.getEntries().filter((entry) => !entry.isDirectory && entry.entryName.toLowerCase().endsWith('.json'));
  if (jsonEntries.length === 0) throw new Error(`ANI_ZIP_PATH=${path} has no JSON entry`);
  const byId = new Map<number, AniZipEntry>();
  for (const jsonEntry of jsonEntries) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonEntry.getData().toString('utf8'));
    } catch (error) {
      throw new Error(`Could not parse ${jsonEntry.entryName} in ANI_ZIP_PATH: ${(error as Error).message}`);
    }
    for (const raw of recordsFromJson(parsed)) {
      const entry = normalizeAniZipRecord(raw);
      if (entry) byId.set(entry.anidbId, entry);
    }
  }
  return [...byId.values()].sort((a, b) => a.anidbId - b.anidbId);
}

function excluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

function coalesce(current: unknown, incoming: string) {
  return sql`COALESCE(${current}, ${excluded(incoming)})`;
}

/**
 * Loads optional ani.zip before provider indexing. It can seed entries the
 * remote mapping sources do not know, but it never replaces the XML's
 * authoritative TVDB/TMDB episode mapping. Every original row remains
 * available in ani_zip_cache for later fields/cross-reference work.
 */
export async function ingestAniZip(entries = readAniZip(), ctx?: YieldCtx) {
  const result = await runChunked(
    'mapping-ani-zip',
    entries,
    500,
    (entry) => entry.anidbId,
    async (chunk) => {
      await db
        .insert(schema.mapping)
        .values(
          chunk.map((entry) => ({
            anidbId: entry.anidbId,
            title: entry.title,
            type: entry.type,
            anilistId: entry.anilistId,
            malId: entry.malId,
            tvdbId: entry.tvdbId,
            tmdbTvId: entry.tmdbTvId,
            tmdbMovieIds: entry.tmdbMovieIds.length ? entry.tmdbMovieIds : null,
            imdbIds: entry.imdbIds.length ? entry.imdbIds : null,
            source: 'ani-zip'
          }))
        )
        .onConflictDoUpdate({
          target: schema.mapping.anidbId,
          set: {
            title: coalesce(schema.mapping.title, 'title'),
            type: coalesce(schema.mapping.type, 'type'),
            anilistId: coalesce(schema.mapping.anilistId, 'anilist_id'),
            malId: coalesce(schema.mapping.malId, 'mal_id'),
            tvdbId: coalesce(schema.mapping.tvdbId, 'tvdb_id'),
            tmdbTvId: coalesce(schema.mapping.tmdbTvId, 'tmdb_tv_id'),
            tmdbMovieIds: coalesce(schema.mapping.tmdbMovieIds, 'tmdb_movie_ids'),
            imdbIds: coalesce(schema.mapping.imdbIds, 'imdb_ids')
          }
        });
      await db
        .insert(schema.aniZipCache)
        .values(chunk.map((entry) => ({ anidbId: entry.anidbId, rawData: entry.raw, lastImportedAt: new Date() })))
        .onConflictDoUpdate({ target: schema.aniZipCache.anidbId, set: { rawData: excluded('raw_data'), lastImportedAt: excluded('last_imported_at') } });
    },
    ctx,
    Config.indexDelayMs
  );
  console.log(`[ani-zip] ${result.processed}/${entries.length} processed, ${result.added.length} new, done=${result.done}`);
  return { ...result, total: entries.length, found: existsSync(Config.sources.aniZipPath) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestAniZip()
    .then((result) => {
      console.log('[ani-zip] done', result);
      process.exit(0);
    })
    .catch((error) => {
      console.error('[ani-zip] failed:', error);
      process.exit(1);
    });
}
