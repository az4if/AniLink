import { parseAnimeListXmlFile } from '../src/mapping/xml-parser.js';
import { buildEpisodes } from '../src/mapping/merge.js';
import type { TvdbEpisode } from '../src/mapping/tvdb-client.js';

const rows = parseAnimeListXmlFile(new URL('./anime-list-master.sample.xml', import.meta.url).pathname);
const byId = new Map(rows.map((r) => [r.anidbId, r]));

let pass = 0;
let fail = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       actual:   ${JSON.stringify(actual)}`);
  }
}

function ep(partial: Partial<TvdbEpisode> & { seasonNumber: number; number: number }): TvdbEpisode {
  return { absoluteNumber: null, name: null, overview: null, titleEn: null, overviewEn: null, aired: null, image: null, ...partial };
}

// --- Cowboy Bebop (anidbid=23) -- plain default season + offset --------
// <anime anidbid="23" tvdbid="76885" defaulttvdbseason="1" episodeoffset="">
{
  const row = byId.get(23)!;
  console.log('Cowboy Bebop (23)');

  const episodes = [
    ep({
      seasonNumber: 1,
      number: 5,
      name: 'Ballad of Fallen Angels',
      overview: 'ov',
      titleEn: 'Ballad of Fallen Angels (EN)',
      overviewEn: 'ov-en',
      aired: '1998-05-27',
      image: '/img5.jpg'
    }),
    ep({ seasonNumber: 1, number: 1, name: 'Asteroid Blues' }), // no English translation available -- titleEn/overviewEn stay null
    // season 0 (specials) has no reverse mapping for Cowboy Bebop's mapping-list
    // (its mapping-list entries are anidbseason="0", which reverseResolveRegular
    // deliberately never reverses -- see resolver.ts) -- should be dropped.
    ep({ seasonNumber: 0, number: 1, name: 'Special' })
  ];

  const result = buildEpisodes(row, episodes);
  check('drops the un-reversible season-0 special, keeps + sorts the two regulars', result.map((r) => r.number), [1, 5]);
  check('carries TVDB metadata through untouched, including English title/overview when present', result[1], {
    number: 5,
    season: 1,
    episode: 5,
    absoluteNumber: null,
    title: 'Ballad of Fallen Angels',
    titleEn: 'Ballad of Fallen Angels (EN)',
    overview: 'ov',
    overviewEn: 'ov-en',
    aired: '1998-05-27',
    image: '/img5.jpg'
  });
  check('an episode with no English translation available carries titleEn/overviewEn through as null, not dropped', result[0].titleEn, null);
}

// --- anidbid=19 -- absolute numbering (defaulttvdbseason="a") ----------
{
  const row = byId.get(19)!;
  console.log('Absolute-numbered anime (19)');

  const episodes = [
    ep({ seasonNumber: 1, number: 3, absoluteNumber: 27, name: 'Ep 27' }),
    ep({ seasonNumber: 2, number: 1, absoluteNumber: null, name: 'No absolute number set' }) // should be dropped
  ];

  const result = buildEpisodes(row, episodes);
  check('absolute-numbered show uses absoluteNumber as the canonical number, drops episodes missing one', result, [
    { number: 27, season: 1, episode: 3, absoluteNumber: 27, title: 'Ep 27', titleEn: null, overview: null, overviewEn: null, aired: null, image: null }
  ]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
