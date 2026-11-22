import {
  conditionalHeaders,
  fetchStreamIfChanged,
  fetchTextIfChanged,
  sha256Hex,
  type Fetcher,
  type SourceFingerprint
} from '../src/helpers/conditional-fetch.js';
import { streamLines } from '../src/helpers/stream-lines.js';

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

/** A fetcher that records the request headers and replies with whatever the test scripted. */
function scripted(reply: (headers: Record<string, string>) => Response) {
  const seen: Array<Record<string, string>> = [];
  const fetcher: Fetcher = async (_url, init) => {
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    seen.push(headers);
    return reply(headers);
  };
  return { fetcher, seen };
}

const BODY = '{"hello":"world"}';
const prev: SourceFingerprint = { etag: '"abc"', lastModified: 'Sun, 15 Nov 2026 00:00:00 GMT', contentHash: sha256Hex(BODY), contentLength: BODY.length };

console.log('conditionalHeaders');
check('no previous state -> no headers', conditionalHeaders(null), {});
check('ETag wins over Last-Modified', conditionalHeaders(prev), { 'If-None-Match': '"abc"' });
check('falls back to Last-Modified', conditionalHeaders({ ...prev, etag: null }), { 'If-Modified-Since': prev.lastModified });
check('hash only -> nothing to send', conditionalHeaders({ etag: null, lastModified: null, contentHash: 'x', contentLength: 1 }), {});

console.log('fetchTextIfChanged');
{
  const { fetcher, seen } = scripted(() => new Response(null, { status: 304 }));
  const r = await fetchTextIfChanged('https://x/a', prev, { fetcher });
  check('304 -> unchanged / not-modified', [r.changed, r.changed ? null : r.reason], [false, 'not-modified']);
  check('304 -> sent If-None-Match', seen[0], { 'If-None-Match': '"abc"' });
}
{
  const { fetcher } = scripted(() => new Response(BODY, { status: 200, headers: { etag: '"new-etag"' } }));
  const r = await fetchTextIfChanged('https://x/a', prev, { fetcher });
  check('200 with identical bytes -> same-content (server ignored the validator)', [r.changed, r.changed ? null : r.reason], [false, 'same-content']);
  check('same-content still reports the refreshed ETag', r.fingerprint.etag, '"new-etag"');
}
{
  const { fetcher } = scripted(() => new Response('{"hello":"changed"}', { status: 200, headers: { etag: '"e2"', 'last-modified': 'Mon, 16 Nov 2026 00:00:00 GMT' } }));
  const r = await fetchTextIfChanged('https://x/a', prev, { fetcher });
  check('200 with new bytes -> changed, body returned', [r.changed, r.changed ? r.body : null], [true, '{"hello":"changed"}']);
  check('new fingerprint captures validators and hash', r.fingerprint, {
    etag: '"e2"',
    lastModified: 'Mon, 16 Nov 2026 00:00:00 GMT',
    contentHash: sha256Hex('{"hello":"changed"}'),
    contentLength: 19
  });
}
{
  const { fetcher, seen } = scripted(() => new Response(BODY, { status: 200 }));
  const r = await fetchTextIfChanged('https://x/a', prev, { fetcher, force: true });
  check('force -> sends no conditional headers', seen[0], {});
  check('force -> reprocesses even identical content', r.changed, true);
}
{
  const { fetcher } = scripted(() => new Response(BODY, { status: 200 }));
  const r = await fetchTextIfChanged('https://x/a', null, { fetcher });
  check('first ever download is always "changed"', r.changed, true);
}
{
  const { fetcher } = scripted(() => new Response('nope', { status: 503 }));
  let message = '';
  try {
    await fetchTextIfChanged('https://x/a', prev, { fetcher, label: 'anime.json' });
  } catch (err) {
    message = (err as Error).message;
  }
  check('HTTP error throws with the label and status', message, 'Failed to download anime.json: HTTP 503');
}
{
  // A 304 we never asked for (no previous state) must not be mistaken for success.
  const { fetcher } = scripted(() => new Response(null, { status: 304 }));
  let threw = false;
  try {
    await fetchTextIfChanged('https://x/a', null, { fetcher });
  } catch {
    threw = true;
  }
  check('unsolicited 304 with no previous state is an error', threw, true);
}

console.log('fetchStreamIfChanged');
{
  const { fetcher } = scripted(() => new Response(null, { status: 304 }));
  const r = await fetchStreamIfChanged('https://x/a', prev, { fetcher });
  check('304 -> unchanged', r.changed, false);
}
{
  const { fetcher } = scripted(() => new Response('line1\nline2\n', { status: 200, headers: { etag: '"s1"' } }));
  const r = await fetchStreamIfChanged('https://x/a', prev, { fetcher });
  check('200 -> hands back the stream and header validators', [r.changed, r.changed ? r.headers.etag : null], [true, '"s1"']);
}

console.log('streamLines');
async function collect(chunks: Uint8Array[]): Promise<{ lines: string[]; bytes: number }> {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    }
  });
  let bytes = 0;
  const lines: string[] = [];
  for await (const line of streamLines(body, (chunk) => (bytes += chunk.byteLength))) lines.push(line);
  return { lines, bytes };
}
const enc = new TextEncoder();
{
  const text = 'alpha\nbeta\r\ngamma\n\nlast-no-newline';
  const { lines, bytes } = await collect([enc.encode(text)]);
  check('splits on \\n and \\r\\n, keeps blank lines, flushes the unterminated tail', lines, ['alpha', 'beta', 'gamma', '', 'last-no-newline']);
  check('onChunk saw every byte', bytes, enc.encode(text).length);
}
{
  // Split in the middle of a line AND in the middle of a 3-byte UTF-8 character (カ = E3 82 AB).
  const bytes = enc.encode('{"t":"カウボーイ"}\n{"t":"2"}\n');
  const cut = bytes.indexOf(0xe3) + 1; // inside the first katakana character
  const { lines } = await collect([bytes.slice(0, cut), bytes.slice(cut, cut + 7), bytes.slice(cut + 7)]);
  check('multi-byte character split across chunks decodes intact', lines, ['{"t":"カウボーイ"}', '{"t":"2"}']);
}
{
  const { lines } = await collect([]);
  check('empty body yields no lines', lines, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
