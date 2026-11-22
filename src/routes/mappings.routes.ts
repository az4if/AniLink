import { Hono } from 'hono';
import { arrayContains, eq, or } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { buildMappingResponse } from '../mapping/response.js';
import { buildCatalogResponse, isCatalogLookup, overlayCatalog, type CatalogLookupName } from '../mapping/catalog.js';

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

function catalogWhere(param: CatalogLookupName, value: string) {
  switch (param) {
    case 'anidb_id': return eq(schema.catalogEntry.anidbId, Number(value));
    case 'mal_id': return eq(schema.catalogEntry.malId, Number(value));
    case 'anilist_id': return eq(schema.catalogEntry.anilistId, Number(value));
    case 'kitsu_id': return eq(schema.catalogEntry.kitsuId, Number(value));
    case 'anisearch_id': return eq(schema.catalogEntry.anisearchId, Number(value));
    case 'livechart_id': return eq(schema.catalogEntry.livechartId, Number(value));
    case 'animeplanet_id': return eq(schema.catalogEntry.animePlanetId, value);
  }
}

/** The catalog entry for a mapping row: matched on AniDB id first, then AniList, then MAL. */
async function catalogForRow(row: { anidbId: number; anilistId: number | null; malId: number | null }) {
  const byAnidb = await db.query.catalogEntry.findFirst({ where: eq(schema.catalogEntry.anidbId, row.anidbId) });
  if (byAnidb) return byAnidb;
  if (row.anilistId !== null) {
    const byAnilist = await db.query.catalogEntry.findFirst({ where: eq(schema.catalogEntry.anilistId, row.anilistId) });
    if (byAnilist) return byAnilist;
  }
  if (row.malId !== null) return (await db.query.catalogEntry.findFirst({ where: eq(schema.catalogEntry.malId, row.malId) })) ?? null;
  return null;
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

  if (!row) {
    // No AniDB-keyed row. The catalog (anime-offline-database) also covers
    // titles that have no AniDB id at all, so try it before giving up.
    const orphan = isCatalogLookup(param) ? await db.query.catalogEntry.findFirst({ where: catalogWhere(param, value) }) : undefined;
    if (!orphan) return c.json({ error: 'not found' }, 404);
    return c.json(buildCatalogResponse(orphan));
  }

  // The merged record is keyed by AniDB, so every lookup can return the
  // rich response rather than only the historic small lookup subset.
  const [merged, catalog] = await Promise.all([
    db.query.anime.findFirst({ where: eq(schema.anime.anidbId, row.anidbId) }),
    catalogForRow(row)
  ]);
  // Catalog data only fills gaps (ids, title, image, episode count) and adds a
  // `catalog` block; it never overrides TVDB/TMDB/ani.zip. Applied at read
  // time so it is always as fresh as the last catalog sync.
  const base = (merged?.data as Record<string, unknown> | null) ?? buildMappingResponse(row);
  return c.json(overlayCatalog(base, catalog ?? null));
});
