import { sql } from 'drizzle-orm';
import { Config } from '../config.js';
import { db, schema } from '../db/index.js';
import { parseAnimeListXml, type MappingRow } from './xml-parser.js';
import type { MappingListEntry } from '../db/schema.js';

async function downloadXml(): Promise<string> {
  const res = await fetch(Config.sources.animeListMasterXmlUrl);
  if (!res.ok) throw new Error(`Failed to download anime-list-master.xml: HTTP ${res.status}`);
  return res.text();
}

function toDbRow(row: MappingRow) {
  return {
    anidbId: row.anidbId,
    tvdbId: row.tvdbId,
    tmdbTvId: row.tmdbTvId,
    tmdbMovieIds: row.tmdbMovieIds.length > 0 ? row.tmdbMovieIds : null,
    imdbIds: row.imdbIds.length > 0 ? row.imdbIds : null,
    // anime-list-master.xml doesn't carry a `type` field itself -- that
    // comes from animetitles.xml / Fribb's reduced JSON, added in a later
    // cross-reference pass. That's why `type` is left out of the upsert's
    // conflict-update set below: this pass must never blank out a `type`
    // a previous pass already filled in.
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
 * Upserts every row from anime-list-master.xml into `mapping`. Chunked
 * because pushing all ~16,865 rows in one INSERT is unnecessary memory
 * pressure for very little benefit -- and chunking gives you visible
 * progress if you're running this by hand the first time.
 */
export async function ingestMapping(xmlContent?: string): Promise<{ total: number }> {
  const xml = xmlContent ?? (await downloadXml());
  const rows = parseAnimeListXml(xml);

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map(toDbRow);
    await db
      .insert(schema.mapping)
      .values(chunk)
      .onConflictDoUpdate({
        target: schema.mapping.anidbId,
        set: {
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
    console.log(`[mapping-ingest] upserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }

  return { total: rows.length };
}

// allows `npm run ingest:mapping` to run this file directly
if (import.meta.url === `file://${process.argv[1]}`) {
  ingestMapping()
    .then(({ total }) => {
      console.log(`[mapping-ingest] done, ${total} anime upserted`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[mapping-ingest] failed:', err);
      process.exit(1);
    });
}
