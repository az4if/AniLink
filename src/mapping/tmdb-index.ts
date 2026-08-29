import { db, schema } from '../db/index.js';
import { Config } from '../config.js';
import { fetchTmdb } from './tmdb-client.js';
import { mergeTmdbIntoAnime } from './merge.js';
import { runSequential } from './sequential-runner.js';
import type { YieldCtx } from './chunked-runner.js';

export type TmdbTarget = { id: number; mediaType: 'tv' | 'movie' };

/** Distinct mapping targets, with the same first-run/new-or-airing behavior as TVDB. */
export async function getTmdbSyncTargets(mode: 'incremental' | 'full'): Promise<TmdbTarget[]> {
  const [mappings, cached] = await Promise.all([
    db.query.mapping.findMany({
      columns: { tmdbTvId: true, tmdbMovieIds: true, airing: true }
    }),
    db.query.tmdbCache.findMany({ columns: { cacheKey: true } })
  ]);
  const known = new Set(cached.map((entry) => entry.cacheKey));
  const targets = new Map<string, TmdbTarget>();
  for (const mapping of mappings) {
    const candidates: TmdbTarget[] = [
      ...(mapping.tmdbTvId ? [{ id: mapping.tmdbTvId, mediaType: 'tv' as const }] : []),
      ...(mapping.tmdbMovieIds ?? []).map((id) => ({ id, mediaType: 'movie' as const }))
    ];
    for (const target of candidates) {
      const key = `${target.mediaType}:${target.id}`;
      if (mode === 'full' || mapping.airing || !known.has(key)) targets.set(key, target);
    }
  }
  return [...targets.values()].sort((a, b) => a.mediaType.localeCompare(b.mediaType) || a.id - b.id);
}

async function indexOneTmdb(target: TmdbTarget): Promise<void> {
  try {
    const data = await fetchTmdb(target.id, target.mediaType);
    const cacheKey = `${target.mediaType}:${target.id}`;
    await db
      .insert(schema.tmdbCache)
      .values({ cacheKey, tmdbId: target.id, mediaType: target.mediaType, rawData: data, status: data.status, lastScrapedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.tmdbCache.cacheKey,
        set: { rawData: data, status: data.status, lastScrapedAt: new Date() }
      });
    await mergeTmdbIntoAnime(target.id, target.mediaType);
  } catch (error) {
    console.error(`[tmdb-index] failed to index ${target.mediaType}=${target.id}:`, error instanceof Error ? error.message : error);
  }
}

export async function runTmdbSync(mode: 'incremental' | 'full', ctx?: YieldCtx) {
  if (!Config.tmdb.apiKey) {
    console.warn('[tmdb-index] TMDB_API_KEY is not set -- skipping TMDB sync');
    return { processed: 0, done: true, yielded: false };
  }
  const targets = await getTmdbSyncTargets(mode);
  const jobName = mode === 'full' ? 'tmdb-full-reconcile' : 'tmdb-reconcile';
  // TMDB shares the same configurable inter-target delay as TVDB.
  return runSequential(jobName, targets, indexOneTmdb, ctx, Config.indexDelayMs);
}
