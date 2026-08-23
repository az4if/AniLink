import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export const mappingsRoutes = new Hono();

// GET /mappings?anidb_id=23
// GET /mappings?mal_id=205
// GET /mappings?anilist_id=1
// GET /mappings?thetvdb_id=76885
mappingsRoutes.get('/', async (c) => {
  const anidbId = c.req.query('anidb_id');
  const malId = c.req.query('mal_id');
  const anilistId = c.req.query('anilist_id');
  const tvdbId = c.req.query('thetvdb_id');

  let row;
  if (anidbId) {
    row = await db.query.anime.findFirst({ where: eq(schema.anime.anidbId, Number(anidbId)) });
  } else if (malId) {
    row = await db.query.anime.findFirst({ where: eq(schema.anime.malId, Number(malId)) });
  } else if (anilistId) {
    row = await db.query.anime.findFirst({ where: eq(schema.anime.anilistId, Number(anilistId)) });
  } else if (tvdbId) {
    row = await db.query.anime.findFirst({ where: eq(schema.anime.tvdbId, Number(tvdbId)) });
  } else {
    return c.json({ error: 'provide one of: anidb_id, mal_id, anilist_id, thetvdb_id' }, 400);
  }

  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row.data);
});
