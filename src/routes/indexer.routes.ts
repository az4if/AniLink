import { Hono } from 'hono';
import { sql, eq } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { ingestMapping } from '../mapping/ingest.js';
import { ingestFribb } from '../mapping/fribb.js';
import { ingestListsIds, ingestAiring } from '../mapping/lists.js';
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
indexerRoutes.get('/status', async (c) => {
  const jobNames = ['mapping-xml', 'mapping-fribb', 'mapping-lists-ids'];
  const jobs = await Promise.all(
    jobNames.map(async (jobName) => {
      const row = await db.query.indexerState.findFirst({ where: eq(schema.indexerState.jobName, jobName) });
      return {
        job: jobName,
        everRun: Boolean(row),
        cursor: row?.cursor ?? null, // non-zero means "mid-pass, will resume from here"
        lastCheckpoint: row?.updatedAt ?? null
      };
    })
  );

  const [mappingCount, animeCount, tvdbCacheCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(schema.mapping).then((r) => r[0].count),
    db.select({ count: sql<number>`count(*)::int` }).from(schema.anime).then((r) => r[0].count),
    db.select({ count: sql<number>`count(*)::int` }).from(schema.tvdbCache).then((r) => r[0].count)
  ]);

  return c.json({
    queues: { json: jsonQueue.status(), tvdb: tvdbQueue.status() },
    jobs,
    rowCounts: { mapping: mappingCount, anime: animeCount, tvdb_cache: tvdbCacheCount },
    scheduler: { enabled: Config.scheduler.enabled }
  });
});

// Placeholders for the next build phase -- once the TVDB fetcher exists it
// plugs into tvdbQueue exactly the way the routes above plug into
// jsonQueue: enqueue(id, priority, async (ctx) => runChunked(..., ctx)):
//   POST /indexer/tvdb/active/run      (currently-airing shows, high priority)
//   POST /indexer/tvdb/reconcile/run   (full catalog sweep, low priority, resumable)
//   POST /indexer/merge/run
