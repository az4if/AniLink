// Mocked TMDB client test: normalized artwork, full raw payload retention,
// and per-season episode retrieval. Run with TMDB_API_KEY=test.
import { fetchTmdb } from '../src/mapping/tmdb-client.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual: ${JSON.stringify(actual)}`);
  }
}

const realFetch = global.fetch;
const calls: string[] = [];
global.fetch = (async (url: string) => {
  calls.push(url);
  if (url.includes('/tv/30991/season/')) {
    const season = Number(url.match(/season\/(\d+)/)?.[1]);
    return new Response(JSON.stringify({ episodes: [{ season_number: season, episode_number: 1, name: `S${season}E1`, overview: 'episode', air_date: '1998-01-01', still_path: '/still.jpg' }] }), { status: 200 });
  }
  if (url.includes('/tv/30991?')) {
    return new Response(
      JSON.stringify({
        id: 30991,
        status: 'Ended',
        overview: 'A test overview.',
        poster_path: '/poster.jpg',
        seasons: [{ season_number: 0 }, { season_number: 1 }],
        images: {
          posters: [{ file_path: '/poster.jpg', width: 1000, height: 1500, iso_639_1: 'en', vote_average: 5 }],
          backdrops: [{ file_path: '/backdrop.jpg', width: 1920, height: 1080, iso_639_1: null }],
          logos: [{ file_path: '/logo.png', width: 800, height: 300, iso_639_1: 'ja' }]
        },
        translations: { translations: [] },
        external_ids: { imdb_id: 'tt0000001' }
      }),
      { status: 200 }
    );
  }
  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

async function run() {
  const data = await fetchTmdb(30991, 'tv');
  check('keeps provider status, description and poster', { status: data.status, overview: data.overview, image: data.image }, {
    status: 'Ended', overview: 'A test overview.', image: 'https://image.tmdb.org/t/p/original/poster.jpg'
  });
  check('normalizes and preserves all three TMDB artwork classes', data.artworks.map((artwork) => [artwork.source, artwork.type, artwork.language]), [
    ['tmdb', 'poster', 'en'], ['tmdb', 'background', null], ['tmdb', 'logo', 'ja']
  ]);
  check('fetches every listed season and derives absolute order excluding specials', data.episodes.map((episode) => [episode.seasonNumber, episode.number, episode.absoluteNumber]), [[0, 1, null], [1, 1, 1]]);
  check('retains unnormalized fields in raw response', (data.raw.external_ids as { imdb_id: string }).imdb_id, 'tt0000001');
  check('requests the full TMDB append payload', calls[0].includes('append_to_response=images,translations,external_ids,credits'), true);
  global.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run();
