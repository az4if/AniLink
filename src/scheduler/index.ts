import { Config } from '../config.js';
import { JobQueue } from './queue.js';
import { ingestMapping } from '../mapping/ingest.js';
import { ingestFribb } from '../mapping/fribb.js';
import { ingestListsIds, ingestAiring } from '../mapping/lists.js';

/**
 * All GitHub-hosted JSON/XML sources share this one queue. There's no
 * external rate limit to respect here -- this is purely "only one of these
 * touches the DB at a time" so an hourly airing check and a monthly XML
 * resync can never race each other and corrupt a write.
 */
export const jsonQueue = new JobQueue('json-sources');

/**
 * Reserved for the TVDB fetcher (not built yet). Unlike jsonQueue, this one
 * matters for a real reason: TVDB has an actual per-key rate budget shared
 * across everything hitting it, so a scheduled priority job genuinely needs
 * to be able to make a long-running reconcile sweep step aside. Whatever
 * the TVDB active/reconcile jobs end up being, they plug in exactly the
 * same way jsonQueue's jobs do below -- runChunked() + this queue's
 * shouldYield() ctx is the whole pattern.
 */
export const tvdbQueue = new JobQueue('tvdb');

// Higher number = more urgent. Airing data is both the most time-sensitive
// (an episode can air within the hour) and the fastest job (~300 entries),
// so it's worth letting it preempt a slow monthly XML resync if the two
// ever land at the same moment.
const PRIORITY = { airing: 30, ids: 20, xml: 10 } as const;

// setInterval's delay is a 32-bit signed int -- anything over ~24.8 days
// (2,147,483,647ms) silently overflows and Node clamps it to firing every
// 1ms instead. The "monthly" XML sync (30 days) hits that exactly, so
// intervals aren't scheduled with a single long setInterval; a short,
// always-safe "tick" checks elapsed time against each job's own interval
// instead. This works for any configured interval, no matter how long.
const TICK_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export function every(hours: number, jobName: string, priority: number, run: (ctx: { shouldYield: () => boolean }) => Promise<void>) {
  const intervalMs = hours * 60 * 60 * 1000;
  let lastRun = 0; // 0 = never run yet -- fires on the first tick after startup

  const tick = () => {
    const now = Date.now();
    if (now - lastRun >= intervalMs) {
      lastRun = now;
      jsonQueue.enqueue(jobName, priority, run);
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

  every(Config.scheduler.xmlSyncHours, 'scheduled:mapping-xml', PRIORITY.xml, async (ctx) => {
    const result = await ingestMapping(undefined, ctx);
    console.log('[scheduler] mapping-xml', result);
  });

  every(Config.scheduler.idsSyncHours, 'scheduled:mapping-ids', PRIORITY.ids, async (ctx) => {
    const fribb = await ingestFribb(undefined, ctx);
    const lists = await ingestListsIds(undefined, ctx);
    console.log('[scheduler] mapping-ids', { fribb, lists });
  });

  every(Config.scheduler.airingSyncHours, 'scheduled:airing', PRIORITY.airing, async () => {
    const result = await ingestAiring();
    console.log('[scheduler] airing', result);
  });

  console.log('[scheduler] enabled', Config.scheduler);
}
