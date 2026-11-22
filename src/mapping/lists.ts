import { sql, eq } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { runChunked, type YieldCtx } from './chunked-runner.js';
import { loadSource } from './source-state.js';
import type { SourceSyncOptions } from './guarded-source.js';

type ListsIdEntry = { idAL?: number; idAniDB?: number; idMal?: number };

type ListsAiringEntry = {
  idAniDB?: number;
  nextEpisode?: { episodeNumber?: number; date?: number }; // date is unix seconds
};

/** Pure transform, exported so it can be unit tested without a DB connection. */
export function toAiringFields(e: ListsAiringEntry): { episodeProgress: number | null; nextEpisodeAt: Date | null } {
  return {
    episodeProgress: typeof e.nextEpisode?.episodeNumber === 'number' ? e.nextEpisode.episodeNumber - 1 : null,
    nextEpisodeAt: typeof e.nextEpisode?.date === 'number' ? new Date(e.nextEpisode.date * 1000) : null
  };
}

function parseJsonArray<T>(label: string) {
  return (text: string): T[] => {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error(`${label} is not an array -- unexpected format`);
    return parsed as T[];
  };
}

// The number of airing shows swings with the season, so its size guard is much
// looser than the catalog-sized sources'. It still catches the real danger:
// an empty/truncated file wiping the airing flag from every show.
const AIRING_MAX_DROP_PERCENT = 60;

/**
 * Backfills anilist_id/mal_id from lists-main's anime.json, but ONLY where
 * this mapping row doesn't already have one -- Fribb's cross-reference is
 * the primary source for these; this just catches anime new enough that
 * Fribb hasn't indexed yet (lists-main updates daily). Resumable/yield-aware,
 * see chunked-runner.ts.
 */
export async function ingestListsIds(
  entries?: ListsIdEntry[],
  ctx?: YieldCtx,
  options: SourceSyncOptions = {}
): Promise<{ total: number; added: number[]; done: boolean; skipped?: string }> {
  const hasAnidbId = (e: ListsIdEntry): e is ListsIdEntry & { idAniDB: number } => typeof e.idAniDB === 'number';
  let all: ListsIdEntry[];
  let commit: (() => Promise<void>) | null = null;

  if (entries !== undefined) {
    all = entries;
  } else {
    const loaded = await loadSource({
      key: 'lists-anime',
      url: Config.sources.animeJsonUrl,
      label: 'anime.json',
      force: options.force,
      parse: parseJsonArray<ListsIdEntry>('anime.json'),
      count: (parsed) => parsed.filter(hasAnidbId).length
    });
    if (loaded.skipped) return { total: 0, added: [], done: true, skipped: loaded.reason };
    all = loaded.data;
    commit = loaded.commit;
  }
  const withAnidbId = all.filter(hasAnidbId);

  const result = await runChunked(
    'mapping-lists-ids',
    withAnidbId,
    500,
    (e) => e.idAniDB,
    async (chunk) => {
      const rows = chunk.map((e) => ({ anidbId: e.idAniDB, anilistId: e.idAL ?? null, malId: e.idMal ?? null }));
      await db
        .insert(schema.mapping)
        .values(rows)
        .onConflictDoUpdate({
          target: schema.mapping.anidbId,
          set: {
            // COALESCE(current value, incoming value) -- only fills a gap,
            // never overwrites something Fribb (or an earlier pass) supplied.
            anilistId: sql`COALESCE(${schema.mapping.anilistId}, excluded.anilist_id)`,
            malId: sql`COALESCE(${schema.mapping.malId}, excluded.mal_id)`
          }
        });
    },
    ctx
  );

  if (result.done && commit) await commit();

  console.log(`[lists-ingest] ids: ${result.processed}/${withAnidbId.length} processed, ${result.added.length} new, done=${result.done}`);
  return { total: withAnidbId.length, added: result.added, done: result.done };
}

/**
 * Refreshes the `airing` / `episodeProgress` / `nextEpisodeAt` snapshot from
 * lists-main's anime-airing.json. This is a full replace, not a merge: shows
 * missing from the new snapshot (because they finished airing) get their
 * airing flag cleared, so this never leaves a stale "airing" show behind.
 * Not chunked/resumable -- at ~300 entries this is fast enough to always run
 * to completion in one pass, and half-clearing the airing flag on yield
 * would be a worse inconsistency than just letting it finish.
 */
export async function ingestAiring(
  entries?: ListsAiringEntry[],
  options: SourceSyncOptions = {}
): Promise<{ total: number; notInCatalog: number; newlyAiring: number[]; noLongerAiring: number[]; skipped?: string }> {
  let all: ListsAiringEntry[];
  let commit: (() => Promise<void>) | null = null;

  if (entries !== undefined) {
    all = entries;
  } else {
    const loaded = await loadSource({
      key: 'lists-airing',
      url: Config.sources.animeAiringJsonUrl,
      label: 'anime-airing.json',
      force: options.force,
      parse: parseJsonArray<ListsAiringEntry>('anime-airing.json'),
      count: (parsed) => parsed.length,
      maxDropPercent: AIRING_MAX_DROP_PERCENT
    });
    if (loaded.skipped) return { total: 0, notInCatalog: 0, newlyAiring: [], noLongerAiring: [], skipped: loaded.reason };
    all = loaded.data;
    commit = loaded.commit;
  }

  const wasAiring = new Set(
    (await db.select({ anidbId: schema.mapping.anidbId }).from(schema.mapping).where(eq(schema.mapping.airing, true))).map(
      (r) => r.anidbId
    )
  );

  await db.update(schema.mapping).set({ airing: false, episodeProgress: null, nextEpisodeAt: null }).where(eq(schema.mapping.airing, true));

  let notInCatalog = 0;
  const nowAiring = new Set<number>();
  for (const entry of all) {
    if (typeof entry.idAniDB !== 'number') continue;
    const { episodeProgress, nextEpisodeAt } = toAiringFields(entry);

    const result = await db
      .update(schema.mapping)
      .set({ airing: true, episodeProgress, nextEpisodeAt })
      .where(eq(schema.mapping.anidbId, entry.idAniDB))
      .returning({ anidbId: schema.mapping.anidbId });

    // anime-list-master.xml covers every AniDB title, so this shouldn't
    // normally happen -- but if lists-main is ahead of the XML repo on a
    // brand-new anime, there's nothing to update yet. Not fatal, just noted.
    if (result.length === 0) notInCatalog++;
    else nowAiring.add(entry.idAniDB);
  }

  const newlyAiring = [...nowAiring].filter((id) => !wasAiring.has(id));
  const noLongerAiring = [...wasAiring].filter((id) => !nowAiring.has(id));

  if (commit) await commit();

  console.log(`[lists-ingest] airing: ${nowAiring.size} airing, ${newlyAiring.length} newly-airing, ${noLongerAiring.length} finished`);
  return { total: all.length, notInCatalog, newlyAiring, noLongerAiring };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.all([ingestListsIds(), ingestAiring()])
    .then(([ids, airing]) => {
      console.log('[lists-ingest] done', { ids, airing });
      process.exit(0);
    })
    .catch((err) => {
      console.error('[lists-ingest] failed:', err);
      process.exit(1);
    });
}
