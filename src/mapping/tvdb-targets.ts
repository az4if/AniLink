import { isNotNull, isNull, or, eq, and } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

/**
 * Which distinct tvdb_ids need a TVDB fetch right now.
 *
 * 'full'        -- every tvdb_id any anime maps to. Used for the monthly
 *                  full resync (TVDB_FULL_SYNC_HOURS).
 * 'incremental' -- only tvdb_ids that are either currently airing (always
 *                  worth rechecking -- new episodes) OR have never been
 *                  fetched at all (no row in tvdb_cache yet).
 *
 * Deliberately one query, not two separate "first run" / "later run" code
 * paths: on a brand new tvdb_cache (nothing fetched yet), EVERY tvdb_id
 * satisfies "never been fetched", so 'incremental' naturally returns the
 * full set the first time and shrinks on its own as tvdb_cache fills in --
 * "first run is slow, later runs are fast" falls out of the data, it's not
 * something the code has to track separately.
 *
 * Distinct because more than one anime can share a tvdb_id (a real example
 * already found in this project: Ghost in the Shell has several AniDB
 * catalog entries -- different cuts -- mapped to the same TVDB entry).
 * There's no reason to fetch the same tvdb_id twice in one pass.
 */
export async function getTvdbSyncTargets(mode: 'incremental' | 'full'): Promise<number[]> {
  if (mode === 'full') {
    const rows = await db.selectDistinct({ tvdbId: schema.mapping.tvdbId }).from(schema.mapping).where(isNotNull(schema.mapping.tvdbId));
    return rows.map((r) => r.tvdbId).filter((id): id is number => id !== null);
  }

  const rows = await db
    .selectDistinct({ tvdbId: schema.mapping.tvdbId })
    .from(schema.mapping)
    .leftJoin(schema.tvdbCache, eq(schema.mapping.tvdbId, schema.tvdbCache.tvdbId))
    .where(and(isNotNull(schema.mapping.tvdbId), or(eq(schema.mapping.airing, true), isNull(schema.tvdbCache.tvdbId))));
  return rows.map((r) => r.tvdbId).filter((id): id is number => id !== null);
}
