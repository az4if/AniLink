import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LOOKUP_NAMES } from '../src/routes/mappings.routes.js';

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

const expected = [
  'anidb_id', 'mal_id', 'anilist_id', 'kitsu_id', 'anisearch_id',
  'notifymoe_id', 'livechart_id', 'thetvdb_id', 'themoviedb_id',
  'imdb_id', 'animeplanet_id'
];
check('API accepts every requested mapping identifier', [...LOOKUP_NAMES], expected);

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf-8');
const select = html.match(/<select id="provider">([\s\S]*?)<\/select>/)?.[1] ?? '';
const menuValues = [...select.matchAll(/<option value="([^"]+)"(?:\s+[^>]*)?>/g)].map((match) => match[1]);
check('Try it menu exposes every API mapping lookup', menuValues, expected);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
