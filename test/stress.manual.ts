import { parseAnimeListXmlFile } from '../src/mapping/xml-parser.js';
import { resolveEpisode } from '../src/mapping/resolver.js';

const rows = parseAnimeListXmlFile(new URL('./anime-list-master.sample.xml', import.meta.url).pathname);
console.log(`parsed ${rows.length} rows`);

let noTvdb = 0, absolute = 0, hasMappingList = 0, crashes = 0;
for (const row of rows) {
  if (!row.tvdbId) noTvdb++;
  if (row.tvdbAbsolute) absolute++;
  if (row.mappingList.length > 0) hasMappingList++;
  try {
    // hammer episode numbers 1..30 for both seasons, both providers -- just want to catch exceptions
    for (const season of [0, 1] as const) {
      for (let n = 1; n <= 30; n++) {
        resolveEpisode(row, { season, number: n }, 'tvdb');
        resolveEpisode(row, { season, number: n }, 'tmdb');
      }
    }
  } catch (e) {
    crashes++;
    console.log(`CRASH on anidbId=${row.anidbId} (${row.name}):`, (e as Error).message);
  }
}

console.log({ total: rows.length, noTvdb, absolute, hasMappingList, crashes });
