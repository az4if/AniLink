import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * Read-only data-quality reports. Each answers "where is AniLink's data weak
 * or disputed?" so corrections (see overrides.ts) can be targeted instead of
 * guessed. All SQL is fixed text; only limit/offset are bound parameters.
 */

type Report = { description: string; from: SQL; where: SQL; columns: SQL; order: SQL };

export const REPORTS = {
  'no-anilist': {
    description: 'AniDB entries with no AniList id -- no AniList validation, relations or fallback artwork.',
    from: sql`mapping m`,
    where: sql`m.anilist_id IS NULL`,
    columns: sql`m.anidb_id, m.title, m.type, m.mal_id`,
    order: sql`m.anidb_id`
  },
  'no-tvdb-tmdb': {
    description: 'AniDB entries with neither a TVDB nor a TMDB id -- episodes can only come from ani.zip.',
    from: sql`mapping m`,
    where: sql`m.tvdb_id IS NULL AND m.tmdb_tv_id IS NULL AND (m.tmdb_movie_ids IS NULL OR cardinality(m.tmdb_movie_ids) = 0)`,
    columns: sql`m.anidb_id, m.title, m.type, m.anilist_id, m.mal_id`,
    order: sql`m.anidb_id`
  },
  'no-image': {
    description: 'AniDB entries that still have no image from any provider, including the catalog fallback.',
    from: sql`mapping m LEFT JOIN anime a ON a.anidb_id = m.anidb_id LEFT JOIN catalog_entry c ON c.anidb_id = m.anidb_id`,
    where: sql`COALESCE(a.data->>'image', '') = '' AND c.picture IS NULL`,
    columns: sql`m.anidb_id, m.title, m.type, m.anilist_id, m.mal_id`,
    order: sql`m.anidb_id`
  },
  'id-conflicts': {
    description: 'Entries where the mapping sources and the catalog disagree on an id. Check these first; fix with an override.',
    from: sql`mapping m JOIN catalog_entry c ON c.anidb_id = m.anidb_id`,
    where: sql`(m.anilist_id IS NOT NULL AND c.anilist_id IS NOT NULL AND m.anilist_id <> c.anilist_id)
      OR (m.mal_id IS NOT NULL AND c.mal_id IS NOT NULL AND m.mal_id <> c.mal_id)
      OR (m.kitsu_id IS NOT NULL AND c.kitsu_id IS NOT NULL AND m.kitsu_id <> c.kitsu_id)
      OR (m.livechart_id IS NOT NULL AND c.livechart_id IS NOT NULL AND m.livechart_id <> c.livechart_id)
      OR (m.anisearch_id IS NOT NULL AND c.anisearch_id IS NOT NULL AND m.anisearch_id <> c.anisearch_id)`,
    columns: sql`m.anidb_id, m.title,
      m.anilist_id, c.anilist_id AS catalog_anilist_id,
      m.mal_id, c.mal_id AS catalog_mal_id,
      m.kitsu_id, c.kitsu_id AS catalog_kitsu_id,
      m.livechart_id, c.livechart_id AS catalog_livechart_id,
      m.anisearch_id, c.anisearch_id AS catalog_anisearch_id`,
    order: sql`m.anidb_id`
  },
  'catalog-only': {
    description: 'Catalog titles with no AniDB entry. Served by id from the catalog alone (no episodes).',
    from: sql`catalog_entry c`,
    where: sql`NOT EXISTS (SELECT 1 FROM mapping m WHERE m.anidb_id = c.anidb_id)`,
    columns: sql`c.key, c.title, c.type, c.anilist_id, c.mal_id, c.kitsu_id`,
    order: sql`c.key`
  }
} satisfies Record<string, Report>;

export type ReportKind = keyof typeof REPORTS;

export function isReportKind(value: string): value is ReportKind {
  return Object.prototype.hasOwnProperty.call(REPORTS, value);
}

async function count(report: Report): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${report.from} WHERE ${report.where}`);
  return Array.from(rows)[0]?.n ?? 0;
}

/** Row counts for every report -- the "how healthy is the data" overview. */
export async function reportSummary(): Promise<Record<ReportKind, { description: string; count: number } | { error: string }>> {
  const entries = await Promise.all(
    (Object.entries(REPORTS) as Array<[ReportKind, Report]>).map(async ([kind, report]) => {
      try {
        return [kind, { description: report.description, count: await count(report) }] as const;
      } catch (err) {
        // A missing table (migration not applied yet) should say so, not take the whole endpoint down.
        return [kind, { error: err instanceof Error ? err.message : String(err) }] as const;
      }
    })
  );
  return Object.fromEntries(entries) as Record<ReportKind, { description: string; count: number } | { error: string }>;
}

export async function reportRows(kind: ReportKind, limit: number, offset: number) {
  const report: Report = REPORTS[kind];
  const rows = await db.execute(
    sql`SELECT ${report.columns} FROM ${report.from} WHERE ${report.where} ORDER BY ${report.order} LIMIT ${limit} OFFSET ${offset}`
  );
  return { description: report.description, total: await count(report), limit, offset, rows: Array.from(rows) };
}
