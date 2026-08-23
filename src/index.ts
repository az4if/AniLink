import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { Config } from './config.js';
import { startKeepAlive } from './helpers/self-poll.js';
import { indexerRoutes } from './routes/indexer.routes.js';
import { mappingsRoutes } from './routes/mappings.routes.js';

const app = new Hono();

// serves public/favicon.ico, public/favicon.png, etc.
app.use('/*', serveStatic({ root: './public' }));

app.get('/', (c) =>
  c.html(
    `<!doctype html><html><head><title>AniLink</title><link rel="icon" href="/favicon.ico"></head>` +
      `<body style="font-family:system-ui;text-align:center;padding:4rem">` +
      `<img src="/favicon.png" width="96" height="96" alt="AniLink" style="border-radius:20px">` +
      `<h1>AniLink</h1><p>AniDB &lt;-&gt; TVDB/TMDB/AniList/MAL episode mapping API.</p>` +
      `<p><a href="/mappings?anidb_id=23">/mappings?anidb_id=23</a></p>` +
      `</body></html>`
  )
);

app.get('/health', (c) => c.json({ ok: true }));
app.route('/indexer', indexerRoutes);
app.route('/mappings', mappingsRoutes);

serve({ fetch: app.fetch, port: Config.port }, (info) => {
  console.log(`AniLink listening on :${info.port}`);
  startKeepAlive();
});
