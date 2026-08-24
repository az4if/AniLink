import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { Config } from './config.js';
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

app.get('/health', (c) => c.json({ ok: true }));
app.route('/indexer', indexerRoutes);
app.route('/mappings', mappingsRoutes);

serve({ fetch: app.fetch, port: Config.port }, (info) => {
  console.log(`AniLink listening on :${info.port}`);
  startKeepAlive();
  startScheduler();
});
