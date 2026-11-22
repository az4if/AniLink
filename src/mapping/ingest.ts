import { sql } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { parseAnimeListXml, type MappingRow } from './xml-parser.js';
import { runChunked, type YieldCtx } from './chunked-runner.js';
import type { MappingListEntry } from '../db/schema.js';
import { loadSource } from './source-state.js';
import type { SourceSyncOptions } from './guarded-source.js';

const SOURCE_KEY = 'anime-list-master-xml';

function toDbRow(row: MappingRow) {
  return {
    anidbId: row.anidbId,
    title: row.name || null,
    tvdbId: row.tvdbId,
    tmdbTvId: row.tmdbTvId,
    tmdbMovieIds: row.tmdbMovieIds.length > 0 ? row.tmdbMovieIds : null,
    imdbIds: row.imdbIds.length > 0 ? row.imdbIds : null,
    // anime-list-master.xml doesn't carry a `type` field itself -- that
    // comes from Fribb's reduced JSON, added in a later cross-reference
    // pass. That's why `type` is left out of the upsert's conflict-update
    // set below: this pass must never blank out a `type` a previous pass
    // already filled in.
    defaultTvdbSeason: row.defaultTvdbSeason,
    tvdbAbsolute: row.tvdbAbsolute,
    tvdbEpisodeOffset: row.tvdbEpisodeOffset,
    defaultTmdbSeason: row.defaultTmdbSeason,
    tmdbAbsolute: row.tmdbAbsolute,
    tmdbEpisodeOffset: row.tmdbEpisodeOffset,
    mappingList: row.mappingList.length > 0 ? (row.mappingList satisfies MappingListEntry[]) : null,
    source: 'anime-lists-xml' as const,
    updatedAt: new Date()
  };
}

/** References the incoming row's value for a column inside an ON CONFLICT DO UPDATE SET clause. */
function excluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/**
 * Upserts every row from anime-list-master.xml into `mapping`. Resumable
 * and yield-aware -- see chunked-runner.ts -- so a run interrupted by a
 * higher-priority scheduled job (or a redeploy) picks back up instead of
 * starting over, and reports which anidb_ids are new since last time.
 *
 * When downloading (no `xmlContent`), an unchanged file is skipped and a file
 * that lost too many entries is rejected -- see guarded-source.ts. The source
 * is marked as processed only after the last chunk, so an interrupted pass
 * is retried rather than skipped.
 */
export async function ingestMapping(
  xmlContent?: string,
  ctx?: YieldCtx,
  options: SourceSyncOptions = {}
): Promise<{ total: number; added: number[]; done: boolean; skipped?: string }> {
  let rows: MappingRow[];
  let commit: (() => Promise<void>) | null = null;

  if (xmlContent !== undefined) {
    rows = parseAnimeListXml(xmlContent);
  } else {
    const loaded = await loadSource({
      key: SOURCE_KEY,
      url: Config.sources.animeListMasterXmlUrl,
      label: 'anime-list-master.xml',
      force: options.force,
      parse: parseAnimeListXml,
      count: (parsed) => parsed.length
    });
    if (loaded.skipped) return { total: 0, added: [], done: true, skipped: loaded.reason };
    rows = loaded.data;
    commit = loaded.commit;
  }

  const result = await runChunked(
    'mapping-xml',
    rows,
    500,
    (r) => r.anidbId,
    async (chunk) => {
      await db
        .insert(schema.mapping)
        .values(chunk.map(toDbRow))
        .onConflictDoUpdate({
          target: schema.mapping.anidbId,
          set: {
            title: excluded('title'),
            tvdbId: excluded('tvdb_id'),
            tmdbTvId: excluded('tmdb_tv_id'),
            tmdbMovieIds: excluded('tmdb_movie_ids'),
            imdbIds: excluded('imdb_ids'),
            defaultTvdbSeason: excluded('default_tvdb_season'),
            tvdbAbsolute: excluded('tvdb_absolute'),
            tvdbEpisodeOffset: excluded('tvdb_episode_offset'),
            defaultTmdbSeason: excluded('default_tmdb_season'),
            tmdbAbsolute: excluded('tmdb_absolute'),
            tmdbEpisodeOffset: excluded('tmdb_episode_offset'),
            mappingList: excluded('mapping_list'),
            source: excluded('source'),
            updatedAt: excluded('updated_at')
            // `type` deliberately omitted -- see comment in toDbRow() above
          }
        });
    },
    ctx
  );

  if (result.done && commit) await commit();

  console.log(`[mapping-ingest] ${result.processed}/${rows.length} processed, ${result.added.length} new, done=${result.done}`);
  return { total: rows.length, added: result.added, done: result.done };
}

// allows `npm run ingest:mapping` to run this file directly
if (import.meta.url === `file://${process.argv[1]}`) {
  ingestMapping()
    .then((result) => {
      console.log(`[mapping-ingest] done`, result);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[mapping-ingest] failed:', err);
      process.exit(1);
    });
}
