import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { fetchAniZip, type AniZipData, type AniZipTarget } from './ani-zip-client.js';
import { remergeAnime } from './merge.js';
import { runSequential } from './sequential-runner.js';
import { Config } from '../config.js';
import type { YieldCtx } from './chunked-runner.js';

function targetFor(row: { anidbId: number; anilistId: number | null; malId: number | null; kitsuId: number | null }): AniZipTarget | null {
  if (row.anilistId) return { anidbId: row.anidbId, lookup: 'anilist_id', value: row.anilistId };
  if (row.malId) return { anidbId: row.anidbId, lookup: 'mal_id', value: row.malId };
  if (row.kitsuId) return { anidbId: row.anidbId, lookup: 'kitsu_id', value: row.kitsuId };
  return { anidbId: row.anidbId, lookup: 'anidb_id', value: row.anidbId };
}

/** New + airing targets for the normal pass; all known-ID targets for full. */
export async function getAniZipSyncTargets(mode: 'incremental' | 'full'): Promise<AniZipTarget[]> {
  const [rows, cached] = await Promise.all([
    db.query.mapping.findMany({ columns: { anidbId: true, anilistId: true, malId: true, kitsuId: true, airing: true } }),
    db.query.aniZipCache.findMany({ columns: { anidbId: true, apiData: true } })
  ]);
  const cachedIds = new Set(cached.filter((row) => row.apiData).map((row) => row.anidbId));
  return rows
    .filter((row) => mode === 'full' || row.airing || !cachedIds.has(row.anidbId))
    .map(targetFor)
    .filter((target): target is AniZipTarget => target !== null)
    .sort((a, b) => a.anidbId - b.anidbId);
}

function preferredTitle(data: AniZipData): string | null {
  return data.titles.en ?? data.titles['x-jat'] ?? data.titles.ja ?? Object.values(data.titles)[0] ?? null;
}

export async function indexOneAniZip(target: AniZipTarget): Promise<void> {
  try {
    const data = await fetchAniZip(target);
    if (data.anidbId !== null && data.anidbId !== target.anidbId) {
      throw new Error(`lookup returned anidb_id=${data.anidbId}, expected ${target.anidbId}`);
    }
    const row = await db.query.mapping.findFirst({ where: eq(schema.mapping.anidbId, target.anidbId) });
    if (!row) return;
    const isMovie = data.mappings.type?.toUpperCase() === 'MOVIE';
    const title = preferredTitle(data);

    // AniLink's established mappings remain authoritative. The API fills
    // only gaps, while all of its richer fields remain available in cache.
    await db
      .update(schema.mapping)
      .set({
        title: row.title ?? title,
        type: row.type ?? data.mappings.type,
        anilistId: row.anilistId ?? data.mappings.anilistId,
        malId: row.malId ?? data.mappings.malId,
        kitsuId: row.kitsuId ?? data.mappings.kitsuId,
        animePlanetId: row.animePlanetId ?? data.mappings.animePlanetId,
        anisearchId: row.anisearchId ?? data.mappings.anisearchId,
        livechartId: row.livechartId ?? data.mappings.livechartId,
        notifyMoeId: row.notifyMoeId ?? data.mappings.notifyMoeId,
        tvdbId: row.tvdbId ?? data.mappings.tvdbId,
        tmdbTvId: row.tmdbTvId ?? (isMovie ? null : data.mappings.tmdbId),
        tmdbMovieIds: row.tmdbMovieIds ?? (isMovie && data.mappings.tmdbId ? [data.mappings.tmdbId] : null),
        imdbIds: row.imdbIds ?? (data.mappings.imdbId ? [data.mappings.imdbId] : null),
        updatedAt: new Date()
      })
      .where(eq(schema.mapping.anidbId, target.anidbId));

    await db
      .insert(schema.aniZipCache)
      .values({ anidbId: target.anidbId, rawData: {}, apiData: data, apiScrapedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.aniZipCache.anidbId,
        set: { apiData: data, apiScrapedAt: new Date() }
      });
    await remergeAnime(target.anidbId);
  } catch (error) {
    console.error(`[ani-zip-index] failed to index anidb_id=${target.anidbId}:`, error instanceof Error ? error.message : error);
  }
}

export async function runAniZipSync(mode: 'incremental' | 'full', ctx?: YieldCtx) {
  const targets = await getAniZipSyncTargets(mode);
  const jobName = mode === 'full' ? 'ani-zip-full-reconcile' : 'ani-zip-reconcile';
  return runSequential(jobName, targets, indexOneAniZip, ctx, Config.indexDelayMs);
}
