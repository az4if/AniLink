import { createHash } from 'node:crypto';
import { sql, ne } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { fetchStreamIfChanged, fetchTextIfChanged, type SourceFingerprint } from '../helpers/conditional-fetch.js';
import { streamLines } from '../helpers/stream-lines.js';
import { createCatalogCollector, entriesToCatalogRows, parseAodDocument, parseAodLine, type CatalogRow, type ConvertedCatalog } from './aod.js';
import type { SourceSyncOptions } from './guarded-source.js';
import { dbSourceStore } from './source-state.js';
import { evaluateRowCount, SyncGuardError } from './sync-guard.js';
import type { YieldCtx } from './chunked-runner.js';

const SOURCE_KEY = 'aod';
const BATCH_SIZE = 500;

export type CatalogIngestResult = {
  total: number;
  written: number;
  removed: number;
  noAnidb: number;
  skippedNoId: number;
  duplicateKeys: number;
  done: boolean;
  skipped?: string;
};

const NOTHING: Omit<CatalogIngestResult, 'done' | 'skipped'> = { total: 0, written: 0, removed: 0, noAnidb: 0, skippedNoId: 0, duplicateKeys: 0 };

/** Downloads the dataset and returns its converted rows + fingerprint, or `unchanged` when there is nothing to do. */
async function loadAod(
  force: boolean,
  prev: SourceFingerprint | null
): Promise<{ converted: ConvertedCatalog; fingerprint: SourceFingerprint } | { unchanged: string; fingerprint: SourceFingerprint }> {
  const url = Config.sources.aodUrl;
  const label = 'anime-offline-database';

  // .json = single-document variant, small enough to hold as a string (stays available for mirrors).
  if (!/\.jsonl(\?|$)/i.test(url)) {
    const result = await fetchTextIfChanged(url, prev, { force, label });
    if (!result.changed) return { unchanged: result.reason, fingerprint: result.fingerprint };
    return { converted: entriesToCatalogRows(parseAodDocument(result.body).entries), fingerprint: result.fingerprint };
  }

  // JSONL: stream it, hashing as we go and reducing each entry to its compact
  // row immediately, so the raw dataset is never held in memory.
  const result = await fetchStreamIfChanged(url, prev, { force, label });
  if (!result.changed) return { unchanged: result.reason, fingerprint: result.fingerprint };

  const hash = createHash('sha256');
  let length = 0;
  const collector = createCatalogCollector();
  for await (const line of streamLines(result.body, (chunk) => {
    hash.update(chunk);
    length += chunk.byteLength;
  })) {
    const parsed = parseAodLine(line);
    if (parsed.kind === 'entry') collector.add(parsed.entry);
  }
  const fingerprint: SourceFingerprint = { ...result.headers, contentHash: hash.digest('hex'), contentLength: length };

  if (!force && prev?.contentHash && prev.contentHash === fingerprint.contentHash) {
    return { unchanged: 'same-content', fingerprint };
  }
  return { converted: collector.finish(), fingerprint };
}

function toDbValues(row: CatalogRow, sourceHash: string, now: Date) {
  return { ...row, sourceHash, updatedAt: now };
}

function excluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/**
 * Replaces `catalog_entry` with the current dataset.
 *
 * Order matters: download -> parse -> size guard -> upsert every row stamped
 * with the download's hash -> delete rows carrying any OTHER hash -> only then
 * record the source as processed. If anything fails or the job yields half way,
 * the old rows are still all there (nothing is deleted before the new set is
 * fully written) and the next run starts over; the upserts are idempotent.
 */
export async function ingestCatalog(ctx?: YieldCtx, options: SourceSyncOptions = {}): Promise<CatalogIngestResult> {
  const force = Boolean(options.force || Config.sync.forceRefresh);
  const previous = await dbSourceStore.load(SOURCE_KEY);

  let loaded;
  try {
    loaded = await loadAod(force, previous.fingerprint);
  } catch (err) {
    await dbSourceStore.record(SOURCE_KEY, 'error', err instanceof Error ? err.message : String(err));
    throw err;
  }

  if ('unchanged' in loaded) {
    await dbSourceStore.record(SOURCE_KEY, 'unchanged', null, loaded.fingerprint);
    console.log(`[catalog-ingest] unchanged (${loaded.unchanged}), skipping`);
    return { ...NOTHING, done: true, skipped: loaded.unchanged };
  }

  const { rows, skippedNoId, duplicateKeys } = loaded.converted;
  const verdict = evaluateRowCount(previous.rowCount, rows.length, Config.sync.maxDropPercent);
  if (!verdict.ok) {
    if (!force) {
      const error = new SyncGuardError(SOURCE_KEY, verdict.reason, verdict.dropPercent);
      await dbSourceStore.record(SOURCE_KEY, 'rejected', error.message);
      throw error;
    }
    console.warn(`[catalog-ingest] size guard overridden by force: ${verdict.reason}`);
  }

  const sourceHash = loaded.fingerprint.contentHash ?? 'unknown';
  const now = new Date();
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await db
      .insert(schema.catalogEntry)
      .values(batch.map((row) => toDbValues(row, sourceHash, now)))
      .onConflictDoUpdate({
        target: schema.catalogEntry.key,
        set: {
          anidbId: excluded('anidb_id'),
          anilistId: excluded('anilist_id'),
          malId: excluded('mal_id'),
          kitsuId: excluded('kitsu_id'),
          anisearchId: excluded('anisearch_id'),
          livechartId: excluded('livechart_id'),
          animePlanetId: excluded('anime_planet_id'),
          animeNewsNetworkId: excluded('animenewsnetwork_id'),
          animeCountdownId: excluded('animecountdown_id'),
          simklId: excluded('simkl_id'),
          title: excluded('title'),
          type: excluded('type'),
          episodes: excluded('episodes'),
          status: excluded('status'),
          season: excluded('season'),
          seasonYear: excluded('season_year'),
          durationSeconds: excluded('duration_seconds'),
          score: excluded('score'),
          picture: excluded('picture'),
          thumbnail: excluded('thumbnail'),
          synonyms: excluded('synonyms'),
          studios: excluded('studios'),
          producers: excluded('producers'),
          tags: excluded('tags'),
          related: excluded('related'),
          sources: excluded('sources'),
          sourceHash: excluded('source_hash'),
          updatedAt: excluded('updated_at')
        }
      });
    written += batch.length;

    if (ctx?.shouldYield() && i + BATCH_SIZE < rows.length) {
      // No cursor on purpose: a restart re-upserts from the top, which is idempotent,
      // and it keeps the delete-stale step below safe (it only runs after a complete pass).
      console.log(`[catalog-ingest] yielding after ${written}/${rows.length} rows; will restart on next run`);
      return { total: rows.length, written, removed: 0, noAnidb: 0, skippedNoId, duplicateKeys, done: false };
    }
  }

  const removed = await db
    .delete(schema.catalogEntry)
    .where(ne(schema.catalogEntry.sourceHash, sourceHash))
    .returning({ key: schema.catalogEntry.key });

  await dbSourceStore.commit(SOURCE_KEY, loaded.fingerprint, rows.length);

  const noAnidb = rows.filter((row) => row.anidbId === null).length;
  console.log(`[catalog-ingest] ${written} rows written, ${removed.length} stale removed, ${noAnidb} without an AniDB id, ${skippedNoId} skipped (no usable id), ${duplicateKeys} duplicate keys`);
  return { total: rows.length, written, removed: removed.length, noAnidb, skippedNoId, duplicateKeys, done: true };
}

/**
 * Fills EMPTY provider-id columns on `mapping` from the catalog entry that
 * shares the row's AniDB id. Never overwrites an existing value (Fribb/XML
 * stay authoritative); disagreements are surfaced by the `id-conflicts` report
 * instead of being silently resolved. Only rows with something to fill are
 * touched, so a steady-state run writes nothing.
 */
export async function fillMappingFromCatalog(): Promise<{ filled: number }> {
  const rows = await db.execute(sql`
    UPDATE mapping AS m SET
      anilist_id = COALESCE(m.anilist_id, c.anilist_id),
      mal_id = COALESCE(m.mal_id, c.mal_id),
      kitsu_id = COALESCE(m.kitsu_id, c.kitsu_id),
      livechart_id = COALESCE(m.livechart_id, c.livechart_id),
      anisearch_id = COALESCE(m.anisearch_id, c.anisearch_id),
      anime_planet_id = COALESCE(m.anime_planet_id, c.anime_planet_id),
      animenewsnetwork_id = COALESCE(m.animenewsnetwork_id, c.animenewsnetwork_id),
      animecountdown_id = COALESCE(m.animecountdown_id, c.animecountdown_id),
      simkl_id = COALESCE(m.simkl_id, c.simkl_id),
      type = COALESCE(m.type, NULLIF(c.type, 'UNKNOWN')),
      updated_at = now()
    FROM catalog_entry AS c
    WHERE c.anidb_id = m.anidb_id
      AND (
        (m.anilist_id IS NULL AND c.anilist_id IS NOT NULL) OR
        (m.mal_id IS NULL AND c.mal_id IS NOT NULL) OR
        (m.kitsu_id IS NULL AND c.kitsu_id IS NOT NULL) OR
        (m.livechart_id IS NULL AND c.livechart_id IS NOT NULL) OR
        (m.anisearch_id IS NULL AND c.anisearch_id IS NOT NULL) OR
        (m.anime_planet_id IS NULL AND c.anime_planet_id IS NOT NULL) OR
        (m.animenewsnetwork_id IS NULL AND c.animenewsnetwork_id IS NOT NULL) OR
        (m.animecountdown_id IS NULL AND c.animecountdown_id IS NOT NULL) OR
        (m.simkl_id IS NULL AND c.simkl_id IS NOT NULL) OR
        (m.type IS NULL AND c.type IS NOT NULL AND c.type <> 'UNKNOWN')
      )
    RETURNING m.anidb_id
  `);
  const filled = Array.from(rows).length;
  if (filled > 0) console.log(`[catalog-fill] filled gaps on ${filled} mapping rows`);
  return { filled };
}
