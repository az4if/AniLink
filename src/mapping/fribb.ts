import { sql } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { runChunked, type YieldCtx } from './chunked-runner.js';

type ThemoviedbId = { tv?: number; movie?: number[] };

export type FribbEntry = {
  anidb_id?: number;
  anilist_id?: number;
  mal_id?: number;
  kitsu_id?: number;
  livechart_id?: number;
  anisearch_id?: number;
  simkl_id?: number;
  animenewsnetwork_id?: number;
  animecountdown_id?: number;
  'anime-planet_id'?: string;
  type?: string;
  // deliberately unused here -- tvdb_id / themoviedb_id / imdb_id / season /
  // episode_offset stay owned by the anime-list-master.xml pass, which has
  // the richer per-episode mapping-list data these reduced fields lack.
};

async function downloadFribbJson(): Promise<FribbEntry[]> {
  const res = await fetch(Config.sources.fribbJsonUrl);
  if (!res.ok) throw new Error(`Failed to download Fribb-format mapping JSON: HTTP ${res.status}`);
  return res.json();
}

function excluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/** Pure transform, exported so it can be unit tested without a DB connection. */
export function toFribbDbRow(e: FribbEntry & { anidb_id: number }) {
  return {
    anidbId: e.anidb_id,
    anilistId: e.anilist_id ?? null,
    malId: e.mal_id ?? null,
    kitsuId: e.kitsu_id ?? null,
    livechartId: e.livechart_id ?? null,
    anisearchId: e.anisearch_id ?? null,
    simklId: e.simkl_id ?? null,
    animeNewsNetworkId: e.animenewsnetwork_id ?? null,
    animeCountdownId: e.animecountdown_id ?? null,
    animePlanetId: e['anime-planet_id'] ?? null,
    type: e.type ?? null
  };
}

/**
 * Backfills id/type fields from a Fribb-format anime-list-full.json onto
 * `mapping`. Only touches entries that carry an anidb_id -- everything else
 * in that file (AniList/MAL-only entries with no AniDB association) is
 * outside our AniDB-anchored catalog and skipped. Resumable/yield-aware,
 * see chunked-runner.ts.
 */
export async function ingestFribb(
  entries?: FribbEntry[],
  ctx?: YieldCtx
): Promise<{ total: number; skippedNoAnidbId: number; added: number[]; done: boolean }> {
  const all = entries ?? (await downloadFribbJson());
  const withAnidbId = all.filter((e): e is FribbEntry & { anidb_id: number } => typeof e.anidb_id === 'number');

  const result = await runChunked(
    'mapping-fribb',
    withAnidbId,
    500,
    (e) => e.anidb_id,
    async (chunk) => {
      await db
        .insert(schema.mapping)
        .values(chunk.map(toFribbDbRow))
        .onConflictDoUpdate({
          target: schema.mapping.anidbId,
          set: {
            anilistId: excluded('anilist_id'),
            malId: excluded('mal_id'),
            kitsuId: excluded('kitsu_id'),
            livechartId: excluded('livechart_id'),
            anisearchId: excluded('anisearch_id'),
            simklId: excluded('simkl_id'),
            animeNewsNetworkId: excluded('animenewsnetwork_id'),
            animeCountdownId: excluded('animecountdown_id'),
            animePlanetId: excluded('anime_planet_id'),
            type: excluded('type')
            // tvdbId / tmdbTvId / tmdbMovieIds / imdbIds / season / offset /
            // mappingList / source deliberately omitted -- XML-owned
          }
        });
    },
    ctx
  );

  console.log(`[fribb-ingest] ${result.processed}/${withAnidbId.length} processed, ${result.added.length} new, done=${result.done}`);
  return { total: withAnidbId.length, skippedNoAnidbId: all.length - withAnidbId.length, added: result.added, done: result.done };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestFribb()
    .then((result) => {
      console.log(`[fribb-ingest] done`, result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[fribb-ingest] failed:', err);
      process.exit(1);
    });
}
