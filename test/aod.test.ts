import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  catalogKey,
  entriesToCatalogRows,
  extractIds,
  extractRelated,
  isPlaceholderImage,
  parseAodDocument,
  parseAodLine,
  toCatalogRow,
  type AodEntry
} from '../src/mapping/aod.js';

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`);
  }
}

const dir = fileURLToPath(new URL('.', import.meta.url));
const doc = parseAodDocument(readFileSync(dir + 'aod.sample.json', 'utf-8'));
const bySource = (url: string) => doc.entries.find((e) => e.sources[0] === url)!;

console.log('extractIds (URL shapes taken from the real dataset)');
check(
  'Cowboy Bebop: all ten providers',
  extractIds(bySource('https://anidb.net/anime/23').sources),
  {
    anidbId: 23, anilistId: 1, malId: 1, kitsuId: 1, anisearchId: 1572, livechartId: 3418,
    animePlanetId: 'cowboy-bebop', animeNewsNetworkId: 13, animeCountdownId: 37089, simklId: 37089
  }
);
check(
  'animecountdown has no /anime/ segment, ANN uses ?id=, kitsu is kitsu.app',
  extractIds(['https://animecountdown.com/48858', 'https://animenewsnetwork.com/encyclopedia/anime.php?id=32920', 'https://kitsu.app/anime/47450']),
  { anidbId: null, anilistId: null, malId: null, kitsuId: 47450, anisearchId: null, livechartId: null, animePlanetId: null, animeNewsNetworkId: 32920, animeCountdownId: 48858, simklId: null }
);
check('legacy kitsu.io host still parses', extractIds(['https://kitsu.io/anime/7']).kitsuId, 7);
check('www. prefix tolerated', extractIds(['https://www.myanimelist.net/anime/5']).malId, 5);
check('anime-planet slug with digits stays a string', extractIds(['https://anime-planet.com/anime/001']).animePlanetId, '001');
check('unknown hosts and junk are ignored', extractIds(['https://example.com/anime/9', 'not a url', '']).anilistId, null);
check('non-numeric id is ignored, not NaN', extractIds(['https://myanimelist.net/anime/abc']).malId, null);
check('first URL wins when a provider appears twice', extractIds(['https://anilist.co/anime/1', 'https://anilist.co/anime/2']).anilistId, 1);

console.log('catalogKey');
check('AniList preferred', catalogKey(extractIds(['https://myanimelist.net/anime/1', 'https://anilist.co/anime/9'])), 'anilist:9');
check('falls back to MAL', catalogKey(extractIds(['https://myanimelist.net/anime/62783'])), 'mal:62783');
check('falls back to AniDB when it is all there is', catalogKey(extractIds(['https://anidb.net/anime/5'])), 'anidb:5');
check('no usable id -> null', catalogKey(extractIds(['https://example.com/x'])), null);

console.log('toCatalogRow');
{
  const row = toCatalogRow(bySource('https://anidb.net/anime/23'))!;
  check('Cowboy Bebop key + scalar fields', [row.key, row.title, row.type, row.episodes, row.status, row.season, row.seasonYear], ['anilist:1', 'Cowboy Bebop', 'TV', 26, 'FINISHED', 'SPRING', 1998]);
  check('duration kept in seconds, score rounded to 2dp', [row.durationSeconds, row.score], [1440, 8.59]);
  check('picture + thumbnail kept', [row.picture, row.thumbnail], ['https://cdn.myanimelist.net/images/anime/4/19644.jpg', 'https://cdn.myanimelist.net/images/anime/4/19644t.jpg']);
  check('non-latin synonyms survive', row.synonyms.includes('カウボーイビバップ') && row.synonyms.includes('星际牛仔'), true);
  check('related reduced to AniDB/AniList/MAL ids, sorted and de-duplicated', row.related, { anidb: [219], anilist: [5, 4037, 17205], mal: [5, 4037, 17205] });
  check('original source URLs retained', row.sources.length, 10);
}
{
  const placeholder = toCatalogRow(bySource('https://anilist.co/anime/185821'))!;
  check('shared no_pic placeholder is dropped, not served as a poster', [placeholder.picture, placeholder.thumbnail], [null, null]);
}
{
  const unknownEpisodes = toCatalogRow(bySource('https://myanimelist.net/anime/62783'))!;
  check('episodes 0 means unknown -> null', unknownEpisodes.episodes, null);
  check('missing score/duration -> null', [unknownEpisodes.score, unknownEpisodes.durationSeconds], [null, null]);
  check('season UNDEFINED -> null but a known year survives', [unknownEpisodes.season, unknownEpisodes.seasonYear], [null, 2027]);
  check('single-source entry keyed by its only id', unknownEpisodes.key, 'mal:62783');
}
{
  const noYear = toCatalogRow(bySource('https://anidb.net/anime/19047'))!;
  check('animeSeason without a year key does not crash', [noYear.season, noYear.seasonYear], [null, null]);
}
check('entry without any recognised id is skipped', toCatalogRow({ sources: ['https://example.com/1'], title: 'x' } as AodEntry), null);
check('entry without a title is skipped', toCatalogRow({ sources: ['https://myanimelist.net/anime/1'], title: '  ' } as AodEntry), null);
check('isPlaceholderImage', [
  isPlaceholderImage('https://raw.githubusercontent.com/cedya77/anime-offline-database/main/pics/no_pic.png'),
  isPlaceholderImage('https://cdn.myanimelist.net/images/anime/4/19644.jpg'),
  isPlaceholderImage(undefined)
], [true, false, false]);
check('extractRelated ignores providers AniLink does not key on', extractRelated(['https://kitsu.app/anime/2', 'https://anilist.co/anime/5']), { anidb: [], anilist: [5], mal: [] });

console.log('entriesToCatalogRows');
{
  const result = entriesToCatalogRows(doc.entries);
  check('every fixture entry converts', [result.rows.length, result.skippedNoId, result.duplicateKeys], [doc.entries.length, 0, 0]);
  check('rows without an AniDB id exist (the point of the catalog)', result.rows.some((r) => r.anidbId === null), true);
}
{
  const dup: AodEntry = { sources: ['https://anilist.co/anime/1'], title: 'a' };
  const result = entriesToCatalogRows([dup, { ...dup, title: 'b' }, { sources: [], title: 'c' }]);
  check('duplicate keys keep the first (a batched upsert would otherwise fail)', [result.rows.map((r) => r.title), result.duplicateKeys, result.skippedNoId], [['a'], 1, 1]);
}

console.log('document + JSONL parsing');
check('document meta', doc.meta, { lastUpdate: '2026-11-15', repository: 'https://github.com/cedya77/anime-offline-database' });
{
  const lines = readFileSync(dir + 'aod.sample.jsonl', 'utf-8').split('\n');
  const parsed = lines.map(parseAodLine);
  check('first JSONL line is metadata', parsed[0].kind, 'meta');
  check('every following non-empty line is an entry', parsed.slice(1).filter((p) => p.kind === 'entry').length, doc.entries.length);
  check('trailing blank line is skipped', parsed[parsed.length - 1].kind, 'skip');
  const fromLines = entriesToCatalogRows(parsed.flatMap((p) => (p.kind === 'entry' ? [p.entry] : [])));
  check('JSONL and document formats give identical rows', fromLines.rows, entriesToCatalogRows(doc.entries).rows);
}
{
  let threw = false;
  try {
    parseAodLine('{"sources":["https://anilist.co/anime/1"],"ti');
  } catch {
    threw = true;
  }
  check('a truncated line throws instead of being half-ingested', threw, true);
}
{
  let message = '';
  try {
    parseAodDocument('{"data": 5}');
  } catch (err) {
    message = (err as Error).message;
  }
  check('document without a data array is rejected', message.includes('no "data" array'), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
