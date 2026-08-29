// Mocked-fetch unit tests for tvdb-client.ts. No real network call to TVDB
// is made or possible here -- this checks the client's OWN logic (token
// caching/reuse, pagination walking, 401 -> forced re-login -> retry-once)
// against a fake server.
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
      JSON.stringify({ data: { status: { name: 'Ended' }, image: 'https://example.com/poster.jpg', overview: 'A test overview.' } }),
      { status: 200 }
    );
  }

  if (url.includes('/episodes/official')) {
    const page = Number(new URL(url).searchParams.get('page'));
    if (page === 0) {
      return new Response(
        JSON.stringify({
          data: { episodes: [{ seasonNumber: 1, number: 1, name: 'Ep 1', overview: 'o', aired: '2020-01-01', image: null }] },
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
  // --- one login, then summary + one paginated episode fetch -----------
  const series = await fetchTvdbSeries(76885);
  check('fetches series summary + episode data correctly', series, {
    status: 'Ended',
    image: 'https://example.com/poster.jpg',
    overview: 'A test overview.',
    episodes: [{ seasonNumber: 1, number: 1, absoluteNumber: null, name: 'Ep 1', overview: 'o', aired: '2020-01-01', image: null }]
  });
  check('exactly one /login call for this whole fetch', loginCount, 1);
  check('pagination stopped once a page came back empty (3 data calls: extended, ep page0, ep page1)', calls.length - loginCount, 3);

  // --- token reused across a second fetch (no second login) ------------
  calls.length = 0;
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
