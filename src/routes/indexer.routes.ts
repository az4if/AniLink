import { Hono } from 'hono';
import { sql, eq, and } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { ingestMapping } from '../mapping/ingest.js';
import { ingestFribb } from '../mapping/fribb.js';
import { ingestListsIds, ingestAiring } from '../mapping/lists.js';
import { ingestAniZip } from '../mapping/ani-zip.js';
import { runProviderSync } from '../mapping/provider-index.js';
import { runMappingSync, runCatalogSync } from '../mapping/sync.js';
import { applyMappingOverrides } from '../mapping/overrides-apply.js';
import { decodeOverrideValue, encodeOverrideValue, OVERRIDABLE_FIELDS, validateOverrideValue } from '../mapping/overrides.js';
import { isReportKind, reportRows, reportSummary } from '../mapping/reports.js';
import { jsonQueue, providerQueue } from '../scheduler/index.js';

export const indexerRoutes = new Hono();

function requireAdmin(headerValue: string | undefined): boolean {
  // No ADMIN_KEY configured (unset or empty) -> open, no key required.
  // Intentional default for local/dev use; set ADMIN_KEY before deploying
  // publicly or every POST /indexer/* route below is callable by anyone.
  if (!Config.adminKey) return true;
  return headerValue === Config.adminKey;
}

/** `?force=true` (or `=1`): re-process even if the source is unchanged AND bypass the size guard. */
function isForce(query: string | undefined): boolean {
  return query === 'true' || query === '1';
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
  const force = isForce(c.req.query('force'));
  jsonQueue.enqueue('manual:mapping-xml', 10, async (ctx) => {
    const result = await ingestMapping(undefined, ctx, { force });
    await applyMappingOverrides();
    console.log('[indexer] mapping-xml', result);
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// POST /indexer/mapping/fribb-refresh
// Backfills anilist/mal/kitsu/livechart/anisearch/anime-planet/ann/
// animecountdown/simkl ids + type from the Fribb-format JSON.
indexerRoutes.post('/mapping/fribb-refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  const force = isForce(c.req.query('force'));
  jsonQueue.enqueue('manual:mapping-fribb', 10, async (ctx) => {
    const result = await ingestFribb(undefined, ctx, { force });
    await applyMappingOverrides();
    console.log('[indexer] mapping-fribb', result);
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// POST /indexer/mapping/lists-refresh
// lists-main: id freshness backfill (only fills gaps) + currently-airing
// snapshot (airing / episodeProgress / nextEpisodeAt).
indexerRoutes.post('/mapping/lists-refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  const force = isForce(c.req.query('force'));
  jsonQueue.enqueue('manual:mapping-lists', 10, async (ctx) => {
    const ids = await ingestListsIds(undefined, ctx, { force });
    const airing = await ingestAiring(undefined, { force });
    await applyMappingOverrides();
    console.log('[indexer] mapping-lists', { ids, airing });
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// POST /indexer/mapping/ani-zip-refresh
// Optional local source. It is a no-op when ani.zip has not been copied to
// ANI_ZIP_PATH yet, making deployments without the archive safe.
indexerRoutes.post('/mapping/ani-zip-refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  jsonQueue.enqueue('manual:mapping-ani-zip', 10, async (ctx) => {
    const result = await ingestAniZip(undefined, ctx);
    console.log('[indexer] mapping-ani-zip', result);
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// GET /indexer/queue/status
// Read-only, ungated -- reveals job names/state only, nothing sensitive.
indexerRoutes.get('/queue/status', (c) => {
  return c.json({ json: jsonQueue.status(), providers: providerQueue.status() });
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

  const jobNames = ['mapping-ani-zip', 'mapping-xml', 'mapping-fribb', 'mapping-lists-ids', 'provider-reconcile', 'provider-full-reconcile'];
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
    ),
    tmdb_cache: await safe('count:tmdb_cache', async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.tmdbCache))[0].n),
    ani_zip_cache: await safe('count:ani_zip_cache', async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.aniZipCache))[0].n),
    catalog_entry: await safe('count:catalog_entry', async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.catalogEntry))[0].n),
    mapping_override: await safe('count:mapping_override', async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.mappingOverride))[0].n)
  };

  // Per remote source: when it was last checked, when it last actually changed,
  // the row count the size guard compares against, and why the last run was
  // rejected or failed (if it was). A source stuck on "rejected" is the thing
  // to look at first.
  const sources = await safe('source_state', async () =>
    (await db.select().from(schema.sourceState).orderBy(schema.sourceState.sourceKey)).map((row) => ({
      source: row.sourceKey,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      rowCount: row.rowCount,
      lastCheckedAt: row.lastCheckedAt,
      lastChangedAt: row.lastChangedAt,
      contentLength: row.contentLength
    }))
  );

  return c.json({
    queues: { json: jsonQueue.status(), providers: providerQueue.status() },
    jobs,
    sources,
    rowCounts,
    scheduler: { enabled: Config.scheduler.enabled }
  });
});

// POST /indexer/mapping/sync[?force=true]
// Runs local ani.zip, XML, Fribb, lists-main ids, the catalog gap-fill, then
// lists-main airing, then re-applies manual overrides -- exactly what the
// scheduler does on MAPPING_SYNC_HOURS (see mapping/sync.ts). Sources that
// have not changed since their last successful run are skipped.
// The routes above still exist individually for targeted debugging.
indexerRoutes.post('/mapping/sync', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  const force = isForce(c.req.query('force'));
  jsonQueue.enqueue('manual:mapping-sync', 10, async (ctx) => {
    const result = await runMappingSync(ctx, { force });
    console.log('[indexer] mapping-sync', result);
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// POST /indexer/catalog/sync[?force=true]
// Refreshes the anime-offline-database catalog (titles without an AniDB id,
// fallback images, synonyms, tags), then gap-fills `mapping` from it.
indexerRoutes.post('/catalog/sync', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  const force = isForce(c.req.query('force'));
  jsonQueue.enqueue('manual:catalog-sync', 10, async (ctx) => {
    const result = await runCatalogSync(ctx, { force });
    console.log('[indexer] catalog-sync', result);
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// --- Manual overrides -----------------------------------------------------
// Corrections that survive every re-sync (see mapping/overrides.ts). They are
// re-applied at the end of each mapping sync; the routes below only edit the
// stored list and queue an apply, so writes still go through jsonQueue.

// GET /indexer/overrides
indexerRoutes.get('/overrides', async (c) => {
  const overrides = await db.select().from(schema.mappingOverride).orderBy(schema.mappingOverride.anidbId, schema.mappingOverride.field);
  return c.json({
    allowedFields: Object.keys(OVERRIDABLE_FIELDS),
    overrides: overrides.map((row) => ({ ...row, value: decodeOverrideValue(row.value) ?? null }))
  });
});

// PUT /indexer/overrides/:anidbId/:field   body: { "value": <json>, "reason": "why" }
// value null = force that column empty. Example: pin the wrong TVDB mapping:
//   PUT /indexer/overrides/1234/tvdbId   { "value": 98765, "reason": "xml maps season 2 to the wrong series" }
indexerRoutes.put('/overrides/:anidbId/:field', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);

  const anidbId = Number(c.req.param('anidbId'));
  if (!Number.isSafeInteger(anidbId) || anidbId <= 0) return c.json({ error: 'anidbId must be a positive integer' }, 400);

  let body: { value?: unknown; reason?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be JSON: { "value": ..., "reason": "..." }' }, 400);
  }
  if (typeof body !== 'object' || body === null || !('value' in body)) {
    return c.json({ error: 'body must include "value" (use null to clear the field)' }, 400);
  }

  const field = c.req.param('field');
  const check = validateOverrideValue(field, body.value);
  if (!check.ok) return c.json({ error: check.error }, 400);
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;

  const now = new Date();
  await db
    .insert(schema.mappingOverride)
    .values({ anidbId, field, value: encodeOverrideValue(check.value), reason, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [schema.mappingOverride.anidbId, schema.mappingOverride.field],
      set: { value: encodeOverrideValue(check.value), reason, updatedAt: now }
    });

  jsonQueue.enqueue('manual:overrides-apply', 10, async () => {
    console.log('[indexer] overrides-apply', await applyMappingOverrides());
  });
  return c.json({ saved: { anidbId, field, value: check.value, reason }, queued: true });
});

// DELETE /indexer/overrides/:anidbId/:field
// Removing an override does not by itself bring the original value back --
// that only returns when a source next writes it -- so this also queues a
// forced mapping sync to restore it now.
indexerRoutes.delete('/overrides/:anidbId/:field', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);

  const anidbId = Number(c.req.param('anidbId'));
  if (!Number.isSafeInteger(anidbId) || anidbId <= 0) return c.json({ error: 'anidbId must be a positive integer' }, 400);

  const field = c.req.param('field');
  const removed = await db
    .delete(schema.mappingOverride)
    .where(and(eq(schema.mappingOverride.anidbId, anidbId), eq(schema.mappingOverride.field, field)))
    .returning({ field: schema.mappingOverride.field });
  if (removed.length === 0) return c.json({ error: 'no such override' }, 404);

  jsonQueue.enqueue('manual:overrides-revert', 10, async (ctx) => {
    console.log('[indexer] overrides-revert', await runMappingSync(ctx, { force: true }));
  });
  return c.json({ deleted: { anidbId, field }, queued: true });
});

// POST /indexer/overrides/apply -- re-apply all stored overrides now.
indexerRoutes.post('/overrides/apply', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  jsonQueue.enqueue('manual:overrides-apply', 10, async () => {
    console.log('[indexer] overrides-apply', await applyMappingOverrides());
  });
  return c.json({ queued: true, queue: jsonQueue.status() });
});

// --- Data-quality reports -------------------------------------------------
// GET /indexer/reports                       counts for every report
// GET /indexer/reports/:kind?limit=&offset=  the rows (kinds are listed by the summary)
indexerRoutes.get('/reports', async (c) => c.json(await reportSummary()));

indexerRoutes.get('/reports/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (!isReportKind(kind)) return c.json({ error: 'unknown report; GET /indexer/reports lists them' }, 404);
  const limit = Math.min(Math.max(Math.trunc(Number(c.req.query('limit') ?? 100)) || 100, 1), 1000);
  const offset = Math.max(Math.trunc(Number(c.req.query('offset') ?? 0)) || 0, 0);
  return c.json({ kind, ...(await reportRows(kind, limit, offset)) });
});

// POST /indexer/providers/incremental
// One ordered TVDB -> TMDB fallback -> ani.zip cross-reference pass per
// anime. The individual legacy paths below are kept as aliases so existing
// deployments switch safely to this single pipeline.
indexerRoutes.post('/providers/incremental', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  providerQueue.enqueue('manual:provider-incremental', 20, async (ctx) => {
    const result = await runProviderSync('incremental', ctx);
    console.log('[indexer] provider-incremental', result);
  });
  return c.json({ queued: true, queue: providerQueue.status() });
});

indexerRoutes.post('/providers/full', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  providerQueue.enqueue('manual:provider-full', 10, async (ctx) => {
    const result = await runProviderSync('full', ctx);
    console.log('[indexer] provider-full', result);
  });
  return c.json({ queued: true, queue: providerQueue.status() });
});

indexerRoutes.post('/tvdb/incremental', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  providerQueue.enqueue('manual:provider-incremental', 20, async (ctx) => {
    const result = await runProviderSync('incremental', ctx);
    console.log('[indexer] provider-incremental', result);
  });
  return c.json({ queued: true, queue: providerQueue.status() });
});

// POST /indexer/tvdb/full
// Every mapped tvdb_id, regardless of cache state. Slow -- meant to be run
// rarely (TVDB_FULL_SYNC_HOURS, default 30 days).
indexerRoutes.post('/tvdb/full', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  providerQueue.enqueue('manual:provider-full', 10, async (ctx) => {
    const result = await runProviderSync('full', ctx);
    console.log('[indexer] provider-full', result);
  });
  return c.json({ queued: true, queue: providerQueue.status() });
});

indexerRoutes.post('/tmdb/incremental', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  providerQueue.enqueue('manual:provider-incremental', 20, async (ctx) => {
    const result = await runProviderSync('incremental', ctx);
    console.log('[indexer] provider-incremental', result);
  });
  return c.json({ queued: true, queue: providerQueue.status() });
});

indexerRoutes.post('/tmdb/full', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  providerQueue.enqueue('manual:provider-full', 10, async (ctx) => {
    const result = await runProviderSync('full', ctx);
    console.log('[indexer] provider-full', result);
  });
  return c.json({ queued: true, queue: providerQueue.status() });
});

// Free remote enrichment for localized titles, provider-ID gap fills,
// direct episode mappings, summaries, images, and episode artwork.
indexerRoutes.post('/ani-zip/incremental', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  providerQueue.enqueue('manual:provider-incremental', 20, async (ctx) => {
    const result = await runProviderSync('incremental', ctx);
    console.log('[indexer] provider-incremental', result);
  });
  return c.json({ queued: true, queue: providerQueue.status() });
});

indexerRoutes.post('/ani-zip/full', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  providerQueue.enqueue('manual:provider-full', 10, async (ctx) => {
    const result = await runProviderSync('full', ctx);
    console.log('[indexer] provider-full', result);
  });
  return c.json({ queued: true, queue: providerQueue.status() });
});
