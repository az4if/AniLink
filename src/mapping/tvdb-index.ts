import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { fetchTvdbSeries } from './tvdb-client.js';
import { mergeTvdbIntoAnime } from './merge.js';
import { getTvdbSyncTargets } from './tvdb-targets.js';
import { runSequential } from './sequential-runner.js';
import type { YieldCtx } from './chunked-runner.js';

/**
 * Fetches TVDB's series+episode data for one tvdb_id, upserts the raw
 * result into tvdb_cache, then re-merges every `mapping` row that points
 * at this tvdb_id into the public `anime` table (see merge.ts).
 *
 * A failure on one id (404 series, transient network error, TVDB
 * downtime, ...) is logged and swallowed rather than thrown. Letting it
 * propagate would abort sequentialCore()'s loop entirely -- since
 * runSequential() only writes the resumable cursor *after* the loop
 * returns (see sequential-runner.ts), one bad id would otherwise leave
 * every run of this job retrying that same id forever instead of moving
 * on to the rest of the batch.
 */
async function indexOneTvdbId(tvdbId: number): Promise<void> {
  try {
    const series = await fetchTvdbSeries(tvdbId);

    await db
      .insert(schema.tvdbCache)
      .values({ tvdbId, rawData: series, status: series.status, lastScrapedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.tvdbCache.tvdbId,
        set: { rawData: series, status: series.status, lastScrapedAt: new Date() }
      });

    await mergeTvdbIntoAnime(tvdbId, series);
  } catch (err) {
    console.error(`[tvdb-index] failed to index tvdb_id=${tvdbId}:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Runs a TVDB sync pass. 'incremental' only touches tvdb_ids that are
 * either currently airing or never fetched -- fast after the first run.
 * 'full' re-touches every mapped tvdb_id -- slow, meant for an infrequent
 * full resync. Each mode has its own resumable cursor (different job
 * names), so an interrupted incremental pass and an interrupted full pass
 * never clobber each other's progress.
 */
export async function runTvdbSync(mode: 'incremental' | 'full', ctx?: YieldCtx) {
  if (!Config.tvdb.apiKey) {
    console.warn('[tvdb-index] TVDB_API_KEY is not set -- skipping TVDB sync. Get one at https://thetvdb.com/api-information');
    return { processed: 0, done: true, yielded: false };
  }

  const targets = await getTvdbSyncTargets(mode);
  const jobName = mode === 'full' ? 'tvdb-full-reconcile' : 'tvdb-reconcile';
  return runSequential(jobName, targets, indexOneTvdbId, ctx);
}
