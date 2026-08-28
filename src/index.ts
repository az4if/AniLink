import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { Config } from './config.js';
import { db } from './db/index.js';
import { startKeepAlive } from './helpers/self-poll.js';
import { startScheduler } from './scheduler/index.js';
import { rateLimiter } from './helpers/rate-limit.js';
import { indexerRoutes } from './routes/indexer.routes.js';
import { mappingsRoutes } from './routes/mappings.routes.js';

const app = new Hono();

// CORS_ORIGIN=* (default) -> reflect any origin, wide open.
// CORS_ORIGIN=https://domainone.com,https://domaintwo.com -> only those
// origins get Access-Control-Allow-Origin; everyone else's browser requests
// are blocked client-side. Applied globally so it covers the static
// landing page, /health, and both route groups below. Must run before
// those handlers so preflight OPTIONS requests are answered here first.
const allowedOrigins =
  Config.corsOrigin === '*' ? '*' : Config.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
app.use('/*', cors({ origin: allowedOrigins }));

// RATE_LIMIT=100 (default) -> 100 requests per IP per RATE_LIMIT_WINDOW_SEC
// (default 60s), everywhere including /indexer/* (on top of its own
// ADMIN_KEY check) and /mappings/*. RATE_LIMIT=0 -> unlimited.
app.use('/*', rateLimiter(Config.rateLimit));

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

// Global safety net -- any unhandled error in a route (a missing DB
// table/column on a schema that's out of sync, a bad query, anything)
// returns actual diagnostic JSON instead of Hono's bare, contentless
// "Internal Server Error". Full detail always goes to server logs either
// way; this just makes sure the RESPONSE says something useful too.
app.onError((err, c) => {
  console.error(`[unhandled] ${c.req.method} ${c.req.path}`, err);
  return c.json({ error: err.message, path: c.req.path }, 500);
});

serve({ fetch: app.fetch, port: Config.port }, (info) => {
  console.log(`AniLink listening on :${info.port}`);
  startKeepAlive();
  startScheduler();
});
