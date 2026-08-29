import { Config } from '../config.js';
import { JobQueue } from './queue.js';
import { ingestMapping } from '../mapping/ingest.js';
import { ingestFribb } from '../mapping/fribb.js';
import { ingestListsIds, ingestAiring } from '../mapping/lists.js';
import { ingestAniZip } from '../mapping/ani-zip.js';
import { runProviderSync } from '../mapping/provider-index.js';
import type { YieldCtx } from '../mapping/chunked-runner.js';

/**
 * All GitHub-hosted JSON/XML sources share this one queue. There's no
 * external rate limit to respect here -- this is purely "only one of these
 * touches the DB at a time" so two of them can never race and corrupt a
 * write.
 */
export const jsonQueue = new JobQueue('json-sources');

/**
 * TVDB jobs share this one instead. This one matters for a real reason:
 * TVDB has an actual per-key rate budget shared across everything hitting
 * it, so a scheduled priority job genuinely needs to be able to make a
 * long-running reconcile sweep step aside.
 */
export const providerQueue = new JobQueue('provider-pipeline');

// Higher number = more urgent.
const PRIORITY = { mapping: 10, providerIncremental: 20, providerFull: 10 } as const;

// setInterval's delay is a 32-bit signed int -- anything over ~24.8 days
// (2,147,483,647ms) silently overflows and Node clamps it to firing every
// 1ms instead. A 30-day interval hits that exactly, so intervals aren't
// scheduled with a single long setInterval; a short, always-safe "tick"
// checks elapsed time against each job's own interval instead. This works
// for any configured interval, no matter how long.
const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export function every(queue: JobQueue, hours: number, jobName: string, priority: number, run: (ctx: YieldCtx) => Promise<void>) {
  const intervalMs = hours * 60 * 60 * 1000;
  let lastRun = 0; // 0 = never run yet -- fires on the first tick after startup

  const tick = () => {
    const now = Date.now();
    if (now - lastRun >= intervalMs) {
      lastRun = now;
      queue.enqueue(jobName, priority, run);
    }
  };

  const timer = setInterval(tick, TICK_INTERVAL_MS);
  timer.unref?.();
  tick(); // also check immediately -- runs once at startup, then on schedule
}

export function startScheduler(): void {
  if (!Config.scheduler.enabled) {
    console.log('[scheduler] disabled (ENABLE_SCHEDULER=false) -- trigger jobs externally via POST /indexer/* instead');
    return;
  }

  // XML (primary: tvdb/tmdb ids, season/offset, mapping-list) -> Fribb
  // (backfills the other provider ids + type) -> lists-main ids (fills any
  // remaining gaps) -> lists-main airing (currently-airing snapshot), every
  // run, in that order, all on one cadence.
  every(jsonQueue, Config.scheduler.mappingSyncHours, 'scheduled:mapping-sync', PRIORITY.mapping, async (ctx) => {
    const aniZip = await ingestAniZip(undefined, ctx);
    const xml = await ingestMapping(undefined, ctx);
    const fribb = await ingestFribb(undefined, ctx);
    const ids = await ingestListsIds(undefined, ctx);
    const airing = await ingestAiring();
    console.log('[scheduler] mapping-sync', { aniZip, xml, fribb, ids, airing });
  });

  every(providerQueue, Config.scheduler.providerSyncHours, 'scheduled:provider-incremental', PRIORITY.providerIncremental, async (ctx) => {
    const result = await runProviderSync('incremental', ctx);
    console.log('[scheduler] provider-incremental', result);
  });

  every(providerQueue, Config.scheduler.providerFullSyncHours, 'scheduled:provider-full', PRIORITY.providerFull, async (ctx) => {
    const result = await runProviderSync('full', ctx);
    console.log('[scheduler] provider-full', result);
  });

  console.log('[scheduler] enabled', Config.scheduler);
}
