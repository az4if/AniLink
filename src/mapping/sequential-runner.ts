import { Config } from '../config.js';
import { readCursor, writeCursor } from './indexer-cursor.js';
import type { YieldCtx } from './chunked-runner.js';

export type SequentialResult = { processed: number; done: boolean; yielded: boolean; endCursor: number };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The actual ask/get/index/wait/next-id loop, decoupled from where the
 * starting cursor comes from -- exported separately so it's unit-testable
 * without a live DB. `runSequential` below is the thin DB-backed wrapper
 * used in production.
 */
export async function sequentialCore<T>(
  jobName: string,
  ids: T[],
  startCursor: number,
  indexOne: (id: T) => Promise<void>,
  ctx?: YieldCtx,
  delayMs: number = Config.indexDelayMs
): Promise<SequentialResult> {
  let i = startCursor >= ids.length ? 0 : startCursor; // stale cursor from a previously-shorter list
  let processed = 0;

  while (i < ids.length) {
    await indexOne(ids[i]);
    processed++;
    i++;

    if (ctx?.shouldYield()) {
      console.log(`[${jobName}] yielding at ${i}/${ids.length} for a higher-priority job`);
      return { processed, done: false, yielded: true, endCursor: i };
    }

    if (i < ids.length) {
      await sleep(delayMs);
    }
  }

  return { processed, done: true, yielded: false, endCursor: 0 }; // full pass -> reset for next run
}

/**
 * Processes `ids` one at a time: ask the provider for this id's data, get
 * the response, index it -- via `indexOne` -- then wait `delayMs` before
 * moving to the next id. This is the shape a single-key rate-limited API
 * (TVDB or TMDB) needs; deliberately NOT the same as chunked-runner.ts, which
 * batches many rows into one upsert -- there's no batching a provider that
 * only accepts one id per request.
 *
 * Resumable and yield-aware exactly like chunked-runner.ts, just checked
 * after every single id instead of every chunk -- even one more provider
 * call is worth avoiding right before a higher-priority job needs the
 * queue. `delayMs` defaults to `Config.indexDelayMs` (the INDEX_DELAY env
 * var, in seconds, converted to ms).
 */
export async function runSequential<T>(
  jobName: string,
  ids: T[],
  indexOne: (id: T) => Promise<void>,
  ctx?: YieldCtx,
  delayMs: number = Config.indexDelayMs
): Promise<Omit<SequentialResult, 'endCursor'>> {
  const startCursor = await readCursor(jobName);
  const result = await sequentialCore(jobName, ids, startCursor, indexOne, ctx, delayMs);
  await writeCursor(jobName, result.endCursor);
  return result;
}
