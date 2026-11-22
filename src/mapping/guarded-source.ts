import { fetchTextIfChanged, type Fetcher, type SourceFingerprint } from '../helpers/conditional-fetch.js';
import { evaluateRowCount, SyncGuardError } from './sync-guard.js';

/**
 * Persistence for "what did the last good run look like". The real
 * implementation is DB-backed (source-state.ts); tests use an in-memory one.
 */
export interface SourceStore {
  load(sourceKey: string): Promise<{ fingerprint: SourceFingerprint | null; rowCount: number | null }>;
  /** Only called after a source was fully processed. */
  commit(sourceKey: string, fingerprint: SourceFingerprint, rowCount: number): Promise<void>;
  record(sourceKey: string, status: 'unchanged' | 'rejected' | 'error', message: string | null, fingerprint?: SourceFingerprint): Promise<void>;
}

/** Options every ingest accepts. `force` = re-process even if unchanged and bypass the size guard. */
export type SourceSyncOptions = { force?: boolean };

export type GuardedLoad<T> =
  | { skipped: true; reason: 'not-modified' | 'same-content' }
  | { skipped: false; data: T; rowCount: number; commit: () => Promise<void> };

export type GuardedLoadOptions<T> = {
  key: string;
  url: string;
  label: string;
  parse: (text: string) => T;
  count: (data: T) => number;
  /** Re-process even if unchanged AND bypass the row-count guard (explicit operator intent). */
  force?: boolean;
  maxDropPercent?: number;
  fetcher?: Fetcher;
};

/**
 * download-if-changed -> parse -> size guard, in that order, with every
 * outcome recorded. Returns `commit` so the caller marks the source as done
 * only after its DB work finished.
 */
export async function loadGuardedSource<T>(store: SourceStore, options: GuardedLoadOptions<T>): Promise<GuardedLoad<T>> {
  const { key, url, label, force = false } = options;
  const previous = await store.load(key);

  let result;
  try {
    result = await fetchTextIfChanged(url, previous.fingerprint, { force, label, fetcher: options.fetcher });
  } catch (err) {
    await store.record(key, 'error', errorMessage(err));
    throw err;
  }

  if (!result.changed) {
    await store.record(key, 'unchanged', null, result.fingerprint);
    console.log(`[source:${key}] unchanged (${result.reason}), skipping`);
    return { skipped: true, reason: result.reason };
  }

  let data: T;
  try {
    data = options.parse(result.body);
  } catch (err) {
    await store.record(key, 'error', `parse failed: ${errorMessage(err)}`);
    throw err;
  }

  const rowCount = options.count(data);
  const verdict = evaluateRowCount(previous.rowCount, rowCount, options.maxDropPercent);
  if (!verdict.ok) {
    if (!force) {
      const error = new SyncGuardError(key, verdict.reason, verdict.dropPercent);
      await store.record(key, 'rejected', error.message);
      throw error;
    }
    console.warn(`[source:${key}] size guard overridden by force: ${verdict.reason}`);
  }

  return {
    skipped: false,
    data,
    rowCount,
    commit: () => store.commit(key, result.fingerprint, rowCount)
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
