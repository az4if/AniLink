import { Hono } from 'hono';
import { Config } from '../config.js';
import { ingestMapping } from '../mapping/ingest.js';
import { ingestFribb } from '../mapping/fribb.js';
import { ingestListsIds, ingestAiring } from '../mapping/lists.js';

export const indexerRoutes = new Hono();

function requireAdmin(headerValue: string | undefined): boolean {
  return Boolean(headerValue) && headerValue === Config.adminKey;
}

// POST /indexer/mapping/refresh
// Re-downloads anime-list-master.xml and upserts the full mapping table.
// Cheap (a static file fetch + parse), safe to trigger often -- this is the
// one job with no external rate limit to worry about. Run this BEFORE the
// two below, since it establishes every anidb_id row they then backfill.
indexerRoutes.post('/mapping/refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  try {
    const result = await ingestMapping();
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error('[indexer] mapping refresh failed:', err);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// POST /indexer/mapping/fribb-refresh
// Backfills anilist/mal/kitsu/livechart/anisearch/anime-planet/ann/
// animecountdown/simkl ids + type from the Fribb-format JSON.
indexerRoutes.post('/mapping/fribb-refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  try {
    const result = await ingestFribb();
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error('[indexer] fribb refresh failed:', err);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// POST /indexer/mapping/lists-refresh
// lists-main: id freshness backfill (only fills gaps) + currently-airing
// snapshot (airing / episodeProgress / nextEpisodeAt).
indexerRoutes.post('/mapping/lists-refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) return c.json({ error: 'unauthorized' }, 401);
  try {
    const [ids, airing] = await Promise.all([ingestListsIds(), ingestAiring()]);
    return c.json({ ok: true, ids, airing });
  } catch (err) {
    console.error('[indexer] lists refresh failed:', err);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// Placeholders for the next build phases:
//   POST /indexer/tvdb/active/run
//   POST /indexer/tvdb/reconcile/run   (resumable via indexer_state cursor)
//   POST /indexer/merge/run
