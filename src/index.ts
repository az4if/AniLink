import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { Config } from './config.js';
import { db } from './db/index.js';
import { startKeepAlive } from './helpers/self-poll.js';
import { startScheduler } from './scheduler/index.js';
import { indexerRoutes } from './routes/indexer.routes.js';
import { mappingsRoutes } from './routes/mappings.routes.js';

const app = new Hono();

// serves public/favicon.ico, public/favicon.png, public/index.html (as static assets)
app.use('/*', serveStatic({ root: './public' }));

// explicit route rather than relying on serveStatic's directory-index
// behavior, so `/` is guaranteed to serve the landing page regardless
const landingPage = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
app.get('/', (c) => c.html(landingPage));

// GET /health
// Pings the database with a trivial query so an uptime monitor (or the
// self-poll keep-alive) can tell "process is up" apart from "process is up
// but the database connection is dead". 200+ok when the db answers, 503+error
// when it doesn't.
app.get('/health', async (c) => {
  const body: Record<string, unknown> = { timestamp: new Date().toISOString() };
  try {
    await db.execute(sql`select 1`);
    body.database = 'ok';
    body.status = 'ok';
    return c.json(body);
  } catch (err) {
    console.error('[health] database check failed', err);
    body.database = 'error';
    body.status = 'error';
    return c.json(body, 503);
  }
});

app.route('/indexer', indexerRoutes);
app.route('/mappings', mappingsRoutes);

serve({ fetch: app.fetch, port: Config.port }, (info) => {
  console.log(`AniLink listening on :${info.port}`);
  startKeepAlive();
  startScheduler();
});
