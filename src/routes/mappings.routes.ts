import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { buildMappingResponse } from '../mapping/response.js';

export const mappingsRoutes = new Hono();

const LOOKUPS = {
  anidb_id: schema.mapping.anidbId,
  mal_id: schema.mapping.malId,
  anilist_id: schema.mapping.anilistId,
  thetvdb_id: schema.mapping.tvdbId
} as const;

const MERGED_LOOKUPS = {
  anidb_id: schema.anime.anidbId,
  mal_id: schema.anime.malId,
  anilist_id: schema.anime.anilistId,
  thetvdb_id: schema.anime.tvdbId
} as const;

// GET /mappings?anidb_id=18278
// GET /mappings?mal_id=57181
// GET /mappings?anilist_id=170942
// GET /mappings?thetvdb_id=429934
mappingsRoutes.get('/', async (c) => {
  const param = (Object.keys(LOOKUPS) as (keyof typeof LOOKUPS)[]).find((key) => c.req.query(key));
  if (!param) return c.json({ error: `provide one of: ${Object.keys(LOOKUPS).join(', ')}` }, 400);

  const value = Number(c.req.query(param));
  if (!Number.isFinite(value)) return c.json({ error: `${param} must be a number` }, 400);

  // Prefer the merged store once it exists (richer: description/image/full
  // episode list). Right now this never hits -- the merge engine isn't
  // built yet -- but the route doesn't need to change again once it is.
  const merged = await db.query.anime.findFirst({ where: eq(MERGED_LOOKUPS[param], value) });
  if (merged?.data) return c.json(merged.data);

  const row = await db.query.mapping.findFirst({ where: eq(LOOKUPS[param], value) });
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(buildMappingResponse(row));
});
