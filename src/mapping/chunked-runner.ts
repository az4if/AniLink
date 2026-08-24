import { inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { readCursor, writeCursor } from './indexer-cursor.js';

export type YieldCtx = { shouldYield: () => boolean };

export type ChunkedResult = { processed: number; done: boolean; yielded: boolean; added: number[] };

/**
 * Checks which of the given anidb_ids DON'T already exist in `mapping` --
 * i.e. which ones this chunk is about to add for the first time, as opposed
 * to updating an existing row. One SELECT per chunk, not per row.
 */
export async function findNewAnidbIds(anidbIds: number[]): Promise<Set<number>> {
  if (anidbIds.length === 0) return new Set();
  const existing = await db
    .select({ anidbId: schema.mapping.anidbId })
    .from(schema.mapping)
    .where(inArray(schema.mapping.anidbId, anidbIds));
  const existingSet = new Set(existing.map((r) => r.anidbId));
  return new Set(anidbIds.filter((id) => !existingSet.has(id)));
}

/**
 * Processes `items` in chunks of `chunkSize`, calling `processChunk` for
 * each. Resumable: starts from wherever `jobName` last left its cursor
 * (from a previous run that got cut short), and checks `ctx.shouldYield()`
 * between chunks -- if a higher-priority job wants the JobQueue, this
 * checkpoints its position to `indexer_state` and returns early instead of
 * finishing the whole list, so the queue can hand control over without
 * losing progress. The next time this job runs, it picks back up exactly
 * where it stopped rather than starting over.
 *
 * On a full, uninterrupted pass, the cursor resets to 0 -- so the next
 * scheduled run starts fresh from the top rather than resuming forever.
 *
 * `getAnidbId` extracts the anidb_id from an item so new-vs-existing can be
 * tracked and returned as `added`.
 */
export async function runChunked<T>(
  jobName: string,
  items: T[],
  chunkSize: number,
  getAnidbId: (item: T) => number,
  processChunk: (chunk: T[]) => Promise<void>,
  ctx?: YieldCtx
): Promise<ChunkedResult> {
  let i = await readCursor(jobName);
  if (i >= items.length) i = 0; // stale cursor from a previously-shorter list

  let processed = 0;
  const added: number[] = [];
  while (i < items.length) {
    const chunk = items.slice(i, i + chunkSize);
    const newIds = await findNewAnidbIds(chunk.map(getAnidbId));
    for (const id of newIds) added.push(id);

    await processChunk(chunk);
    processed += chunk.length;
    i += chunkSize;

    if (ctx?.shouldYield()) {
      await writeCursor(jobName, i);
      console.log(`[${jobName}] yielding at ${i}/${items.length} for a higher-priority job`);
      return { processed, done: false, yielded: true, added };
    }
  }

  await writeCursor(jobName, 0); // full pass complete, reset for next run
  return { processed, done: true, yielded: false, added };
}
