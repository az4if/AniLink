import { buildMappingResponse } from '../src/mapping/response.js';

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

// Cowboy Bebop, using the exact real values verified against
// anime-list-master.xml and Fribb's JSON earlier in this project.
const cowboyBebopRow = {
  anidbId: 23,
  malId: 1,
  anilistId: 1,
  kitsuId: 1,
  livechartId: 3418,
  anisearchId: 1572,
  animePlanetId: 'cowboy-bebop',
  animeNewsNetworkId: 13,
  animeCountdownId: 37089,
  simklId: 37089,
  notifyMoeId: null,
  tvdbId: 76885,
  tmdbTvId: 30991,
  tmdbMovieIds: null,
  imdbIds: ['tt0213338'],
  type: 'TV',
  title: 'Cowboy Bebop',
  airing: false,
  episodeProgress: null,
  nextEpisodeAt: null,
  defaultTvdbSeason: 1,
  tvdbAbsolute: false,
  tvdbEpisodeOffset: 0,
  defaultTmdbSeason: 1,
  tmdbAbsolute: false,
  tmdbEpisodeOffset: 0,
  mappingList: null,
  source: 'anime-lists-xml',
  updatedAt: new Date('2026-01-01T00:00:00Z')
} as any;

check('response shapes ids/type/title/airing correctly, nulls image/description/episodes honestly', buildMappingResponse(cowboyBebopRow), {
  ids: {
    anidb: 23,
    mal: 1,
    anilist: 1,
    kitsu: 1,
    tvdb: 76885,
    tmdb: { tv: 30991, movie: [] },
    imdb: ['tt0213338'],
    livechart: 3418,
    anisearch: 1572,
    animePlanet: 'cowboy-bebop',
    animeNewsNetwork: 13,
    animeCountdown: 37089,
    simkl: 37089,
    notifyMoe: null
  },
  type: 'TV',
  title: 'Cowboy Bebop',
  airing: false,
  episodeProgress: null,
  nextEpisodeAt: null,
  description: null,
  image: null,
  episodes: [],
  titles: {},
  episodeCount: null,
  specialCount: null,
  artworks: [],
  providers: { tvdb: null, tmdb: null, aniZip: null },
  updatedAt: cowboyBebopRow.updatedAt
});

// null tmdbMovieIds/imdbIds should become [] , not null, in the response
const movieRow = { ...cowboyBebopRow, tmdbTvId: null, tmdbMovieIds: [128], imdbIds: null } as any;
check('null arrays default to [] rather than leaking null', buildMappingResponse(movieRow).ids, {
  ...buildMappingResponse(cowboyBebopRow).ids,
  tmdb: { tv: null, movie: [128] },
  imdb: []
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
