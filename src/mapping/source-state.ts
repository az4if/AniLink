import { eq } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import type { SourceFingerprint } from '../helpers/conditional-fetch.js';
import { loadGuardedSource, type GuardedLoad, type GuardedLoadOptions, type SourceStore } from './guarded-source.js';

type SourceStateRow = typeof schema.sourceState.$inferSelect;

export function rowToFingerprint(row: SourceStateRow | undefined): SourceFingerprint | null {
  if (!row || (!row.etag && !row.lastModified && !row.contentHash)) return null;
  return { etag: row.etag, lastModified: row.lastModified, contentHash: row.contentHash, contentLength: row.contentLength };
}

/** Postgres-backed SourceStore. Fingerprint columns move only on commit(); record() just notes the outcome. */
export const dbSourceStore: SourceStore = {
  async load(sourceKey) {
    const row = await db.query.sourceState.findFirst({ where: eq(schema.sourceState.sourceKey, sourceKey) });
    return { fingerprint: rowToFingerprint(row), rowCount: row?.rowCount ?? null };
  },

  async commit(sourceKey, fingerprint, rowCount) {
    const now = new Date();
    const values = {
      etag: fingerprint.etag,
      lastModified: fingerprint.lastModified,
      contentHash: fingerprint.contentHash,
      contentLength: fingerprint.contentLength,
      rowCount,
      lastStatus: 'changed',
      lastError: null,
      lastCheckedAt: now,
      lastChangedAt: now,
      updatedAt: now
    };
    await db
      .insert(schema.sourceState)
      .values({ sourceKey, ...values })
      .onConflictDoUpdate({ target: schema.sourceState.sourceKey, set: values });
  },

  async record(sourceKey, status, message, fingerprint) {
    const now = new Date();
    // An 'unchanged' check may carry a refreshed validator (e.g. a new ETag for identical bytes).
    const validators = status === 'unchanged' && fingerprint ? { etag: fingerprint.etag, lastModified: fingerprint.lastModified } : {};
    const values = { lastStatus: status, lastError: message, lastCheckedAt: now, updatedAt: now, ...validators };
    await db
      .insert(schema.sourceState)
      .values({ sourceKey, ...values })
      .onConflictDoUpdate({ target: schema.sourceState.sourceKey, set: values });
  }
};

/** Shared entry point for the text sources: change detection + size guard against the DB-backed state. */
export function loadSource<T>(options: Omit<GuardedLoadOptions<T>, 'maxDropPercent'> & { maxDropPercent?: number }): Promise<GuardedLoad<T>> {
  return loadGuardedSource(dbSourceStore, {
    maxDropPercent: Config.sync.maxDropPercent,
    ...options,
    force: options.force || Config.sync.forceRefresh
  });
}
