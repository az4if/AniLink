import { Hono } from 'hono';
import { Config } from '../config.js';
import { ingestMapping } from '../mapping/ingest.js';

export const indexerRoutes = new Hono();

function requireAdmin(headerValue: string | undefined): boolean {
  return Boolean(headerValue) && headerValue === Config.adminKey;
}

// POST /indexer/mapping/refresh
// Re-downloads anime-list-master.xml and upserts the full mapping table.
// Cheap (a static file fetch + parse), safe to trigger often -- this is the
// one job with no external rate limit to worry about.
indexerRoutes.post('/mapping/refresh', async (c) => {
  if (!requireAdmin(c.req.header('x-admin-key'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  try {
    const result = await ingestMapping();
    return c.json({ ok: true, ...result });
  } catch (err) {
    console.error('[indexer] mapping refresh failed:', err);
    return c.json({ ok: false, error: (err as Error).message }, 500);
  }
});

// Placeholders for the next build phases -- wired up the same way once the
// AniDB/TVDB clients exist:
//   POST /indexer/anidb/active/run
//   POST /indexer/anidb/reconcile/run   (resumable via indexer_state cursor)
//   POST /indexer/tvdb/active/run
//   POST /indexer/tvdb/reconcile/run
//   POST /indexer/merge/run
