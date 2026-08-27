import { Hono } from 'hono';
import { sql, eq } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { ingestMapping } from '../mapping/ingest.js';
import { ingestFribb } from '../mapping/fribb.js';
import { ingestListsIds, ingestAiring } from '../mapping/lists.js';
import { runTvdbSync } from '../mapping/tvdb-index.js';
import { jsonQueue, tvdbQueue } from '../scheduler/index.js';

export const indexerRoutes = new Hono();

function requireAdmin(headerValue: string | undefined): boolean {
  return Boolean(headerValue) && headerValue === Config.adminKey;
}

// Every job below is enqueued into jsonQueue rather than run inline -- the
// same queue the internal scheduler uses (scheduler/index.ts) -- so a
// manual trigger (e.g. an external pinger hitting this route on a cron)
// can never overlap a scheduled run and corrupt a write. The route returns
// as soon as the job is queued, not when it finishes; watch server logs
// (or GET /indexer/queue/status) for the result of a long-running one.

// POST /indexer/mapping/refresh
// Re-downloads anime-list-master.xml and upserts the full mapping table.
// Run this before the two below at least once, since it establishes every
// anidb_id row they then backfill.
indexerRoutes.post('/mapping/refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  jsonQueue.enqueue('manual:mapping-xml', 10, async (ctx) => {
    const result = await ingestMapping(undefined, ctx);
    console.log('[indexer] mapping-xml', result);
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// POST /indexer/mapping/fribb-refresh
// Backfills anilist/mal/kitsu/livechart/anisearch/anime-planet/ann/
// animecountdown/simkl ids + type from the Fribb-format JSON.
indexerRoutes.post('/mapping/fribb-refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  jsonQueue.enqueue('manual:mapping-fribb', 10, async (ctx) => {
    const result = await ingestFribb(undefined, ctx);
    console.log('[indexer] mapping-fribb', result);
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// POST /indexer/mapping/lists-refresh
// lists-main: id freshness backfill (only fills gaps) + currently-airing
// snapshot (airing / episodeProgress / nextEpisodeAt).
indexerRoutes.post('/mapping/lists-refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  jsonQueue.enqueue('manual:mapping-lists', 10, async (ctx) => {
    const ids = await ingestListsIds(undefined, ctx);
    const airing = await ingestAiring();
    console.log('[indexer] mapping-lists', { ids, airing });
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// GET /indexer/queue/status
// Read-only, ungated -- reveals job names/state only, nothing sensitive.
indexerRoutes.get('/queue/status', (c) => {
  return c.json({ json: jsonQueue.status(), tvdb: tvdbQueue.status() });
});

// GET /indexer/status
// The "is this actually running?" endpoint -- for each known job, when it
// last completed (or last checkpointed, if it yielded mid-pass) and how
// many rows are in each table right now. If a job's lastRun is old or
// missing entirely, nothing has triggered it -- that's the first thing to
// check before assuming there's a bug: is the scheduler on
// (ENABLE_SCHEDULER=true), or is an external pinger actually configured?
//
// Every piece below is independently try/caught. A diagnostic endpoint
// that itself crashes with no explanation defeats the purpose -- if your
// DB is missing a table (e.g. schema migrated before a later column/table
// was added), this reports exactly that instead of a bare 500.
indexerRoutes.get('/status', async (c) => {
  async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> {
    try {
      return await fn();
    } catch (err) {
      console.error(`[indexer/status] ${label} failed:`, err);
      return { error: (err as Error).message };
    }
  }

  const jobNames = ['mapping-xml', 'mapping-fribb', 'mapping-lists-ids', 'tvdb-reconcile', 'tvdb-full-reconcile'];
  const jobs = await Promise.all(
    jobNames.map((jobName) =>
      safe(`indexer_state:${jobName}`, async () => {
        const row = await db.query.indexerState.findFirst({ where: eq(schema.indexerState.jobName, jobName) });
        return {
          job: jobName,
          everRun: Boolean(row),
          cursor: row?.cursor ?? null, // non-zero means "mid-pass, will resume from here"
          lastCheckpoint: row?.updatedAt ?? null
        };
      })
    )
  );

  const rowCounts = {
    mapping: await safe('count:mapping', async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.mapping))[0].n),
    anime: await safe('count:anime', async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.anime))[0].n),
    tvdb_cache: await safe(
      'count:tvdb_cache',
      async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.tvdbCache))[0].n
    )
  };

  return c.json({
    queues: { json: jsonQueue.status(), tvdb: tvdbQueue.status() },
    jobs,
    rowCounts,
    scheduler: { enabled: Config.scheduler.enabled }
  });
});

// POST /indexer/mapping/sync
// Runs all four mapping sources in sequence -- XML, Fribb, lists-main ids,
// lists-main airing -- exactly what the scheduler does on MAPPING_SYNC_HOURS.
// The three routes above still exist individually for targeted debugging.
indexerRoutes.post('/mapping/sync', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  jsonQueue.enqueue('manual:mapping-sync', 10, async (ctx) => {
    const xml = await ingestMapping(undefined, ctx);
    const fribb = await ingestFribb(undefined, ctx);
    const ids = await ingestListsIds(undefined, ctx);
    const airing = await ingestAiring();
    console.log('[indexer] mapping-sync', { xml, fribb, ids, airing });
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// POST /indexer/tvdb/incremental
// Only tvdb_ids that are currently airing or have never been fetched --
// naturally covers everything on the very first run (nothing's cached
// yet), and only the new/airing subset after that. See tvdb-targets.ts.
// NOTE: the actual TVDB API call is still a stub (see tvdb-index.ts) --
// this exercises the real selection/queue/rate-limit plumbing, but won't
// populate tvdb_cache with real data until a TVDB client is built.
indexerRoutes.post('/tvdb/incremental', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  tvdbQueue.enqueue('manual:tvdb-incremental', 20, async (ctx) => {
    const result = await runTvdbSync('incremental', ctx);
    console.log('[indexer] tvdb-incremental', result);
  });
  return c.json({ queued: true, queue: tvdbQueue.status() });
});

// POST /indexer/tvdb/full
// Every mapped tvdb_id, regardless of cache state. Slow -- meant to be run
// rarely (TVDB_FULL_SYNC_HOURS, default 30 days).
indexerRoutes.post('/tvdb/full', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  tvdbQueue.enqueue('manual:tvdb-full', 10, async (ctx) => {
    const result = await runTvdbSync('full', ctx);
    console.log('[indexer] tvdb-full', result);
  });
  return c.json({ queued: true, queue: tvdbQueue.status() });
});
