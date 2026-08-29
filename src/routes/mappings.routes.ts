import { Hono } from 'hono';
import { arrayContains, eq, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { buildMappingResponse } from '../mapping/response.js';

export const mappingsRoutes = new Hono();

export const LOOKUP_NAMES = [
  'anidb_id', 'mal_id', 'anilist_id', 'kitsu_id', 'anisearch_id',
  'notifymoe_id', 'livechart_id', 'thetvdb_id', 'themoviedb_id',
  'imdb_id', 'animeplanet_id'
] as const;

type LookupName = (typeof LOOKUP_NAMES)[number];
const TEXT_LOOKUPS = new Set<LookupName>(['imdb_id', 'animeplanet_id']);

function lookupWhere(param: LookupName, value: string) {
  switch (param) {
    case 'anidb_id': return eq(schema.mapping.anidbId, Number(value));
    case 'mal_id': return eq(schema.mapping.malId, Number(value));
    case 'anilist_id': return eq(schema.mapping.anilistId, Number(value));
    case 'kitsu_id': return eq(schema.mapping.kitsuId, Number(value));
    case 'anisearch_id': return eq(schema.mapping.anisearchId, Number(value));
    case 'notifymoe_id': return eq(schema.mapping.notifyMoeId, Number(value));
    case 'livechart_id': return eq(schema.mapping.livechartId, Number(value));
    case 'thetvdb_id': return eq(schema.mapping.tvdbId, Number(value));
    case 'themoviedb_id': return or(eq(schema.mapping.tmdbTvId, Number(value)), arrayContains(schema.mapping.tmdbMovieIds, [Number(value)]));
    case 'imdb_id': return arrayContains(schema.mapping.imdbIds, [value]);
    case 'animeplanet_id': return eq(schema.mapping.animePlanetId, value);
  }
}

// GET /mappings?anidb_id=18278
// GET /mappings?mal_id=57181
// GET /mappings?anilist_id=170942
// GET /mappings?thetvdb_id=429934
// All stable provider IDs exposed in `ids` are accepted, including TMDB
// TV/movie IDs, IMDb IDs, and Anime-Planet slugs.
mappingsRoutes.get('/', async (c) => {
  const param = LOOKUP_NAMES.find((key) => c.req.query(key) !== undefined);
  if (!param) return c.json({ error: `provide one of: ${LOOKUP_NAMES.join(', ')}` }, 400);

  const value = c.req.query(param)!.trim();
  if (!value) return c.json({ error: `${param} cannot be empty` }, 400);
  if (!TEXT_LOOKUPS.has(param) && !Number.isSafeInteger(Number(value))) return c.json({ error: `${param} must be an integer` }, 400);

  const row = await db.query.mapping.findFirst({ where: lookupWhere(param, value) });
  if (!row) return c.json({ error: 'not found' }, 404);

  // The merged record is keyed by AniDB, so every lookup can return the
  // rich response rather than only the historic small lookup subset.
  const merged = await db.query.anime.findFirst({ where: eq(schema.anime.anidbId, row.anidbId) });
  if (merged?.data) return c.json(merged.data);
  return c.json(buildMappingResponse(row));
});
