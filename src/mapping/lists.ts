import { sql, eq } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';

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

async function downloadJson<T>(url: string, label: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${label}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Backfills anilist_id/mal_id from lists-main's anime.json, but ONLY where
 * this mapping row doesn't already have one -- Fribb's cross-reference is
 * the primary source for these; this just catches anime new enough that
 * Fribb hasn't indexed yet (lists-main updates daily).
 */
export async function ingestListsIds(entries?: ListsIdEntry[]): Promise<{ total: number }> {
  const all = entries ?? (await downloadJson<ListsIdEntry[]>(Config.sources.animeJsonUrl, 'anime.json'));
  const withAnidbId = all.filter((e): e is ListsIdEntry & { idAniDB: number } => typeof e.idAniDB === 'number');

  const CHUNK = 500;
  for (let i = 0; i < withAnidbId.length; i += CHUNK) {
    const chunk = withAnidbId.slice(i, i + CHUNK).map((e) => ({
      anidbId: e.idAniDB,
      anilistId: e.idAL ?? null,
      malId: e.idMal ?? null
    }));

    await db
      .insert(schema.mapping)
      .values(chunk)
      .onConflictDoUpdate({
        target: schema.mapping.anidbId,
        set: {
          // COALESCE(current value, incoming value) -- only fills a gap,
          // never overwrites something Fribb (or an earlier lists pass)
          // already supplied.
          anilistId: sql`COALESCE(${schema.mapping.anilistId}, excluded.anilist_id)`,
          malId: sql`COALESCE(${schema.mapping.malId}, excluded.mal_id)`
        }
      });
    console.log(`[lists-ingest] id backfill ${Math.min(i + CHUNK, withAnidbId.length)}/${withAnidbId.length}`);
  }

  return { total: withAnidbId.length };
}

/**
 * Refreshes the `airing` / `episodeProgress` / `nextEpisodeAt` snapshot from
 * lists-main's anime-airing.json. This is a full replace, not a merge: shows
 * missing from the new snapshot (because they finished airing) get their
 * airing flag cleared, so this never leaves a stale "airing" show behind.
 */
export async function ingestAiring(entries?: ListsAiringEntry[]): Promise<{ total: number; notInCatalog: number }> {
  const all = entries ?? (await downloadJson<ListsAiringEntry[]>(Config.sources.animeAiringJsonUrl, 'anime-airing.json'));

  await db.update(schema.mapping).set({ airing: false, episodeProgress: null, nextEpisodeAt: null }).where(eq(schema.mapping.airing, true));

  let notInCatalog = 0;
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
  }

  return { total: all.length, notInCatalog };
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
