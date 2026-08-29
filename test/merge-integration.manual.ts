// Manual integration check, NOT part of the committed test suite (needs a
// live DATABASE_URL, same as tvdb-targets.test.ts / fribb-gapfill.test.ts).
// Verifies mergeTvdbIntoAnime() writes real rows into `anime` and that the
// one-tvdb_id-shared-by-multiple-anidb-ids case (Ghost in the Shell, see
// tvdb-targets.ts) produces one merged row per anidb entry, each using its
// OWN mapping-list/offset against the SAME shared TVDB episode data.
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db/index.js';
import { mergeTvdbIntoAnime } from '../src/mapping/merge.js';
import type { TvdbSeriesData } from '../src/mapping/tvdb-client.js';

async function main() {
  await db.delete(schema.anime);
  await db.delete(schema.mapping);

  // Two AniDB entries sharing one tvdb_id, each with a different offset --
  // the real-world shape CONTRIBUTING.md calls out for Ghost in the Shell.
  await db.insert(schema.mapping).values([
    {
      anidbId: 9001,
      title: 'Shared TVDB Cut A',
      tvdbId: 555,
      type: 'TV',
      defaultTvdbSeason: 1,
      tvdbEpisodeOffset: 0,
      airing: false,
      source: 'test'
    },
    {
      anidbId: 9002,
      title: 'Shared TVDB Cut B',
      tvdbId: 555,
      type: 'TV',
      defaultTvdbSeason: 1,
      tvdbEpisodeOffset: 5, // this cut's AniDB numbering starts 5 later
      airing: false,
      source: 'test'
    },
    {
      anidbId: 9003,
      title: 'Different show, different tvdb_id',
      tvdbId: 999,
      type: 'TV',
      defaultTvdbSeason: 1,
      tvdbEpisodeOffset: 0,
      airing: false,
      source: 'test'
    }
  ]);

  const series: TvdbSeriesData = {
    status: 'Ended',
    image: 'https://example.com/poster.jpg',
    overview: 'A test overview.',
    episodes: [
      { seasonNumber: 1, number: 1, absoluteNumber: 1, name: 'Ep 1', overview: 'o1', aired: '2020-01-01', image: null },
      { seasonNumber: 1, number: 6, absoluteNumber: 6, name: 'Ep 6', overview: 'o6', aired: '2020-02-05', image: null }
    ]
  };

  await mergeTvdbIntoAnime(555, series);

  const rowA = await db.query.anime.findFirst({ where: eq(schema.anime.anidbId, 9001) });
  const rowB = await db.query.anime.findFirst({ where: eq(schema.anime.anidbId, 9002) });
  const rowC = await db.query.anime.findFirst({ where: eq(schema.anime.anidbId, 9003) });

  let pass = 0;
  let fail = 0;
  function check(label: string, cond: boolean) {
    if (cond) {
      pass++;
      console.log(`  ok   ${label}`);
    } else {
      fail++;
      console.log(`  FAIL ${label}`);
    }
  }

  check('cut A merged, cut B merged, untouched tvdb_id (999) left alone', !!rowA && !!rowB && !rowC);
  check('cut A: offset 0 -> tvdb ep1 reverses to anidb ep1', (rowA!.data as any).episodes.some((e: any) => e.number === 1 && e.episode === 1));
  check('cut A: offset 0 -> tvdb ep6 reverses to anidb ep6', (rowA!.data as any).episodes.some((e: any) => e.number === 6 && e.episode === 6));
  check(
    'cut B: offset +5 -> tvdb ep6 reverses to anidb ep1 (SAME tvdb episode, DIFFERENT anidb number per cut)',
    (rowB!.data as any).episodes.some((e: any) => e.number === 1 && e.episode === 6)
  );
  check('description/image come from the shared TVDB series data on both cuts', (rowA!.data as any).description === 'A test overview.' && (rowB!.data as any).image === 'https://example.com/poster.jpg');
  check('anime.data.ids.tvdb round-trips the shared tvdb_id on both cuts', (rowA!.data as any).ids.tvdb === 555 && (rowB!.data as any).ids.tvdb === 555);

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.delete(schema.anime);
  await db.delete(schema.mapping);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
