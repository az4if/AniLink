import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAodDocument, toCatalogRow } from '../src/mapping/aod.js';
import { buildCatalogResponse, CATALOG_LOOKUP_FIELDS, isCatalogLookup, overlayCatalog, type CatalogRecord } from '../src/mapping/catalog.js';
import { buildMappingResponse } from '../src/mapping/response.js';

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
const entries = parseAodDocument(readFileSync(dir + 'aod.sample.json', 'utf-8')).entries;
const record = (source: string): CatalogRecord => ({ ...toCatalogRow(entries.find((e) => e.sources[0] === source)!)!, updatedAt: null });

const bebop = record('https://anidb.net/anime/23');
const orphan = record('https://anilist.co/anime/149074'); // no AniDB id, ONGOING
const placeholder = record('https://anilist.co/anime/185821'); // dataset only had its no_pic image

// A bare AniDB-keyed document: ids only, nothing from TVDB/TMDB/ani.zip yet.
const bareRow = {
  anidbId: 23, malId: null, anilistId: null, kitsuId: null, livechartId: null, anisearchId: null, animePlanetId: null,
  animeNewsNetworkId: null, animeCountdownId: null, simklId: null, notifyMoeId: null, tvdbId: 76885, tmdbTvId: 30991,
  tmdbMovieIds: null, imdbIds: ['tt0213338'], type: null, title: null, airing: false, episodeProgress: null, nextEpisodeAt: null,
  updatedAt: new Date(0)
} as unknown as Parameters<typeof buildMappingResponse>[0];

console.log('overlayCatalog');
{
  const base = buildMappingResponse(bareRow);
  const snapshot = JSON.stringify(base);
  const out = overlayCatalog(base as unknown as Record<string, unknown>, bebop) as Record<string, any>;
  check('does not mutate the cached document it was given', JSON.stringify(base), snapshot);
  check('fills missing ids from the catalog', [out.ids.anilist, out.ids.mal, out.ids.kitsu, out.ids.livechart], [1, 1, 1, 3418]);
  check('keeps ids the mapping already had', [out.ids.anidb, out.ids.tvdb, out.ids.imdb], [23, 76885, ['tt0213338']]);
  check('fills title/type/image/episodeCount gaps', [out.title, out.type, out.image, out.episodeCount], ['Cowboy Bebop', 'TV', 'https://cdn.myanimelist.net/images/anime/4/19644.jpg', 26]);
  check('adds the catalog poster as an aod artwork', [out.artworks.length, out.artworks[0].source, out.artworks[0].type], [1, 'aod', 'poster']);
  check('exposes the catalog block', [out.catalog.key, out.catalog.synonyms.includes('Bebop'), out.catalog.status], ['anilist:1', true, 'FINISHED']);
}
{
  // A merged document that already has better data: the catalog must not override any of it.
  const merged = {
    ids: { anidb: 23, mal: 999, anilist: 888, kitsu: null },
    title: 'Cowboy Bebop (TVDB title)',
    type: 'TV',
    image: 'https://artworks.thetvdb.com/poster.jpg',
    episodeCount: 25,
    artworks: [{ url: 'https://artworks.thetvdb.com/poster.jpg', source: 'tvdb', type: 'poster' }]
  };
  const out = overlayCatalog(merged, bebop) as Record<string, any>;
  check('never overrides an existing id (a conflict is for the id-conflicts report, not silent replacement)', [out.ids.mal, out.ids.anilist], [999, 888]);
  check('never overrides existing title/image/episode count', [out.title, out.image, out.episodeCount], ['Cowboy Bebop (TVDB title)', 'https://artworks.thetvdb.com/poster.jpg', 25]);
  check('still fills the one missing id', out.ids.kitsu, 1);
  check('keeps provider artworks and appends the catalog one after them', out.artworks.map((a: any) => a.source), ['tvdb', 'aod']);
  const twice = overlayCatalog(out, bebop) as Record<string, any>;
  check('is idempotent: re-applying does not duplicate the aod artwork', twice.artworks.length, 2);
}
{
  const out = overlayCatalog({ ids: {}, title: 'x' }, null) as Record<string, unknown>;
  check('no catalog entry -> catalog: null, document otherwise unchanged', [out.catalog, out.title], [null, 'x']);
}
{
  const out = overlayCatalog({ ids: {}, title: null, image: null, artworks: [] }, placeholder) as Record<string, any>;
  check('placeholder-only entry adds no image and no artwork', [out.image, out.artworks], [null, []]);
}

console.log('buildCatalogResponse (titles with no AniDB id)');
{
  const out = buildCatalogResponse(orphan) as Record<string, any>;
  check('ids carry what the catalog knows, anidb/tvdb/tmdb honestly empty', [out.ids.anidb, out.ids.anilist, out.ids.tvdb, out.ids.tmdb, out.ids.imdb], [null, 149074, null, { tv: null, movie: [] }, []]);
  check('ONGOING status -> airing true', out.airing, true);
  check('title / type / image / episodeCount from the catalog', [out.title, out.type, out.episodeCount, typeof out.image], ['A Si yu Xiao Lingdang', 'ONA', 93, 'string']);
  check('no fabricated episodes or descriptions', [out.episodes, out.description], [[], null]);
  const mappingShape = Object.keys(buildMappingResponse(bareRow)).sort();
  check('same top-level keys as the AniDB-backed response, plus catalog (clients need no special case)', Object.keys(out).sort(), [...mappingShape, 'catalog'].sort());
  check('ids has the same keys too', Object.keys(out.ids).sort(), Object.keys((buildMappingResponse(bareRow) as any).ids).sort());
}

console.log('lookup parameters');
check('catalog can answer the id lookups it stores', Object.keys(CATALOG_LOOKUP_FIELDS), ['anidb_id', 'mal_id', 'anilist_id', 'kitsu_id', 'anisearch_id', 'livechart_id', 'animeplanet_id']);
check('and refuses the ones it does not (tvdb/tmdb/imdb/notify)', ['thetvdb_id', 'themoviedb_id', 'imdb_id', 'notifymoe_id'].map(isCatalogLookup), [false, false, false, false]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
