import { fillEpisodeImages } from '../src/mapping/episode-images.js';

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

const ep = (number: number, image: string | null, extra: Record<string, unknown> = {}) => ({ number, image, ...extra });

console.log('fillEpisodeImages');

// primary's own image always wins and is attributed to the primary
{
  const out = fillEpisodeImages(
    { source: 'tvdb', episodes: [ep(1, 'tvdb-1')] },
    [{ source: 'tmdb', episodes: [ep(1, 'tmdb-1')] }]
  );
  check('primary image wins, tagged with the primary source', [out[0].image, out[0].imageSource], ['tvdb-1', 'tvdb']);
}

// missing primary image -> first fallback that has one, in the order given
{
  const out = fillEpisodeImages(
    { source: 'tvdb', episodes: [ep(1, null), ep(2, null), ep(3, null)] },
    [
      { source: 'tmdb', episodes: [ep(1, 'tmdb-1'), ep(2, null)] },
      { source: 'ani-zip', episodes: [ep(1, 'az-1'), ep(2, 'az-2')] }
    ]
  );
  check('first fallback with an image wins', [out[0].image, out[0].imageSource], ['tmdb-1', 'tmdb']);
  check('falls through to the next fallback when the first has none', [out[1].image, out[1].imageSource], ['az-2', 'ani-zip']);
  check('nobody has one -> image and imageSource both null', [out[2].image, out[2].imageSource], [null, null]);
}

// empty / whitespace strings count as "no image"
{
  const out = fillEpisodeImages(
    { source: 'tvdb', episodes: [ep(1, ''), ep(2, '   ')] },
    [{ source: 'tmdb', episodes: [ep(1, 'tmdb-1')] }]
  );
  check('empty string is treated as missing and filled', [out[0].image, out[0].imageSource], ['tmdb-1', 'tmdb']);
  check('whitespace-only is treated as missing, nothing to fill -> null', [out[1].image, out[1].imageSource], [null, null]);
}

// only image/imageSource change -- the episode's identity fields are untouched
{
  const out = fillEpisodeImages(
    { source: 'tvdb', episodes: [ep(5, null, { title: 'Ballad of Fallen Angels', season: 1, tvdbEpisodeId: 219124 })] },
    [{ source: 'tmdb', episodes: [ep(5, 'tmdb-5', { title: 'WRONG TITLE', season: 9 })] }]
  );
  check(
    'fallback supplies only the image, never other fields',
    [out[0].title, out[0].season, out[0].tvdbEpisodeId, out[0].image],
    ['Ballad of Fallen Angels', 1, 219124, 'tmdb-5']
  );
}

// matching is by canonical number, not list position
{
  const out = fillEpisodeImages(
    { source: 'tmdb', episodes: [ep(2, null), ep(1, null)] },
    [{ source: 'tvdb', episodes: [ep(1, 'tvdb-1'), ep(2, 'tvdb-2')] }]
  );
  check('matches by episode number even when list order differs', out.map((e) => e.image), ['tvdb-2', 'tvdb-1']);
}

// a duplicate number in a fallback can't override the first image
{
  const out = fillEpisodeImages(
    { source: 'tvdb', episodes: [ep(1, null)] },
    [{ source: 'tmdb', episodes: [ep(1, 'first'), ep(1, 'second')] }]
  );
  check('duplicate canonical numbers: first image wins', out[0].image, 'first');
}

// no fallbacks / no episodes
{
  check('no fallbacks: missing image stays null with null source', fillEpisodeImages({ source: 'tvdb', episodes: [ep(1, null)] }, []).map((e) => [e.image, e.imageSource]), [[null, null]]);
  check('no episodes -> empty list', fillEpisodeImages({ source: 'tvdb', episodes: [] }, [{ source: 'tmdb', episodes: [ep(1, 'x')] }]), []);
}

// does not mutate its inputs
{
  const input = ep(1, null);
  fillEpisodeImages({ source: 'tvdb', episodes: [input] }, [{ source: 'tmdb', episodes: [ep(1, 'tmdb-1')] }]);
  check('input episode objects are not mutated', input, { number: 1, image: null });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
