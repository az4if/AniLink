import { limitToAiredProgress, type MergedEpisode } from '../src/mapping/merge.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

const episodes = [1174, 1175, 1176].map((number) => ({
  number, season: 1, episode: number, absoluteNumber: number, title: null, titleEn: null,
  overview: null, overviewEn: null, aired: null, image: null
} satisfies MergedEpisode));

check('airing progress 1175 never exposes scheduled episode 1176', limitToAiredProgress({ airing: true, episodeProgress: 1175 }, episodes).map((episode) => episode.number), [1174, 1175]);
check('the next run exposes 1176 only after the feed advances', limitToAiredProgress({ airing: true, episodeProgress: 1176 }, episodes).map((episode) => episode.number), [1174, 1175, 1176]);
check('finished titles keep their complete episode history', limitToAiredProgress({ airing: false, episodeProgress: null }, episodes).map((episode) => episode.number), [1174, 1175, 1176]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
