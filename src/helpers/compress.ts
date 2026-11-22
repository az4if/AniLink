import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

/**
 * Response compression: Brotli when the client accepts it, gzip otherwise,
 * nothing when it accepts neither.
 *
 * Why not hono/compress: it only offers gzip/deflate, because it relies on the
 * web CompressionStream API, and Brotli there isn't reliably available on every
 * Node 20/22 build. node:zlib has Brotli everywhere, so this is a small
 * middleware on top of it.
 *
 * JSON from /mappings compresses very well (repeated keys, repeated artwork
 * and episode structures), so this is the cheapest bandwidth win available.
 */

const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

export type CompressionOptions = {
  /** Bodies smaller than this many bytes are sent as-is. */
  minBytes?: number;
  /**
   * Brotli quality, 0-11. 11 (zlib's default) is far too slow for responses
   * generated per request; 4-5 gets most of the size win at gzip-like speed.
   */
  brotliQuality?: number;
  /** gzip level, 1-9. */
  gzipLevel?: number;
};

type Encoding = 'br' | 'gzip';

const COMPRESSIBLE_TYPE = /^(text\/(?!event-stream)|application\/(json|[\w.+-]*\+json|javascript|xml|[\w.+-]*\+xml)|image\/svg\+xml)/i;

/**
 * Picks the best encoding the client accepts, honoring q-values
 * (`br;q=0` means "no Brotli") and the `*` wildcard. Brotli wins ties.
 */
export function pickEncoding(acceptEncoding: string | null | undefined): Encoding | null {
  if (!acceptEncoding) return null;

  const q = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let weight = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match) weight = Number(match[1]);
    }
    q.set(name, Number.isFinite(weight) ? weight : 0);
  }

  const wildcard = q.get('*');
  const weightOf = (name: string) => q.get(name) ?? wildcard ?? 0;

  const br = weightOf('br');
  const gz = Math.max(weightOf('gzip'), q.get('x-gzip') ?? 0);
  if (br > 0 && br >= gz) return 'br';
  if (gz > 0) return 'gzip';
  return null;
}

function appendVary(headers: Headers, value: string): void {
  const existing = headers.get('Vary');
  if (!existing) {
    headers.set('Vary', value);
    return;
  }
  if (existing.trim() === '*') return;
  const present = existing.split(',').some((part) => part.trim().toLowerCase() === value.toLowerCase());
  if (!present) headers.set('Vary', `${existing}, ${value}`);
}

export function compression(options: CompressionOptions = {}): MiddlewareHandler {
  const minBytes = options.minBytes ?? 1024;
  const brotliQuality = options.brotliQuality ?? 4;
  const gzipLevel = options.gzipLevel ?? 6;

  return async (c, next) => {
    await next();

    const res = c.res;
    if (c.req.method === 'HEAD') return;
    // 200 only: skips 204/304 (no body), 206 (Range -- compressing a slice
    // would corrupt it), redirects and errors with tiny bodies.
    if (res.status !== 200 || !res.body) return;

    const contentType = res.headers.get('Content-Type') ?? '';
    if (!COMPRESSIBLE_TYPE.test(contentType)) return;

    // The body varies by Accept-Encoding from here on, so caches must know --
    // even for this request if it ends up uncompressed.
    appendVary(res.headers, 'Accept-Encoding');

    if (res.headers.has('Content-Encoding')) return;
    if (/\bno-transform\b/i.test(res.headers.get('Cache-Control') ?? '')) return;

    const declaredLength = Number(res.headers.get('Content-Length'));
    if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength < minBytes) return;

    const encoding = pickEncoding(c.req.header('Accept-Encoding'));
    if (!encoding) return;

    const original = Buffer.from(await res.arrayBuffer());
    if (original.byteLength < minBytes) {
      // The body is already consumed, so it has to be put back.
      c.res = new Response(original, res);
      return;
    }

    const compressed =
      encoding === 'br'
        ? await brotliAsync(original, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: brotliQuality,
              [constants.BROTLI_PARAM_SIZE_HINT]: original.byteLength
            }
          })
        : await gzipAsync(original, { level: gzipLevel });

    // Assign first, THEN set headers: Hono's `c.res =` setter copies the
    // previous response's headers (including the old Content-Length) over the
    // new response, which would otherwise clobber the values set here.
    c.res = new Response(compressed, res);
    c.res.headers.set('Content-Encoding', encoding);
    c.res.headers.set('Content-Length', String(compressed.byteLength));
    appendVary(c.res.headers, 'Accept-Encoding');

    // A compressed representation is not byte-identical to the original, so a
    // strong validator must become weak (RFC 9110 8.8.1).
    const etag = c.res.headers.get('ETag');
    if (etag && !etag.startsWith('W/')) c.res.headers.set('ETag', `W/${etag}`);
  };
}
