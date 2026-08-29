import { fetchAniListMedia } from '../src/mapping/anilist-client.js';
import { buildAniListSegments } from '../src/mapping/anilist-index.js';

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

let request: Request | null = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  request = new Request(input, init);
  return new Response(JSON.stringify({
    data: {
      Media: {
        id: 21, idMal: 21,
        title: { romaji: 'One Piece', english: 'One Piece', native: 'ONE PIECE' },
        synonyms: ['OP', ''], format: 'TV', status: 'RELEASING', episodes: null, duration: 24,
        startDate: { year: 1999, month: 10, day: 20 }, endDate: { year: null, month: null, day: null },
        nextAiringEpisode: { episode: 1176, airingAt: 1780000000 }, siteUrl: 'https://anilist.co/anime/21',
        relations: { edges: [
          { relationType: 'PREQUEL', node: { id: 1, title: { romaji: 'Pilot', english: null, native: null }, format: 'SPECIAL', status: 'FINISHED', episodes: 1, startDate: { year: 1998, month: 1, day: 1 }, endDate: null, siteUrl: 'https://anilist.co/anime/1' } },
          { relationType: 'SIDE_STORY', node: { id: 2, title: { romaji: 'Side OVA', english: 'Side OVA', native: null }, format: 'OVA', status: 'FINISHED', episodes: 2, startDate: { year: 2000, month: 2, day: 3 }, endDate: { year: 2000, month: 3, day: 3 }, siteUrl: 'https://anilist.co/anime/2' } }
        ] }
      }
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

try {
  const media = await fetchAniListMedia(21);
  check('uses the AniList GraphQL endpoint and POST body', { url: request?.url, method: request?.method, bodyHasId: (await request?.text())?.includes('"id":21') }, {
    url: 'https://graphql.anilist.co/', method: 'POST', bodyHasId: true
  });
  check('normalizes episode, release, and relation metadata', {
    id: media.id, idMal: media.idMal, synonyms: media.synonyms, startDate: media.startDate,
    endDate: media.endDate, next: media.nextAiringEpisode, relations: media.relations
  }, {
    id: 21, idMal: 21, synonyms: ['OP'], startDate: '1999-10-20', endDate: null,
    next: { episode: 1176, airingAt: 1780000000 },
    relations: [
      { id: 1, relationType: 'PREQUEL', format: 'SPECIAL', status: 'FINISHED', episodes: 1, title: { romaji: 'Pilot', english: null, native: null }, startDate: '1998-01-01', endDate: null, siteUrl: 'https://anilist.co/anime/1' },
      { id: 2, relationType: 'SIDE_STORY', format: 'OVA', status: 'FINISHED', episodes: 2, title: { romaji: 'Side OVA', english: 'Side OVA', native: null }, startDate: '2000-02-03', endDate: '2000-03-03', siteUrl: 'https://anilist.co/anime/2' }
    ]
  });
  const segments = buildAniListSegments(69, media);
  check('only direct AniList mapping receives an episode range', segments.map(({ anilistId, relationType, format, episodeStart, episodeEnd, confidence }) => ({ anilistId, relationType, format, episodeStart, episodeEnd, confidence })), [
    { anilistId: 21, relationType: 'SELF', format: 'TV', episodeStart: null, episodeEnd: null, confidence: 100 },
    { anilistId: 1, relationType: 'PREQUEL', format: 'SPECIAL', episodeStart: null, episodeEnd: 1, confidence: 60 },
    { anilistId: 2, relationType: 'SIDE_STORY', format: 'OVA', episodeStart: null, episodeEnd: 2, confidence: 50 }
  ]);
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
