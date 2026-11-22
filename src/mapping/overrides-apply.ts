import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { remergeAnime } from './merge.js';
import { buildOverridePatch, changedFields, decodeOverrideValue, type Rejected } from './overrides.js';

export type ApplyOverridesResult = {
  overrides: number;
  rows: number;
  changed: number[];
  missing: number[];
  rejected: Array<Rejected & { anidbId: number }>;
};

/**
 * Re-applies every stored override onto `mapping`. Called at the end of each
 * sync (after all sources have had their say) and whenever an override is
 * added. Idempotent: rows that already match are not written, so running it
 * with no overrides (or no drift) costs one SELECT.
 *
 * Rows whose values actually changed are re-merged so the served document
 * (episodes in particular, which depend on tvdb/tmdb ids and offsets) reflects
 * the correction immediately instead of at the next provider pass.
 */
export async function applyMappingOverrides(): Promise<ApplyOverridesResult> {
  const stored = await db.select().from(schema.mappingOverride);
  const result: ApplyOverridesResult = { overrides: stored.length, rows: 0, changed: [], missing: [], rejected: [] };
  if (stored.length === 0) return result;

  const byAnime = new Map<number, Array<{ field: string; value: unknown }>>();
  for (const row of stored) {
    const value = decodeOverrideValue(row.value);
    if (value === undefined) {
      // Corrupt stored text. Never fall through to validation: undefined reads as
      // "clear the column", which would blank a good id because of a bad row.
      result.rejected.push({ anidbId: row.anidbId, field: row.field, error: 'stored value is not valid JSON' });
      continue;
    }
    const list = byAnime.get(row.anidbId) ?? [];
    list.push({ field: row.field, value });
    byAnime.set(row.anidbId, list);
  }
  result.rows = byAnime.size;
  if (byAnime.size === 0) return result;

  const current = await db.select().from(schema.mapping).where(inArray(schema.mapping.anidbId, [...byAnime.keys()]));
  const currentById = new Map<number, Record<string, unknown>>(current.map((row: { anidbId: number }) => [row.anidbId, row as unknown as Record<string, unknown>]));

  for (const [anidbId, overrides] of byAnime) {
    const row = currentById.get(anidbId);
    if (!row) {
      result.missing.push(anidbId);
      continue;
    }

    const { patch, rejected } = buildOverridePatch(overrides);
    for (const item of rejected) result.rejected.push({ anidbId, ...item });

    const changes = changedFields(row, patch);
    if (Object.keys(changes).length === 0) continue;

    await db
      .update(schema.mapping)
      .set({ ...changes, updatedAt: new Date() } as Partial<typeof schema.mapping.$inferInsert>)
      .where(eq(schema.mapping.anidbId, anidbId));
    result.changed.push(anidbId);
  }

  for (const anidbId of result.changed) {
    try {
      await remergeAnime(anidbId);
    } catch (err) {
      // The correction is already stored; a failed re-merge is repaired by the next provider pass.
      console.error(`[overrides] re-merge failed for anidb_id=${anidbId}:`, err instanceof Error ? err.message : err);
    }
  }

  if (result.changed.length > 0 || result.missing.length > 0 || result.rejected.length > 0) {
    console.log(
      `[overrides] ${result.overrides} stored, ${result.changed.length} rows corrected, ${result.missing.length} missing, ${result.rejected.length} rejected`
    );
  }
  return result;
}
