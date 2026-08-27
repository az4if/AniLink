import { getTvdbSyncTargets } from './tvdb-targets.js';
import { runSequential } from './sequential-runner.js';
import type { YieldCtx } from './chunked-runner.js';

/**
 * TODO: the actual TVDB v4 API call (login/token + fetch episodes for this
 * tvdb_id + upsert into tvdb_cache) isn't built yet -- this is a stub.
 * Everything AROUND this function is real and tested: which ids need
 * fetching (tvdb-targets.test.ts), the rate-limited one-at-a-time loop with
 * INDEX_DELAY between calls and resumable/yield-aware checkpointing
 * (sequential-runner.test.ts). Once a real TVDB client exists, it plugs in
 * as the body of this one function -- nothing else here needs to change.
 */
async function indexOneTvdbId(tvdbId: number): Promise<void> {
  console.log(`[tvdb-index] STUB -- would fetch and cache tvdb_id=${tvdbId} here (no TVDB client built yet)`);
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
  const targets = await getTvdbSyncTargets(mode);
  const jobName = mode === 'full' ? 'tvdb-full-reconcile' : 'tvdb-reconcile';
  return runSequential(jobName, targets, indexOneTvdbId, ctx);
}
