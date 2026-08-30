import { parseAnimeListXmlFile } from '../src/mapping/xml-parser.js';
import { buildEpisodes, capToExpectedEpisodeCount, type MergedEpisode } from '../src/mapping/merge.js';
import type { TvdbEpisode } from '../src/mapping/tvdb-client.js';
import { fileURLToPath } from 'node:url';

const rows = parseAnimeListXmlFile(fileURLToPath(new URL('./anime-list-master.sample.xml', import.meta.url)));
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

// --- anidbid=19 (Rizelmine) -- absolute numbering (defaulttvdbseason="a")
// PLUS explicit mapping-list ranges for episodes 1-24:
//   <mapping anidbseason="1" tvdbseason="1" start="1" end="12"/>
//   <mapping anidbseason="1" tvdbseason="2" start="13" end="24" offset="-12"/>
// Real bug found & fixed here: buildEpisodes used to check `row.tvdbAbsolute`
// FIRST and use ep.absoluteNumber unconditionally whenever true, without
// ever consulting the mapping-list -- inverting the priority order the
// forward resolver documents (explicit/range mapping-list > absolute).
// Two consequences, both wrong, both fixed by resolveCanonicalNumber():
//   1. An episode a mapping-list range legitimately covers (like these two)
//      got the wrong number entirely -- TVDB's own absoluteNumber instead
//      of the curated, authoritative mapping-list value.
//   2. Season-0 specials/OVAs/movies -- which TVDB/TMDB routinely tag with
//      absoluteNumber 0 or null, since they were never part of the
//      absolute count -- got included anyway, all colliding on canonical
//      episode 0. This is the exact bug reported against a real deployment
//      (a One Piece query returning OVA/movie/TV-special entries mixed
//      into the episode list, every one numbered 0).
{
  const row = byId.get(19)!;
  console.log('Absolute-numbered anime (19, Rizelmine)');

  const episodes = [
    // covered by the season-1 mapping-list range (1-12, offset 0) -- must
    // resolve via mapping-list to 3, NOT via absoluteNumber to 27
    ep({ seasonNumber: 1, number: 3, absoluteNumber: 27, name: 'Ep 27 by absolute number, but really ep 3' }),
    // covered by the season-2 mapping-list range (13-24, offset -12) --
    // must resolve via mapping-list to 13, even though it has NO
    // absoluteNumber at all (previously this meant "drop it" -- wrong,
    // the mapping-list still applies regardless of absoluteNumber)
    ep({ seasonNumber: 2, number: 1, absoluteNumber: null, name: 'No absolute number, but mapping-list covers it -> ep 13' }),
    // NOT covered by either mapping-list range (season 1, but outside
    // 1-12) -- genuinely falls through to absolute numbering
    ep({ seasonNumber: 1, number: 13, absoluteNumber: 25, name: 'Outside every range -- genuinely absolute' }),
    // the actual reported bug: a season-0 special with absoluteNumber 0 --
    // must be dropped, not surfaced as "episode 0"
    ep({ seasonNumber: 0, number: 1, absoluteNumber: 0, name: 'Special miscategorized with absoluteNumber 0' })
  ];

  const result = buildEpisodes(row, episodes);
  check('mapping-list wins over absolute numbering when both could apply, season-0-with-absoluteNumber-0 is dropped', result, [
    {
      number: 3,
      season: 1,
      episode: 3,
      absoluteNumber: 27,
      title: 'Ep 27 by absolute number, but really ep 3',
      titleEn: null,
      overview: null,
      overviewEn: null,
      aired: null,
      image: null
    },
    {
      number: 13,
      season: 2,
      episode: 1,
      absoluteNumber: null,
      title: 'No absolute number, but mapping-list covers it -> ep 13',
      titleEn: null,
      overview: null,
      overviewEn: null,
      aired: null,
      image: null
    },
    {
      number: 25,
      season: 1,
      episode: 13,
      absoluteNumber: 25,
      title: 'Outside every range -- genuinely absolute',
      titleEn: null,
      overview: null,
      overviewEn: null,
      aired: null,
      image: null
    }
  ]);
}

// --- capToExpectedEpisodeCount -- defense-in-depth against leaked extras
{
  console.log('capToExpectedEpisodeCount');

  const mkEp = (number: number): MergedEpisode => ({
    number,
    season: 1,
    episode: number,
    absoluteNumber: number,
    title: `Ep ${number}`,
    titleEn: null,
    overview: null,
    overviewEn: null,
    aired: null,
    image: null
  });

  const episodes = [mkEp(1), mkEp(2), mkEp(3), mkEp(4)];

  check('null expected count -> no-op, nothing dropped', capToExpectedEpisodeCount(null, episodes).length, 4);
  check('expected count matches -> no-op', capToExpectedEpisodeCount(4, episodes).length, 4);
  check(
    'expected count lower than resolved (the reported bug pattern) -> drops the excess',
    capToExpectedEpisodeCount(2, episodes).map((e) => e.number),
    [1, 2]
  );
  check(
    'expected count higher than resolved -> no-op (this is the existing "partial" case, not this function\'s job)',
    capToExpectedEpisodeCount(10, episodes).length,
    4
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
