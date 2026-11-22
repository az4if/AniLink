import { Hono } from 'hono';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { compression, pickEncoding } from '../src/helpers/compress.js';

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

// --- pickEncoding ---------------------------------------------------------
console.log('pickEncoding');
check('br preferred when both accepted', pickEncoding('gzip, deflate, br'), 'br');
check('gzip when only gzip accepted', pickEncoding('gzip, deflate'), 'gzip');
check('nothing accepted -> null', pickEncoding('identity'), null);
check('missing header -> null', pickEncoding(undefined), null);
check('br;q=0 means no brotli -> gzip', pickEncoding('br;q=0, gzip'), 'gzip');
check('higher q for gzip beats br', pickEncoding('br;q=0.5, gzip;q=0.9'), 'gzip');
check('wildcard accepts brotli', pickEncoding('*'), 'br');
check('wildcard does not resurrect an explicit q=0', pickEncoding('br;q=0, *'), 'gzip');
check('case-insensitive', pickEncoding('GZIP, BR'), 'br');

// --- middleware -----------------------------------------------------------
// big enough to clear the default 1024-byte threshold and to compress well
const bigJson = { episodes: Array.from({ length: 200 }, (_, i) => ({ number: i + 1, title: `Episode ${i + 1}`, image: null })) };
const bigText = JSON.stringify(bigJson);

function makeApp() {
  const app = new Hono();
  // an OUTER middleware that sets a header on the way out, like cors() does --
  // it must survive the response being replaced by the compressor
  app.use('/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    await next();
  });
  app.use('/*', compression());
  app.get('/big', (c) => c.json(bigJson));
  app.get('/small', (c) => c.json({ ok: true }));
  app.get('/html', (c) => c.html(`<html>${'x'.repeat(4000)}</html>`));
  app.get('/binary', (c) => new Response(new Uint8Array(5000), { headers: { 'Content-Type': 'image/png' } }));
  app.get('/encoded', (c) => new Response(bigText, { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' } }));
  app.get('/etag', (c) => new Response(bigText, { headers: { 'Content-Type': 'application/json', ETag: '"abc"' } }));
  app.get('/notransform', (c) => new Response(bigText, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-transform' } }));
  app.get('/error', (c) => c.json({ error: 'x'.repeat(3000) }, 500));
  app.get('/vary', (c) => new Response(bigText, { headers: { 'Content-Type': 'application/json', Vary: 'Origin' } }));
  return app;
}

const app = makeApp();
const get = (path: string, acceptEncoding?: string, method = 'GET') =>
  app.request(path, { method, headers: acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {} });

async function main() {
  console.log('compression middleware');

  {
    const res = await get('/big', 'gzip, deflate, br');
    const raw = Buffer.from(await res.arrayBuffer());
    check('brotli: Content-Encoding', res.headers.get('Content-Encoding'), 'br');
    check('brotli: body round-trips to the original JSON', brotliDecompressSync(raw).toString(), bigText);
    check('brotli: Content-Length matches the compressed bytes', res.headers.get('Content-Length'), String(raw.byteLength));
    check('brotli: actually smaller', raw.byteLength < Buffer.byteLength(bigText) / 2, true);
    check('brotli: Vary includes Accept-Encoding', res.headers.get('Vary'), 'Accept-Encoding');
    check('brotli: Content-Type preserved', res.headers.get('Content-Type')?.startsWith('application/json'), true);
    check('brotli: header set by outer middleware survives', res.headers.get('Access-Control-Allow-Origin'), '*');
    check('brotli: status preserved', res.status, 200);
  }

  {
    const res = await get('/big', 'gzip, deflate');
    const raw = Buffer.from(await res.arrayBuffer());
    check('gzip fallback: Content-Encoding', res.headers.get('Content-Encoding'), 'gzip');
    check('gzip fallback: body round-trips', gunzipSync(raw).toString(), bigText);
    check('gzip fallback: Content-Length matches', res.headers.get('Content-Length'), String(raw.byteLength));
  }

  {
    const res = await get('/big');
    check('no Accept-Encoding: not encoded', res.headers.get('Content-Encoding'), null);
    check('no Accept-Encoding: body untouched', await res.text(), bigText);
    check('no Accept-Encoding: Vary still set (caches must differentiate)', res.headers.get('Vary'), 'Accept-Encoding');
  }

  {
    const res = await get('/small', 'br, gzip');
    check('small body: not compressed', res.headers.get('Content-Encoding'), null);
    check('small body: still intact after the body was consumed and restored', await res.json(), { ok: true });
  }

  {
    const res = await get('/html', 'br');
    const raw = Buffer.from(await res.arrayBuffer());
    check('html is compressed too', [res.headers.get('Content-Encoding'), brotliDecompressSync(raw).toString().length], ['br', 4013]);
  }

  {
    const res = await get('/binary', 'br, gzip');
    check('non-compressible content type (png) is left alone', res.headers.get('Content-Encoding'), null);
    check('non-compressible: no Vary added', res.headers.get('Vary'), null);
  }

  {
    const res = await get('/encoded', 'br, gzip');
    check('already Content-Encoded responses are not double-compressed', res.headers.get('Content-Encoding'), 'identity');
  }

  {
    const res = await get('/etag', 'br');
    check('strong ETag becomes weak when compressed', res.headers.get('ETag'), 'W/"abc"');
  }

  {
    const res = await get('/notransform', 'br');
    check('Cache-Control: no-transform is respected', res.headers.get('Content-Encoding'), null);
  }

  {
    const res = await get('/error', 'br');
    check('non-200 responses are left alone', [res.status, res.headers.get('Content-Encoding')], [500, null]);
  }

  {
    const res = await get('/vary', 'br');
    check('existing Vary header is extended, not replaced', res.headers.get('Vary'), 'Origin, Accept-Encoding');
  }

  {
    const res = await get('/big', 'br', 'HEAD');
    check('HEAD requests are left alone', [res.headers.get('Content-Encoding'), (await res.arrayBuffer()).byteLength], [null, 0]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
