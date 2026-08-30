// Mocked-fetch unit tests for tvdb-client.ts. No real network call to TVDB
// is made or possible here -- this checks the client's OWN logic (token
// caching/reuse, pagination walking, 401 -> forced re-login -> retry-once,
// and the English-translation fetch pass) against a fake server. Run with
// TVDB_API_KEY=test -- the client's own guard clause rejects an empty key
// before ever reaching the mocked fetch, so this must be set even though
// no real request happens.
import { fetchTvdbSeries } from '../src/mapping/tvdb-client.js';

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

const calls: { url: string; method: string }[] = [];
const translationCalls: string[] = []; // episode ids that were actually fetched -- id 1002 must NEVER appear here
let loginCount = 0;
let forceOneUnauthorized = false;

const realFetch = global.fetch;
global.fetch = (async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  calls.push({ url, method });

  if (url.endsWith('/login')) {
    loginCount++;
    return new Response(JSON.stringify({ data: { token: `fake-token-${loginCount}` }, status: 'success' }), { status: 200 });
  }

  if (forceOneUnauthorized) {
    forceOneUnauthorized = false;
    return new Response('unauthorized', { status: 401 });
  }

  if (url.includes('/extended')) {
    return new Response(
      JSON.stringify({
        data: {
          status: { name: 'Ended' }, image: 'https://example.com/poster.jpg', overview: 'A test overview.',
          aliases: [{ name: 'Bebop', language: 'eng' }], remoteIds: [{ id: 'tt0213338', sourceName: 'IMDB' }],
          artworks: [{ image: 'https://example.com/art.jpg', thumbnail: 'https://example.com/art-thumb.jpg', width: 1000, height: 1500, language: 'eng', type: 2, score: 10, includesText: true }]
        }
      }),
      { status: 200 }
    );
  }

  const translationMatch = url.match(/\/episodes\/(\d+)\/translations\/eng$/);
  if (translationMatch) {
    const episodeId = translationMatch[1];
    translationCalls.push(episodeId);
    if (episodeId === '1001') {
      return new Response(JSON.stringify({ data: { name: 'Ep A (EN)', overview: 'Overview A, in English.', language: 'eng' } }), { status: 200 });
    }
    if (episodeId === '1003') {
      // simulates the real-world edge case where overviewTranslations said
      // "eng" exists but the translation record itself 404s anyway
      return new Response('not found', { status: 404 });
    }
    throw new Error(`unexpected translation fetch for episode ${episodeId} -- should have been skipped`);
  }

  if (url.includes('/episodes/official')) {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 0) {
      return new Response(
        JSON.stringify({
          data: {
            episodes: [
              // has "eng" via nameTranslations -> should be fetched, and succeeds
              { id: 1001, seasonNumber: 1, number: 1, name: 'Ep A', overview: 'o', aired: '2020-01-01', image: null, nameTranslations: ['eng', 'jpn'], overviewTranslations: ['jpn'] },
              // no "eng" listed anywhere -> should NOT be fetched at all
              { id: 1002, seasonNumber: 1, number: 2, name: 'Ep B', overview: 'o', aired: '2020-01-08', image: null, nameTranslations: ['jpn'], overviewTranslations: ['jpn'] },
              // has "eng" via overviewTranslations only -> should be fetched, but 404s
              { id: 1003, seasonNumber: 1, number: 3, name: 'Ep C', overview: 'o', aired: '2020-01-15', image: null, nameTranslations: [], overviewTranslations: ['eng'] }
            ]
          },
          links: { next: `${url.split('?')[0]}?page=1` }
        }),
        { status: 200 }
      );
    }
    // page 1 onward: empty -> pagination should stop here
    return new Response(JSON.stringify({ data: { episodes: [] } }), { status: 200 });
  }

  throw new Error(`unexpected mocked fetch: ${method} ${url}`);
}) as typeof fetch;

async function run() {
  const series = await fetchTvdbSeries(76885);

  check('fetches series summary correctly', { status: series.status, image: series.image, overview: series.overview }, {
    status: 'Ended',
    image: 'https://example.com/poster.jpg',
    overview: 'A test overview.'
  });
  check('keeps extended fields losslessly and normalizes TVDB artwork', {
    alias: (series.raw?.aliases as any[])?.[0]?.name,
    remoteId: (series.raw?.remoteIds as any[])?.[0]?.id,
    artwork: series.artworks?.[0] && [series.artworks[0].source, series.artworks[0].type, series.artworks[0].includesText]
  }, { alias: 'Bebop', remoteId: 'tt0213338', artwork: ['tvdb', 'poster', true] });
  check('exactly one /login call for this whole fetch', loginCount, 1);
  check(
    'skips the translation fetch entirely for the episode with no "eng" in either translations array (only 1001 and 1003 fetched, never 1002)',
    translationCalls.sort(),
    ['1001', '1003']
  );
  check('English translation successfully fetched and attached', series.episodes[0], {
    seasonNumber: 1,
    number: 1,
    absoluteNumber: null,
    name: 'Ep A',
    overview: 'o',
    titleEn: 'Ep A (EN)',
    overviewEn: 'Overview A, in English.',
    aired: '2020-01-01',
    image: null
  });
  check('episode never flagged as having an English translation stays null, untouched', series.episodes[1].titleEn, null);
  check('a translation flagged as available but 404ing leaves titleEn/overviewEn null rather than throwing', series.episodes[2], {
    seasonNumber: 1,
    number: 3,
    absoluteNumber: null,
    name: 'Ep C',
    overview: 'o',
    titleEn: null,
    overviewEn: null,
    aired: '2020-01-15',
    image: null
  });
  check('pagination stopped once a page came back empty', calls.some((c) => c.url.includes('page=1')) && calls.some((c) => c.url.includes('page=2')), false);

  // --- token reused across a second fetch (no second login) ------------
  calls.length = 0;
  translationCalls.length = 0;
  await fetchTvdbSeries(76885);
  check('token cached -- no second /login on a subsequent fetch', loginCount, 1);

  // --- a 401 forces exactly one fresh login + retry, then succeeds -----
  calls.length = 0;
  forceOneUnauthorized = true;
  const afterRetry = await fetchTvdbSeries(76885);
  check('401 triggers a fresh login (loginCount now 2) and the retried call still succeeds', loginCount, 2);
  check('data after the 401-retry is still correct', afterRetry.overview, 'A test overview.');

  global.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
