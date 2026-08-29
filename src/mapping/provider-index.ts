import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { fetchTvdbSeries } from './tvdb-client.js';
import { fetchTmdb } from './tmdb-client.js';
import { indexOneAniZip } from './ani-zip-index.js';
import { remergeAnime } from './merge.js';
import { runSequential } from './sequential-runner.js';
import { Config } from '../config.js';
import type { YieldCtx } from './chunked-runner.js';

export type ProviderTarget = { anidbId: number };

/**
 * One title, one ordered pipeline:
 *   1. TVDB when a TVDB ID is mapped.
 *   2. Otherwise TMDB when a TMDB ID is mapped.
 *   3. ani.zip always, using AniList -> MAL -> Kitsu -> AniDB lookup.
 *
 * The remote enrichment can fill IDs for a title that initially had neither
 * provider. Those newly discovered IDs are picked up by the next incremental
 * pass, keeping one predictable provider pass per title.
 */
export async function getProviderSyncTargets(mode: 'incremental' | 'full'): Promise<ProviderTarget[]> {
  const [mappings, tvdbCached, tmdbCached, aniZipCached] = await Promise.all([
    db.query.mapping.findMany({ columns: { anidbId: true, tvdbId: true, tmdbTvId: true, tmdbMovieIds: true, airing: true } }),
    db.query.tvdbCache.findMany({ columns: { tvdbId: true } }),
    db.query.tmdbCache.findMany({ columns: { cacheKey: true } }),
    db.query.aniZipCache.findMany({ columns: { anidbId: true, apiData: true } })
  ]);
  const tvdbIds = new Set(tvdbCached.map((entry) => entry.tvdbId));
  const tmdbKeys = new Set(tmdbCached.map((entry) => entry.cacheKey));
  const aniZipIds = new Set(aniZipCached.filter((entry) => entry.apiData).map((entry) => entry.anidbId));

  return mappings
    .filter((row) => {
      if (mode === 'full' || row.airing) return true;
      const providerCached = row.tvdbId
        ? tvdbIds.has(row.tvdbId)
        : row.tmdbTvId
          ? tmdbKeys.has(`tv:${row.tmdbTvId}`)
          : (row.tmdbMovieIds ?? []).length > 0
            ? (row.tmdbMovieIds ?? []).every((id) => tmdbKeys.has(`movie:${id}`))
            : true;
      return !providerCached || !aniZipIds.has(row.anidbId);
    })
    .map((row) => ({ anidbId: row.anidbId }))
    .sort((a, b) => a.anidbId - b.anidbId);
}

async function cacheTvdb(tvdbId: number): Promise<void> {
  const series = await fetchTvdbSeries(tvdbId);
  await db
    .insert(schema.tvdbCache)
    .values({ tvdbId, rawData: series, status: series.status, lastScrapedAt: new Date() })
    .onConflictDoUpdate({ target: schema.tvdbCache.tvdbId, set: { rawData: series, status: series.status, lastScrapedAt: new Date() } });
}

async function cacheTmdb(tmdbId: number, mediaType: 'tv' | 'movie'): Promise<void> {
  const data = await fetchTmdb(tmdbId, mediaType);
  const cacheKey = `${mediaType}:${tmdbId}`;
  await db
    .insert(schema.tmdbCache)
    .values({ cacheKey, tmdbId, mediaType, rawData: data, status: data.status, lastScrapedAt: new Date() })
    .onConflictDoUpdate({ target: schema.tmdbCache.cacheKey, set: { rawData: data, status: data.status, lastScrapedAt: new Date() } });
}

async function indexOneProvider(target: ProviderTarget): Promise<void> {
  const row = await db.query.mapping.findFirst({ where: eq(schema.mapping.anidbId, target.anidbId) });
  if (!row) return;

  try {
    if (row.tvdbId) {
      if (Config.tvdb.apiKey) await cacheTvdb(row.tvdbId);
      else console.warn(`[provider-index] TVDB_API_KEY is not set; skipped tvdb_id=${row.tvdbId}`);
    } else if (row.tmdbTvId || (row.tmdbMovieIds ?? []).length > 0) {
      if (!Config.tmdb.apiKey) {
        console.warn(`[provider-index] TMDB_API_KEY is not set; skipped anidb_id=${row.anidbId}`);
      } else if (row.tmdbTvId) {
        await cacheTmdb(row.tmdbTvId, 'tv');
      } else {
        for (const tmdbId of row.tmdbMovieIds ?? []) await cacheTmdb(tmdbId, 'movie');
      }
    }
  } catch (error) {
    // ani.zip still runs below. Its data is useful even when a paid provider
    // is temporarily unavailable, and it may provide a missing mapping.
    console.error(`[provider-index] provider stage failed for anidb_id=${row.anidbId}:`, error instanceof Error ? error.message : error);
  }

  await indexOneAniZip({
    anidbId: row.anidbId,
    lookup: row.anilistId ? 'anilist_id' : row.malId ? 'mal_id' : row.kitsuId ? 'kitsu_id' : 'anidb_id',
    value: row.anilistId ?? row.malId ?? row.kitsuId ?? row.anidbId
  });
  await remergeAnime(row.anidbId);
}

export async function runProviderSync(mode: 'incremental' | 'full', ctx?: YieldCtx) {
  const targets = await getProviderSyncTargets(mode);
  const jobName = mode === 'full' ? 'provider-full-reconcile' : 'provider-reconcile';
  return runSequential(jobName, targets, indexOneProvider, ctx, Config.indexDelayMs);
}
